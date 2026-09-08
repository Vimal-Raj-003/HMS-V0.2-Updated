import { Injectable } from '@nestjs/common';
import { newId } from '@vims/contracts';
import type { TransactionClient } from '../../../core/db/database.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { consoleEvent } from './consoles.events.js';
import type {
  BiopsyRequest,
  BiopsyResultRequest,
  DermScoreRequest,
  LesionObservationRequest,
  LesionRequest,
  OpenQuery,
  PatientQuery,
  PhototherapyCourseRequest,
  PhototherapySessionRequest,
  RaiseCeilingRequest,
} from './consoles.schemas.js';
import {
  ConsoleSupport,
  asBool,
  asJson,
  asNumber,
  asNumberOrNull,
  asStringArray,
  asText,
  asTextOrNull,
} from './consoles.support.js';
import type {
  BiopsyRow,
  DermScoreRow,
  LesionObservationRow,
  LesionRow,
  PhototherapyCourseRow,
  PhototherapySessionRow,
} from './consoles.types.js';

/** The score types the database computes. Everything else keeps its typed value. */
const DERIVED_SCORES = new Set(['pasi', 'easi', 'scorad', 'bsa']);

/** At or above this the skin has reacted, and the ladder stops climbing. */
const ERYTHEMA_HOLD_GRADE = 2;

/**
 * OP-027 — the dermatology console.
 *
 * ── Nothing here computes a PASI ────────────────────────────────────────────
 *
 * The formula lives in a trigger, so the number that keeps a biologic funded
 * was computed the same way in January and in July. The service's only opinion
 * about scores is `derived`, a flag telling a screen whether the value in front
 * of it came from the components or from a person.
 *
 * ── The next dose is a suggestion, and the ceiling is a refusal ─────────────
 *
 * `suggestedNextDoseMj` applies the course's increment, clips at the ceiling,
 * and holds flat after erythema — the same three rules the database enforces,
 * offered forwards so the technician sees the right number rather than being
 * refused after typing the wrong one. The suggestion is advice; the refusal is
 * the rule, and it is not in this file.
 *
 * ── Raising the ceiling is a different verb ─────────────────────────────────
 *
 * `raiseCeiling` is a separate method behind a separate permission with a
 * mandatory reason. It never delivers a session, and delivering a session never
 * touches the ceiling — because the two being one call is exactly how a limit
 * gets moved by the person who wanted to exceed it.
 */
@Injectable()
export class DermatologyService extends ConsoleSupport {
  // ═══════════════════════════════════════════════════════════════════════════
  // Lesions
  // ═══════════════════════════════════════════════════════════════════════════

  async createLesion(body: LesionRequest): Promise<LesionRow> {
    return this.guard(async (tx) => {
      const id = newId();
      // The number is per patient and allocated from what is already there, so
      // "lesion 3" means one thing in a note, a photograph and a histology
      // request. Not a numbering series: it is an index within a chart, not a
      // document number anybody quotes outside it.
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.derm_lesions
           (id, hospital_id, branch_id, patient_id, lesion_no, body_site_snomed, region_key,
            side, morphology, size_mm, colour, descriptors, first_seen_encounter_id,
            sensitive, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,
                 coalesce((SELECT max(lesion_no) FROM specialty.derm_lesions
                            WHERE hospital_id = $2 AND patient_id = $4), 0) + 1,
                 $5,$6,$7::clinical."Laterality",$8,$9,$10,$11::jsonb,$12,$13,$14, now(), now())
         RETURNING *, 0::int AS observation_count, NULL::timestamptz AS last_observed_at,
                   NULL::numeric AS growth_mm`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.patientId,
          body.bodySiteSnomed ?? null,
          body.regionKey,
          body.side,
          body.morphology,
          body.sizeMm ?? null,
          body.colour ?? null,
          JSON.stringify(body.descriptors),
          body.firstSeenEncounterId ?? null,
          body.sensitive,
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The lesion was not recorded.');

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'derm_lesion',
        rowId: id,
        businessKey: `${body.patientId}:${asText(row['lesion_no'])}`,
        dataClass: 'phi',
        patientId: body.patientId,
        encounterId: body.firstSeenEncounterId ?? null,
        before: null,
        after: { region: body.regionKey, sensitive: body.sensitive },
      });

      return this.toLesion(row);
    });
  }

  async observeLesion(lesionId: string, body: LesionObservationRequest): Promise<LesionObservationRow> {
    return this.guard(async (tx) => {
      await this.requireParent(tx, 'specialty.derm_lesions', lesionId, 'That lesion');
      const id = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.derm_lesion_observations
           (id, hospital_id, lesion_id, encounter_id, findings, itch_nrs, photos,
            observed_at, observed_by)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::uuid[], now(), $8)
         RETURNING *`,
        [
          id,
          this.hospitalId(),
          lesionId,
          body.encounterId ?? null,
          JSON.stringify(body.findings),
          body.itchNrs ?? null,
          body.photos,
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The observation was not recorded.');

      return {
        id: asText(row['id']),
        lesionId: asText(row['lesion_id']),
        findings: asJson(row['findings']),
        itchNrs: asNumberOrNull(row['itch_nrs']),
        photos: asStringArray(row['photos']),
        observedAt: asText(row['observed_at']),
        observedBy: asText(row['observed_by']),
      };
    });
  }

  async listLesions(query: OpenQuery): Promise<readonly LesionRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT l.*,
                (SELECT count(*) FROM specialty.derm_lesion_observations o
                  WHERE o.lesion_id = l.id) AS observation_count,
                (SELECT max(o.observed_at) FROM specialty.derm_lesion_observations o
                  WHERE o.lesion_id = l.id) AS last_observed_at,
                -- Growth since the first recorded size. The single most useful
                -- number on a pigmented lesion, and the one nobody computes by
                -- hand across two visits a year apart.
                (SELECT (o.findings->>'sizeMm')::numeric - l.size_mm
                   FROM specialty.derm_lesion_observations o
                  WHERE o.lesion_id = l.id AND o.findings ? 'sizeMm'
                  ORDER BY o.observed_at DESC LIMIT 1) AS growth_mm
           FROM specialty.derm_lesions l
          WHERE l.hospital_id = $1
            AND ($2::uuid IS NULL OR l.patient_id = $2::uuid)
            AND ($3::boolean IS NOT TRUE OR l.status IN ('active','monitor'))
          ORDER BY l.lesion_no
          LIMIT $4`,
        [this.hospitalId(), query.patientId ?? null, query.openOnly, query.limit],
      );
      return rows.map((r) => this.toLesion(r));
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Scores
  // ═══════════════════════════════════════════════════════════════════════════

  async recordScore(body: DermScoreRequest): Promise<DermScoreRow> {
    return this.guard(async (tx) => {
      const id = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.derm_scores
           (id, hospital_id, branch_id, patient_id, encounter_id, score_type,
            components, value, form_response_id, recorded_at, recorded_by)
         VALUES ($1,$2,$3,$4,$5,$6::specialty."DermScoreType",$7::jsonb,$8,$9, now(), $10)
         RETURNING *`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.patientId,
          body.encounterId ?? null,
          body.scoreType,
          JSON.stringify(body.components),
          // Sent, and for the four derived types simply overwritten by the
          // trigger. Passing it through rather than stripping it keeps the
          // service honest about where the authority is.
          body.value ?? null,
          body.formResponseId ?? null,
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The score was not recorded.');
      return this.toScore(row);
    });
  }

  async listScores(query: PatientQuery): Promise<readonly DermScoreRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM specialty.derm_scores
          WHERE hospital_id = $1 AND ($2::uuid IS NULL OR patient_id = $2::uuid)
          ORDER BY recorded_at DESC LIMIT $3`,
        [this.hospitalId(), query.patientId ?? null, query.limit],
      );
      return rows.map((r) => this.toScore(r));
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Biopsies
  // ═══════════════════════════════════════════════════════════════════════════

  async sendBiopsy(body: BiopsyRequest): Promise<BiopsyRow> {
    return this.guard(async (tx) => {
      const id = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.derm_biopsies
           (id, hospital_id, branch_id, patient_id, procedure_id, lesion_id, specimen_no,
            lab_order_id, type, size_mm, dif, clinical_dx, status, created_by,
            created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'sent',$13, now(), now())
         RETURNING *`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.patientId,
          body.procedureId ?? null,
          body.lesionId,
          body.specimenNo ?? null,
          body.labOrderId ?? null,
          body.type,
          body.sizeMm ?? null,
          body.dif,
          body.clinicalDx ?? null,
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The biopsy was not recorded.');

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'derm_biopsy',
        rowId: id,
        businessKey: body.specimenNo ?? body.lesionId,
        dataClass: 'phi',
        patientId: body.patientId,
        encounterId: null,
        before: null,
        after: { type: body.type, dif: body.dif },
      });

      return this.toBiopsy(row);
    });
  }

  async fileBiopsyResult(id: string, body: BiopsyResultRequest): Promise<BiopsyRow> {
    return this.guard(async (tx) => {
      const closing = body.status === 'reviewed' || body.status === 'action_planned';
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE specialty.derm_biopsies
            SET result_summary = $3, malignancy_flag = $4, margins = $5,
                followup_task_id = coalesce($6, followup_task_id),
                status = $7::specialty."BiopsyStatus",
                reviewed_by = CASE WHEN $8 THEN $9 ELSE reviewed_by END,
                reviewed_at = CASE WHEN $8 THEN now() ELSE reviewed_at END,
                updated_at = now()
          WHERE hospital_id = $1 AND id = $2
          RETURNING *`,
        [
          this.hospitalId(),
          id,
          body.resultSummary,
          body.malignancyFlag,
          body.margins ?? null,
          body.followupTaskId ?? null,
          body.status,
          closing,
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.notFound('That biopsy does not exist.');

      if (body.malignancyFlag) {
        await this.outbox.publish(
          tx,
          consoleEvent('derm.biopsy.malignant', id, {
            biopsyId: id,
            patientId: asText(row['patient_id']),
            lesionId: asText(row['lesion_id']),
            specimenNo: asTextOrNull(row['specimen_no']),
            margins: asTextOrNull(row['margins']),
          }),
        );
      }

      await this.audit.write(tx, {
        action: 'update',
        entity: 'derm_biopsy',
        rowId: id,
        businessKey: asTextOrNull(row['specimen_no']) ?? id,
        dataClass: 'phi',
        patientId: asText(row['patient_id']),
        encounterId: null,
        before: null,
        after: { status: body.status, malignant: body.malignancyFlag },
      });

      return this.toBiopsy(row);
    });
  }

  async listBiopsies(query: OpenQuery): Promise<readonly BiopsyRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM specialty.derm_biopsies
          WHERE hospital_id = $1
            AND ($2::uuid IS NULL OR patient_id = $2::uuid)
            AND ($3::boolean IS NOT TRUE OR status NOT IN ('reviewed','action_planned'))
          ORDER BY malignancy_flag DESC, created_at DESC LIMIT $4`,
        [this.hospitalId(), query.patientId ?? null, query.openOnly, query.limit],
      );
      return rows.map((r) => this.toBiopsy(r));
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Phototherapy
  // ═══════════════════════════════════════════════════════════════════════════

  async prescribeCourse(body: PhototherapyCourseRequest): Promise<PhototherapyCourseRow> {
    return this.guard(async (tx) => {
      const id = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.derm_phototherapy_courses
           (id, hospital_id, branch_id, patient_id, modality, skin_type, med_mj,
            start_dose_mj, increment_pct, max_dose_mj, freq_per_week, shielding, psoralen,
            device_id, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5::specialty."PhototherapyModality",$6,$7,$8,$9,$10,$11,
                 $12::jsonb,$13::jsonb,$14,$15, now(), now())
         RETURNING *`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.patientId,
          body.modality,
          body.skinType,
          body.medMj ?? null,
          body.startDoseMj,
          body.incrementPct,
          body.maxDoseMj,
          body.freqPerWeek,
          JSON.stringify(body.shielding),
          JSON.stringify(body.psoralen),
          body.deviceId ?? null,
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The course was not created.');

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'derm_phototherapy_course',
        rowId: id,
        businessKey: body.patientId,
        dataClass: 'phi',
        patientId: body.patientId,
        encounterId: null,
        before: null,
        after: {
          modality: body.modality,
          skinType: body.skinType,
          startDoseMj: body.startDoseMj,
          maxDoseMj: body.maxDoseMj,
        },
      });

      return this.courseWithin(tx, id);
    });
  }

  async deliverSession(courseId: string, body: PhototherapySessionRequest): Promise<PhototherapySessionRow> {
    return this.guard(async (tx) => {
      const id = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.derm_phototherapy_sessions
           (id, hospital_id, course_id, seq, dose_mj, erythema_grade, adverse,
            technician_id, charge_intent_id, administered_at)
         VALUES ($1,$2,$3,
                 coalesce((SELECT max(seq) FROM specialty.derm_phototherapy_sessions
                            WHERE course_id = $3), 0) + 1,
                 $4,$5,$6::jsonb,$7,$8, now())
         RETURNING *`,
        [
          id,
          this.hospitalId(),
          courseId,
          body.doseMj,
          body.erythemaGrade,
          JSON.stringify(body.adverse),
          this.actorId(),
          body.chargeIntentId ?? null,
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The session was not recorded.');

      if (body.erythemaGrade >= ERYTHEMA_HOLD_GRADE) {
        const course = await this.courseWithin(tx, courseId);
        await this.outbox.publish(
          tx,
          consoleEvent('derm.phototherapy.erythema', id, {
            sessionId: id,
            courseId,
            patientId: course.patientId,
            seq: asNumber(row['seq']),
            doseMj: String(body.doseMj),
            erythemaGrade: body.erythemaGrade,
            cumulativeDoseMj: String(course.cumulativeDoseMj),
          }),
        );
      }

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'derm_phototherapy_session',
        rowId: id,
        businessKey: courseId,
        dataClass: 'phi',
        patientId: null,
        encounterId: null,
        before: null,
        after: { doseMj: body.doseMj, erythemaGrade: body.erythemaGrade },
      });

      return {
        id: asText(row['id']),
        courseId: asText(row['course_id']),
        seq: asNumber(row['seq']),
        doseMj: asNumber(row['dose_mj']),
        erythemaGrade: asNumber(row['erythema_grade']),
        technicianId: asText(row['technician_id']),
        administeredAt: asText(row['administered_at']),
      };
    });
  }

  /**
   * Move the ceiling, deliberately.
   *
   * A different permission, a different route and a mandatory reason, because
   * the ceiling is the thing that stops a burn. Lowering it is allowed without
   * ceremony in the sense that the reason is still recorded — the audit row does
   * not care which direction it moved, and neither should the clinic.
   */
  async raiseCeiling(courseId: string, body: RaiseCeilingRequest): Promise<PhototherapyCourseRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE specialty.derm_phototherapy_courses
            SET max_dose_mj = $3, updated_at = now()
          WHERE hospital_id = $1 AND id = $2 AND status = 'active'
          RETURNING *`,
        [this.hospitalId(), courseId, body.maxDoseMj],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict('That course does not exist, or it is no longer active.');
      }

      await this.audit.write(tx, {
        action: 'override',
        entity: 'derm_phototherapy_course',
        rowId: courseId,
        businessKey: asText(row['patient_id']),
        dataClass: 'phi',
        patientId: asText(row['patient_id']),
        encounterId: null,
        reasonText: body.reason,
        before: null,
        after: { maxDoseMj: body.maxDoseMj },
      });

      return this.courseWithin(tx, courseId);
    });
  }

  async listCourses(query: OpenQuery): Promise<readonly PhototherapyCourseRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT id FROM specialty.derm_phototherapy_courses
          WHERE hospital_id = $1
            AND ($2::uuid IS NULL OR patient_id = $2::uuid)
            AND ($3::boolean IS NOT TRUE OR status = 'active')
          ORDER BY created_at DESC LIMIT $4`,
        [this.hospitalId(), query.patientId ?? null, query.openOnly, query.limit],
      );
      const out: PhototherapyCourseRow[] = [];
      for (const r of rows) out.push(await this.courseWithin(tx, asText(r['id'])));
      return out;
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Shaping
  // ═══════════════════════════════════════════════════════════════════════════

  private async courseWithin(tx: TransactionClient, courseId: string): Promise<PhototherapyCourseRow> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT c.*,
              (SELECT s.dose_mj FROM specialty.derm_phototherapy_sessions s
                WHERE s.course_id = c.id ORDER BY s.seq DESC LIMIT 1) AS last_dose_mj,
              (SELECT s.erythema_grade FROM specialty.derm_phototherapy_sessions s
                WHERE s.course_id = c.id ORDER BY s.seq DESC LIMIT 1) AS last_erythema
         FROM specialty.derm_phototherapy_courses c
        WHERE c.hospital_id = $1 AND c.id = $2`,
      [this.hospitalId(), courseId],
    );
    const row = rows[0];
    if (row === undefined) throw AppError.notFound('That phototherapy course does not exist.');
    return this.toCourse(row);
  }

  private toCourse(row: Record<string, unknown>): PhototherapyCourseRow {
    const max = asNumber(row['max_dose_mj']);
    const increment = asNumber(row['increment_pct']);
    const start = asNumber(row['start_dose_mj']);
    const last = asNumberOrNull(row['last_dose_mj']);
    const lastErythema = asNumberOrNull(row['last_erythema']);
    const status = asText(row['status']);

    // The same three rules the database enforces, offered forwards. A
    // technician who sees the right number does not have to be refused after
    // typing the wrong one.
    let suggested: number | null;
    let reason: string;
    if (status !== 'active') {
      suggested = null;
      reason = 'The course is not active.';
    } else if (last === null) {
      suggested = Math.min(start, max);
      reason = 'First session: the starting dose.';
    } else if (lastErythema !== null && lastErythema >= ERYTHEMA_HOLD_GRADE) {
      suggested = last;
      reason = `The last session caused grade ${String(lastErythema)} erythema, so the dose holds rather than climbing.`;
    } else {
      const stepped = Math.round(last * (1 + increment / 100) * 100) / 100;
      suggested = Math.min(stepped, max);
      reason =
        stepped > max
          ? 'The next step would pass the course ceiling, so the ceiling is the suggestion.'
          : `The last dose plus ${String(increment)} per cent.`;
    }

    return {
      id: asText(row['id']),
      patientId: asText(row['patient_id']),
      modality: asText(row['modality']),
      skinType: asNumber(row['skin_type']),
      startDoseMj: start,
      incrementPct: increment,
      maxDoseMj: max,
      freqPerWeek: asNumber(row['freq_per_week']),
      cumulativeDoseMj: asNumber(row['cumulative_dose_mj']),
      sessionsCount: asNumber(row['sessions_count']),
      status,
      suggestedNextDoseMj: suggested,
      suggestionReason: reason,
    };
  }

  private toLesion(row: Record<string, unknown>): LesionRow {
    return {
      id: asText(row['id']),
      patientId: asText(row['patient_id']),
      lesionNo: asNumber(row['lesion_no']),
      regionKey: asText(row['region_key']),
      side: asText(row['side']),
      morphology: asText(row['morphology']),
      sizeMm: asNumberOrNull(row['size_mm']),
      status: asText(row['status']),
      sensitive: asBool(row['sensitive']),
      observationCount: asNumber(row['observation_count'] ?? 0),
      lastObservedAt: asTextOrNull(row['last_observed_at']),
      growthMm: asNumberOrNull(row['growth_mm']),
    };
  }

  private toScore(row: Record<string, unknown>): DermScoreRow {
    const type = asText(row['score_type']);
    return {
      id: asText(row['id']),
      patientId: asText(row['patient_id']),
      scoreType: type,
      components: asJson(row['components']),
      value: asNumberOrNull(row['value']),
      derived: DERIVED_SCORES.has(type),
      recordedAt: asText(row['recorded_at']),
    };
  }

  private toBiopsy(row: Record<string, unknown>): BiopsyRow {
    const malignant = asBool(row['malignancy_flag']);
    const followup = asTextOrNull(row['followup_task_id']);
    const status = asText(row['status']);
    return {
      id: asText(row['id']),
      patientId: asText(row['patient_id']),
      lesionId: asText(row['lesion_id']),
      specimenNo: asTextOrNull(row['specimen_no']),
      type: asText(row['type']),
      status,
      resultSummary: asTextOrNull(row['result_summary']),
      malignancyFlag: malignant,
      margins: asTextOrNull(row['margins']),
      followupTaskId: followup,
      createdAt: asText(row['created_at']),
      reviewedAt: asTextOrNull(row['reviewed_at']),
      awaitingFollowup: malignant && followup === null,
    };
  }
}
