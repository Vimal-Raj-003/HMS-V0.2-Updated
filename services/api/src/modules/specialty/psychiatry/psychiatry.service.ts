import { Injectable } from '@nestjs/common';
import { newId } from '@vims/contracts';
import type { TransactionClient } from '../../../core/db/database.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { consoleEvent } from '../consoles/consoles.events.js';
import {
  ConsoleSupport,
  asBoolOrNull,
  asJson,
  asNumber,
  asNumberOrNull,
  asText,
  asTextOrNull,
} from '../consoles/consoles.support.js';
import type {
  AdmissionRequest,
  CapacityRequest,
  DischargeRequest,
  EctCourseRequest,
  EctSessionRequest,
  EpisodeQuery,
  EpisodeRequest,
  InstrumentRequest,
  IntimationRequest,
  ObservationRequest,
  RestraintCloseRequest,
  RestraintQuery,
  RestraintRequest,
  RevokeRequest,
  ScaleRequest,
} from './psychiatry.schemas.js';
import type {
  AdmissionRow,
  CapacityRow,
  EctCourseRow,
  EctSessionRow,
  EpisodeDetail,
  InstrumentRow,
  PsyEpisodeRow,
  RestraintRow,
  ScaleRow,
} from './psychiatry.types.js';

/** How long before an authority lapses the ward should already know. */
const AUTHORITY_WARNING_HOURS = 72;

/**
 * OP-032 — psychiatry and mental health.
 *
 * ── Nothing here decides capacity or sets an expiry ────────────────────────
 *
 * The verdict follows from the four limbs, and every clock follows from the
 * section. A service that also computed them would be a second author of the
 * findings that make a detention lawful.
 *
 * ── What it does is count down ─────────────────────────────────────────────
 *
 * `hoursLeftOfAuthority` and `capacityCurrent` are the same arithmetic read
 * forwards. The thing they prevent is not a refused write; it is a person held
 * past a date nobody was watching.
 */
@Injectable()
export class PsychiatryService extends ConsoleSupport {
  // ── The episode ───────────────────────────────────────────────────────────

  async openEpisode(body: EpisodeRequest): Promise<PsyEpisodeRow> {
    return this.guard(async (tx) => {
      const id = newId();
      await tx.query(
        `INSERT INTO specialty.psy_episodes
           (id, hospital_id, branch_id, patient_id, opened_at, primary_dx_icd10, dx_history,
            risk_level, lead_clinician_id, care_team, sensitivity, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,coalesce($5::timestamptz, now()),$6,$7::jsonb,
                 $8::specialty."PsyRiskLevel",$9,$10::uuid[],$11,$12,now(),now())`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.patientId,
          body.openedAt ?? null,
          body.primaryDxIcd10 ?? null,
          JSON.stringify(body.dxHistory),
          body.riskLevel,
          body.leadClinicianId,
          body.careTeam,
          body.sensitivity,
          this.actorId(),
        ],
      );
      return this.episodeWithin(tx, id);
    });
  }

  async listEpisodes(query: EpisodeQuery): Promise<readonly PsyEpisodeRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `${EPISODE_SELECT}
          WHERE e.hospital_id = $1
            AND ($2::uuid IS NULL OR e.patient_id = $2::uuid)
            AND ($3::boolean IS NOT TRUE OR e.status = 'active')
            AND ($4::boolean IS NOT TRUE OR e.risk_level = 'high')
            AND ($5::boolean IS NOT TRUE
                 OR (adm.authority_expires_at IS NOT NULL
                     AND adm.authority_expires_at < now() + make_interval(hours => $6)))
          ORDER BY adm.authority_expires_at NULLS LAST, e.opened_at DESC
          LIMIT $7`,
        [
          this.hospitalId(),
          query.patientId ?? null,
          query.activeOnly,
          query.highRiskOnly,
          query.authorityExpiringOnly,
          AUTHORITY_WARNING_HOURS,
          query.limit,
        ],
      );
      return rows.map((r) => this.toEpisode(r));
    });
  }

  async episodeDetail(id: string): Promise<EpisodeDetail> {
    return this.guard(async (tx) => {
      const episode = await this.episodeWithin(tx, id);
      const [caps, instruments, admissions, scales] = await Promise.all([
        tx.query<Record<string, unknown>>(
          `${CAPACITY_SELECT} WHERE c.episode_id = $1 ORDER BY c.assessed_at DESC LIMIT 30`,
          [id],
        ),
        tx.query<Record<string, unknown>>(
          `SELECT * FROM specialty.mhca_instruments WHERE patient_id = $1 ORDER BY made_at DESC`,
          [episode.patientId],
        ),
        tx.query<Record<string, unknown>>(
          `${ADMISSION_SELECT} WHERE a.episode_id = $1 ORDER BY a.admitted_at DESC`,
          [id],
        ),
        tx.query<Record<string, unknown>>(
          `SELECT * FROM specialty.psy_scales WHERE episode_id = $1
            ORDER BY recorded_at DESC LIMIT 50`,
          [id],
        ),
      ]);
      return {
        episode,
        capacities: caps.rows.map((r) => this.toCapacity(r)),
        instruments: instruments.rows.map((r) => this.toInstrument(r)),
        admissions: admissions.rows.map((r) => this.toAdmission(r)),
        scales: scales.rows.map((r) => this.toScale(r)),
      };
    });
  }

  // ── Scales ────────────────────────────────────────────────────────────────

  async recordScale(body: ScaleRequest): Promise<ScaleRow> {
    return this.guard(async (tx) => {
      // `total`, `severity_band` and `item9_flag` are absent: a total somebody
      // adds up at the end of a clinic is a total that gets rounded towards the
      // answer they expected.
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.psy_scales
           (id, hospital_id, episode_id, patient_id, scale, items, completed_by,
            recorded_at, recorded_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,coalesce($8::timestamptz, now()),$9,now(),now())
         RETURNING *`,
        [
          newId(),
          this.hospitalId(),
          body.episodeId ?? null,
          body.patientId,
          body.scale,
          JSON.stringify(body.items),
          body.completedBy,
          body.recordedAt ?? null,
          this.actorId(),
        ],
      );
      const scale = this.toScale(this.one(rows));

      // The person who filled the form in is often alone in a waiting room.
      if (scale.item9Flag || (scale.scale === 'cssrs' && (scale.total ?? 0) >= 4)) {
        await this.outbox.publish(
          tx,
          consoleEvent('psy.risk.flagged', scale.id, {
            scaleId: scale.id,
            patientId: body.patientId,
            episodeId: body.episodeId ?? null,
            scale: scale.scale,
            total: scale.total === null ? null : String(scale.total),
            severityBand: scale.severityBand,
          }),
        );
      }

      return scale;
    });
  }

  // ── Capacity ──────────────────────────────────────────────────────────────

  async assessCapacity(body: CapacityRequest): Promise<CapacityRow> {
    return this.guard(async (tx) => {
      // `has_capacity` and `valid_until` are absent. A clinician who could type
      // the verdict has decided before applying the test.
      const { rows } = await tx.query<Record<string, unknown>>(
        `WITH ins AS (
           INSERT INTO specialty.psy_capacity_assessments
             (id, hospital_id, episode_id, patient_id, assessed_at, assessed_by,
              understands, retains, weighs, communicates, decision_scope, rationale,
              created_at, updated_at)
           VALUES ($1,$2,$3,$4,now(),$5,$6,$7,$8,$9,$10,$11,now(),now())
           RETURNING id)
         SELECT 1`,
        [
          newId(),
          this.hospitalId(),
          body.episodeId,
          body.patientId,
          this.actorId(),
          body.understands,
          body.retains,
          body.weighs,
          body.communicates,
          body.decisionScope,
          body.rationale,
        ],
      );
      void rows;

      const { rows: latest } = await tx.query<Record<string, unknown>>(
        `${CAPACITY_SELECT} WHERE c.episode_id = $1 ORDER BY c.assessed_at DESC LIMIT 1`,
        [body.episodeId],
      );
      const assessment = this.toCapacity(this.one(latest));

      await this.audit.write(tx, {
        action: 'sign',
        entity: 'psy_capacity_assessment',
        rowId: assessment.id,
        businessKey: body.decisionScope,
        dataClass: 'phi',
        patientId: body.patientId,
        encounterId: null,
        reasonText: body.rationale,
        before: null,
        after: { hasCapacity: assessment.hasCapacity, validUntil: assessment.validUntil },
      });

      return assessment;
    });
  }

  // ── Instruments ───────────────────────────────────────────────────────────

  async recordInstrument(body: InstrumentRequest): Promise<InstrumentRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.mhca_instruments
           (id, hospital_id, patient_id, kind, content, made_at, valid_from, witnessed_by,
            document_id, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6::timestamptz,$7::date,$8::jsonb,$9,$10,now(),now())
         RETURNING *`,
        [
          newId(),
          this.hospitalId(),
          body.patientId,
          body.kind,
          JSON.stringify(body.content),
          body.madeAt,
          body.validFrom,
          JSON.stringify(body.witnessedBy),
          body.documentId ?? null,
          this.actorId(),
        ],
      );
      const instrument = this.toInstrument(this.one(rows));

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'mhca_instrument',
        rowId: instrument.id,
        businessKey: body.kind,
        dataClass: 'phi',
        patientId: body.patientId,
        encounterId: null,
        reasonText: body.reason,
        before: null,
        after: { kind: body.kind, validFrom: body.validFrom },
      });

      return instrument;
    });
  }

  /** Only the Review Board can set one aside. Never a delete. */
  async revokeInstrument(id: string, body: RevokeRequest): Promise<InstrumentRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE specialty.mhca_instruments
            SET revoked_at = now(), revoked_reason = $2, mhrb_ref = coalesce($3, mhrb_ref),
                updated_at = now()
          WHERE id = $1 AND hospital_id = $4
          RETURNING *`,
        [id, body.reason, body.mhrbRef ?? null, this.hospitalId()],
      );
      const instrument = this.toInstrument(this.one(rows));

      await this.audit.write(tx, {
        action: 'override',
        entity: 'mhca_instrument',
        rowId: id,
        businessKey: instrument.kind,
        dataClass: 'phi',
        patientId: instrument.patientId,
        encounterId: null,
        reasonText: body.reason,
        before: null,
        after: { revoked: true, mhrbRef: body.mhrbRef ?? null },
      });

      return instrument;
    });
  }

  // ── Admission under the Act ───────────────────────────────────────────────

  async admit(body: AdmissionRequest): Promise<AdmissionRow> {
    return this.guard(async (tx) => {
      const id = newId();
      // `authority_expires_at` and `mhrb_intimation_due_at` are absent: a date
      // somebody types is a date somebody can extend.
      await tx.query(
        `INSERT INTO specialty.mhca_admissions
           (id, hospital_id, branch_id, episode_id, patient_id, admission_id, admission_type,
            admitted_at, capacity_assessment_id, nr_instrument_id, mhrb_ref,
            created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::specialty."MhcaAdmissionType",
                 coalesce($8::timestamptz, now()),$9,$10,$11,$12,now(),now())`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.episodeId,
          body.patientId,
          body.admissionId ?? null,
          body.admissionType,
          body.admittedAt ?? null,
          body.capacityAssessmentId ?? null,
          body.nrInstrumentId ?? null,
          body.mhrbRef ?? null,
          this.actorId(),
        ],
      );
      const admission = await this.admissionWithin(tx, id);

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'mhca_admission',
        rowId: id,
        businessKey: body.admissionType,
        dataClass: 'phi',
        patientId: body.patientId,
        encounterId: null,
        reasonText: body.reason,
        before: null,
        after: {
          admissionType: body.admissionType,
          authorityExpiresAt: admission.authorityExpiresAt,
        },
      });

      // The person who files the Board intimation is medical records, not the
      // psychiatrist who admitted.
      if (admission.mhrbIntimationDueAt !== null) {
        await this.outbox.publish(
          tx,
          consoleEvent('psy.mhrb.intimation_due', id, {
            admissionId: id,
            patientId: body.patientId,
            admissionType: body.admissionType,
            dueAt: admission.mhrbIntimationDueAt,
          }),
        );
      }

      return admission;
    });
  }

  async recordIntimation(id: string, body: IntimationRequest): Promise<AdmissionRow> {
    return this.guard(async (tx) => {
      await tx.query(
        `UPDATE specialty.mhca_admissions
            SET mhrb_intimated_at = now(), mhrb_ref = $2, updated_at = now()
          WHERE id = $1 AND hospital_id = $3`,
        [id, body.mhrbRef, this.hospitalId()],
      );
      return this.admissionWithin(tx, id);
    });
  }

  async discharge(id: string, body: DischargeRequest): Promise<AdmissionRow> {
    return this.guard(async (tx) => {
      await tx.query(
        `UPDATE specialty.mhca_admissions
            SET discharged_at = now(), outcome = $2, updated_at = now()
          WHERE id = $1 AND hospital_id = $3`,
        [id, body.outcome, this.hospitalId()],
      );
      return this.admissionWithin(tx, id);
    });
  }

  // ── Restraint ─────────────────────────────────────────────────────────────

  /**
   * Ordering. The psychiatrist who calls it is the one signed in, so the order
   * has a name from the moment it exists rather than a ratification later.
   */
  async orderRestraint(body: RestraintRequest): Promise<RestraintRow> {
    return this.guard(async (tx) => {
      const id = newId();
      await tx.query(
        `INSERT INTO specialty.psy_restraint_events
           (id, hospital_id, admission_id, kind, started_at, reason, ordered_by, ordered_at,
            created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4::specialty."RestraintType",coalesce($5::timestamptz, now()),
                 $6,$7,now(),$8,now(),now())`,
        [
          id,
          this.hospitalId(),
          body.admissionId,
          body.kind,
          body.startedAt ?? null,
          body.reason,
          this.actorId(),
          this.actorId(),
        ],
      );
      const restraint = await this.restraintWithin(tx, id);

      await this.audit.write(tx, {
        action: 'override',
        entity: 'psy_restraint_event',
        rowId: id,
        businessKey: body.kind,
        dataClass: 'phi',
        patientId: null,
        encounterId: null,
        reasonText: body.reason,
        before: null,
        after: { kind: body.kind, startedAt: restraint.startedAt },
      });

      return restraint;
    });
  }

  async observe(id: string, body: ObservationRequest): Promise<RestraintRow> {
    return this.guard(async (tx) => {
      await tx.query(
        `UPDATE specialty.psy_restraint_events
            SET monitoring = monitoring || jsonb_build_array(
                  jsonb_build_object('at', coalesce($2::timestamptz, now()),
                                     'state', $3::text, 'by', $4::uuid)),
                updated_at = now()
          WHERE id = $1 AND hospital_id = $5`,
        [id, body.at ?? null, body.state, this.actorId(), this.hospitalId()],
      );
      return this.restraintWithin(tx, id);
    });
  }

  async closeRestraint(id: string, body: RestraintCloseRequest): Promise<RestraintRow> {
    return this.guard(async (tx) => {
      await tx.query(
        `UPDATE specialty.psy_restraint_events
            SET ended_at = now(),
                nr_informed_at = coalesce($2::timestamptz, nr_informed_at, now()),
                updated_at = now()
          WHERE id = $1 AND hospital_id = $3`,
        [id, body.nrInformedAt ?? null, this.hospitalId()],
      );
      const restraint = await this.restraintWithin(tx, id);

      // Feeds the monthly return to the Board, which is statutory rather than
      // an audit convenience.
      await this.outbox.publish(
        tx,
        consoleEvent('psy.restraint.recorded', id, {
          restraintId: id,
          admissionId: restraint.admissionId,
          kind: restraint.kind,
          startedAt: restraint.startedAt,
          durationMin: restraint.durationMin,
          reason: restraint.reason,
        }),
      );

      return restraint;
    });
  }

  async listRestraints(query: RestraintQuery): Promise<readonly RestraintRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `${RESTRAINT_SELECT}
          WHERE r.hospital_id = $1
            AND ($2::text IS NULL OR to_char(r.started_at, 'YYYY-MM') = $2::text)
            AND ($3::boolean IS NOT TRUE OR r.ended_at IS NULL)
          ORDER BY r.started_at DESC
          LIMIT $4`,
        [this.hospitalId(), query.month ?? null, query.openOnly, query.limit],
      );
      return rows.map((r) => this.toRestraint(r));
    });
  }

  // ── Electroconvulsive therapy ─────────────────────────────────────────────

  async openEctCourse(body: EctCourseRequest): Promise<EctCourseRow> {
    return this.guard(async (tx) => {
      const id = newId();
      await tx.query(
        `INSERT INTO specialty.psy_ect_courses
           (id, hospital_id, episode_id, patient_id, indication, consent_id, nr_consent_id,
            capacity_assessment_id, minor, mhrb_permission_ref, max_sessions, started_at,
            created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now(),$12,now(),now())`,
        [
          id,
          this.hospitalId(),
          body.episodeId,
          body.patientId,
          body.indication,
          body.consentId ?? null,
          body.nrConsentId ?? null,
          body.capacityAssessmentId ?? null,
          body.minor,
          body.mhrbPermissionRef ?? null,
          body.maxSessions,
          this.actorId(),
        ],
      );

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'psy_ect_course',
        rowId: id,
        businessKey: body.indication.slice(0, 60),
        dataClass: 'phi',
        patientId: body.patientId,
        encounterId: null,
        reasonText: body.reason,
        before: null,
        after: { minor: body.minor, maxSessions: body.maxSessions },
      });

      return this.ectCourseWithin(tx, id);
    });
  }

  /**
   * A session. Both halves of "modified" are required by the schema and again
   * by the database, and there is no path that records one without them.
   */
  async recordEctSession(courseId: string, body: EctSessionRequest): Promise<EctSessionRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.psy_ect_sessions
           (id, hospital_id, course_id, seq, given_at, placement, charge_mc, seizure_sec,
            anaesthesia, complications, aldrete, cognition_pre, cognition_post,
            created_by, created_at, updated_at)
         SELECT $1::uuid, $2::uuid, $3::uuid,
                coalesce((SELECT max(s.seq) FROM specialty.psy_ect_sessions s
                           WHERE s.course_id = $3::uuid), 0) + 1,
                now(), $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10::jsonb, $11::jsonb,
                $12, now(), now()
         RETURNING *`,
        [
          newId(),
          this.hospitalId(),
          courseId,
          body.placement,
          body.chargeMc ?? null,
          body.seizureSec ?? null,
          JSON.stringify(body.anaesthesia),
          JSON.stringify(body.complications),
          body.aldrete ?? null,
          body.cognitionPre === undefined ? null : JSON.stringify(body.cognitionPre),
          body.cognitionPost === undefined ? null : JSON.stringify(body.cognitionPost),
          this.actorId(),
        ],
      );
      return this.toEctSession(this.one(rows));
    });
  }

  async ectCourse(id: string): Promise<EctCourseRow> {
    return this.guard(async (tx) => this.ectCourseWithin(tx, id));
  }

  // ── Shaping ───────────────────────────────────────────────────────────────

  private one(rows: readonly Record<string, unknown>[]): Record<string, unknown> {
    const row = rows[0];
    if (row === undefined) throw AppError.notFound('That psychiatry record was not found.');
    return row;
  }

  private async episodeWithin(tx: TransactionClient, id: string): Promise<PsyEpisodeRow> {
    const { rows } = await tx.query<Record<string, unknown>>(`${EPISODE_SELECT} WHERE e.id = $1`, [id]);
    return this.toEpisode(this.one(rows));
  }

  private async admissionWithin(tx: TransactionClient, id: string): Promise<AdmissionRow> {
    const { rows } = await tx.query<Record<string, unknown>>(`${ADMISSION_SELECT} WHERE a.id = $1`, [id]);
    return this.toAdmission(this.one(rows));
  }

  private async restraintWithin(tx: TransactionClient, id: string): Promise<RestraintRow> {
    const { rows } = await tx.query<Record<string, unknown>>(`${RESTRAINT_SELECT} WHERE r.id = $1`, [id]);
    return this.toRestraint(this.one(rows));
  }

  private async ectCourseWithin(tx: TransactionClient, id: string): Promise<EctCourseRow> {
    const { rows } = await tx.query<Record<string, unknown>>(`${ECT_SELECT} WHERE c.id = $1`, [id]);
    return this.toEctCourse(this.one(rows));
  }

  private hoursLeft(expiresAt: string | null): number | null {
    if (expiresAt === null) return null;
    return Math.floor((new Date(expiresAt).getTime() - Date.now()) / 3_600_000);
  }

  private toEpisode(r: Record<string, unknown>): PsyEpisodeRow {
    const validUntil = asTextOrNull(r.capacity_valid_until);
    const expiresAt = asTextOrNull(r.authority_expires_at);
    return {
      id: asText(r.id),
      patientId: asText(r.patient_id),
      openedAt: asText(r.opened_at),
      primaryDxIcd10: asTextOrNull(r.primary_dx_icd10),
      riskLevel: asText(r.risk_level),
      leadClinicianId: asText(r.lead_clinician_id),
      status: asText(r.status),
      sensitivity: asText(r.sensitivity),
      capacityKnown: asBoolOrNull(r.has_capacity) !== null,
      hasCapacity: asBoolOrNull(r.has_capacity),
      capacityValidUntil: validUntil,
      // The whole point of the expiry: an assessment from six weeks ago is not
      // evidence of anything today.
      capacityCurrent: validUntil !== null && new Date(validUntil).getTime() >= Date.now(),
      admissionType: asTextOrNull(r.admission_type),
      authorityExpiresAt: expiresAt,
      hoursLeftOfAuthority: this.hoursLeft(expiresAt),
      mhrbIntimationDueAt: asTextOrNull(r.mhrb_intimation_due_at),
      mhrbIntimated: asTextOrNull(r.mhrb_intimated_at) !== null,
      lastScale: asTextOrNull(r.last_scale),
      lastScaleTotal: asNumberOrNull(r.last_scale_total),
      suicidalityFlagged: r.suicidality_flagged === true,
    };
  }

  private toCapacity(r: Record<string, unknown>): CapacityRow {
    const validUntil = asText(r.valid_until);
    return {
      id: asText(r.id),
      episodeId: asText(r.episode_id),
      assessedAt: asText(r.assessed_at),
      assessedBy: asText(r.assessed_by),
      understands: r.understands === true,
      retains: r.retains === true,
      weighs: r.weighs === true,
      communicates: r.communicates === true,
      hasCapacity: r.has_capacity === true,
      decisionScope: asText(r.decision_scope),
      rationale: asText(r.rationale),
      validUntil,
      current: new Date(validUntil).getTime() >= Date.now(),
    };
  }

  private toInstrument(r: Record<string, unknown>): InstrumentRow {
    return {
      id: asText(r.id),
      patientId: asText(r.patient_id),
      kind: asText(r.kind),
      content: asJson(r.content),
      madeAt: asText(r.made_at),
      validFrom: asText(r.valid_from),
      revokedAt: asTextOrNull(r.revoked_at),
      revokedReason: asTextOrNull(r.revoked_reason),
      mhrbRef: asTextOrNull(r.mhrb_ref),
      inForce: asTextOrNull(r.revoked_at) === null,
    };
  }

  private toAdmission(r: Record<string, unknown>): AdmissionRow {
    const expiresAt = asTextOrNull(r.authority_expires_at);
    const hoursLeft = this.hoursLeft(expiresAt);
    const dueAt = asTextOrNull(r.mhrb_intimation_due_at);
    const intimatedAt = asTextOrNull(r.mhrb_intimated_at);
    const dischargedAt = asTextOrNull(r.discharged_at);

    // The forward view, and the only one that matters: a person held past their
    // authority is not a late task.
    const blockedBy: string[] = [];
    if (dischargedAt === null && hoursLeft !== null) {
      if (hoursLeft < 0) {
        blockedBy.push(`the authority for this admission lapsed ${String(Math.abs(hoursLeft))} hours ago`);
      } else if (hoursLeft <= AUTHORITY_WARNING_HOURS) {
        blockedBy.push(`${String(hoursLeft)} hours of authority left`);
      }
    }
    if (dischargedAt === null && dueAt !== null && intimatedAt === null) {
      const dueIn = Math.floor((new Date(dueAt).getTime() - Date.now()) / 3_600_000);
      blockedBy.push(
        dueIn < 0
          ? `the Review Board should have been told ${String(Math.abs(dueIn))} hours ago`
          : `the Review Board has to be told within ${String(dueIn)} hours`,
      );
    }

    return {
      id: asText(r.id),
      episodeId: asText(r.episode_id),
      patientId: asText(r.patient_id),
      admissionType: asText(r.admission_type),
      admittedAt: asText(r.admitted_at),
      capacityAssessmentId: asTextOrNull(r.capacity_assessment_id),
      authorityExpiresAt: expiresAt,
      hoursLeftOfAuthority: hoursLeft,
      mhrbIntimationDueAt: dueAt,
      mhrbIntimatedAt: intimatedAt,
      mhrbRef: asTextOrNull(r.mhrb_ref),
      dischargedAt,
      blockedBy,
      restraintsThisAdmission: asNumber(r.restraint_count),
    };
  }

  private toRestraint(r: Record<string, unknown>): RestraintRow {
    const observations = Array.isArray(r.monitoring) ? r.monitoring.length : 0;
    const orderedAt = asTextOrNull(r.ordered_at);
    const nrInformedAt = asTextOrNull(r.nr_informed_at);

    const blockedBy: string[] = [];
    if (orderedAt === null) blockedBy.push('no psychiatrist’s order is recorded');
    if (observations === 0) blockedBy.push('no observations have been recorded');
    if (nrInformedAt === null) blockedBy.push('the nominated representative has not been told');

    return {
      id: asText(r.id),
      admissionId: asText(r.admission_id),
      kind: asText(r.kind),
      startedAt: asText(r.started_at),
      endedAt: asTextOrNull(r.ended_at),
      durationMin: asNumberOrNull(r.duration_min),
      reason: asText(r.reason),
      orderedBy: asTextOrNull(r.ordered_by),
      orderedAt,
      observations,
      nrInformedAt,
      reportedAt: asTextOrNull(r.reported_at),
      blockedBy: asTextOrNull(r.ended_at) === null ? blockedBy : [],
    };
  }

  private toEctCourse(r: Record<string, unknown>): EctCourseRow {
    const given = asNumber(r.sessions_given);
    const max = asNumber(r.max_sessions);
    const minor = r.minor === true;
    const boardRef = asTextOrNull(r.mhrb_permission_ref);

    // §95, read forwards.
    const blockedBy: string[] = [];
    if (minor && boardRef === null) {
      blockedBy.push('a minor needs the Review Board’s permission before the first session');
    }
    if (given >= max) blockedBy.push(`the course is authorised for ${String(max)} sessions`);
    if (asTextOrNull(r.consent_id) === null && asTextOrNull(r.nr_consent_id) === null) {
      blockedBy.push('no consent is recorded');
    }

    return {
      id: asText(r.id),
      episodeId: asText(r.episode_id),
      patientId: asText(r.patient_id),
      indication: asText(r.indication),
      minor,
      mhrbPermissionRef: boardRef,
      maxSessions: max,
      sessionsGiven: given,
      startedAt: asText(r.started_at),
      endedAt: asTextOrNull(r.ended_at),
      blockedBy,
    };
  }

  private toEctSession(r: Record<string, unknown>): EctSessionRow {
    return {
      id: asText(r.id),
      courseId: asText(r.course_id),
      seq: asNumber(r.seq),
      givenAt: asText(r.given_at),
      placement: asText(r.placement),
      seizureSec: asNumberOrNull(r.seizure_sec),
      anaesthesia: asJson(r.anaesthesia),
    };
  }

  private toScale(r: Record<string, unknown>): ScaleRow {
    return {
      id: asText(r.id),
      patientId: asText(r.patient_id),
      scale: asText(r.scale),
      items: asJson(r.items),
      total: asNumberOrNull(r.total),
      severityBand: asTextOrNull(r.severity_band),
      item9Flag: r.item9_flag === true,
      recordedAt: asText(r.recorded_at),
    };
  }
}

const EPISODE_SELECT = `
  SELECT e.*,
         cap.has_capacity, cap.valid_until AS capacity_valid_until,
         adm.admission_type, adm.authority_expires_at, adm.mhrb_intimation_due_at,
         adm.mhrb_intimated_at,
         sc.scale AS last_scale, sc.total AS last_scale_total,
         coalesce(sc.item9_flag, false) AS suicidality_flagged
    FROM specialty.psy_episodes e
    LEFT JOIN LATERAL (
      SELECT c.has_capacity, c.valid_until FROM specialty.psy_capacity_assessments c
       WHERE c.episode_id = e.id ORDER BY c.assessed_at DESC LIMIT 1
    ) cap ON true
    LEFT JOIN LATERAL (
      SELECT a.admission_type, a.authority_expires_at, a.mhrb_intimation_due_at, a.mhrb_intimated_at
        FROM specialty.mhca_admissions a
       WHERE a.episode_id = e.id AND a.discharged_at IS NULL
       ORDER BY a.admitted_at DESC LIMIT 1
    ) adm ON true
    LEFT JOIN LATERAL (
      SELECT s.scale, s.total, s.item9_flag FROM specialty.psy_scales s
       WHERE s.episode_id = e.id ORDER BY s.recorded_at DESC LIMIT 1
    ) sc ON true`;

const CAPACITY_SELECT = `SELECT c.* FROM specialty.psy_capacity_assessments c`;

const ADMISSION_SELECT = `
  SELECT a.*,
         (SELECT count(*) FROM specialty.psy_restraint_events r
           WHERE r.admission_id = a.id) AS restraint_count
    FROM specialty.mhca_admissions a`;

const RESTRAINT_SELECT = `SELECT r.* FROM specialty.psy_restraint_events r`;

const ECT_SELECT = `
  SELECT c.*,
         (SELECT count(*) FROM specialty.psy_ect_sessions s WHERE s.course_id = c.id) AS sessions_given
    FROM specialty.psy_ect_courses c`;
