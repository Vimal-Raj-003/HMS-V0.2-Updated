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
  asText,
  asTextOrNull,
} from '../consoles/consoles.support.js';
import type {
  AssessmentRequest,
  AttendRequest,
  DischargeRequest,
  EpisodeQuery,
  EpisodeRequest,
  ExtendAuthorisationRequest,
  GoalRequest,
  PlanRequest,
  ResolveGoalRequest,
  SessionRequest,
} from './therapy.schemas.js';
import type {
  AssessmentRow,
  EpisodeDetail,
  EpisodeRow,
  GoalRow,
  PlanRow,
  SessionRow,
} from './therapy.types.js';

/**
 * OP-015 — the therapy spine, shared by physiotherapy, wound care, dietetics
 * and speech and swallow.
 *
 * ── Nothing here counts a session against an authorisation ─────────────────
 *
 * The database refuses the eleventh session of ten. What this service does is
 * *report* the count forwards — `sessionsRemaining`, `authorisationExhausted`
 * — so a therapist books the next appointment knowing it will not be allowed,
 * rather than finding out with the patient in the room. The refusal is the
 * rule; the count is a courtesy.
 *
 * ── `dischargeBlockedBy` says the same thing the refusal would ─────────────
 *
 * A discharge is refused while goals are open, and the list screen carries the
 * same sentence. Two different explanations of one rule is how a person comes
 * to believe the screen and the server disagree.
 *
 * ── Attending is a status change, not an insert ────────────────────────────
 *
 * A session is booked and then attended, because a no-show is a fact worth
 * having and a course of therapy is mostly its attendance record. Recording an
 * attendance against a plan that has since been superseded is refused by the
 * database, which is right: it means somebody is working from a printout.
 */
@Injectable()
export class TherapyService extends ConsoleSupport {
  // ═══════════════════════════════════════════════════════════════════════════
  // The episode
  // ═══════════════════════════════════════════════════════════════════════════

  async openEpisode(body: EpisodeRequest): Promise<EpisodeRow> {
    return this.guard(async (tx) => {
      const id = newId();
      await tx.query(
        `INSERT INTO specialty.therapy_episodes
           (id, hospital_id, branch_id, patient_id, discipline, setting, referral_id, source,
            referring_doctor_id, diagnosis_icd10, precautions, sessions_authorised,
            lead_therapist_id, sla_due_at, status, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5::specialty."TherapyDiscipline",$6::specialty."TherapySetting",
                 $7,$8,$9,$10,$11::jsonb,$12,$13,$14::timestamptz,'triaged',$15, now(), now())`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.patientId,
          body.discipline,
          body.setting,
          body.referralId ?? null,
          body.source,
          body.referringDoctorId ?? null,
          body.diagnosisIcd10 ?? null,
          JSON.stringify(body.precautions),
          body.sessionsAuthorised ?? null,
          body.leadTherapistId ?? this.actorId(),
          body.slaDueAt ?? null,
          this.actorId(),
        ],
      );

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'therapy_episode',
        rowId: id,
        businessKey: body.patientId,
        dataClass: 'phi',
        patientId: body.patientId,
        encounterId: null,
        before: null,
        after: { discipline: body.discipline, authorised: body.sessionsAuthorised ?? null },
      });

      return this.episodeWithin(tx, id);
    });
  }

  async listEpisodes(query: EpisodeQuery): Promise<readonly EpisodeRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `${this.selectEpisode()}
          WHERE e.hospital_id = $1
            AND ($2::uuid IS NULL OR e.patient_id = $2::uuid)
            AND ($3::text IS NULL OR e.discipline::text = $3::text)
            AND ($4::boolean IS NOT TRUE OR e.status NOT IN ('discharged'))
          ORDER BY e.opened_at DESC
          LIMIT $5`,
        [this.hospitalId(), query.patientId ?? null, query.discipline ?? null, query.openOnly, query.limit],
      );
      return rows.map((r) => this.toEpisode(r));
    });
  }

  async episodeDetail(id: string): Promise<EpisodeDetail> {
    return this.guard(async (tx) => {
      const episode = await this.episodeWithin(tx, id);
      const [assessments, goals, plans, sessions] = await Promise.all([
        tx.query<Record<string, unknown>>(
          `SELECT * FROM specialty.therapy_assessments WHERE episode_id = $1 ORDER BY created_at`,
          [id],
        ),
        tx.query<Record<string, unknown>>(
          `SELECT * FROM specialty.therapy_goals WHERE episode_id = $1 ORDER BY created_at`,
          [id],
        ),
        tx.query<Record<string, unknown>>(
          `SELECT * FROM specialty.therapy_plans WHERE episode_id = $1 ORDER BY version`,
          [id],
        ),
        tx.query<Record<string, unknown>>(
          `SELECT * FROM specialty.therapy_sessions WHERE episode_id = $1 ORDER BY seq`,
          [id],
        ),
      ]);

      return {
        episode,
        assessments: assessments.rows.map((r) => this.toAssessment(r)),
        goals: goals.rows.map((r) => this.toGoal(r)),
        plans: plans.rows.map((r) => this.toPlan(r)),
        sessions: sessions.rows.map((r) => this.toSession(r)),
      };
    });
  }

  /**
   * Extend what a payer or a package authorised.
   *
   * A separate route behind a `high` key with a mandatory reason, because the
   * eleventh session of ten is either fraud or unpaid work and which one it is
   * depends entirely on this having been done.
   */
  async extendAuthorisation(id: string, body: ExtendAuthorisationRequest): Promise<EpisodeRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE specialty.therapy_episodes
            SET sessions_authorised = $3,
                authorisation_extended_by = $4,
                authorisation_extended_at = now(),
                authorisation_extended_reason = $5,
                updated_at = now()
          WHERE hospital_id = $1 AND id = $2 AND status <> 'discharged'
          RETURNING patient_id, sessions_authorised`,
        [this.hospitalId(), id, body.sessionsAuthorised, this.actorId(), body.reason],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict('That episode does not exist, or it has already been discharged.');
      }

      await this.audit.write(tx, {
        action: 'override',
        entity: 'therapy_episode',
        rowId: id,
        businessKey: asText(row['patient_id']),
        dataClass: 'financial',
        patientId: asText(row['patient_id']),
        encounterId: null,
        reasonText: body.reason,
        before: null,
        after: { sessionsAuthorised: body.sessionsAuthorised },
      });

      return this.episodeWithin(tx, id);
    });
  }

  async discharge(id: string, body: DischargeRequest): Promise<EpisodeRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE specialty.therapy_episodes
            SET status = 'discharged', outcome = $3, updated_at = now()
          WHERE hospital_id = $1 AND id = $2 AND status <> 'discharged'
          RETURNING patient_id, discipline`,
        [this.hospitalId(), id, body.outcome],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict('That episode does not exist, or it is already discharged.');
      }

      const episode = await this.episodeWithin(tx, id);
      const { rows: goalRows } = await tx.query<Record<string, unknown>>(
        `SELECT count(*) FILTER (WHERE status = 'met') AS met, count(*) AS total
           FROM specialty.therapy_goals WHERE episode_id = $1`,
        [id],
      );
      const counts = goalRows[0];

      await this.outbox.publish(
        tx,
        consoleEvent('therapy.episode.discharged', id, {
          episodeId: id,
          patientId: asText(row['patient_id']),
          discipline: asText(row['discipline']),
          outcome: body.outcome,
          sessionsDelivered: episode.sessionsDelivered,
          goalsMet: asNumber(counts?.['met'] ?? 0),
          goalsTotal: asNumber(counts?.['total'] ?? 0),
        }),
      );

      await this.audit.write(tx, {
        action: 'update',
        entity: 'therapy_episode',
        rowId: id,
        businessKey: asText(row['patient_id']),
        dataClass: 'phi',
        patientId: asText(row['patient_id']),
        encounterId: null,
        before: null,
        after: { outcome: body.outcome, sessions: episode.sessionsDelivered },
      });

      return episode;
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Assessment, goals and plan
  // ═══════════════════════════════════════════════════════════════════════════

  async recordAssessment(episodeId: string, body: AssessmentRequest): Promise<AssessmentRow> {
    return this.guard(async (tx) => {
      const id = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.therapy_assessments
           (id, hospital_id, episode_id, patient_id, encounter_id, admission_id, kind,
            findings, scores, impression, form_response_id, therapist_id, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12, now(), now())
         RETURNING *`,
        [
          id,
          this.hospitalId(),
          episodeId,
          body.patientId,
          body.encounterId ?? null,
          body.admissionId ?? null,
          body.kind,
          JSON.stringify(body.findings),
          JSON.stringify(body.scores),
          body.impression ?? null,
          body.formResponseId ?? null,
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The assessment was not recorded.');

      // Assessing is the stage the episode is in. Moving it here rather than in
      // a separate call means a triaged episode cannot sit "triaged" while it is
      // plainly being assessed.
      await tx.query(
        `UPDATE specialty.therapy_episodes SET status = 'assessing', updated_at = now()
          WHERE id = $1 AND status = 'triaged'`,
        [episodeId],
      );

      return this.toAssessment(row);
    });
  }

  async signAssessment(id: string): Promise<AssessmentRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE specialty.therapy_assessments
            SET signed_by = $3, signed_at = now(), updated_at = now()
          WHERE hospital_id = $1 AND id = $2 AND signed_at IS NULL
          RETURNING *`,
        [this.hospitalId(), id, this.actorId()],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict('That assessment does not exist, or it is already signed.');
      }

      await this.audit.write(tx, {
        action: 'sign',
        entity: 'therapy_assessment',
        rowId: id,
        businessKey: asText(row['patient_id']),
        dataClass: 'phi',
        patientId: asText(row['patient_id']),
        encounterId: asTextOrNull(row['encounter_id']),
        before: null,
        after: { kind: asText(row['kind']) },
      });

      return this.toAssessment(row);
    });
  }

  async addGoal(episodeId: string, body: GoalRequest): Promise<GoalRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.therapy_goals
           (id, hospital_id, episode_id, description, metric, baseline, target, code,
            target_date, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10, now(), now())
         RETURNING *`,
        [
          newId(),
          this.hospitalId(),
          episodeId,
          body.description,
          body.metric,
          body.baseline,
          body.target,
          body.code ?? null,
          body.targetDate ?? null,
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The goal was not recorded.');
      return this.toGoal(row);
    });
  }

  async resolveGoal(id: string, body: ResolveGoalRequest): Promise<GoalRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE specialty.therapy_goals
            SET status = $3::specialty."TherapyGoalStatus", outcome_note = $4,
                resolved_at = now(), resolved_by = $5, updated_at = now()
          WHERE hospital_id = $1 AND id = $2
          RETURNING *`,
        [this.hospitalId(), id, body.status, body.outcomeNote, this.actorId()],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.notFound('That goal does not exist.');
      return this.toGoal(row);
    });
  }

  async writePlan(episodeId: string, body: PlanRequest): Promise<PlanRow> {
    return this.guard(async (tx) => {
      // Superseding first, so that "one active plan" is satisfied by the time
      // the new one lands. A plan replaced mid-course keeps every session that
      // was delivered under it.
      await tx.query(
        `UPDATE specialty.therapy_plans
            SET status = 'superseded', updated_at = now()
          WHERE episode_id = $1 AND status = 'active'`,
        [episodeId],
      );

      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.therapy_plans
           (id, hospital_id, episode_id, assessment_id, version, items, frequency_per_week,
            sessions_planned, precautions_snapshot, home_programme, status,
            therapist_id, signed_by, signed_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,
                 coalesce((SELECT max(version) FROM specialty.therapy_plans WHERE episode_id = $3), 0) + 1,
                 $5::jsonb,$6,$7,
                 coalesce((SELECT precautions FROM specialty.therapy_episodes WHERE id = $3), '{}'::jsonb),
                 $8::jsonb,'active',$9,$9, now(), now(), now())
         RETURNING *`,
        [
          newId(),
          this.hospitalId(),
          episodeId,
          body.assessmentId,
          JSON.stringify(body.items),
          body.frequencyPerWeek ?? null,
          body.sessionsPlanned ?? null,
          JSON.stringify(body.homeProgramme),
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The plan was not written.');

      await tx.query(
        `UPDATE specialty.therapy_episodes SET status = 'active', updated_at = now()
          WHERE id = $1 AND status IN ('triaged', 'assessing', 'on_hold')`,
        [episodeId],
      );

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'therapy_plan',
        rowId: asText(row['id']),
        businessKey: episodeId,
        dataClass: 'phi',
        patientId: null,
        encounterId: null,
        before: null,
        after: { version: asNumber(row['version']), items: body.items.length },
      });

      return this.toPlan(row);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Sessions
  // ═══════════════════════════════════════════════════════════════════════════

  async bookSession(episodeId: string, body: SessionRequest): Promise<SessionRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.therapy_sessions
           (id, hospital_id, branch_id, episode_id, patient_id, plan_id, seq, setting,
            status, scheduled_at, work_done, therapist_id, charge_intent_id, units,
            created_at, updated_at)
         VALUES ($1,$2,$3,$4,
                 (SELECT patient_id FROM specialty.therapy_episodes WHERE id = $4),
                 $5,
                 coalesce((SELECT max(seq) FROM specialty.therapy_sessions WHERE episode_id = $4), 0) + 1,
                 $6::specialty."TherapySetting",'scheduled',$7::timestamptz,$8::jsonb,$9,$10,$11,
                 now(), now())
         RETURNING *`,
        [
          newId(),
          this.hospitalId(),
          this.branchId(),
          episodeId,
          body.planId,
          body.setting,
          body.scheduledAt,
          JSON.stringify(body.workDone),
          this.actorId(),
          body.chargeIntentId ?? null,
          body.units ?? null,
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The session was not booked.');
      return this.toSession(row);
    });
  }

  /**
   * The session happened.
   *
   * The authorisation check fires here rather than at booking, because a booked
   * slot has not used anybody's package and a clinic books ahead. When it
   * refuses, the message names the number authorised and what to do — and the
   * event below tells the payer desk before the next patient is turned away.
   */
  async attend(id: string, body: AttendRequest): Promise<SessionRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE specialty.therapy_sessions
            SET status = 'attended', started_at = coalesce(started_at, now()),
                ended_at = now(), duration_min = $3,
                work_done = $4::jsonb, response = $5, homework = $6,
                pain_pre = $7, pain_post = $8, caregiver_present = $9,
                charge_intent_id = coalesce($10, charge_intent_id),
                updated_at = now()
          WHERE hospital_id = $1 AND id = $2 AND status = 'scheduled'
          RETURNING *`,
        [
          this.hospitalId(),
          id,
          body.durationMin,
          JSON.stringify(body.workDone),
          body.response ?? null,
          body.homework ?? null,
          body.painPre ?? null,
          body.painPost ?? null,
          body.caregiverPresent,
          body.chargeIntentId ?? null,
        ],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict('That session does not exist, or it is not waiting to be attended.');
      }

      const episode = await this.episodeWithin(tx, asText(row['episode_id']));

      // The last authorised session has been used. The person who can extend it
      // is at the payer desk, not on the therapy floor.
      if (episode.authorisationExhausted && episode.sessionsAuthorised !== null) {
        await this.outbox.publish(
          tx,
          consoleEvent('therapy.authorisation.exhausted', episode.id, {
            episodeId: episode.id,
            patientId: episode.patientId,
            discipline: episode.discipline,
            sessionsAuthorised: episode.sessionsAuthorised,
            sessionsDelivered: episode.sessionsDelivered,
          }),
        );
      }

      await this.audit.write(tx, {
        action: 'update',
        entity: 'therapy_session',
        rowId: id,
        businessKey: asText(row['episode_id']),
        dataClass: 'phi',
        patientId: asText(row['patient_id']),
        encounterId: null,
        before: null,
        after: { seq: asNumber(row['seq']), durationMin: body.durationMin },
      });

      return this.toSession(row);
    });
  }

  async markNoShow(id: string): Promise<SessionRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE specialty.therapy_sessions
            SET status = 'no_show', updated_at = now()
          WHERE hospital_id = $1 AND id = $2 AND status = 'scheduled'
          RETURNING *`,
        [this.hospitalId(), id],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict('That session does not exist, or it is not waiting to be attended.');
      }
      return this.toSession(row);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Shaping
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * The counts a therapist needs before booking the next appointment.
   *
   * Computed on read rather than kept on the row: a stored session count goes
   * stale the moment somebody corrects a no-show, and an anticoagulation-style
   * "we will just update it everywhere" is how two numbers appear.
   */
  private selectEpisode(): string {
    return `SELECT e.*,
              (SELECT count(*) FROM specialty.therapy_sessions s
                WHERE s.episode_id = e.id AND s.status = 'attended') AS sessions_delivered,
              (SELECT count(*) FROM specialty.therapy_goals g
                WHERE g.episode_id = e.id AND g.status = 'active') AS goals_open,
              (SELECT count(*) FROM specialty.therapy_goals g
                WHERE g.episode_id = e.id) AS goals_total
              FROM specialty.therapy_episodes e`;
  }

  private async episodeWithin(tx: TransactionClient, id: string): Promise<EpisodeRow> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `${this.selectEpisode()} WHERE e.hospital_id = $1 AND e.id = $2`,
      [this.hospitalId(), id],
    );
    const row = rows[0];
    if (row === undefined) throw AppError.notFound('That therapy episode does not exist.');
    return this.toEpisode(row);
  }

  private toEpisode(row: Record<string, unknown>): EpisodeRow {
    const authorised = asNumberOrNull(row['sessions_authorised']);
    const delivered = asNumber(row['sessions_delivered'] ?? 0);
    const goalsOpen = asNumber(row['goals_open'] ?? 0);
    const status = asText(row['status']);
    const remaining = authorised === null ? null : Math.max(0, authorised - delivered);

    // The same sentence the database would refuse with, offered forwards.
    let blocked: string | null = null;
    if (status !== 'discharged') {
      if (goalsOpen > 0) {
        blocked = `${String(goalsOpen)} goal${goalsOpen === 1 ? '' : 's'} still to be resolved`;
      }
    }

    return {
      id: asText(row['id']),
      patientId: asText(row['patient_id']),
      discipline: asText(row['discipline']),
      setting: asText(row['setting']),
      status,
      diagnosisIcd10: asTextOrNull(row['diagnosis_icd10']),
      precautions: asJson(row['precautions']),
      sessionsAuthorised: authorised,
      leadTherapistId: asTextOrNull(row['lead_therapist_id']),
      slaDueAt: asTextOrNull(row['sla_due_at']),
      openedAt: asText(row['opened_at']),
      closedAt: asTextOrNull(row['closed_at']),
      outcome: asTextOrNull(row['outcome']),
      sessionsDelivered: delivered,
      sessionsRemaining: remaining,
      authorisationExhausted: remaining !== null && remaining === 0,
      goalsOpen,
      goalsTotal: asNumber(row['goals_total'] ?? 0),
      dischargeBlockedBy: blocked,
    };
  }

  private toAssessment(row: Record<string, unknown>): AssessmentRow {
    return {
      id: asText(row['id']),
      episodeId: asText(row['episode_id']),
      kind: asText(row['kind']),
      findings: asJson(row['findings']),
      scores: asJson(row['scores']),
      impression: asTextOrNull(row['impression']),
      therapistId: asText(row['therapist_id']),
      signedBy: asTextOrNull(row['signed_by']),
      signedAt: asTextOrNull(row['signed_at']),
      createdAt: asText(row['created_at']),
    };
  }

  private toGoal(row: Record<string, unknown>): GoalRow {
    return {
      id: asText(row['id']),
      episodeId: asText(row['episode_id']),
      description: asText(row['description']),
      metric: asText(row['metric']),
      baseline: asText(row['baseline']),
      target: asText(row['target']),
      targetDate: asTextOrNull(row['target_date']),
      status: asText(row['status']),
      outcomeNote: asTextOrNull(row['outcome_note']),
      resolvedAt: asTextOrNull(row['resolved_at']),
    };
  }

  private toPlan(row: Record<string, unknown>): PlanRow {
    const items = row['items'];
    return {
      id: asText(row['id']),
      episodeId: asText(row['episode_id']),
      assessmentId: asText(row['assessment_id']),
      version: asNumber(row['version']),
      items: Array.isArray(items) ? (items as Record<string, unknown>[]) : [],
      frequencyPerWeek: asNumberOrNull(row['frequency_per_week']),
      sessionsPlanned: asNumberOrNull(row['sessions_planned']),
      status: asText(row['status']),
      signedBy: asTextOrNull(row['signed_by']),
      signedAt: asTextOrNull(row['signed_at']),
    };
  }

  private toSession(row: Record<string, unknown>): SessionRow {
    return {
      id: asText(row['id']),
      episodeId: asText(row['episode_id']),
      planId: asText(row['plan_id']),
      seq: asNumber(row['seq']),
      setting: asText(row['setting']),
      status: asText(row['status']),
      scheduledAt: asText(row['scheduled_at']),
      startedAt: asTextOrNull(row['started_at']),
      durationMin: asNumberOrNull(row['duration_min']),
      painPre: asNumberOrNull(row['pain_pre']),
      painPost: asNumberOrNull(row['pain_post']),
      therapistId: asText(row['therapist_id']),
      chargeIntentId: asTextOrNull(row['charge_intent_id']),
      units: asNumberOrNull(row['units']),
    };
  }
}
