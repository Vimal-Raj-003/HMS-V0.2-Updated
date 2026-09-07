import { Inject, Injectable } from '@nestjs/common';
import { ProblemType, newId } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService, type TransactionClient } from '../../../core/db/database.service.js';
import { NumberingService } from '../../../core/numbering/numbering.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import { withOphthalmologyErrors } from './ophthalmology.errors.js';
import { ophthalmologyEvent } from './ophthalmology.events.js';
import type {
  AcuityBatchRequest,
  DiagnosisBatchRequest,
  DilateRequest,
  ExamRequest,
  IopBatchRequest,
  OpenVisitRequest,
  RefractionBatchRequest,
  SpectacleRxRequest,
  SurgeryPlanRequest,
  SurgeryStatusRequest,
  TrendQuery,
  VisitQuery,
} from './ophthalmology.schemas.js';
import type {
  AcuityRow,
  DiagnosisRow,
  ExamRow,
  IopRow,
  RefractionRow,
  SpectacleRxRow,
  SurgeryPlanRow,
  TrendPoint,
  VisitDetail,
  VisitRow,
} from './ophthalmology.types.js';

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

/**
 * How high a pressure has to be before it stops the patient leaving.
 *
 * OP-025 §5 gives 22 as the amber line and 30 as the red one. They are here
 * rather than in the client so a banner, a worklist chip and a report cannot
 * disagree about which pressures were high — and they are constants rather than
 * settings because a hospital that raised the red line to 40 would be
 * configuring away an alert rather than a preference.
 */
const IOP_RAISED_MMHG = 22;
const IOP_URGENT_MMHG = 30;

/** The convention for how old biometry may be before a surgeon should look again. */
const BIOMETRY_STALE_DAYS = 183;

/**
 * OP-025 — the eye clinic.
 *
 * ── Nothing here converts an acuity ─────────────────────────────────────────
 *
 * `logmar` is a trigger's output. A service that also converted would give the
 * trend two authors, and the first time they disagreed the chart would say a
 * patient improved while the note beside it said they had not.
 *
 * ── Two keys, one signature ─────────────────────────────────────────────────
 *
 * A spectacle prescription is signed by whoever holds `spectacle_rx.sign`, or
 * by an optometrist holding `spectacle_rx.sign_delegated` where the hospital
 * has delegated it. The row records which, because a prescription signed under
 * delegation is a different thing to a regulator and to the person reading it
 * two years later.
 *
 * ── Staleness is a warning, refusal is for absence ──────────────────────────
 *
 * A lens with no biometry behind it is refused by the database. Biometry six
 * months old is reported as stale and planned with anyway, because six months
 * is a convention and a stable eye is a stable eye — but the surgeon should be
 * the one deciding that, knowing the number.
 */
@Injectable()
export class OphthalmologyService {
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
  private guard<T>(fn: (tx: TransactionClient) => Promise<T>): Promise<T> {
    return withOphthalmologyErrors(() => this.db.withTenant(currentTenantContext(), fn));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The visit
  // ═══════════════════════════════════════════════════════════════════════════

  async openVisit(body: OpenVisitRequest): Promise<VisitRow> {
    return this.guard(async (tx) => {
      const id = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.ophtha_visits
           (id, hospital_id, branch_id, patient_id, encounter_id, chief_complaint_codes, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6::text[], now(), now())
         RETURNING *, NULL::numeric AS highest_iop`,
        [id, this.hospitalId(), this.branchId(), body.patientId, body.encounterId, body.chiefComplaintCodes],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The eye visit was not opened.');

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'ophtha_visit',
        rowId: id,
        businessKey: body.encounterId,
        dataClass: 'phi',
        patientId: body.patientId,
        encounterId: body.encounterId,
        before: null,
        after: { complaints: body.chiefComplaintCodes },
      });

      return this.toVisit(row);
    });
  }

  async listVisits(query: VisitQuery): Promise<readonly VisitRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `${this.selectVisit()}
          WHERE v.hospital_id = $1
            AND ($2::boolean IS NOT TRUE OR v.signed_at IS NULL)
            AND ($3::text IS NULL OR v.stage::text = $3::text)
          ORDER BY v.created_at DESC
          LIMIT $4`,
        [this.hospitalId(), query.openOnly, query.stage ?? null, query.limit],
      );
      return rows.map((r) => this.toVisit(r));
    });
  }

  async visitDetail(id: string): Promise<VisitDetail> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `${this.selectVisit()} WHERE v.hospital_id = $1 AND v.id = $2`,
        [this.hospitalId(), id],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.notFound('That eye visit does not exist.');

      const [acuities, refractions, iop, exam, diagnoses] = await Promise.all([
        tx.query<Record<string, unknown>>(
          `SELECT * FROM specialty.ophtha_visual_acuity WHERE visit_id = $1 ORDER BY recorded_at, eye`,
          [id],
        ),
        tx.query<Record<string, unknown>>(
          `SELECT * FROM specialty.ophtha_refractions WHERE visit_id = $1 ORDER BY recorded_at, eye`,
          [id],
        ),
        tx.query<Record<string, unknown>>(
          `SELECT * FROM specialty.ophtha_iop_readings WHERE visit_id = $1 ORDER BY recorded_at, eye`,
          [id],
        ),
        tx.query<Record<string, unknown>>(
          `SELECT * FROM specialty.ophtha_exam_findings WHERE visit_id = $1 ORDER BY segment, eye`,
          [id],
        ),
        tx.query<Record<string, unknown>>(
          `SELECT * FROM specialty.ophtha_diagnoses WHERE visit_id = $1 ORDER BY is_primary DESC, icd10`,
          [id],
        ),
      ]);

      return {
        visit: this.toVisit(row),
        acuities: acuities.rows.map((r) => this.toAcuity(r)),
        refractions: refractions.rows.map((r) => this.toRefraction(r)),
        iop: iop.rows.map((r) => this.toIop(r)),
        exam: exam.rows.map((r) => this.toExam(r)),
        diagnoses: diagnoses.rows.map((r) => this.toDiagnosis(r)),
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The refraction lane
  // ═══════════════════════════════════════════════════════════════════════════

  async recordAcuities(visitId: string, body: AcuityBatchRequest): Promise<readonly AcuityRow[]> {
    return this.guard(async (tx) => {
      const actor = this.actorId();
      for (const reading of body.readings) {
        await tx.query(
          `INSERT INTO specialty.ophtha_visual_acuity
             (id, hospital_id, visit_id, eye, context, notation, value, distance_m, recorded_at, recorded_by)
           VALUES ($1,$2,$3,$4::clinical."Laterality",$5::specialty."VaContext",
                   $6::specialty."VaNotation",$7,$8, now(), $9)`,
          [
            newId(),
            this.hospitalId(),
            visitId,
            reading.eye,
            reading.context,
            reading.notation,
            reading.value,
            reading.distanceM ?? null,
            actor,
          ],
        );
      }

      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM specialty.ophtha_visual_acuity WHERE visit_id = $1 ORDER BY recorded_at, eye`,
        [visitId],
      );
      return rows.map((r) => this.toAcuity(r));
    });
  }

  async recordRefractions(visitId: string, body: RefractionBatchRequest): Promise<readonly RefractionRow[]> {
    return this.guard(async (tx) => {
      const actor = this.actorId();
      for (const r of body.refractions) {
        await tx.query(
          `INSERT INTO specialty.ophtha_refractions
             (id, hospital_id, visit_id, eye, kind, sph, cyl, axis, "add", prism, base,
              va_achieved, pd_mono, pd_bino, vertex_mm, k1, k1_axis, k2, k2_axis, source,
              recorded_at, recorded_by)
           VALUES ($1,$2,$3,$4::clinical."Laterality",$5::specialty."RefractionKind",
                   $6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20, now(), $21)`,
          [
            newId(),
            this.hospitalId(),
            visitId,
            r.eye,
            r.kind,
            r.sph ?? null,
            r.cyl ?? null,
            r.axis ?? null,
            r.add ?? null,
            r.prism ?? null,
            r.base ?? null,
            r.vaAchieved ?? null,
            r.pdMono ?? null,
            r.pdBino ?? null,
            r.vertexMm ?? null,
            r.k1 ?? null,
            r.k1Axis ?? null,
            r.k2 ?? null,
            r.k2Axis ?? null,
            r.source,
            actor,
          ],
        );
      }

      const { rows: visit } = await tx.query<Record<string, unknown>>(
        `UPDATE specialty.ophtha_visits SET stage = 'doctor', updated_at = now()
          WHERE id = $1 AND stage IN ('registered', 'refraction')
          RETURNING patient_id, encounter_id`,
        [visitId],
      );
      const v = visit[0];
      if (v !== undefined) {
        await this.outbox.publish(
          tx,
          ophthalmologyEvent('ophtha.refraction.recorded', visitId, {
            visitId,
            patientId: asText(v['patient_id']),
            encounterId: asText(v['encounter_id']),
            eyes: [...new Set(body.refractions.map((r) => r.eye))],
            source: body.refractions.every((r) => r.source === 'device') ? 'device' : 'manual',
          }),
        );
      }

      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM specialty.ophtha_refractions WHERE visit_id = $1 ORDER BY recorded_at, eye`,
        [visitId],
      );
      return rows.map((r) => this.toRefraction(r));
    });
  }

  /**
   * Records pressures, and raises the alert from the same transaction.
   *
   * A pressure of 34 read at a machine in the corridor has to reach the doctor
   * before the patient walks out, and a banner on a screen nobody has open is
   * not a way of telling them.
   */
  async recordIop(visitId: string, body: IopBatchRequest): Promise<readonly IopRow[]> {
    return this.guard(async (tx) => {
      const actor = this.actorId();
      const { rows: visits } = await tx.query<Record<string, unknown>>(
        `SELECT patient_id FROM specialty.ophtha_visits WHERE hospital_id = $1 AND id = $2`,
        [this.hospitalId(), visitId],
      );
      const visit = visits[0];
      if (visit === undefined) throw AppError.notFound('That eye visit does not exist.');
      const patientId = asText(visit['patient_id']);

      for (const reading of body.readings) {
        await tx.query(
          `INSERT INTO specialty.ophtha_iop_readings
             (id, hospital_id, visit_id, patient_id, eye, method, value_mmhg, cct_um,
              corrected_mmhg, post_dilation, recorded_at, recorded_by)
           VALUES ($1,$2,$3,$4,$5::clinical."Laterality",$6::specialty."IopMethod",$7,$8,$9,$10, now(), $11)`,
          [
            newId(),
            this.hospitalId(),
            visitId,
            patientId,
            reading.eye,
            reading.method,
            reading.valueMmhg,
            reading.cctUm ?? null,
            // Dresden nomogram, the correction every glaucoma clinic uses: a
            // thin cornea reads low, which is how glaucoma is missed in exactly
            // the eyes most at risk of it.
            reading.cctUm === undefined
              ? null
              : Math.round((reading.valueMmhg - (reading.cctUm - 545) * 0.0423) * 10) / 10,
            reading.postDilation,
            actor,
          ],
        );

        if (reading.valueMmhg >= IOP_URGENT_MMHG) {
          await this.outbox.publish(
            tx,
            ophthalmologyEvent('ophtha.iop.high', visitId, {
              visitId,
              patientId,
              eye: reading.eye,
              valueMmhg: reading.valueMmhg.toFixed(1),
              method: reading.method,
              postDilation: reading.postDilation,
            }),
          );
        }
      }

      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM specialty.ophtha_iop_readings WHERE visit_id = $1 ORDER BY recorded_at, eye`,
        [visitId],
      );
      return rows.map((r) => this.toIop(r));
    });
  }

  async dilate(visitId: string, body: DilateRequest): Promise<VisitRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE specialty.ophtha_visits
            SET dilated_at = now(), dilating_drug = $3, cycloplegic = $4,
                stage = 'dilating', updated_at = now()
          WHERE hospital_id = $1 AND id = $2 AND signed_at IS NULL
          RETURNING *, NULL::numeric AS highest_iop`,
        [this.hospitalId(), visitId, body.drug, body.cycloplegic],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict('That eye visit does not exist, or it has already been signed.');
      }

      await this.audit.write(tx, {
        action: 'update',
        entity: 'ophtha_visit',
        rowId: visitId,
        businessKey: `dilated with ${body.drug}`,
        dataClass: 'phi',
        patientId: asText(row['patient_id']),
        before: null,
        after: { drug: body.drug, cycloplegic: body.cycloplegic },
      });

      return this.toVisit(row);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The examination
  // ═══════════════════════════════════════════════════════════════════════════

  async recordExam(visitId: string, body: ExamRequest): Promise<ExamRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.ophtha_exam_findings
           (id, hospital_id, visit_id, segment, eye, findings, dr_grade, dme, cdr_vertical,
            drawing_key, recorded_at, recorded_by)
         VALUES ($1,$2,$3,$4::specialty."ExamSegment",$5::clinical."Laterality",$6::jsonb,
                 $7::specialty."DrGrade",$8,$9,$10, now(), $11)
         ON CONFLICT (visit_id, segment, eye) DO UPDATE SET
           findings = EXCLUDED.findings,
           dr_grade = EXCLUDED.dr_grade,
           dme = EXCLUDED.dme,
           cdr_vertical = EXCLUDED.cdr_vertical,
           drawing_key = COALESCE(EXCLUDED.drawing_key, specialty.ophtha_exam_findings.drawing_key),
           recorded_at = now(),
           recorded_by = EXCLUDED.recorded_by
         RETURNING *`,
        [
          newId(),
          this.hospitalId(),
          visitId,
          body.segment,
          body.eye,
          JSON.stringify(body.findings),
          body.drGrade ?? null,
          body.dme ?? null,
          body.cdrVertical ?? null,
          body.drawingKey ?? null,
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The examination was not recorded.');
      return this.toExam(row);
    });
  }

  async recordDiagnoses(visitId: string, body: DiagnosisBatchRequest): Promise<readonly DiagnosisRow[]> {
    return this.guard(async (tx) => {
      const actor = this.actorId();
      await tx.query(`DELETE FROM specialty.ophtha_diagnoses WHERE visit_id = $1`, [visitId]);
      for (const d of body.diagnoses) {
        await tx.query(
          `INSERT INTO specialty.ophtha_diagnoses
             (id, hospital_id, visit_id, eye, icd10, snomed, is_primary, note, recorded_at, recorded_by)
           VALUES ($1,$2,$3,$4::clinical."Laterality",$5,$6,$7,$8, now(), $9)`,
          [
            newId(),
            this.hospitalId(),
            visitId,
            d.eye,
            d.icd10,
            d.snomed ?? null,
            d.isPrimary,
            d.note ?? null,
            actor,
          ],
        );
      }
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM specialty.ophtha_diagnoses WHERE visit_id = $1 ORDER BY is_primary DESC, icd10`,
        [visitId],
      );
      return rows.map((r) => this.toDiagnosis(r));
    });
  }

  async signVisit(visitId: string): Promise<VisitRow> {
    return this.guard(async (tx) => {
      const actor = this.actorId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE specialty.ophtha_visits
            SET signed_by = $3, signed_at = now(), stage = 'done', updated_at = now()
          WHERE hospital_id = $1 AND id = $2 AND signed_at IS NULL
          RETURNING *, NULL::numeric AS highest_iop`,
        [this.hospitalId(), visitId, actor],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict('That eye visit does not exist, or it is already signed.');
      }

      const { rows: counted } = await tx.query<Record<string, unknown>>(
        `SELECT count(*) AS n FROM specialty.ophtha_diagnoses WHERE visit_id = $1`,
        [visitId],
      );

      await this.audit.write(tx, {
        action: 'sign',
        entity: 'ophtha_visit',
        rowId: visitId,
        businessKey: asText(row['encounter_id']),
        dataClass: 'phi',
        patientId: asText(row['patient_id']),
        before: null,
        after: { diagnoses: asNumber(counted[0]?.['n'] ?? 0) },
      });

      await this.outbox.publish(
        tx,
        ophthalmologyEvent('ophtha.exam.signed', visitId, {
          visitId,
          patientId: asText(row['patient_id']),
          encounterId: asText(row['encounter_id']),
          signedBy: actor,
          diagnosisCount: asNumber(counted[0]?.['n'] ?? 0),
        }),
      );

      return this.toVisit(row);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The prescription and the operation
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Signs a spectacle or contact-lens prescription.
   *
   * `underDelegation` comes from the route, not from the request body. There
   * are two routes and two permission keys, and the guard decides which the
   * caller may reach — a flag in the body would let any client claim to be the
   * doctor, or claim not to be.
   */
  async signSpectacleRx(
    visitId: string,
    body: SpectacleRxRequest,
    underDelegation: boolean,
  ): Promise<SpectacleRxRow> {
    return this.guard(async (tx) => {
      const { rows: visits } = await tx.query<Record<string, unknown>>(
        `SELECT patient_id FROM specialty.ophtha_visits WHERE hospital_id = $1 AND id = $2`,
        [this.hospitalId(), visitId],
      );
      const visit = visits[0];
      if (visit === undefined) throw AppError.notFound('That eye visit does not exist.');

      if (body.right === undefined && body.left === undefined) {
        throw new AppError(
          ProblemType.VALIDATION_FAILED,
          'A prescription with no powers on either eye is a blank sheet with a signature on it.',
        );
      }

      const id = newId();
      const actor = this.actorId();
      const alloc = await this.numbering.allocate(tx, {
        key: 'SPEC_RX',
        branchId: this.branchId(),
        refType: 'ophtha_spectacle_rx',
        refId: id,
      });

      const lines: Record<string, unknown> = {};
      if (body.right !== undefined) lines['right'] = body.right;
      if (body.left !== undefined) lines['left'] = body.left;

      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.ophtha_spectacle_rx
           (id, hospital_id, branch_id, patient_id, visit_id, rx_no, kind, lines,
            pd_mono, pd_bino, lens_advice, valid_until, signed_by, signed_at,
            signed_under_delegation, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::specialty."SpectacleRxKind",$8::jsonb,$9,$10,$11::jsonb,
                 (current_date + make_interval(months => $12::int)), $13, now(), $14, now(), now())
         RETURNING *`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          asText(visit['patient_id']),
          visitId,
          alloc.formatted,
          body.kind,
          JSON.stringify(lines),
          body.pdMono ?? null,
          body.pdBino ?? null,
          body.lensAdvice === undefined ? null : JSON.stringify(body.lensAdvice),
          body.validMonths,
          actor,
          underDelegation,
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The prescription was not written.');

      await this.audit.write(tx, {
        action: 'sign',
        entity: 'ophtha_spectacle_rx',
        rowId: id,
        businessKey: alloc.formatted,
        dataClass: 'phi',
        patientId: asText(visit['patient_id']),
        before: null,
        after: { kind: body.kind, underDelegation },
      });

      await this.outbox.publish(
        tx,
        ophthalmologyEvent('ophtha.spectacle_rx.signed', id, {
          rxId: id,
          rxNo: alloc.formatted,
          patientId: asText(visit['patient_id']),
          kind: body.kind,
          validUntil: asText(row['valid_until']).slice(0, 10),
          signedBy: actor,
          underDelegation,
        }),
      );

      return this.toSpectacleRx(row);
    });
  }

  async planSurgery(visitId: string, body: SurgeryPlanRequest): Promise<SurgeryPlanRow> {
    return this.guard(async (tx) => {
      const { rows: visits } = await tx.query<Record<string, unknown>>(
        `SELECT patient_id FROM specialty.ophtha_visits WHERE hospital_id = $1 AND id = $2`,
        [this.hospitalId(), visitId],
      );
      const visit = visits[0];
      if (visit === undefined) throw AppError.notFound('That eye visit does not exist.');

      const id = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.ophtha_surgery_plans
           (id, hospital_id, branch_id, patient_id, visit_id, procedure_code, eye, anaesthesia,
            iol_model, iol_power, iol_formula, target_refraction, backup_power,
            biometry, biometry_at, preop_checklist, npcbvi_flag, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::clinical."Laterality",$8,$9,$10,$11,$12,$13,
                 $14::jsonb,$15::timestamptz,$16::jsonb,$17,$18, now(), now())
         RETURNING *`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          asText(visit['patient_id']),
          visitId,
          body.procedureCode,
          body.eye,
          body.anaesthesia,
          body.iolModel ?? null,
          body.iolPower ?? null,
          body.iolFormula ?? null,
          body.targetRefraction ?? null,
          body.backupPower ?? null,
          body.biometry === undefined ? null : JSON.stringify(body.biometry),
          body.biometryAt ?? null,
          body.preopChecklist === undefined ? null : JSON.stringify(body.preopChecklist),
          body.npcbviFlag,
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The plan was not written.');

      const plan = this.toSurgeryPlan(row);

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'ophtha_surgery_plan',
        rowId: id,
        businessKey: `${body.procedureCode} ${body.eye}`,
        dataClass: 'phi',
        patientId: asText(visit['patient_id']),
        before: null,
        after: { iolPower: body.iolPower ?? null, biometryStale: plan.biometryStale },
      });

      await this.outbox.publish(
        tx,
        ophthalmologyEvent('ophtha.surgery.planned', id, {
          planId: id,
          patientId: asText(visit['patient_id']),
          procedureCode: body.procedureCode,
          eye: body.eye,
          iolModel: body.iolModel ?? null,
          iolPower: body.iolPower === undefined ? null : body.iolPower.toFixed(2),
          biometryAgeDays: plan.biometryAgeDays,
        }),
      );

      return plan;
    });
  }

  async updateSurgeryStatus(id: string, body: SurgeryStatusRequest): Promise<SurgeryPlanRow> {
    if (body.status === 'cancelled' && (body.reason ?? '').trim().length < 4) {
      throw new AppError(
        ProblemType.VALIDATION_FAILED,
        'Cancelling a planned operation records why. The patient was told it was happening.',
      );
    }

    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE specialty.ophtha_surgery_plans
            SET status = $3::specialty."SurgeryPlanStatus",
                ot_case_id = COALESCE($4::uuid, ot_case_id),
                cancel_reason = COALESCE($5, cancel_reason),
                updated_at = now()
          WHERE hospital_id = $1 AND id = $2 AND status NOT IN ('done', 'cancelled')
          RETURNING *`,
        [this.hospitalId(), id, body.status, body.otCaseId ?? null, body.reason ?? null],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict('That plan does not exist, or it is already finished or cancelled.');
      }

      await this.audit.write(tx, {
        action: body.status === 'cancelled' ? 'delete' : 'update',
        entity: 'ophtha_surgery_plan',
        rowId: id,
        businessKey: `${asText(row['procedure_code'])} → ${body.status}`,
        dataClass: 'phi',
        patientId: asText(row['patient_id']),
        before: null,
        after: { status: body.status },
        reasonText: body.reason ?? null,
      });

      return this.toSurgeryPlan(row);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Trends
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * The three numbers an eye is followed on, across every visit.
   *
   * A pressure, an acuity and a cup-disc ratio only mean anything as a series.
   * A single reading of 24 is a reading; four of them rising is glaucoma.
   */
  async trend(patientId: string, query: TrendQuery): Promise<readonly TrendPoint[]> {
    return this.guard(async (tx) => {
      const eyeFilter = query.eye === 'both' ? null : query.eye;
      const sql =
        query.metric === 'iop'
          ? `SELECT recorded_at AS at, eye::text AS eye, COALESCE(corrected_mmhg, value_mmhg) AS value
               FROM specialty.ophtha_iop_readings
              WHERE hospital_id = $1 AND patient_id = $2
                AND ($3::text IS NULL OR eye::text = $3::text)
              ORDER BY recorded_at DESC LIMIT $4`
          : query.metric === 'logmar'
            ? `SELECT a.recorded_at AS at, a.eye::text AS eye, a.logmar AS value
                 FROM specialty.ophtha_visual_acuity a
                 JOIN specialty.ophtha_visits v ON v.id = a.visit_id
                WHERE a.hospital_id = $1 AND v.patient_id = $2 AND a.logmar IS NOT NULL
                  AND a.context = 'bcva'
                  AND ($3::text IS NULL OR a.eye::text = $3::text)
                ORDER BY a.recorded_at DESC LIMIT $4`
            : `SELECT e.recorded_at AS at, e.eye::text AS eye, e.cdr_vertical AS value
                 FROM specialty.ophtha_exam_findings e
                 JOIN specialty.ophtha_visits v ON v.id = e.visit_id
                WHERE e.hospital_id = $1 AND v.patient_id = $2 AND e.cdr_vertical IS NOT NULL
                  AND ($3::text IS NULL OR e.eye::text = $3::text)
                ORDER BY e.recorded_at DESC LIMIT $4`;

      const { rows } = await tx.query<Record<string, unknown>>(sql, [
        this.hospitalId(),
        patientId,
        eyeFilter,
        query.limit,
      ]);

      return rows
        .map((r) => ({ at: asText(r['at']), eye: asText(r['eye']), value: asNumber(r['value']) }))
        .reverse();
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Reading
  // ═══════════════════════════════════════════════════════════════════════════

  private selectVisit(): string {
    return `SELECT v.*,
                   (SELECT max(COALESCE(i.corrected_mmhg, i.value_mmhg))
                      FROM specialty.ophtha_iop_readings i WHERE i.visit_id = v.id) AS highest_iop
              FROM specialty.ophtha_visits v`;
  }

  private toVisit(r: Record<string, unknown>): VisitRow {
    return {
      id: asText(r['id']),
      patientId: asText(r['patient_id']),
      encounterId: asText(r['encounter_id']),
      stage: asText(r['stage']),
      dilatedAt: asTextOrNull(r['dilated_at']),
      dilatingDrug: asTextOrNull(r['dilating_drug']),
      cycloplegic: asBool(r['cycloplegic']),
      signedAt: asTextOrNull(r['signed_at']),
      signedBy: asTextOrNull(r['signed_by']),
      createdAt: asText(r['created_at']),
      highestIop: asNumberOrNull(r['highest_iop']),
    };
  }

  private toAcuity(r: Record<string, unknown>): AcuityRow {
    return {
      id: asText(r['id']),
      eye: asText(r['eye']),
      context: asText(r['context']),
      notation: asText(r['notation']),
      value: asText(r['value']),
      logmar: asNumberOrNull(r['logmar']),
      recordedAt: asText(r['recorded_at']),
      recordedBy: asText(r['recorded_by']),
    };
  }

  private toRefraction(r: Record<string, unknown>): RefractionRow {
    return {
      id: asText(r['id']),
      eye: asText(r['eye']),
      kind: asText(r['kind']),
      sph: asNumberOrNull(r['sph']),
      cyl: asNumberOrNull(r['cyl']),
      axis: asNumberOrNull(r['axis']),
      add: asNumberOrNull(r['add']),
      prism: asNumberOrNull(r['prism']),
      base: asTextOrNull(r['base']),
      vaAchieved: asTextOrNull(r['va_achieved']),
      pdMono: asNumberOrNull(r['pd_mono']),
      pdBino: asNumberOrNull(r['pd_bino']),
      k1: asNumberOrNull(r['k1']),
      k2: asNumberOrNull(r['k2']),
      source: asText(r['source']),
      recordedAt: asText(r['recorded_at']),
    };
  }

  private toIop(r: Record<string, unknown>): IopRow {
    const effective = asNumber(r['corrected_mmhg'] ?? r['value_mmhg']);
    return {
      id: asText(r['id']),
      eye: asText(r['eye']),
      method: asText(r['method']),
      valueMmhg: asNumber(r['value_mmhg']),
      cctUm: asNumberOrNull(r['cct_um']),
      correctedMmhg: asNumberOrNull(r['corrected_mmhg']),
      postDilation: asBool(r['post_dilation']),
      recordedAt: asText(r['recorded_at']),
      band: effective >= IOP_URGENT_MMHG ? 'urgent' : effective >= IOP_RAISED_MMHG ? 'raised' : 'normal',
    };
  }

  private toExam(r: Record<string, unknown>): ExamRow {
    return {
      id: asText(r['id']),
      segment: asText(r['segment']),
      eye: asText(r['eye']),
      findings: r['findings'] ?? {},
      drGrade: asTextOrNull(r['dr_grade']),
      dme: asBoolOrNull(r['dme']),
      cdrVertical: asNumberOrNull(r['cdr_vertical']),
      drawingKey: asTextOrNull(r['drawing_key']),
      recordedAt: asText(r['recorded_at']),
    };
  }

  private toDiagnosis(r: Record<string, unknown>): DiagnosisRow {
    return {
      id: asText(r['id']),
      eye: asText(r['eye']),
      icd10: asText(r['icd10']),
      snomed: asTextOrNull(r['snomed']),
      isPrimary: asBool(r['is_primary']),
      note: asTextOrNull(r['note']),
    };
  }

  private toSpectacleRx(r: Record<string, unknown>): SpectacleRxRow {
    return {
      id: asText(r['id']),
      rxNo: asText(r['rx_no']),
      patientId: asText(r['patient_id']),
      visitId: asText(r['visit_id']),
      kind: asText(r['kind']),
      lines: r['lines'] ?? {},
      pdMono: asNumberOrNull(r['pd_mono']),
      pdBino: asNumberOrNull(r['pd_bino']),
      validUntil: asText(r['valid_until']).slice(0, 10),
      signedBy: asText(r['signed_by']),
      signedAt: asText(r['signed_at']),
      signedUnderDelegation: asBool(r['signed_under_delegation']),
      printedAt: asTextOrNull(r['printed_at']),
    };
  }

  private toSurgeryPlan(r: Record<string, unknown>): SurgeryPlanRow {
    const biometryAt = asTextOrNull(r['biometry_at']);
    const ageDays =
      biometryAt === null ? null : Math.floor((Date.now() - new Date(biometryAt).getTime()) / 86_400_000);
    return {
      id: asText(r['id']),
      patientId: asText(r['patient_id']),
      visitId: asText(r['visit_id']),
      procedureCode: asText(r['procedure_code']),
      eye: asText(r['eye']),
      anaesthesia: asText(r['anaesthesia']),
      iolModel: asTextOrNull(r['iol_model']),
      iolPower: asNumberOrNull(r['iol_power']),
      iolFormula: asTextOrNull(r['iol_formula']),
      targetRefraction: asNumberOrNull(r['target_refraction']),
      biometry: r['biometry'] ?? null,
      biometryAt,
      status: asText(r['status']),
      otCaseId: asTextOrNull(r['ot_case_id']),
      npcbviFlag: asBool(r['npcbvi_flag']),
      biometryAgeDays: ageDays,
      biometryStale: ageDays !== null && ageDays > BIOMETRY_STALE_DAYS,
    };
  }
}
