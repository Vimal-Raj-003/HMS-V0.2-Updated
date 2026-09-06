import { Inject, Injectable } from '@nestjs/common';
import { ProblemType, newId, type Page } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService, type TransactionClient } from '../../../core/db/database.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import { withFractureErrors } from './fracture.errors.js';
import { fractureEvent } from './fracture.events.js';
import type {
  BundleRequest,
  ComplicationRequest,
  ConfirmRequest,
  CreateFractureRequest,
  EpisodeRequest,
  ExamRequest,
  FilmRequest,
  FindingRequest,
  FollowupRequest,
  FractureEventRequest,
  PlanRequest,
  PromRequest,
  RegistryQuery,
  UnionRequest,
  UpdateFractureRequest,
} from './fracture.schemas.js';
import type { FractureDetailView, FractureView, OrthoEpisodeView } from './fracture.types.js';

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
function json(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}
function weeksBetween(from: unknown, to: unknown): string | null {
  const a = asTextOrNull(from);
  const b = asTextOrNull(to);
  if (a === null || b === null) return null;
  return ((new Date(b).getTime() - new Date(a).getTime()) / (7 * 24 * 3600 * 1000)).toFixed(1);
}

/**
 * Six months. Before this, non-union is a surgeon's judgement rather than a
 * definition, and it needs stated grounds.
 */
const NONUNION_WEEKS = 26;

/**
 * TR-002 + OP-009 — the fracture registry and the orthopaedic OPD.
 *
 * ── The AO code is rendered here, once ──────────────────────────────────────
 *
 * `42-B2.1` is bone 4, segment 2, type B, group 2, subgroup 1. Rendering it in
 * the service rather than accepting a string means the components and the
 * display can never disagree, and a registry export cannot contain a code
 * somebody typed by hand.
 *
 * ── Laterality is compared by the database, not here ────────────────────────
 *
 * `setPlan` sends the side and Postgres refuses a mismatch. Checking it in this
 * service as well would be a second implementation of the one rule that must
 * not have two implementations — the whole failure mode is four documents each
 * confident they were checked.
 */
@Injectable()
export class FractureService {
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
    return withFractureErrors(() => this.db.withTenant(currentTenantContext(), fn));
  }

  /** `42-B2.1`. Built from the components so the two cannot drift apart. */
  private renderAoCode(f: {
    readonly aoBone?: number | undefined;
    readonly aoSegment?: number | undefined;
    readonly aoType?: string | undefined;
    readonly aoGroup?: number | undefined;
    readonly aoSubgroup?: number | undefined;
  }): string | null {
    if (f.aoBone === undefined || f.aoSegment === undefined) return null;
    let code = `${String(f.aoBone)}${String(f.aoSegment)}`;
    if (f.aoType === undefined) return code;
    code += `-${f.aoType}`;
    if (f.aoGroup === undefined) return code;
    code += String(f.aoGroup);
    if (f.aoSubgroup === undefined) return code;
    return `${code}.${String(f.aoSubgroup)}`;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The registry
  // ═══════════════════════════════════════════════════════════════════════════

  async createFracture(body: CreateFractureRequest): Promise<FractureDetailView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();
      const id = newId();
      const aoCode = this.renderAoCode(body);

      await tx.query(
        `INSERT INTO clinical.fx_fractures (
           id, hospital_id, branch_id, patient_id, er_visit_id, admission_id, trauma_injury_id, ortho_episode_id,
           bone_code, bone_display, ao_bone, ao_segment, ao_type, ao_group, ao_subgroup, ao_qualifiers, ao_code, ao_version,
           side, is_open, gustilo, tscherne, paediatric, salter_harris,
           aetiology, periprosthetic_class, dislocation, associated, regional_classification,
           icd10, mechanism, injury_at, injury_at_estimated, diagnosed_at, diagnosed_by,
           classification_status, is_mlc, mlc_id, status, version, notes, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8,
           $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
           $19::clinical."FractureSide", $20, $21::clinical."GustiloGrade", $22, $23, $24::clinical."SalterHarris",
           $25::clinical."FractureAetiology", $26, $27, $28::jsonb, $29::jsonb,
           $30, $31::jsonb, $32::timestamptz, $33, now(), $34,
           'provisional', $35, $36, 'open', 1, $37, now(), now()
         )`,
        [
          id,
          hospital,
          this.branchId(),
          body.patientId,
          body.erVisitId ?? null,
          body.admissionId ?? null,
          body.traumaInjuryId ?? null,
          body.orthoEpisodeId ?? null,
          body.boneCode,
          body.boneDisplay,
          body.aoBone ?? null,
          body.aoSegment ?? null,
          body.aoType ?? null,
          body.aoGroup ?? null,
          body.aoSubgroup ?? null,
          body.aoQualifiers,
          aoCode,
          body.aoVersion,
          body.side,
          body.isOpen,
          body.gustilo ?? null,
          body.tscherne ?? null,
          body.paediatric,
          body.salterHarris ?? null,
          body.aetiology,
          body.periprostheticClass ?? null,
          body.dislocation,
          json(body.associated),
          json(body.regionalClassification),
          body.icd10 ?? null,
          json(body.mechanism),
          body.injuryAt ?? null,
          body.injuryAtEstimated,
          this.actorId(),
          body.isMlc,
          body.mlcId ?? null,
          body.notes ?? null,
        ],
      );

      await this.snapshot(tx, id, 1, 'Registered');
      await this.addEvent(tx, id, { kind: 'diagnosed' });

      // An open fracture gets its bundle immediately, with the arrival it will
      // be measured against. Creating it later would mean the clock started
      // whenever somebody remembered.
      if (body.isOpen) {
        await tx.query(
          `INSERT INTO clinical.fx_open_bundle (id, hospital_id, fracture_id, arrived_at, created_at, updated_at)
           VALUES ($1, $2, $3, COALESCE($4::timestamptz, $5::timestamptz, now()), now(), now())`,
          [newId(), hospital, id, body.arrivedAt ?? null, body.injuryAt ?? null],
        );
      }

      await this.outbox.publish(
        tx,
        fractureEvent('fracture.registered', id, {
          fractureId: id,
          patientId: body.patientId,
          boneDisplay: body.boneDisplay,
          side: body.side,
          aoCode,
          isOpen: body.isOpen,
          gustilo: body.gustilo ?? null,
        }),
      );

      return this.loadFracture(tx, id);
    });
  }

  async updateFracture(id: string, body: UpdateFractureRequest): Promise<FractureDetailView> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM clinical.fx_fractures WHERE id = $1 AND hospital_id = $2 FOR UPDATE`,
        [id, this.hospitalId()],
      );
      const before = rows[0];
      if (before === undefined) throw AppError.notFound('That fracture does not exist.');

      // The code is re-rendered from whatever the components now are, merged
      // over what they were. Accepting a display string would let the two drift.
      const merged = {
        aoBone: body.aoBone ?? asNumberOrNull(before['ao_bone']) ?? undefined,
        aoSegment: body.aoSegment ?? asNumberOrNull(before['ao_segment']) ?? undefined,
        aoType: body.aoType ?? asTextOrNull(before['ao_type']) ?? undefined,
        aoGroup: body.aoGroup ?? asNumberOrNull(before['ao_group']) ?? undefined,
        aoSubgroup: body.aoSubgroup ?? asNumberOrNull(before['ao_subgroup']) ?? undefined,
      };
      const aoCode = this.renderAoCode(merged);
      const version = asNumber(before['version']) + 1;

      await tx.query(
        `UPDATE clinical.fx_fractures SET
           bone_code   = COALESCE($2, bone_code),
           bone_display= COALESCE($3, bone_display),
           side        = COALESCE($4::clinical."FractureSide", side),
           ao_bone     = $5, ao_segment = $6, ao_type = $7, ao_group = $8, ao_subgroup = $9, ao_code = $10,
           is_open     = COALESCE($11::boolean, is_open),
           gustilo     = COALESCE($12::clinical."GustiloGrade", gustilo),
           tscherne    = COALESCE($13, tscherne),
           paediatric  = COALESCE($14::boolean, paediatric),
           salter_harris = COALESCE($15::clinical."SalterHarris", salter_harris),
           aetiology   = COALESCE($16::clinical."FractureAetiology", aetiology),
           dislocation = COALESCE($17::boolean, dislocation),
           associated  = COALESCE($18::jsonb, associated),
           regional_classification = COALESCE($19::jsonb, regional_classification),
           icd10       = COALESCE($20, icd10),
           mechanism   = COALESCE($21::jsonb, mechanism),
           injury_at   = COALESCE($22::timestamptz, injury_at),
           notes       = COALESCE($23, notes),
           version     = $24,
           updated_at  = now()
         WHERE id = $1`,
        [
          id,
          body.boneCode ?? null,
          body.boneDisplay ?? null,
          body.side ?? null,
          merged.aoBone ?? null,
          merged.aoSegment ?? null,
          merged.aoType ?? null,
          merged.aoGroup ?? null,
          merged.aoSubgroup ?? null,
          aoCode,
          body.isOpen ?? null,
          body.gustilo ?? null,
          body.tscherne ?? null,
          body.paediatric ?? null,
          body.salterHarris ?? null,
          body.aetiology ?? null,
          body.dislocation ?? null,
          json(body.associated),
          json(body.regionalClassification),
          body.icd10 ?? null,
          json(body.mechanism),
          body.injuryAt ?? null,
          body.notes ?? null,
          version,
        ],
      );

      await this.snapshot(tx, id, version, getContext().reason ?? 'Reclassified');

      // Every interval on the timeline is derived from the injury time, so a
      // corrected injury date moves them all together rather than leaving a
      // set of weeks that no longer add up.
      if (body.injuryAt !== undefined) await this.recomputeFilmIntervals(tx, id);

      return this.loadFracture(tx, id);
    });
  }

  /** A snapshot of what the classification said, before it said something else. */
  private async snapshot(
    tx: TransactionClient,
    fractureId: string,
    version: number,
    reason: string,
  ): Promise<void> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT to_jsonb(f) AS snapshot FROM clinical.fx_fractures f WHERE f.id = $1`,
      [fractureId],
    );
    await tx.query(
      `INSERT INTO clinical.fx_versions (id, hospital_id, fracture_id, version, snapshot, changed_by, changed_at, reason)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, now(), $7)`,
      [
        newId(),
        this.hospitalId(),
        fractureId,
        version,
        JSON.stringify(rows[0]?.['snapshot'] ?? {}),
        this.actorId(),
        reason,
      ],
    );
  }

  async confirm(id: string, body: ConfirmRequest): Promise<FractureDetailView> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.fx_fractures
            SET classification_status = 'confirmed'::clinical."ClassificationStatus",
                confirmed_by = $2, confirmed_at = now(), cosign_required = $3, updated_at = now()
          WHERE id = $1 AND hospital_id = $4 AND classification_status = 'provisional'
          RETURNING *`,
        [id, this.actorId(), body.cosignRequired, this.hospitalId()],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict('That fracture is already confirmed, or does not exist.');
      }

      await this.audit.write(tx, {
        // `sign`, because that is what the audit vocabulary calls putting a
        // clinician's name to a finding. Confirming an AO code is exactly that.
        action: 'sign',
        entity: 'fracture',
        rowId: id,
        businessKey: asText(row['ao_code'] ?? row['bone_display']),
        dataClass: 'phi',
        before: { classificationStatus: 'provisional' },
        after: { classificationStatus: 'confirmed', aoCode: asTextOrNull(row['ao_code']) },
      });

      await this.outbox.publish(
        tx,
        fractureEvent('fracture.classification.confirmed', id, {
          fractureId: id,
          aoCode: asText(row['ao_code']),
          confirmedBy: this.actorId(),
          cosignRequired: body.cosignRequired,
        }),
      );

      return this.loadFracture(tx, id);
    });
  }

  async setPlan(id: string, body: PlanRequest): Promise<FractureDetailView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();
      const { rows: seq } = await tx.query<Record<string, unknown>>(
        `SELECT COALESCE(max(version), 0) + 1 AS next FROM clinical.fx_plans WHERE fracture_id = $1`,
        [id],
      );
      const version = asNumber(seq[0]?.['next'] ?? 1);

      await tx.query(`UPDATE clinical.fx_plans SET is_current = false WHERE fracture_id = $1`, [id]);

      const planId = newId();
      await tx.query(
        `INSERT INTO clinical.fx_plans (
           id, hospital_id, fracture_id, version, intent, damage_control, urgency, side,
           planned_procedure_code, planned_implant_family, planned_date,
           weight_bearing, pwb_pct, wb_review_date, rom_restrictions, dvt_prophylaxis, consent_doc_ref,
           is_current, set_by, set_at
         ) VALUES (
           $1, $2, $3, $4, $5::clinical."TreatmentIntent", $6, $7, $8::clinical."FractureSide",
           $9, $10, $11::timestamptz,
           $12::clinical."WeightBearing", $13, $14::date, $15, $16, $17,
           true, $18, now()
         )`,
        [
          planId,
          hospital,
          id,
          version,
          body.intent,
          body.damageControl,
          body.urgency,
          body.side,
          body.plannedProcedureCode ?? null,
          body.plannedImplantFamily ?? null,
          body.plannedDate ?? null,
          body.weightBearing,
          body.pwbPct ?? null,
          body.wbReviewDate ?? null,
          body.romRestrictions ?? null,
          body.dvtProphylaxis,
          body.consentDocRef ?? null,
          this.actorId(),
        ],
      );

      await this.outbox.publish(
        tx,
        fractureEvent('fracture.plan.set', planId, {
          fractureId: id,
          planId,
          intent: body.intent,
          side: body.side,
          weightBearing: body.weightBearing,
          urgency: body.urgency,
        }),
      );

      return this.loadFracture(tx, id);
    });
  }

  async recordEvent(id: string, body: FractureEventRequest): Promise<FractureDetailView> {
    return this.guard(async (tx) => {
      await this.addEvent(tx, id, body);
      return this.loadFracture(tx, id);
    });
  }

  private async addEvent(
    tx: TransactionClient,
    fractureId: string,
    body: FractureEventRequest,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO clinical.fx_events (id, hospital_id, fracture_id, kind, at, by_id, ref_type, ref_id, details, created_at)
       VALUES ($1, $2, $3, $4::clinical."FractureEventKind", COALESCE($5::timestamptz, now()), $6, $7, $8, $9::jsonb, now())`,
      [
        newId(),
        this.hospitalId(),
        fractureId,
        body.kind,
        body.at ?? null,
        this.actorId(),
        body.refType ?? null,
        body.refId ?? null,
        json(body.details),
      ],
    );
  }

  async attachFilm(id: string, body: FilmRequest): Promise<FractureDetailView> {
    return this.guard(async (tx) => {
      const filmId = newId();
      await tx.query(
        `INSERT INTO clinical.fx_xray_timeline
           (id, hospital_id, fracture_id, study_uid, study_id, label, taken_at, auto_attached, attached_by, is_key_image, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8, $9, $10, now())`,
        [
          filmId,
          this.hospitalId(),
          id,
          body.studyUid ?? null,
          body.studyId ?? null,
          body.label,
          body.takenAt,
          body.autoAttached,
          body.autoAttached ? null : this.actorId(),
          body.isKeyImage,
        ],
      );
      await this.recomputeFilmIntervals(tx, id);
      await this.addEvent(tx, id, { kind: 'imaging', at: body.takenAt, refType: 'film', refId: filmId });
      return this.loadFracture(tx, id);
    });
  }

  /**
   * Recompute every film's interval from the injury and the last surgery.
   *
   * Stored rather than computed on read because the registry exports them, and
   * recomputed wholesale rather than incrementally because a corrected injury
   * date has to move all of them at once — a timeline where three films agree
   * and one does not is worse than one that is uniformly wrong.
   */
  private async recomputeFilmIntervals(tx: TransactionClient, fractureId: string): Promise<void> {
    await tx.query(
      `UPDATE clinical.fx_xray_timeline t
          SET weeks_since_injury = CASE
                WHEN f.injury_at IS NULL THEN NULL
                ELSE round((EXTRACT(EPOCH FROM (t.taken_at - f.injury_at)) / 604800)::numeric, 1)
              END,
              weeks_since_surgery = CASE
                WHEN s.surgery_at IS NULL THEN NULL
                ELSE round((EXTRACT(EPOCH FROM (t.taken_at - s.surgery_at)) / 604800)::numeric, 1)
              END
         FROM clinical.fx_fractures f
         LEFT JOIN LATERAL (
           SELECT max(e.at) AS surgery_at FROM clinical.fx_events e
            WHERE e.fracture_id = f.id AND e.kind = 'surgery'
         ) s ON true
        WHERE t.fracture_id = $1 AND f.id = t.fracture_id`,
      [fractureId],
    );
  }

  async recordFinding(id: string, body: FindingRequest): Promise<FractureDetailView> {
    return this.guard(async (tx) => {
      await tx.query(
        `INSERT INTO clinical.fx_imaging_findings (
           id, hospital_id, fracture_id, film_id, assessed_by, assessed_at,
           angulation_deg, translation_pct, shortening_mm, rotation_deg,
           rust_score, mrust_score, alignment_maintained, implant_status, joint_congruity,
           union_status, notes
         ) VALUES (
           $1, $2, $3, $4, $5, now(),
           $6, $7, $8, $9,
           $10, $11, $12, $13, $14,
           $15::clinical."UnionStatus", $16
         )`,
        [
          newId(),
          this.hospitalId(),
          id,
          body.filmId,
          this.actorId(),
          body.angulationDeg ?? null,
          body.translationPct ?? null,
          body.shorteningMm ?? null,
          body.rotationDeg ?? null,
          body.rustScore ?? null,
          body.mrustScore ?? null,
          body.alignmentMaintained ?? null,
          body.implantStatus ?? null,
          body.jointCongruity ?? null,
          body.unionStatus,
          body.notes ?? null,
        ],
      );
      return this.loadFracture(tx, id);
    });
  }

  /**
   * Declare union, or non-union.
   *
   * Union wants a film that says so — or a stated clinical reason, because a
   * clinically united fracture in a patient who cannot come back for imaging is
   * a real and common thing. Non-union before six months wants grounds, because
   * it converts a fracture that might have healed into an operation.
   */
  async declareUnion(id: string, body: UnionRequest): Promise<FractureDetailView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT injury_at, bone_display FROM clinical.fx_fractures WHERE id = $1 AND hospital_id = $2`,
        [id, hospital],
      );
      const fracture = rows[0];
      if (fracture === undefined) throw AppError.notFound('That fracture does not exist.');

      const at = body.at ?? new Date().toISOString();
      const weeks = weeksBetween(fracture['injury_at'], at);

      if (body.outcome === 'united') {
        const { rows: films } = await tx.query<Record<string, unknown>>(
          `SELECT count(*) AS n FROM clinical.fx_imaging_findings
            WHERE fracture_id = $1 AND union_status = 'united'`,
          [id],
        );
        if (asNumber(films[0]?.['n'] ?? 0) === 0 && body.clinicalJustification === undefined) {
          throw AppError.conflict(
            'No film on this fracture reports union. Record one, or state the clinical grounds — a union declared with neither is a discharge nobody can defend if it refractures.',
          );
        }
      }

      let overrideReason: string | null = null;
      if (body.outcome === 'nonunion' && weeks !== null && Number(weeks) < NONUNION_WEEKS) {
        overrideReason = this.reason(
          `Declaring non-union at ${weeks} weeks, before the six-month definition`,
        );
      }

      await tx.query(
        `UPDATE clinical.fx_fractures
            SET status = CASE WHEN $2 = 'united' THEN 'united'::clinical."FractureStatus" ELSE status END,
                union_at = CASE WHEN $2 = 'united' THEN $3::timestamptz ELSE union_at END,
                time_to_union_weeks = CASE WHEN $2 = 'united' THEN $4::numeric ELSE time_to_union_weeks END,
                nonunion_override_by = COALESCE($5, nonunion_override_by),
                nonunion_override_reason = COALESCE($6, nonunion_override_reason),
                updated_at = now()
          WHERE id = $1`,
        [id, body.outcome, at, weeks, overrideReason === null ? null : this.actorId(), overrideReason],
      );

      await this.addEvent(tx, id, {
        kind: body.outcome === 'united' ? 'union' : 'complication',
        at,
        details: { outcome: body.outcome, weeks, overrideReason },
      });

      if (body.outcome === 'nonunion') {
        await tx.query(
          `INSERT INTO clinical.fx_complications
             (id, hospital_id, fracture_id, kind, onset_at, detected_by, severity, created_at)
           VALUES ($1, $2, $3, 'nonunion', $4::timestamptz, $5, 'severe', now())`,
          [newId(), hospital, id, at, this.actorId()],
        );
      }

      await this.outbox.publish(
        tx,
        fractureEvent('fracture.union.declared', id, {
          fractureId: id,
          status: body.outcome,
          timeToUnionWeeks: weeks,
          overrideReason,
        }),
      );

      return this.loadFracture(tx, id);
    });
  }

  async recordComplication(id: string, body: ComplicationRequest): Promise<FractureDetailView> {
    return this.guard(async (tx) => {
      await tx.query(
        `INSERT INTO clinical.fx_complications
           (id, hospital_id, fracture_id, kind, onset_at, detected_by, severity, clavien_dindo, management, notes, created_at)
         VALUES ($1, $2, $3, $4::clinical."FractureComplicationKind", $5::timestamptz, $6, $7, $8, $9, $10, now())`,
        [
          newId(),
          this.hospitalId(),
          id,
          body.kind,
          body.onsetAt,
          this.actorId(),
          body.severity,
          body.clavienDindo ?? null,
          body.management ?? null,
          body.notes ?? null,
        ],
      );
      await this.addEvent(tx, id, { kind: 'complication', at: body.onsetAt, details: { kind: body.kind } });
      return this.loadFracture(tx, id);
    });
  }

  /**
   * Record the open-fracture bundle.
   *
   * The breaches are recomputed by the database on write, so what comes back is
   * what will be reported — this service does not get a say in whether the hour
   * was met.
   */
  async recordBundle(id: string, body: BundleRequest): Promise<FractureDetailView> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.fx_open_bundle SET
           antibiotic_at        = COALESCE($2::timestamptz, antibiotic_at),
           tetanus_at           = COALESCE($3::timestamptz, tetanus_at),
           photo_at             = COALESCE($4::timestamptz, photo_at),
           dressing_at          = COALESCE($5::timestamptz, dressing_at),
           splint_at            = COALESCE($6::timestamptz, splint_at),
           debridement_at       = COALESCE($7::timestamptz, debridement_at),
           plastics_referral_at = COALESCE($8::timestamptz, plastics_referral_at),
           definitive_cover_at  = COALESCE($9::timestamptz, definitive_cover_at),
           updated_at           = now()
         WHERE fracture_id = $1 AND hospital_id = $10
         RETURNING *`,
        [
          id,
          body.antibioticAt ?? null,
          body.tetanusAt ?? null,
          body.photoAt ?? null,
          body.dressingAt ?? null,
          body.splintAt ?? null,
          body.debridementAt ?? null,
          body.plasticsReferralAt ?? null,
          body.definitiveCoverAt ?? null,
          this.hospitalId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict('That fracture has no open-fracture bundle. It is recorded as closed.');
      }

      const breaches = asStringArray(row['breaches']);
      if (breaches.length > 0) {
        const { rows: fr } = await tx.query<Record<string, unknown>>(
          `SELECT gustilo::text AS gustilo FROM clinical.fx_fractures WHERE id = $1`,
          [id],
        );
        const antibioticAt = asTextOrNull(row['antibiotic_at']);
        await this.outbox.publish(
          tx,
          fractureEvent('fracture.open.bundle_breached', id, {
            fractureId: id,
            gustilo: asTextOrNull(fr[0]?.['gustilo']),
            breaches,
            minutesToAntibiotic:
              antibioticAt === null
                ? null
                : Math.round(
                    (new Date(antibioticAt).getTime() - new Date(asText(row['arrived_at'])).getTime()) /
                      60_000,
                  ),
          }),
        );
      }

      return this.loadFracture(tx, id);
    });
  }

  async registry(query: RegistryQuery): Promise<Page<FractureView>> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM clinical.fx_fractures
          WHERE hospital_id = $1 AND branch_id = $2
            AND ($3::uuid IS NULL OR patient_id = $3)
            AND ($4::text IS NULL OR status::text = $4)
            AND (NOT $5::boolean OR is_open)
            AND (NOT $6::boolean OR classification_status = 'confirmed')
          ORDER BY diagnosed_at DESC
          LIMIT $7`,
        [
          this.hospitalId(),
          this.branchId(),
          query.patientId ?? null,
          query.status ?? null,
          query.openOnly,
          query.confirmedOnly,
          query.limit,
        ],
      );
      return { items: rows.map((r) => this.toFracture(r)), nextCursor: null, hasMore: false };
    });
  }

  async getFracture(id: string): Promise<FractureDetailView> {
    return this.guard((tx) => this.loadFracture(tx, id));
  }

  private async loadFracture(tx: TransactionClient, id: string): Promise<FractureDetailView> {
    const hospital = this.hospitalId();
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM clinical.fx_fractures WHERE id = $1 AND hospital_id = $2`,
      [id, hospital],
    );
    const row = rows[0];
    if (row === undefined) throw AppError.notFound('That fracture does not exist.');

    const [{ rows: plans }, { rows: events }, { rows: films }, { rows: comps }, { rows: bundles }] =
      await Promise.all([
        tx.query<Record<string, unknown>>(
          `SELECT * FROM clinical.fx_plans WHERE fracture_id = $1 ORDER BY version DESC`,
          [id],
        ),
        tx.query<Record<string, unknown>>(
          `SELECT * FROM clinical.fx_events WHERE fracture_id = $1 ORDER BY at`,
          [id],
        ),
        tx.query<Record<string, unknown>>(
          `SELECT * FROM clinical.fx_xray_timeline WHERE fracture_id = $1 ORDER BY taken_at`,
          [id],
        ),
        tx.query<Record<string, unknown>>(
          `SELECT * FROM clinical.fx_complications WHERE fracture_id = $1 ORDER BY onset_at DESC`,
          [id],
        ),
        tx.query<Record<string, unknown>>(`SELECT * FROM clinical.fx_open_bundle WHERE fracture_id = $1`, [
          id,
        ]),
      ]);

    const { rows: findings } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM clinical.fx_imaging_findings WHERE fracture_id = $1 ORDER BY assessed_at`,
      [id],
    );

    const injuryAt = asTextOrNull(row['injury_at']);
    const bundleRow = bundles[0];

    return {
      fracture: this.toFracture(row),
      plans: plans.map((p) => ({
        id: asText(p['id']),
        version: asNumber(p['version']),
        intent: asText(p['intent']),
        side: asText(p['side']),
        damageControl: asBool(p['damage_control']),
        urgency: asText(p['urgency']),
        plannedProcedureCode: asTextOrNull(p['planned_procedure_code']),
        plannedImplantFamily: asTextOrNull(p['planned_implant_family']),
        plannedDate: asTextOrNull(p['planned_date']),
        weightBearing: asText(p['weight_bearing']),
        pwbPct: asNumberOrNull(p['pwb_pct']),
        wbReviewDate: asTextOrNull(p['wb_review_date']),
        romRestrictions: asTextOrNull(p['rom_restrictions']),
        dvtProphylaxis: asBool(p['dvt_prophylaxis']),
        isCurrent: asBool(p['is_current']),
        setAt: asText(p['set_at']),
      })),
      events: events.map((e) => ({
        id: asText(e['id']),
        kind: asText(e['kind']),
        at: asText(e['at']),
        byId: asTextOrNull(e['by_id']),
        refType: asTextOrNull(e['ref_type']),
        refId: asTextOrNull(e['ref_id']),
        details: e['details'] ?? null,
        weeksSinceInjury: weeksBetween(injuryAt, e['at']),
      })),
      films: films.map((f) => ({
        id: asText(f['id']),
        label: asText(f['label']),
        takenAt: asText(f['taken_at']),
        studyUid: asTextOrNull(f['study_uid']),
        weeksSinceInjury: asTextOrNull(f['weeks_since_injury']),
        weeksSinceSurgery: asTextOrNull(f['weeks_since_surgery']),
        autoAttached: asBool(f['auto_attached']),
        isKeyImage: asBool(f['is_key_image']),
        findings: findings
          .filter((x) => asText(x['film_id']) === asText(f['id']))
          .map((x) => ({
            id: asText(x['id']),
            filmId: asText(x['film_id']),
            assessedAt: asText(x['assessed_at']),
            angulationDeg: asTextOrNull(x['angulation_deg']),
            translationPct: asNumberOrNull(x['translation_pct']),
            shorteningMm: asNumberOrNull(x['shortening_mm']),
            rustScore: asNumberOrNull(x['rust_score']),
            mrustScore: asNumberOrNull(x['mrust_score']),
            alignmentMaintained:
              x['alignment_maintained'] === null ? null : asBool(x['alignment_maintained']),
            implantStatus: asTextOrNull(x['implant_status']),
            unionStatus: asText(x['union_status']),
            notes: asTextOrNull(x['notes']),
          })),
      })),
      complications: comps.map((c) => ({
        id: asText(c['id']),
        kind: asText(c['kind']),
        onsetAt: asText(c['onset_at']),
        severity: asText(c['severity']),
        clavienDindo: asTextOrNull(c['clavien_dindo']),
        management: asTextOrNull(c['management']),
        resolvedAt: asTextOrNull(c['resolved_at']),
      })),
      openBundle:
        bundleRow === undefined
          ? null
          : {
              arrivedAt: asText(bundleRow['arrived_at']),
              antibioticAt: asTextOrNull(bundleRow['antibiotic_at']),
              tetanusAt: asTextOrNull(bundleRow['tetanus_at']),
              debridementAt: asTextOrNull(bundleRow['debridement_at']),
              plasticsReferralAt: asTextOrNull(bundleRow['plastics_referral_at']),
              definitiveCoverAt: asTextOrNull(bundleRow['definitive_cover_at']),
              breaches: asStringArray(bundleRow['breaches']),
              minutesToAntibiotic:
                asTextOrNull(bundleRow['antibiotic_at']) === null
                  ? null
                  : Math.round(
                      (new Date(asText(bundleRow['antibiotic_at'])).getTime() -
                        new Date(asText(bundleRow['arrived_at'])).getTime()) /
                        60_000,
                    ),
            },
    };
  }

  private toFracture(row: Record<string, unknown>): FractureView {
    const injuryAt = asTextOrNull(row['injury_at']);
    const status = asText(row['status']);

    // What a registry export would reject, named rather than counted. The
    // dataset needs bone, side, a code to type level, open/closed, a mechanism,
    // an injury date, and an outcome once the record is closed.
    const gaps: string[] = [];
    if (asTextOrNull(row['ao_type']) === null) gaps.push('AO/OTA code below type level');
    if (asText(row['classification_status']) !== 'confirmed') gaps.push('classification not confirmed');
    if (injuryAt === null) gaps.push('no injury date');
    if (row['mechanism'] === null || row['mechanism'] === undefined) gaps.push('no mechanism');
    if (asBool(row['is_open']) && asTextOrNull(row['gustilo']) === null)
      gaps.push('open with no Gustilo grade');
    if (
      status !== 'open' &&
      asTextOrNull(row['union_at']) === null &&
      asTextOrNull(row['closed_reason']) === null
    ) {
      gaps.push('closed with no outcome');
    }

    return {
      id: asText(row['id']),
      patientId: asText(row['patient_id']),
      boneCode: asText(row['bone_code']),
      boneDisplay: asText(row['bone_display']),
      side: asText(row['side']),
      aoBone: asNumberOrNull(row['ao_bone']),
      aoSegment: asNumberOrNull(row['ao_segment']),
      aoType: asTextOrNull(row['ao_type']),
      aoGroup: asNumberOrNull(row['ao_group']),
      aoSubgroup: asNumberOrNull(row['ao_subgroup']),
      aoCode: asTextOrNull(row['ao_code']),
      aoVersion: asText(row['ao_version']),
      isOpen: asBool(row['is_open']),
      gustilo: asTextOrNull(row['gustilo']),
      tscherne: asTextOrNull(row['tscherne']),
      paediatric: asBool(row['paediatric']),
      salterHarris: asTextOrNull(row['salter_harris']),
      aetiology: asText(row['aetiology']),
      dislocation: asBool(row['dislocation']),
      associated: row['associated'] ?? null,
      regionalClassification: row['regional_classification'] ?? null,
      icd10: asTextOrNull(row['icd10']),
      mechanism: row['mechanism'] ?? null,
      injuryAt,
      injuryAtEstimated: asBool(row['injury_at_estimated']),
      diagnosedAt: asText(row['diagnosed_at']),
      classificationStatus: asText(row['classification_status']),
      confirmedBy: asTextOrNull(row['confirmed_by']),
      confirmedAt: asTextOrNull(row['confirmed_at']),
      cosignRequired: asBool(row['cosign_required']),
      cosignedAt: asTextOrNull(row['cosigned_at']),
      isMlc: asBool(row['is_mlc']),
      status,
      unionAt: asTextOrNull(row['union_at']),
      timeToUnionWeeks: asTextOrNull(row['time_to_union_weeks']),
      closedReason: asTextOrNull(row['closed_reason']),
      nonunionOverrideReason: asTextOrNull(row['nonunion_override_reason']),
      version: asNumber(row['version']),
      notes: asTextOrNull(row['notes']),
      weeksSinceInjury: weeksBetween(injuryAt, new Date().toISOString()),
      registryReady: gaps.length === 0,
      registryGaps: gaps,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // OP-009
  // ═══════════════════════════════════════════════════════════════════════════

  async createEpisode(body: EpisodeRequest): Promise<OrthoEpisodeView> {
    return this.guard(async (tx) => {
      const id = newId();
      await tx.query(
        `INSERT INTO clinical.ortho_episodes
           (id, hospital_id, branch_id, patient_id, encounter_id, anchor_kind, anchor_at,
            presenting_complaint, xray_first, status, opened_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8, $9, 'open', now(), now(), now())`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.patientId,
          body.encounterId ?? null,
          body.anchorKind,
          body.anchorAt,
          body.presentingComplaint ?? null,
          body.xrayFirst,
        ],
      );
      return this.loadEpisode(tx, id);
    });
  }

  async recordExam(id: string, body: ExamRequest): Promise<OrthoEpisodeView> {
    return this.guard(async (tx) => {
      await tx.query(
        `INSERT INTO clinical.ortho_exams
           (id, hospital_id, episode_id, at, by_id, rom, neurovascular, special_tests, notes, created_at)
         VALUES ($1, $2, $3, now(), $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, now())`,
        [
          newId(),
          this.hospitalId(),
          id,
          this.actorId(),
          JSON.stringify(body.rom),
          json(body.neurovascular),
          json(body.specialTests),
          body.notes ?? null,
        ],
      );
      return this.loadEpisode(tx, id);
    });
  }

  /**
   * Apply a follow-up protocol.
   *
   * Every date is the anchor plus an offset, computed in SQL from the stored
   * anchor. Computing them from "today" would mean a schedule that slides every
   * time somebody opens the protocol, and a six-week film taken at nine weeks.
   */
  async scheduleFollowups(id: string, body: FollowupRequest): Promise<OrthoEpisodeView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT anchor_at FROM clinical.ortho_episodes WHERE id = $1 AND hospital_id = $2`,
        [id, hospital],
      );
      if (rows[0] === undefined) throw AppError.notFound('That episode does not exist.');
      const anchorAt = asText(rows[0]['anchor_at']);

      for (const visit of body.visits) {
        await tx.query(
          `INSERT INTO clinical.ortho_followups
             (id, hospital_id, episode_id, fracture_id, protocol_key, label, offset_weeks, due_at, actions, status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7,
                   $8::timestamptz + make_interval(days => ($7::numeric * 7)::int),
                   $9, 'due', now(), now())
           ON CONFLICT (episode_id, protocol_key, offset_weeks) DO UPDATE SET
             label      = EXCLUDED.label,
             actions    = EXCLUDED.actions,
             due_at     = EXCLUDED.due_at,
             updated_at = now()`,
          [
            newId(),
            hospital,
            id,
            body.fractureId ?? null,
            body.protocolKey,
            visit.label,
            visit.offsetWeeks,
            anchorAt,
            visit.actions,
          ],
        );
      }

      await this.outbox.publish(
        tx,
        fractureEvent('ortho.followups.scheduled', id, {
          episodeId: id,
          protocolKey: body.protocolKey,
          anchorAt,
          visitCount: body.visits.length,
        }),
      );

      return this.loadEpisode(tx, id);
    });
  }

  /**
   * Record a PROM.
   *
   * The maximum and the direction come from the instrument, not the caller. A
   * DASH recorded as higher-is-better turns a deteriorating patient into an
   * improving line, and that is the one charting error nobody catches by eye.
   */
  async recordProm(id: string, body: PromRequest): Promise<OrthoEpisodeView> {
    return this.guard(async (tx) => {
      const SCALES: Readonly<Record<string, { readonly max: number; readonly higherIsBetter: boolean }>> = {
        oxford_hip: { max: 48, higherIsBetter: true },
        oxford_knee: { max: 48, higherIsBetter: true },
        harris_hip: { max: 100, higherIsBetter: true },
        eq5d: { max: 100, higherIsBetter: true },
        dash: { max: 100, higherIsBetter: false },
        vas_pain: { max: 10, higherIsBetter: false },
      };
      const scale = SCALES[body.instrument];
      if (scale === undefined) throw AppError.conflict('That instrument is not one this module scores.');

      await tx.query(
        `INSERT INTO clinical.ortho_proms
           (id, hospital_id, episode_id, fracture_id, instrument, at_weeks, responses, score, score_max,
            higher_is_better, collected_at, collected_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, now(), $11)`,
        [
          newId(),
          this.hospitalId(),
          id,
          body.fractureId ?? null,
          body.instrument,
          body.atWeeks,
          JSON.stringify(body.responses),
          body.score ?? null,
          scale.max,
          scale.higherIsBetter,
          this.actorId(),
        ],
      );
      return this.loadEpisode(tx, id);
    });
  }

  async getEpisode(id: string): Promise<OrthoEpisodeView> {
    return this.guard((tx) => this.loadEpisode(tx, id));
  }

  private async loadEpisode(tx: TransactionClient, id: string): Promise<OrthoEpisodeView> {
    const hospital = this.hospitalId();
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM clinical.ortho_episodes WHERE id = $1 AND hospital_id = $2`,
      [id, hospital],
    );
    const row = rows[0];
    if (row === undefined) throw AppError.notFound('That episode does not exist.');

    const [{ rows: exams }, { rows: followups }, { rows: proms }] = await Promise.all([
      tx.query<Record<string, unknown>>(
        `SELECT * FROM clinical.ortho_exams WHERE episode_id = $1 ORDER BY at DESC`,
        [id],
      ),
      tx.query<Record<string, unknown>>(
        `SELECT * FROM clinical.ortho_followups WHERE episode_id = $1 ORDER BY offset_weeks`,
        [id],
      ),
      tx.query<Record<string, unknown>>(
        `SELECT * FROM clinical.ortho_proms WHERE episode_id = $1 ORDER BY instrument, at_weeks`,
        [id],
      ),
    ]);

    const now = Date.now();
    return {
      id,
      patientId: asText(row['patient_id']),
      anchorKind: asText(row['anchor_kind']),
      anchorAt: asText(row['anchor_at']),
      presentingComplaint: asTextOrNull(row['presenting_complaint']),
      xrayFirst: asBool(row['xray_first']),
      status: asText(row['status']),
      openedAt: asText(row['opened_at']),
      exams: exams.map((e) => ({
        id: asText(e['id']),
        at: asText(e['at']),
        rom: e['rom'] ?? [],
        neurovascular: e['neurovascular'] ?? null,
        specialTests: e['special_tests'] ?? null,
        notes: asTextOrNull(e['notes']),
      })),
      followups: followups.map((f) => ({
        id: asText(f['id']),
        protocolKey: asText(f['protocol_key']),
        label: asText(f['label']),
        offsetWeeks: asText(f['offset_weeks']),
        dueAt: asText(f['due_at']),
        actions: asStringArray(f['actions']),
        status: asText(f['status']),
        completedAt: asTextOrNull(f['completed_at']),
        daysUntilDue: Math.round((new Date(asText(f['due_at'])).getTime() - now) / 86_400_000),
      })),
      proms: proms.map((p) => ({
        id: asText(p['id']),
        instrument: asText(p['instrument']),
        atWeeks: asText(p['at_weeks']),
        score: asTextOrNull(p['score']),
        scoreMax: asTextOrNull(p['score_max']),
        higherIsBetter: asBool(p['higher_is_better']),
        collectedAt: asText(p['collected_at']),
      })),
    };
  }
}
