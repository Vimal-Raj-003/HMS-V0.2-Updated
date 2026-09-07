import { Injectable } from '@nestjs/common';
import { newId } from '@vims/contracts';
import type { TransactionClient } from '../../../core/db/database.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { consoleEvent } from './consoles.events.js';
import type {
  AnticoagEnrolRequest,
  CardioConsultRequest,
  EcgAcknowledgeRequest,
  EcgQuery,
  EcgReadRequest,
  EcgRecordRequest,
  EchoReportRequest,
  InrVisitRequest,
  StressTestRequest,
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
  AnticoagRow,
  CardioConsultRow,
  EchoRow,
  EcgRow,
  InrVisitRow,
  StressTestRow,
} from './consoles.types.js';

/**
 * The corrected interval above which most interaction checks refuse a
 * QT-prolonging drug.
 *
 * A constant rather than a setting: a hospital that raised it to 550 would be
 * configuring away an alert rather than expressing a preference, and the
 * pharmacist screening against 500 and the cardiologist looking at a chart that
 * called 520 normal would be reading the same tracing differently.
 */
const QTC_PROLONGED_MS = 500;

/**
 * OP-029 — the cardiology console.
 *
 * ── Nothing here computes a QTc ─────────────────────────────────────────────
 *
 * Bazett lives in a trigger. A service that also applied it would give the
 * number two authors, and the first time they disagreed a drug would be held
 * on one screen and given on another.
 *
 * ── The acknowledgement is a route, not a field ─────────────────────────────
 *
 * `acknowledgeCritical` is the only way `critical_ack_by` is ever set, and it
 * takes the actor from the request context rather than the body. A body field
 * would let the technician who recorded the tracing name a consultant who was
 * never called — which is precisely the failure the flag exists to catch, done
 * with better paperwork.
 *
 * ── Time in therapeutic range is reported, not stored as truth ──────────────
 *
 * `ttr_pct` on a visit is a snapshot of a rolling figure. It is recomputed on
 * read from the enrolment's window and its readings, because a stored TTR goes
 * stale the moment a historic INR is corrected, and an anticoagulation clinic
 * corrects historic INRs.
 */
@Injectable()
export class CardiologyService extends ConsoleSupport {
  // ═══════════════════════════════════════════════════════════════════════════
  // The consultation
  // ═══════════════════════════════════════════════════════════════════════════

  async recordConsult(body: CardioConsultRequest): Promise<CardioConsultRow> {
    return this.guard(async (tx) => {
      const id = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.cardio_consults
           (id, hospital_id, branch_id, patient_id, encounter_id, nyha, ccs,
            scores, cv_history, exam, plan, problem_codes, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12::text[],$13, now(), now())
         ON CONFLICT (encounter_id) DO UPDATE
           SET nyha = EXCLUDED.nyha, ccs = EXCLUDED.ccs, scores = EXCLUDED.scores,
               cv_history = EXCLUDED.cv_history, exam = EXCLUDED.exam, plan = EXCLUDED.plan,
               problem_codes = EXCLUDED.problem_codes,
               version = specialty.cardio_consults.version + 1, updated_at = now()
         RETURNING *`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.patientId,
          body.encounterId,
          body.nyha ?? null,
          body.ccs ?? null,
          JSON.stringify(body.scores),
          JSON.stringify(body.cvHistory),
          JSON.stringify(body.exam),
          JSON.stringify(body.plan),
          body.problemCodes,
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The consultation was not recorded.');

      await this.audit.write(tx, {
        action: 'update',
        entity: 'cardio_consult',
        rowId: asText(row['id']),
        businessKey: body.encounterId,
        dataClass: 'phi',
        patientId: body.patientId,
        encounterId: body.encounterId,
        before: null,
        after: { nyha: body.nyha ?? null, ccs: body.ccs ?? null },
      });

      return this.toConsult(row);
    });
  }

  async signConsult(id: string): Promise<CardioConsultRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE specialty.cardio_consults
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
        entity: 'cardio_consult',
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
  // The tracing
  // ═══════════════════════════════════════════════════════════════════════════

  async recordEcg(body: EcgRecordRequest): Promise<EcgRow> {
    return this.guard(async (tx) => {
      const id = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.cardio_ecg_records
           (id, hospital_id, branch_id, patient_id, encounter_id, device_order_id, source,
            acquired_at, tech_id, hr, pr_ms, qrs_ms, qt_ms, axis_deg, machine_interp,
            lead_quality, waveform_key, pdf_key, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::specialty."EcgSource",$8::timestamptz,$9,
                 $10,$11,$12,$13,$14,$15::text[],$16,$17,$18, now(), now())
         RETURNING *`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.patientId,
          body.encounterId ?? null,
          body.deviceOrderId ?? null,
          body.source,
          body.acquiredAt,
          body.techId ?? this.actorId(),
          body.hr ?? null,
          body.prMs ?? null,
          body.qrsMs ?? null,
          body.qtMs ?? null,
          body.axisDeg ?? null,
          body.machineInterp,
          body.leadQuality ?? null,
          body.waveformKey ?? null,
          body.pdfKey ?? null,
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The tracing was not filed.');

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'cardio_ecg',
        rowId: id,
        businessKey: body.patientId,
        dataClass: 'phi',
        patientId: body.patientId,
        encounterId: body.encounterId ?? null,
        before: null,
        after: { source: body.source, qtcMs: asNumberOrNull(row['qtc_ms']) },
      });

      return this.toEcg(row);
    });
  }

  async readEcg(id: string, body: EcgReadRequest): Promise<EcgRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE specialty.cardio_ecg_records
            SET read_interp = $3::text[], read_by = $4, read_at = now(),
                critical = $5, status = $6::specialty."EcgStatus", updated_at = now()
          WHERE hospital_id = $1 AND id = $2
          RETURNING *`,
        [this.hospitalId(), id, body.interpretation, this.actorId(), body.critical, body.status],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.notFound('That tracing does not exist.');

      // The tracing leaves the console only when it has to reach somebody who
      // is not looking at this screen.
      if (body.critical && asTextOrNull(row['critical_ack_at']) === null) {
        await this.outbox.publish(
          tx,
          consoleEvent('cardio.ecg.critical', id, {
            ecgId: id,
            patientId: asText(row['patient_id']),
            encounterId: asTextOrNull(row['encounter_id']),
            findings: body.interpretation,
            qtcMs: asNumberOrNull(row['qtc_ms']),
            acquiredAt: asText(row['acquired_at']),
          }),
        );
      }

      await this.audit.write(tx, {
        action: 'sign',
        entity: 'cardio_ecg',
        rowId: id,
        businessKey: asText(row['patient_id']),
        dataClass: 'phi',
        patientId: asText(row['patient_id']),
        encounterId: asTextOrNull(row['encounter_id']),
        before: null,
        after: { status: body.status, critical: body.critical },
      });

      return this.toEcg(row);
    });
  }

  /**
   * The handover, recorded.
   *
   * The actor comes from the context, never the body: an acknowledgement is a
   * statement that *this person* passed it on, and a body field would let the
   * technician who took the tracing close the loop in a consultant's name.
   */
  async acknowledgeCritical(id: string, body: EcgAcknowledgeRequest): Promise<EcgRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE specialty.cardio_ecg_records
            SET critical_ack_by = $3, critical_ack_at = now(), critical_ack_to = $4,
                updated_at = now()
          WHERE hospital_id = $1 AND id = $2 AND critical
          RETURNING *`,
        [this.hospitalId(), id, this.actorId(), body.toldTo],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict('That tracing does not exist, or it is not flagged critical.');
      }

      await this.audit.write(tx, {
        action: 'update',
        entity: 'cardio_ecg',
        rowId: id,
        businessKey: asText(row['patient_id']),
        dataClass: 'phi',
        patientId: asText(row['patient_id']),
        encounterId: asTextOrNull(row['encounter_id']),
        before: null,
        after: { acknowledgedTo: body.toldTo },
      });

      return this.toEcg(row);
    });
  }

  async listEcgs(query: EcgQuery): Promise<readonly EcgRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM specialty.cardio_ecg_records
          WHERE hospital_id = $1
            AND ($2::uuid IS NULL OR patient_id = $2::uuid)
            AND ($3::boolean IS NOT TRUE OR (critical AND critical_ack_at IS NULL))
          ORDER BY critical AND critical_ack_at IS NULL DESC, acquired_at DESC
          LIMIT $4`,
        [this.hospitalId(), query.patientId ?? null, query.unacknowledgedOnly, query.limit],
      );
      return rows.map((r) => this.toEcg(r));
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Echo and stress
  // ═══════════════════════════════════════════════════════════════════════════

  async recordEcho(body: EchoReportRequest): Promise<EchoRow> {
    return this.guard(async (tx) => {
      const id = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.cardio_echo_reports
           (id, hospital_id, branch_id, patient_id, encounter_id, device_order_id, study_uid,
            type, ef_pct, measurements, wall_motion, conclusions, key_images, tech_id,
            reported_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::specialty."EchoType",$9,$10::jsonb,$11::jsonb,
                 $12,$13::uuid[],$14,$15, now(), now())
         RETURNING *`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.patientId,
          body.encounterId ?? null,
          body.deviceOrderId ?? null,
          body.studyUid ?? null,
          body.type,
          body.efPct ?? null,
          JSON.stringify(body.measurements),
          JSON.stringify(body.wallMotion),
          body.conclusions ?? null,
          body.keyImages,
          body.techId ?? null,
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The echo report was not saved.');
      return this.toEcho(row);
    });
  }

  async signEcho(id: string): Promise<EchoRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE specialty.cardio_echo_reports
            SET signed_by = $3, signed_at = now(), updated_at = now()
          WHERE hospital_id = $1 AND id = $2 AND signed_at IS NULL
          RETURNING *`,
        [this.hospitalId(), id, this.actorId()],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict('That echo report does not exist, or it is already signed.');
      }

      await this.audit.write(tx, {
        action: 'sign',
        entity: 'cardio_echo',
        rowId: id,
        businessKey: asText(row['patient_id']),
        dataClass: 'phi',
        patientId: asText(row['patient_id']),
        encounterId: asTextOrNull(row['encounter_id']),
        before: null,
        after: { efPct: asNumberOrNull(row['ef_pct']) },
      });

      return this.toEcho(row);
    });
  }

  async recordStressTest(body: StressTestRequest): Promise<StressTestRow> {
    return this.guard(async (tx) => {
      const id = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.cardio_stress_tests
           (id, hospital_id, branch_id, patient_id, encounter_id, protocol, stages,
            target_hr, max_hr_pct, duke_score, termination_reason, result,
            physician_id, consent_id, checklist, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6::specialty."StressProtocol",$7::jsonb,$8,$9,$10,$11,
                 $12::specialty."StressResult",$13,$14,$15::jsonb,$16, now(), now())
         RETURNING *`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.patientId,
          body.encounterId ?? null,
          body.protocol,
          JSON.stringify(body.stages),
          body.targetHr ?? null,
          body.maxHrPct ?? null,
          body.dukeScore ?? null,
          body.terminationReason ?? null,
          body.result ?? null,
          body.physicianId,
          body.consentId ?? null,
          JSON.stringify(body.checklist),
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The stress test was not recorded.');
      return this.toStress(row);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Anticoagulation
  // ═══════════════════════════════════════════════════════════════════════════

  async enrolAnticoag(body: AnticoagEnrolRequest): Promise<AnticoagRow> {
    return this.guard(async (tx) => {
      const id = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.cardio_anticoag_enrolments
           (id, hospital_id, branch_id, patient_id, drug, indication,
            target_inr_low, target_inr_high, start_date, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5::specialty."AnticoagDrug",$6,$7,$8,$9::date,$10, now(), now())
         RETURNING *`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.patientId,
          body.drug,
          body.indication,
          body.targetInrLow ?? null,
          body.targetInrHigh ?? null,
          body.startDate,
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The enrolment was not created.');
      return this.toAnticoag(row);
    });
  }

  async recordInrVisit(enrolmentId: string, body: InrVisitRequest): Promise<InrVisitRow> {
    return this.guard(async (tx) => {
      const id = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.cardio_inr_visits
           (id, hospital_id, enrolment_id, measured_at, inr, source,
            weekly_dose_mg, dose_grid, next_at, events, recorded_by, created_at)
         VALUES ($1,$2,$3,$4::timestamptz,$5,$6,$7,$8::jsonb,$9::date,$10::jsonb,$11, now())
         RETURNING *`,
        [
          id,
          this.hospitalId(),
          enrolmentId,
          body.measuredAt,
          body.inr,
          body.source,
          body.weeklyDoseMg,
          JSON.stringify(body.doseGrid),
          body.nextAt ?? null,
          JSON.stringify(body.events),
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The INR visit was not recorded.');

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'cardio_anticoag',
        rowId: id,
        businessKey: enrolmentId,
        dataClass: 'phi',
        patientId: null,
        encounterId: null,
        before: null,
        after: { inr: body.inr, weeklyDoseMg: body.weeklyDoseMg },
      });

      return this.enrichInrVisit(await this.inrContext(tx, enrolmentId), row);
    });
  }

  async listInrVisits(enrolmentId: string): Promise<readonly InrVisitRow[]> {
    return this.guard(async (tx) => {
      const ctx = await this.inrContext(tx, enrolmentId);
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM specialty.cardio_inr_visits
          WHERE hospital_id = $1 AND enrolment_id = $2
          ORDER BY measured_at DESC LIMIT 100`,
        [this.hospitalId(), enrolmentId],
      );
      return rows.map((r) => this.enrichInrVisit(ctx, r));
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Shaping
  // ═══════════════════════════════════════════════════════════════════════════

  private async inrContext(
    tx: TransactionClient,
    enrolmentId: string,
  ): Promise<{ low: number | null; high: number | null; ttr: number | null }> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT e.target_inr_low, e.target_inr_high,
              (SELECT round(
                 100.0 * count(*) FILTER (
                   WHERE v.inr BETWEEN e.target_inr_low AND e.target_inr_high
                 ) / nullif(count(*), 0), 2)
                 FROM specialty.cardio_inr_visits v
                WHERE v.enrolment_id = e.id) AS ttr_pct
         FROM specialty.cardio_anticoag_enrolments e
        WHERE e.hospital_id = $1 AND e.id = $2`,
      [this.hospitalId(), enrolmentId],
    );
    const row = rows[0];
    if (row === undefined) throw AppError.notFound('That enrolment does not exist.');
    return {
      low: asNumberOrNull(row['target_inr_low']),
      high: asNumberOrNull(row['target_inr_high']),
      ttr: asNumberOrNull(row['ttr_pct']),
    };
  }

  private enrichInrVisit(
    ctx: { low: number | null; high: number | null; ttr: number | null },
    row: Record<string, unknown>,
  ): InrVisitRow {
    const inr = asNumber(row['inr']);
    const grid = row['dose_grid'];
    return {
      id: asText(row['id']),
      enrolmentId: asText(row['enrolment_id']),
      measuredAt: asText(row['measured_at']),
      inr,
      source: asText(row['source']),
      weeklyDoseMg: asNumber(row['weekly_dose_mg']),
      doseGrid: Array.isArray(grid) ? grid.map((g) => asNumber(g)) : [],
      nextAt: asTextOrNull(row['next_at']),
      inRange: ctx.low === null || ctx.high === null ? null : inr >= ctx.low && inr <= ctx.high,
      ttrPct: ctx.ttr,
    };
  }

  private toConsult(row: Record<string, unknown>): CardioConsultRow {
    return {
      id: asText(row['id']),
      patientId: asText(row['patient_id']),
      encounterId: asText(row['encounter_id']),
      nyha: asNumberOrNull(row['nyha']),
      ccs: asNumberOrNull(row['ccs']),
      scores: asJson(row['scores']),
      problemCodes: asStringArray(row['problem_codes']),
      signedBy: asTextOrNull(row['signed_by']),
      signedAt: asTextOrNull(row['signed_at']),
      createdAt: asText(row['created_at']),
    };
  }

  private toEcg(row: Record<string, unknown>): EcgRow {
    const critical = asBool(row['critical']);
    const ackAt = asTextOrNull(row['critical_ack_at']);
    const qtc = asNumberOrNull(row['qtc_ms']);
    return {
      id: asText(row['id']),
      patientId: asText(row['patient_id']),
      encounterId: asTextOrNull(row['encounter_id']),
      source: asText(row['source']),
      acquiredAt: asText(row['acquired_at']),
      hr: asNumberOrNull(row['hr']),
      prMs: asNumberOrNull(row['pr_ms']),
      qrsMs: asNumberOrNull(row['qrs_ms']),
      qtMs: asNumberOrNull(row['qt_ms']),
      qtcMs: qtc,
      axisDeg: asNumberOrNull(row['axis_deg']),
      machineInterp: asStringArray(row['machine_interp']),
      readInterp: asStringArray(row['read_interp']),
      readBy: asTextOrNull(row['read_by']),
      readAt: asTextOrNull(row['read_at']),
      critical,
      criticalAckBy: asTextOrNull(row['critical_ack_by']),
      criticalAckAt: ackAt,
      criticalAckTo: asTextOrNull(row['critical_ack_to']),
      status: asText(row['status']),
      awaitingAcknowledgement: critical && ackAt === null,
      qtcProlonged: qtc !== null && qtc >= QTC_PROLONGED_MS,
    };
  }

  private toEcho(row: Record<string, unknown>): EchoRow {
    return {
      id: asText(row['id']),
      patientId: asText(row['patient_id']),
      type: asText(row['type']),
      efPct: asNumberOrNull(row['ef_pct']),
      measurements: asJson(row['measurements']),
      conclusions: asTextOrNull(row['conclusions']),
      signedBy: asTextOrNull(row['signed_by']),
      signedAt: asTextOrNull(row['signed_at']),
      createdAt: asText(row['created_at']),
    };
  }

  private toStress(row: Record<string, unknown>): StressTestRow {
    return {
      id: asText(row['id']),
      patientId: asText(row['patient_id']),
      protocol: asText(row['protocol']),
      targetHr: asNumberOrNull(row['target_hr']),
      dukeScore: asNumberOrNull(row['duke_score']),
      terminationReason: asTextOrNull(row['termination_reason']),
      result: asTextOrNull(row['result']),
      physicianId: asText(row['physician_id']),
      signedAt: asTextOrNull(row['signed_at']),
      createdAt: asText(row['created_at']),
    };
  }

  private toAnticoag(row: Record<string, unknown>): AnticoagRow {
    return {
      id: asText(row['id']),
      patientId: asText(row['patient_id']),
      drug: asText(row['drug']),
      indication: asText(row['indication']),
      targetInrLow: asNumberOrNull(row['target_inr_low']),
      targetInrHigh: asNumberOrNull(row['target_inr_high']),
      startDate: asText(row['start_date']),
      status: asText(row['status']),
    };
  }
}
