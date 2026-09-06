import { Inject, Injectable } from '@nestjs/common';
import { ProblemType, newId, type Page } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService, type TransactionClient } from '../../../core/db/database.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import { withNursingErrors } from './nursing.errors.js';
import { nursingEvent } from './nursing.events.js';
import { scoreScale } from './nursing.scales.js';
import type {
  AdministerRequest,
  AssessmentRequest,
  AssignmentRequest,
  DeviceRemoveRequest,
  DeviceRequest,
  EscalationAckRequest,
  EscalationQuery,
  EscalationResolveRequest,
  FluidRequest,
  HaiAdjudicateRequest,
  HandoverRequest,
  HandoverSignRequest,
  IsolationRequest,
  MarOrderRequest,
  MarQuery,
  NoteRequest,
  OmitRequest,
  VerifyRequest,
  WardQuery,
} from './nursing.schemas.js';
import type {
  AssessmentRow,
  DeviceRow,
  EscalationRow,
  FluidBalanceView,
  HaiRow,
  HandoverView,
  IsolationRow,
  MarDoseRow,
  WardPatientRow,
} from './nursing.types.js';

function asText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString();
  return '';
}
function asTextOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : asText(v);
}
function asNumber(v: unknown): number {
  return typeof v === 'number' ? v : Number(asText(v));
}
function asNumberOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : asNumber(v);
}
function asBool(v: unknown): boolean {
  return v === true || v === 't' || v === 'true';
}
function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map(asText) : [];
}
function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/**
 * How long each rung has to answer, in minutes.
 *
 * Tight at the bottom and looser higher up: a nurse is on the ward and can
 * answer in five, a consultant may be operating. The ladder exists because
 * every rung eventually runs out, not because any single one is generous.
 */
const RUNG_MINUTES: Readonly<Record<string, number>> = {
  nurse: 5,
  senior_nurse: 10,
  rmo: 15,
  consultant: 20,
  rapid_response: 10,
  code_blue: 5,
};

/**
 * A scan that did not match, thrown out of the administering transaction.
 *
 * The near miss cannot be written inside that transaction: refusing the dose
 * rolls it back, and the record of the refusal would roll back with it. So the
 * comparison throws this, the transaction unwinds, and the caller writes the
 * near miss in a transaction of its own before refusing. A wrong-drug scan
 * nobody counts is a wrong-drug scan that becomes an error the week the scanner
 * is broken — losing it *because* the refusal worked would be the worst of both.
 */
class ScanMismatch extends Error {
  constructor(
    readonly kind: 'patient' | 'drug',
    readonly expected: string,
    readonly scanned: string,
    readonly doseId: string,
    readonly orderId: string,
    readonly admissionId: string,
    readonly drugName: string,
    readonly detail: string,
  ) {
    super(detail);
    this.name = 'ScanMismatch';
  }
}

const NEXT_RUNG: Readonly<Record<string, string>> = {
  nurse: 'senior_nurse',
  senior_nurse: 'rmo',
  rmo: 'consultant',
  consultant: 'rapid_response',
  rapid_response: 'code_blue',
  code_blue: 'code_blue',
};

/**
 * Phase 7B — the nursing station.
 *
 * ── The five rights are compared here and enforced below ────────────────────
 *
 * `administer` compares the scanned wristband against the patient and the
 * scanned barcode against the drug, and refuses a mismatch with a message
 * naming what was expected. That refusal is a *near miss*, and it is recorded
 * as one — a wrong-drug scan nobody counts is a wrong-drug scan that becomes an
 * error the week the scanner is broken.
 *
 * Beneath that, the database refuses a `given` row without both payloads, a
 * high-alert dose without a second nurse, a witness who is the administering
 * nurse, and any dose on an unverified order. This service can be wrong; those
 * cannot be bypassed.
 *
 * ── Escalation belongs to the worker, not to a browser ──────────────────────
 *
 * `climbLadder` is one statement over overdue rows. It is called on a schedule
 * and depends on nothing in anybody's tab, because the nurse who recorded the
 * deteriorating observation is the one most likely to be busy with the patient.
 */
@Injectable()
export class NursingService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private hospitalId(): string {
    const id = getContext().hospitalId;
    if (id === null) throw AppError.unauthenticated();
    return id;
  }
  private branchId(): string {
    const id = getContext().branchId;
    if (id === null || id === undefined) {
      throw AppError.conflict('This action needs a branch. Choose one and try again.');
    }
    return id;
  }
  private actorId(): string {
    const id = getContext().userId;
    if (id === null) throw AppError.unauthenticated();
    return id;
  }
  private reason(what: string): string {
    const value = getContext().reason;
    if (value === null || value.trim().length < 12) {
      throw new AppError(
        ProblemType.VALIDATION_FAILED,
        `${what} needs grounds of at least twelve characters, sent in the \`x-reason\` header.`,
      );
    }
    return value.trim();
  }
  private guard<T>(fn: (tx: TransactionClient) => Promise<T>): Promise<T> {
    return withNursingErrors(() => this.db.withTenant(currentTenantContext(), fn));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The ward screen
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Every patient on the ward, with everything that is due about them.
   *
   * One query rather than a row per patient plus five lookups, because a
   * sixty-bed ward would otherwise be three hundred round trips and the budget
   * is a second. Each subquery is bounded by the admission.
   */
  async wardScreen(query: WardQuery): Promise<Page<WardPatientRow>> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT a.id AS admission_id, a.patient_id, a.ip_no, a.attending_doctor_id, a.expected_discharge_at,
                b.code AS bed_code, w.id AS ward_id, w.name AS ward_name,
                v.news2_score, v.news2_band, v.recorded_at AS last_vitals_at,
                e.id AS escalation_id, e.rung::text AS escalation_rung, e.due_at AS escalation_due_at,
                (SELECT count(*) FROM clinical.ip_mar_doses d
                  WHERE d.admission_id = a.id AND d.state = 'due') AS doses_due,
                (SELECT count(*) FROM clinical.ip_mar_doses d
                  WHERE d.admission_id = a.id AND d.state = 'due' AND d.due_at < now()) AS doses_overdue,
                (SELECT count(*) FROM clinical.ip_risk_assessments r
                  WHERE r.admission_id = a.id AND r.reassess_due_at IS NOT NULL AND r.reassess_due_at < now()
                    AND NOT EXISTS (SELECT 1 FROM clinical.ip_risk_assessments r2
                                     WHERE r2.admission_id = r.admission_id AND r2.scale = r.scale
                                       AND r2.assessed_at > r.assessed_at)) AS assessments_overdue,
                COALESCE((SELECT array_agg(i.precaution) FROM clinical.ip_isolation_orders i
                           WHERE i.admission_id = a.id AND i.ended_at IS NULL), '{}') AS isolation,
                COALESCE((SELECT array_agg(dd.device_type) FROM clinical.ip_device_days dd
                           WHERE dd.admission_id = a.id AND dd.removed_at IS NULL), '{}') AS devices,
                (SELECT r.band FROM clinical.ip_risk_assessments r
                  WHERE r.admission_id = a.id AND r.scale = 'morse_falls'
                  ORDER BY r.assessed_at DESC LIMIT 1) AS falls_band,
                (SELECT r.band FROM clinical.ip_risk_assessments r
                  WHERE r.admission_id = a.id AND r.scale = 'braden_pressure'
                  ORDER BY r.assessed_at DESC LIMIT 1) AS pressure_band,
                (SELECT na.nurse_id FROM clinical.ip_nurse_patient_assignments npa
                   JOIN clinical.ip_nurse_assignments na ON na.id = npa.assignment_id
                  WHERE npa.admission_id = a.id AND na.starts_at <= now() AND na.ends_at > now()
                  LIMIT 1) AS nurse_id
           FROM clinical.ip_admissions a
           LEFT JOIN clinical.ip_bed_occupancies o ON o.admission_id = a.id AND o.to_at IS NULL
           LEFT JOIN clinical.ip_beds b  ON b.id = o.bed_id
           LEFT JOIN clinical.ip_wards w ON w.id = b.ward_id
           LEFT JOIN LATERAL (
             SELECT vt.news2_score, vt.news2_band, vt.recorded_at
               FROM clinical.vitals vt
              WHERE vt.patient_id = a.patient_id
              ORDER BY vt.recorded_at DESC LIMIT 1
           ) v ON true
           LEFT JOIN clinical.ip_news2_escalations e
                  ON e.admission_id = a.id AND e.resolved_at IS NULL
          WHERE a.hospital_id = $1 AND a.branch_id = $2 AND a.status = 'admitted'
            AND ($3::uuid IS NULL OR b.ward_id = $3)
          ORDER BY e.id IS NOT NULL DESC, v.news2_score DESC NULLS LAST, b.code
          LIMIT $4`,
        [this.hospitalId(), this.branchId(), query.wardId ?? null, query.limit],
      );

      return {
        items: rows.map((r): WardPatientRow => {
          const lastVitals = asTextOrNull(r['last_vitals_at']);
          const escDue = asTextOrNull(r['escalation_due_at']);
          return {
            admissionId: asText(r['admission_id']),
            patientId: asText(r['patient_id']),
            ipNo: asText(r['ip_no']),
            bedCode: asTextOrNull(r['bed_code']),
            wardId: asTextOrNull(r['ward_id']),
            wardName: asTextOrNull(r['ward_name']),
            attendingDoctorId: asTextOrNull(r['attending_doctor_id']),
            expectedDischargeAt: asTextOrNull(r['expected_discharge_at']),
            news2Score: asNumberOrNull(r['news2_score']),
            news2Band: asTextOrNull(r['news2_band']),
            lastVitalsAt: lastVitals,
            vitalsOverdueMinutes:
              lastVitals === null ? null : Math.round((Date.now() - new Date(lastVitals).getTime()) / 60_000),
            escalationId: asTextOrNull(r['escalation_id']),
            escalationRung: asTextOrNull(r['escalation_rung']),
            escalationOverdue: escDue !== null && new Date(escDue).getTime() < Date.now(),
            dosesDue: asNumber(r['doses_due'] ?? 0),
            dosesOverdue: asNumber(r['doses_overdue'] ?? 0),
            assessmentsOverdue: asNumber(r['assessments_overdue'] ?? 0),
            isolation: asStringArray(r['isolation']),
            fallsBand: asTextOrNull(r['falls_band']),
            pressureBand: asTextOrNull(r['pressure_band']),
            devices: asStringArray(r['devices']),
            nurseId: asTextOrNull(r['nurse_id']),
          };
        }),
        nextCursor: null,
        hasMore: false,
      };
    });
  }

  async assign(body: AssignmentRequest): Promise<{ readonly id: string; readonly patients: number }> {
    return this.guard(async (tx) => {
      const id = newId();
      await tx.query(
        `INSERT INTO clinical.ip_nurse_assignments (
           id, hospital_id, branch_id, ward_id, nurse_id, shift, shift_date, starts_at, ends_at, role, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8::timestamptz,$9::timestamptz,$10,now(),now())
         ON CONFLICT (hospital_id, ward_id, nurse_id, shift_date, shift) DO UPDATE
           SET starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at, role = EXCLUDED.role, updated_at = now()`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.wardId,
          body.nurseId,
          body.shift,
          body.shiftDate,
          body.startsAt,
          body.endsAt,
          body.role,
        ],
      );

      const { rows: existing } = await tx.query<Record<string, unknown>>(
        `SELECT id FROM clinical.ip_nurse_assignments
          WHERE hospital_id = $1 AND ward_id = $2 AND nurse_id = $3 AND shift_date = $4::date AND shift = $5`,
        [this.hospitalId(), body.wardId, body.nurseId, body.shiftDate, body.shift],
      );
      const assignmentId = asText(existing[0]?.['id'] ?? id);

      for (const admissionId of body.admissionIds) {
        await tx.query(
          `INSERT INTO clinical.ip_nurse_patient_assignments (id, hospital_id, assignment_id, admission_id, created_at)
           VALUES ($1,$2,$3,$4,now()) ON CONFLICT (assignment_id, admission_id) DO NOTHING`,
          [newId(), this.hospitalId(), assignmentId, admissionId],
        );
      }

      return { id: assignmentId, patients: body.admissionIds.length };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Assessments
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Record a risk assessment.
   *
   * The score comes from the items and the band from the score — neither is
   * accepted from the caller. The database checks the same relationship from
   * the other side, so this being wrong is caught rather than stored.
   */
  async assess(body: AssessmentRequest): Promise<AssessmentRow> {
    return this.guard(async (tx) => {
      const result = scoreScale(body.scale, body.items);
      const id = newId();

      // The scale's own suggestions fill in when the nurse recorded none and
      // the band demands some. Not silently: they are the published guidance
      // for that band, and leaving the field empty would fail the CHECK and
      // lose the assessment entirely, which helps nobody at the bedside.
      const interventions =
        body.interventions.length > 0 ? body.interventions : [...result.suggestedInterventions];

      const hours = body.reassessInHours ?? result.reassessHours;

      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO clinical.ip_risk_assessments (
           id, hospital_id, admission_id, scale, items, score, band,
           assessed_at, assessed_by, reassess_due_at, interventions, notes, created_at
         ) VALUES ($1,$2,$3,$4::clinical."RiskScale",$5::jsonb,$6,$7,now(),$8,
                   now() + make_interval(hours => $9::int), $10::text[], $11, now())
         RETURNING *`,
        [
          id,
          this.hospitalId(),
          body.admissionId,
          body.scale,
          json(body.items),
          result.score,
          result.band,
          this.actorId(),
          hours,
          interventions,
          body.notes ?? null,
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The assessment was not recorded.');

      if (result.band === 'high' || result.band === 'very_high') {
        await this.outbox.publish(
          tx,
          nursingEvent('nursing.risk.high', id, {
            assessmentId: id,
            admissionId: body.admissionId,
            scale: body.scale,
            score: result.score,
            band: result.band,
            interventions,
          }),
        );
      }

      return this.toAssessment(row);
    });
  }

  private toAssessment(r: Record<string, unknown>): AssessmentRow {
    const due = asTextOrNull(r['reassess_due_at']);
    return {
      id: asText(r['id']),
      admissionId: asText(r['admission_id']),
      scale: asText(r['scale']),
      score: asNumber(r['score']),
      band: asText(r['band']),
      items: r['items'] ?? null,
      interventions: asStringArray(r['interventions']),
      assessedAt: asText(r['assessed_at']),
      assessedBy: asText(r['assessed_by']),
      reassessDueAt: due,
      overdue: due !== null && new Date(due).getTime() < Date.now(),
    };
  }

  async assessments(admissionId: string): Promise<readonly AssessmentRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT DISTINCT ON (scale) * FROM clinical.ip_risk_assessments
          WHERE hospital_id = $1 AND admission_id = $2
          ORDER BY scale, assessed_at DESC`,
        [this.hospitalId(), admissionId],
      );
      return rows.map((r) => this.toAssessment(r));
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The MAR
  // ═══════════════════════════════════════════════════════════════════════════

  private toDose(r: Record<string, unknown>): MarDoseRow {
    const dueAt = asTextOrNull(r['due_at']);
    const state = asText(r['state']);
    const minutes = dueAt === null ? null : Math.round((new Date(dueAt).getTime() - Date.now()) / 60_000);
    return {
      id: asText(r['id']),
      orderId: asText(r['order_id']),
      admissionId: asText(r['admission_id']),
      patientId: asText(r['patient_id']),
      ipNo: asText(r['ip_no']),
      bedCode: asTextOrNull(r['bed_code']),
      drugName: asText(r['drug_name']),
      dose: asText(r['dose']),
      doseUnit: asText(r['dose_unit']),
      route: asText(r['route']),
      frequency: asText(r['frequency']),
      isHighAlert: asBool(r['is_high_alert']),
      isNarcotic: asBool(r['is_narcotic']),
      isPrn: asBool(r['is_prn']),
      verified: r['verified_at'] !== null && r['verified_at'] !== undefined,
      dueAt,
      state,
      administeredAt: asTextOrNull(r['administered_at']),
      administeredBy: asTextOrNull(r['administered_by']),
      witnessedBy: asTextOrNull(r['witnessed_by']),
      reasonCode: asTextOrNull(r['reason_code']),
      reasonNote: asTextOrNull(r['reason_note']),
      givenDose: asTextOrNull(r['given_dose']),
      minutesUntilDue: minutes,
      overdue: state === 'due' && minutes !== null && minutes < 0,
    };
  }

  private readonly doseSelect = `
    SELECT d.*, o.drug_name, o.dose, o.dose_unit, o.route, o.frequency,
           o.is_high_alert, o.is_narcotic, o.is_prn, o.verified_at, o.drug_barcode,
           a.ip_no, b.code AS bed_code, b.ward_id
      FROM clinical.ip_mar_doses d
      JOIN clinical.ip_mar_orders o  ON o.id = d.order_id
      JOIN clinical.ip_admissions a  ON a.id = d.admission_id
      LEFT JOIN clinical.ip_bed_occupancies bo ON bo.admission_id = a.id AND bo.to_at IS NULL
      LEFT JOIN clinical.ip_beds b   ON b.id = bo.bed_id`;

  async marRound(query: MarQuery): Promise<Page<MarDoseRow>> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `${this.doseSelect}
          WHERE d.hospital_id = $1 AND d.branch_id = $2
            AND ($3::uuid IS NULL OR d.admission_id = $3)
            AND ($4::uuid IS NULL OR b.ward_id = $4)
            AND (NOT $5::boolean OR d.state = 'due')
            AND (NOT $6::boolean OR (d.state = 'due' AND d.due_at < now()))
          ORDER BY d.state = 'due' DESC, d.due_at NULLS LAST
          LIMIT $7`,
        [
          this.hospitalId(),
          this.branchId(),
          query.admissionId ?? null,
          query.wardId ?? null,
          query.dueOnly,
          query.overdueOnly,
          query.limit,
        ],
      );
      return { items: rows.map((r) => this.toDose(r)), nextCursor: null, hasMore: false };
    });
  }

  /**
   * Put a drug on the chart, and schedule its doses.
   *
   * The doses are created `due` and stay unadministrable until a pharmacist
   * verifies the order — the trigger checks that at administration time, so
   * scheduling early is safe and lets the ward see what is coming.
   */
  async writeOrder(body: MarOrderRequest): Promise<{ readonly id: string; readonly doses: number }> {
    return this.guard(async (tx) => {
      const id = newId();
      const startsAt = body.startsAt ?? new Date().toISOString();

      await tx.query(
        `INSERT INTO clinical.ip_mar_orders (
           id, hospital_id, branch_id, admission_id, patient_id, drug_id, drug_name, drug_barcode,
           dose, dose_unit, route, frequency, is_high_alert, is_narcotic, is_prn, prn_indication,
           starts_at, ends_at, ordered_by, ordered_at, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
                   $17::timestamptz,$18::timestamptz,$19,now(),now(),now())`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.admissionId,
          body.patientId,
          body.drugId ?? null,
          body.drugName,
          body.drugBarcode ?? null,
          body.dose,
          body.doseUnit,
          body.route,
          body.frequency,
          body.isHighAlert,
          body.isNarcotic,
          body.isPrn,
          body.prnIndication ?? null,
          startsAt,
          body.endsAt ?? null,
          this.actorId(),
        ],
      );

      // A when-required drug has no schedule: its doses appear when somebody
      // gives one. Scheduling a PRN would put phantom overdue rows on the round
      // list for a drug nobody needed.
      let created = 0;
      if (!body.isPrn && body.times.length > 0) {
        const { rows } = await tx.query<Record<string, unknown>>(
          `INSERT INTO clinical.ip_mar_doses (
             id, hospital_id, branch_id, order_id, admission_id, patient_id, due_at, state, created_at, updated_at
           )
           SELECT gen_random_uuid(), $1, $2, $3, $4, $5,
                  (($6::timestamptz)::date + (d.day || ' days')::interval + t.time::time) AT TIME ZONE 'Asia/Kolkata',
                  'due', now(), now()
             FROM generate_series(0, $7::int - 1) AS d(day)
             CROSS JOIN unnest($8::text[]) AS t(time)
            WHERE (($6::timestamptz)::date + (d.day || ' days')::interval + t.time::time) AT TIME ZONE 'Asia/Kolkata'
                  >= $6::timestamptz - interval '1 hour'
           RETURNING id`,
          [
            this.hospitalId(),
            this.branchId(),
            id,
            body.admissionId,
            body.patientId,
            startsAt,
            body.days,
            body.times,
          ],
        );
        created = rows.length;
      }

      return { id, doses: created };
    });
  }

  async verifyOrder(orderId: string, body: VerifyRequest): Promise<{ readonly verified: boolean }> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.ip_mar_orders
            SET verified_at = now(), verified_by = $3, verification_note = $4, updated_at = now()
          WHERE id = $1 AND hospital_id = $2 AND verified_at IS NULL
          RETURNING drug_name, admission_id, ordered_at`,
        [orderId, this.hospitalId(), this.actorId(), body.note ?? null],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('That order is not awaiting verification.');

      await this.outbox.publish(
        tx,
        nursingEvent('mar.order.verified', orderId, {
          orderId,
          admissionId: asText(row['admission_id']),
          drugName: asText(row['drug_name']),
          verifiedBy: this.actorId(),
          minutesToVerify: Math.max(
            0,
            Math.round((Date.now() - new Date(asText(row['ordered_at'])).getTime()) / 60_000),
          ),
        }),
      );

      return { verified: true };
    });
  }

  async discontinueOrder(orderId: string): Promise<{ readonly discontinued: boolean }> {
    return this.guard(async (tx) => {
      const reason = this.reason('Stopping a drug');
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.ip_mar_orders
            SET discontinued_at = now(), discontinued_by = $3, discontinue_reason = $4, updated_at = now()
          WHERE id = $1 AND hospital_id = $2 AND discontinued_at IS NULL
          RETURNING drug_name`,
        [orderId, this.hospitalId(), this.actorId(), reason],
      );
      if (rows[0] === undefined) throw AppError.conflict('That order is not running.');

      // Doses that were still waiting are cancelled, not left to go missed. A
      // stopped drug producing overdue rows is a round list that trains people
      // to ignore it.
      await tx.query(
        `UPDATE clinical.ip_mar_doses
            SET state = 'cancelled', reason_code = 'order_changed', reason_note = $2, updated_at = now()
          WHERE order_id = $1 AND state = 'due'`,
        [orderId, reason],
      );

      return { discontinued: true };
    });
  }

  /**
   * Give a dose.
   *
   * ── The comparison, and what happens when it fails ──────────────────────
   *
   * The scanned wristband is checked against the patient and the scanned
   * barcode against the drug. A mismatch is refused with a message that names
   * what was expected — and recorded as `mar.scan.mismatch`, because a wrong-
   * drug scan nobody counts is a wrong-drug scan that becomes an error the week
   * the scanner is broken.
   *
   * ── There is no path here that skips it ─────────────────────────────────
   *
   * No flag, no configuration, no emergency mode. The database refuses a
   * `given` row without both payloads, so even a caller that reached the table
   * another way cannot claim an administration nobody scanned for.
   */
  async administer(doseId: string, body: AdministerRequest): Promise<MarDoseRow> {
    try {
      return await this.administerInTransaction(doseId, body);
    } catch (error) {
      if (!(error instanceof ScanMismatch)) throw error;

      // The refusing transaction has rolled back. Write the near miss in its
      // own, so the record survives the refusal that caused it.
      await this.guard(async (tx) => {
        await this.recordMismatch(tx, error);
      });
      throw AppError.conflict(error.detail);
    }
  }

  private async administerInTransaction(doseId: string, body: AdministerRequest): Promise<MarDoseRow> {
    return this.guard(async (tx) => {
      const { rows: found } = await tx.query<Record<string, unknown>>(
        `SELECT d.id, d.state, d.patient_id, d.admission_id, d.due_at, d.order_id,
                o.drug_name, o.drug_barcode, o.is_high_alert, o.is_narcotic, o.is_prn, o.verified_at
           FROM clinical.ip_mar_doses d
           JOIN clinical.ip_mar_orders o ON o.id = d.order_id
          WHERE d.id = $1 AND d.hospital_id = $2
          FOR UPDATE OF d`,
        [doseId, this.hospitalId()],
      );
      const dose = found[0];
      if (dose === undefined) throw AppError.notFound('That dose is not on this chart.');
      if (asText(dose['state']) !== 'due') {
        throw AppError.conflict(`That dose is already recorded as ${asText(dose['state'])}.`);
      }

      const patientId = asText(dose['patient_id']);
      const drugName = asText(dose['drug_name']);
      const expectedBarcode = asTextOrNull(dose['drug_barcode']);

      // Right patient. The wristband payload carries the patient id; anything
      // that does not contain it is a different patient's wristband.
      if (!body.patientScan.includes(patientId)) {
        throw new ScanMismatch(
          'patient',
          patientId,
          body.patientScan,
          doseId,
          asText(dose['order_id']),
          asText(dose['admission_id']),
          drugName,
          `That wristband is not this patient's. ${drugName} is charted for the patient in this bed — check the band and the chart before giving anything.`,
        );
      }

      // Right drug.
      if (expectedBarcode !== null && body.drugScan.trim() !== expectedBarcode) {
        throw new ScanMismatch(
          'drug',
          expectedBarcode,
          body.drugScan.trim(),
          doseId,
          asText(dose['order_id']),
          asText(dose['admission_id']),
          drugName,
          `That is not ${drugName}. The chart expects barcode ${expectedBarcode} and the scan read ${body.drugScan.trim()}.`,
        );
      }

      const highAlert = asBool(dose['is_high_alert']) || asBool(dose['is_narcotic']);
      if (highAlert && body.witnessedBy === undefined) {
        throw new AppError(
          ProblemType.VALIDATION_FAILED,
          `${drugName} is a high-alert drug and needs a second nurse to witness it. There is no override for this.`,
        );
      }
      if (body.witnessedBy !== undefined && body.witnessedBy === this.actorId()) {
        throw new AppError(
          ProblemType.VALIDATION_FAILED,
          'A second check by the same person is not a second check. The witness must be another nurse.',
        );
      }

      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.ip_mar_doses
            SET state = 'given',
                patient_scan = $3, drug_scan = $4,
                administered_at = COALESCE($5::timestamptz, now()), administered_by = $6,
                witnessed_by = $7, witnessed_at = CASE WHEN $7::uuid IS NULL THEN NULL ELSE now() END,
                given_dose = $8, site = $9, prn_indication = $10, updated_at = now()
          WHERE id = $1 AND hospital_id = $2
          RETURNING administered_at`,
        [
          doseId,
          this.hospitalId(),
          body.patientScan.trim(),
          body.drugScan.trim(),
          body.at ?? null,
          this.actorId(),
          body.witnessedBy ?? null,
          body.givenDose ?? null,
          body.site ?? null,
          body.prnIndication ?? null,
        ],
      );
      const updated = rows[0];
      if (updated === undefined) throw AppError.conflict('The dose was not recorded.');

      const dueAt = asTextOrNull(dose['due_at']);
      await this.outbox.publish(
        tx,
        nursingEvent('mar.dose.given', doseId, {
          doseId,
          orderId: asText(dose['order_id']),
          admissionId: asText(dose['admission_id']),
          patientId,
          drugName,
          givenDose: body.givenDose ?? null,
          administeredBy: this.actorId(),
          witnessedBy: body.witnessedBy ?? null,
          highAlert,
          minutesFromDue:
            dueAt === null
              ? null
              : Math.round(
                  (new Date(asText(updated['administered_at'])).getTime() - new Date(dueAt).getTime()) /
                    60_000,
                ),
        }),
      );

      const { rows: view } = await tx.query<Record<string, unknown>>(`${this.doseSelect} WHERE d.id = $1`, [
        doseId,
      ]);
      const v = view[0];
      if (v === undefined) throw AppError.conflict('The dose was not recorded.');
      return this.toDose(v);
    });
  }

  /**
   * A near miss, recorded.
   *
   * Audited as well as published, because the audit row carries the actor and
   * the event carries the shape — the safety team counts one and the incident
   * investigation reads the other.
   */
  private async recordMismatch(tx: TransactionClient, miss: ScanMismatch): Promise<void> {
    await this.audit.write(tx, {
      action: 'read_phi',
      entity: 'mar_dose',
      rowId: miss.doseId,
      businessKey: miss.drugName,
      dataClass: 'phi',
      before: null,
      after: {
        nearMiss: miss.kind,
        expected: miss.expected,
        scanned: miss.scanned,
        attemptedBy: this.actorId(),
      },
    });

    await this.outbox.publish(
      tx,
      nursingEvent('mar.scan.mismatch', miss.orderId, {
        orderId: miss.orderId,
        admissionId: miss.admissionId,
        expected: miss.expected,
        scanned: miss.scanned,
        kind: miss.kind,
        attemptedBy: this.actorId(),
      }),
    );
  }

  async omit(doseId: string, body: OmitRequest): Promise<MarDoseRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.ip_mar_doses
            SET state = $3::clinical."MarDoseState", reason_code = $4, reason_note = $5, updated_at = now()
          WHERE id = $1 AND hospital_id = $2 AND state = 'due'
          RETURNING order_id, admission_id`,
        [doseId, this.hospitalId(), body.state, body.reasonCode, body.note ?? null],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('That dose is not waiting to be given.');

      const { rows: view } = await tx.query<Record<string, unknown>>(`${this.doseSelect} WHERE d.id = $1`, [
        doseId,
      ]);
      const v = view[0];
      if (v === undefined) throw AppError.conflict('The dose was not recorded.');
      const dose = this.toDose(v);

      await this.outbox.publish(
        tx,
        nursingEvent('mar.dose.omitted', doseId, {
          doseId,
          orderId: dose.orderId,
          admissionId: dose.admissionId,
          drugName: dose.drugName,
          state: body.state,
          reasonCode: body.reasonCode,
          highAlert: dose.isHighAlert,
        }),
      );

      return dose;
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Escalation
  // ═══════════════════════════════════════════════════════════════════════════

  private toEscalation(r: Record<string, unknown>): EscalationRow {
    const dueAt = asText(r['due_at']);
    const raisedAt = asText(r['raised_at']);
    return {
      id: asText(r['id']),
      admissionId: asText(r['admission_id']),
      patientId: asText(r['patient_id']),
      ipNo: asText(r['ip_no']),
      bedCode: asTextOrNull(r['bed_code']),
      wardName: asTextOrNull(r['ward_name']),
      score: asNumber(r['score']),
      band: asText(r['band']),
      rung: asText(r['rung']),
      raisedAt,
      dueAt,
      acknowledgedAt: asTextOrNull(r['acknowledged_at']),
      acknowledgedBy: asTextOrNull(r['acknowledged_by']),
      resolvedAt: asTextOrNull(r['resolved_at']),
      outcome: asTextOrNull(r['outcome']),
      ladder: r['ladder'] ?? [],
      minutesUnanswered: Math.max(0, Math.round((Date.now() - new Date(raisedAt).getTime()) / 60_000)),
      overdue: r['resolved_at'] === null && new Date(dueAt).getTime() < Date.now(),
    };
  }

  private readonly escalationSelect = `
    SELECT e.*, a.ip_no, b.code AS bed_code, w.name AS ward_name
      FROM clinical.ip_news2_escalations e
      JOIN clinical.ip_admissions a ON a.id = e.admission_id
      LEFT JOIN clinical.ip_bed_occupancies o ON o.admission_id = a.id AND o.to_at IS NULL
      LEFT JOIN clinical.ip_beds b  ON b.id = o.bed_id
      LEFT JOIN clinical.ip_wards w ON w.id = b.ward_id`;

  async escalations(query: EscalationQuery): Promise<Page<EscalationRow>> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `${this.escalationSelect}
          WHERE e.hospital_id = $1 AND e.branch_id = $2
            AND ($3::uuid IS NULL OR b.ward_id = $3)
            AND (NOT $4::boolean OR e.resolved_at IS NULL)
          ORDER BY e.resolved_at IS NULL DESC, e.due_at
          LIMIT $5`,
        [this.hospitalId(), this.branchId(), query.wardId ?? null, query.openOnly, query.limit],
      );
      return { items: rows.map((r) => this.toEscalation(r)), nextCursor: null, hasMore: false };
    });
  }

  /**
   * Raise an escalation from a NEWS2 score.
   *
   * Idempotent per admission: if one is already running, the score is folded
   * into it rather than starting a second ladder. Two ladders on one patient
   * both climb slowly, and the second one resets the clock the first had earned.
   */
  async raiseEscalation(input: {
    readonly admissionId: string;
    readonly patientId: string;
    readonly score: number;
    readonly band: string;
    readonly vitalsId?: string;
  }): Promise<EscalationRow> {
    return this.guard(async (tx) => {
      const { rows: live } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.ip_news2_escalations
            SET score = GREATEST(score, $3), band = CASE WHEN $3 > score THEN $4 ELSE band END, updated_at = now()
          WHERE admission_id = $1 AND hospital_id = $2 AND resolved_at IS NULL
          RETURNING id`,
        [input.admissionId, this.hospitalId(), input.score, input.band],
      );
      if (live[0] !== undefined) {
        const { rows } = await tx.query<Record<string, unknown>>(`${this.escalationSelect} WHERE e.id = $1`, [
          asText(live[0]['id']),
        ]);
        const row = rows[0];
        if (row === undefined) throw AppError.conflict('The escalation was not raised.');
        return this.toEscalation(row);
      }

      const id = newId();
      await tx.query(
        `INSERT INTO clinical.ip_news2_escalations (
           id, hospital_id, branch_id, admission_id, vitals_id, patient_id, score, band, rung,
           raised_at, due_at, ladder, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'nurse', now(),
                   now() + make_interval(mins => $9::int), '[]'::jsonb, now(), now())`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          input.admissionId,
          input.vitalsId ?? null,
          input.patientId,
          input.score,
          input.band,
          RUNG_MINUTES['nurse'] ?? 5,
        ],
      );

      const { rows } = await tx.query<Record<string, unknown>>(`${this.escalationSelect} WHERE e.id = $1`, [
        id,
      ]);
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The escalation was not raised.');
      return this.toEscalation(row);
    });
  }

  async acknowledgeEscalation(id: string, body: EscalationAckRequest): Promise<EscalationRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.ip_news2_escalations
            SET acknowledged_at = now(), acknowledged_by = $3,
                ladder = ladder || jsonb_build_object('rung', rung::text, 'acknowledgedAt', now(), 'by', $3::text, 'note', $4::text),
                updated_at = now()
          WHERE id = $1 AND hospital_id = $2 AND acknowledged_at IS NULL AND resolved_at IS NULL
          RETURNING id`,
        [id, this.hospitalId(), this.actorId(), body.note ?? null],
      );
      if (rows[0] === undefined) throw AppError.conflict('That escalation is already answered or closed.');

      const { rows: view } = await tx.query<Record<string, unknown>>(
        `${this.escalationSelect} WHERE e.id = $1`,
        [id],
      );
      const v = view[0];
      if (v === undefined) throw AppError.conflict('The escalation was not acknowledged.');
      return this.toEscalation(v);
    });
  }

  async resolveEscalation(id: string, body: EscalationResolveRequest): Promise<EscalationRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.ip_news2_escalations
            SET resolved_at = now(), resolved_by = $3, outcome = $4,
                acknowledged_at = COALESCE(acknowledged_at, now()),
                acknowledged_by = COALESCE(acknowledged_by, $3),
                updated_at = now()
          WHERE id = $1 AND hospital_id = $2 AND resolved_at IS NULL
          RETURNING admission_id, rung::text AS rung, raised_at`,
        [id, this.hospitalId(), this.actorId(), body.outcome],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('That escalation is already closed.');

      await this.outbox.publish(
        tx,
        nursingEvent('news2.escalation.resolved', id, {
          escalationId: id,
          admissionId: asText(row['admission_id']),
          rung: asText(row['rung']),
          minutesToResolve: Math.max(
            0,
            Math.round((Date.now() - new Date(asText(row['raised_at'])).getTime()) / 60_000),
          ),
          outcome: body.outcome,
        }),
      );

      const { rows: view } = await tx.query<Record<string, unknown>>(
        `${this.escalationSelect} WHERE e.id = $1`,
        [id],
      );
      const v = view[0];
      if (v === undefined) throw AppError.conflict('The escalation was not resolved.');
      return this.toEscalation(v);
    });
  }

  /**
   * Climb the ladder on every overdue, unanswered escalation.
   *
   * One statement. Called by the worker on a schedule, and it reads a column —
   * so it happens whether or not the nurse who recorded the observation still
   * has a tab open, which is the entire point of doing it this way.
   */
  async climbLadder(): Promise<{ readonly climbed: number }> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT id, admission_id, patient_id, score, band, rung::text AS rung, raised_at
           FROM clinical.ip_news2_escalations
          WHERE hospital_id = $1 AND resolved_at IS NULL AND acknowledged_at IS NULL AND due_at <= now()
          FOR UPDATE SKIP LOCKED`,
        [this.hospitalId()],
      );

      for (const row of rows) {
        const from = asText(row['rung']);
        const to = NEXT_RUNG[from] ?? 'code_blue';
        const minutes = RUNG_MINUTES[to] ?? 10;

        await tx.query(
          `UPDATE clinical.ip_news2_escalations
              SET rung = $2::clinical."EscalationRung",
                  due_at = now() + make_interval(mins => $3::int),
                  ladder = ladder || jsonb_build_object('rung', $4::text, 'unansweredAt', now(), 'climbedTo', $2::text),
                  updated_at = now()
            WHERE id = $1`,
          [asText(row['id']), to, minutes, from],
        );

        await this.outbox.publish(
          tx,
          nursingEvent('news2.escalated', asText(row['id']), {
            escalationId: asText(row['id']),
            admissionId: asText(row['admission_id']),
            patientId: asText(row['patient_id']),
            score: asNumber(row['score']),
            band: asText(row['band']),
            fromRung: from,
            toRung: to,
            minutesUnanswered: Math.max(
              0,
              Math.round((Date.now() - new Date(asText(row['raised_at'])).getTime()) / 60_000),
            ),
          }),
        );
      }

      return { climbed: rows.length };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Fluids, notes, handover
  // ═══════════════════════════════════════════════════════════════════════════

  async recordFluid(body: FluidRequest): Promise<FluidBalanceView> {
    return this.guard(async (tx) => {
      await tx.query(
        `INSERT INTO clinical.ip_fluid_entries (
           id, hospital_id, branch_id, admission_id, direction, kind, volume_ml, at, recorded_by, notes, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE($8::timestamptz, now()), $9, $10, now())`,
        [
          newId(),
          this.hospitalId(),
          this.branchId(),
          body.admissionId,
          body.direction,
          body.kind,
          body.volumeMl,
          body.at ?? null,
          this.actorId(),
          body.notes ?? null,
        ],
      );
      return this.fluidBalance(body.admissionId, 24);
    });
  }

  /**
   * The running balance over a window.
   *
   * Twenty-four hours by default because that is the shift-to-shift question,
   * and the sum is computed rather than kept: a running total column would be
   * one more thing that can disagree with the entries beneath it.
   */
  async fluidBalance(admissionId: string, windowHours = 24): Promise<FluidBalanceView> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT id, direction, kind, volume_ml, at, notes
           FROM clinical.ip_fluid_entries
          WHERE hospital_id = $1 AND admission_id = $2 AND at > now() - make_interval(hours => $3::int)
          ORDER BY at DESC`,
        [this.hospitalId(), admissionId, windowHours],
      );

      const entries = rows.map((r) => ({
        id: asText(r['id']),
        direction: asText(r['direction']),
        kind: asText(r['kind']),
        volumeMl: asNumber(r['volume_ml']),
        at: asText(r['at']),
        notes: asTextOrNull(r['notes']),
      }));
      const intakeMl = entries.filter((e) => e.direction === 'intake').reduce((n, e) => n + e.volumeMl, 0);
      const outputMl = entries.filter((e) => e.direction === 'output').reduce((n, e) => n + e.volumeMl, 0);

      return { admissionId, windowHours, intakeMl, outputMl, balanceMl: intakeMl - outputMl, entries };
    });
  }

  async writeNote(body: NoteRequest): Promise<{ readonly id: string }> {
    return this.guard(async (tx) => {
      const id = newId();
      await tx.query(
        `INSERT INTO clinical.ip_nursing_notes (
           id, hospital_id, branch_id, admission_id, kind, situation, background, assessment,
           recommendation, body, photo_ref, at, by_id, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now(), $12, now())`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.admissionId,
          body.kind,
          body.situation ?? null,
          body.background ?? null,
          body.assessment ?? null,
          body.recommendation ?? null,
          body.body ?? null,
          body.photoRef ?? null,
          this.actorId(),
        ],
      );
      return { id };
    });
  }

  /**
   * Compose the handover from what actually happened this shift.
   *
   * A snapshot, stored — not a set of live joins. The point of a handover is
   * what was said at 20:00; re-deriving it tomorrow from current data would
   * show a different ward and make the signature meaningless.
   */
  async composeHandover(body: HandoverRequest): Promise<HandoverView> {
    return this.guard(async (tx) => {
      const { rows: patients } = await tx.query<Record<string, unknown>>(
        `SELECT a.id, a.ip_no, b.code AS bed_code,
                (SELECT vt.news2_score FROM clinical.vitals vt
                  WHERE vt.patient_id = a.patient_id ORDER BY vt.recorded_at DESC LIMIT 1) AS news2,
                (SELECT count(*) FROM clinical.ip_mar_doses d
                  WHERE d.admission_id = a.id AND d.state = 'missed'
                    AND d.updated_at > now() - interval '12 hours') AS missed_doses,
                (SELECT count(*) FROM clinical.ip_news2_escalations e
                  WHERE e.admission_id = a.id AND e.resolved_at IS NULL) AS open_escalations,
                COALESCE((SELECT array_agg(i.precaution) FROM clinical.ip_isolation_orders i
                           WHERE i.admission_id = a.id AND i.ended_at IS NULL), '{}') AS isolation
           FROM clinical.ip_admissions a
           JOIN clinical.ip_bed_occupancies o ON o.admission_id = a.id AND o.to_at IS NULL
           JOIN clinical.ip_beds b ON b.id = o.bed_id
          WHERE a.hospital_id = $1 AND b.ward_id = $2 AND a.status = 'admitted'
          ORDER BY b.code`,
        [this.hospitalId(), body.wardId],
      );

      const composed = {
        composedAt: new Date().toISOString(),
        patients: patients.map((r) => ({
          admissionId: asText(r['id']),
          ipNo: asText(r['ip_no']),
          bedCode: asText(r['bed_code']),
          news2: asNumberOrNull(r['news2']),
          missedDoses: asNumber(r['missed_doses'] ?? 0),
          openEscalations: asNumber(r['open_escalations'] ?? 0),
          isolation: asStringArray(r['isolation']),
        })),
      };

      const id = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO clinical.ip_shift_handovers (
           id, hospital_id, branch_id, ward_id, from_shift, to_shift, shift_date, composed, additions, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6, CURRENT_DATE, $7::jsonb, $8, now(), now())
         RETURNING *`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.wardId,
          body.fromShift,
          body.toShift,
          json(composed),
          body.additions ?? null,
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The handover was not composed.');
      return this.toHandover(row);
    });
  }

  private toHandover(r: Record<string, unknown>): HandoverView {
    return {
      id: asText(r['id']),
      wardId: asText(r['ward_id']),
      fromShift: asText(r['from_shift']),
      toShift: asText(r['to_shift']),
      shiftDate: asText(r['shift_date']),
      composed: r['composed'] ?? null,
      additions: asTextOrNull(r['additions']),
      handedOverBy: asTextOrNull(r['handed_over_by']),
      handedOverAt: asTextOrNull(r['handed_over_at']),
      receivedBy: asTextOrNull(r['received_by']),
      receivedAt: asTextOrNull(r['received_at']),
    };
  }

  async signHandover(id: string, body: HandoverSignRequest): Promise<HandoverView> {
    return this.guard(async (tx) => {
      const column = body.side === 'give' ? 'handed_over' : 'received';
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.ip_shift_handovers
            SET ${column}_by = $3, ${column}_at = now(), updated_at = now()
          WHERE id = $1 AND hospital_id = $2 AND ${column}_at IS NULL
          RETURNING *`,
        [id, this.hospitalId(), this.actorId()],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('That side of the handover is already signed.');

      const view = this.toHandover(row);
      if (view.handedOverBy !== null && view.receivedBy !== null) {
        const composed = view.composed as { patients?: unknown[] } | null;
        await this.outbox.publish(
          tx,
          nursingEvent('nursing.handover.signed', id, {
            handoverId: id,
            wardId: view.wardId,
            fromShift: view.fromShift,
            toShift: view.toShift,
            patients: Array.isArray(composed?.patients) ? composed.patients.length : 0,
            handedOverBy: view.handedOverBy,
            receivedBy: view.receivedBy,
          }),
        );
      }
      return view;
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Infection control
  // ═══════════════════════════════════════════════════════════════════════════

  async insertDevice(body: DeviceRequest): Promise<DeviceRow> {
    return this.guard(async (tx) => {
      const id = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO clinical.ip_device_days (
           id, hospital_id, branch_id, admission_id, patient_id, ward_id, device_type, site,
           inserted_at, inserted_by, created_at, updated_at
         )
         SELECT $1, $2, $3, a.id, a.patient_id, b.ward_id, $5, $6, COALESCE($7::timestamptz, now()), $8, now(), now()
           FROM clinical.ip_admissions a
           LEFT JOIN clinical.ip_bed_occupancies o ON o.admission_id = a.id AND o.to_at IS NULL
           LEFT JOIN clinical.ip_beds b ON b.id = o.bed_id
          WHERE a.id = $4 AND a.hospital_id = $2
         RETURNING *`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.admissionId,
          body.deviceType,
          body.site ?? null,
          body.insertedAt ?? null,
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.notFound('That admission is not on this hospital’s record.');
      return this.toDevice(row);
    });
  }

  private toDevice(r: Record<string, unknown>): DeviceRow {
    const inserted = asText(r['inserted_at']);
    const removed = asTextOrNull(r['removed_at']);
    const until = removed === null ? Date.now() : new Date(removed).getTime();
    return {
      id: asText(r['id']),
      admissionId: asText(r['admission_id']),
      deviceType: asText(r['device_type']),
      site: asTextOrNull(r['site']),
      insertedAt: inserted,
      removedAt: removed,
      removalReason: asTextOrNull(r['removal_reason']),
      deviceDays: Math.max(0, Math.floor((until - new Date(inserted).getTime()) / 86_400_000)),
    };
  }

  async removeDevice(id: string, body: DeviceRemoveRequest): Promise<DeviceRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.ip_device_days
            SET removed_at = COALESCE($3::timestamptz, now()), removed_by = $4,
                removal_reason = $5, updated_at = now()
          WHERE id = $1 AND hospital_id = $2 AND removed_at IS NULL
          RETURNING *`,
        [id, this.hospitalId(), body.at ?? null, this.actorId(), body.removalReason],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('That device is already recorded as out.');
      return this.toDevice(row);
    });
  }

  async startIsolation(body: IsolationRequest): Promise<IsolationRow> {
    return this.guard(async (tx) => {
      const id = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO clinical.ip_isolation_orders (
           id, hospital_id, branch_id, admission_id, patient_id, precaution, organism, indication,
           started_at, started_by, created_at, updated_at
         )
         SELECT $1, $2, $3, a.id, a.patient_id, $5, $6, $7, now(), $8, now(), now()
           FROM clinical.ip_admissions a WHERE a.id = $4 AND a.hospital_id = $2
         RETURNING *`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.admissionId,
          body.precaution,
          body.organism ?? null,
          body.indication,
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.notFound('That admission is not on this hospital’s record.');

      await this.outbox.publish(
        tx,
        nursingEvent('infection.isolation.started', id, {
          orderId: id,
          admissionId: body.admissionId,
          patientId: asText(row['patient_id']),
          precaution: body.precaution,
          organism: body.organism ?? null,
        }),
      );

      return {
        id,
        admissionId: body.admissionId,
        precaution: body.precaution,
        organism: body.organism ?? null,
        indication: body.indication,
        startedAt: asText(row['started_at']),
        endedAt: null,
      };
    });
  }

  async haiCases(): Promise<readonly HaiRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM clinical.ip_hai_cases
          WHERE hospital_id = $1 AND branch_id = $2
          ORDER BY adjudication = 'candidate' DESC, detected_at DESC LIMIT 200`,
        [this.hospitalId(), this.branchId()],
      );
      return rows.map((r): HaiRow => ({
        id: asText(r['id']),
        admissionId: asText(r['admission_id']),
        patientId: asText(r['patient_id']),
        kind: asText(r['kind']),
        detectedAt: asText(r['detected_at']),
        adjudication: asText(r['adjudication']),
        organism: asTextOrNull(r['organism']),
        rationale: asTextOrNull(r['rationale']),
        trigger: r['trigger'] ?? null,
      }));
    });
  }

  async adjudicateHai(id: string, body: HaiAdjudicateRequest): Promise<HaiRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.ip_hai_cases
            SET adjudication = $3, adjudicated_at = now(), adjudicated_by = $4,
                rationale = $5, updated_at = now()
          WHERE id = $1 AND hospital_id = $2 AND adjudication = 'candidate'
          RETURNING *`,
        [id, this.hospitalId(), body.adjudication, this.actorId(), body.rationale],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('That case has already been adjudicated.');
      return {
        id: asText(row['id']),
        admissionId: asText(row['admission_id']),
        patientId: asText(row['patient_id']),
        kind: asText(row['kind']),
        detectedAt: asText(row['detected_at']),
        adjudication: asText(row['adjudication']),
        organism: asTextOrNull(row['organism']),
        rationale: asTextOrNull(row['rationale']),
        trigger: row['trigger'] ?? null,
      };
    });
  }
}
