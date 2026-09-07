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
  AbortRequest,
  AccessRequest,
  AccessUpdateRequest,
  DialyserQuery,
  DialyserRequest,
  DiscardRequest,
  MachineRequest,
  MachineRezoneRequest,
  MachineStatusRequest,
  ObservationRequest,
  PrescriptionRequest,
  ProgramQuery,
  ProgramRequest,
  ProgramUpdateRequest,
  ReprocessRequest,
  SessionQuery,
  SessionRequest,
  SessionUpdateRequest,
} from './dialysis.schemas.js';
import type {
  DialyserUseRow,
  DialysisBoardRow,
  DialysisMachineRow,
  DialysisObservationRow,
  DialysisPrescriptionRow,
  DialysisProgramRow,
  DialysisSessionDetail,
  DialysisSessionRow,
  VascularAccessRow,
} from './dialysis.types.js';

/** How long a dry weight may stand before the unit should look at it again. */
const DRY_WEIGHT_REVIEW_DAYS = 90;

/** How long a serology may stand. Most units re-screen every six months. */
const SEROLOGY_REVIEW_DAYS = 180;

/**
 * OP-012 and IP-022 — the dialysis unit.
 *
 * ── Nothing here computes a zone, a rate or a use number ───────────────────
 *
 * All three are trigger outputs. A service that also computed them would be a
 * second author of the numbers every rule in this module is a line on, and the
 * two would diverge the first time one of them was revised — in the direction
 * nobody checks.
 *
 * ── What it does compute is the forward view ────────────────────────────────
 *
 * `blockedBy`, `minutesNeededForGoal`, `usesRemaining`, `nextUseLicensed`. Each
 * is the same arithmetic the trigger does, read the other way round: not "this
 * is refused" but "this is what would refuse it, and here is the figure that
 * would not". A nurse who can see the refusal coming never meets it.
 */
@Injectable()
export class DialysisService extends ConsoleSupport {
  // ═══════════════════════════════════════════════════════════════════════════
  // The programme
  // ═══════════════════════════════════════════════════════════════════════════

  async createProgram(body: ProgramRequest): Promise<DialysisProgramRow> {
    return this.guard(async (tx) => {
      const id = newId();
      // `isolation_zone` is absent from the column list on purpose: it is NOT
      // NULL with no default, and the BEFORE trigger fills it before the
      // constraint is checked. There is no value to pass because there is no
      // value anybody outside the database is entitled to choose.
      await tx.query(
        `INSERT INTO specialty.dialysis_programs
           (id, hospital_id, branch_id, patient_id, modality, aetiology_icd10, start_date,
            dry_weight_kg, dry_weight_updated_at, viral_status, blood_group, nephrologist_id,
            transport_needed, notes, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5::specialty."DialysisModality",$6,$7::date,
                 $8,now(),$9::jsonb,$10,$11,$12,$13,$14,now(),now())`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.patientId,
          body.modality,
          body.aetiologyIcd10 ?? null,
          body.startDate,
          body.dryWeightKg,
          JSON.stringify(body.viralStatus),
          body.bloodGroup ?? null,
          body.nephrologistId ?? null,
          body.transportNeeded,
          body.notes ?? null,
          this.actorId(),
        ],
      );

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'dialysis_program',
        rowId: id,
        businessKey: body.patientId,
        dataClass: 'phi',
        patientId: body.patientId,
        encounterId: null,
        before: null,
        after: { modality: body.modality, dryWeightKg: body.dryWeightKg },
      });

      return this.programWithin(tx, id);
    });
  }

  async updateProgram(id: string, body: ProgramUpdateRequest): Promise<DialysisProgramRow> {
    return this.guard(async (tx) => {
      const before = await this.programWithin(tx, id);
      await tx.query(
        `UPDATE specialty.dialysis_programs
            SET dry_weight_kg         = coalesce($2, dry_weight_kg),
                dry_weight_updated_at = CASE WHEN $2::numeric IS NULL THEN dry_weight_updated_at ELSE now() END,
                viral_status          = coalesce($3::jsonb, viral_status),
                nephrologist_id       = coalesce($4, nephrologist_id),
                transport_needed      = coalesce($5, transport_needed),
                status                = coalesce($6, status),
                notes                 = coalesce($7, notes),
                updated_at            = now()
          WHERE id = $1 AND hospital_id = $8`,
        [
          id,
          body.dryWeightKg ?? null,
          body.viralStatus === undefined ? null : JSON.stringify(body.viralStatus),
          body.nephrologistId ?? null,
          body.transportNeeded ?? null,
          body.status ?? null,
          body.notes ?? null,
          this.hospitalId(),
        ],
      );

      const after = await this.programWithin(tx, id);
      await this.audit.write(tx, {
        action: 'update',
        entity: 'dialysis_program',
        rowId: id,
        businessKey: after.patientId,
        dataClass: 'phi',
        patientId: after.patientId,
        encounterId: null,
        before: { dryWeightKg: before.dryWeightKg, isolationZone: before.isolationZone },
        after: { dryWeightKg: after.dryWeightKg, isolationZone: after.isolationZone },
      });

      // A zone change is not an edit. It moves the patient to a different set of
      // machines, and every booking they already hold is now on the wrong one.
      if (after.isolationZone !== before.isolationZone) {
        await tx.query(
          `UPDATE specialty.dialysis_sessions SET machine_id = NULL, updated_at = now()
            WHERE program_id = $1 AND status IN ('scheduled', 'checked_in')`,
          [id],
        );
      }

      return after;
    });
  }

  async listPrograms(query: ProgramQuery): Promise<readonly DialysisProgramRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `${PROGRAM_SELECT}
          WHERE p.hospital_id = $1
            AND ($2::uuid IS NULL OR p.patient_id = $2::uuid)
            AND ($3::text IS NULL OR p.isolation_zone::text = $3::text)
            AND ($4::boolean IS NOT TRUE OR p.status = 'active')
          ORDER BY p.created_at DESC
          LIMIT $5`,
        [this.hospitalId(), query.patientId ?? null, query.zone ?? null, query.activeOnly, query.limit],
      );
      return rows.map((r) => this.toProgram(r));
    });
  }

  async programDetail(id: string): Promise<{
    readonly program: DialysisProgramRow;
    readonly accesses: readonly VascularAccessRow[];
    readonly prescriptions: readonly DialysisPrescriptionRow[];
    readonly sessions: readonly DialysisSessionRow[];
  }> {
    return this.guard(async (tx) => {
      const program = await this.programWithin(tx, id);
      const [accesses, prescriptions, sessions] = await Promise.all([
        tx.query<Record<string, unknown>>(
          `SELECT *, (current_date - created_on) AS age_days
             FROM specialty.dialysis_vascular_accesses
            WHERE program_id = $1 ORDER BY created_at DESC`,
          [id],
        ),
        tx.query<Record<string, unknown>>(
          `SELECT * FROM specialty.dialysis_prescriptions WHERE program_id = $1
            ORDER BY effective_from DESC, version DESC`,
          [id],
        ),
        tx.query<Record<string, unknown>>(
          `${SESSION_SELECT} WHERE s.program_id = $1 ORDER BY s.scheduled_at DESC LIMIT 60`,
          [id],
        ),
      ]);
      return {
        program,
        accesses: accesses.rows.map((r) => this.toAccess(r)),
        prescriptions: prescriptions.rows.map((r) => this.toPrescription(r)),
        sessions: sessions.rows.map((r) => this.toSession(r)),
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The access
  // ═══════════════════════════════════════════════════════════════════════════

  async createAccess(body: AccessRequest): Promise<VascularAccessRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.dialysis_vascular_accesses
           (id, hospital_id, program_id, type, site, side, created_on, created_by_surgeon,
            status, created_at, updated_at)
         VALUES ($1,$2,$3,$4::specialty."VascularAccessType",$5,$6::clinical."Laterality",
                 $7::date,$8,$9,now(),now())
         RETURNING *, (current_date - created_on) AS age_days`,
        [
          newId(),
          this.hospitalId(),
          body.programId,
          body.type,
          body.site,
          body.side,
          body.createdOn ?? null,
          body.createdBySurgeon ?? null,
          body.status,
        ],
      );
      return this.toAccess(this.one(rows));
    });
  }

  async updateAccess(id: string, body: AccessUpdateRequest): Promise<VascularAccessRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE specialty.dialysis_vascular_accesses
            SET status = $2, complications = $3::jsonb, last_assessed = now(), updated_at = now()
          WHERE id = $1 AND hospital_id = $4
          RETURNING *, (current_date - created_on) AS age_days`,
        [id, body.status, JSON.stringify(body.complications), this.hospitalId()],
      );
      const access = this.toAccess(this.one(rows));

      await this.audit.write(tx, {
        action: 'update',
        entity: 'dialysis_vascular_access',
        rowId: id,
        businessKey: access.programId,
        dataClass: 'phi',
        patientId: null,
        encounterId: null,
        before: null,
        after: { status: access.status },
      });

      // A failed access is an interventional slot the patient needs before their
      // next session, and a failure found on the morning of a treatment is a
      // treatment missed.
      if (body.status === 'failed') {
        const { rows: prog } = await tx.query<Record<string, unknown>>(
          `SELECT patient_id FROM specialty.dialysis_programs WHERE id = $1`,
          [access.programId],
        );
        await this.outbox.publish(
          tx,
          consoleEvent('dialysis.access.failed', id, {
            accessId: id,
            programId: access.programId,
            patientId: asText(this.one(prog).patient_id),
            type: access.type,
            site: access.site,
          }),
        );
      }

      return access;
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The prescription
  // ═══════════════════════════════════════════════════════════════════════════

  async writePrescription(body: PrescriptionRequest): Promise<DialysisPrescriptionRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.dialysis_prescriptions
           (id, hospital_id, program_id, version, frequency_per_week, duration_min,
            dialyser_item_id, dialyser_max_uses, qb, qd, dialysate, uf_max_rate_ml_kg_h,
            heparin, anticoag_mode, epo_plan, iron_plan, target_ktv, effective_from,
            prescribed_by, created_at, updated_at)
         SELECT $1, $2, $3,
                coalesce(max(rx.version), 0) + 1,
                $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12::jsonb, $13, $14::jsonb, $15::jsonb,
                $16, $17::date, $18, now(), now()
           FROM specialty.dialysis_prescriptions rx
          WHERE rx.program_id = $3
         RETURNING *`,
        [
          newId(),
          this.hospitalId(),
          body.programId,
          body.frequencyPerWeek,
          body.durationMin,
          body.dialyserItemId ?? null,
          body.dialyserMaxUses,
          body.qb,
          body.qd,
          JSON.stringify(body.dialysate),
          body.ufMaxRateMlKgH,
          JSON.stringify(body.heparin),
          body.anticoagMode,
          JSON.stringify(body.epoPlan),
          JSON.stringify(body.ironPlan),
          body.targetKtv ?? null,
          body.effectiveFrom,
          this.actorId(),
        ],
      );
      const rx = this.toPrescription(this.one(rows));

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'dialysis_prescription',
        rowId: rx.id,
        businessKey: body.programId,
        dataClass: 'phi',
        patientId: null,
        encounterId: null,
        before: null,
        // The ceiling is the interesting field: raising it is how a faster
        // ultrafiltration is authorised, and the audit row is where that shows.
        after: { version: rx.version, ufMaxRateMlKgH: rx.ufMaxRateMlKgH, durationMin: rx.durationMin },
      });

      return rx;
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The machines
  // ═══════════════════════════════════════════════════════════════════════════

  async createMachine(body: MachineRequest): Promise<DialysisMachineRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.dialysis_machines
           (id, hospital_id, branch_id, asset_id, code, model, serial, zone, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::specialty."IsolationZone",now(),now())
         RETURNING *, 0::bigint AS live_sessions`,
        [
          newId(),
          this.hospitalId(),
          this.branchId(),
          body.assetId ?? null,
          body.code,
          body.model ?? null,
          body.serial ?? null,
          body.zone,
        ],
      );
      return this.toMachine(this.one(rows));
    });
  }

  async listMachines(): Promise<readonly DialysisMachineRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(`${MACHINE_SELECT} ORDER BY m.code`, [
        this.hospitalId(),
        this.branchId(),
      ]);
      return rows.map((r) => this.toMachine(r));
    });
  }

  async setMachineStatus(id: string, body: MachineStatusRequest): Promise<DialysisMachineRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE specialty.dialysis_machines m
            SET status            = $2::specialty."MachineStatus",
                last_disinfection = coalesce($3::jsonb, m.last_disinfection),
                hours_run         = coalesce($4, m.hours_run),
                last_service_at   = coalesce($5::timestamptz, m.last_service_at),
                next_service_due_at = coalesce($6::timestamptz, m.next_service_due_at),
                updated_at        = now()
          WHERE m.id = $1 AND m.hospital_id = $7
          RETURNING m.*, (SELECT count(*) FROM specialty.dialysis_sessions s
                           WHERE s.machine_id = m.id
                             AND s.status IN ('scheduled','checked_in','on_machine')) AS live_sessions`,
        [
          id,
          body.status,
          body.lastDisinfection === undefined ? null : JSON.stringify(body.lastDisinfection),
          body.hoursRun ?? null,
          body.lastServiceAt ?? null,
          body.nextServiceDueAt ?? null,
          this.hospitalId(),
        ],
      );
      const machine = this.toMachine(this.one(rows));

      // A machine going down takes a shift's bookings with it, and every one of
      // them has to move to another machine in the *same* zone — of which there
      // may not be one. That is somebody else's problem to solve, immediately.
      if (body.status === 'breakdown' || body.status === 'maintenance') {
        await this.outbox.publish(
          tx,
          consoleEvent('dialysis.machine.down', id, {
            machineId: id,
            code: machine.code,
            zone: machine.zone,
            status: machine.status,
            affectedSessions: machine.liveSessions,
          }),
        );
      }

      return machine;
    });
  }

  async rezoneMachine(id: string, body: MachineRezoneRequest): Promise<DialysisMachineRow> {
    return this.guard(async (tx) => {
      const { rows: prior } = await tx.query<Record<string, unknown>>(
        `SELECT zone, code FROM specialty.dialysis_machines WHERE id = $1 AND hospital_id = $2`,
        [id, this.hospitalId()],
      );
      const before = this.one(prior);

      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE specialty.dialysis_machines m
            SET zone = $2::specialty."IsolationZone", updated_at = now()
          WHERE m.id = $1 AND m.hospital_id = $3
          RETURNING m.*, 0::bigint AS live_sessions`,
        [id, body.zone, this.hospitalId()],
      );
      const machine = this.toMachine(this.one(rows));

      await this.audit.write(tx, {
        action: 'override',
        entity: 'dialysis_machine',
        rowId: id,
        businessKey: machine.code,
        dataClass: 'operational',
        patientId: null,
        encounterId: null,
        reasonText: body.reason,
        before: { zone: asText(before.zone) },
        after: { zone: machine.zone },
      });

      return machine;
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The session
  // ═══════════════════════════════════════════════════════════════════════════

  async scheduleSession(body: SessionRequest): Promise<DialysisSessionRow> {
    return this.guard(async (tx) => {
      const { rows: prog } = await tx.query<Record<string, unknown>>(
        `SELECT p.patient_id,
                (SELECT rx.id FROM specialty.dialysis_prescriptions rx
                  WHERE rx.program_id = p.id
                  ORDER BY (rx.effective_from <= current_date) DESC, rx.effective_from DESC, rx.version DESC
                  LIMIT 1) AS rx_id,
                (SELECT rx.duration_min FROM specialty.dialysis_prescriptions rx
                  WHERE rx.program_id = p.id
                  ORDER BY (rx.effective_from <= current_date) DESC, rx.effective_from DESC, rx.version DESC
                  LIMIT 1) AS duration_min
           FROM specialty.dialysis_programs p
          WHERE p.id = $1 AND p.hospital_id = $2`,
        [body.programId, this.hospitalId()],
      );
      const program = this.one(prog);
      const prescriptionId = body.prescriptionId ?? asTextOrNull(program.rx_id);
      if (prescriptionId === null) {
        throw AppError.conflict(
          'This patient has no dialysis prescription, so there is nothing to book them onto. Write one first — it carries the duration, the flows and the ultrafiltration ceiling this session will be checked against.',
        );
      }

      // The end comes from the prescription's own duration unless the caller
      // gives one. A session length typed at the desk is the number the rate
      // ceiling is computed against, so the default is the prescribed one.
      const durationMin = asNumberOrNull(program.duration_min) ?? 240;

      // Two statements rather than a data-modifying CTE: a CTE's insert is not
      // visible to the outer query's snapshot, so the read has to follow the
      // write rather than ride alongside it.
      const id = newId();
      await tx.query(
        `INSERT INTO specialty.dialysis_sessions
             (id, hospital_id, branch_id, program_id, patient_id, machine_id, chair_no,
              admission_id, prescription_id, scheduled_at, scheduled_end, shift,
              created_by, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,
                   coalesce($11::timestamptz, $10::timestamptz + make_interval(mins => $12)),
                   $13,$14,now(),now())`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.programId,
          asText(program.patient_id),
          body.machineId ?? null,
          body.chairNo ?? null,
          body.admissionId ?? null,
          prescriptionId,
          body.scheduledAt,
          body.scheduledEnd ?? null,
          durationMin,
          body.shift ?? null,
          this.actorId(),
        ],
      );
      return this.sessionWithin(tx, id);
    });
  }

  async listSessions(query: SessionQuery): Promise<readonly DialysisSessionRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `${SESSION_SELECT}
          WHERE s.hospital_id = $1
            AND ($2::uuid IS NULL OR s.program_id = $2::uuid)
            AND ($3::uuid IS NULL OR s.patient_id = $3::uuid)
            AND ($4::uuid IS NULL OR s.machine_id = $4::uuid)
            AND ($5::date IS NULL OR s.scheduled_at::date = $5::date)
            AND ($6::boolean IS NOT TRUE
                 OR s.status IN ('scheduled','checked_in','on_machine'))
          ORDER BY s.scheduled_at
          LIMIT $7`,
        [
          this.hospitalId(),
          query.programId ?? null,
          query.patientId ?? null,
          query.machineId ?? null,
          query.on ?? null,
          query.liveOnly,
          query.limit,
        ],
      );
      return rows.map((r) => this.toSession(r));
    });
  }

  async sessionDetail(id: string): Promise<DialysisSessionDetail> {
    return this.guard(async (tx) => {
      const session = await this.sessionWithin(tx, id);
      const program = await this.programWithin(tx, session.programId);
      const [accesses, dialysers, observations] = await Promise.all([
        tx.query<Record<string, unknown>>(
          `SELECT *, (current_date - created_on) AS age_days
             FROM specialty.dialysis_vascular_accesses
            WHERE program_id = $1 ORDER BY (status = 'active') DESC, created_at DESC`,
          [session.programId],
        ),
        tx.query<Record<string, unknown>>(
          `${DIALYSER_SELECT} WHERE u.program_id = $1
            ORDER BY u.label, u.use_no DESC LIMIT 60`,
          [session.programId],
        ),
        tx.query<Record<string, unknown>>(
          `SELECT * FROM specialty.dialysis_observations WHERE session_id = $1 ORDER BY recorded_at`,
          [id],
        ),
      ]);

      return {
        session,
        program,
        accesses: accesses.rows.map((r) => this.toAccess(r)),
        dialysers: dialysers.rows.map((r) => this.toDialyser(r)),
        observations: observations.rows.map((r) => this.toObservation(r, session)),
      };
    });
  }

  async updateSession(id: string, body: SessionUpdateRequest): Promise<DialysisSessionRow> {
    return this.guard(async (tx) => {
      await tx.query(
        `UPDATE specialty.dialysis_sessions s
              SET status         = coalesce($2::specialty."DialysisSessionStatus", s.status),
                  machine_id     = CASE WHEN $3::boolean THEN $4::uuid ELSE s.machine_id END,
                  access_id      = coalesce($5::uuid, s.access_id),
                  pre_weight_kg  = coalesce($6::numeric, s.pre_weight_kg),
                  pre            = coalesce($7::jsonb, s.pre),
                  uf_goal_l      = coalesce($8::numeric, s.uf_goal_l),
                  connect_at     = coalesce($9::timestamptz, s.connect_at),
                  disconnect_at  = coalesce($10::timestamptz, s.disconnect_at),
                  post_weight_kg = coalesce($11::numeric, s.post_weight_kg),
                  post           = coalesce($12::jsonb, s.post),
                  actual_uf_l    = coalesce($13::numeric, s.actual_uf_l),
                  dialyser_label = coalesce($14, s.dialyser_label),
                  dialyser_use_no= coalesce($15::int, s.dialyser_use_no),
                  complications  = coalesce($16::jsonb, s.complications),
                  meds_given     = coalesce($17::jsonb, s.meds_given),
                  adequacy_labs  = coalesce($18::jsonb, s.adequacy_labs),
                  technician_id  = coalesce($19::uuid, s.technician_id),
                  nurse_id       = coalesce($20::uuid, s.nurse_id),
                  updated_at     = now()
            WHERE s.id = $1 AND s.hospital_id = $21`,
        [
          id,
          body.status ?? null,
          Object.prototype.hasOwnProperty.call(body, 'machineId'),
          body.machineId ?? null,
          body.accessId ?? null,
          body.preWeightKg ?? null,
          body.pre === undefined ? null : JSON.stringify(body.pre),
          body.ufGoalL ?? null,
          body.connectAt ?? null,
          body.disconnectAt ?? null,
          body.postWeightKg ?? null,
          body.post === undefined ? null : JSON.stringify(body.post),
          body.actualUfL ?? null,
          body.dialyserLabel ?? null,
          body.dialyserUseNo ?? null,
          body.complications === undefined ? null : JSON.stringify(body.complications),
          body.medsGiven === undefined ? null : JSON.stringify(body.medsGiven),
          body.adequacyLabs === undefined ? null : JSON.stringify(body.adequacyLabs),
          body.technicianId ?? null,
          body.nurseId ?? null,
          this.hospitalId(),
        ],
      );
      const session = await this.sessionWithin(tx, id);

      if (body.status !== undefined) {
        await this.audit.write(tx, {
          action: 'update',
          entity: 'dialysis_session',
          rowId: id,
          businessKey: session.patientId,
          dataClass: 'phi',
          patientId: session.patientId,
          encounterId: null,
          before: null,
          after: { status: session.status, machineId: session.machineId },
        });
      }

      if (body.status === 'completed') {
        await this.outbox.publish(
          tx,
          consoleEvent('dialysis.session.completed', id, {
            sessionId: id,
            programId: session.programId,
            patientId: session.patientId,
            machineCode: session.machineCode,
            ufGoalL: session.ufGoalL === null ? null : String(session.ufGoalL),
            actualUfL: session.actualUfL === null ? null : String(session.actualUfL),
            urr: session.urr === null ? null : String(session.urr),
            ktv: session.ktv === null ? null : String(session.ktv),
            disconnectAt: session.disconnectAt ?? new Date().toISOString(),
          }),
        );
      }

      return session;
    });
  }

  async abortSession(id: string, body: AbortRequest): Promise<DialysisSessionRow> {
    return this.guard(async (tx) => {
      await tx.query(
        `UPDATE specialty.dialysis_sessions s
              SET status         = 'aborted',
                  abort_reason   = $2,
                  disconnect_at  = coalesce(s.disconnect_at, now()),
                  actual_uf_l    = coalesce($3::numeric, s.actual_uf_l),
                  post_weight_kg = coalesce($4::numeric, s.post_weight_kg),
                  complications  = $5::jsonb,
                  updated_at     = now()
            WHERE s.id = $1 AND s.hospital_id = $6`,
        [
          id,
          body.reason,
          body.actualUfL ?? null,
          body.postWeightKg ?? null,
          JSON.stringify(body.complications),
          this.hospitalId(),
        ],
      );
      const session = await this.sessionWithin(tx, id);

      await this.audit.write(tx, {
        action: 'update',
        entity: 'dialysis_session',
        rowId: id,
        businessKey: session.patientId,
        dataClass: 'phi',
        patientId: session.patientId,
        encounterId: null,
        reasonText: body.reason,
        before: null,
        after: { status: 'aborted', minutesRun: session.minutesRun },
      });

      await this.outbox.publish(
        tx,
        consoleEvent('dialysis.session.aborted', id, {
          sessionId: id,
          programId: session.programId,
          patientId: session.patientId,
          minutesRun: session.minutesRun,
          reason: body.reason,
        }),
      );

      return session;
    });
  }

  async recordObservation(sessionId: string, body: ObservationRequest): Promise<DialysisObservationRow> {
    return this.guard(async (tx) => {
      const session = await this.sessionWithin(tx, sessionId);

      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.dialysis_observations
           (id, hospital_id, session_id, recorded_at, recorded_by, systolic, diastolic, pulse,
            temperature_c, qb, qd, arterial_mmhg, venous_mmhg, tmp_mmhg, uf_removed_l, uf_rate_lh,
            conductivity, symptoms, intervention, created_at)
         VALUES ($1,$2,$3,coalesce($4::timestamptz, now()),$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
                 $15,$16,$17,$18::jsonb,$19,now())
         RETURNING *`,
        [
          newId(),
          this.hospitalId(),
          sessionId,
          body.recordedAt ?? null,
          this.actorId(),
          body.systolic ?? null,
          body.diastolic ?? null,
          body.pulse ?? null,
          body.temperatureC ?? null,
          body.qb ?? null,
          body.qd ?? null,
          body.arterialMmhg ?? null,
          body.venousMmhg ?? null,
          body.tmpMmhg ?? null,
          body.ufRemovedL ?? null,
          body.ufRateLh ?? null,
          body.conductivity ?? null,
          JSON.stringify(body.symptoms),
          body.intervention ?? null,
        ],
      );
      return this.toObservation(this.one(rows), session);
    });
  }

  /** The board: one row per machine, with who is on it and who is next. */
  async board(): Promise<readonly DialysisBoardRow[]> {
    return this.guard(async (tx) => {
      const [machines, sessions] = await Promise.all([
        tx.query<Record<string, unknown>>(`${MACHINE_SELECT} ORDER BY m.zone, m.code`, [
          this.hospitalId(),
          this.branchId(),
        ]),
        tx.query<Record<string, unknown>>(
          `${SESSION_SELECT}
            WHERE s.hospital_id = $1 AND s.branch_id = $2
              AND s.machine_id IS NOT NULL
              AND s.status IN ('scheduled','checked_in','on_machine')
              AND s.scheduled_at < now() + interval '18 hours'
            ORDER BY s.scheduled_at`,
          [this.hospitalId(), this.branchId()],
        ),
      ]);

      const byMachine = new Map<string, DialysisSessionRow[]>();
      for (const raw of sessions.rows) {
        const session = this.toSession(raw);
        if (session.machineId === null) continue;
        const list = byMachine.get(session.machineId);
        if (list === undefined) byMachine.set(session.machineId, [session]);
        else list.push(session);
      }

      return machines.rows.map((raw) => {
        const machine = this.toMachine(raw);
        const queue = byMachine.get(machine.id) ?? [];
        const current = queue.find((s) => s.status === 'on_machine' || s.status === 'checked_in') ?? null;
        const next = queue.find((s) => s !== current) ?? null;
        return { machine, current, next };
      });
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The dialyser
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Logging a use. The use number is not in the request: it is one more than
   * the last one on that label, and the whole of reuse safety rests on nobody
   * being able to choose it.
   */
  async logDialyserUse(body: DialyserRequest): Promise<DialyserUseRow> {
    return this.guard(async (tx) => {
      const id = newId();
      await tx.query(
        `INSERT INTO specialty.dialyser_uses
             (id, hospital_id, program_id, label, item_id, use_no, session_id, created_at, updated_at)
           SELECT $1::uuid, $2::uuid, $3::uuid, $4::text, $5::uuid,
                  -- $4 is cast on both sides: used once as the inserted label
                  -- and once as a lookup key, Postgres deduces varchar from one
                  -- and text from the other and refuses the statement.
                  coalesce((SELECT max(u.use_no) FROM specialty.dialyser_uses u
                             WHERE u.hospital_id = $2::uuid AND u.label = $4::text), 0) + 1,
                  $6::uuid, now(), now()`,
        [id, this.hospitalId(), body.programId, body.label, body.itemId ?? null, body.sessionId ?? null],
      );
      return this.dialyserWithin(tx, id);
    });
  }

  async reprocess(id: string, body: ReprocessRequest): Promise<DialyserUseRow> {
    return this.guard(async (tx) => {
      await tx.query(
        `UPDATE specialty.dialyser_uses u
              SET reprocessed_at = now(), tcv_pct = $2, integrity_ok = $3,
                  chemical = $4, reprocessed_by = $5, updated_at = now()
            WHERE u.id = $1 AND u.hospital_id = $6`,
        [id, body.tcvPct, body.integrityOk, body.chemical ?? null, this.actorId(), this.hospitalId()],
      );
      return this.dialyserWithin(tx, id);
    });
  }

  async discardDialyser(id: string, body: DiscardRequest): Promise<DialyserUseRow> {
    return this.guard(async (tx) => {
      await tx.query(
        `UPDATE specialty.dialyser_uses u
              SET discarded_at = now(), discard_reason = $2, updated_at = now()
            WHERE u.id = $1 AND u.hospital_id = $3`,
        [id, body.reason, this.hospitalId()],
      );
      const use = await this.dialyserWithin(tx, id);

      // The reprocessing room needs to issue a replacement before the patient
      // arrives, rather than while they sit in the chair waiting.
      await this.outbox.publish(
        tx,
        consoleEvent('dialysis.dialyser.condemned', id, {
          label: use.label,
          programId: use.programId,
          useNo: use.useNo,
          reason: body.reason,
        }),
      );

      return use;
    });
  }

  async listDialysers(query: DialyserQuery): Promise<readonly DialyserUseRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `${DIALYSER_SELECT}
          WHERE u.hospital_id = $1
            AND ($2::uuid IS NULL OR u.program_id = $2::uuid)
            AND ($3::text IS NULL OR u.label = $3::text)
            AND ($4::boolean IS NOT TRUE OR u.discarded_at IS NULL)
          ORDER BY u.label, u.use_no DESC
          LIMIT $5`,
        [this.hospitalId(), query.programId ?? null, query.label ?? null, query.usableOnly, query.limit],
      );
      return rows.map((r) => this.toDialyser(r));
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Shaping
  // ═══════════════════════════════════════════════════════════════════════════

  private one(rows: readonly Record<string, unknown>[]): Record<string, unknown> {
    const row = rows[0];
    if (row === undefined) throw AppError.notFound('That dialysis record was not found.');
    return row;
  }

  private async sessionWithin(tx: TransactionClient, id: string): Promise<DialysisSessionRow> {
    const { rows } = await tx.query<Record<string, unknown>>(`${SESSION_SELECT} WHERE s.id = $1`, [id]);
    return this.toSession(this.one(rows));
  }

  private async dialyserWithin(tx: TransactionClient, id: string): Promise<DialyserUseRow> {
    const { rows } = await tx.query<Record<string, unknown>>(`${DIALYSER_SELECT} WHERE u.id = $1`, [id]);
    return this.toDialyser(this.one(rows));
  }

  private async programWithin(tx: TransactionClient, id: string): Promise<DialysisProgramRow> {
    const { rows } = await tx.query<Record<string, unknown>>(`${PROGRAM_SELECT} WHERE p.id = $1`, [id]);
    return this.toProgram(this.one(rows));
  }

  private toProgram(r: Record<string, unknown>): DialysisProgramRow {
    const dryWeightAgeDays = asNumber(r.dry_weight_age_days);
    const serologyAgeDays = asNumberOrNull(r.serology_age_days);
    const activeAccessCount = asNumber(r.active_access_count);

    const blockedBy: string[] = [];
    if (asTextOrNull(r.prescription_id) === null) blockedBy.push('no prescription');
    if (activeAccessCount === 0) blockedBy.push('no active vascular access');
    if (asText(r.status) !== 'active') blockedBy.push(`the programme is ${asText(r.status)}`);

    return {
      id: asText(r.id),
      patientId: asText(r.patient_id),
      branchId: asText(r.branch_id),
      modality: asText(r.modality),
      aetiologyIcd10: asTextOrNull(r.aetiology_icd10),
      startDate: asText(r.start_date),
      dryWeightKg: asNumber(r.dry_weight_kg),
      dryWeightUpdatedAt: asText(r.dry_weight_updated_at),
      viralStatus: asJson(r.viral_status),
      isolationZone: asText(r.isolation_zone),
      bloodGroup: asTextOrNull(r.blood_group),
      nephrologistId: asTextOrNull(r.nephrologist_id),
      transportNeeded: r.transport_needed === true,
      status: asText(r.status),
      dryWeightAgeDays,
      dryWeightStale: dryWeightAgeDays > DRY_WEIGHT_REVIEW_DAYS,
      serologyAgeDays,
      serologyDue: serologyAgeDays !== null && serologyAgeDays > SEROLOGY_REVIEW_DAYS,
      prescriptionId: asTextOrNull(r.prescription_id),
      durationMin: asNumberOrNull(r.duration_min),
      frequencyPerWeek: asNumberOrNull(r.frequency_per_week),
      ufMaxRateMlKgH: asNumberOrNull(r.uf_max_rate_ml_kg_h),
      dialyserMaxUses: asNumberOrNull(r.dialyser_max_uses),
      activeAccessId: activeAccessCount === 1 ? asTextOrNull(r.active_access_id) : null,
      activeAccessLabel: activeAccessCount === 1 ? asTextOrNull(r.active_access_label) : null,
      blockedBy,
    };
  }

  private toAccess(r: Record<string, unknown>): VascularAccessRow {
    return {
      id: asText(r.id),
      programId: asText(r.program_id),
      type: asText(r.type),
      site: asText(r.site),
      side: asText(r.side),
      createdOn: asTextOrNull(r.created_on),
      status: asText(r.status),
      complications: Array.isArray(r.complications) ? (r.complications as Record<string, unknown>[]) : [],
      lastAssessed: asTextOrNull(r.last_assessed),
      ageDays: asNumberOrNull(r.age_days),
    };
  }

  private toPrescription(r: Record<string, unknown>): DialysisPrescriptionRow {
    return {
      id: asText(r.id),
      programId: asText(r.program_id),
      version: asNumber(r.version),
      frequencyPerWeek: asNumber(r.frequency_per_week),
      durationMin: asNumber(r.duration_min),
      dialyserItemId: asTextOrNull(r.dialyser_item_id),
      dialyserMaxUses: asNumber(r.dialyser_max_uses),
      qb: asNumber(r.qb),
      qd: asNumber(r.qd),
      dialysate: asJson(r.dialysate),
      ufMaxRateMlKgH: asNumber(r.uf_max_rate_ml_kg_h),
      heparin: asJson(r.heparin),
      anticoagMode: asText(r.anticoag_mode),
      targetKtv: asNumberOrNull(r.target_ktv),
      effectiveFrom: asText(r.effective_from),
      prescribedBy: asText(r.prescribed_by),
    };
  }

  private toMachine(r: Record<string, unknown>): DialysisMachineRow {
    const status = asText(r.status);
    const due = asTextOrNull(r.next_service_due_at);
    return {
      id: asText(r.id),
      code: asText(r.code),
      model: asTextOrNull(r.model),
      serial: asTextOrNull(r.serial),
      zone: asText(r.zone),
      status,
      hoursRun: asNumber(r.hours_run),
      lastServiceAt: asTextOrNull(r.last_service_at),
      nextServiceDueAt: due,
      liveSessions: asNumber(r.live_sessions),
      free: status === 'available',
      serviceOverdue: due !== null && new Date(due).getTime() < Date.now(),
    };
  }

  private toSession(r: Record<string, unknown>): DialysisSessionRow {
    const ufGoalL = asNumberOrNull(r.uf_goal_l);
    const ufRate = asNumberOrNull(r.uf_rate_ml_kg_h);
    const ufMax = asNumber(r.uf_max_rate_ml_kg_h);
    const dryWeight = asNumber(r.dry_weight_kg);
    const preWeight = asNumberOrNull(r.pre_weight_kg);
    const status = asText(r.status);
    const machineZone = asTextOrNull(r.machine_zone);
    const patientZone = asText(r.patient_zone);

    // The same arithmetic the trigger does, read forwards: not "this is
    // refused" but "run it this long and it will not be".
    const minutesNeededForGoal =
      ufGoalL !== null && ufRate !== null && ufRate > ufMax && dryWeight > 0
        ? Math.ceil(((ufGoalL * 1000) / ufMax / dryWeight) * 60)
        : null;

    const blockedBy: string[] = [];
    if (machineZone !== null && machineZone !== patientZone) {
      blockedBy.push(`the machine is a ${machineZone} machine and this patient is ${patientZone}`);
    }
    if (
      asTextOrNull(r.machine_status) !== null &&
      !['available', 'in_use'].includes(asText(r.machine_status))
    ) {
      blockedBy.push(`the machine is ${asText(r.machine_status)}`);
    }
    if (asTextOrNull(r.access_id) === null && asTextOrNull(r.machine_id) !== null) {
      blockedBy.push('no access has been recorded');
    } else if (asTextOrNull(r.access_status) !== null && asText(r.access_status) !== 'active') {
      blockedBy.push(`the access is ${asText(r.access_status)}, not active`);
    }
    if (minutesNeededForGoal !== null) {
      blockedBy.push(
        `${String(ufRate)} ml/kg/h exceeds the limit of ${String(ufMax)} — run for ${String(minutesNeededForGoal)} minutes or take less off`,
      );
    }

    return {
      id: asText(r.id),
      programId: asText(r.program_id),
      patientId: asText(r.patient_id),
      machineId: asTextOrNull(r.machine_id),
      machineCode: asTextOrNull(r.machine_code),
      machineZone,
      patientZone,
      chairNo: asTextOrNull(r.chair_no),
      admissionId: asTextOrNull(r.admission_id),
      accessId: asTextOrNull(r.access_id),
      prescriptionId: asText(r.prescription_id),
      scheduledAt: asText(r.scheduled_at),
      scheduledEnd: asText(r.scheduled_end),
      shift: asTextOrNull(r.shift),
      status,
      preWeightKg: preWeight,
      pre: asJson(r.pre),
      ufGoalL,
      ufRateMlKgH: ufRate,
      connectAt: asTextOrNull(r.connect_at),
      disconnectAt: asTextOrNull(r.disconnect_at),
      postWeightKg: asNumberOrNull(r.post_weight_kg),
      post: asJson(r.post),
      actualUfL: asNumberOrNull(r.actual_uf_l),
      dialyserLabel: asTextOrNull(r.dialyser_label),
      dialyserUseNo: asNumberOrNull(r.dialyser_use_no),
      complications: Array.isArray(r.complications) ? (r.complications as Record<string, unknown>[]) : [],
      medsGiven: Array.isArray(r.meds_given) ? (r.meds_given as Record<string, unknown>[]) : [],
      urr: asNumberOrNull(r.urr),
      ktv: asNumberOrNull(r.ktv),
      adequacyLabs: asJson(r.adequacy_labs),
      abortReason: asTextOrNull(r.abort_reason),
      technicianId: asTextOrNull(r.technician_id),
      nurseId: asTextOrNull(r.nurse_id),
      suggestedUfGoalL:
        preWeight === null ? null : Math.max(Math.round((preWeight - dryWeight) * 100) / 100, 0),
      ufMaxRateMlKgH: ufMax,
      minutesNeededForGoal,
      blockedBy,
      minutesRun: asNumberOrNull(r.minutes_run),
    };
  }

  private toObservation(r: Record<string, unknown>, session: DialysisSessionRow): DialysisObservationRow {
    const removed = asNumberOrNull(r.uf_removed_l);
    const recordedAt = asText(r.recorded_at);

    // Where the machine should be by now, against where it is. The nurse
    // watching a patient cramp wants to know whether the machine is ahead of
    // plan, and that is a subtraction nobody does at the chair.
    let ufBehindL: number | null = null;
    if (removed !== null && session.ufGoalL !== null && session.connectAt !== null) {
      const elapsedMs = new Date(recordedAt).getTime() - new Date(session.connectAt).getTime();
      const plannedMs = new Date(session.scheduledEnd).getTime() - new Date(session.scheduledAt).getTime();
      if (plannedMs > 0 && elapsedMs >= 0) {
        const expected = session.ufGoalL * Math.min(elapsedMs / plannedMs, 1);
        ufBehindL = Math.round((expected - removed) * 100) / 100;
      }
    }

    return {
      id: asText(r.id),
      sessionId: asText(r.session_id),
      recordedAt,
      recordedBy: asText(r.recorded_by),
      systolic: asNumberOrNull(r.systolic),
      diastolic: asNumberOrNull(r.diastolic),
      pulse: asNumberOrNull(r.pulse),
      temperatureC: asNumberOrNull(r.temperature_c),
      qb: asNumberOrNull(r.qb),
      qd: asNumberOrNull(r.qd),
      arterialMmhg: asNumberOrNull(r.arterial_mmhg),
      venousMmhg: asNumberOrNull(r.venous_mmhg),
      tmpMmhg: asNumberOrNull(r.tmp_mmhg),
      ufRemovedL: removed,
      ufRateLh: asNumberOrNull(r.uf_rate_lh),
      conductivity: asNumberOrNull(r.conductivity),
      symptoms: Array.isArray(r.symptoms) ? (r.symptoms as Record<string, unknown>[]) : [],
      intervention: asTextOrNull(r.intervention),
      ufBehindL,
    };
  }

  private toDialyser(r: Record<string, unknown>): DialyserUseRow {
    const useNo = asNumber(r.use_no);
    const maxUses = asNumberOrNull(r.max_uses);
    const tcv = asNumberOrNull(r.tcv_pct);
    const integrity = asBoolOrNull(r.integrity_ok);
    const discardedAt = asTextOrNull(r.discarded_at);
    const reprocessedAt = asTextOrNull(r.reprocessed_at);
    const floor = asNumber(r.tcv_floor);

    // The forward reading of §B.6, in the order the trigger checks it.
    const blockedBy: string[] = [];
    if (discardedAt !== null) blockedBy.push('it has been discarded');
    if (maxUses !== null && useNo >= maxUses)
      blockedBy.push(`it has reached its limit of ${String(maxUses)}`);
    if (reprocessedAt === null) blockedBy.push('it has not been reprocessed since this use');
    else if (integrity !== true) blockedBy.push('its integrity test has not passed');
    else if (tcv === null || tcv < floor) {
      blockedBy.push(
        `its cell volume is ${tcv === null ? 'unrecorded' : `${String(tcv)} %`}, below the ${String(floor)} % floor`,
      );
    }

    return {
      id: asText(r.id),
      programId: asText(r.program_id),
      label: asText(r.label),
      itemId: asTextOrNull(r.item_id),
      useNo,
      sessionId: asTextOrNull(r.session_id),
      reprocessedAt,
      tcvPct: tcv,
      integrityOk: integrity,
      chemical: asTextOrNull(r.chemical),
      discardedAt,
      discardReason: asTextOrNull(r.discard_reason),
      usesRemaining: maxUses === null ? null : Math.max(maxUses - useNo, 0),
      nextUseLicensed: blockedBy.length === 0,
      blockedBy,
    };
  }
}

/**
 * The live prescription is the one whose effective date has arrived, latest
 * first — the same ordering `dialyser_use_is_licensed()` uses, so the reuse
 * limit a screen shows and the one the trigger counts against are one figure.
 */
const LIVE_PRESCRIPTION = `
  LEFT JOIN LATERAL (
    SELECT rx.id, rx.duration_min, rx.frequency_per_week, rx.uf_max_rate_ml_kg_h, rx.dialyser_max_uses
      FROM specialty.dialysis_prescriptions rx
     WHERE rx.program_id = p.id
     ORDER BY (rx.effective_from <= current_date) DESC, rx.effective_from DESC, rx.version DESC
     LIMIT 1
  ) rx ON true`;

const PROGRAM_SELECT = `
  SELECT p.*,
         (current_date - p.dry_weight_updated_at::date) AS dry_weight_age_days,
         CASE WHEN p.viral_status ? 'testedAt'
              THEN (current_date - (p.viral_status ->> 'testedAt')::timestamptz::date)
         END AS serology_age_days,
         rx.id AS prescription_id, rx.duration_min, rx.frequency_per_week,
         rx.uf_max_rate_ml_kg_h, rx.dialyser_max_uses,
         acc.id AS active_access_id,
         acc.label AS active_access_label,
         coalesce(accn.n, 0) AS active_access_count
    FROM specialty.dialysis_programs p
    ${LIVE_PRESCRIPTION}
    LEFT JOIN LATERAL (
      SELECT a.id, a.type || ' at the ' || a.site AS label
        FROM specialty.dialysis_vascular_accesses a
       WHERE a.program_id = p.id AND a.status = 'active'
       ORDER BY a.created_at DESC LIMIT 1
    ) acc ON true
    LEFT JOIN LATERAL (
      SELECT count(*) AS n FROM specialty.dialysis_vascular_accesses a
       WHERE a.program_id = p.id AND a.status = 'active'
    ) accn ON true`;

const SESSION_SELECT = `
  SELECT s.*,
         m.code AS machine_code, m.zone::text AS machine_zone, m.status::text AS machine_status,
         p.isolation_zone::text AS patient_zone, p.dry_weight_kg,
         rx.uf_max_rate_ml_kg_h,
         a.status AS access_status,
         CASE WHEN s.connect_at IS NOT NULL
              THEN (extract(epoch FROM (coalesce(s.disconnect_at, now()) - s.connect_at)) / 60)::int
         END AS minutes_run
    FROM specialty.dialysis_sessions s
    JOIN specialty.dialysis_programs p ON p.id = s.program_id
    JOIN specialty.dialysis_prescriptions rx ON rx.id = s.prescription_id
    LEFT JOIN specialty.dialysis_machines m ON m.id = s.machine_id
    LEFT JOIN specialty.dialysis_vascular_accesses a ON a.id = s.access_id`;

const MACHINE_SELECT = `
  SELECT m.*,
         (SELECT count(*) FROM specialty.dialysis_sessions s
           WHERE s.machine_id = m.id
             AND s.status IN ('scheduled','checked_in','on_machine')) AS live_sessions
    FROM specialty.dialysis_machines m
   WHERE m.hospital_id = $1 AND m.branch_id = $2`;

const DIALYSER_SELECT = `
  SELECT u.*,
         rx.dialyser_max_uses AS max_uses,
         specialty.dialyser_tcv_floor_pct() AS tcv_floor
    FROM specialty.dialyser_uses u
    JOIN specialty.dialysis_programs p ON p.id = u.program_id
    ${LIVE_PRESCRIPTION}`;
