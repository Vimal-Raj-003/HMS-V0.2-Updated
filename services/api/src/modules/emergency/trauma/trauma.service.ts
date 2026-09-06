import { Inject, Injectable } from '@nestjs/common';
import {
  ESI_TARGET_MINUTES,
  ProblemType,
  TRISS_MTOS,
  newId,
  scoreEsi,
  scoreGcs,
  issBand,
  scoreIss,
  scoreMgap,
  scoreRts,
  scoreTriss,
  shockIndex,
  type AisInjury,
  type IssRegion,
  type Page,
} from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService, type TransactionClient } from '../../../core/db/database.service.js';
import { NumberingService } from '../../../core/numbering/numbering.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import { withTraumaErrors } from './trauma.errors.js';
import { traumaEvent } from './trauma.events.js';
import type {
  AcknowledgePageRequest,
  ActivateRequest,
  AmendScoreRequest,
  ComputeScoresRequest,
  DeclareMciRequest,
  InjuryRequest,
  InterventionRequest,
  StandDownMciRequest,
  StandDownRequest,
  SurveyRequest,
  TraumaBoardQuery,
  TriageRequest,
} from './trauma.schemas.js';
import type {
  ActivationPageView,
  GoldenHourClocks,
  MciIncidentView,
  PrimarySurveyView,
  SurveyInterventionView,
  TraumaActivationView,
  TraumaBoardView,
  TraumaInjuryView,
  TraumaScoreView,
  TriageRecordView,
  TriageResultView,
} from './trauma.types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Row coercion
// ─────────────────────────────────────────────────────────────────────────────

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
function asBoolOrNull(v: unknown): boolean | null {
  return v === null || v === undefined ? null : asBool(v);
}
function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map(asText) : [];
}

function minutesBetween(from: unknown, to: unknown): number | null {
  const a = asTextOrNull(from);
  const b = asTextOrNull(to);
  if (a === null || b === null) return null;
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60_000);
}

// ─────────────────────────────────────────────────────────────────────────────
// The published activation criteria
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The ACS-COT field triage criteria this hospital starts with.
 *
 * These *suggest*; they never activate. The team is called by a person pressing
 * a button, and the reason that matters is not squeamishness about automation —
 * it is that an automatic activation has nobody to stand it down, and a page
 * with no owner is the page a night shift learns to ignore.
 *
 * `criteriaFired` is stored on the activation rather than re-derived, because
 * this list is editable and an activation has to stay explicable after somebody
 * edits it.
 */
interface CriterionHit {
  readonly key: string;
  readonly tier: 'level_1' | 'level_2';
}

function activationCriteria(obs: {
  readonly systolicBp: number | null;
  readonly respiratoryRate: number | null;
  readonly gcsTotal: number | null;
  readonly gcsIntubated: boolean;
  readonly ageYears: number;
  readonly esiLevel: number | null;
}): readonly CriterionHit[] {
  const hits: CriterionHit[] = [];

  if (obs.systolicBp !== null && obs.systolicBp < 90) {
    hits.push({ key: 'systolic_bp_under_90', tier: 'level_1' });
  }
  if (obs.gcsIntubated) {
    hits.push({ key: 'intubated_or_airway_compromise', tier: 'level_1' });
  }
  if (obs.gcsTotal !== null && !obs.gcsIntubated && obs.gcsTotal <= 8) {
    hits.push({ key: 'gcs_8_or_less', tier: 'level_1' });
  }
  if (obs.respiratoryRate !== null && (obs.respiratoryRate < 10 || obs.respiratoryRate > 29)) {
    hits.push({ key: 'respiratory_rate_outside_10_29', tier: 'level_1' });
  }
  if (obs.esiLevel === 1) {
    hits.push({ key: 'esi_level_1', tier: 'level_1' });
  }
  // The paediatric and geriatric thresholds are the ones most often missed:
  // an 82-year-old with a "normal" pressure of 105 is shocked, and the criteria
  // that catch them have to be in the list rather than in somebody's judgement.
  if (obs.ageYears >= 65 && obs.systolicBp !== null && obs.systolicBp < 110) {
    hits.push({ key: 'age_65_plus_systolic_under_110', tier: 'level_2' });
  }
  if (obs.ageYears < 15 && obs.gcsTotal !== null && obs.gcsTotal <= 13) {
    hits.push({ key: 'paediatric_gcs_13_or_less', tier: 'level_2' });
  }
  if (obs.esiLevel === 2) {
    hits.push({ key: 'esi_level_2', tier: 'level_2' });
  }

  return hits;
}

/**
 * Who gets paged, by tier.
 *
 * A level-1 fan-out is wide on purpose. The cost of an orthopaedic surgeon
 * walking down for nothing is one walk; the cost of not paging them is measured
 * in the other direction.
 */
const DEFAULT_PAGE_ROLES: Readonly<Record<string, readonly string[]>> = {
  level_1: [
    'trauma_surgeon',
    'em_physician',
    'anaesthetist',
    'orthopaedics',
    'radiology',
    'blood_bank',
    'ot_coordinator',
  ],
  level_2: ['trauma_surgeon', 'em_physician', 'radiology'],
  consult: ['trauma_surgeon'],
};

/** 90 minutes is the warning, 120 the one that costs a limb. */
const TOURNIQUET_WARNING_MINUTES = 90;
const TOURNIQUET_CRITICAL_MINUTES = 120;

/**
 * TR-001 — triage, the trauma team and the golden hour.
 *
 * ── Nothing computed arrives from a client ──────────────────────────────────
 *
 * Every score in this file is produced by a pure function in
 * `@vims/contracts/scores` that the tablet also runs. The client renders its
 * result so the nurse sees a level before the round trip; the server stores
 * only what it computed itself. A GCS one point out is the difference between a
 * level-2 and a level-1 activation, so "the client already worked it out" is
 * exactly the shortcut that must not exist.
 *
 * ── The triage and the board are written together ───────────────────────────
 *
 * `applyTriage` writes the triage record and the denormalised `esi_level` on the
 * ER visit inside one transaction. The board sorts on that column, and a board
 * that disagrees with the record it is derived from is a board that sends the
 * wrong patient in first.
 */
@Injectable()
export class TraumaService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(NumberingService) private readonly numbering: NumberingService,
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
  /** EN-024 §5: the reason for a reason-required action rides in `x-reason`. */
  private reason(what: string): string {
    const value = getContext().reason;
    if (value === null || value.trim().length < 8) {
      throw new AppError(
        ProblemType.VALIDATION_FAILED,
        `${what} needs a reason of at least eight characters, sent in the \`x-reason\` header.`,
      );
    }
    return value.trim();
  }

  private guard<T>(fn: (tx: TransactionClient) => Promise<T>): Promise<T> {
    return withTraumaErrors(() => this.db.withTenant(currentTenantContext(), fn));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Triage
  // ═══════════════════════════════════════════════════════════════════════════

  async applyTriage(visitId: string, body: TriageRequest): Promise<TriageResultView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();
      const branch = this.branchId();
      const actor = this.actorId();

      const { rows: visitRows } = await tx.query<Record<string, unknown>>(
        `SELECT id, er_no, patient_id, esi_level, status, approximate_age, arrived_at
           FROM clinical.er_visits
          WHERE id = $1 AND hospital_id = $2
          FOR UPDATE`,
        [visitId, hospital],
      );
      const visit = visitRows[0];
      if (visit === undefined) throw AppError.notFound('That ER visit does not exist.');

      const previousLevel = asNumberOrNull(visit['esi_level']);

      // ── GCS ────────────────────────────────────────────────────────────────
      // Computed here, never accepted. An intubated patient's total is `nT` and
      // deliberately not padded: scoring the verbal component as 1 makes them
      // look worse than they are, as 5 better.
      let gcsTotal: number | null = null;
      let gcsDisplay: string | null = null;
      if (body.gcsEye !== undefined && body.gcsMotor !== undefined) {
        const gcs = scoreGcs({
          eye: body.gcsEye,
          motor: body.gcsMotor,
          verbal: body.gcsIntubated ? undefined : body.gcsVerbal,
          intubated: body.gcsIntubated,
          ageYears: body.ageYears,
        });
        gcsTotal = gcs.total;
        gcsDisplay = gcs.display;
      }

      // ── The level ──────────────────────────────────────────────────────────
      let suggestedLevel: number | null = null;
      let decisionPoint: string | null = null;
      let rationale: string | null = null;
      let dangerZoneVitals: readonly string[] = [];

      if (body.system === 'esi') {
        const esi = scoreEsi({
          needsLifeSavingIntervention: body.needsLifeSavingIntervention,
          highRisk: body.highRisk,
          resourceCount: body.resourceCount,
          ageYears: body.ageYears,
          vitals: {
            heartRate: body.heartRate,
            respiratoryRate: body.respiratoryRate,
            spo2: body.spo2,
            temperatureC: body.temperatureC,
          },
          painScore: body.painScore,
        });
        suggestedLevel = esi.level;
        decisionPoint = esi.decisionPoint;
        rationale = esi.rationale;
        dangerZoneVitals = esi.dangerZoneVitals;
      }

      const overridden = body.assignedLevel !== undefined || body.overrideReason !== undefined;
      if (overridden && (body.assignedLevel === undefined || body.overrideReason === undefined)) {
        throw new AppError(
          ProblemType.VALIDATION_FAILED,
          'An override needs both the level you are assigning and why. The nurse in front of the patient is usually right — the record just has to say so.',
        );
      }
      const esiLevel = body.system === 'esi' ? (body.assignedLevel ?? suggestedLevel) : null;

      if (body.system !== 'esi' && body.tag === undefined) {
        throw new AppError(
          ProblemType.VALIDATION_FAILED,
          'A START triage produces a tag: red, yellow, green or black. Colour and word both, never colour alone.',
        );
      }

      // ── Sequence and target ────────────────────────────────────────────────
      const { rows: seqRows } = await tx.query<Record<string, unknown>>(
        `SELECT COALESCE(max(sequence_no), 0) + 1 AS next FROM clinical.triage_records WHERE er_visit_id = $1`,
        [visitId],
      );
      const sequenceNo = asNumber(seqRows[0]?.['next'] ?? 1);

      const targetMinutes =
        esiLevel === null ? null : (ESI_TARGET_MINUTES[esiLevel as 1 | 2 | 3 | 4 | 5] ?? null);

      const id = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO clinical.triage_records (
           id, hospital_id, branch_id, er_visit_id, patient_id,
           system, sequence_no, esi_level, decision_point, resource_count,
           suggested_level, overridden, override_reason, tag,
           heart_rate, respiratory_rate, systolic_bp, diastolic_bp, spo2,
           temperature_c, pain_score, glucose,
           gcs_eye, gcs_verbal, gcs_motor, gcs_total, gcs_intubated,
           chief_complaint, pathways, target_seen_by,
           triaged_at, triaged_by, device_id, device_sequence, recorded_offline, synced_at, created_at
         ) VALUES (
           $1, $2, $3, $4, $5,
           $6::clinical."TriageSystem", $7, $8, $9, $10,
           $11, $12, $13, $14::clinical."TriageTag",
           $15, $16, $17, $18, $19,
           $20, $21, $22,
           $23, $24, $25, $26, $27,
           $28, $29,
           CASE WHEN $30::int IS NULL THEN NULL ELSE now() + make_interval(mins => $30::int) END,
           now(), $31, $32, $33, $34,
           CASE WHEN $34::boolean THEN now() ELSE NULL END, now()
         )
         RETURNING *`,
        [
          id,
          hospital,
          branch,
          visitId,
          asTextOrNull(visit['patient_id']),
          body.system,
          sequenceNo,
          esiLevel,
          decisionPoint,
          body.system === 'esi' ? body.resourceCount : null,
          suggestedLevel,
          overridden,
          body.overrideReason ?? null,
          body.tag ?? null,
          body.heartRate ?? null,
          body.respiratoryRate ?? null,
          body.systolicBp ?? null,
          body.diastolicBp ?? null,
          body.spo2 ?? null,
          body.temperatureC ?? null,
          body.painScore ?? null,
          body.glucose ?? null,
          body.gcsEye ?? null,
          body.gcsIntubated ? null : (body.gcsVerbal ?? null),
          body.gcsMotor ?? null,
          gcsTotal,
          body.gcsIntubated,
          body.chiefComplaint ?? null,
          body.pathways,
          targetMinutes,
          actor,
          body.deviceId ?? null,
          body.deviceSequence ?? null,
          body.recordedOffline,
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The triage was not written.');

      // ── The board and the record, together ─────────────────────────────────
      // `status` only advances; a re-triage of a patient already in treatment
      // must not send them back to the waiting room.
      // A visit carries one ladder's answer, never both — `er_visit_has_one_triage_ladder`.
      // Switching a patient from ESI to START mid-shift is exactly what happens
      // when an MCI is declared over their head, so the column the new triage
      // does not use is cleared rather than left holding a stale answer.
      await tx.query(
        `UPDATE clinical.er_visits
            SET esi_level = CASE WHEN $4 = 'esi' THEN COALESCE($2::int, esi_level) ELSE NULL END,
                triage_tag = CASE WHEN $4 = 'esi' THEN NULL
                                  ELSE COALESCE($5::clinical."TriageTag", triage_tag) END,
                triaged_at = COALESCE(triaged_at, now()),
                target_seen_by = COALESCE($3::timestamptz, target_seen_by),
                status = CASE WHEN status IN ('inbound', 'arrived') THEN 'triaged'::clinical."ErVisitStatus"
                              ELSE status END,
                updated_at = now()
          WHERE id = $1`,
        [visitId, esiLevel, asTextOrNull(row['target_seen_by']), body.system, body.tag ?? null],
      );

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'triage_record',
        rowId: id,
        businessKey: `${asText(visit['er_no'])}#${String(sequenceNo)}`,
        dataClass: 'phi',
        before: null,
        after: {
          system: body.system,
          sequenceNo,
          esiLevel,
          suggestedLevel,
          overridden,
          tag: body.tag ?? null,
        },
      });

      await this.outbox.publish(
        tx,
        traumaEvent('triage.assigned', id, {
          triageId: id,
          visitId,
          system: body.system,
          sequenceNo,
          esiLevel,
          tag: body.tag ?? null,
          suggestedLevel,
          overridden,
          targetSeenBy: asTextOrNull(row['target_seen_by']),
          pathways: body.pathways,
        }),
      );

      // A re-triage that found the patient sicker is the event that should wake
      // somebody. It is separate from `triage.assigned` for exactly that reason.
      let deterioratedFrom: number | null = null;
      if (previousLevel !== null && esiLevel !== null && esiLevel < previousLevel) {
        deterioratedFrom = previousLevel;
        const waited = minutesBetween(visit['arrived_at'], new Date().toISOString()) ?? 0;
        await this.outbox.publish(
          tx,
          traumaEvent('triage.deteriorated', id, {
            triageId: id,
            visitId,
            fromLevel: previousLevel,
            toLevel: esiLevel,
            minutesWaiting: waited,
          }),
        );
      }

      const hits = activationCriteria({
        systolicBp: body.systolicBp ?? null,
        respiratoryRate: body.respiratoryRate ?? null,
        gcsTotal,
        gcsIntubated: body.gcsIntubated,
        ageYears: body.ageYears,
        esiLevel,
      });
      const suggestedActivation =
        hits.length === 0
          ? null
          : {
              tier: hits.some((h) => h.tier === 'level_1') ? 'level_1' : 'level_2',
              criteria: hits.map((h) => h.key),
            };

      return {
        record: this.toTriage(row, gcsDisplay, rationale, dangerZoneVitals),
        deterioratedFrom,
        suggestedActivation,
      };
    });
  }

  async listTriage(visitId: string): Promise<Page<TriageRecordView>> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM clinical.triage_records
          WHERE er_visit_id = $1 AND hospital_id = $2
          ORDER BY sequence_no`,
        [visitId, this.hospitalId()],
      );
      return {
        items: rows.map((r) => this.toTriage(r, null, null, [])),
        nextCursor: null,
        hasMore: false,
      };
    });
  }

  private toTriage(
    row: Record<string, unknown>,
    gcsDisplay: string | null,
    rationale: string | null,
    dangerZoneVitals: readonly string[],
  ): TriageRecordView {
    const total = asNumberOrNull(row['gcs_total']);
    const intubated = asBool(row['gcs_intubated']);
    return {
      id: asText(row['id']),
      erVisitId: asText(row['er_visit_id']),
      system: asText(row['system']),
      sequenceNo: asNumber(row['sequence_no']),
      esiLevel: asNumberOrNull(row['esi_level']),
      decisionPoint: asTextOrNull(row['decision_point']),
      resourceCount: asNumberOrNull(row['resource_count']),
      suggestedLevel: asNumberOrNull(row['suggested_level']),
      overridden: asBool(row['overridden']),
      overrideReason: asTextOrNull(row['override_reason']),
      tag: asTextOrNull(row['tag']),
      heartRate: asNumberOrNull(row['heart_rate']),
      respiratoryRate: asNumberOrNull(row['respiratory_rate']),
      systolicBp: asNumberOrNull(row['systolic_bp']),
      diastolicBp: asNumberOrNull(row['diastolic_bp']),
      spo2: asNumberOrNull(row['spo2']),
      temperatureC: asTextOrNull(row['temperature_c']),
      painScore: asNumberOrNull(row['pain_score']),
      glucose: asNumberOrNull(row['glucose']),
      gcsEye: asNumberOrNull(row['gcs_eye']),
      gcsVerbal: asNumberOrNull(row['gcs_verbal']),
      gcsMotor: asNumberOrNull(row['gcs_motor']),
      gcsTotal: total,
      gcsIntubated: intubated,
      gcsDisplay: gcsDisplay ?? (total === null ? null : intubated ? `${String(total)}T` : String(total)),
      chiefComplaint: asTextOrNull(row['chief_complaint']),
      pathways: asStringArray(row['pathways']),
      targetSeenBy: asTextOrNull(row['target_seen_by']),
      triagedAt: asText(row['triaged_at']),
      triagedBy: asTextOrNull(row['triaged_by']),
      recordedOffline: asBool(row['recorded_offline']),
      rationale,
      dangerZoneVitals,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Activation
  // ═══════════════════════════════════════════════════════════════════════════

  async activate(body: ActivateRequest): Promise<TraumaActivationView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();
      const branch = this.branchId();
      const actor = this.actorId();

      const { rows: visitRows } = await tx.query<Record<string, unknown>>(
        `SELECT id, er_no FROM clinical.er_visits WHERE id = $1 AND hospital_id = $2`,
        [body.erVisitId, hospital],
      );
      if (visitRows[0] === undefined) throw AppError.notFound('That ER visit does not exist.');

      const id = newId();
      await tx.query(
        `INSERT INTO clinical.trauma_activations (
           id, hospital_id, branch_id, er_visit_id, triage_record_id,
           tier, status, criteria_fired, clinical_judgement,
           activated_at, activated_by, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5,
           $6::clinical."ActivationTier", 'active', $7, $8,
           now(), $9, now(), now()
         )`,
        [
          id,
          hospital,
          branch,
          body.erVisitId,
          body.triageRecordId ?? null,
          body.tier,
          body.criteriaFired,
          body.clinicalJudgement,
          actor,
        ],
      );

      // ── The fan-out ────────────────────────────────────────────────────────
      // `suppressed` is written false explicitly rather than left to the column
      // default. A level-1 page carrying true is refused by the database, and
      // spelling the value out here means the refusal is visible at the site of
      // the insert rather than three files away.
      const roles = body.pageRoles ?? DEFAULT_PAGE_ROLES[body.tier] ?? ['em_physician'];
      for (const role of roles) {
        await tx.query(
          `INSERT INTO clinical.activation_pages (
             id, hospital_id, activation_id, role, channel, status, suppressed, sent_at, created_at
           ) VALUES ($1, $2, $3, $4, 'push', 'sent'::clinical."PageStatus", false, now(), now())`,
          [newId(), hospital, id, role],
        );
      }

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'trauma_activation',
        rowId: id,
        businessKey: asText(visitRows[0]['er_no']),
        dataClass: 'phi',
        before: null,
        after: {
          tier: body.tier,
          criteriaFired: body.criteriaFired,
          clinicalJudgement: body.clinicalJudgement,
          pagedRoles: roles,
        },
      });

      await this.outbox.publish(
        tx,
        traumaEvent('trauma.activation.created', id, {
          activationId: id,
          visitId: body.erVisitId,
          tier: body.tier,
          criteriaFired: body.criteriaFired,
          clinicalJudgement: body.clinicalJudgement,
          pagedRoles: [...roles],
        }),
      );

      return this.loadActivation(tx, id);
    });
  }

  async acknowledgePage(pageId: string, body: AcknowledgePageRequest): Promise<TraumaActivationView> {
    return this.guard(async (tx) => {
      const actor = this.actorId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.activation_pages
            SET status = CASE WHEN $3::boolean THEN 'arrived'::clinical."PageStatus"
                              ELSE 'acknowledged'::clinical."PageStatus" END,
                acknowledged_at = COALESCE(acknowledged_at, now()),
                arrived_at = CASE WHEN $3::boolean THEN COALESCE(arrived_at, now()) ELSE arrived_at END,
                eta_minutes = COALESCE($4::int, eta_minutes),
                user_id = COALESCE(user_id, $2)
          WHERE id = $1 AND hospital_id = $5
          RETURNING *`,
        [pageId, actor, body.arrived, body.etaMinutes ?? null, this.hospitalId()],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.notFound('That page does not exist.');

      const activationId = asText(row['activation_id']);
      await this.outbox.publish(
        tx,
        traumaEvent('trauma.page.acknowledged', pageId, {
          pageId,
          activationId,
          role: asText(row['role']),
          secondsToAcknowledge: Math.max(
            0,
            Math.round(
              (new Date(asText(row['acknowledged_at'])).getTime() -
                new Date(asText(row['sent_at'] ?? row['created_at'])).getTime()) /
                1000,
            ),
          ),
          etaMinutes: asNumberOrNull(row['eta_minutes']),
        }),
      );

      return this.loadActivation(tx, activationId);
    });
  }

  async standDown(activationId: string, body: StandDownRequest): Promise<TraumaActivationView> {
    return this.guard(async (tx) => {
      const reason = this.reason('Standing the trauma team down');
      const actor = this.actorId();

      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.trauma_activations
            SET status = 'stood_down'::clinical."ActivationStatus",
                stood_down_at = now(),
                stood_down_by = $2,
                stand_down_reason = $3,
                final_iss = COALESCE($4::int, final_iss),
                updated_at = now()
          WHERE id = $1 AND hospital_id = $5 AND status = 'active'
          RETURNING *`,
        [activationId, actor, reason, body.finalIss ?? null, this.hospitalId()],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict('That activation is not running. Nothing was changed.');
      }

      await this.audit.write(tx, {
        action: 'update',
        entity: 'trauma_activation',
        rowId: activationId,
        businessKey: activationId,
        dataClass: 'phi',
        before: { status: 'active' },
        after: { status: 'stood_down', reason },
      });

      await this.outbox.publish(
        tx,
        traumaEvent('trauma.activation.stood_down', activationId, {
          activationId,
          visitId: asText(row['er_visit_id']),
          tier: asText(row['tier']),
          reason,
          minutesActive: minutesBetween(row['activated_at'], row['stood_down_at']) ?? 0,
        }),
      );

      return this.loadActivation(tx, activationId);
    });
  }

  async board(query: TraumaBoardQuery): Promise<TraumaBoardView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();
      const branch = this.branchId();

      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT a.*, v.er_no, v.display_name
           FROM clinical.trauma_activations a
           JOIN clinical.er_visits v ON v.id = a.er_visit_id
          WHERE a.hospital_id = $1 AND a.branch_id = $2
            AND ($3::boolean OR a.status = 'active')
          ORDER BY (a.status = 'active') DESC,
                   CASE a.tier WHEN 'level_1' THEN 1 WHEN 'level_2' THEN 2 ELSE 3 END,
                   a.activated_at DESC
          LIMIT $4`,
        [hospital, branch, query.includeClosed, query.limit],
      );

      const ids = rows.map((r) => asText(r['id']));
      const pagesByActivation = await this.loadPages(tx, ids);

      const { rows: mciRows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM clinical.mci_incidents
          WHERE hospital_id = $1 AND branch_id = $2 AND stood_down_at IS NULL
          ORDER BY declared_at DESC LIMIT 1`,
        [hospital, branch],
      );

      return {
        activations: rows.map((r) => this.toActivation(r, pagesByActivation.get(asText(r['id'])) ?? [])),
        activeMci: mciRows[0] === undefined ? null : this.toMci(mciRows[0]),
        generatedAt: new Date().toISOString(),
      };
    });
  }

  async getActivation(id: string): Promise<TraumaActivationView> {
    return this.guard((tx) => this.loadActivation(tx, id));
  }

  private async loadActivation(tx: TransactionClient, id: string): Promise<TraumaActivationView> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT a.*, v.er_no, v.display_name
         FROM clinical.trauma_activations a
         JOIN clinical.er_visits v ON v.id = a.er_visit_id
        WHERE a.id = $1 AND a.hospital_id = $2`,
      [id, this.hospitalId()],
    );
    const row = rows[0];
    if (row === undefined) throw AppError.notFound('That activation does not exist.');
    const pages = await this.loadPages(tx, [id]);
    return this.toActivation(row, pages.get(id) ?? []);
  }

  private async loadPages(
    tx: TransactionClient,
    activationIds: readonly string[],
  ): Promise<Map<string, ActivationPageView[]>> {
    const byActivation = new Map<string, ActivationPageView[]>();
    if (activationIds.length === 0) return byActivation;

    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM clinical.activation_pages
        WHERE activation_id = ANY($1::uuid[]) AND hospital_id = $2
        ORDER BY role`,
      [activationIds, this.hospitalId()],
    );

    for (const row of rows) {
      const activationId = asText(row['activation_id']);
      const list = byActivation.get(activationId) ?? [];
      const sentAt = asTextOrNull(row['sent_at']);
      const ackAt = asTextOrNull(row['acknowledged_at']);
      list.push({
        id: asText(row['id']),
        activationId,
        role: asText(row['role']),
        userId: asTextOrNull(row['user_id']),
        channel: asText(row['channel']),
        status: asText(row['status']),
        suppressed: asBool(row['suppressed']),
        sentAt,
        acknowledgedAt: ackAt,
        arrivedAt: asTextOrNull(row['arrived_at']),
        etaMinutes: asNumberOrNull(row['eta_minutes']),
        failureReason: asTextOrNull(row['failure_reason']),
        secondsToAcknowledge:
          sentAt === null || ackAt === null
            ? null
            : Math.max(0, Math.round((new Date(ackAt).getTime() - new Date(sentAt).getTime()) / 1000)),
      });
      byActivation.set(activationId, list);
    }
    return byActivation;
  }

  private toActivation(
    row: Record<string, unknown>,
    pages: readonly ActivationPageView[],
  ): TraumaActivationView {
    const stoodDownAt = asTextOrNull(row['stood_down_at']);
    return {
      id: asText(row['id']),
      erVisitId: asText(row['er_visit_id']),
      erNo: asTextOrNull(row['er_no']),
      displayName: asTextOrNull(row['display_name']),
      triageRecordId: asTextOrNull(row['triage_record_id']),
      tier: asText(row['tier']),
      status: asText(row['status']),
      criteriaFired: asStringArray(row['criteria_fired']),
      clinicalJudgement: asBool(row['clinical_judgement']),
      activatedAt: asText(row['activated_at']),
      activatedBy: asTextOrNull(row['activated_by']),
      stoodDownAt,
      standDownReason: asTextOrNull(row['stand_down_reason']),
      finalIss: asNumberOrNull(row['final_iss']),
      overTriage: asBoolOrNull(row['over_triage']),
      underTriage: asBoolOrNull(row['under_triage']),
      minutesActive: minutesBetween(row['activated_at'], stoodDownAt ?? new Date().toISOString()) ?? 0,
      pages,
      acknowledgedCount: pages.filter((p) => p.acknowledgedAt !== null).length,
      pagedCount: pages.length,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The primary survey and the golden hour
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Create or update the survey. One per visit — the unique index says so.
   *
   * Every field is optional and merged over what is there, because this form is
   * filled in over an hour by four people, and a PUT that blanked the airway
   * because the person recording the pelvic binder left it empty would be a
   * clinical record destroyed by a UI convention.
   */
  async recordSurvey(body: SurveyRequest): Promise<PrimarySurveyView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();
      const actor = this.actorId();

      const { rows: existing } = await tx.query<Record<string, unknown>>(
        `SELECT id FROM clinical.primary_surveys WHERE er_visit_id = $1 AND hospital_id = $2`,
        [body.erVisitId, hospital],
      );

      let surveyId = asTextOrNull(existing[0]?.['id']);
      if (surveyId === null) {
        surveyId = newId();
        await tx.query(
          `INSERT INTO clinical.primary_surveys (
             id, hospital_id, er_visit_id, activation_id, door_at, created_at, created_by, updated_at
           ) VALUES ($1, $2, $3, $4, now(), now(), $5, now())`,
          [surveyId, hospital, body.erVisitId, body.activationId ?? null, actor],
        );
      }

      // COALESCE on every column: absent means "not recorded now", never "clear
      // what somebody else recorded".
      await tx.query(
        `UPDATE clinical.primary_surveys SET
           activation_id       = COALESCE($2::uuid, activation_id),
           injury_at           = COALESCE($3::timestamptz, injury_at),
           ct_at               = COALESCE($4::timestamptz, ct_at),
           ot_at               = COALESCE($5::timestamptz, ot_at),
           airway_patent       = COALESCE($6::boolean, airway_patent),
           airway_adjunct      = COALESCE($7, airway_adjunct),
           collar_at           = COALESCE($8::timestamptz, collar_at),
           intubated_at        = COALESCE($9::timestamptz, intubated_at),
           breath_sounds_equal = COALESCE($10::boolean, breath_sounds_equal),
           needle_decomp_at    = COALESCE($11::timestamptz, needle_decomp_at),
           chest_drain_at      = COALESCE($12::timestamptz, chest_drain_at),
           tourniquet_on_at    = COALESCE($13::timestamptz, tourniquet_on_at),
           tourniquet_off_at   = COALESCE($14::timestamptz, tourniquet_off_at),
           tourniquet_site     = COALESCE($15, tourniquet_site),
           pelvic_binder_at    = COALESCE($16::timestamptz, pelvic_binder_at),
           iv_access_count     = COALESCE($17::int, iv_access_count),
           io_access           = COALESCE($18::boolean, io_access),
           crystalloid_ml      = COALESCE($19::int, crystalloid_ml),
           blood_units         = COALESCE($20::int, blood_units),
           mtp_activated_at    = COALESCE($21::timestamptz, mtp_activated_at),
           fast_result         = COALESCE($22, fast_result),
           pupil_left_mm       = COALESCE($23::int, pupil_left_mm),
           pupil_right_mm      = COALESCE($24::int, pupil_right_mm),
           pupils_reactive     = COALESCE($25::boolean, pupils_reactive),
           exposed_at          = COALESCE($26::timestamptz, exposed_at),
           log_rolled_at       = COALESCE($27::timestamptz, log_rolled_at),
           temperature_c       = COALESCE($28::numeric, temperature_c),
           tetanus_at          = COALESCE($29::timestamptz, tetanus_at),
           txa_at              = COALESCE($30::timestamptz, txa_at),
           antibiotic_at       = COALESCE($31::timestamptz, antibiotic_at),
           ample_history       = COALESCE($32::jsonb, ample_history),
           mechanism           = COALESCE($33, mechanism),
           updated_at          = now(),
           updated_by          = $34
         WHERE id = $1`,
        [
          surveyId,
          body.activationId ?? null,
          body.injuryAt ?? null,
          body.ctAt ?? null,
          body.otAt ?? null,
          body.airwayPatent ?? null,
          body.airwayAdjunct ?? null,
          body.collarAt ?? null,
          body.intubatedAt ?? null,
          body.breathSoundsEqual ?? null,
          body.needleDecompAt ?? null,
          body.chestDrainAt ?? null,
          body.tourniquetOnAt ?? null,
          body.tourniquetOffAt ?? null,
          body.tourniquetSite ?? null,
          body.pelvicBinderAt ?? null,
          body.ivAccessCount ?? null,
          body.ioAccess ?? null,
          body.crystalloidMl ?? null,
          body.bloodUnits ?? null,
          body.mtpActivatedAt ?? null,
          body.fastResult ?? null,
          body.pupilLeftMm ?? null,
          body.pupilRightMm ?? null,
          body.pupilsReactive ?? null,
          body.exposedAt ?? null,
          body.logRolledAt ?? null,
          body.temperatureC ?? null,
          body.tetanusAt ?? null,
          body.txaAt ?? null,
          body.antibioticAt ?? null,
          body.ampleHistory === undefined ? null : JSON.stringify(body.ampleHistory),
          body.mechanism ?? null,
          actor,
        ],
      );

      await this.audit.write(tx, {
        action: 'update',
        entity: 'primary_survey',
        rowId: surveyId,
        businessKey: body.erVisitId,
        dataClass: 'phi',
        before: null,
        after: { fieldsRecorded: Object.keys(body).length },
      });

      return this.loadSurvey(tx, body.erVisitId);
    });
  }

  async addIntervention(visitId: string, body: InterventionRequest): Promise<PrimarySurveyView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT id FROM clinical.primary_surveys WHERE er_visit_id = $1 AND hospital_id = $2`,
        [visitId, hospital],
      );
      const surveyId = asTextOrNull(rows[0]?.['id']);
      if (surveyId === null) {
        throw AppError.conflict('Start the primary survey before recording what was done in it.');
      }

      await tx.query(
        `INSERT INTO clinical.survey_interventions (id, hospital_id, survey_id, kind, detail, at_time, by_id)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, now()), $7)`,
        [newId(), hospital, surveyId, body.kind, body.detail ?? null, body.atTime ?? null, this.actorId()],
      );

      return this.loadSurvey(tx, visitId);
    });
  }

  async getSurvey(visitId: string): Promise<PrimarySurveyView> {
    return this.guard((tx) => this.loadSurvey(tx, visitId));
  }

  private async loadSurvey(tx: TransactionClient, visitId: string): Promise<PrimarySurveyView> {
    const hospital = this.hospitalId();
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM clinical.primary_surveys WHERE er_visit_id = $1 AND hospital_id = $2`,
      [visitId, hospital],
    );
    const row = rows[0];
    if (row === undefined) throw AppError.notFound('No primary survey has been started for that visit.');

    const { rows: interventionRows } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM clinical.survey_interventions
        WHERE survey_id = $1 AND hospital_id = $2
        ORDER BY at_time`,
      [asText(row['id']), hospital],
    );

    const doorAt = asText(row['door_at']);
    const interventions: SurveyInterventionView[] = interventionRows.map((i) => ({
      id: asText(i['id']),
      kind: asText(i['kind']),
      detail: asTextOrNull(i['detail']),
      atTime: asText(i['at_time']),
      byId: asTextOrNull(i['by_id']),
      minutesFromDoor: minutesBetween(doorAt, i['at_time']) ?? 0,
    }));

    return {
      id: asText(row['id']),
      erVisitId: visitId,
      activationId: asTextOrNull(row['activation_id']),
      injuryAt: asTextOrNull(row['injury_at']),
      doorAt,
      ctAt: asTextOrNull(row['ct_at']),
      otAt: asTextOrNull(row['ot_at']),
      airwayPatent: asBoolOrNull(row['airway_patent']),
      airwayAdjunct: asTextOrNull(row['airway_adjunct']),
      collarAt: asTextOrNull(row['collar_at']),
      intubatedAt: asTextOrNull(row['intubated_at']),
      breathSoundsEqual: asBoolOrNull(row['breath_sounds_equal']),
      needleDecompAt: asTextOrNull(row['needle_decomp_at']),
      chestDrainAt: asTextOrNull(row['chest_drain_at']),
      tourniquetOnAt: asTextOrNull(row['tourniquet_on_at']),
      tourniquetOffAt: asTextOrNull(row['tourniquet_off_at']),
      tourniquetSite: asTextOrNull(row['tourniquet_site']),
      pelvicBinderAt: asTextOrNull(row['pelvic_binder_at']),
      ivAccessCount: asNumber(row['iv_access_count']),
      ioAccess: asBool(row['io_access']),
      crystalloidMl: asNumber(row['crystalloid_ml']),
      bloodUnits: asNumber(row['blood_units']),
      mtpActivatedAt: asTextOrNull(row['mtp_activated_at']),
      fastResult: asTextOrNull(row['fast_result']),
      pupilLeftMm: asNumberOrNull(row['pupil_left_mm']),
      pupilRightMm: asNumberOrNull(row['pupil_right_mm']),
      pupilsReactive: asBoolOrNull(row['pupils_reactive']),
      exposedAt: asTextOrNull(row['exposed_at']),
      logRolledAt: asTextOrNull(row['log_rolled_at']),
      temperatureC: asTextOrNull(row['temperature_c']),
      tetanusAt: asTextOrNull(row['tetanus_at']),
      txaAt: asTextOrNull(row['txa_at']),
      antibioticAt: asTextOrNull(row['antibiotic_at']),
      ampleHistory: row['ample_history'] ?? null,
      mechanism: asTextOrNull(row['mechanism']),
      interventions,
      clocks: this.clocks(row, doorAt),
    };
  }

  private clocks(row: Record<string, unknown>, doorAt: string): GoldenHourClocks {
    const now = new Date().toISOString();
    const tourniquetOn = asTextOrNull(row['tourniquet_on_at']);
    const tourniquetOff = asTextOrNull(row['tourniquet_off_at']);
    const tourniquetMinutes =
      tourniquetOn === null ? null : (minutesBetween(tourniquetOn, tourniquetOff ?? now) ?? null);

    return {
      prehospitalMinutes: minutesBetween(row['injury_at'], doorAt),
      doorToCtMinutes: minutesBetween(doorAt, row['ct_at']),
      doorToOtMinutes: minutesBetween(doorAt, row['ot_at']),
      elapsedMinutes: minutesBetween(doorAt, now) ?? 0,
      tourniquetMinutes,
      tourniquetAlarm:
        tourniquetMinutes === null || tourniquetOff !== null
          ? 'none'
          : tourniquetMinutes >= TOURNIQUET_CRITICAL_MINUTES
            ? 'critical'
            : tourniquetMinutes >= TOURNIQUET_WARNING_MINUTES
              ? 'warning'
              : 'none',
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Injuries and scores
  // ═══════════════════════════════════════════════════════════════════════════

  async addInjury(visitId: string, body: InjuryRequest): Promise<Page<TraumaInjuryView>> {
    return this.guard(async (tx) => {
      await tx.query(
        `INSERT INTO clinical.trauma_injuries
           (id, hospital_id, er_visit_id, region, ais_severity, ais_code, description, side, created_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), $9)`,
        [
          newId(),
          this.hospitalId(),
          visitId,
          body.region,
          body.aisSeverity,
          body.aisCode ?? null,
          body.description,
          body.side ?? null,
          this.actorId(),
        ],
      );
      return this.loadInjuries(tx, visitId);
    });
  }

  /** Only before the score that used it is locked — otherwise the score lies. */
  async removeInjury(visitId: string, injuryId: string): Promise<Page<TraumaInjuryView>> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT count(*) AS locked FROM clinical.trauma_scores
          WHERE er_visit_id = $1 AND hospital_id = $2 AND status = 'locked'`,
        [visitId, this.hospitalId()],
      );
      if (asNumber(rows[0]?.['locked'] ?? 0) > 0) {
        throw AppError.conflict(
          'A locked score was computed from this injury list. Amend the score instead — removing the injury now would leave a signed ISS that no longer follows from anything.',
        );
      }
      await tx.query(
        `DELETE FROM clinical.trauma_injuries WHERE id = $1 AND er_visit_id = $2 AND hospital_id = $3`,
        [injuryId, visitId, this.hospitalId()],
      );
      return this.loadInjuries(tx, visitId);
    });
  }

  async listInjuries(visitId: string): Promise<Page<TraumaInjuryView>> {
    return this.guard((tx) => this.loadInjuries(tx, visitId));
  }

  private async loadInjuries(tx: TransactionClient, visitId: string): Promise<Page<TraumaInjuryView>> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM clinical.trauma_injuries
        WHERE er_visit_id = $1 AND hospital_id = $2
        ORDER BY ais_severity DESC, region`,
      [visitId, this.hospitalId()],
    );
    return {
      items: rows.map((r) => ({
        id: asText(r['id']),
        region: asText(r['region']),
        aisSeverity: asNumber(r['ais_severity']),
        aisCode: asTextOrNull(r['ais_code']),
        description: asText(r['description']),
        side: asTextOrNull(r['side']),
      })),
      nextCursor: null,
      hasMore: false,
    };
  }

  async computeScores(body: ComputeScoresRequest): Promise<TraumaScoreView> {
    return this.guard((tx) => this.writeScore(tx, body, null));
  }

  /**
   * Amend a locked score.
   *
   * The locked version is marked `amended` and stays; the correction is a new
   * version carrying the reason. "Was the score changed after the death?" has to
   * be answerable either way, and a registry submission that silently moved is
   * one nobody can defend at a mortality review.
   */
  async amendScore(body: AmendScoreRequest): Promise<TraumaScoreView> {
    return this.guard(async (tx) => {
      const reason = this.reason('Amending a locked trauma score');
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT id, status, version_no FROM clinical.trauma_scores
          WHERE id = $1 AND er_visit_id = $2 AND hospital_id = $3`,
        [body.supersedesId, body.erVisitId, this.hospitalId()],
      );
      const previous = rows[0];
      if (previous === undefined) throw AppError.notFound('That score version does not exist.');
      if (asText(previous['status']) !== 'locked') {
        throw AppError.conflict('Only a locked score is amended. A provisional one is simply recomputed.');
      }

      // `amended` is the one transition the immutability trigger allows.
      await tx.query(
        `UPDATE clinical.trauma_scores SET status = 'amended'::clinical."ScoreStatus" WHERE id = $1`,
        [body.supersedesId],
      );

      return this.writeScore(tx, body, { supersedesId: body.supersedesId, reason });
    });
  }

  private async writeScore(
    tx: TransactionClient,
    body: ComputeScoresRequest,
    amendment: { readonly supersedesId: string; readonly reason: string } | null,
  ): Promise<TraumaScoreView> {
    const hospital = this.hospitalId();

    // ── The arrival set ────────────────────────────────────────────────────
    // Read from the *first* triage record when the caller does not supply it.
    // That record is the arrival physiology by definition, and TRISS computed
    // from anything later says the patient was always going to survive.
    const { rows: arrivalRows } = await tx.query<Record<string, unknown>>(
      `SELECT gcs_total, systolic_bp, respiratory_rate, heart_rate
         FROM clinical.triage_records
        WHERE er_visit_id = $1 AND hospital_id = $2
        ORDER BY sequence_no
        LIMIT 1`,
      [body.erVisitId, hospital],
    );
    const arrival = arrivalRows[0];

    const { rows: visitRows } = await tx.query<Record<string, unknown>>(
      `SELECT er_no, approximate_age FROM clinical.er_visits WHERE id = $1 AND hospital_id = $2`,
      [body.erVisitId, hospital],
    );
    if (visitRows[0] === undefined) throw AppError.notFound('That ER visit does not exist.');

    const gcs = body.arrivalGcs ?? asNumberOrNull(arrival?.['gcs_total']);
    const sbp = body.arrivalSbp ?? asNumberOrNull(arrival?.['systolic_bp']);
    const rr = body.arrivalRr ?? asNumberOrNull(arrival?.['respiratory_rate']);
    const hr = body.arrivalHeartRate ?? asNumberOrNull(arrival?.['heart_rate']);
    const age = body.ageYears ?? asNumberOrNull(visitRows[0]['approximate_age']);

    // ── The injuries ───────────────────────────────────────────────────────
    const { rows: injuryRows } = await tx.query<Record<string, unknown>>(
      `SELECT region, ais_severity FROM clinical.trauma_injuries
        WHERE er_visit_id = $1 AND hospital_id = $2`,
      [body.erVisitId, hospital],
    );
    const injuries: AisInjury[] = injuryRows.map((r) => ({
      region: asText(r['region']) as IssRegion,
      severity: asNumber(r['ais_severity']),
    }));
    const iss = scoreIss(injuries);

    const rts =
      gcs !== null && sbp !== null && rr !== null
        ? scoreRts({ gcs, systolicBp: sbp, respiratoryRate: rr })
        : null;
    const si = hr !== null && sbp !== null && sbp > 0 ? shockIndex(hr, sbp) : null;
    const mgap =
      gcs !== null && sbp !== null && age !== null
        ? scoreMgap({ gcs, systolicBp: sbp, ageYears: age, blunt: body.mechanism === 'blunt' })
        : null;
    const triss =
      rts !== null && age !== null && injuries.length > 0
        ? scoreTriss({ rts: rts.rts, iss: iss.iss, ageYears: age, mechanism: body.mechanism })
        : null;

    const { rows: seqRows } = await tx.query<Record<string, unknown>>(
      `SELECT COALESCE(max(version_no), 0) + 1 AS next FROM clinical.trauma_scores WHERE er_visit_id = $1`,
      [body.erVisitId],
    );
    const versionNo = asNumber(seqRows[0]?.['next'] ?? 1);

    const id = newId();
    const { rows } = await tx.query<Record<string, unknown>>(
      `INSERT INTO clinical.trauma_scores (
         id, hospital_id, er_visit_id, version_no, status,
         arrival_gcs, arrival_sbp, arrival_rr, age_years, mechanism,
         rts, iss, niss, shock_index, mgap, gap, triss, triss_coefficient_set,
         supersedes_id, amend_reason, computed_at, created_at, created_by
       ) VALUES (
         $1, $2, $3, $4, 'provisional'::clinical."ScoreStatus",
         $5, $6, $7, $8, $9,
         $10, $11, $12, $13, $14, $15, $16, $17,
         $18, $19, now(), now(), $20
       )
       RETURNING *`,
      [
        id,
        hospital,
        body.erVisitId,
        versionNo,
        gcs,
        sbp,
        rr,
        age,
        body.mechanism,
        rts?.rts ?? null,
        injuries.length === 0 ? null : iss.iss,
        injuries.length === 0 ? null : iss.niss,
        si?.value ?? null,
        mgap?.mgap ?? null,
        mgap?.gap ?? null,
        triss?.probabilityOfSurvival ?? null,
        triss?.coefficientSet ??
          (body.mechanism === 'blunt' ? TRISS_MTOS.blunt.label : TRISS_MTOS.penetrating.label),
        amendment?.supersedesId ?? null,
        amendment?.reason ?? null,
        this.actorId(),
      ],
    );
    const row = rows[0];
    if (row === undefined) throw AppError.conflict('The score was not written.');

    await this.outbox.publish(
      tx,
      traumaEvent('trauma.score.computed', id, {
        scoreId: id,
        visitId: body.erVisitId,
        versionNo,
        iss: injuries.length === 0 ? null : iss.iss,
        niss: injuries.length === 0 ? null : iss.niss,
        rts: rts === null ? null : rts.rts.toFixed(4),
        triss: triss === null ? null : triss.probabilityOfSurvival.toFixed(4),
        coefficientSet: triss?.coefficientSet ?? null,
      }),
    );

    return this.toScore(row);
  }

  async lockScore(scoreId: string): Promise<TraumaScoreView> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.trauma_scores
            SET status = 'locked'::clinical."ScoreStatus", locked_at = now(), locked_by = $2
          WHERE id = $1 AND hospital_id = $3 AND status = 'provisional'
          RETURNING *`,
        [scoreId, this.actorId(), this.hospitalId()],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict('That score is not provisional. A locked score is amended, never re-locked.');
      }

      await this.audit.write(tx, {
        action: 'update',
        entity: 'trauma_score',
        rowId: scoreId,
        businessKey: `${asText(row['er_visit_id'])}#v${asText(row['version_no'])}`,
        dataClass: 'phi',
        before: { status: 'provisional' },
        after: { status: 'locked', iss: asNumberOrNull(row['iss']) },
      });

      await this.outbox.publish(
        tx,
        traumaEvent('trauma.score.locked', scoreId, {
          scoreId,
          visitId: asText(row['er_visit_id']),
          versionNo: asNumber(row['version_no']),
          iss: asNumberOrNull(row['iss']),
        }),
      );

      return this.toScore(row);
    });
  }

  async listScores(visitId: string): Promise<Page<TraumaScoreView>> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM clinical.trauma_scores
          WHERE er_visit_id = $1 AND hospital_id = $2
          ORDER BY version_no DESC`,
        [visitId, this.hospitalId()],
      );
      return { items: rows.map((r) => this.toScore(r)), nextCursor: null, hasMore: false };
    });
  }

  /**
   * `trissDisplay` is derived from the **stored** decimal, never from the
   * unrounded probability the calculator returned.
   *
   * The column is `numeric(6,4)`, so the record holds 0.8525 whatever the
   * arithmetic produced. Formatting the live value at compute time and the
   * stored value on reload made the same score read 85.2% when it was computed
   * and 85.3% when the page was refreshed — a survival probability that moves
   * on a page refresh is one nobody can quote in a mortality review.
   */
  private toScore(row: Record<string, unknown>): TraumaScoreView {
    const triss = asTextOrNull(row['triss']);
    const iss = asNumberOrNull(row['iss']);
    return {
      id: asText(row['id']),
      erVisitId: asText(row['er_visit_id']),
      versionNo: asNumber(row['version_no']),
      status: asText(row['status']),
      arrivalGcs: asNumberOrNull(row['arrival_gcs']),
      arrivalSbp: asNumberOrNull(row['arrival_sbp']),
      arrivalRr: asNumberOrNull(row['arrival_rr']),
      ageYears: asNumberOrNull(row['age_years']),
      mechanism: asTextOrNull(row['mechanism']),
      rts: asTextOrNull(row['rts']),
      iss,
      niss: asNumberOrNull(row['niss']),
      issBand: iss === null ? null : issBand(iss),
      shockIndex: asTextOrNull(row['shock_index']),
      mgap: asNumberOrNull(row['mgap']),
      gap: asNumberOrNull(row['gap']),
      triss,
      trissDisplay: triss === null ? null : `${(Number(triss) * 100).toFixed(1)}%`,
      trissCoefficientSet: asTextOrNull(row['triss_coefficient_set']),
      lockedAt: asTextOrNull(row['locked_at']),
      lockedBy: asTextOrNull(row['locked_by']),
      supersedesId: asTextOrNull(row['supersedes_id']),
      amendReason: asTextOrNull(row['amend_reason']),
      computedAt: asText(row['computed_at']),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Mass casualty
  // ═══════════════════════════════════════════════════════════════════════════

  async declareMci(body: DeclareMciRequest): Promise<MciIncidentView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();
      const branch = this.branchId();

      const { rows: running } = await tx.query<Record<string, unknown>>(
        `SELECT id, incident_code FROM clinical.mci_incidents
          WHERE hospital_id = $1 AND branch_id = $2 AND stood_down_at IS NULL`,
        [hospital, branch],
      );
      if (running[0] !== undefined) {
        throw AppError.conflict(
          `An incident is already running (${asText(running[0]['incident_code'])}). A second declaration would split the casualty count across two boards.`,
        );
      }

      const id = newId();
      const alloc = await this.numbering.allocate(tx, {
        key: 'MCI_NO',
        branchId: branch,
        refType: 'mci_incident',
        refId: id,
      });

      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO clinical.mci_incidents
           (id, hospital_id, branch_id, incident_code, name, source, declared_at, declared_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now(), $7, now(), now())
         RETURNING *`,
        [id, hospital, branch, alloc.formatted, body.name, body.source, this.actorId()],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The incident was not declared.');

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'mci_incident',
        rowId: id,
        businessKey: alloc.formatted,
        dataClass: 'operational',
        before: null,
        after: { name: body.name, source: body.source },
      });

      await this.outbox.publish(
        tx,
        traumaEvent('mci.declared', id, {
          incidentId: id,
          incidentCode: alloc.formatted,
          name: body.name,
          source: body.source,
        }),
      );

      return this.toMci(row);
    });
  }

  async standDownMci(id: string, body: StandDownMciRequest): Promise<MciIncidentView> {
    return this.guard(async (tx) => {
      const reason = this.reason('Closing a mass-casualty incident');
      const report = {
        ...(body.afterActionReport ?? { patientsSeen: 0, actions: [] }),
        closedBecause: reason,
      };

      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.mci_incidents
            SET stood_down_at = now(), stood_down_by = $2, after_action_report = $3::jsonb, updated_at = now()
          WHERE id = $1 AND hospital_id = $4 AND stood_down_at IS NULL
          RETURNING *`,
        [id, this.actorId(), JSON.stringify(report), this.hospitalId()],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('That incident is not running.');

      await this.outbox.publish(
        tx,
        traumaEvent('mci.stood_down', id, {
          incidentId: id,
          incidentCode: asText(row['incident_code']),
          minutesActive: minutesBetween(row['declared_at'], row['stood_down_at']) ?? 0,
          patientsSeen: body.afterActionReport?.patientsSeen ?? 0,
        }),
      );

      return this.toMci(row);
    });
  }

  async listMci(): Promise<Page<MciIncidentView>> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM clinical.mci_incidents
          WHERE hospital_id = $1 AND branch_id = $2
          ORDER BY declared_at DESC
          LIMIT 100`,
        [this.hospitalId(), this.branchId()],
      );
      return { items: rows.map((r) => this.toMci(r)), nextCursor: null, hasMore: false };
    });
  }

  private toMci(row: Record<string, unknown>): MciIncidentView {
    const stoodDownAt = asTextOrNull(row['stood_down_at']);
    return {
      id: asText(row['id']),
      incidentCode: asText(row['incident_code']),
      name: asText(row['name']),
      source: asText(row['source']),
      declaredAt: asText(row['declared_at']),
      declaredBy: asTextOrNull(row['declared_by']),
      stoodDownAt,
      minutesActive: minutesBetween(row['declared_at'], stoodDownAt ?? new Date().toISOString()) ?? 0,
      afterActionReport: row['after_action_report'] ?? null,
      isActive: stoodDownAt === null,
    };
  }
}
