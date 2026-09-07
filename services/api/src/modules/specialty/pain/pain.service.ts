import { Injectable } from '@nestjs/common';
import { newId } from '@vims/contracts';
import type { TransactionClient } from '../../../core/db/database.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { consoleEvent } from '../consoles/consoles.events.js';
import {
  ConsoleSupport,
  asBool,
  asJson,
  asNumber,
  asNumberOrNull,
  asStringArray,
  asText,
  asTextOrNull,
} from '../consoles/consoles.support.js';
import type {
  AgreementRequest,
  InterventionRequest,
  OpioidQuery,
  OpioidRequest,
  PainAssessmentRequest,
  PainEpisodeRequest,
  PainQuery,
  RevokeAgreementRequest,
  SecondReviewRequest,
} from './pain.schemas.js';
import type {
  AgreementRow,
  InterventionRow,
  OpioidRow,
  PainAssessmentRow,
  PainEpisodeDetail,
  PainEpisodeRow,
  PainThresholds,
} from './pain.types.js';

/** How close to expiry an agreement has to be before it is worth saying so. */
const AGREEMENT_WARNING_DAYS = 30;

/** How close to the annual ceiling before the clinic should know. */
const STEROID_WARNING_FRACTION = 0.75;

/**
 * OP-016 — the pain management clinic.
 *
 * ── Nothing here multiplies a dose by a conversion factor ──────────────────
 *
 * The morphine equivalent is a trigger's output, and so is which factor row it
 * used. A service that also converted would be a second author of the number
 * every opioid threshold is a line on — and the two would diverge the first
 * time a guideline was revised, in the direction nobody checks.
 *
 * ── The thresholds are read from the database ──────────────────────────────
 *
 * `thresholds()` asks Postgres what they are rather than carrying constants.
 * The alternative is two copies of "90", one in a trigger and one in a chip,
 * and a hospital that changes one of them.
 *
 * ── Countersigning is a different person's method ──────────────────────────
 *
 * `secondReview` takes the reviewer from the session and the database refuses
 * one who is the prescriber. Sending it in the prescription body would let the
 * prescriber name a colleague who has not looked at it, which is the failure
 * the threshold exists to catch with better paperwork.
 */
@Injectable()
export class PainService extends ConsoleSupport {
  // ═══════════════════════════════════════════════════════════════════════════
  // The episode
  // ═══════════════════════════════════════════════════════════════════════════

  async openEpisode(body: PainEpisodeRequest): Promise<PainEpisodeRow> {
    return this.guard(async (tx) => {
      const id = newId();
      await tx.query(
        `INSERT INTO specialty.pain_episodes
           (id, hospital_id, branch_id, patient_id, referral_id, type, mechanism,
            primary_dx_icd10, onset_date, sites, lead_physician_id, opioid_therapy,
            risk_scores, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6::specialty."PainType",$7::specialty."PainMechanism",
                 $8,$9::date,$10::jsonb,$11,$12,$13::jsonb,$14, now(), now())`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.patientId,
          body.referralId ?? null,
          body.type,
          body.mechanism ?? null,
          body.primaryDxIcd10 ?? null,
          body.onsetDate ?? null,
          JSON.stringify(body.sites),
          body.leadPhysicianId,
          body.opioidTherapy,
          JSON.stringify(body.riskScores),
          this.actorId(),
        ],
      );

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'pain_episode',
        rowId: id,
        businessKey: body.patientId,
        dataClass: 'phi',
        patientId: body.patientId,
        encounterId: null,
        before: null,
        after: { type: body.type, opioidTherapy: body.opioidTherapy },
      });

      return this.episodeWithin(tx, id);
    });
  }

  async listEpisodes(query: PainQuery): Promise<readonly PainEpisodeRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `${this.selectEpisode()}
          WHERE e.hospital_id = $1
            AND ($2::uuid IS NULL OR e.patient_id = $2::uuid)
            AND ($3::boolean IS NOT TRUE OR e.status = 'active')
            AND ($4::boolean IS NOT TRUE OR e.opioid_therapy)
          ORDER BY e.created_at DESC
          LIMIT $5`,
        [this.hospitalId(), query.patientId ?? null, query.openOnly, query.opioidOnly, query.limit],
      );
      return rows.map((r) => this.toEpisode(r));
    });
  }

  async episodeDetail(id: string): Promise<PainEpisodeDetail> {
    return this.guard(async (tx) => {
      const episode = await this.episodeWithin(tx, id);
      const [assessments, agreements, opioids, interventions] = await Promise.all([
        tx.query<Record<string, unknown>>(
          `SELECT * FROM specialty.pain_assessments WHERE episode_id = $1
            ORDER BY recorded_at DESC LIMIT 100`,
          [id],
        ),
        tx.query<Record<string, unknown>>(
          `SELECT * FROM specialty.opioid_agreements WHERE episode_id = $1 ORDER BY signed_at DESC`,
          [id],
        ),
        tx.query<Record<string, unknown>>(
          `SELECT * FROM specialty.opioid_prescription_log WHERE episode_id = $1
            ORDER BY start_date DESC LIMIT 200`,
          [id],
        ),
        tx.query<Record<string, unknown>>(
          `SELECT * FROM specialty.pain_interventions WHERE episode_id = $1
            ORDER BY performed_at DESC LIMIT 100`,
          [id],
        ),
      ]);

      return {
        episode,
        assessments: assessments.rows.map((r) => this.toAssessment(r)),
        agreements: agreements.rows.map((r) => this.toAgreement(r)),
        opioids: opioids.rows.map((r) => this.toOpioid(r)),
        interventions: interventions.rows.map((r) => this.toIntervention(r)),
      };
    });
  }

  async recordAssessment(episodeId: string, body: PainAssessmentRequest): Promise<PainAssessmentRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.pain_assessments
           (id, hospital_id, episode_id, encounter_id, kind, nrs_now, nrs_avg, nrs_worst,
            nrs_least, scale, instruments, sleep, pgic, work_status, side_effects,
            form_response_id, recorded_at, recorded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15::jsonb,$16, now(), $17)
         RETURNING *`,
        [
          newId(),
          this.hospitalId(),
          episodeId,
          body.encounterId ?? null,
          body.kind,
          body.nrsNow ?? null,
          body.nrsAvg ?? null,
          body.nrsWorst ?? null,
          body.nrsLeast ?? null,
          body.scale,
          JSON.stringify(body.instruments),
          body.sleep ?? null,
          body.pgic ?? null,
          body.workStatus ?? null,
          JSON.stringify(body.sideEffects),
          body.formResponseId ?? null,
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The assessment was not recorded.');
      return this.toAssessment(row);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The agreement
  // ═══════════════════════════════════════════════════════════════════════════

  async signAgreement(episodeId: string, body: AgreementRequest): Promise<AgreementRow> {
    return this.guard(async (tx) => {
      const id = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.opioid_agreements
           (id, hospital_id, patient_id, episode_id, consent_id, terms_version,
            signed_at, valid_to, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6, now(), $7::date, $8, now(), now())
         RETURNING *`,
        [
          id,
          this.hospitalId(),
          body.patientId,
          episodeId,
          body.consentId ?? null,
          body.termsVersion,
          body.validTo,
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The agreement was not recorded.');

      await this.audit.write(tx, {
        action: 'sign',
        entity: 'opioid_agreement',
        rowId: id,
        businessKey: body.patientId,
        dataClass: 'phi',
        patientId: body.patientId,
        encounterId: null,
        before: null,
        after: { termsVersion: body.termsVersion, validTo: body.validTo },
      });

      return this.toAgreement(row);
    });
  }

  /**
   * End the agreement.
   *
   * Every further opioid on the episode is refused from here, so the reason is
   * mandatory and travels to the audit: a clinic that revokes an agreement has
   * to be able to explain it to the patient, who will be at the counter when
   * their next prescription is refused.
   */
  async revokeAgreement(id: string, body: RevokeAgreementRequest): Promise<AgreementRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE specialty.opioid_agreements
            SET status = 'revoked', revoked_at = now(), revoked_reason = $3, updated_at = now()
          WHERE hospital_id = $1 AND id = $2 AND status = 'active'
          RETURNING *`,
        [this.hospitalId(), id, body.reason],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict('That agreement does not exist, or it is not in force.');
      }

      await this.audit.write(tx, {
        // The audit vocabulary has no `revoke`; ending an agreement is an
        // override of the ordinary course, and it carries its reason.
        action: 'override',
        entity: 'opioid_agreement',
        rowId: id,
        businessKey: asText(row['patient_id']),
        dataClass: 'phi',
        patientId: asText(row['patient_id']),
        encounterId: null,
        reasonText: body.reason,
        before: { status: 'active' },
        after: { status: 'revoked' },
      });

      return this.toAgreement(row);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Opioids
  // ═══════════════════════════════════════════════════════════════════════════

  async prescribe(episodeId: string, body: OpioidRequest): Promise<OpioidRow> {
    return this.guard(async (tx) => {
      const id = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.opioid_prescription_log
           (id, hospital_id, branch_id, patient_id, episode_id, rx_id, drug_key, drug_name,
            route, strength, daily_dose, dose_unit, days_supply, quantity, start_date,
            justification, naloxone_prescribed, naloxone_declined, uds_last_at,
            prescriber_id, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::date,$16,$17,$18,
                 $19::date,$20, now(), now())
         RETURNING *`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.patientId,
          episodeId,
          body.rxId ?? null,
          body.drugKey,
          body.drugName,
          body.route,
          body.strength,
          body.dailyDose,
          body.doseUnit,
          body.daysSupply,
          body.quantity,
          body.startDate,
          body.justification ?? null,
          body.naloxonePrescribed,
          body.naloxoneDeclined ?? null,
          body.udsLastAt ?? null,
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The prescription was not recorded.');

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'opioid_prescription',
        rowId: id,
        businessKey: body.patientId,
        dataClass: 'phi',
        patientId: body.patientId,
        encounterId: null,
        before: null,
        // The audit records the equivalent the database computed, not the dose
        // that was typed: the MME is what any later review is conducted against.
        after: {
          drug: body.drugKey,
          dailyDose: body.dailyDose,
          mme: asNumberOrNull(row['mme']),
          naloxone: body.naloxonePrescribed,
        },
      });

      return this.toOpioid(row);
    });
  }

  /**
   * Countersign a prescription at or above the review threshold.
   *
   * Deliberately an update to a row that already exists rather than part of the
   * insert: the prescription is written, refused if it needed a review it did
   * not have, and this is how it gets one — from a second person, at a second
   * moment, in their own session.
   */
  async secondReview(id: string, body: SecondReviewRequest): Promise<OpioidRow> {
    return this.guard(async (tx) => {
      const { rows: existing } = await tx.query<Record<string, unknown>>(
        `SELECT prescriber_id, patient_id, episode_id, drug_key, mme
           FROM specialty.opioid_prescription_log WHERE hospital_id = $1 AND id = $2`,
        [this.hospitalId(), id],
      );
      const rx = existing[0];
      if (rx === undefined) throw AppError.notFound('That prescription does not exist.');

      // The database refuses this too. Saying it here means the reviewer sees a
      // sentence rather than a constraint name.
      if (asText(rx['prescriber_id']) === this.actorId()) {
        throw AppError.conflict(
          'A prescription cannot be countersigned by the person who wrote it. The review is a second prescriber looking at the dose.',
        );
      }

      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE specialty.opioid_prescription_log
            SET second_reviewer_id = $3, second_reviewed_at = now(),
                justification = $4, updated_at = now()
          WHERE hospital_id = $1 AND id = $2
          RETURNING *`,
        [this.hospitalId(), id, this.actorId(), body.justification],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.notFound('That prescription does not exist.');

      await this.outbox.publish(
        tx,
        consoleEvent('pain.opioid.high_dose', id, {
          logId: id,
          patientId: asText(row['patient_id']),
          episodeId: asText(row['episode_id']),
          drugKey: asText(row['drug_key']),
          mme: String(asNumberOrNull(row['mme']) ?? 0),
          prescriberId: asText(row['prescriber_id']),
          secondReviewerId: this.actorId(),
        }),
      );

      await this.audit.write(tx, {
        action: 'approve',
        entity: 'opioid_prescription',
        rowId: id,
        businessKey: asText(row['patient_id']),
        dataClass: 'phi',
        patientId: asText(row['patient_id']),
        encounterId: null,
        reasonText: body.justification,
        before: null,
        after: { mme: asNumberOrNull(row['mme']), reviewedBy: this.actorId() },
      });

      return this.toOpioid(row);
    });
  }

  async listOpioids(query: OpioidQuery): Promise<readonly OpioidRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM specialty.opioid_prescription_log
          WHERE hospital_id = $1
            AND ($2::uuid IS NULL OR patient_id = $2::uuid)
            AND ($3::boolean IS NOT TRUE OR mme >= specialty.mme_second_review_threshold())
          ORDER BY start_date DESC, created_at DESC
          LIMIT $4`,
        [this.hospitalId(), query.patientId ?? null, query.highDoseOnly, query.limit],
      );
      return rows.map((r) => this.toOpioid(r));
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Interventions
  // ═══════════════════════════════════════════════════════════════════════════

  async performIntervention(episodeId: string, body: InterventionRequest): Promise<InterventionRow> {
    return this.guard(async (tx) => {
      const id = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.pain_interventions
           (id, hospital_id, branch_id, patient_id, episode_id, procedure_id,
            intervention_code, name, levels, side, guidance, drugs, steroid_mg_equiv,
            rf_params, contrast_pattern, fluoro_sec, dose_mgy, nrs_pre, nrs_post_30min,
            sensory_block, complications, outcome, performed_by, performed_at,
            created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::clinical."Laterality",$11,
                 $12::jsonb,$13,$14::jsonb,$15,$16,$17,$18,$19,$20,$21::jsonb,
                 $22::specialty."InterventionOutcome",$23, now(), now(), now())
         RETURNING *`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.patientId,
          episodeId,
          body.procedureId ?? null,
          body.interventionCode,
          body.name,
          JSON.stringify(body.levels),
          body.side,
          body.guidance,
          JSON.stringify(body.drugs),
          body.steroidMgEquiv ?? null,
          JSON.stringify(body.rfParams),
          body.contrastPattern ?? null,
          body.fluoroSec ?? null,
          body.doseMgy ?? null,
          body.nrsPre ?? null,
          body.nrsPost30min ?? null,
          body.sensoryBlock ?? null,
          JSON.stringify(body.complications),
          body.outcome ?? null,
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The intervention was not recorded.');

      // The clinic books weeks ahead, so a patient approaching the ceiling has
      // to be known now rather than when the next injection is refused.
      if (body.steroidMgEquiv !== undefined && body.steroidMgEquiv > 0) {
        const thresholds = await this.thresholdsWithin(tx);
        const { rows: exposure } = await tx.query<Record<string, unknown>>(
          `SELECT year, cumulative_mg, injections FROM specialty.pain_steroid_exposure
            WHERE hospital_id = $1 AND patient_id = $2
              AND year = extract(year FROM now())::int`,
          [this.hospitalId(), body.patientId],
        );
        const total = asNumber(exposure[0]?.['cumulative_mg'] ?? 0);
        if (total >= thresholds.annualSteroidCeilingMg * STEROID_WARNING_FRACTION) {
          await this.outbox.publish(
            tx,
            consoleEvent('pain.steroid.ceiling_near', body.patientId, {
              patientId: body.patientId,
              year: asNumber(exposure[0]?.['year'] ?? new Date().getFullYear()),
              cumulativeMg: String(total),
              ceilingMg: String(thresholds.annualSteroidCeilingMg),
              injections: asNumber(exposure[0]?.['injections'] ?? 0),
            }),
          );
        }
      }

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'pain_intervention',
        rowId: id,
        businessKey: body.patientId,
        dataClass: 'phi',
        patientId: body.patientId,
        encounterId: null,
        before: null,
        after: {
          code: body.interventionCode,
          steroidMg: body.steroidMgEquiv ?? null,
          outcome: body.outcome ?? null,
        },
      });

      return this.toIntervention(row);
    });
  }

  /**
   * What the thresholds currently are.
   *
   * Read from the database rather than carried as constants, so a chip on a
   * screen and the trigger that refuses cannot be two different numbers.
   */
  async thresholds(): Promise<PainThresholds> {
    return this.guard((tx) => this.thresholdsWithin(tx));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Shaping
  // ═══════════════════════════════════════════════════════════════════════════

  private async thresholdsWithin(tx: TransactionClient): Promise<PainThresholds> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT specialty.mme_naloxone_threshold() AS naloxone,
              specialty.mme_second_review_threshold() AS review,
              specialty.annual_steroid_ceiling_mg() AS steroid`,
      [],
    );
    const row = rows[0];
    return {
      naloxoneMme: asNumber(row?.['naloxone'] ?? 50),
      secondReviewMme: asNumber(row?.['review'] ?? 90),
      annualSteroidCeilingMg: asNumber(row?.['steroid'] ?? 400),
    };
  }

  /**
   * The three facts a pain clinic needs about an episode that no consultation
   * can see: the total daily equivalent across every live prescription, the
   * agreement's remaining life, and this year's steroid.
   */
  private selectEpisode(): string {
    return `SELECT e.*,
              (SELECT sum(l.mme) FROM specialty.opioid_prescription_log l
                WHERE l.episode_id = e.id
                  AND l.start_date <= current_date
                  AND (l.end_date IS NULL OR l.end_date >= current_date)) AS current_daily_mme,
              (SELECT a.valid_to FROM specialty.opioid_agreements a
                WHERE a.episode_id = e.id AND a.status = 'active'
                ORDER BY a.valid_to DESC LIMIT 1) AS agreement_valid_to,
              coalesce((SELECT x.cumulative_mg FROM specialty.pain_steroid_exposure x
                WHERE x.hospital_id = e.hospital_id AND x.patient_id = e.patient_id
                  AND x.year = extract(year FROM now())::int), 0) AS steroid_mg_this_year,
              specialty.mme_second_review_threshold() AS review_threshold,
              specialty.annual_steroid_ceiling_mg() AS steroid_ceiling
              FROM specialty.pain_episodes e`;
  }

  private async episodeWithin(tx: TransactionClient, id: string): Promise<PainEpisodeRow> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `${this.selectEpisode()} WHERE e.hospital_id = $1 AND e.id = $2`,
      [this.hospitalId(), id],
    );
    const row = rows[0];
    if (row === undefined) throw AppError.notFound('That pain episode does not exist.');
    return this.toEpisode(row);
  }

  private static daysUntil(date: string | null): number | null {
    if (date === null || date === '') return null;
    const days = Math.floor((Date.parse(date) - Date.now()) / 86_400_000);
    return Number.isNaN(days) ? null : days;
  }

  private toEpisode(row: Record<string, unknown>): PainEpisodeRow {
    const mme = asNumberOrNull(row['current_daily_mme']);
    const reviewAt = asNumber(row['review_threshold'] ?? 90);
    const ceiling = asNumber(row['steroid_ceiling'] ?? 400);
    const steroid = asNumber(row['steroid_mg_this_year'] ?? 0);
    const validTo = asTextOrNull(row['agreement_valid_to']);
    const type = asText(row['type']);
    const sites = row['sites'];

    return {
      id: asText(row['id']),
      patientId: asText(row['patient_id']),
      type,
      mechanism: asTextOrNull(row['mechanism']),
      primaryDxIcd10: asTextOrNull(row['primary_dx_icd10']),
      sites: Array.isArray(sites) ? (sites as Record<string, unknown>[]) : [],
      leadPhysicianId: asText(row['lead_physician_id']),
      opioidTherapy: asBool(row['opioid_therapy']),
      riskScores: asJson(row['risk_scores']),
      status: asText(row['status']),
      openedAt: asText(row['created_at']),
      currentDailyMme: mme,
      aboveReviewThreshold: mme !== null && mme >= reviewAt,
      agreementValidTo: validTo,
      agreementDaysRemaining: PainService.daysUntil(validTo),
      // Only chronic and cancer episodes need one; the acute pain service is a
      // different governance world and the trigger agrees.
      agreementMissing: (type === 'chronic' || type === 'cancer') && validTo === null,
      steroidMgThisYear: steroid,
      steroidMgRemaining: Math.max(0, ceiling - steroid),
    };
  }

  private toAssessment(row: Record<string, unknown>): PainAssessmentRow {
    return {
      id: asText(row['id']),
      episodeId: asText(row['episode_id']),
      kind: asText(row['kind']),
      nrsNow: asNumberOrNull(row['nrs_now']),
      nrsAvg: asNumberOrNull(row['nrs_avg']),
      nrsWorst: asNumberOrNull(row['nrs_worst']),
      nrsLeast: asNumberOrNull(row['nrs_least']),
      scale: asText(row['scale']),
      instruments: asJson(row['instruments']),
      pgic: asNumberOrNull(row['pgic']),
      recordedAt: asText(row['recorded_at']),
      recordedBy: asText(row['recorded_by']),
    };
  }

  private toAgreement(row: Record<string, unknown>): AgreementRow {
    const validTo = asText(row['valid_to']);
    const days = PainService.daysUntil(validTo);
    const status = asText(row['status']);
    return {
      id: asText(row['id']),
      patientId: asText(row['patient_id']),
      episodeId: asText(row['episode_id']),
      termsVersion: asText(row['terms_version']),
      signedAt: asText(row['signed_at']),
      validTo,
      status,
      revokedAt: asTextOrNull(row['revoked_at']),
      revokedReason: asTextOrNull(row['revoked_reason']),
      daysRemaining: days,
      expiringSoon: status === 'active' && days !== null && days <= AGREEMENT_WARNING_DAYS,
    };
  }

  private toOpioid(row: Record<string, unknown>): OpioidRow {
    const mme = asNumberOrNull(row['mme']);
    const start = asText(row['start_date']);
    const end = asTextOrNull(row['end_date']);
    const today = Date.now();

    return {
      id: asText(row['id']),
      patientId: asText(row['patient_id']),
      episodeId: asText(row['episode_id']),
      drugKey: asText(row['drug_key']),
      drugName: asText(row['drug_name']),
      route: asText(row['route']),
      strength: asText(row['strength']),
      dailyDose: asNumber(row['daily_dose']),
      doseUnit: asText(row['dose_unit']),
      mme,
      conversionFactorId: asTextOrNull(row['conversion_factor_id']),
      daysSupply: asNumber(row['days_supply']),
      quantity: asNumber(row['quantity']),
      startDate: start,
      endDate: end,
      agreementId: asTextOrNull(row['agreement_id']),
      justification: asTextOrNull(row['justification']),
      secondReviewerId: asTextOrNull(row['second_reviewer_id']),
      secondReviewedAt: asTextOrNull(row['second_reviewed_at']),
      naloxonePrescribed: asBool(row['naloxone_prescribed']),
      naloxoneDeclined: asTextOrNull(row['naloxone_declined']),
      prescriberId: asText(row['prescriber_id']),
      createdAt: asText(row['created_at']),
      // Both read off the stored MME, so a chip and a refusal are one number.
      aboveNaloxoneThreshold: mme !== null && mme >= 50,
      aboveReviewThreshold: mme !== null && mme >= 90,
      active: Date.parse(start) <= today && (end === null || Date.parse(end) >= today),
    };
  }

  private toIntervention(row: Record<string, unknown>): InterventionRow {
    const pre = asNumberOrNull(row['nrs_pre']);
    const post = asNumberOrNull(row['nrs_post_30min']);
    const levels = row['levels'];

    return {
      id: asText(row['id']),
      patientId: asText(row['patient_id']),
      episodeId: asText(row['episode_id']),
      interventionCode: asText(row['intervention_code']),
      name: asText(row['name']),
      levels: Array.isArray(levels) ? asStringArray(levels) : [],
      side: asText(row['side']),
      guidance: asText(row['guidance']),
      steroidMgEquiv: asNumberOrNull(row['steroid_mg_equiv']),
      nrsPre: pre,
      nrsPost30min: post,
      outcome: asTextOrNull(row['outcome']),
      performedBy: asText(row['performed_by']),
      performedAt: asText(row['performed_at']),
      reliefPoints: pre === null || post === null ? null : pre - post,
    };
  }
}
