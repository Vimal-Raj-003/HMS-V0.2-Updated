import { Injectable } from '@nestjs/common';
import { newId } from '@vims/contracts';
import type { TransactionClient } from '../../../core/db/database.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { consoleEvent } from './consoles.events.js';
import type {
  AudiologyResultRequest,
  AudiologyTestRequest,
  EntExamRequest,
  HearingAidRequest,
  OpenQuery,
  PatientQuery,
  ThresholdBatchRequest,
} from './consoles.schemas.js';
import {
  ConsoleSupport,
  asBool,
  asJson,
  asNumber,
  asNumberOrNull,
  asText,
  asTextOrNull,
} from './consoles.support.js';
import type {
  AudiologyResultRow,
  AudiologyTestDetail,
  AudiologyTestRow,
  EntExamRow,
  HearingAidRow,
  ThresholdRow,
} from './consoles.types.js';

/**
 * OP-028 — the ENT and audiology console.
 *
 * ── Nothing here averages four thresholds ───────────────────────────────────
 *
 * The PTA, the degree band and the conductive/sensorineural split are all
 * trigger output, and the trigger re-runs when a threshold is corrected. A
 * service that also averaged would be a second author of a number a disability
 * certificate is issued on.
 *
 * ── The air-bone gap is displayed, not decided ──────────────────────────────
 *
 * `airBoneGapDb` on a result is computed here for the screen, from the
 * thresholds. The rule that a *negative* gap is impossible lives in the
 * database and fires at the point of entry, where the technician can still
 * repeat the frequency — not here, where the only thing left to do is show a
 * number nobody can act on.
 *
 * ── Recording a result is an upsert ─────────────────────────────────────────
 *
 * One result per ear per test, by unique index. A second write to the same ear
 * amends the first, because an audiologist who corrects a speech score has not
 * produced a second opinion about the same session.
 */
@Injectable()
export class EntService extends ConsoleSupport {
  // ═══════════════════════════════════════════════════════════════════════════
  // The examination
  // ═══════════════════════════════════════════════════════════════════════════

  async recordExam(body: EntExamRequest): Promise<EntExamRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.ent_exams
           (id, hospital_id, branch_id, patient_id, encounter_id, ear, nose, throat, neck,
            drawings, stop_bang, epworth, form_response_id, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,
                 $11,$12,$13,$14, now(), now())
         ON CONFLICT (encounter_id) DO UPDATE
           SET ear = EXCLUDED.ear, nose = EXCLUDED.nose, throat = EXCLUDED.throat,
               neck = EXCLUDED.neck, drawings = EXCLUDED.drawings,
               stop_bang = EXCLUDED.stop_bang, epworth = EXCLUDED.epworth,
               version = specialty.ent_exams.version + 1, updated_at = now()
         RETURNING *`,
        [
          newId(),
          this.hospitalId(),
          this.branchId(),
          body.patientId,
          body.encounterId,
          JSON.stringify(body.ear),
          JSON.stringify(body.nose),
          JSON.stringify(body.throat),
          JSON.stringify(body.neck),
          JSON.stringify(body.drawings),
          body.stopBang ?? null,
          body.epworth ?? null,
          body.formResponseId ?? null,
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The examination was not recorded.');

      await this.audit.write(tx, {
        action: 'update',
        entity: 'ent_exam',
        rowId: asText(row['id']),
        businessKey: body.encounterId,
        dataClass: 'phi',
        patientId: body.patientId,
        encounterId: body.encounterId,
        before: null,
        after: { stopBang: body.stopBang ?? null },
      });

      return this.toExam(row);
    });
  }

  async signExam(id: string): Promise<EntExamRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE specialty.ent_exams
            SET signed_by = $3, signed_at = now(), updated_at = now()
          WHERE hospital_id = $1 AND id = $2 AND signed_at IS NULL
          RETURNING *`,
        [this.hospitalId(), id, this.actorId()],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict('That examination does not exist, or it is already signed.');
      }
      await this.audit.write(tx, {
        action: 'sign',
        entity: 'ent_exam',
        rowId: id,
        businessKey: asText(row['encounter_id']),
        dataClass: 'phi',
        patientId: asText(row['patient_id']),
        encounterId: asText(row['encounter_id']),
        before: null,
        after: { signedAt: asText(row['signed_at']) },
      });
      return this.toExam(row);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The booth
  // ═══════════════════════════════════════════════════════════════════════════

  async openTest(body: AudiologyTestRequest): Promise<AudiologyTestRow> {
    return this.guard(async (tx) => {
      const id = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.ent_audiology_tests
           (id, hospital_id, branch_id, patient_id, encounter_id, device_order_id,
            test_type, source, booth_id, audiologist_id, performed_at, calibration_ok,
            status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::specialty."AudioTestType",$8,$9,$10,
                 $11::timestamptz,$12,'in_progress', now(), now())
         RETURNING *`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.patientId,
          body.encounterId ?? null,
          body.deviceOrderId ?? null,
          body.testType,
          body.source,
          body.boothId ?? null,
          this.actorId(),
          body.performedAt,
          body.calibrationOk,
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The test was not opened.');
      return this.toTest(row);
    });
  }

  async recordThresholds(testId: string, body: ThresholdBatchRequest): Promise<AudiologyTestDetail> {
    return this.guard(async (tx) => {
      for (const t of body.thresholds) {
        // An upsert, so that correcting a mis-masked frequency is a correction
        // rather than a second point on the same line. The recompute trigger
        // moves the derived summary with it either way.
        await tx.query(
          `INSERT INTO specialty.ent_audiogram_thresholds
             (id, hospital_id, test_id, ear, conduction, freq_hz, threshold_db,
              masked, no_response, created_at)
           VALUES ($1,$2,$3,$4::clinical."Laterality",$5::specialty."Conduction",$6,$7,$8,$9, now())
           ON CONFLICT (test_id, ear, conduction, freq_hz) DO UPDATE
             SET threshold_db = EXCLUDED.threshold_db,
                 masked = EXCLUDED.masked,
                 no_response = EXCLUDED.no_response`,
          [
            newId(),
            this.hospitalId(),
            testId,
            t.ear,
            t.conduction,
            t.freqHz,
            t.thresholdDb,
            t.masked,
            t.noResponse,
          ],
        );
      }
      return this.detailWithin(tx, testId);
    });
  }

  async recordResult(testId: string, body: AudiologyResultRequest): Promise<AudiologyTestDetail> {
    return this.guard(async (tx) => {
      await tx.query(
        `INSERT INTO specialty.ent_audiology_results
           (id, hospital_id, test_id, ear, configuration, srt, sds_pct, mcl, ucl,
            tymp_type, ecv_ml, peak_dapa, compliance_ml, reflexes, oae, abr,
            interpretation, created_at, updated_at)
         VALUES ($1,$2,$3,$4::clinical."Laterality",$5,$6,$7,$8,$9,
                 $10::specialty."TympType",$11,$12,$13,$14::jsonb,$15::jsonb,$16::jsonb,$17, now(), now())
         ON CONFLICT (test_id, ear) DO UPDATE
           SET configuration = EXCLUDED.configuration, srt = EXCLUDED.srt,
               sds_pct = EXCLUDED.sds_pct, mcl = EXCLUDED.mcl, ucl = EXCLUDED.ucl,
               tymp_type = EXCLUDED.tymp_type, ecv_ml = EXCLUDED.ecv_ml,
               peak_dapa = EXCLUDED.peak_dapa, compliance_ml = EXCLUDED.compliance_ml,
               reflexes = EXCLUDED.reflexes, oae = EXCLUDED.oae, abr = EXCLUDED.abr,
               interpretation = EXCLUDED.interpretation, updated_at = now()`,
        [
          newId(),
          this.hospitalId(),
          testId,
          body.ear,
          body.configuration ?? null,
          body.srt ?? null,
          body.sdsPct ?? null,
          body.mcl ?? null,
          body.ucl ?? null,
          body.tympType ?? null,
          body.ecvMl ?? null,
          body.peakDapa ?? null,
          body.complianceMl ?? null,
          JSON.stringify(body.reflexes),
          JSON.stringify(body.oae),
          JSON.stringify(body.abr),
          body.interpretation ?? null,
        ],
      );
      return this.detailWithin(tx, testId);
    });
  }

  async signTest(testId: string): Promise<AudiologyTestDetail> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE specialty.ent_audiology_tests
            SET status = 'signed', signed_by = $3, signed_at = now(), updated_at = now()
          WHERE hospital_id = $1 AND id = $2 AND signed_at IS NULL
          RETURNING *`,
        [this.hospitalId(), testId, this.actorId()],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict('That test does not exist, or it is already signed.');
      }

      const detail = await this.detailWithin(tx, testId);

      await this.outbox.publish(
        tx,
        consoleEvent('ent.audiology.signed', testId, {
          testId,
          patientId: asText(row['patient_id']),
          testType: asText(row['test_type']),
          results: detail.results.map((r) => ({
            ear: r.ear,
            ptaAvg: r.ptaAvg === null ? null : String(r.ptaAvg),
            degree: r.degree,
          })),
          signedBy: this.actorId(),
        }),
      );

      await this.audit.write(tx, {
        action: 'sign',
        entity: 'ent_audiology_test',
        rowId: testId,
        businessKey: asText(row['patient_id']),
        dataClass: 'phi',
        patientId: asText(row['patient_id']),
        encounterId: asTextOrNull(row['encounter_id']),
        before: null,
        after: { degrees: detail.results.map((r) => r.degree) },
      });

      return detail;
    });
  }

  async testDetail(testId: string): Promise<AudiologyTestDetail> {
    return this.guard((tx) => this.detailWithin(tx, testId));
  }

  async listTests(query: OpenQuery): Promise<readonly AudiologyTestRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM specialty.ent_audiology_tests
          WHERE hospital_id = $1
            AND ($2::uuid IS NULL OR patient_id = $2::uuid)
            AND ($3::boolean IS NOT TRUE OR signed_at IS NULL)
          ORDER BY performed_at DESC LIMIT $4`,
        [this.hospitalId(), query.patientId ?? null, query.openOnly, query.limit],
      );
      return rows.map((r) => this.toTest(r));
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Hearing aids
  // ═══════════════════════════════════════════════════════════════════════════

  async recordHearingAid(body: HearingAidRequest): Promise<HearingAidRow> {
    return this.guard(async (tx) => {
      const id = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.ent_hearing_aids
           (id, hospital_id, branch_id, patient_id, ear, model, serial, item_id,
            status, fitting, dispensed_at, warranty_until, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5::clinical."Laterality",$6,$7,$8,
                 $9::specialty."HearingAidStatus",$10::jsonb,
                 CASE WHEN $9 = 'dispensed' THEN now() ELSE NULL END,
                 $11::date,$12, now(), now())
         RETURNING *`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.patientId,
          body.ear,
          body.model,
          body.serial,
          body.itemId ?? null,
          body.status,
          JSON.stringify(body.fitting),
          body.warrantyUntil ?? null,
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The hearing aid was not recorded.');

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'ent_hearing_aid',
        rowId: id,
        businessKey: body.serial,
        dataClass: 'phi',
        patientId: body.patientId,
        encounterId: null,
        before: null,
        after: { ear: body.ear, model: body.model, status: body.status },
      });

      return this.toAid(row);
    });
  }

  async listHearingAids(query: PatientQuery): Promise<readonly HearingAidRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM specialty.ent_hearing_aids
          WHERE hospital_id = $1 AND ($2::uuid IS NULL OR patient_id = $2::uuid)
          ORDER BY created_at DESC LIMIT $3`,
        [this.hospitalId(), query.patientId ?? null, query.limit],
      );
      return rows.map((r) => this.toAid(r));
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Shaping
  // ═══════════════════════════════════════════════════════════════════════════

  private async detailWithin(tx: TransactionClient, testId: string): Promise<AudiologyTestDetail> {
    const [test, thresholds, results] = await Promise.all([
      tx.query<Record<string, unknown>>(
        `SELECT * FROM specialty.ent_audiology_tests WHERE hospital_id = $1 AND id = $2`,
        [this.hospitalId(), testId],
      ),
      tx.query<Record<string, unknown>>(
        `SELECT * FROM specialty.ent_audiogram_thresholds
          WHERE test_id = $1 ORDER BY ear, conduction, freq_hz`,
        [testId],
      ),
      tx.query<Record<string, unknown>>(
        `SELECT r.*,
                (SELECT round(avg(a.threshold_db) - avg(b.threshold_db), 1)
                   FROM specialty.ent_audiogram_thresholds a
                   JOIN specialty.ent_audiogram_thresholds b
                     ON b.test_id = a.test_id AND b.ear = a.ear
                    AND b.freq_hz = a.freq_hz AND b.conduction = 'bc'
                    AND NOT b.no_response
                  WHERE a.test_id = r.test_id AND a.ear = r.ear
                    AND a.conduction = 'ac' AND NOT a.no_response
                    AND a.freq_hz IN (500, 1000, 2000, 4000)) AS air_bone_gap_db
           FROM specialty.ent_audiology_results r
          WHERE r.test_id = $1 ORDER BY r.ear`,
        [testId],
      ),
    ]);

    const row = test.rows[0];
    if (row === undefined) throw AppError.notFound('That audiology test does not exist.');

    return {
      test: this.toTest(row),
      thresholds: thresholds.rows.map((r) => this.toThreshold(r)),
      results: results.rows.map((r) => this.toResult(r)),
    };
  }

  private toExam(row: Record<string, unknown>): EntExamRow {
    return {
      id: asText(row['id']),
      patientId: asText(row['patient_id']),
      encounterId: asText(row['encounter_id']),
      ear: asJson(row['ear']),
      nose: asJson(row['nose']),
      throat: asJson(row['throat']),
      neck: asJson(row['neck']),
      stopBang: asNumberOrNull(row['stop_bang']),
      epworth: asNumberOrNull(row['epworth']),
      signedBy: asTextOrNull(row['signed_by']),
      signedAt: asTextOrNull(row['signed_at']),
      createdAt: asText(row['created_at']),
    };
  }

  private toTest(row: Record<string, unknown>): AudiologyTestRow {
    return {
      id: asText(row['id']),
      patientId: asText(row['patient_id']),
      testType: asText(row['test_type']),
      performedAt: asText(row['performed_at']),
      boothId: asTextOrNull(row['booth_id']),
      audiologistId: asText(row['audiologist_id']),
      calibrationOk: asBool(row['calibration_ok']),
      status: asText(row['status']),
      signedBy: asTextOrNull(row['signed_by']),
      signedAt: asTextOrNull(row['signed_at']),
    };
  }

  private toThreshold(row: Record<string, unknown>): ThresholdRow {
    return {
      ear: asText(row['ear']),
      conduction: asText(row['conduction']),
      freqHz: asNumber(row['freq_hz']),
      thresholdDb: asNumber(row['threshold_db']),
      masked: asBool(row['masked']),
      noResponse: asBool(row['no_response']),
    };
  }

  private toResult(row: Record<string, unknown>): AudiologyResultRow {
    return {
      id: asText(row['id']),
      ear: asText(row['ear']),
      ptaAvg: asNumberOrNull(row['pta_avg']),
      degree: asTextOrNull(row['degree']),
      type: asTextOrNull(row['type']),
      srt: asNumberOrNull(row['srt']),
      sdsPct: asNumberOrNull(row['sds_pct']),
      tympType: asTextOrNull(row['tymp_type']),
      interpretation: asTextOrNull(row['interpretation']),
      airBoneGapDb: asNumberOrNull(row['air_bone_gap_db']),
    };
  }

  private toAid(row: Record<string, unknown>): HearingAidRow {
    return {
      id: asText(row['id']),
      patientId: asText(row['patient_id']),
      ear: asText(row['ear']),
      model: asText(row['model']),
      serial: asText(row['serial']),
      status: asText(row['status']),
      dispensedAt: asTextOrNull(row['dispensed_at']),
      warrantyUntil: asTextOrNull(row['warranty_until']),
    };
  }
}
