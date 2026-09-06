import { Inject, Injectable } from '@nestjs/common';
import { ProblemType, newId, type Page } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService, type TransactionClient } from '../../../core/db/database.service.js';
import { NumberingService } from '../../../core/numbering/numbering.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import { withTheatreErrors } from './theatre.errors.js';
import { theatreEvent } from './theatre.events.js';
import type {
  BoardQuery,
  CaseRequest,
  ChecklistRequest,
  CloseRequest,
  CountsRequest,
  IndicatorRequest,
  IntraopRequest,
  IssueRequest,
  LoadQuery,
  LoadRequest,
  PreopRequest,
  ReturnRequest,
  SetRequest,
} from './theatre.schemas.js';
import type { CssdLoadRow, OtCaseDetail, OtCaseRow, RecallResult, RecallRow } from './theatre.types.js';

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

/**
 * Phase 7D — the theatre and sterile supply.
 *
 * ── This service never decides whether the checklist was done ───────────────
 *
 * It records each phase and lets the triggers refuse an incision without a
 * time-out and a closure without a sign-out and reconciled counts. Checking
 * here as well would be a second implementation of the one rule that must not
 * have two, and the second one would be the one that gets a `force` parameter
 * the first time a case runs late.
 *
 * ── The recall is the reason the CSSD tables exist ──────────────────────────
 *
 * Given a load whose biological indicator failed, `recall` returns every set
 * issued from it and every case those sets touched. That list is what somebody
 * needs at 6 a.m. and cannot reconstruct from paper.
 */
@Injectable()
export class TheatreService {
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
    return withTheatreErrors(() => this.db.withTenant(currentTenantContext(), fn));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Cases
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * What this case is waiting on.
   *
   * Ordered by what a coordinator would chase first: the checklist phases in
   * their own order, then the pre-op gaps, because a case with no consent is
   * further from theatre than one whose sign-in has not been run.
   */
  private blockedBy(r: Record<string, unknown>): string | null {
    const state = asText(r['state']);
    if (state === 'closed' || state === 'cancelled') return null;

    if (r['consent_at'] === null) return 'Consent has not been taken.';
    if (asTextOrNull(r['side']) !== null && r['site_marked_at'] === null) {
      return 'The site has not been marked. A side is recorded on this case, so a mark is expected.';
    }
    if (r['pac_cleared_at'] === null) return 'Pre-anaesthetic clearance has not been recorded.';

    if (state === 'in_progress' || state === 'signed_out') {
      if (
        r['swab_count_out'] === null ||
        r['instrument_count_out'] === null ||
        r['sharps_count_out'] === null
      ) {
        return 'The closing counts have not been recorded.';
      }
      if (asBool(r['count_discrepancy']) && r['count_resolution'] === null) {
        return 'A count does not reconcile and no resolution is recorded.';
      }
    }
    if (r['sign_in_at'] === null) return 'The WHO sign-in has not been run.';
    if (r['time_out_at'] === null) return 'The time-out has not been run — nothing can be cut until it is.';
    if (state !== 'closed' && r['sign_out_at'] === null && r['incision_at'] !== null) {
      return 'The sign-out has not been run.';
    }
    return null;
  }

  private toCase(r: Record<string, unknown>): OtCaseRow {
    return {
      id: asText(r['id']),
      caseNo: asText(r['case_no']),
      patientId: asText(r['patient_id']),
      admissionId: asTextOrNull(r['admission_id']),
      theatreId: asTextOrNull(r['theatre_id']),
      theatreCode: asTextOrNull(r['theatre_code']),
      plannedProcedure: asText(r['planned_procedure']),
      specialty: asText(r['specialty']),
      side: asTextOrNull(r['side']),
      urgency: asText(r['urgency']),
      state: asText(r['state']),
      anaesthesiaType: asTextOrNull(r['anaesthesia_type']),
      asaGrade: asNumberOrNull(r['asa_grade']),
      surgeonId: asTextOrNull(r['surgeon_id']),
      anaesthetistId: asTextOrNull(r['anaesthetist_id']),
      scheduledStart: asTextOrNull(r['scheduled_start']),
      estimatedMinutes: asNumberOrNull(r['estimated_minutes']),
      signInAt: asTextOrNull(r['sign_in_at']),
      timeOutAt: asTextOrNull(r['time_out_at']),
      signOutAt: asTextOrNull(r['sign_out_at']),
      incisionAt: asTextOrNull(r['incision_at']),
      closureAt: asTextOrNull(r['closure_at']),
      countDiscrepancy: asBool(r['count_discrepancy']),
      bumpedCaseId: asTextOrNull(r['bumped_case_id']),
      bumpReason: asTextOrNull(r['bump_reason']),
      blockedBy: this.blockedBy(r),
      preop: {
        consent: r['consent_at'] !== null,
        siteMarked: r['site_marked_at'] !== null,
        fasting: r['fasting_from'] !== null,
        pacCleared: r['pac_cleared_at'] !== null,
        crossmatch: r['crossmatch_ref'] !== null,
        antibiotic: r['antibiotic_given_at'] !== null,
      },
    };
  }

  private readonly caseSelect = `
    SELECT c.*, t.code AS theatre_code
      FROM clinical.ot_cases c
      LEFT JOIN clinical.ot_theatres t ON t.id = c.theatre_id`;

  async board(query: BoardQuery): Promise<Page<OtCaseRow>> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `${this.caseSelect}
          WHERE c.hospital_id = $1 AND c.branch_id = $2
            AND ($3::uuid IS NULL OR c.theatre_id = $3)
            AND ($4::date IS NULL OR c.scheduled_start::date = $4)
            AND (NOT $5::boolean OR c.state NOT IN ('closed', 'cancelled'))
          ORDER BY c.urgency = 'emergency' DESC, c.scheduled_start NULLS LAST
          LIMIT $6`,
        [
          this.hospitalId(),
          this.branchId(),
          query.theatreId ?? null,
          query.date ?? null,
          query.openOnly,
          query.limit,
        ],
      );
      return { items: rows.map((r) => this.toCase(r)), nextCursor: null, hasMore: false };
    });
  }

  async book(body: CaseRequest): Promise<OtCaseDetail> {
    return this.guard(async (tx) => {
      const id = newId();
      const alloc = await this.numbering.allocate(tx, {
        key: 'OT_CASE',
        branchId: this.branchId(),
        refType: 'ot_case',
        refId: id,
      });

      // Bumping is not a side effect of booking; it is the reason the reason is
      // required. The displaced case is postponed in the same transaction so
      // the board never shows two cases in one slot.
      const bumpReason = body.bumpedCaseId === undefined ? null : this.reason('Displacing an elective case');

      await tx.query(
        `INSERT INTO clinical.ot_cases (
           id, hospital_id, branch_id, case_no, patient_id, admission_id, theatre_id,
           polytrauma_case_id, fracture_id, planned_procedure, procedure_code, specialty, side,
           urgency, anaesthesia_type, asa_grade, surgeon_id, anaesthetist_id,
           scheduled_start, estimated_minutes, state, bumped_case_id, bump_reason, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
                   $19::timestamptz,$20,'scheduled',$21,$22,now(),now())`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          alloc.formatted,
          body.patientId,
          body.admissionId ?? null,
          body.theatreId ?? null,
          body.polytraumaCaseId ?? null,
          body.fractureId ?? null,
          body.plannedProcedure,
          body.procedureCode ?? null,
          body.specialty,
          body.side ?? null,
          body.urgency,
          body.anaesthesiaType ?? null,
          body.asaGrade ?? null,
          body.surgeonId ?? this.actorId(),
          body.anaesthetistId ?? null,
          body.scheduledStart ?? null,
          body.estimatedMinutes ?? null,
          body.bumpedCaseId ?? null,
          bumpReason,
        ],
      );

      if (body.bumpedCaseId !== undefined && bumpReason !== null) {
        await tx.query(
          `UPDATE clinical.ot_cases
              SET state = 'postponed', cancel_reason = $3, updated_at = now()
            WHERE id = $1 AND hospital_id = $2 AND state NOT IN ('closed', 'cancelled')`,
          [body.bumpedCaseId, this.hospitalId(), `Displaced by ${alloc.formatted}: ${bumpReason}`],
        );

        await this.outbox.publish(
          tx,
          theatreEvent('ot.case.bumped', id, {
            caseId: id,
            bumpedCaseId: body.bumpedCaseId,
            theatreId: body.theatreId ?? null,
            reason: bumpReason,
            bumpedBy: this.actorId(),
          }),
        );
      }

      return this.load(tx, id);
    });
  }

  private async load(tx: TransactionClient, id: string): Promise<OtCaseDetail> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `${this.caseSelect} WHERE c.id = $1 AND c.hospital_id = $2`,
      [id, this.hospitalId()],
    );
    const row = rows[0];
    if (row === undefined) throw AppError.notFound('That case is not on this hospital’s list.');

    const { rows: sets } = await tx.query<Record<string, unknown>>(
      `SELECT s.id, s.code, s.name
         FROM clinical.cssd_issues i JOIN clinical.cssd_sets s ON s.id = i.set_id
        WHERE i.ot_case_id = $1 ORDER BY s.code`,
      [id],
    );

    return {
      ...this.toCase(row),
      signInItems: row['sign_in_items'] ?? null,
      timeOutItems: row['time_out_items'] ?? null,
      signOutItems: row['sign_out_items'] ?? null,
      swabCountIn: asNumberOrNull(row['swab_count_in']),
      swabCountOut: asNumberOrNull(row['swab_count_out']),
      instrumentCountIn: asNumberOrNull(row['instrument_count_in']),
      instrumentCountOut: asNumberOrNull(row['instrument_count_out']),
      sharpsCountIn: asNumberOrNull(row['sharps_count_in']),
      sharpsCountOut: asNumberOrNull(row['sharps_count_out']),
      countResolution: asTextOrNull(row['count_resolution']),
      performedProcedure: asTextOrNull(row['performed_procedure']),
      findings: asTextOrNull(row['findings']),
      bloodLossMl: asNumberOrNull(row['blood_loss_ml']),
      specimens: asStringArray(row['specimens']),
      fluoroscopyMinutes: asNumberOrNull(row['fluoroscopy_minutes']),
      fluoroscopyDoseMgy: asNumberOrNull(row['fluoroscopy_dose_mgy']),
      operativeNote: asTextOrNull(row['operative_note']),
      postOpOrders: asTextOrNull(row['post_op_orders']),
      sets: sets.map((s) => ({ id: asText(s['id']), code: asText(s['code']), name: asText(s['name']) })),
    };
  }

  async getCase(id: string): Promise<OtCaseDetail> {
    return this.guard((tx) => this.load(tx, id));
  }

  async recordPreop(id: string, body: PreopRequest): Promise<OtCaseDetail> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.ot_cases
            SET consent_id = COALESCE($3, consent_id),
                consent_at = CASE WHEN $4::boolean THEN COALESCE(consent_at, now()) ELSE consent_at END,
                site_marked_at = CASE WHEN $5::boolean THEN COALESCE(site_marked_at, now()) ELSE site_marked_at END,
                site_marked_by = CASE WHEN $5::boolean THEN COALESCE(site_marked_by, $9::uuid) ELSE site_marked_by END,
                fasting_from = COALESCE($6::timestamptz, fasting_from),
                pac_cleared_at = CASE WHEN $7::boolean THEN COALESCE(pac_cleared_at, now()) ELSE pac_cleared_at END,
                pac_cleared_by = CASE WHEN $7::boolean THEN COALESCE(pac_cleared_by, $9::uuid) ELSE pac_cleared_by END,
                crossmatch_ref = COALESCE($8, crossmatch_ref),
                antibiotic_given_at = CASE WHEN $10::boolean THEN COALESCE(antibiotic_given_at, now()) ELSE antibiotic_given_at END,
                updated_at = now()
          WHERE id = $1 AND hospital_id = $2
          RETURNING id`,
        [
          id,
          this.hospitalId(),
          body.consentId ?? null,
          body.consentTaken ?? false,
          body.siteMarked ?? false,
          body.fastingFrom ?? null,
          body.pacCleared ?? false,
          body.crossmatchRef ?? null,
          this.actorId(),
          body.antibioticGiven ?? false,
        ],
      );
      if (rows[0] === undefined) throw AppError.notFound('That case is not on this hospital’s list.');
      return this.load(tx, id);
    });
  }

  /**
   * Run one phase of the WHO checklist.
   *
   * The phase columns and the state move together; the triggers do the refusing.
   * Extra items go into the JSON beside the timestamp — configuration adds, it
   * never removes.
   */
  async runChecklist(id: string, body: ChecklistRequest): Promise<OtCaseDetail> {
    return this.guard(async (tx) => {
      const column = body.phase;
      const nextState =
        body.phase === 'sign_in' ? 'signed_in' : body.phase === 'time_out' ? 'timed_out' : 'signed_out';

      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.ot_cases
            SET ${column}_at = now(), ${column}_by = $3, ${column}_items = $4::jsonb,
                state = $5::clinical."OtCaseState", updated_at = now()
          WHERE id = $1 AND hospital_id = $2 AND ${column}_at IS NULL
          RETURNING case_no, patient_id, side, wheeled_in_at`,
        [id, this.hospitalId(), this.actorId(), json(body.items), nextState],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict(`The ${body.phase.replace('_', '-')} on that case is already recorded.`);
      }

      if (body.phase === 'time_out') {
        const wheeledIn = asTextOrNull(row['wheeled_in_at']);
        await this.outbox.publish(
          tx,
          theatreEvent('ot.timeout.completed', id, {
            caseId: id,
            caseNo: asText(row['case_no']),
            patientId: asText(row['patient_id']),
            side: asTextOrNull(row['side']),
            ranBy: this.actorId(),
            minutesFromWheelIn:
              wheeledIn === null
                ? null
                : Math.max(0, Math.round((Date.now() - new Date(wheeledIn).getTime()) / 60_000)),
          }),
        );
      }

      return this.load(tx, id);
    });
  }

  async recordIntraop(id: string, body: IntraopRequest): Promise<OtCaseDetail> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.ot_cases
            SET wheeled_in_at = CASE WHEN $3::boolean THEN COALESCE(wheeled_in_at, now()) ELSE wheeled_in_at END,
                anaesthesia_start_at = CASE WHEN $4::boolean THEN COALESCE(anaesthesia_start_at, now()) ELSE anaesthesia_start_at END,
                incision_at = CASE WHEN $5::boolean THEN COALESCE(incision_at, now()) ELSE incision_at END,
                closure_at = CASE WHEN $6::boolean THEN COALESCE(closure_at, now()) ELSE closure_at END,
                wheeled_out_at = CASE WHEN $7::boolean THEN COALESCE(wheeled_out_at, now()) ELSE wheeled_out_at END,
                state = CASE WHEN $5::boolean AND state = 'timed_out'
                             THEN 'in_progress'::clinical."OtCaseState" ELSE state END,
                performed_procedure = COALESCE($8, performed_procedure),
                findings = COALESCE($9, findings),
                blood_loss_ml = COALESCE($10, blood_loss_ml),
                specimens = CASE WHEN $11::text[] IS NULL THEN specimens ELSE $11::text[] END,
                fluoroscopy_minutes = COALESCE($12, fluoroscopy_minutes),
                fluoroscopy_dose_mgy = COALESCE($13, fluoroscopy_dose_mgy),
                scrub_nurse_id = COALESCE($14, scrub_nurse_id),
                circulating_nurse_id = COALESCE($15, circulating_nurse_id),
                updated_at = now()
          WHERE id = $1 AND hospital_id = $2
          RETURNING id`,
        [
          id,
          this.hospitalId(),
          body.wheeledIn ?? false,
          body.anaesthesiaStart ?? false,
          body.incision ?? false,
          body.closure ?? false,
          body.wheeledOut ?? false,
          body.performedProcedure ?? null,
          body.findings ?? null,
          body.bloodLossMl ?? null,
          body.specimens ?? null,
          body.fluoroscopyMinutes ?? null,
          body.fluoroscopyDoseMgy ?? null,
          body.scrubNurseId ?? null,
          body.circulatingNurseId ?? null,
        ],
      );
      if (rows[0] === undefined) throw AppError.notFound('That case is not on this hospital’s list.');
      return this.load(tx, id);
    });
  }

  /**
   * Record the counts.
   *
   * The discrepancy flag is set by a trigger from the numbers, and the event
   * fires whether or not the case then closes. A count that did not reconcile
   * is a patient who may have something inside them, and the safety team should
   * hear about it even when the theatre resolves it in the room and moves on.
   */
  async recordCounts(id: string, body: CountsRequest): Promise<OtCaseDetail> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.ot_cases
            SET swab_count_in = $3, swab_count_out = $4,
                instrument_count_in = $5, instrument_count_out = $6,
                sharps_count_in = $7, sharps_count_out = $8,
                count_resolution = COALESCE($9, count_resolution), updated_at = now()
          WHERE id = $1 AND hospital_id = $2
          RETURNING case_no, patient_id, count_discrepancy, count_resolution`,
        [
          id,
          this.hospitalId(),
          body.swabIn,
          body.swabOut,
          body.instrumentIn,
          body.instrumentOut,
          body.sharpsIn,
          body.sharpsOut,
          body.resolution ?? null,
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.notFound('That case is not on this hospital’s list.');

      if (asBool(row['count_discrepancy'])) {
        await this.outbox.publish(
          tx,
          theatreEvent('ot.count.discrepancy', id, {
            caseId: id,
            caseNo: asText(row['case_no']),
            patientId: asText(row['patient_id']),
            swabGap: body.swabIn - body.swabOut,
            instrumentGap: body.instrumentIn - body.instrumentOut,
            sharpsGap: body.sharpsIn - body.sharpsOut,
            resolution: asTextOrNull(row['count_resolution']),
          }),
        );
      }

      return this.load(tx, id);
    });
  }

  async close(id: string, body: CloseRequest): Promise<OtCaseDetail> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.ot_cases
            SET state = 'closed',
                operative_note = COALESCE($3, operative_note),
                post_op_orders = COALESCE($4, post_op_orders),
                closure_at = COALESCE(closure_at, now()),
                updated_at = now()
          WHERE id = $1 AND hospital_id = $2 AND state <> 'closed'
          RETURNING case_no, patient_id, performed_procedure, incision_at, closure_at, blood_loss_ml`,
        [id, this.hospitalId(), body.operativeNote ?? null, body.postOpOrders ?? null],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('That case is already closed.');

      const incision = asTextOrNull(row['incision_at']);
      const closure = asTextOrNull(row['closure_at']);
      await this.outbox.publish(
        tx,
        theatreEvent('ot.case.closed', id, {
          caseId: id,
          caseNo: asText(row['case_no']),
          patientId: asText(row['patient_id']),
          performedProcedure: asTextOrNull(row['performed_procedure']),
          knifeToSkinMinutes:
            incision === null || closure === null
              ? null
              : Math.round((new Date(closure).getTime() - new Date(incision).getTime()) / 60_000),
          bloodLossMl: asNumberOrNull(row['blood_loss_ml']),
        }),
      );

      return this.load(tx, id);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Sterile supply
  // ═══════════════════════════════════════════════════════════════════════════

  async createSet(body: SetRequest): Promise<{ readonly id: string }> {
    return this.guard(async (tx) => {
      const id = newId();
      await tx.query(
        `INSERT INTO clinical.cssd_sets (
           id, hospital_id, branch_id, code, name, set_type, contents, item_count, shelf_life_days, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,now(),now())`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.code,
          body.name,
          body.setType,
          json(body.contents),
          body.itemCount,
          body.shelfLifeDays,
        ],
      );
      return { id };
    });
  }

  async startLoad(body: LoadRequest): Promise<CssdLoadRow> {
    return this.guard(async (tx) => {
      const id = newId();
      await tx.query(
        `INSERT INTO clinical.cssd_loads (
           id, hospital_id, branch_id, load_no, autoclave_id, cycle_no, state,
           peak_temperature_c, hold_minutes, peak_pressure_bar,
           biological_indicator, started_at, operator_id, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,'sterilising',$7,$8,$9,'pending', now(), $10, now(), now())`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.loadNo,
          body.autoclaveId,
          body.cycleNo ?? null,
          body.peakTemperatureC ?? null,
          body.holdMinutes ?? null,
          body.peakPressureBar ?? null,
          this.actorId(),
        ],
      );

      await tx.query(
        `INSERT INTO clinical.cssd_load_items (id, hospital_id, load_id, set_id, expires_on, created_at)
         SELECT gen_random_uuid(), $2, $1, s.id, CURRENT_DATE + s.shelf_life_days, now()
           FROM clinical.cssd_sets s
          WHERE s.id = ANY($3::uuid[]) AND s.hospital_id = $2`,
        [id, this.hospitalId(), body.setIds],
      );

      return this.loadRow(tx, id);
    });
  }

  private async loadRow(tx: TransactionClient, id: string): Promise<CssdLoadRow> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT l.*,
              (SELECT count(*) FROM clinical.cssd_load_items i WHERE i.load_id = l.id) AS sets_in_load,
              (SELECT count(*) FROM clinical.cssd_issues s WHERE s.load_id = l.id) AS sets_issued
         FROM clinical.cssd_loads l WHERE l.id = $1 AND l.hospital_id = $2`,
      [id, this.hospitalId()],
    );
    const row = rows[0];
    if (row === undefined) throw AppError.notFound('That load is not on this hospital’s record.');
    return {
      id: asText(row['id']),
      loadNo: asText(row['load_no']),
      autoclaveId: asText(row['autoclave_id']),
      cycleNo: asTextOrNull(row['cycle_no']),
      state: asText(row['state']),
      peakTemperatureC: asNumberOrNull(row['peak_temperature_c']),
      holdMinutes: asNumberOrNull(row['hold_minutes']),
      bowieDick: asTextOrNull(row['bowie_dick']),
      chemicalIndicator: asTextOrNull(row['chemical_indicator']),
      biologicalIndicator: asText(row['biological_indicator']),
      startedAt: asText(row['started_at']),
      releasedAt: asTextOrNull(row['released_at']),
      recalledAt: asTextOrNull(row['recalled_at']),
      recallNote: asTextOrNull(row['recall_note']),
      setsInLoad: asNumber(row['sets_in_load'] ?? 0),
      setsIssued: asNumber(row['sets_issued'] ?? 0),
    };
  }

  async loads(query: LoadQuery): Promise<Page<CssdLoadRow>> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT l.id FROM clinical.cssd_loads l
          WHERE l.hospital_id = $1 AND l.branch_id = $2
            AND ($3::text IS NULL OR l.state::text = $3)
          ORDER BY l.started_at DESC LIMIT $4`,
        [this.hospitalId(), this.branchId(), query.state ?? null, query.limit],
      );
      const items: CssdLoadRow[] = [];
      for (const r of rows) items.push(await this.loadRow(tx, asText(r['id'])));
      return { items, nextCursor: null, hasMore: false };
    });
  }

  /**
   * Read the indicators into the load.
   *
   * A failing biological indicator moves the load to `failed` here rather than
   * waiting for somebody to notice: from that moment the trigger refuses any
   * issue from it, which is the behaviour that matters between reading the
   * result and running the recall.
   */
  async recordIndicators(id: string, body: IndicatorRequest): Promise<CssdLoadRow> {
    return this.guard(async (tx) => {
      const failing = body.biologicalIndicator === 'fail';
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.cssd_loads
            SET bowie_dick = COALESCE($3, bowie_dick),
                chemical_indicator = COALESCE($4, chemical_indicator),
                biological_indicator = COALESCE($5, biological_indicator),
                bi_read_at = CASE WHEN $5 IS NULL OR $5 = 'pending' THEN bi_read_at ELSE now() END,
                bi_read_by = CASE WHEN $5 IS NULL OR $5 = 'pending' THEN bi_read_by ELSE $6::uuid END,
                state = CASE WHEN $7::boolean THEN 'failed'::clinical."SterilisationState"
                             WHEN $5 = 'pass' AND state = 'sterilising' THEN 'quarantined'::clinical."SterilisationState"
                             ELSE state END,
                updated_at = now()
          WHERE id = $1 AND hospital_id = $2
          RETURNING load_no, autoclave_id`,
        [
          id,
          this.hospitalId(),
          body.bowieDick ?? null,
          body.chemicalIndicator ?? null,
          body.biologicalIndicator ?? null,
          this.actorId(),
          failing,
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.notFound('That load is not on this hospital’s record.');

      if (failing) {
        const view = await this.loadRow(tx, id);
        await this.outbox.publish(
          tx,
          theatreEvent('cssd.load.failed', id, {
            loadId: id,
            loadNo: asText(row['load_no']),
            autoclaveId: asText(row['autoclave_id']),
            setsInLoad: view.setsInLoad,
            setsAlreadyIssued: view.setsIssued,
          }),
        );
      }

      return this.loadRow(tx, id);
    });
  }

  async releaseLoad(id: string): Promise<CssdLoadRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.cssd_loads
            SET released_at = now(), released_by = $3, state = 'released', updated_at = now()
          WHERE id = $1 AND hospital_id = $2 AND released_at IS NULL
          RETURNING load_no`,
        [id, this.hospitalId(), this.actorId()],
      );
      if (rows[0] === undefined) throw AppError.conflict('That load is already released.');
      return this.loadRow(tx, id);
    });
  }

  async issue(body: IssueRequest): Promise<{ readonly id: string }> {
    return this.guard(async (tx) => {
      const id = newId();
      await tx.query(
        `INSERT INTO clinical.cssd_issues (
           id, hospital_id, branch_id, set_id, load_id, ot_case_id, patient_id,
           issued_at, issued_by, issued_to, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7, now(), $8, $9, now(), now())`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.setId,
          body.loadId,
          body.otCaseId ?? null,
          body.patientId ?? null,
          this.actorId(),
          body.issuedTo ?? null,
        ],
      );
      return { id };
    });
  }

  async returnSet(id: string, body: ReturnRequest): Promise<{ readonly returned: boolean }> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.cssd_issues
            SET returned_at = now(), returned_by = $3, return_state = $4, updated_at = now()
          WHERE id = $1 AND hospital_id = $2 AND returned_at IS NULL
          RETURNING id`,
        [id, this.hospitalId(), this.actorId(), body.returnState],
      );
      if (rows[0] === undefined) throw AppError.conflict('That set is already back.');
      return { returned: true };
    });
  }

  /**
   * The recall.
   *
   * Given a load whose biological indicator failed: every set issued from it,
   * every case those sets touched, and every patient. `phase-07` requires the
   * list; this is the query, and it is why the issue table records the case and
   * the patient rather than just "issued to theatre 1".
   */
  async recall(loadId: string): Promise<RecallResult> {
    return this.guard(async (tx) => {
      const reason = this.reason('Recalling a sterilisation load');

      const { rows: load } = await tx.query<Record<string, unknown>>(
        `SELECT load_no, biological_indicator FROM clinical.cssd_loads WHERE id = $1 AND hospital_id = $2`,
        [loadId, this.hospitalId()],
      );
      const l = load[0];
      if (l === undefined) throw AppError.notFound('That load is not on this hospital’s record.');

      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT i.id AS issue_id, s.code AS set_code, s.name AS set_name, i.issued_at,
                i.ot_case_id, c.case_no, c.planned_procedure, i.patient_id, i.returned_at
           FROM clinical.cssd_issues i
           JOIN clinical.cssd_sets s     ON s.id = i.set_id
           LEFT JOIN clinical.ot_cases c ON c.id = i.ot_case_id
          WHERE i.load_id = $1 AND i.hospital_id = $2
          ORDER BY i.issued_at`,
        [loadId, this.hospitalId()],
      );

      const recalled: RecallRow[] = rows.map((r) => ({
        issueId: asText(r['issue_id']),
        setCode: asText(r['set_code']),
        setName: asText(r['set_name']),
        issuedAt: asText(r['issued_at']),
        otCaseId: asTextOrNull(r['ot_case_id']),
        caseNo: asTextOrNull(r['case_no']),
        procedure: asTextOrNull(r['planned_procedure']),
        patientId: asTextOrNull(r['patient_id']),
        returnedAt: asTextOrNull(r['returned_at']),
      }));

      await tx.query(
        `UPDATE clinical.cssd_issues SET recalled_at = now(), updated_at = now()
          WHERE load_id = $1 AND hospital_id = $2 AND recalled_at IS NULL`,
        [loadId, this.hospitalId()],
      );
      await tx.query(
        `UPDATE clinical.cssd_loads
            SET recalled_at = now(), recalled_by = $3, recall_note = $4,
                state = 'recalled', updated_at = now()
          WHERE id = $1 AND hospital_id = $2`,
        [loadId, this.hospitalId(), this.actorId(), reason],
      );

      const cases = new Set(recalled.map((r) => r.otCaseId).filter((x): x is string => x !== null));
      const patients = new Set(recalled.map((r) => r.patientId).filter((x): x is string => x !== null));

      await this.audit.write(tx, {
        action: 'export',
        entity: 'cssd_load',
        rowId: loadId,
        businessKey: asText(l['load_no']),
        dataClass: 'phi',
        before: null,
        after: {
          setsRecalled: recalled.length,
          casesAffected: cases.size,
          patientsAffected: patients.size,
          reason,
        },
      });

      await this.outbox.publish(
        tx,
        theatreEvent('cssd.recall.issued', loadId, {
          loadId,
          loadNo: asText(l['load_no']),
          setsRecalled: recalled.length,
          casesAffected: cases.size,
          patientsAffected: patients.size,
          reason,
        }),
      );

      return {
        loadId,
        loadNo: asText(l['load_no']),
        setsRecalled: recalled.length,
        casesAffected: cases.size,
        patientsAffected: patients.size,
        rows: recalled,
      };
    });
  }
}
