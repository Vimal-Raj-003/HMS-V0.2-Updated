import { Injectable } from '@nestjs/common';
import { newId } from '@vims/contracts';
import type { TransactionClient } from '../../../core/db/database.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { consoleEvent } from '../consoles/consoles.events.js';
import { ConsoleSupport, asBool, asNumber, asText, asTextOrNull } from '../consoles/consoles.support.js';
import type {
  PathwayQuery,
  PathwayRequest,
  PathwayStepRequest,
  ReferralCancelRequest,
  ReferralQuery,
  ReferralReplyRequest,
  ReferralRequest,
  TeleConsultCloseRequest,
  TeleConsultRequest,
  TelePrescriptionRequest,
  TeleQuery,
} from './handoffs.schemas.js';
import type {
  PathwayInstanceRow,
  PathwayStepRecordRow,
  ReferralRow,
  TeleConsultRow,
  TeleDrugRuleRow,
  TelePrescriptionLineRow,
  VarianceTallyRow,
} from './handoffs.types.js';

/**
 * OP-018, OP-021 and IP-020 — the hand-offs.
 *
 * ── Nothing here decides whether a drug may be prescribed ──────────────────
 *
 * The four lists live in `mdm.telemedicine_drug_rules` and a trigger reads
 * them against the consultation's mode and type. What this service adds is
 * saying so *first*: `reachableLists` and the drug catalogue's `reachable` flag
 * are the same rule read forwards, so a doctor sees that List B is out of reach
 * on a first consultation before they have typed a drug rather than after.
 *
 * ── Nor when a referral is due ─────────────────────────────────────────────
 *
 * The database derives it from the urgency. This service computes only
 * `hoursRemaining`, which is that number minus now, and lets it go negative —
 * "eleven days overdue" is the fact worth showing, and clamping it to zero
 * would hide exactly the referrals the module exists to surface.
 *
 * ── Nor what a pathway's adherence is ──────────────────────────────────────
 *
 * A trigger counts it from the step records on every insert, update and
 * delete. `outstanding` is the other half of the same picture: the steps the
 * pathway defines that have no record at all, which no roll-up can see because
 * a step nobody recorded leaves no row to count.
 */
@Injectable()
export class HandoffsService extends ConsoleSupport {
  // ══ OP-018 · telemedicine ════════════════════════════════════════════════

  async openConsult(body: TeleConsultRequest): Promise<TeleConsultRow> {
    return this.guard(async (tx) => {
      const id = newId();
      await tx.query(
        `INSERT INTO specialty.tele_consults
           (id, hospital_id, branch_id, patient_id, practitioner_id, practitioner_reg_no, mode,
            first_consult, follows_consult_id, initiated_by, consent_id, identity_verification,
            started_at, complaint, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::specialty."ConsultMode",$8,$9,$10,$11,$12::jsonb,
                 $13::timestamptz,$14,$15,now(),now())`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.patientId,
          body.practitionerId,
          body.practitionerRegNo,
          body.mode,
          body.firstConsult,
          body.followsConsultId ?? null,
          body.initiatedBy,
          body.consentId ?? null,
          JSON.stringify(body.identityVerification),
          body.startedAt,
          body.complaint ?? null,
          this.actorId(),
        ],
      );
      return this.consultWithin(tx, id);
    });
  }

  async closeConsult(id: string, body: TeleConsultCloseRequest): Promise<TeleConsultRow> {
    return this.guard(async (tx) => {
      await tx.query(
        `UPDATE specialty.tele_consults
            SET ended_at           = coalesce($2::timestamptz, ended_at, now()),
                advice             = coalesce($3, advice),
                referred_in_person = coalesce($4::boolean, referred_in_person),
                updated_at         = now()
          WHERE id = $1 AND hospital_id = $5`,
        [id, body.endedAt ?? null, body.advice ?? null, body.referredInPerson ?? null, this.hospitalId()],
      );
      return this.consultWithin(tx, id);
    });
  }

  async listConsults(query: TeleQuery): Promise<readonly TeleConsultRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `${CONSULT_SELECT}
          WHERE c.hospital_id = $1
            AND ($2::uuid IS NULL OR c.patient_id = $2::uuid)
            AND ($3::text IS NULL OR c.mode::text = $3::text)
            AND ($4::boolean IS NOT TRUE OR c.ended_at IS NULL)
          ORDER BY c.started_at DESC
          LIMIT $5`,
        [this.hospitalId(), query.patientId ?? null, query.mode ?? null, query.openOnly, query.limit],
      );
      return rows.map((x) => this.toConsult(x));
    });
  }

  /**
   * A prescription line, and the lists that decide whether it may exist.
   *
   * The refusal comes from the database, so the only thing worth doing here on
   * failure is telling somebody outside the consultation that it happened: a
   * doctor reaching for a prohibited drug remotely is usually a patient who
   * needs to be seen today.
   */
  async prescribe(consultId: string, body: TelePrescriptionRequest): Promise<TelePrescriptionLineRow> {
    // Held outside the transaction so the refusal can still be described after
    // that transaction has been rolled back by the trigger.
    const seen: { consult: TeleConsultRow | null } = { consult: null };
    try {
      return await this.guard(async (tx) => {
        seen.consult = await this.consultWithin(tx, consultId);
        const id = newId();
        await tx.query(
          `INSERT INTO specialty.tele_prescription_lines
             (id, hospital_id, consult_id, drug_key, drug_name, dose, frequency, duration_days,
              created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),now())`,
          [
            id,
            this.hospitalId(),
            consultId,
            body.drugKey,
            body.drugName,
            body.dose,
            body.frequency,
            body.durationDays,
          ],
        );
        const { rows } = await tx.query<Record<string, unknown>>(
          `SELECT * FROM specialty.tele_prescription_lines WHERE id = $1`,
          [id],
        );
        return this.toLine(this.one(rows));
      });
    } catch (err) {
      // The pattern across a month is what tells a hospital its telemedicine
      // service is being asked to do something it cannot. One refusal is a
      // clinical fact; thirty are a service-design one. Published in a new
      // transaction, because the one that tried the insert is gone.
      const consult = seen.consult;
      if (consult !== null) await this.publishRefusal(consultId, consult, body.drugKey);
      throw err;
    }
  }

  async listPrescriptions(consultId: string): Promise<readonly TelePrescriptionLineRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT l.* FROM specialty.tele_prescription_lines l
           JOIN specialty.tele_consults c ON c.id = l.consult_id
          WHERE l.consult_id = $1 AND l.hospital_id = $2
          ORDER BY l.created_at`,
        [consultId, this.hospitalId()],
      );
      return rows.map((x) => this.toLine(x));
    });
  }

  /**
   * The four lists, read against one consultation.
   *
   * The prohibited entries are returned rather than hidden, marked unreachable
   * with the reason. A catalogue that quietly omits them teaches a doctor the
   * drug is missing from the formulary; one that shows them refused teaches
   * what the rule actually is.
   */
  async listDrugRules(consultId: string | undefined): Promise<readonly TeleDrugRuleRow[]> {
    return this.guard(async (tx) => {
      const consult = consultId === undefined ? null : await this.consultWithin(tx, consultId);
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT drug_key, drug_name, list_code, note
           FROM mdm.telemedicine_drug_rules
          ORDER BY list_code, drug_name`,
      );
      return rows.map((r) => {
        const listCode = asText(r.list_code);
        // With no consultation named, the only thing that can be said is what
        // is true of every consultation: the prohibited list is out of reach.
        const reason =
          consult === null
            ? listCode === 'prohibited'
              ? 'scheduled under the NDPS Act — never prescribable by telemedicine'
              : null
            : reachability(listCode, consult);
        return {
          drugKey: asText(r.drug_key),
          drugName: asText(r.drug_name),
          listCode,
          note: asTextOrNull(r.note),
          reachable: reason === null,
          reason,
        };
      });
    });
  }

  // ══ OP-021 · referrals ═══════════════════════════════════════════════════

  async raiseReferral(body: ReferralRequest): Promise<ReferralRow> {
    return this.guard(async (tx) => {
      const id = newId();
      await tx.query(
        `INSERT INTO clinical.referrals
           (id, hospital_id, branch_id, encounter_id, patient_id, from_user_id,
            to_department_key, to_practitioner_key, external_facility, urgency, reason,
            shared_note, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::clinical."ReferralUrgency",$11,$12,$13,now(),now())`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.encounterId,
          body.patientId,
          this.actorId(),
          body.toDepartmentKey ?? null,
          body.toPractitionerKey ?? null,
          body.externalFacility ?? null,
          body.urgency,
          body.reason,
          body.sharedNote ?? null,
          this.actorId(),
        ],
      );
      return this.referralWithin(tx, id);
    });
  }

  async acknowledgeReferral(id: string): Promise<ReferralRow> {
    return this.guard(async (tx) => {
      await tx.query(
        `UPDATE clinical.referrals
            SET acknowledged_at = coalesce(acknowledged_at, now()),
                status = CASE WHEN status = 'sent' THEN 'accepted'::clinical."ReferralStatus"
                              ELSE status END,
                updated_at = now(), updated_by = $2
          WHERE id = $1 AND hospital_id = $3`,
        [id, this.actorId(), this.hospitalId()],
      );
      return this.referralWithin(tx, id);
    });
  }

  /**
   * The reply, and closure with it when asked.
   *
   * Closure is in the same call rather than a route of its own, because a
   * separate `POST /close` is a route somebody eventually calls without the
   * reply — and while the database would refuse it, the honest design is not to
   * offer the shape at all.
   */
  async replyToReferral(id: string, body: ReferralReplyRequest): Promise<ReferralRow> {
    return this.guard(async (tx) => {
      const before = await this.referralWithin(tx, id);
      await tx.query(
        `UPDATE clinical.referrals
            SET reply_text = $2, replied_at = now(), replied_by = $3,
                target_visit_id = coalesce($4::uuid, target_visit_id),
                status = CASE WHEN $5 THEN 'closed'::clinical."ReferralStatus"
                              ELSE 'replied'::clinical."ReferralStatus" END,
                updated_at = now(), updated_by = $3
          WHERE id = $1 AND hospital_id = $6`,
        [id, body.replyText, this.actorId(), body.targetVisitId ?? null, body.close, this.hospitalId()],
      );
      const after = await this.referralWithin(tx, id);

      await this.audit.write(tx, {
        action: 'update',
        entity: 'referral',
        rowId: id,
        businessKey: after.urgency,
        dataClass: 'phi',
        patientId: after.patientId,
        encounterId: after.encounterId,
        reasonText: null,
        before: { status: before.status, repliedAt: before.repliedAt },
        after: { status: after.status, repliedAt: after.repliedAt },
      });

      return after;
    });
  }

  async cancelReferral(id: string, body: ReferralCancelRequest): Promise<ReferralRow> {
    return this.guard(async (tx) => {
      const before = await this.referralWithin(tx, id);
      await tx.query(
        `UPDATE clinical.referrals
            SET status = 'cancelled'::clinical."ReferralStatus", updated_at = now(), updated_by = $2
          WHERE id = $1 AND hospital_id = $3`,
        [id, this.actorId(), this.hospitalId()],
      );
      const after = await this.referralWithin(tx, id);

      // A cancellation is not a closure, and the difference is the whole point:
      // one says somebody answered, the other says nobody will.
      await this.audit.write(tx, {
        action: 'update',
        entity: 'referral',
        rowId: id,
        businessKey: after.urgency,
        dataClass: 'phi',
        patientId: after.patientId,
        encounterId: after.encounterId,
        reasonText: body.reason,
        before: { status: before.status },
        after: { status: after.status },
      });

      return after;
    });
  }

  async listReferrals(query: ReferralQuery): Promise<readonly ReferralRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM clinical.referrals r
          WHERE r.hospital_id = $1
            AND ($2::uuid IS NULL OR r.patient_id = $2::uuid)
            AND ($3::text IS NULL OR r.urgency::text = $3::text)
            AND ($4::boolean IS NOT TRUE
                 OR (r.replied_at IS NULL
                     AND r.status NOT IN ('cancelled','closed')
                     AND r.reply_due_at < now()))
            AND ($5::boolean IS NOT TRUE
                 OR (r.replied_at IS NULL AND r.status NOT IN ('cancelled','closed')))
          ORDER BY r.reply_due_at
          LIMIT $6`,
        [
          this.hospitalId(),
          query.patientId ?? null,
          query.urgency ?? null,
          query.overdueOnly,
          query.awaitingReplyOnly,
          query.limit,
        ],
      );
      return rows.map((x) => this.toReferral(x));
    });
  }

  // ══ IP-020 · clinical pathways ═══════════════════════════════════════════

  async startPathway(body: PathwayRequest): Promise<PathwayInstanceRow> {
    return this.guard(async (tx) => {
      const id = newId();
      await tx.query(
        `INSERT INTO specialty.pathway_instances
           (id, hospital_id, branch_id, patient_id, admission_id, pathway_key, pathway_name,
            version, steps, started_at, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::timestamptz,$11,now(),now())`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.patientId,
          body.admissionId ?? null,
          body.pathwayKey,
          body.pathwayName,
          body.version,
          JSON.stringify(body.steps),
          body.startedAt,
          this.actorId(),
        ],
      );
      return this.pathwayWithin(tx, id);
    });
  }

  async recordStep(instanceId: string, body: PathwayStepRequest): Promise<PathwayInstanceRow> {
    return this.guard(async (tx) => {
      const id = newId();
      await tx.query(
        `INSERT INTO specialty.pathway_step_records
           (id, hospital_id, instance_id, step_key, day_no, outcome, done_at,
            variance_reason, variance_category, recorded_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,$8,$9,$10,now(),now())
         ON CONFLICT (instance_id, step_key) DO UPDATE
            SET day_no = EXCLUDED.day_no, outcome = EXCLUDED.outcome, done_at = EXCLUDED.done_at,
                variance_reason = EXCLUDED.variance_reason,
                variance_category = EXCLUDED.variance_category,
                recorded_by = EXCLUDED.recorded_by, updated_at = now()`,
        [
          id,
          this.hospitalId(),
          instanceId,
          body.stepKey,
          body.dayNo,
          body.outcome,
          body.doneAt ?? null,
          body.varianceReason ?? null,
          body.varianceCategory ?? null,
          this.actorId(),
        ],
      );
      const instance = await this.pathwayWithin(tx, instanceId);

      // Three of the four categories are the hospital's problem, and the
      // variance log is the only place those show up before they show up as
      // length of stay.
      if (body.outcome === 'varied' && body.varianceCategory !== undefined) {
        await this.outbox.publish(
          tx,
          consoleEvent('pathway.variance.recorded', instanceId, {
            recordId: id,
            instanceId,
            pathwayKey: instance.pathwayKey,
            stepKey: body.stepKey,
            dayNo: body.dayNo,
            varianceCategory: body.varianceCategory,
            adherencePct: instance.adherencePct,
          }),
        );
      }

      return instance;
    });
  }

  async listPathways(query: PathwayQuery): Promise<readonly PathwayInstanceRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `${PATHWAY_SELECT}
          WHERE p.hospital_id = $1
            AND ($2::uuid IS NULL OR p.patient_id = $2::uuid)
            AND ($3::text IS NULL OR p.pathway_key = $3::text)
            AND ($4::boolean IS NOT TRUE OR p.completed_at IS NULL)
          ORDER BY p.started_at DESC
          LIMIT $5`,
        [this.hospitalId(), query.patientId ?? null, query.pathwayKey ?? null, query.openOnly, query.limit],
      );
      return rows.map((x) => this.toPathway(x));
    });
  }

  async listSteps(instanceId: string): Promise<readonly PathwayStepRecordRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM specialty.pathway_step_records
          WHERE instance_id = $1 AND hospital_id = $2
          ORDER BY day_no, step_key`,
        [instanceId, this.hospitalId()],
      );
      return rows.map((r) => ({
        id: asText(r.id),
        instanceId: asText(r.instance_id),
        stepKey: asText(r.step_key),
        dayNo: asNumber(r.day_no),
        outcome: asText(r.outcome),
        doneAt: asTextOrNull(r.done_at),
        varianceReason: asTextOrNull(r.variance_reason),
        varianceCategory: asTextOrNull(r.variance_category),
        recordedBy: asText(r.recorded_by),
      }));
    });
  }

  /**
   * The variance analysis — the reason anybody writes a pathway down.
   *
   * A pathway that is followed tells you nothing. Which of the four categories
   * the departures fall into is the finding, and three of them are actionable
   * by the hospital that ran the query.
   */
  async varianceReport(pathwayKey: string | undefined): Promise<readonly VarianceTallyRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT s.variance_category, count(*)::int AS n
           FROM specialty.pathway_step_records s
           JOIN specialty.pathway_instances p ON p.id = s.instance_id
          WHERE s.hospital_id = $1
            AND s.outcome = 'varied'
            AND ($2::text IS NULL OR p.pathway_key = $2::text)
          GROUP BY s.variance_category
          ORDER BY n DESC`,
        [this.hospitalId(), pathwayKey ?? null],
      );
      return rows.map((r) => {
        const category = asText(r.variance_category);
        return {
          varianceCategory: category,
          count: asNumber(r.n),
          // The patient's own choice is the one departure that is not a
          // failure of the hospital, and counting it with the other three is
          // how a good pathway looks like a badly run one.
          hospitalOwned: category !== 'patient',
        };
      });
    });
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  private one(rows: readonly Record<string, unknown>[]): Record<string, unknown> {
    const row = rows[0];
    if (row === undefined) throw AppError.notFound('That record was not found.');
    return row;
  }

  private async consultWithin(tx: TransactionClient, id: string): Promise<TeleConsultRow> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `${CONSULT_SELECT} WHERE c.id = $1 AND c.hospital_id = $2`,
      [id, this.hospitalId()],
    );
    return this.toConsult(this.one(rows));
  }

  private async referralWithin(tx: TransactionClient, id: string): Promise<ReferralRow> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM clinical.referrals WHERE id = $1 AND hospital_id = $2`,
      [id, this.hospitalId()],
    );
    return this.toReferral(this.one(rows));
  }

  private async pathwayWithin(tx: TransactionClient, id: string): Promise<PathwayInstanceRow> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `${PATHWAY_SELECT} WHERE p.id = $1 AND p.hospital_id = $2`,
      [id, this.hospitalId()],
    );
    return this.toPathway(this.one(rows));
  }

  private async publishRefusal(consultId: string, consult: TeleConsultRow, drugKey: string): Promise<void> {
    await this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT list_code FROM mdm.telemedicine_drug_rules WHERE drug_key = $1`,
        [drugKey],
      );
      const listCode = rows[0] === undefined ? null : asTextOrNull(rows[0].list_code);
      await this.outbox.publish(
        tx,
        consoleEvent('tele.prescription.refused', consultId, {
          consultId,
          practitionerId: consult.practitionerId,
          drugKey,
          listCode,
          mode: consult.mode,
          firstConsult: consult.firstConsult,
        }),
      );
    });
  }

  private toConsult(r: Record<string, unknown>): TeleConsultRow {
    const mode = asText(r.mode);
    const firstConsult = asBool(r.first_consult);
    const identityVerified = asBool(r.identity_verified);
    const regNoPresent = asText(r.practitioner_reg_no).trim().length >= 3;

    const blockedBy: string[] = [];
    if (!identityVerified) blockedBy.push('the patient’s identity has not been verified');
    if (!regNoPresent) blockedBy.push('the practitioner’s registration number is missing');

    // The lists, read forwards. The prohibited list is not among them on any
    // consultation, which is why it is not a case here.
    const reachableLists: string[] = [];
    if (identityVerified && regNoPresent) {
      reachableLists.push('list_o');
      if (!firstConsult || mode === 'video') reachableLists.push('list_a');
      if (!firstConsult) reachableLists.push('list_b');
    }
    if (firstConsult && mode !== 'video') {
      blockedBy.push('List A needs video on a first consultation');
    }
    if (firstConsult) blockedBy.push('List B needs a follow-up');

    return {
      id: asText(r.id),
      patientId: asText(r.patient_id),
      practitionerId: asText(r.practitioner_id),
      practitionerRegNo: asText(r.practitioner_reg_no),
      mode,
      firstConsult,
      followsConsultId: asTextOrNull(r.follows_consult_id),
      initiatedBy: asText(r.initiated_by),
      identityVerified,
      startedAt: asText(r.started_at),
      endedAt: asTextOrNull(r.ended_at),
      complaint: asTextOrNull(r.complaint),
      advice: asTextOrNull(r.advice),
      referredInPerson: asBool(r.referred_in_person),
      prescriptionLines: asNumber(r.line_count),
      reachableLists,
      blockedBy,
    };
  }

  private toLine(r: Record<string, unknown>): TelePrescriptionLineRow {
    return {
      id: asText(r.id),
      consultId: asText(r.consult_id),
      drugKey: asText(r.drug_key),
      drugName: asText(r.drug_name),
      dose: asText(r.dose),
      frequency: asText(r.frequency),
      durationDays: asNumber(r.duration_days),
      listCode: asTextOrNull(r.list_code),
    };
  }

  private toReferral(r: Record<string, unknown>): ReferralRow {
    const replyDueAt = asText(r.reply_due_at);
    const repliedAt = asTextOrNull(r.replied_at);
    const status = asText(r.status);
    const settled = repliedAt !== null || status === 'cancelled' || status === 'closed';

    // Deliberately signed. "Eleven days overdue" is the fact worth showing, and
    // clamping at zero would hide exactly the referrals this module exists for.
    const hoursRemaining = Math.round(((new Date(replyDueAt).getTime() - Date.now()) / 3_600_000) * 10) / 10;

    return {
      id: asText(r.id),
      patientId: asText(r.patient_id),
      encounterId: asText(r.encounter_id),
      fromUserId: asText(r.from_user_id),
      toDepartmentKey: asTextOrNull(r.to_department_key),
      toPractitionerKey: asTextOrNull(r.to_practitioner_key),
      externalFacility: asTextOrNull(r.external_facility),
      urgency: asText(r.urgency),
      reason: asText(r.reason),
      status,
      createdAt: asText(r.created_at),
      replyDueAt,
      acknowledgedAt: asTextOrNull(r.acknowledged_at),
      repliedAt,
      replyText: asTextOrNull(r.reply_text),
      overdue: !settled && hoursRemaining < 0,
      hoursRemaining,
    };
  }

  private toPathway(r: Record<string, unknown>): PathwayInstanceRow {
    const defined = definedSteps(r.steps);
    const recorded = asStepKeys(r.recorded_keys);
    return {
      id: asText(r.id),
      patientId: asText(r.patient_id),
      admissionId: asTextOrNull(r.admission_id),
      pathwayKey: asText(r.pathway_key),
      pathwayName: asText(r.pathway_name),
      version: asNumber(r.version),
      startedAt: asText(r.started_at),
      completedAt: asTextOrNull(r.completed_at),
      adherencePct: asTextOrNull(r.adherence_pct),
      varianceCount: asNumber(r.variance_count),
      stepsRecorded: recorded.length,
      stepsDefined: defined.length,
      // A step nobody recorded leaves no row, so the roll-up cannot see it.
      // This is the other half of the same picture.
      outstanding: defined.filter((s) => !recorded.includes(s.key)).map((s) => s.key),
    };
  }
}

/** Why a list is out of reach on this consultation, or null when it is not. */
function reachability(listCode: string, consult: TeleConsultRow): string | null {
  if (listCode === 'prohibited') {
    return 'scheduled under the NDPS Act — never prescribable by telemedicine';
  }
  if (!consult.identityVerified) return 'the patient’s identity has not been verified';
  if (listCode === 'list_a' && consult.firstConsult && consult.mode !== 'video') {
    return 'List A on a first consultation needs video';
  }
  if (listCode === 'list_b' && consult.firstConsult) {
    return 'List B is an add-on and needs a follow-up';
  }
  return null;
}

interface StepDefinition {
  readonly key: string;
  readonly day: number;
}

function definedSteps(value: unknown): readonly StepDefinition[] {
  if (!Array.isArray(value)) return [];
  const out: StepDefinition[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const key = record.key;
    if (typeof key !== 'string') continue;
    out.push({ key, day: typeof record.day === 'number' ? record.day : 0 });
  }
  return out.sort((a, b) => a.day - b.day);
}

function asStepKeys(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is string => typeof x === 'string');
}

const CONSULT_SELECT = `
  SELECT c.*,
         (c.identity_verification <> '{}'::jsonb) AS identity_verified,
         (SELECT count(*) FROM specialty.tele_prescription_lines l WHERE l.consult_id = c.id)
           AS line_count
    FROM specialty.tele_consults c`;

const PATHWAY_SELECT = `
  SELECT p.*,
         coalesce((SELECT array_agg(s.step_key)
                     FROM specialty.pathway_step_records s
                    WHERE s.instance_id = p.id), ARRAY[]::varchar[]) AS recorded_keys
    FROM specialty.pathway_instances p`;
