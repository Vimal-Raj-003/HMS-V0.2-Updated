import { Inject, Injectable } from '@nestjs/common';
import { ProblemType, newId, type Page } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService, type TransactionClient } from '../../../core/db/database.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { CursorService } from '../../../core/pagination/cursor.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import { ageDaysAt, mapClinicalConstraints, requireBranch, toNumber } from './clinical.common.js';
import { clinicalEvent } from './clinical.events.js';
import { scoreNews2 } from './vitals.news2.js';
import {
  checkPlausibility,
  evaluateReadings,
  type RangeSubject,
  type Reading,
  type ReferenceRange,
  type VitalFlag,
} from './vitals.ranges.js';
import type {
  AcknowledgeAlertRequest,
  CorrectVitalsRequest,
  CreateVitalsRequest,
  ListVitalsQuery,
  RecheckRequest,
  ReferenceRangeQuery,
} from './vitals.schemas.js';

/**
 * OP-007 — the vital room.
 *
 * Five properties shape this file, and each one is why a piece of it is longer
 * than its CRUD surface suggests.
 *
 * **No threshold is compiled in.** Every abnormal, critical and plausibility
 * bound is read from `clinical.vitals_reference_ranges`, which is
 * hospital-configurable, effective-dated and age/sex/pregnancy aware
 * (OP-007 §5). `vitals.ranges.ts` does the matching; this file does the I/O.
 *
 * **An observation that crosses a band raises an alert somebody must close.**
 * The alert row and its `vitals.abnormal` / `vitals.critical` event are written
 * in the *same transaction* as the reading. An observation that recorded a
 * critical potassium-equivalent and failed to tell anybody is the failure mode
 * the whole module exists to prevent.
 *
 * **Nothing is ever edited or deleted.** OP-007 §5: "corrections versioned;
 * readings never deleted." A correction inserts a new row pointing at the old
 * one through `corrects_id`, and stamps `superseded_at` on the original. The
 * migration revokes DELETE, so there is nothing to bypass.
 *
 * **A weight is never zero.** The storage CHECK starts at 0.3 kg, so a NULL
 * weight means exactly one thing — nobody weighed them — which is the
 * unambiguous input `clinical.encounters.dosing_weight_source` needs.
 *
 * **No query carries a `hospital_id` predicate.** Isolation is row-level
 * security acting on the scope stamped by `withTenant`, which is why a
 * cross-tenant id reads as "not found" rather than "forbidden" (`docs/09` §3.1
 * case 2).
 */

const RESOURCE = 'opd.vitals';

/** How long after a reading its own recorder may still correct it (OP-007 §14 AC-11). */
const SELF_CORRECTION_WINDOW_MS = 30 * 60 * 1000;

/** OP-007 §3.2.2: a device reading older than this is not the patient in front of you. */
const DEVICE_READING_MAX_AGE_MS = 2 * 60 * 1000;

/**
 * `clinical.VitalsContext` → the `vitals.recorded` event's `context` enum.
 *
 * The two sets are not the same, and the registry's is the narrower one: it has
 * `er` where the table has `er_triage`, and it has no arm for `daycare`,
 * `kiosk` or `telemed_self`. Mapping them to `other` loses information at the
 * event boundary; the observation itself keeps its exact context in
 * `clinical.vitals`, which is the record of truth. Reported as a contract gap
 * rather than papered over by inventing a registry arm.
 */
const EVENT_CONTEXT: Readonly<Record<string, string>> = {
  opd_vitals_room: 'opd_vitals_room',
  er_triage: 'er',
  ward: 'ward',
  icu: 'icu',
  ot: 'ot',
  home: 'home',
  daycare: 'other',
  kiosk: 'other',
  telemed_self: 'other',
};

/** `clinical.VitalsSource` → the event's `source` enum, which has no `mixed`/`kiosk`. */
const EVENT_SOURCE: Readonly<Record<string, string>> = {
  manual: 'manual',
  kiosk: 'manual',
  device: 'device',
  mixed: 'device',
};

/** `clinical.VitalsAlertAction` → the `vitals.alert.acknowledged` event's `actionTaken`. */
const EVENT_ALERT_ACTION: Readonly<Record<string, string>> = {
  none: 'none',
  repeat: 'repeat_vitals',
  doctor_informed: 'informed_doctor',
  sent_to_er: 'escalated_er',
};

export interface VitalsRow {
  readonly id: string;
  readonly patient_id: string;
  readonly visit_id: string | null;
  readonly encounter_id: string | null;
  readonly context: string;
  readonly recorded_at: Date;
  readonly recorded_by: string;
  readonly station_id: string | null;
  readonly systolic: number | null;
  readonly diastolic: number | null;
  readonly pulse: number | null;
  readonly spo2: number | null;
  readonly on_oxygen: boolean;
  readonly copd_scale2: boolean;
  readonly temperature_c: string | null;
  readonly resp_rate: number | null;
  readonly glucose_mgdl: string | null;
  readonly glucose_type: string | null;
  readonly height_cm: string | null;
  readonly weight_kg: string | null;
  readonly bmi: string | null;
  readonly pain_score: number | null;
  readonly avpu: string | null;
  readonly gcs_total: number | null;
  readonly lmp_date: Date | null;
  readonly pregnancy_status: string;
  readonly news2_score: number | null;
  readonly news2_band: string | null;
  readonly flags: Record<string, string>;
  readonly overall_flag: string;
  readonly source: string;
  readonly notes: string | null;
  readonly repeat_of_id: string | null;
  readonly corrects_id: string | null;
  readonly corrected_reason: string | null;
  readonly superseded_at: Date | null;
  readonly version: number;
}

export interface VitalsAlertView {
  readonly id: string;
  readonly level: string;
  readonly parameters: readonly string[];
  readonly notified_doctor_id: string | null;
  readonly acknowledged_at: Date | null;
  readonly acknowledged_by: string | null;
  readonly action_taken: string;
  readonly note: string | null;
}

export interface VitalsDetail extends VitalsRow {
  readonly alerts: readonly VitalsAlertView[];
}

interface PatientSubjectRow {
  readonly id: string;
  readonly uhid: string;
  readonly gender: string;
  readonly dob: Date | null;
  readonly is_pregnant: boolean;
}

@Injectable()
export class VitalsService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(CursorService) private readonly cursors: CursorService,
  ) {}

  // ── record ────────────────────────────────────────────────────────────────

  /** OP-007 §6 `POST /vitals/records` — save an observation set and act on it. */
  async record(body: CreateVitalsRequest): Promise<VitalsDetail> {
    const branchId = requireBranch();
    const id = newId();

    await this.db.withTenant(currentTenantContext(), async (tx) => {
      const patient = await this.loadPatient(tx, body.patientId);
      await this.assertVisit(tx, body.visitId, patient.id);
      const deviceReadings = await this.resolveDeviceReadings(tx, body.deviceReadings);

      const outcome = await this.scoreObservation(tx, patient, body);

      const recorded = await mapClinicalConstraints(async () =>
        this.insertVitals(tx, {
          id,
          branchId,
          patient,
          body,
          deviceReadings,
          correctsId: null,
          correctedReason: null,
          outcome,
        }),
      );

      if (body.assessment !== undefined) {
        await this.insertAssessment(tx, {
          branchId,
          patientId: patient.id,
          visitId: body.visitId ?? null,
          vitalsId: id,
          recordedAt: recorded.recorded_at,
          assessment: body.assessment,
        });
      }

      // The patient has been through the vitals room, so the visit says so.
      //
      // Nothing did this. A walk-in opened as `waiting_vitals`, the nurse
      // recorded the reading, and the visit stayed `waiting_vitals` for ever —
      // so OP-002's precondition refused every consultation and the doctor had
      // to declare "see without vitals" on a patient whose vitals were sitting
      // in the record. A safety rule that has to be overridden on every patient
      // is not a safety rule; it is a habit, and the first thing it teaches is
      // to reach for the override.
      //
      // In this transaction rather than off the event, because the doctor's
      // screen is the very next thing that happens and a relay that has not run
      // yet is a doctor being refused for no reason they can see.
      if (body.visitId !== undefined) {
        await tx.query(
          `UPDATE clinical.op_visits
              SET status = 'waiting_doctor', updated_at = now()
            WHERE id = $1 AND hospital_id = $2 AND status = 'waiting_vitals'`,
          [body.visitId, getContext().hospitalId],
        );
      }

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'clinical.vitals',
        rowId: id,
        businessKey: patient.uhid,
        dataClass: 'phi',
        patientId: patient.id,
        before: null,
        after: {
          context: body.context,
          overall_flag: outcome.evaluation.overall,
          flags: outcome.evaluation.flags,
          news2_score: outcome.news2?.score ?? null,
          news2_band: outcome.news2?.band ?? null,
          // A score that assumed alertness rather than observing it must never
          // be indistinguishable from one that observed it (see vitals.news2.ts).
          news2_consciousness_assumed: outcome.news2?.consciousnessAssumed ?? null,
          source: body.source,
          device_readings: deviceReadings.length,
        },
      });

      await this.outbox.publish(
        tx,
        clinicalEvent('vitals.recorded', id, {
          vitalsId: id,
          recordedAt: recorded.recorded_at.toISOString(),
          patientId: patient.id,
          visitId: body.visitId ?? null,
          encounterId: body.encounterId ?? null,
          context: EVENT_CONTEXT[body.context] ?? 'other',
          overallFlag: outcome.evaluation.overall,
          news2Score: outcome.news2?.score ?? null,
          news2Band: outcome.news2?.band ?? null,
          pewsScore: null,
          source: EVENT_SOURCE[body.source] ?? 'manual',
          recordedBy: this.actor(),
        }),
      );

      await this.raiseAlert(tx, {
        branchId,
        patient,
        vitalsId: id,
        recordedAt: recorded.recorded_at,
        visitId: body.visitId ?? null,
        evaluation: outcome.evaluation,
        news2Score: outcome.news2?.score ?? null,
      });
    });

    return this.get(id);
  }

  // ── correction ────────────────────────────────────────────────────────────

  /**
   * OP-007 §6 `PATCH /vitals/records/{id}` — a correction.
   *
   * Not an update. A correction inserts a **new** observation set carrying
   * `corrects_id` and the reason, and stamps `superseded_at` on the original,
   * which stays readable forever (§5, §14 AC-11).
   *
   * The window rule is §14 AC-11 exactly: the person who took the reading may
   * correct it for thirty minutes; after that a *different* clinician — the
   * supervisor, who holds the same permission key with a wider ABAC scope —
   * must do it. The scope half is not modelled yet, so what is enforced here is
   * only the half that can be: the original recorder is refused after thirty
   * minutes. That is reported rather than hidden.
   */
  async correct(id: string, body: CorrectVitalsRequest): Promise<VitalsDetail> {
    const branchId = requireBranch();
    const correctionId = newId();

    await this.db.withTenant(currentTenantContext(), async (tx) => {
      const original = await tx.maybeOne<VitalsRow>(
        `SELECT id, patient_id, visit_id, encounter_id, context::text AS context, recorded_at, recorded_by,
                station_id, superseded_at
           FROM clinical.vitals WHERE id = $1`,
        [id],
      );
      if (original === undefined) throw AppError.notFound('The observation set');
      if (original.superseded_at !== null) {
        throw AppError.conflict(
          'That reading has already been corrected. Correct the current version instead.',
        );
      }

      const actor = this.actor();
      const ageMs = Date.now() - original.recorded_at.getTime();
      if (original.recorded_by === actor && ageMs > SELF_CORRECTION_WINDOW_MS) {
        throw new AppError(
          ProblemType.BUSINESS_RULE_VIOLATED,
          'A reading may be corrected by the person who took it for thirty minutes. After that a supervisor must do it (OP-007 §14 AC-11).',
          { nextAction: 'Ask the nursing supervisor to record the correction.' },
        );
      }

      const patient = await this.loadPatient(tx, original.patient_id);
      const outcome = await this.scoreObservation(tx, patient, body);
      const deviceReadings = await this.resolveDeviceReadings(tx, body.deviceReadings);

      const recorded = await mapClinicalConstraints(async () =>
        this.insertVitals(tx, {
          id: correctionId,
          branchId,
          patient,
          body: {
            ...body,
            patientId: patient.id,
            context: original.context as CreateVitalsRequest['context'],
            ...(original.visit_id === null ? {} : { visitId: original.visit_id }),
            ...(original.encounter_id === null ? {} : { encounterId: original.encounter_id }),
            ...(original.station_id === null ? {} : { stationId: original.station_id }),
            deviceReadings: body.deviceReadings,
          },
          deviceReadings,
          correctsId: id,
          correctedReason: body.reason,
          outcome,
        }),
      );

      await tx.query(
        `UPDATE clinical.vitals
            SET superseded_at = now(), updated_at = now(), updated_by = $3, version = version + 1
          WHERE id = $1 AND recorded_at = $2`,
        [id, original.recorded_at, actor],
      );

      await this.audit.write(tx, {
        action: 'update',
        entity: 'clinical.vitals',
        rowId: id,
        businessKey: patient.uhid,
        dataClass: 'phi',
        patientId: patient.id,
        before: { superseded_at: null },
        after: { superseded_at: recorded.recorded_at.toISOString(), corrected_by_vitals_id: correctionId },
        reasonText: body.reason,
      });

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'clinical.vitals',
        rowId: correctionId,
        businessKey: patient.uhid,
        dataClass: 'phi',
        patientId: patient.id,
        before: null,
        after: {
          corrects_id: id,
          overall_flag: outcome.evaluation.overall,
          flags: outcome.evaluation.flags,
          news2_score: outcome.news2?.score ?? null,
        },
        reasonText: body.reason,
      });

      await this.outbox.publish(
        tx,
        clinicalEvent('vitals.recorded', correctionId, {
          vitalsId: correctionId,
          recordedAt: recorded.recorded_at.toISOString(),
          patientId: patient.id,
          visitId: original.visit_id,
          encounterId: original.encounter_id,
          context: EVENT_CONTEXT[original.context] ?? 'other',
          overallFlag: outcome.evaluation.overall,
          news2Score: outcome.news2?.score ?? null,
          news2Band: outcome.news2?.band ?? null,
          pewsScore: null,
          source: EVENT_SOURCE[body.source] ?? 'manual',
          recordedBy: actor,
        }),
      );

      await this.raiseAlert(tx, {
        branchId,
        patient,
        vitalsId: correctionId,
        recordedAt: recorded.recorded_at,
        visitId: original.visit_id,
        evaluation: outcome.evaluation,
        news2Score: outcome.news2?.score ?? null,
      });
    });

    return this.get(correctionId);
  }

  // ── reads ─────────────────────────────────────────────────────────────────

  /** OP-007 §6 `GET /vitals/records/{id}`. Class C: a record read, p95 250 ms. */
  async get(id: string): Promise<VitalsDetail> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const row = await tx.maybeOne<VitalsRow>(`${VITALS_SELECT} WHERE v.id = $1`, [id]);
      if (row === undefined) throw AppError.notFound('The observation set');

      const alerts = await tx.rows<VitalsAlertView>(
        `SELECT id, level::text AS level, parameters, notified_doctor_id,
                acknowledged_at, acknowledged_by, action_taken::text AS action_taken, note
           FROM clinical.vitals_alerts
          WHERE vitals_id = $1
          ORDER BY created_at`,
        [id],
      );

      await this.audit.write(tx, {
        action: 'read_phi',
        entity: 'clinical.vitals',
        rowId: id,
        businessKey: null,
        dataClass: 'phi',
        patientId: row.patient_id,
        before: null,
        after: null,
        rowCount: 1,
      });

      return { ...row, alerts };
    });
  }

  /** OP-007 §6 `GET /vitals/records` — history and trends, keyset-paginated. */
  async list(query: ListVitalsQuery): Promise<Page<VitalsRow>> {
    const ctx = getContext();
    const hospitalId = ctx.hospitalId ?? '';
    const resource = `${RESOURCE}.records`;
    const limit = this.cursors.pageSize(query.limit);
    const after = this.cursors.start(query.cursor, { hospitalId, resource });

    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const values: unknown[] = [];
      const bind = (value: unknown): string => `$${values.push(value)}`;
      const where: string[] = [];

      if (query.patient !== undefined) where.push(`v.patient_id = ${bind(query.patient)}::uuid`);
      if (query.visit !== undefined) where.push(`v.visit_id = ${bind(query.visit)}::uuid`);
      if (query.encounter !== undefined) where.push(`v.encounter_id = ${bind(query.encounter)}::uuid`);
      if (query.context !== undefined) {
        where.push(`v.context = ${bind(query.context)}::clinical."VitalsContext"`);
      }
      if (query.flag !== undefined) {
        where.push(`v.overall_flag = ${bind(query.flag)}::clinical."VitalFlag"`);
      }
      // Both bounds are pushed down onto the partition key, so a two-year trend
      // reads two years of partitions and not ten (docs/07 §4).
      if (query.from !== undefined) where.push(`v.recorded_at >= ${bind(query.from)}::timestamptz`);
      if (query.to !== undefined) where.push(`v.recorded_at <= ${bind(query.to)}::timestamptz`);
      if (after !== null) {
        where.push(`(v.recorded_at, v.id) < (${bind(after.k[0])}::timestamptz, ${bind(after.id)}::uuid)`);
      }

      const fetched = await tx.rows<VitalsRow & { cursor_key: string }>(
        `SELECT ${VITALS_COLUMNS}, v.recorded_at::text AS cursor_key
           FROM clinical.vitals v
          ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`}
          ORDER BY v.recorded_at DESC, v.id DESC
          LIMIT ${bind(limit + 1)}`,
        values,
      );

      const page = this.cursors.keysetPage<VitalsRow>(fetched, limit, {
        hospitalId,
        resource,
        direction: 'desc',
      });

      await this.audit.write(tx, {
        action: 'read_phi',
        entity: 'clinical.vitals',
        rowId: query.patient ?? query.visit ?? null,
        businessKey: null,
        dataClass: 'phi',
        patientId: query.patient ?? null,
        before: null,
        after: null,
        rowCount: page.items.length,
      });

      return page;
    });
  }

  /**
   * OP-007 §6 `GET /vitals/reference-ranges` — the configured bands.
   *
   * Read-only. The write half of the configuration is EN-027's change-set
   * workflow (propose → validate → approve → activate); a bare `PUT` here would
   * let somebody widen a critical threshold with no approval and no effective
   * date, which is the one edit in this module a hospital can least afford to
   * make casually.
   */
  async referenceRanges(query: ReferenceRangeQuery): Promise<Page<Record<string, unknown>>> {
    const ctx = getContext();
    const hospitalId = ctx.hospitalId ?? '';
    const resource = `${RESOURCE}.reference_ranges`;
    const limit = this.cursors.pageSize(query.limit);
    const after = this.cursors.start(query.cursor, { hospitalId, resource });

    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const values: unknown[] = [];
      const bind = (value: unknown): string => `$${values.push(value)}`;
      const where: string[] = [`r.status = 'active'`];
      if (query.parameter !== undefined) where.push(`r.parameter = ${bind(query.parameter)}`);
      if (after !== null) {
        where.push(`(r.parameter, r.id) > (${bind(after.k[0])}, ${bind(after.id)}::uuid)`);
      }

      const fetched = await tx.rows<Record<string, unknown> & { id: string; cursor_key: string }>(
        `SELECT r.id, r.parameter, r.age_min_days, r.age_max_days, r.sex, r.pregnancy::text AS pregnancy,
                r.scale, r.low_abnormal, r.high_abnormal, r.low_critical, r.high_critical,
                r.low_plausible, r.high_plausible, r.unit, r.effective_from, r.effective_to,
                r.parameter AS cursor_key
           FROM clinical.vitals_reference_ranges r
          WHERE ${where.join(' AND ')}
          ORDER BY r.parameter ASC, r.id ASC
          LIMIT ${bind(limit + 1)}`,
        values,
      );

      return this.cursors.keysetPage<Record<string, unknown> & { id: string }>(fetched, limit, {
        hospitalId,
        resource,
        direction: 'asc',
      });
    });
  }

  // ── alerts and rechecks ───────────────────────────────────────────────────

  /** OP-007 §6 `POST /vitals/records/{id}/alerts/{alert}/ack` — close the loop. */
  async acknowledgeAlert(
    vitalsId: string,
    alertId: string,
    body: AcknowledgeAlertRequest,
  ): Promise<VitalsAlertView> {
    const actor = this.actor();

    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const alert = await tx.maybeOne<{
        id: string;
        patient_id: string;
        level: string;
        acknowledged_at: Date | null;
      }>(
        `SELECT id, patient_id, level::text AS level, acknowledged_at
           FROM clinical.vitals_alerts WHERE id = $1 AND vitals_id = $2 FOR UPDATE`,
        [alertId, vitalsId],
      );
      if (alert === undefined) throw AppError.notFound('The alert');
      if (alert.acknowledged_at !== null) {
        throw new AppError(ProblemType.ALREADY_DECIDED, 'That alert has already been acknowledged.', {
          nextAction: 'Reload the patient to see who acknowledged it.',
        });
      }

      const updated = await tx.one<VitalsAlertView>(
        `UPDATE clinical.vitals_alerts
            SET acknowledged_at = now(), acknowledged_by = $2,
                action_taken = $3::clinical."VitalsAlertAction", note = $4,
                updated_at = now(), updated_by = $2
          WHERE id = $1
        RETURNING id, level::text AS level, parameters, notified_doctor_id,
                  acknowledged_at, acknowledged_by, action_taken::text AS action_taken, note`,
        [alertId, actor, body.actionTaken, body.note ?? null],
      );

      await this.audit.write(tx, {
        action: 'update',
        entity: 'clinical.vitals_alerts',
        rowId: alertId,
        businessKey: null,
        dataClass: 'phi',
        patientId: alert.patient_id,
        before: { acknowledged_at: null },
        after: { acknowledged_at: updated.acknowledged_at?.toISOString() ?? null, action: body.actionTaken },
        reasonText: body.note ?? null,
      });

      await this.outbox.publish(
        tx,
        clinicalEvent('vitals.alert.acknowledged', alertId, {
          alertId,
          patientId: alert.patient_id,
          acknowledgedBy: actor,
          actionTaken: EVENT_ALERT_ACTION[body.actionTaken] ?? 'other',
          note: body.note ?? null,
          acknowledgedAt: (updated.acknowledged_at ?? new Date()).toISOString(),
        }),
      );

      return updated;
    });
  }

  /**
   * OP-007 §6 `POST /vitals/recheck-requests` — the doctor sends the patient back.
   *
   * There is no `recheck_requests` table and deliberately so: the fact is the
   * event, and the *queue* re-entry it causes belongs to EN-006, which already
   * owns token state in `queue.queue_tokens`. A second table here would fork the
   * token lifecycle and make "which queue is the patient in" a question with two
   * answers.
   */
  async requestRecheck(body: RecheckRequest): Promise<{ readonly requested: true }> {
    const actor = this.actor();

    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const patient = await this.loadPatient(tx, body.patientId);

      await this.audit.write(tx, {
        action: 'update',
        entity: 'clinical.vitals',
        rowId: body.vitalsId ?? null,
        businessKey: patient.uhid,
        dataClass: 'phi',
        patientId: patient.id,
        before: null,
        after: { recheck_parameters: body.parameters, visit_id: body.visitId ?? null },
        reasonText: body.note ?? null,
      });

      await this.outbox.publish(
        tx,
        clinicalEvent('vitals.recheck.requested', body.vitalsId ?? patient.id, {
          patientId: patient.id,
          visitId: body.visitId ?? null,
          vitalsId: body.vitalsId ?? null,
          parameters: body.parameters,
          requestedBy: actor,
          requestedAt: new Date().toISOString(),
        }),
      );

      return { requested: true as const };
    });
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private actor(): string {
    const userId = getContext().userId;
    if (userId === null) {
      throw new Error('VitalsService reached without an authenticated user; a guarded route cannot.');
    }
    return userId;
  }

  private async loadPatient(tx: TransactionClient, patientId: string): Promise<PatientSubjectRow> {
    const row = await tx.maybeOne<PatientSubjectRow>(
      `SELECT id, uhid, gender::text AS gender, dob, is_pregnant
         FROM patient.patients WHERE id = $1 AND deleted_at IS NULL`,
      [patientId],
    );
    if (row === undefined) throw AppError.notFound('The patient');
    return row;
  }

  /** OP-007 §3.2.1: "vitals attach to the active visit only". */
  private async assertVisit(
    tx: TransactionClient,
    visitId: string | undefined,
    patientId: string,
  ): Promise<void> {
    if (visitId === undefined) return;
    const visit = await tx.maybeOne<{ patient_id: string; status: string }>(
      `SELECT patient_id, status::text AS status FROM clinical.op_visits WHERE id = $1`,
      [visitId],
    );
    if (visit === undefined) throw AppError.notFound('The visit');
    if (visit.patient_id !== patientId) {
      throw new AppError(
        ProblemType.BUSINESS_RULE_VIOLATED,
        'That visit belongs to a different patient. Scan the patient again before saving.',
      );
    }
    if (visit.status === 'cancelled' || visit.status === 'closed') {
      throw new AppError(
        ProblemType.BUSINESS_RULE_VIOLATED,
        `That visit is ${visit.status}; an observation cannot be attached to it.`,
      );
    }
  }

  /**
   * OP-007 §3.2.2: a reading is auto-accepted only from a **registered, active**
   * device and only if it is no more than two minutes old. A client is not the
   * authority on either, so both are checked against `clinical.vitals_devices`
   * and the device's serial is taken from the row rather than from the payload.
   */
  private async resolveDeviceReadings(
    tx: TransactionClient,
    readings: CreateVitalsRequest['deviceReadings'],
  ): Promise<readonly Record<string, unknown>[]> {
    if (readings.length === 0) return [];
    const resolved: Record<string, unknown>[] = [];

    for (const reading of readings) {
      const device = await tx.maybeOne<{ id: string; serial: string; status: string; type: string }>(
        `SELECT id, serial, status::text AS status, type::text AS type
           FROM clinical.vitals_devices WHERE id = $1`,
        [reading.deviceId],
      );
      if (device === undefined) throw AppError.notFound('The device');
      if (device.status !== 'active') {
        throw new AppError(
          ProblemType.BUSINESS_RULE_VIOLATED,
          `Device ${device.serial} is ${device.status} and its readings cannot be accepted. Enter the value by hand.`,
        );
      }
      const takenAt = new Date(reading.at);
      if (Date.now() - takenAt.getTime() > DEVICE_READING_MAX_AGE_MS) {
        throw new AppError(
          ProblemType.BUSINESS_RULE_VIOLATED,
          `That reading from ${device.serial} is more than two minutes old. Take it again.`,
        );
      }
      resolved.push({
        field: reading.field,
        device_id: device.id,
        serial: device.serial,
        type: device.type,
        raw: reading.raw,
        at: takenAt.toISOString(),
      });
    }

    await tx.query(
      `UPDATE clinical.vitals_devices SET last_seen_at = now(), updated_at = now()
        WHERE id = ANY($1::uuid[])`,
      [readings.map((r) => r.deviceId)],
    );

    return resolved;
  }

  private async loadRanges(tx: TransactionClient): Promise<readonly ReferenceRange[]> {
    const rows = await tx.rows<Record<string, unknown>>(
      `SELECT id, parameter, age_min_days, age_max_days, sex, pregnancy::text AS pregnancy, scale,
              low_abnormal, high_abnormal, low_critical, high_critical,
              low_plausible, high_plausible, unit
         FROM clinical.vitals_reference_ranges
        WHERE status = 'active'
          AND effective_from <= now()
          AND (effective_to IS NULL OR effective_to > now())`,
    );

    return rows.map((row) => ({
      id: text(row['id']),
      parameter: text(row['parameter']),
      ageMinDays: Number(row['age_min_days']),
      ageMaxDays: Number(row['age_max_days']),
      sex: text(row['sex']),
      pregnancy: typeof row['pregnancy'] === 'string' ? row['pregnancy'] : null,
      scale: toNumber(row['scale']),
      lowAbnormal: toNumber(row['low_abnormal']),
      highAbnormal: toNumber(row['high_abnormal']),
      lowCritical: toNumber(row['low_critical']),
      highCritical: toNumber(row['high_critical']),
      lowPlausible: toNumber(row['low_plausible']),
      highPlausible: toNumber(row['high_plausible']),
      unit: text(row['unit']),
    }));
  }

  /**
   * Reads the configured bands, refuses implausible values, flags the rest and
   * scores NEWS2. Shared by the record and correction paths so a correction can
   * never be scored by a different rule than the reading it replaces.
   */
  private async scoreObservation(
    tx: TransactionClient,
    patient: PatientSubjectRow,
    body: CreateVitalsRequest | CorrectVitalsRequest,
  ): Promise<ScoredObservation> {
    const ranges = await this.loadRanges(tx);
    const bmi = deriveBmi(body.heightCm, body.weightKg);

    const subject: RangeSubject = {
      ageDays: ageDaysAt(patient.dob, new Date()),
      sex: patient.gender,
      // The observation's own answer wins over the demographic flag: a nurse who
      // has just asked knows better than a field set at registration.
      pregnancy: body.pregnancyStatus === 'unknown' && patient.is_pregnant ? 'yes' : body.pregnancyStatus,
      copdScale2: body.copdScale2,
    };

    const readings = readingsOf(body, bmi);
    const breaches = checkPlausibility(ranges, readings, subject);
    if (breaches.length > 0) {
      throw AppError.validation(
        breaches.map((breach) => ({
          path: breach.parameter,
          code: 'implausible_value',
          message: `${String(breach.value)} ${breach.unit} is outside the plausible range configured for this patient (${describeBounds(breach.low, breach.high, breach.unit)}). Check the reading and enter it again.`,
        })),
      );
    }

    const evaluation = evaluateReadings(ranges, readings, subject);
    const news2 = scoreNews2({
      respRate: body.respRate ?? null,
      spo2: body.spo2 ?? null,
      onOxygen: body.onOxygen,
      systolic: body.systolic ?? null,
      pulse: body.pulse ?? null,
      temperatureC: body.temperatureC ?? null,
      avpu: body.avpu ?? null,
      copdScale2: body.copdScale2,
    });

    return { bmi, evaluation, news2, subject };
  }

  private async insertVitals(
    tx: TransactionClient,
    input: {
      readonly id: string;
      readonly branchId: string;
      readonly patient: PatientSubjectRow;
      readonly body: CreateVitalsRequest;
      readonly deviceReadings: readonly Record<string, unknown>[];
      readonly correctsId: string | null;
      readonly correctedReason: string | null;
      readonly outcome: ScoredObservation;
    },
  ): Promise<{ readonly recorded_at: Date }> {
    const ctx = getContext();
    const { body, outcome } = input;

    return tx.one<{ recorded_at: Date }>(
      `INSERT INTO clinical.vitals (
         id, hospital_id, branch_id, patient_id, visit_id, encounter_id,
         context, recorded_at, recorded_by, station_id,
         systolic, diastolic, bp_position, bp_arm, cuff_size,
         pulse, pulse_rhythm, spo2, on_oxygen, o2_flow_lpm, copd_scale2,
         temperature_c, temp_site, resp_rate, glucose_mgdl, glucose_type,
         height_cm, weight_kg, bmi, waist_cm, head_circ_cm,
         pain_score, pain_scale, avpu, gcs_total, lmp_date, pregnancy_status,
         news2_score, news2_band, flags, overall_flag, device_readings, source, notes,
         repeat_of_id, corrects_id, corrected_reason,
         created_by, updated_by, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7::clinical."VitalsContext", now(), $8, $9,
         $10, $11, $12::clinical."BpPosition", $13, $14,
         $15, $16::clinical."PulseRhythm", $17, $18, $19, $20,
         $21, $22::clinical."TempSite", $23, $24, $25::clinical."GlucoseType",
         $26, $27, $28, $29, $30,
         $31, $32::clinical."PainScale", $33::clinical."AvpuLevel", $34, $35::date, $36::clinical."PregnancyStatus",
         $37, $38, $39::jsonb, $40::clinical."VitalFlag", $41::jsonb, $42::clinical."VitalsSource", $43,
         $44, $45, $46,
         $47, $47, now()
       )
       RETURNING recorded_at`,
      [
        input.id,
        ctx.hospitalId,
        input.branchId,
        input.patient.id,
        body.visitId ?? null,
        body.encounterId ?? null,
        body.context,
        this.actor(),
        body.stationId ?? null,
        body.systolic ?? null,
        body.diastolic ?? null,
        body.bpPosition ?? null,
        body.bpArm ?? null,
        body.cuffSize ?? null,
        body.pulse ?? null,
        body.pulseRhythm ?? null,
        body.spo2 ?? null,
        body.onOxygen,
        body.o2FlowLpm ?? null,
        body.copdScale2,
        body.temperatureC ?? null,
        body.tempSite ?? null,
        body.respRate ?? null,
        body.glucoseMgdl ?? null,
        body.glucoseType ?? null,
        body.heightCm ?? null,
        body.weightKg ?? null,
        outcome.bmi,
        body.waistCm ?? null,
        body.headCircCm ?? null,
        body.painScore ?? null,
        body.painScale ?? null,
        body.avpu ?? null,
        body.gcsTotal ?? null,
        body.lmpDate ?? null,
        outcome.subject.pregnancy,
        outcome.news2?.score ?? null,
        outcome.news2?.band ?? null,
        JSON.stringify(outcome.evaluation.flags),
        outcome.evaluation.overall,
        JSON.stringify(input.deviceReadings),
        body.source,
        body.notes ?? null,
        body.repeatOfId ?? null,
        input.correctsId,
        input.correctedReason,
        ctx.userId,
      ],
    );
  }

  private async insertAssessment(
    tx: TransactionClient,
    input: {
      readonly branchId: string;
      readonly patientId: string;
      readonly visitId: string | null;
      readonly vitalsId: string;
      readonly recordedAt: Date;
      readonly assessment: NonNullable<CreateVitalsRequest['assessment']>;
    },
  ): Promise<void> {
    const ctx = getContext();
    const a = input.assessment;

    await tx.query(
      `INSERT INTO clinical.nursing_pre_consult_assessments (
         id, hospital_id, branch_id, patient_id, visit_id, vitals_id, vitals_recorded_at,
         allergies_verified, allergies_verified_at, medications_reconciled,
         fall_risk_score, fall_risk_flag, smoking, alcohol, chief_complaint_text,
         remarks, not_done_reason, created_by, updated_by, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         $8, $9, $10,
         $11, $12, $13, $14, $15,
         $16, $17, $18, $18, now()
       )`,
      [
        newId(),
        ctx.hospitalId,
        input.branchId,
        input.patientId,
        input.visitId,
        input.vitalsId,
        input.recordedAt,
        a.allergiesVerified,
        a.allergiesVerified ? new Date() : null,
        a.medicationsReconciled,
        a.fallRiskScore ?? null,
        a.fallRiskFlag,
        a.smoking ?? null,
        a.alcohol ?? null,
        a.chiefComplaintText ?? null,
        a.remarks ?? null,
        a.notDoneReason ?? null,
        ctx.userId,
      ],
    );
  }

  /**
   * OP-007 §3.2.4 — an out-of-band observation raises an alert and tells the
   * doctor, in the same transaction as the reading.
   *
   * The doctor is resolved from the visit's practitioner through
   * `mdm_practitioners.user_id`; a visiting consultant with no login leaves it
   * null, which is the state the escalation ladder reads as "nobody has been
   * told yet" rather than as "told and silent".
   */
  private async raiseAlert(
    tx: TransactionClient,
    input: {
      readonly branchId: string;
      readonly patient: PatientSubjectRow;
      readonly vitalsId: string;
      readonly recordedAt: Date;
      readonly visitId: string | null;
      readonly evaluation: ScoredObservation['evaluation'];
      readonly news2Score: number | null;
    },
  ): Promise<void> {
    const level: VitalFlag = input.evaluation.overall;
    if (level === 'normal') return;

    const ctx = getContext();
    const parameters = [...input.evaluation.critical, ...input.evaluation.abnormal];
    const alertId = newId();
    const doctorUserId = await this.doctorForVisit(tx, input.visitId);

    await tx.query(
      `INSERT INTO clinical.vitals_alerts (
         id, hospital_id, branch_id, patient_id, vitals_id, vitals_recorded_at,
         level, parameters, notified_doctor_id, notified_at, created_by, updated_by, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::clinical."VitalFlag", $8, $9, $10, $11, $11, now())`,
      [
        alertId,
        ctx.hospitalId,
        input.branchId,
        input.patient.id,
        input.vitalsId,
        input.recordedAt,
        level,
        parameters,
        doctorUserId,
        doctorUserId === null ? null : new Date(),
        ctx.userId,
      ],
    );

    await this.audit.write(tx, {
      action: 'insert',
      entity: 'clinical.vitals_alerts',
      rowId: alertId,
      businessKey: input.patient.uhid,
      dataClass: 'phi',
      patientId: input.patient.id,
      before: null,
      after: { level, parameters, notified_doctor_id: doctorUserId },
    });

    await this.outbox.publish(
      tx,
      clinicalEvent(level === 'critical' ? 'vitals.critical' : 'vitals.abnormal', alertId, {
        alertId,
        vitalsId: input.vitalsId,
        vitalsRecordedAt: input.recordedAt.toISOString(),
        patientId: input.patient.id,
        parameters,
        news2Score: input.news2Score,
        notifiedDoctorUserId: doctorUserId,
        raisedAt: new Date().toISOString(),
      }),
    );
  }

  private async doctorForVisit(tx: TransactionClient, visitId: string | null): Promise<string | null> {
    if (visitId === null) return null;
    const row = await tx.maybeOne<{ user_id: string | null }>(
      `SELECT p.user_id
         FROM clinical.op_visits v
         JOIN mdm.mdm_practitioners p ON p.record_key = v.practitioner_key AND p.status = 'active'
        WHERE v.id = $1
        ORDER BY p.version DESC
        LIMIT 1`,
      [visitId],
    );
    return row?.user_id ?? null;
  }
}

interface ScoredObservation {
  readonly bmi: number | null;
  readonly evaluation: ReturnType<typeof evaluateReadings>;
  readonly news2: ReturnType<typeof scoreNews2>;
  readonly subject: RangeSubject;
}

/**
 * The columns every read of an observation set returns. One constant so the
 * list and the single read cannot drift into returning different shapes.
 */
const VITALS_COLUMNS = `
  v.id, v.patient_id, v.visit_id, v.encounter_id, v.context::text AS context,
         v.recorded_at, v.recorded_by, v.station_id,
         v.systolic, v.diastolic, v.pulse, v.spo2, v.on_oxygen, v.copd_scale2,
         v.temperature_c, v.resp_rate, v.glucose_mgdl, v.glucose_type::text AS glucose_type,
         v.height_cm, v.weight_kg, v.bmi, v.pain_score, v.avpu::text AS avpu, v.gcs_total,
         v.lmp_date, v.pregnancy_status::text AS pregnancy_status,
         v.news2_score, v.news2_band, v.flags, v.overall_flag::text AS overall_flag,
         v.source::text AS source, v.notes, v.repeat_of_id, v.corrects_id, v.corrected_reason,
         v.superseded_at, v.version`;

const VITALS_SELECT = `SELECT ${VITALS_COLUMNS} FROM clinical.vitals v`;

/**
 * `pg` hands back `unknown` for a dynamically-shaped row. Every text column read
 * that way goes through here rather than through `String()`, which would happily
 * render an object as `[object Object]` and put it in a clinical reference band.
 */
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** "at least 40 mmHg", "up to 300 mmHg", "40–300 mmHg" — whichever bounds exist. */
function describeBounds(low: number | null, high: number | null, unit: string): string {
  if (low !== null && high !== null) return `${String(low)}–${String(high)} ${unit}`;
  if (low !== null) return `at least ${String(low)} ${unit}`;
  if (high !== null) return `up to ${String(high)} ${unit}`;
  return 'no configured bound';
}

/**
 * OP-007 §5: "BMI auto, not editable."
 *
 * Rounded to two decimals, which the migration's `vitals_bmi_derived` CHECK
 * accepts (it allows a discrepancy below 0.05 against the exact quotient). A
 * BMI arriving without both measurements is not computed at all rather than
 * being guessed from one.
 */
export function deriveBmi(heightCm: number | undefined, weightKg: number | undefined): number | null {
  if (heightCm === undefined || weightKg === undefined || heightCm <= 0) return null;
  const metres = heightCm / 100;
  return Math.round((weightKg / (metres * metres)) * 100) / 100;
}

/**
 * The measured values, named by the `vitals_reference_ranges.parameter` each is
 * scored against.
 *
 * Glucose is split by test type because 140 mg/dL is unremarkable after a meal
 * and abnormal fasting, and the reference table carries a separate row for each
 * — which is also why the schema refuses a glucose value with no type.
 */
export function readingsOf(
  body: {
    readonly systolic?: number | undefined;
    readonly diastolic?: number | undefined;
    readonly pulse?: number | undefined;
    readonly spo2?: number | undefined;
    readonly temperatureC?: number | undefined;
    readonly respRate?: number | undefined;
    readonly glucoseMgdl?: number | undefined;
    readonly glucoseType?: string | undefined;
    readonly heightCm?: number | undefined;
    readonly weightKg?: number | undefined;
    readonly headCircCm?: number | undefined;
    readonly painScore?: number | undefined;
  },
  bmi: number | null,
): readonly Reading[] {
  const readings: Reading[] = [];
  const push = (parameter: string, value: number | null | undefined): void => {
    if (value !== null && value !== undefined) readings.push({ parameter, value });
  };

  push('systolic', body.systolic);
  push('diastolic', body.diastolic);
  push('pulse', body.pulse);
  push('spo2', body.spo2);
  push('temperature_c', body.temperatureC);
  push('resp_rate', body.respRate);
  if (body.glucoseMgdl !== undefined && body.glucoseType !== undefined) {
    push(`glucose_${body.glucoseType}`, body.glucoseMgdl);
  }
  push('height_cm', body.heightCm);
  push('weight_kg', body.weightKg);
  push('head_circ_cm', body.headCircCm);
  push('pain_score', body.painScore);
  push('bmi', bmi);

  return readings;
}
