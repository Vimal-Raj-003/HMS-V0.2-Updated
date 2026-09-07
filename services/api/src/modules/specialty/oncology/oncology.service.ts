import { Injectable } from '@nestjs/common';
import { newId } from '@vims/contracts';
import type { TransactionClient } from '../../../core/db/database.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { consoleEvent } from '../consoles/consoles.events.js';
import {
  ConsoleSupport,
  asJson,
  asNumber,
  asNumberOrNull,
  asStringArray,
  asText,
  asTextOrNull,
} from '../consoles/consoles.support.js';
import type {
  AdministerRequest,
  AdministrationUpdateRequest,
  CaseQuery,
  CaseRequest,
  CosignRequest,
  CycleQuery,
  CycleRequest,
  CycleSignRequest,
  DeferRequest,
  OrderLineRequest,
  PharmacyRequest,
  PlanRequest,
  RegimenRequest,
  ToxicityRequest,
} from './oncology.schemas.js';
import type {
  AdministrationRow,
  ChemoCycleRow,
  CumulativeRow,
  CycleDetail,
  OncoCaseRow,
  OrderLineRow,
  RegimenRow,
  ToxicityRow,
  TreatmentPlanRow,
} from './oncology.types.js';

/** Where a cardiology referral has to start, not where the refusal is. */
const CAP_WARNING_FRACTION = 0.8;

/**
 * OP-031 and IP-023 — oncology and chemotherapy.
 *
 * ── Nothing here multiplies anything by a body surface area ────────────────
 *
 * The surface area, the clearance, every dose, every absolute cap and the
 * running lifetime total are trigger outputs. A service that also computed them
 * would be a second author of the numbers that kill people, and the two would
 * diverge the first time one was revised.
 *
 * ── What it does is warn early ─────────────────────────────────────────────
 *
 * `capFraction` and `approachingCap` cross four-fifths long before the refusal
 * does, because the way past an anthracycline ceiling is a cardiology opinion
 * and a different regimen — and both take weeks that nobody has once the
 * refusal has already happened.
 */
@Injectable()
export class OncologyService extends ConsoleSupport {
  // ═══════════════════════════════════════════════════════════════════════════
  // The case
  // ═══════════════════════════════════════════════════════════════════════════

  async createCase(body: CaseRequest): Promise<OncoCaseRow> {
    return this.guard(async (tx) => {
      const id = newId();
      await tx.query(
        `INSERT INTO specialty.onco_cases
           (id, hospital_id, branch_id, patient_id, case_no, primary_site_icdo3,
            morphology_icdo3, laterality, grade, dx_date, dx_basis, biomarkers, tnm,
            ecog, kps, intent, oncologist_id, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::clinical."Laterality",$9,$10::date,$11,
                 $12::jsonb,$13::jsonb,$14,$15,$16::specialty."OncoIntent",$17,$18,now(),now())`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.patientId,
          body.caseNo,
          body.primarySiteIcdo3,
          body.morphologyIcdo3 ?? null,
          body.laterality,
          body.grade ?? null,
          body.dxDate,
          body.dxBasis,
          JSON.stringify(body.biomarkers),
          JSON.stringify(body.tnm),
          body.ecog ?? null,
          body.kps ?? null,
          body.intent,
          body.oncologistId,
          this.actorId(),
        ],
      );

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'onco_case',
        rowId: id,
        businessKey: body.caseNo,
        dataClass: 'phi',
        patientId: body.patientId,
        encounterId: null,
        before: null,
        after: { site: body.primarySiteIcdo3, intent: body.intent },
      });

      return this.caseWithin(tx, id);
    });
  }

  async listCases(query: CaseQuery): Promise<readonly OncoCaseRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `${CASE_SELECT}
          WHERE c.hospital_id = $1
            AND ($2::uuid IS NULL OR c.patient_id = $2::uuid)
            AND ($3::boolean IS NOT TRUE OR c.status = 'active')
            AND ($4::boolean IS NOT TRUE OR EXISTS (
                  SELECT 1 FROM specialty.onco_cumulative_doses cd
                   WHERE cd.case_id = c.id AND cd.cap IS NOT NULL AND cd.cap > 0
                     AND coalesce(cd.total_per_m2, 0) >= cd.cap * $5::numeric))
          ORDER BY c.created_at DESC
          LIMIT $6`,
        [
          this.hospitalId(),
          query.patientId ?? null,
          query.activeOnly,
          query.nearingCapOnly,
          CAP_WARNING_FRACTION,
          query.limit,
        ],
      );
      return rows.map((r) => this.toCase(r));
    });
  }

  async caseDetail(id: string): Promise<OncoCaseRow> {
    return this.guard(async (tx) => this.caseWithin(tx, id));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The regimen library
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * A new regimen, or a new version of one. Regimens are never edited: every
   * plan in the hospital is a pin to a version, and editing one under a running
   * patient changes a dose they have already had.
   */
  async writeRegimen(body: RegimenRequest): Promise<RegimenRow> {
    return this.guard(async (tx) => {
      const id = newId();
      await tx.query(
        `INSERT INTO mdm.chemo_regimens
           (id, hospital_id, code, name, indication_sites, version, status, cycle_length_days,
            planned_cycles, emetogenicity, lab_thresholds, approved_by, approved_at,
            created_at, updated_at)
         SELECT $1::uuid, $2::uuid, $3::text, $4, $5::text[],
                coalesce(max(r.version), 0) + 1, 'approved', $6, $7, $8, $9::jsonb, $10, now(),
                now(), now()
           -- $2 and $3 are cast on both sides: each is used once as an inserted
           -- column and once as a lookup key, and Postgres deduces two types
           -- for such a parameter and refuses the statement.
           FROM mdm.chemo_regimens r WHERE r.hospital_id = $2::uuid AND r.code = $3::text`,
        [
          id,
          this.hospitalId(),
          body.code,
          body.name,
          body.indicationSites,
          body.cycleLengthDays,
          body.plannedCycles,
          body.emetogenicity,
          JSON.stringify(body.labThresholds),
          this.actorId(),
        ],
      );

      for (const drug of body.drugs) {
        await tx.query(
          `INSERT INTO mdm.chemo_regimen_drugs
             (id, hospital_id, regimen_id, seq, drug_id, drug_name, drug_class, dose_basis,
              dose_value, unit, bsa_cap, absolute_cap, route, infusion_min, diluent, volume_ml,
              stability_h, vesicant, days, cumulative_cap, cap_unit, is_premed, is_supportive,
              created_at, updated_at)
           VALUES ($1,$23,$2,$3,$4,$5,$6,$7::mdm."ChemoDoseBasis",$8,$9,$10,$11,$12,$13,$14,$15,$16,
                   $17,$18::int[],$19,$20,$21,$22,now(),now())`,
          [
            newId(),
            id,
            drug.seq,
            drug.drugId ?? null,
            drug.drugName,
            drug.drugClass,
            drug.doseBasis,
            drug.doseValue,
            drug.unit,
            drug.bsaCap ?? null,
            drug.absoluteCap ?? null,
            drug.route,
            drug.infusionMin ?? null,
            drug.diluent ?? null,
            drug.volumeMl ?? null,
            drug.stabilityH ?? null,
            drug.vesicant,
            drug.days,
            drug.cumulativeCap ?? null,
            drug.capUnit ?? null,
            drug.isPremed,
            drug.isSupportive,
            this.hospitalId(),
          ],
        );
      }

      await this.audit.write(tx, {
        action: 'approve',
        entity: 'chemo_regimen',
        rowId: id,
        businessKey: body.code,
        dataClass: 'operational',
        patientId: null,
        encounterId: null,
        reasonText: body.reason,
        before: null,
        after: { code: body.code, drugs: body.drugs.length },
      });

      return this.regimenWithin(tx, id);
    });
  }

  async listRegimens(): Promise<readonly RegimenRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM mdm.chemo_regimens
          WHERE (hospital_id = $1 OR hospital_id IS NULL) AND status = 'approved'
          ORDER BY code, version DESC LIMIT 200`,
        [this.hospitalId()],
      );
      const out: RegimenRow[] = [];
      for (const r of rows) out.push(await this.regimenWithin(tx, asText(r.id)));
      return out;
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The plan
  // ═══════════════════════════════════════════════════════════════════════════

  async writePlan(body: PlanRequest): Promise<TreatmentPlanRow> {
    return this.guard(async (tx) => {
      const { rows: reg } = await tx.query<Record<string, unknown>>(
        `SELECT version FROM mdm.chemo_regimens WHERE id = $1`,
        [body.regimenId],
      );
      const id = newId();
      // `bsa` and `crcl` are absent from the column list. They are what the
      // doses are computed from, and no request can carry them.
      await tx.query(
        `INSERT INTO specialty.onco_treatment_plans
           (id, hospital_id, case_id, regimen_id, regimen_version, intent, start_date,
            planned_cycles, height_cm, weight_kg, age_years, female, creatinine_mg_dl,
            bsa_method, consent_id, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6::specialty."OncoIntent",$7::date,$8,$9,$10,$11,$12,$13,$14,
                 $15,$16,now(),now())`,
        [
          id,
          this.hospitalId(),
          body.caseId,
          body.regimenId,
          asNumber(this.one(reg).version),
          body.intent,
          body.startDate,
          body.plannedCycles,
          body.heightCm,
          body.weightKg,
          body.ageYears,
          body.female,
          body.creatinineMgDl ?? null,
          body.bsaMethod,
          body.consentId ?? null,
          this.actorId(),
        ],
      );
      return this.planWithin(tx, id);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The cycle
  // ═══════════════════════════════════════════════════════════════════════════

  async scheduleCycle(planId: string, body: CycleRequest): Promise<CycleDetail> {
    return this.guard(async (tx) => {
      const id = newId();
      await tx.query(
        `INSERT INTO specialty.chemo_cycles
           (id, hospital_id, plan_id, cycle_no, day_no, scheduled_at, fitness,
            created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$7::jsonb,$8,now(),now())`,
        [
          id,
          this.hospitalId(),
          planId,
          body.cycleNo,
          body.dayNo,
          body.scheduledAt,
          JSON.stringify(body.fitness),
          this.actorId(),
        ],
      );
      return this.cycleDetailWithin(tx, id);
    });
  }

  /**
   * Adding a drug to a cycle. The dose is computed here by the database from
   * the plan's surface area and the library's basis — and the route, the days
   * and every cap come from the library too, which is what makes the vinca
   * never-event unreachable from a request.
   */
  async addOrderLine(cycleId: string, body: OrderLineRequest): Promise<CycleDetail> {
    return this.guard(async (tx) => {
      const { rows: drug } = await tx.query<Record<string, unknown>>(
        `SELECT drug_name, drug_class, dose_basis, dose_value, unit, route, infusion_min,
                diluent, volume_ml, vesicant
           FROM mdm.chemo_regimen_drugs WHERE id = $1`,
        [body.regimenDrugId],
      );
      const d = this.one(drug);

      await tx.query(
        `INSERT INTO specialty.chemo_order_lines
           (id, hospital_id, cycle_id, regimen_drug_id, seq, drug_name, drug_class, dose_basis,
            basis_value, reduction_pct, reduction_reason, unit, route, infusion_min, diluent,
            volume_ml, vesicant, created_at, updated_at)
         SELECT $1::uuid, $2::uuid, $3::uuid, $4::uuid,
                coalesce((SELECT max(l.seq) FROM specialty.chemo_order_lines l
                           WHERE l.cycle_id = $3::uuid), 0) + 1,
                $5, $6, $7::mdm."ChemoDoseBasis", $8, $9, $10, $11, $12, $13, $14, $15, $16,
                now(), now()`,
        [
          newId(),
          this.hospitalId(),
          cycleId,
          body.regimenDrugId,
          asText(d.drug_name),
          asText(d.drug_class),
          asText(d.dose_basis),
          asNumber(d.dose_value),
          body.reductionPct,
          body.reductionReason ?? null,
          asText(d.unit),
          asText(d.route),
          asNumberOrNull(d.infusion_min),
          asTextOrNull(d.diluent),
          asNumberOrNull(d.volume_ml),
          d.vesicant === true,
        ],
      );

      await this.announceApproachingCaps(tx, cycleId);
      return this.cycleDetailWithin(tx, cycleId);
    });
  }

  async signCycle(id: string, body: CycleSignRequest): Promise<CycleDetail> {
    return this.guard(async (tx) => {
      await tx.query(
        `UPDATE specialty.chemo_cycles
            SET fitness = coalesce($2::jsonb, fitness),
                signed_by = $3, signed_at = now(), status = 'pharm_pending', updated_at = now()
          WHERE id = $1 AND hospital_id = $4`,
        [
          id,
          body.fitness === undefined ? null : JSON.stringify(body.fitness),
          this.actorId(),
          this.hospitalId(),
        ],
      );
      const detail = await this.cycleDetailWithin(tx, id);

      await this.audit.write(tx, {
        action: 'sign',
        entity: 'chemo_cycle',
        rowId: id,
        businessKey: `${detail.plan.caseId}:${String(detail.cycle.cycleNo)}`,
        dataClass: 'phi',
        patientId: null,
        encounterId: null,
        before: null,
        after: { cycleNo: detail.cycle.cycleNo, drugs: detail.lines.length },
      });

      return detail;
    });
  }

  /**
   * The second oncologist.
   *
   * Taken from the session rather than the body — the same shape as the opioid
   * countersignature, because a first signer who could name their co-signer
   * would be naming somebody who has not looked.
   */
  async cosignCycle(id: string, body: CosignRequest): Promise<CycleDetail> {
    return this.guard(async (tx) => {
      await tx.query(
        `UPDATE specialty.chemo_cycles
            SET second_signer_id = $2, second_signed_at = now(), override_reason = $3,
                updated_at = now()
          WHERE id = $1 AND hospital_id = $4`,
        [id, this.actorId(), body.reason, this.hospitalId()],
      );
      const detail = await this.cycleDetailWithin(tx, id);

      await this.audit.write(tx, {
        action: 'approve',
        entity: 'chemo_cycle',
        rowId: id,
        businessKey: String(detail.cycle.cycleNo),
        dataClass: 'phi',
        patientId: null,
        encounterId: null,
        reasonText: body.reason,
        before: null,
        after: { fitnessFailures: [...detail.cycle.fitnessFailures] },
      });

      return detail;
    });
  }

  async deferCycle(id: string, body: DeferRequest): Promise<CycleDetail> {
    return this.guard(async (tx) => {
      await tx.query(
        `UPDATE specialty.chemo_cycles
            SET status = 'deferred', deferred_reason = $2, updated_at = now()
          WHERE id = $1 AND hospital_id = $3`,
        [id, body.reason, this.hospitalId()],
      );
      return this.cycleDetailWithin(tx, id);
    });
  }

  async listCycles(query: CycleQuery): Promise<readonly ChemoCycleRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `${CYCLE_SELECT}
          WHERE c.hospital_id = $1
            AND ($2::uuid IS NULL OR c.plan_id = $2::uuid)
            AND ($3::date IS NULL OR c.scheduled_at::date = $3::date)
            AND ($4::boolean IS NOT TRUE OR EXISTS (
                  SELECT 1 FROM specialty.chemo_order_lines l
                   WHERE l.cycle_id = c.id AND l.pharm_status = 'pending'))
          ORDER BY c.scheduled_at
          LIMIT $5`,
        [this.hospitalId(), query.planId ?? null, query.on ?? null, query.pendingPharmacyOnly, query.limit],
      );
      return rows.map((r) => this.toCycle(r));
    });
  }

  async cycleDetail(id: string): Promise<CycleDetail> {
    return this.guard(async (tx) => this.cycleDetailWithin(tx, id));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Pharmacy, and the chair
  // ═══════════════════════════════════════════════════════════════════════════

  async verifyLine(id: string, body: PharmacyRequest): Promise<OrderLineRow> {
    return this.guard(async (tx) => {
      await tx.query(
        `UPDATE specialty.chemo_order_lines
            SET pharm_status = $2::specialty."PharmStatus", pharm_by = $3, pharm_at = now(),
                pharm_notes = $4, updated_at = now()
          WHERE id = $1 AND hospital_id = $5`,
        [id, body.status, this.actorId(), body.notes ?? null, this.hospitalId()],
      );
      const line = await this.lineWithin(tx, id);

      await this.audit.write(tx, {
        action: 'approve',
        entity: 'chemo_order_line',
        rowId: id,
        businessKey: line.drugName,
        dataClass: 'phi',
        patientId: null,
        encounterId: null,
        ...(body.notes === undefined ? {} : { reasonText: body.notes }),
        before: null,
        after: { status: body.status, finalDose: line.finalDose },
      });

      // A patient is sitting in a chair while this is resolved, and the
      // oncologist who wrote it is on a ward round.
      if (body.status !== 'approved') {
        await this.outbox.publish(
          tx,
          consoleEvent('onco.pharmacy.queried', id, {
            orderLineId: id,
            cycleId: line.cycleId,
            drugName: line.drugName,
            status: body.status,
            notes: body.notes ?? '',
          }),
        );
      }

      return line;
    });
  }

  async administer(cycleId: string, body: AdministerRequest): Promise<CycleDetail> {
    return this.guard(async (tx) => {
      await tx.query(
        `INSERT INTO specialty.chemo_administrations
           (id, hospital_id, cycle_id, order_line_id, chair_id, verify_nurse1_id,
            verify_nurse2_id, barcode_verified, started_at, rate, access,
            created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),$9,$10,$11,now(),now())`,
        [
          newId(),
          this.hospitalId(),
          cycleId,
          body.orderLineId,
          body.chairId ?? null,
          this.actorId(),
          body.verifyNurse2Id,
          body.barcodeVerified,
          body.rate ?? null,
          body.access,
          this.actorId(),
        ],
      );
      await tx.query(
        `UPDATE specialty.chemo_cycles SET status = 'in_progress', updated_at = now()
          WHERE id = $1 AND status NOT IN ('administered', 'cancelled')`,
        [cycleId],
      );
      return this.cycleDetailWithin(tx, cycleId);
    });
  }

  async updateAdministration(id: string, body: AdministrationUpdateRequest): Promise<AdministrationRow> {
    return this.guard(async (tx) => {
      await tx.query(
        `UPDATE specialty.chemo_administrations
            SET ended_at      = coalesce($2::timestamptz, ended_at),
                completed     = coalesce($3, completed),
                reactions     = coalesce($4::jsonb, reactions),
                extravasation = coalesce($5::jsonb, extravasation),
                vitals        = coalesce($6::jsonb, vitals),
                interruptions = coalesce($7::jsonb, interruptions),
                notes         = coalesce($8, notes),
                updated_at    = now()
          WHERE id = $1 AND hospital_id = $9`,
        [
          id,
          body.endedAt ?? null,
          body.completed ?? null,
          body.reactions === undefined ? null : JSON.stringify(body.reactions),
          body.extravasation === undefined ? null : JSON.stringify(body.extravasation),
          body.vitals === undefined ? null : JSON.stringify(body.vitals),
          body.interruptions === undefined ? null : JSON.stringify(body.interruptions),
          body.notes ?? null,
          this.hospitalId(),
        ],
      );
      const admin = await this.administrationWithin(tx, id);

      // A surgical emergency with a drug-specific, time-critical antidote.
      if (body.extravasation !== undefined) {
        const { rows } = await tx.query<Record<string, unknown>>(
          `SELECT p.case_id, c.patient_id
             FROM specialty.chemo_cycles cy
             JOIN specialty.onco_treatment_plans p ON p.id = cy.plan_id
             JOIN specialty.onco_cases c ON c.id = p.case_id
            WHERE cy.id = $1`,
          [admin.cycleId],
        );
        await this.outbox.publish(
          tx,
          consoleEvent('onco.extravasation', id, {
            administrationId: id,
            cycleId: admin.cycleId,
            patientId: asText(this.one(rows).patient_id),
            drugName: admin.drugName,
            access: admin.access,
            at: new Date().toISOString(),
          }),
        );
      }

      if (body.completed === true) await this.announceCycleIfDone(tx, admin.cycleId);
      return admin;
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Toxicity
  // ═══════════════════════════════════════════════════════════════════════════

  async recordToxicity(caseId: string, body: ToxicityRequest): Promise<ToxicityRow> {
    return this.guard(async (tx) => {
      // `max_grade` and `action` are absent: the worst grade in a list is a
      // maximum, and a clinician who types one has already decided what the
      // list means.
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.toxicity_assessments
           (id, hospital_id, case_id, cycle_id, assessed_at, source, items, assessed_by,
            created_at, updated_at)
         VALUES ($1,$2,$3,$4,now(),$5,$6::jsonb,$7,now(),now())
         RETURNING *`,
        [
          newId(),
          this.hospitalId(),
          caseId,
          body.cycleId ?? null,
          body.source,
          JSON.stringify(body.items),
          this.actorId(),
        ],
      );
      const tox = this.toToxicity(this.one(rows));

      // Febrile neutropenia has a sixty-minute antibiotic clock, and the person
      // who records the grade is rarely the person who starts them.
      if ((tox.maxGrade ?? 0) >= 3) {
        const { rows: pat } = await tx.query<Record<string, unknown>>(
          `SELECT patient_id FROM specialty.onco_cases WHERE id = $1`,
          [caseId],
        );
        await this.outbox.publish(
          tx,
          consoleEvent('onco.toxicity.severe', tox.id, {
            assessmentId: tox.id,
            caseId,
            patientId: asText(this.one(pat).patient_id),
            maxGrade: tox.maxGrade ?? 0,
            action: tox.action,
            terms: body.items.filter((i) => i.grade >= 3).map((i) => i.term),
          }),
        );
      }

      return tox;
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Shaping
  // ═══════════════════════════════════════════════════════════════════════════

  private one(rows: readonly Record<string, unknown>[]): Record<string, unknown> {
    const row = rows[0];
    if (row === undefined) throw AppError.notFound('That oncology record was not found.');
    return row;
  }

  private async caseWithin(tx: TransactionClient, id: string): Promise<OncoCaseRow> {
    const { rows } = await tx.query<Record<string, unknown>>(`${CASE_SELECT} WHERE c.id = $1`, [id]);
    return this.toCase(this.one(rows));
  }

  private async planWithin(tx: TransactionClient, id: string): Promise<TreatmentPlanRow> {
    const { rows } = await tx.query<Record<string, unknown>>(`${PLAN_SELECT} WHERE p.id = $1`, [id]);
    return this.toPlan(this.one(rows));
  }

  private async lineWithin(tx: TransactionClient, id: string): Promise<OrderLineRow> {
    const { rows } = await tx.query<Record<string, unknown>>(`${LINE_SELECT} WHERE l.id = $1`, [id]);
    return this.toLine(this.one(rows));
  }

  private async administrationWithin(tx: TransactionClient, id: string): Promise<AdministrationRow> {
    const { rows } = await tx.query<Record<string, unknown>>(`${ADMIN_SELECT} WHERE a.id = $1`, [id]);
    return this.toAdministration(this.one(rows));
  }

  private async regimenWithin(tx: TransactionClient, id: string): Promise<RegimenRow> {
    const [reg, drugs] = await Promise.all([
      tx.query<Record<string, unknown>>(`SELECT * FROM mdm.chemo_regimens WHERE id = $1`, [id]),
      tx.query<Record<string, unknown>>(
        `SELECT * FROM mdm.chemo_regimen_drugs WHERE regimen_id = $1 ORDER BY seq`,
        [id],
      ),
    ]);
    const r = this.one(reg.rows);
    return {
      id: asText(r.id),
      code: asText(r.code),
      name: asText(r.name),
      version: asNumber(r.version),
      status: asText(r.status),
      cycleLengthDays: asNumber(r.cycle_length_days),
      plannedCycles: asNumber(r.planned_cycles),
      emetogenicity: asText(r.emetogenicity),
      labThresholds: asJson(r.lab_thresholds),
      drugs: drugs.rows.map((d) => ({
        id: asText(d.id),
        seq: asNumber(d.seq),
        drugName: asText(d.drug_name),
        drugClass: asText(d.drug_class),
        doseBasis: asText(d.dose_basis),
        doseValue: asNumber(d.dose_value),
        unit: asText(d.unit),
        route: asText(d.route),
        days: Array.isArray(d.days) ? d.days.map((x) => asNumber(x)) : [],
        bsaCap: asNumberOrNull(d.bsa_cap),
        absoluteCap: asNumberOrNull(d.absolute_cap),
        cumulativeCap: asNumberOrNull(d.cumulative_cap),
        vesicant: d.vesicant === true,
      })),
    };
  }

  private async cycleDetailWithin(tx: TransactionClient, id: string): Promise<CycleDetail> {
    const { rows } = await tx.query<Record<string, unknown>>(`${CYCLE_SELECT} WHERE c.id = $1`, [id]);
    const cycle = this.toCycle(this.one(rows));
    const [plan, lines, admins] = await Promise.all([
      tx.query<Record<string, unknown>>(`${PLAN_SELECT} WHERE p.id = $1`, [cycle.planId]),
      tx.query<Record<string, unknown>>(`${LINE_SELECT} WHERE l.cycle_id = $1 ORDER BY l.seq`, [id]),
      tx.query<Record<string, unknown>>(`${ADMIN_SELECT} WHERE a.cycle_id = $1 ORDER BY a.started_at`, [id]),
    ]);
    return {
      cycle,
      plan: this.toPlan(this.one(plan.rows)),
      lines: lines.rows.map((r) => this.toLine(r)),
      administrations: admins.rows.map((r) => this.toAdministration(r)),
    };
  }

  /**
   * Four-fifths of a lifetime ceiling.
   *
   * Early on purpose: the way past an anthracycline cap is a cardiology opinion
   * and a different regimen, and both take weeks that nobody has once the
   * refusal has already happened.
   */
  private async announceApproachingCaps(tx: TransactionClient, cycleId: string): Promise<void> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT cd.case_id, c.patient_id, cd.drug_name, cd.total_per_m2, cd.cap
         FROM specialty.onco_cumulative_doses cd
         JOIN specialty.onco_cases c ON c.id = cd.case_id
         JOIN specialty.onco_treatment_plans p ON p.case_id = cd.case_id
         JOIN specialty.chemo_cycles cy ON cy.plan_id = p.id
        WHERE cy.id = $1 AND cd.cap IS NOT NULL AND cd.cap > 0
          AND coalesce(cd.total_per_m2, 0) >= cd.cap * $2::numeric`,
      [cycleId, CAP_WARNING_FRACTION],
    );
    for (const r of rows) {
      const total = asNumber(r.total_per_m2);
      const cap = asNumber(r.cap);
      await this.outbox.publish(
        tx,
        consoleEvent('onco.cumulative.approaching_cap', asText(r.case_id), {
          caseId: asText(r.case_id),
          patientId: asText(r.patient_id),
          drugName: asText(r.drug_name),
          totalPerM2: String(total),
          cap: String(cap),
          fraction: String(Math.round((total / cap) * 100) / 100),
        }),
      );
    }
  }

  /** Every line on the cycle has run and finished. */
  private async announceCycleIfDone(tx: TransactionClient, cycleId: string): Promise<void> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT count(*) FILTER (WHERE NOT EXISTS (
                SELECT 1 FROM specialty.chemo_administrations a
                 WHERE a.order_line_id = l.id AND a.completed)) AS outstanding
         FROM specialty.chemo_order_lines l WHERE l.cycle_id = $1`,
      [cycleId],
    );
    if (asNumber(this.one(rows).outstanding) > 0) return;

    await tx.query(
      `UPDATE specialty.chemo_cycles SET status = 'administered', updated_at = now() WHERE id = $1`,
      [cycleId],
    );

    const detail = await this.cycleDetailWithin(tx, cycleId);
    const { rows: pat } = await tx.query<Record<string, unknown>>(
      `SELECT c.id AS case_id, c.patient_id
         FROM specialty.onco_cases c
         JOIN specialty.onco_treatment_plans p ON p.case_id = c.id
        WHERE p.id = $1`,
      [detail.cycle.planId],
    );
    await this.outbox.publish(
      tx,
      consoleEvent('onco.cycle.administered', cycleId, {
        cycleId,
        planId: detail.cycle.planId,
        caseId: asText(this.one(pat).case_id),
        patientId: asText(this.one(pat).patient_id),
        cycleNo: detail.cycle.cycleNo,
        dayNo: detail.cycle.dayNo,
        drugs: detail.lines.map((l) => ({
          name: l.drugName,
          finalDose: String(l.finalDose ?? 0),
          unit: l.unit,
        })),
      }),
    );
  }

  private toCase(r: Record<string, unknown>): OncoCaseRow {
    const cumulative = Array.isArray(r.cumulative)
      ? (r.cumulative as Record<string, unknown>[]).map((c) => this.toCumulative(c))
      : [];
    return {
      id: asText(r.id),
      patientId: asText(r.patient_id),
      caseNo: asText(r.case_no),
      primarySiteIcdo3: asText(r.primary_site_icdo3),
      morphologyIcdo3: asTextOrNull(r.morphology_icdo3),
      laterality: asText(r.laterality),
      grade: asTextOrNull(r.grade),
      dxDate: asText(r.dx_date),
      dxBasis: asText(r.dx_basis),
      biomarkers: asJson(r.biomarkers),
      tnm: asJson(r.tnm),
      ecog: asNumberOrNull(r.ecog),
      intent: asText(r.intent),
      oncologistId: asText(r.oncologist_id),
      status: asText(r.status),
      cumulative,
      worstToxicityGrade: asNumberOrNull(r.worst_toxicity_grade),
    };
  }

  private toCumulative(c: Record<string, unknown>): CumulativeRow {
    const total = asNumberOrNull(c.totalPerM2 ?? c.total_per_m2);
    const cap = asNumberOrNull(c.cap);
    const fraction = total === null || cap === null || cap === 0 ? null : total / cap;
    return {
      drugName: asText(c.drugName ?? c.drug_name),
      drugClass: asText(c.drugClass ?? c.drug_class),
      totalDose: asNumber(c.totalDose ?? c.total_dose),
      unit: asText(c.unit),
      totalPerM2: total,
      cap,
      capFraction: fraction === null ? null : Math.round(fraction * 100) / 100,
      approachingCap: fraction !== null && fraction >= CAP_WARNING_FRACTION,
      lastAt: asTextOrNull(c.lastAt ?? c.last_at),
    };
  }

  private toPlan(r: Record<string, unknown>): TreatmentPlanRow {
    return {
      id: asText(r.id),
      caseId: asText(r.case_id),
      regimenId: asText(r.regimen_id),
      regimenVersion: asNumber(r.regimen_version),
      regimenName: asText(r.regimen_name),
      intent: asText(r.intent),
      startDate: asText(r.start_date),
      plannedCycles: asNumber(r.planned_cycles),
      heightCm: asNumber(r.height_cm),
      weightKg: asNumber(r.weight_kg),
      bsaMethod: asText(r.bsa_method),
      bsa: asNumberOrNull(r.bsa),
      crcl: asNumberOrNull(r.crcl),
      status: asText(r.status),
      signedAt: asTextOrNull(r.signed_at),
    };
  }

  private toCycle(r: Record<string, unknown>): ChemoCycleRow {
    const failures = asStringArray(r.fitness_failures);
    const signedAt = asTextOrNull(r.signed_at);
    const secondSigner = asTextOrNull(r.second_signer_id);
    const pending = asNumber(r.lines_pending);

    // §B.5 and §B.6, read forwards: what will refuse the next step.
    const blockedBy: string[] = [];
    if (failures.length > 0 && secondSigner === null) {
      blockedBy.push(`${failures.join('; ')} — a second oncologist has to sign this with you`);
    }
    if (signedAt === null) blockedBy.push('the cycle has not been signed');
    if (pending > 0) blockedBy.push(`${String(pending)} line(s) are waiting on pharmacy`);

    return {
      id: asText(r.id),
      planId: asText(r.plan_id),
      cycleNo: asNumber(r.cycle_no),
      dayNo: asNumber(r.day_no),
      scheduledAt: asText(r.scheduled_at),
      status: asText(r.status),
      fitness: asJson(r.fitness),
      fitnessFailures: failures,
      deferredReason: asTextOrNull(r.deferred_reason),
      signedBy: asTextOrNull(r.signed_by),
      signedAt,
      secondSignerId: secondSigner,
      overrideReason: asTextOrNull(r.override_reason),
      blockedBy,
      linesPending: pending,
      linesApproved: asNumber(r.lines_approved),
    };
  }

  private toLine(r: Record<string, unknown>): OrderLineRow {
    return {
      id: asText(r.id),
      cycleId: asText(r.cycle_id),
      seq: asNumber(r.seq),
      drugName: asText(r.drug_name),
      drugClass: asText(r.drug_class),
      doseBasis: asText(r.dose_basis),
      basisValue: asNumber(r.basis_value),
      calcDose: asNumberOrNull(r.calc_dose),
      reductionPct: asNumber(r.reduction_pct),
      reductionReason: asTextOrNull(r.reduction_reason),
      finalDose: asNumberOrNull(r.final_dose),
      unit: asText(r.unit),
      capApplied: r.cap_applied === true,
      route: asText(r.route),
      infusionMin: asNumberOrNull(r.infusion_min),
      vesicant: r.vesicant === true,
      cumulativeBefore: asNumberOrNull(r.cumulative_before),
      cumulativeAfter: asNumberOrNull(r.cumulative_after),
      pharmStatus: asText(r.pharm_status),
      pharmNotes: asTextOrNull(r.pharm_notes),
      administered: r.administered === true,
    };
  }

  private toAdministration(r: Record<string, unknown>): AdministrationRow {
    return {
      id: asText(r.id),
      cycleId: asText(r.cycle_id),
      orderLineId: asText(r.order_line_id),
      drugName: asText(r.drug_name),
      verifyNurse1Id: asText(r.verify_nurse1_id),
      verifyNurse2Id: asText(r.verify_nurse2_id),
      barcodeVerified: r.barcode_verified === true,
      startedAt: asText(r.started_at),
      endedAt: asTextOrNull(r.ended_at),
      access: asText(r.access),
      reactions: Array.isArray(r.reactions) ? (r.reactions as Record<string, unknown>[]) : [],
      extravasation:
        r.extravasation === null || r.extravasation === undefined ? null : asJson(r.extravasation),
      completed: r.completed === true,
    };
  }

  private toToxicity(r: Record<string, unknown>): ToxicityRow {
    return {
      id: asText(r.id),
      caseId: asText(r.case_id),
      cycleId: asTextOrNull(r.cycle_id),
      assessedAt: asText(r.assessed_at),
      source: asText(r.source),
      items: Array.isArray(r.items) ? (r.items as Record<string, unknown>[]) : [],
      maxGrade: asNumberOrNull(r.max_grade),
      action: asTextOrNull(r.action),
    };
  }
}

const CASE_SELECT = `
  SELECT c.*,
         coalesce((SELECT jsonb_agg(jsonb_build_object(
                     'drug_name', cd.drug_name, 'drug_class', cd.drug_class,
                     'total_dose', cd.total_dose, 'unit', cd.unit,
                     'total_per_m2', cd.total_per_m2, 'cap', cd.cap, 'last_at', cd.last_at)
                     ORDER BY cd.drug_name)
                    FROM specialty.onco_cumulative_doses cd WHERE cd.case_id = c.id),
                  '[]'::jsonb) AS cumulative,
         (SELECT max(t.max_grade) FROM specialty.toxicity_assessments t
           WHERE t.case_id = c.id) AS worst_toxicity_grade
    FROM specialty.onco_cases c`;

const PLAN_SELECT = `
  SELECT p.*, r.name AS regimen_name
    FROM specialty.onco_treatment_plans p
    JOIN mdm.chemo_regimens r ON r.id = p.regimen_id`;

const CYCLE_SELECT = `
  SELECT c.*,
         (SELECT count(*) FROM specialty.chemo_order_lines l
           WHERE l.cycle_id = c.id AND l.pharm_status = 'pending') AS lines_pending,
         (SELECT count(*) FROM specialty.chemo_order_lines l
           WHERE l.cycle_id = c.id AND l.pharm_status = 'approved') AS lines_approved
    FROM specialty.chemo_cycles c`;

const LINE_SELECT = `
  SELECT l.*,
         EXISTS (SELECT 1 FROM specialty.chemo_administrations a
                  WHERE a.order_line_id = l.id AND a.completed) AS administered
    FROM specialty.chemo_order_lines l`;

const ADMIN_SELECT = `
  SELECT a.*, l.drug_name
    FROM specialty.chemo_administrations a
    JOIN specialty.chemo_order_lines l ON l.id = a.order_line_id`;
