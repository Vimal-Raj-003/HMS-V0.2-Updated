import { Injectable } from '@nestjs/common';
import { newId } from '@vims/contracts';
import { AppError } from '../../../core/problem/app-error.js';
import { consoleEvent } from '../consoles/consoles.events.js';
import {
  ConsoleSupport,
  asBool,
  asNumber,
  asNumberOrNull,
  asStringArray,
  asText,
  asTextOrNull,
} from '../consoles/consoles.support.js';
import type {
  AdministerRequest,
  AefiRequest,
  BreachDecisionRequest,
  BreachRequest,
  DiscardVialRequest,
  ImmunisationQuery,
  OpenVialRequest,
  PlanDoseUpdateRequest,
  VialQuery,
  VoidDoseRequest,
} from './programme.schemas.js';
import type { AefiRow, BreachRow, PlanDoseRow, VaccinationRow, VialRow } from './programme.types.js';

/** How long a patient is watched after a dose, when the console is not told. */
const DEFAULT_OBSERVATION_MINUTES = 30;

/**
 * OP-013 — vaccination and immunisation.
 *
 * ── Nothing here computes an interval or a discard time ────────────────────
 *
 * The minimum age, the minimum interval, the vial's clock and any cold chain
 * hold are all triggers. What this service adds is the *forward* view — which
 * vials are still usable, how long is left on each, which doses are overdue —
 * so a session is set up correctly rather than corrected dose by dose.
 *
 * ── Voiding is a route with a key, and never a delete ──────────────────────
 *
 * The immunisation record is what a school, an outbreak investigation and a
 * national registry read. A dose recorded in error is struck with a reason and
 * a name attached; `hms_app` cannot delete one at all.
 *
 * ── Deciding a breach is the moment a hold means anything ──────────────────
 *
 * While the action is `hold` every dose from those batches is refused. Deciding
 * releases them or condemns them, and it is a `high` key with a reason because
 * releasing puts every dose from a refrigerator that reached 14 °C back into
 * arms.
 */
@Injectable()
export class ImmunisationService extends ConsoleSupport {
  // ═══════════════════════════════════════════════════════════════════════════
  // Vials
  // ═══════════════════════════════════════════════════════════════════════════

  async openVial(body: OpenVialRequest): Promise<VialRow> {
    return this.guard(async (tx) => {
      const id = newId();
      // Both the dose count and the discard time go in NULL: the BEFORE trigger
      // fills them from the vaccine's own policy, and NOT NULL is checked after
      // it runs. A placeholder would survive the trigger's coalesce and quietly
      // become the value — which for a dose count is a vial that holds nothing.
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.open_vials
           (id, hospital_id, branch_id, vaccine_id, item_id, batch_no, expiry_date,
            opened_at, opened_by, doses_total, discard_due_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::date, now(), $8, $9, NULL, now(), now())
         RETURNING *`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.vaccineId,
          body.itemId ?? null,
          body.batchNo,
          body.expiryDate,
          this.actorId(),
          body.dosesTotal ?? null,
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The vial was not opened.');

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'open_vial',
        rowId: id,
        businessKey: body.batchNo,
        dataClass: 'operational',
        patientId: null,
        encounterId: null,
        before: null,
        after: { batch: body.batchNo, discardDueAt: asText(row['discard_due_at']) },
      });

      return this.toVial(row);
    });
  }

  async discardVial(id: string, body: DiscardVialRequest): Promise<VialRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE specialty.open_vials
            SET discarded_at = now(), discard_reason = $3::specialty."VialDiscardReason",
                wastage_doses = coalesce($4, greatest(0, doses_total - doses_used)),
                updated_at = now()
          WHERE hospital_id = $1 AND id = $2 AND discarded_at IS NULL
          RETURNING *`,
        [this.hospitalId(), id, body.reason, body.wastageDoses ?? null],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict('That vial does not exist, or it is already discarded.');
      }

      await this.audit.write(tx, {
        action: 'update',
        entity: 'open_vial',
        rowId: id,
        businessKey: asText(row['batch_no']),
        dataClass: 'operational',
        patientId: null,
        encounterId: null,
        before: null,
        after: { reason: body.reason, wastage: asNumberOrNull(row['wastage_doses']) },
      });

      return this.toVial(row);
    });
  }

  /**
   * The vials a session can actually draw from.
   *
   * `usableOnly` filters to open, inside the clock, with doses left — which is
   * the list a nurse setting up needs, and the one that stops a dose being
   * refused with a needle already drawn.
   */
  async listVials(query: VialQuery): Promise<readonly VialRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM specialty.open_vials
          WHERE hospital_id = $1 AND branch_id = $2
            AND ($3::boolean IS NOT TRUE
                 OR (discarded_at IS NULL AND discard_due_at > now() AND doses_used < doses_total))
          ORDER BY discard_due_at
          LIMIT $4`,
        [this.hospitalId(), this.branchId(), query.usableOnly, query.limit],
      );
      return rows.map((r) => this.toVial(r));
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Doses
  // ═══════════════════════════════════════════════════════════════════════════

  async administer(body: AdministerRequest): Promise<VaccinationRow> {
    return this.guard(async (tx) => {
      const id = newId();
      const minutes = body.observationMinutes ?? DEFAULT_OBSERVATION_MINUTES;

      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.vaccination_records
           (id, hospital_id, branch_id, patient_id, visit_id, plan_dose_id, vaccine_id,
            antigen_code, dose_no, batch_no, expiry_date, vvm_stage, vial_id, diluent_batch,
            site, route, dose_ml, administered_at, administered_by, ordered_by, consent_id,
            screening, observation_until, camp_id, source, external_facility,
            created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::date,$12,$13,$14,$15,$16,$17,
                 $18::timestamptz,$19,$20,$21,$22::jsonb,
                 $18::timestamptz + make_interval(mins => $23),
                 $24,$25,$26, now(), now())
         RETURNING *`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.patientId,
          body.visitId ?? null,
          body.planDoseId ?? null,
          body.vaccineId,
          body.antigenCode,
          body.doseNo,
          body.batchNo,
          body.expiryDate,
          body.vvmStage ?? null,
          body.vialId ?? null,
          body.diluentBatch ?? null,
          body.site,
          body.route,
          body.doseMl,
          body.administeredAt,
          this.actorId(),
          body.orderedBy ?? null,
          body.consentId ?? null,
          JSON.stringify(body.screening),
          minutes,
          body.campId ?? null,
          body.source,
          body.externalFacility ?? null,
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The dose was not recorded.');

      // The plan follows the record, not the other way round: a dose given
      // without a plan is still a dose, and a plan updated without a dose is a
      // child recorded as protected who is not.
      if (body.planDoseId !== undefined) {
        await tx.query(
          `UPDATE specialty.immunisation_plan_doses
              SET status = 'given', given_record_id = $3, updated_at = now()
            WHERE hospital_id = $1 AND id = $2`,
          [this.hospitalId(), body.planDoseId, id],
        );
      }

      await this.outbox.publish(
        tx,
        consoleEvent('immunisation.dose.given', id, {
          recordId: id,
          patientId: body.patientId,
          antigenCode: body.antigenCode,
          doseNo: body.doseNo,
          batchNo: body.batchNo,
          administeredAt: body.administeredAt,
          source: body.source,
        }),
      );

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'vaccination_record',
        rowId: id,
        businessKey: `${body.antigenCode}-${String(body.doseNo)}`,
        dataClass: 'phi',
        patientId: body.patientId,
        encounterId: body.visitId ?? null,
        before: null,
        after: { antigen: body.antigenCode, doseNo: body.doseNo, batch: body.batchNo },
      });

      return this.toRecord(row);
    });
  }

  /**
   * Strike a dose from the record.
   *
   * Never a delete — `hms_app` holds none. A void leaves the row saying that
   * somebody once thought the dose had been given, which is what an outbreak
   * investigation needs and what a school certificate has to be reconciled
   * against.
   */
  async voidDose(id: string, body: VoidDoseRequest): Promise<VaccinationRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE specialty.vaccination_records
            SET voided = true, void_reason = $3, voided_by = $4, updated_at = now()
          WHERE hospital_id = $1 AND id = $2 AND NOT voided
          RETURNING *`,
        [this.hospitalId(), id, body.reason, this.actorId()],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict('That dose does not exist, or it is already voided.');
      }

      // The plan dose goes back to due: a record struck in error means the
      // child is owed the dose again, and a recall list that does not know
      // that is the whole harm.
      await tx.query(
        `UPDATE specialty.immunisation_plan_doses
            SET status = 'due', given_record_id = NULL, updated_at = now()
          WHERE hospital_id = $1 AND given_record_id = $2`,
        [this.hospitalId(), id],
      );

      await this.audit.write(tx, {
        action: 'override',
        entity: 'vaccination_record',
        rowId: id,
        businessKey: `${asText(row['antigen_code'])}-${asText(row['dose_no'])}`,
        dataClass: 'phi',
        patientId: asText(row['patient_id']),
        encounterId: null,
        reasonText: body.reason,
        before: { voided: false },
        after: { voided: true },
      });

      return this.toRecord(row);
    });
  }

  async listRecords(query: ImmunisationQuery): Promise<readonly VaccinationRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM specialty.vaccination_records
          WHERE hospital_id = $1 AND ($2::uuid IS NULL OR patient_id = $2::uuid)
          ORDER BY administered_at DESC LIMIT $3`,
        [this.hospitalId(), query.patientId ?? null, query.limit],
      );
      return rows.map((r) => this.toRecord(r));
    });
  }

  /** The recall list: what is due, and how far past due it is. */
  async listPlanDoses(query: ImmunisationQuery): Promise<readonly PlanDoseRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT *, greatest(0, current_date - due_date) AS days_overdue
           FROM specialty.immunisation_plan_doses
          WHERE hospital_id = $1
            AND ($2::uuid IS NULL OR patient_id = $2::uuid)
            AND ($3::boolean IS NOT TRUE OR (status = 'due' AND due_date < current_date))
          ORDER BY due_date
          LIMIT $4`,
        [this.hospitalId(), query.patientId ?? null, query.overdueOnly, query.limit],
      );
      return rows.map((r) => this.toPlanDose(r));
    });
  }

  async updatePlanDose(id: string, body: PlanDoseUpdateRequest): Promise<PlanDoseRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE specialty.immunisation_plan_doses
            SET status = $3::specialty."PlanDoseStatus", reason = $4,
                next_reminder_at = coalesce($5::date, next_reminder_at), updated_at = now()
          WHERE hospital_id = $1 AND id = $2
          RETURNING *, greatest(0, current_date - due_date) AS days_overdue`,
        [this.hospitalId(), id, body.status, body.reason ?? null, body.nextReminderAt ?? null],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.notFound('That scheduled dose does not exist.');
      return this.toPlanDose(row);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Cold chain
  // ═══════════════════════════════════════════════════════════════════════════

  async recordBreach(body: BreachRequest): Promise<BreachRow> {
    return this.guard(async (tx) => {
      const id = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.cold_chain_breaches
           (id, hospital_id, unit_id, started_at, ended_at, peak_c, duration_min,
            batches_affected, action, note, created_at, updated_at)
         VALUES ($1,$2,$3,$4::timestamptz,$5::timestamptz,$6,
                 CASE WHEN $5::timestamptz IS NULL THEN NULL
                      ELSE (extract(epoch FROM ($5::timestamptz - $4::timestamptz)) / 60)::int END,
                 $7::text[], 'hold', $8, now(), now())
         RETURNING *`,
        [
          id,
          this.hospitalId(),
          body.unitId,
          body.startedAt,
          body.endedAt ?? null,
          body.peakC,
          body.batchesAffected,
          body.note ?? null,
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The breach was not recorded.');

      const { rows: unit } = await tx.query<Record<string, unknown>>(
        `SELECT code FROM specialty.cold_chain_units WHERE id = $1`,
        [body.unitId],
      );

      // Every dose from these batches is refused from this moment, and the
      // store has to pull them off the shelf before the next session opens.
      await this.outbox.publish(
        tx,
        consoleEvent('immunisation.coldchain.breached', id, {
          breachId: id,
          unitCode: asText(unit[0]?.['code'] ?? ''),
          peakC: String(body.peakC),
          startedAt: body.startedAt,
          batchesAffected: body.batchesAffected,
        }),
      );

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'cold_chain_breach',
        rowId: id,
        businessKey: asText(unit[0]?.['code'] ?? id),
        dataClass: 'operational',
        patientId: null,
        encounterId: null,
        before: null,
        after: { peakC: body.peakC, batches: body.batchesAffected.length },
      });

      return this.toBreach(row);
    });
  }

  /**
   * Release or condemn the vaccine.
   *
   * The only moment the hold means anything. Releasing puts every dose from a
   * refrigerator that reached 14 °C back into arms, so it is a named person
   * with a reason rather than a queue somebody clears.
   */
  async decideBreach(id: string, body: BreachDecisionRequest): Promise<BreachRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE specialty.cold_chain_breaches
            SET action = $3::specialty."BreachAction", decided_by = $4, decided_at = now(),
                note = coalesce(note || E'\\n', '') || $5, updated_at = now()
          WHERE hospital_id = $1 AND id = $2 AND action = 'hold'
          RETURNING *`,
        [this.hospitalId(), id, body.action, this.actorId(), body.reason],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict('That breach does not exist, or it has already been decided.');
      }

      await this.audit.write(tx, {
        action: 'approve',
        entity: 'cold_chain_breach',
        rowId: id,
        businessKey: asText(row['unit_id']),
        dataClass: 'operational',
        patientId: null,
        encounterId: null,
        reasonText: body.reason,
        before: { action: 'hold' },
        after: { action: body.action, batches: asStringArray(row['batches_affected']).length },
      });

      return this.toBreach(row);
    });
  }

  async listBreaches(): Promise<readonly BreachRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM specialty.cold_chain_breaches
          WHERE hospital_id = $1
          ORDER BY action = 'hold' DESC, started_at DESC LIMIT 100`,
        [this.hospitalId()],
      );
      return rows.map((r) => this.toBreach(r));
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Adverse events
  // ═══════════════════════════════════════════════════════════════════════════

  async reportAefi(body: AefiRequest): Promise<AefiRow> {
    return this.guard(async (tx) => {
      const id = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.aefi_reports
           (id, hospital_id, branch_id, patient_id, vaccination_record_ids, onset_at,
            reported_at, reporter_id, symptoms, severity, category, treatment, outcome,
            created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5::uuid[],$6::timestamptz, now(), $7,$8::jsonb,
                 $9::specialty."AefiSeverity",$10,$11,$12, now(), now())
         RETURNING *`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.patientId,
          body.vaccinationRecordIds,
          body.onsetAt,
          this.actorId(),
          JSON.stringify(body.symptoms),
          body.severity,
          body.category ?? null,
          body.treatment ?? null,
          body.outcome ?? null,
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The adverse event was not recorded.');

      // The statutory clock is twenty-four hours and the district programme
      // officer is not on this system.
      if (body.severity === 'serious') {
        await this.outbox.publish(
          tx,
          consoleEvent('immunisation.aefi.serious', id, {
            reportId: id,
            patientId: body.patientId,
            severity: body.severity,
            onsetAt: body.onsetAt,
            vaccinationRecordIds: body.vaccinationRecordIds,
          }),
        );
      }

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'aefi_report',
        rowId: id,
        businessKey: body.patientId,
        dataClass: 'phi',
        patientId: body.patientId,
        encounterId: null,
        before: null,
        after: { severity: body.severity, doses: body.vaccinationRecordIds.length },
      });

      return this.toAefi(row);
    });
  }

  async listAefi(): Promise<readonly AefiRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM specialty.aefi_reports
          WHERE hospital_id = $1
          ORDER BY severity DESC, reported_at DESC LIMIT 100`,
        [this.hospitalId()],
      );
      return rows.map((r) => this.toAefi(r));
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Shaping
  // ═══════════════════════════════════════════════════════════════════════════

  private toVial(row: Record<string, unknown>): VialRow {
    const total = asNumber(row['doses_total']);
    const used = asNumber(row['doses_used']);
    const discardedAt = asTextOrNull(row['discarded_at']);
    const dueAt = asText(row['discard_due_at']);
    const msLeft = Date.parse(dueAt) - Date.now();

    return {
      id: asText(row['id']),
      vaccineId: asText(row['vaccine_id']),
      batchNo: asText(row['batch_no']),
      expiryDate: asText(row['expiry_date']),
      openedAt: asText(row['opened_at']),
      openedBy: asText(row['opened_by']),
      dosesTotal: total,
      dosesUsed: used,
      discardDueAt: dueAt,
      discardedAt,
      discardReason: asTextOrNull(row['discard_reason']),
      wastageDoses: asNumberOrNull(row['wastage_doses']),
      // The three conditions the trigger checks, offered forwards so a session
      // is set up right rather than corrected with a needle already drawn.
      usable: discardedAt === null && msLeft > 0 && used < total,
      dosesLeft: Math.max(0, total - used),
      minutesLeft: Number.isNaN(msLeft) ? null : Math.floor(msLeft / 60_000),
    };
  }

  private toRecord(row: Record<string, unknown>): VaccinationRow {
    const until = asTextOrNull(row['observation_until']);
    return {
      id: asText(row['id']),
      patientId: asText(row['patient_id']),
      vaccineId: asText(row['vaccine_id']),
      antigenCode: asText(row['antigen_code']),
      doseNo: asNumber(row['dose_no']),
      batchNo: asText(row['batch_no']),
      expiryDate: asText(row['expiry_date']),
      vialId: asTextOrNull(row['vial_id']),
      site: asText(row['site']),
      route: asText(row['route']),
      doseMl: asNumber(row['dose_ml']),
      administeredAt: asText(row['administered_at']),
      administeredBy: asText(row['administered_by']),
      observationUntil: until,
      source: asText(row['source']),
      voided: asBool(row['voided']),
      voidReason: asTextOrNull(row['void_reason']),
      // Anaphylaxis is minutes, so the board needs to know who is still in the
      // room rather than who has been given something.
      underObservation: until !== null && Date.parse(until) > Date.now(),
    };
  }

  private toPlanDose(row: Record<string, unknown>): PlanDoseRow {
    const overdue = asNumberOrNull(row['days_overdue']);
    return {
      id: asText(row['id']),
      patientId: asText(row['patient_id']),
      antigenCode: asText(row['antigen_code']),
      doseNo: asNumber(row['dose_no']),
      dueDate: asText(row['due_date']),
      status: asText(row['status']),
      reason: asTextOrNull(row['reason']),
      daysOverdue: overdue === null || overdue === 0 ? null : overdue,
    };
  }

  private toBreach(row: Record<string, unknown>): BreachRow {
    const action = asText(row['action']);
    return {
      id: asText(row['id']),
      unitId: asText(row['unit_id']),
      startedAt: asText(row['started_at']),
      endedAt: asTextOrNull(row['ended_at']),
      peakC: asNumber(row['peak_c']),
      durationMin: asNumberOrNull(row['duration_min']),
      batchesAffected: asStringArray(row['batches_affected']),
      action,
      decidedBy: asTextOrNull(row['decided_by']),
      decidedAt: asTextOrNull(row['decided_at']),
      note: asTextOrNull(row['note']),
      holding: action === 'hold',
    };
  }

  private toAefi(row: Record<string, unknown>): AefiRow {
    const severity = asText(row['severity']);
    const fir = asTextOrNull(row['fir_sent_at']);
    return {
      id: asText(row['id']),
      patientId: asText(row['patient_id']),
      vaccinationRecordIds: asStringArray(row['vaccination_record_ids']),
      onsetAt: asText(row['onset_at']),
      reportedAt: asText(row['reported_at']),
      severity,
      category: asTextOrNull(row['category']),
      outcome: asTextOrNull(row['outcome']),
      firSentAt: fir,
      pirDueAt: asTextOrNull(row['pir_due_at']),
      cifDueAt: asTextOrNull(row['cif_due_at']),
      status: asText(row['status']),
      firOverdue: severity === 'serious' && fir === null,
    };
  }
}
