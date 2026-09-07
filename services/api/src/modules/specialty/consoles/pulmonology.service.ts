import { Injectable } from '@nestjs/common';
import { newId } from '@vims/contracts';
import { AppError } from '../../../core/problem/app-error.js';
import { consoleEvent } from './consoles.events.js';
import type {
  OpenQuery,
  PapComplianceRequest,
  PapRxRequest,
  PatientQuery,
  PftInterpretRequest,
  PftStudyRequest,
  PulmoConsultRequest,
  SleepScoreRequest,
  SleepStudyRequest,
} from './consoles.schemas.js';
import {
  ConsoleSupport,
  asBoolOrNull,
  asJson,
  asNumberOrNull,
  asStringArray,
  asText,
  asTextOrNull,
} from './consoles.support.js';
import type { PapRxRow, PftRow, PulmoConsultRow, SleepStudyRow } from './consoles.types.js';

/**
 * The fixed-ratio line for airflow obstruction.
 *
 * GOLD's 0.70 rather than a lower-limit-of-normal cut, because it is what the
 * reference equations in `predicted` may or may not supply and this chip has to
 * mean the same thing on every study. The interpretation is a clinician's;
 * this is a flag on a list.
 */
const OBSTRUCTION_RATIO = 0.7;

/** The insurer's line: four hours a night on seven nights in ten. */
const ADHERENCE_PCT_NIGHTS = 70;

/**
 * OP-030 — the pulmonology console.
 *
 * ── Nothing here divides FEV1 by FVC ────────────────────────────────────────
 *
 * The ratio, the reversibility and the severity band are all trigger output.
 * The service reads them; it never produces them. The one thing it does compute
 * is `obstructed`, and that is a display chip derived from the stored ratio —
 * not a second opinion about what the ratio is.
 *
 * ── Signing is where the quality grade bites ────────────────────────────────
 *
 * `interpretPft` sends the grade with the interpretation, because the two
 * arrive together in real life: the person interpreting the study is the person
 * who decides whether the effort was acceptable. The database then refuses to
 * sign an `F`, and the refusal reaches the screen as a sentence about repeating
 * the manoeuvre rather than a constraint name.
 */
@Injectable()
export class PulmonologyService extends ConsoleSupport {
  // ═══════════════════════════════════════════════════════════════════════════
  // The consultation
  // ═══════════════════════════════════════════════════════════════════════════

  async recordConsult(body: PulmoConsultRequest): Promise<PulmoConsultRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.pulmo_consults
           (id, hospital_id, branch_id, patient_id, encounter_id, smoking, exposures,
            scores, gold_group, gina_step, dx_codes, plan, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11::text[],$12::jsonb,$13, now(), now())
         ON CONFLICT (encounter_id) DO UPDATE
           SET smoking = EXCLUDED.smoking, exposures = EXCLUDED.exposures,
               scores = EXCLUDED.scores, gold_group = EXCLUDED.gold_group,
               gina_step = EXCLUDED.gina_step, dx_codes = EXCLUDED.dx_codes,
               plan = EXCLUDED.plan,
               version = specialty.pulmo_consults.version + 1, updated_at = now()
         RETURNING *`,
        [
          newId(),
          this.hospitalId(),
          this.branchId(),
          body.patientId,
          body.encounterId,
          JSON.stringify(body.smoking),
          JSON.stringify(body.exposures),
          JSON.stringify(body.scores),
          body.goldGroup ?? null,
          body.ginaStep ?? null,
          body.dxCodes,
          JSON.stringify(body.plan),
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The consultation was not recorded.');

      await this.audit.write(tx, {
        action: 'update',
        entity: 'pulmo_consult',
        rowId: asText(row['id']),
        businessKey: body.encounterId,
        dataClass: 'phi',
        patientId: body.patientId,
        encounterId: body.encounterId,
        before: null,
        after: { goldGroup: body.goldGroup ?? null, ginaStep: body.ginaStep ?? null },
      });

      return this.toConsult(row);
    });
  }

  async signConsult(id: string): Promise<PulmoConsultRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE specialty.pulmo_consults
            SET signed_by = $3, signed_at = now(), updated_at = now()
          WHERE hospital_id = $1 AND id = $2 AND signed_at IS NULL
          RETURNING *`,
        [this.hospitalId(), id, this.actorId()],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict('That consultation does not exist, or it is already signed.');
      }
      await this.audit.write(tx, {
        action: 'sign',
        entity: 'pulmo_consult',
        rowId: id,
        businessKey: asText(row['encounter_id']),
        dataClass: 'phi',
        patientId: asText(row['patient_id']),
        encounterId: asText(row['encounter_id']),
        before: null,
        after: { signedAt: asText(row['signed_at']) },
      });
      return this.toConsult(row);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Pulmonary function
  // ═══════════════════════════════════════════════════════════════════════════

  async recordPft(body: PftStudyRequest): Promise<PftRow> {
    return this.guard(async (tx) => {
      const id = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.pulmo_pft_studies
           (id, hospital_id, branch_id, patient_id, encounter_id, device_order_id, tests,
            source, performed_at, tech_id, demographics, quality_grade,
            pre_fvc, pre_fev1, pre_pef, post_fvc, post_fev1,
            predicted, dlco, volumes, feno_ppb, sixmwt, curves_key,
            status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::text[],$8,$9::timestamptz,$10,$11::jsonb,$12,
                 $13,$14,$15,$16,$17,$18::jsonb,$19::jsonb,$20::jsonb,$21,$22::jsonb,$23,
                 'performed', now(), now())
         RETURNING *`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.patientId,
          body.encounterId ?? null,
          body.deviceOrderId ?? null,
          body.tests,
          body.source,
          body.performedAt,
          body.techId ?? this.actorId(),
          JSON.stringify(body.demographics),
          body.qualityGrade ?? null,
          body.preFvc ?? null,
          body.preFev1 ?? null,
          body.prePef ?? null,
          body.postFvc ?? null,
          body.postFev1 ?? null,
          JSON.stringify(body.predicted),
          JSON.stringify(body.dlco),
          JSON.stringify(body.volumes),
          body.fenoPpb ?? null,
          JSON.stringify(body.sixmwt),
          body.curvesKey ?? null,
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The study was not recorded.');

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'pulmo_pft',
        rowId: id,
        businessKey: body.patientId,
        dataClass: 'phi',
        patientId: body.patientId,
        encounterId: body.encounterId ?? null,
        before: null,
        after: {
          qualityGrade: body.qualityGrade ?? null,
          preRatio: asNumberOrNull(row['pre_ratio']),
          reversible: asBoolOrNull(row['reversible']),
        },
      });

      return this.toPft(row);
    });
  }

  async interpretPft(id: string, body: PftInterpretRequest): Promise<PftRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE specialty.pulmo_pft_studies
            SET interpretation = $3, quality_grade = $4, status = 'interpreted',
                signed_by = $5, signed_at = now(), updated_at = now()
          WHERE hospital_id = $1 AND id = $2
          RETURNING *`,
        [this.hospitalId(), id, body.interpretation, body.qualityGrade, this.actorId()],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.notFound('That study does not exist.');

      await this.outbox.publish(
        tx,
        consoleEvent('pulmo.pft.signed', id, {
          studyId: id,
          patientId: asText(row['patient_id']),
          qualityGrade: body.qualityGrade,
          preRatio: asTextOrNull(row['pre_ratio']),
          reversible: asBoolOrNull(row['reversible']),
          signedBy: this.actorId(),
        }),
      );

      await this.audit.write(tx, {
        action: 'sign',
        entity: 'pulmo_pft',
        rowId: id,
        businessKey: asText(row['patient_id']),
        dataClass: 'phi',
        patientId: asText(row['patient_id']),
        encounterId: asTextOrNull(row['encounter_id']),
        before: null,
        after: { qualityGrade: body.qualityGrade },
      });

      return this.toPft(row);
    });
  }

  async listPfts(query: PatientQuery): Promise<readonly PftRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM specialty.pulmo_pft_studies
          WHERE hospital_id = $1 AND ($2::uuid IS NULL OR patient_id = $2::uuid)
          ORDER BY performed_at DESC LIMIT $3`,
        [this.hospitalId(), query.patientId ?? null, query.limit],
      );
      return rows.map((r) => this.toPft(r));
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Sleep
  // ═══════════════════════════════════════════════════════════════════════════

  async scheduleSleepStudy(body: SleepStudyRequest): Promise<SleepStudyRow> {
    return this.guard(async (tx) => {
      const id = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.pulmo_sleep_studies
           (id, hospital_id, branch_id, patient_id, type, bed_id, scheduled_at,
            tech_id, device_serial, hookup_checklist, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5::specialty."SleepStudyType",$6,$7::timestamptz,$8,$9,$10::jsonb,$11, now(), now())
         RETURNING *`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.patientId,
          body.type,
          body.bedId ?? null,
          body.scheduledAt,
          body.techId ?? null,
          body.deviceSerial ?? null,
          JSON.stringify(body.hookupChecklist),
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The sleep study was not scheduled.');
      return this.toSleep(row);
    });
  }

  async scoreSleepStudy(id: string, body: SleepScoreRequest): Promise<SleepStudyRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE specialty.pulmo_sleep_studies
            SET ahi = $3, scored = $4::jsonb, interpretation = $5,
                status = 'scored', updated_at = now()
          WHERE hospital_id = $1 AND id = $2
          RETURNING *`,
        [this.hospitalId(), id, body.ahi, JSON.stringify(body.scored), body.interpretation ?? null],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.notFound('That sleep study does not exist.');

      await this.audit.write(tx, {
        action: 'update',
        entity: 'pulmo_sleep_study',
        rowId: id,
        businessKey: asText(row['patient_id']),
        dataClass: 'phi',
        patientId: asText(row['patient_id']),
        encounterId: null,
        before: null,
        // The severity is the trigger's, and the audit records what the
        // database concluded rather than what the scorer thought it would.
        after: { ahi: body.ahi, severity: asTextOrNull(row['severity']) },
      });

      return this.toSleep(row);
    });
  }

  async signSleepStudy(id: string): Promise<SleepStudyRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE specialty.pulmo_sleep_studies
            SET signed_by = $3, signed_at = now(), status = 'reported', updated_at = now()
          WHERE hospital_id = $1 AND id = $2 AND signed_at IS NULL
          RETURNING *`,
        [this.hospitalId(), id, this.actorId()],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict('That study does not exist, or it is already signed.');
      }
      return this.toSleep(row);
    });
  }

  async listSleepStudies(query: OpenQuery): Promise<readonly SleepStudyRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM specialty.pulmo_sleep_studies
          WHERE hospital_id = $1
            AND ($2::uuid IS NULL OR patient_id = $2::uuid)
            AND ($3::boolean IS NOT TRUE OR signed_at IS NULL)
          ORDER BY scheduled_at DESC LIMIT $4`,
        [this.hospitalId(), query.patientId ?? null, query.openOnly, query.limit],
      );
      return rows.map((r) => this.toSleep(r));
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Positive airway pressure
  // ═══════════════════════════════════════════════════════════════════════════

  async prescribePap(body: PapRxRequest): Promise<PapRxRow> {
    return this.guard(async (tx) => {
      const id = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.pulmo_pap_prescriptions
           (id, hospital_id, branch_id, patient_id, study_id, mode,
            pressure_cm, pressure_min, pressure_max, epap, ipap,
            mask, humidifier, device_item_id, serial, ownership, start_date,
            prescribed_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6::specialty."PapMode",$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
                 $17::date,$18, now(), now())
         RETURNING *, NULL::boolean AS adherent`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.patientId,
          body.studyId ?? null,
          body.mode,
          body.pressureCm ?? null,
          body.pressureMin ?? null,
          body.pressureMax ?? null,
          body.epap ?? null,
          body.ipap ?? null,
          body.mask ?? null,
          body.humidifier,
          body.deviceItemId ?? null,
          body.serial ?? null,
          body.ownership,
          body.startDate,
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The prescription was not created.');

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'pulmo_pap_rx',
        rowId: id,
        businessKey: body.patientId,
        dataClass: 'phi',
        patientId: body.patientId,
        encounterId: null,
        before: null,
        after: { mode: body.mode },
      });

      return this.toPap(row);
    });
  }

  async recordCompliance(rxId: string, body: PapComplianceRequest): Promise<PapRxRow> {
    return this.guard(async (tx) => {
      await tx.query(
        `INSERT INTO specialty.pulmo_pap_compliance
           (id, hospital_id, rx_id, period_from, period_to, usage_hours_avg,
            pct_nights_ge4h, residual_ahi, leak, source, report_key,
            reviewed_by, reviewed_at, created_at)
         VALUES ($1,$2,$3,$4::date,$5::date,$6,$7,$8,$9,$10,$11,$12, now(), now())`,
        [
          newId(),
          this.hospitalId(),
          rxId,
          body.periodFrom,
          body.periodTo,
          body.usageHoursAvg,
          body.pctNightsGe4h,
          body.residualAhi ?? null,
          body.leak ?? null,
          body.source,
          body.reportKey ?? null,
          this.actorId(),
        ],
      );

      const { rows } = await tx.query<Record<string, unknown>>(
        `${this.selectPap()} WHERE p.hospital_id = $1 AND p.id = $2`,
        [this.hospitalId(), rxId],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.notFound('That prescription does not exist.');
      return this.toPap(row);
    });
  }

  async listPapRx(query: PatientQuery): Promise<readonly PapRxRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `${this.selectPap()}
          WHERE p.hospital_id = $1 AND ($2::uuid IS NULL OR p.patient_id = $2::uuid)
          ORDER BY p.start_date DESC LIMIT $3`,
        [this.hospitalId(), query.patientId ?? null, query.limit],
      );
      return rows.map((r) => this.toPap(r));
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Shaping
  // ═══════════════════════════════════════════════════════════════════════════

  private selectPap(): string {
    return `SELECT p.*,
              (SELECT c.pct_nights_ge4h >= ${ADHERENCE_PCT_NIGHTS}
                 FROM specialty.pulmo_pap_compliance c
                WHERE c.rx_id = p.id
                ORDER BY c.period_to DESC LIMIT 1) AS adherent
              FROM specialty.pulmo_pap_prescriptions p`;
  }

  private toConsult(row: Record<string, unknown>): PulmoConsultRow {
    return {
      id: asText(row['id']),
      patientId: asText(row['patient_id']),
      encounterId: asText(row['encounter_id']),
      goldGroup: asTextOrNull(row['gold_group']),
      ginaStep: asNumberOrNull(row['gina_step']),
      scores: asJson(row['scores']),
      dxCodes: asStringArray(row['dx_codes']),
      signedBy: asTextOrNull(row['signed_by']),
      signedAt: asTextOrNull(row['signed_at']),
      createdAt: asText(row['created_at']),
    };
  }

  private toPft(row: Record<string, unknown>): PftRow {
    const grade = asTextOrNull(row['quality_grade']);
    const preRatio = asNumberOrNull(row['pre_ratio']);
    const postRatio = asNumberOrNull(row['post_ratio']);
    const ratio = postRatio ?? preRatio;
    return {
      id: asText(row['id']),
      patientId: asText(row['patient_id']),
      performedAt: asText(row['performed_at']),
      tests: asStringArray(row['tests']),
      qualityGrade: grade,
      preFvc: asNumberOrNull(row['pre_fvc']),
      preFev1: asNumberOrNull(row['pre_fev1']),
      preRatio,
      postFvc: asNumberOrNull(row['post_fvc']),
      postFev1: asNumberOrNull(row['post_fev1']),
      postRatio,
      revFev1Pct: asNumberOrNull(row['rev_fev1_pct']),
      revFev1Ml: asNumberOrNull(row['rev_fev1_ml']),
      reversible: asBoolOrNull(row['reversible']),
      interpretation: asTextOrNull(row['interpretation']),
      status: asText(row['status']),
      signedBy: asTextOrNull(row['signed_by']),
      signedAt: asTextOrNull(row['signed_at']),
      unsignable: grade !== null && grade.toUpperCase() === 'F',
      obstructed: ratio === null ? null : ratio < OBSTRUCTION_RATIO,
    };
  }

  private toSleep(row: Record<string, unknown>): SleepStudyRow {
    return {
      id: asText(row['id']),
      patientId: asText(row['patient_id']),
      type: asText(row['type']),
      scheduledAt: asText(row['scheduled_at']),
      ahi: asNumberOrNull(row['ahi']),
      severity: asTextOrNull(row['severity']),
      scored: asJson(row['scored']),
      interpretation: asTextOrNull(row['interpretation']),
      status: asText(row['status']),
      signedAt: asTextOrNull(row['signed_at']),
    };
  }

  private toPap(row: Record<string, unknown>): PapRxRow {
    return {
      id: asText(row['id']),
      patientId: asText(row['patient_id']),
      studyId: asTextOrNull(row['study_id']),
      mode: asText(row['mode']),
      pressureCm: asNumberOrNull(row['pressure_cm']),
      pressureMin: asNumberOrNull(row['pressure_min']),
      pressureMax: asNumberOrNull(row['pressure_max']),
      epap: asNumberOrNull(row['epap']),
      ipap: asNumberOrNull(row['ipap']),
      mask: asTextOrNull(row['mask']),
      ownership: asText(row['ownership']),
      startDate: asText(row['start_date']),
      status: asText(row['status']),
      adherent: asBoolOrNull(row['adherent']),
    };
  }
}
