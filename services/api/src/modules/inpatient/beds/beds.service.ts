import { Inject, Injectable } from '@nestjs/common';
import { ProblemType, newId, type Page } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService, type TransactionClient } from '../../../core/db/database.service.js';
import { NumberingService } from '../../../core/numbering/numbering.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import { withBedErrors } from './beds.errors.js';
import { bedEvent } from './beds.events.js';
import {
  HOLD_TTL_MINUTES,
  type AdmissionQuery,
  type AdmissionRequestBody,
  type AdmitRequest,
  type BedClassRequest,
  type BedRequest,
  type BlockRequest,
  type BoardQuery,
  type BuildingRequest,
  type CleaningActionRequest,
  type CleaningQuery,
  type DischargeRequest,
  type HoldRequest,
  type ReleaseHoldRequest,
  type RoomRequest,
  type TransferRequest,
  type WardRequest,
} from './beds.schemas.js';
import type {
  AdmissionDetailView,
  AdmissionView,
  BedBoardRow,
  CensusRow,
  CleaningTaskView,
  TransferView,
} from './beds.types.js';

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
 * Phase 7A — beds, admissions, transfers and turnover.
 *
 * ── Allocation is a lock, not a query ───────────────────────────────────────
 *
 * `allocate` runs `SELECT … FOR UPDATE SKIP LOCKED` over the candidate beds
 * inside the admitting transaction. `SKIP LOCKED` is the important half: two
 * simultaneous admissions do not queue behind each other and then fight over
 * the same row — the second one simply sees a different bed. Behind it sits a
 * GiST exclusion constraint on (bed, time range), so even a caller that skipped
 * this method cannot put two patients in one bed. `phase-07` exit gate 1 fires
 * fifty concurrent claims at one bed; the lock makes that fast and the
 * constraint makes it true.
 *
 * ── Nothing here counts beds ────────────────────────────────────────────────
 *
 * Every census figure is a query over `ip_bed_occupancies` through
 * `clinical.v_bed_board`. There is no counter to keep in step, which is why
 * rebuilding the board from the admissions tables and comparing it to the live
 * board — exit gate 2 — is a tautology rather than a test that can fail
 * mysteriously at 4 a.m.
 */
@Injectable()
export class BedsService {
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
    return withBedErrors(() => this.db.withTenant(currentTenantContext(), fn));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Configuration
  // ═══════════════════════════════════════════════════════════════════════════

  async createBuilding(body: BuildingRequest): Promise<{ readonly id: string }> {
    return this.guard(async (tx) => {
      const id = newId();
      await tx.query(
        `INSERT INTO clinical.ip_buildings (id, hospital_id, branch_id, code, name, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, now(), now())`,
        [id, this.hospitalId(), this.branchId(), body.code, body.name],
      );
      return { id };
    });
  }

  async createWard(body: WardRequest): Promise<{ readonly id: string }> {
    return this.guard(async (tx) => {
      const id = newId();
      await tx.query(
        `INSERT INTO clinical.ip_wards (
           id, hospital_id, branch_id, building_id, code, name, floor, ward_type,
           cleaning_sla_minutes, sex_policy, min_age_years, max_age_years, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now(),now())`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.buildingId,
          body.code,
          body.name,
          body.floor,
          body.wardType,
          body.cleaningSlaMinutes,
          body.sexPolicy,
          body.minAgeYears ?? null,
          body.maxAgeYears ?? null,
        ],
      );
      return { id };
    });
  }

  async createBedClass(body: BedClassRequest): Promise<{ readonly id: string }> {
    return this.guard(async (tx) => {
      const id = newId();
      await tx.query(
        `INSERT INTO clinical.ip_bed_classes (id, hospital_id, code, name, tier, tariff_service_id, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,now(),now())`,
        [id, this.hospitalId(), body.code, body.name, body.tier, body.tariffServiceId ?? null],
      );
      return { id };
    });
  }

  async createRoom(body: RoomRequest): Promise<{ readonly id: string }> {
    return this.guard(async (tx) => {
      const id = newId();
      await tx.query(
        `INSERT INTO clinical.ip_rooms (id, hospital_id, ward_id, class_id, code, name, is_shared, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now(),now())`,
        [id, this.hospitalId(), body.wardId, body.classId, body.code, body.name ?? null, body.isShared],
      );
      return { id };
    });
  }

  async createBed(body: BedRequest): Promise<{ readonly id: string }> {
    return this.guard(async (tx) => {
      const id = newId();
      await tx.query(
        `INSERT INTO clinical.ip_beds (
           id, hospital_id, branch_id, ward_id, room_id, class_id, code, status,
           isolation_capable, has_oxygen_point, has_monitor, has_ventilator_point, has_attendant_bed,
           created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'available',$8,$9,$10,$11,$12,now(),now())`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.wardId,
          body.roomId,
          body.classId,
          body.code,
          body.isolationCapable,
          body.hasOxygenPoint,
          body.hasMonitor,
          body.hasVentilatorPoint,
          body.hasAttendantBed,
        ],
      );
      return { id };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The board
  // ═══════════════════════════════════════════════════════════════════════════

  private toBoardRow(r: Record<string, unknown>): BedBoardRow {
    return {
      bedId: asText(r['bed_id']),
      bedCode: asText(r['bed_code']),
      status: asText(r['status']),
      wardId: asText(r['ward_id']),
      wardCode: asText(r['ward_code']),
      wardName: asText(r['ward_name']),
      wardType: asText(r['ward_type']),
      roomCode: asText(r['room_code']),
      classId: asText(r['class_id']),
      classCode: asText(r['class_code']),
      tier: asNumber(r['tier']),
      isolationCapable: asBool(r['isolation_capable']),
      hasOxygenPoint: asBool(r['has_oxygen_point']),
      hasMonitor: asBool(r['has_monitor']),
      hasVentilatorPoint: asBool(r['has_ventilator_point']),
      hasAttendantBed: asBool(r['has_attendant_bed']),
      admissionId: asTextOrNull(r['admission_id']),
      patientId: asTextOrNull(r['patient_id']),
      ipNo: asTextOrNull(r['ip_no']),
      occupiedSince: asTextOrNull(r['occupied_since']),
      expectedDischargeAt: asTextOrNull(r['expected_discharge_at']),
      attendingDoctorId: asTextOrNull(r['attending_doctor_id']),
      holdId: asTextOrNull(r['hold_id']),
      holdExpiresAt: asTextOrNull(r['hold_expires_at']),
      holdReason: asTextOrNull(r['hold_reason']),
      cleaningTaskId: asTextOrNull(r['cleaning_task_id']),
      cleaningState: asTextOrNull(r['cleaning_state']),
      cleaningDueAt: asTextOrNull(r['cleaning_due_at']),
      cleaningBreached: asBool(r['cleaning_breached']),
    };
  }

  async board(query: BoardQuery): Promise<Page<BedBoardRow>> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM clinical.v_bed_board
          WHERE hospital_id = $1 AND branch_id = $2
            AND ($3::uuid IS NULL OR ward_id = $3)
            AND ($4::text IS NULL OR ward_type = $4)
            AND ($5::uuid IS NULL OR class_id = $5)
            AND ($6::text IS NULL OR status::text = $6)
            AND (NOT $7::boolean OR (status = 'available' AND hold_id IS NULL))
          ORDER BY ward_code, room_code, bed_code
          LIMIT $8`,
        [
          this.hospitalId(),
          this.branchId(),
          query.wardId ?? null,
          query.wardType ?? null,
          query.classId ?? null,
          query.status ?? null,
          query.freeOnly,
          query.limit,
        ],
      );
      return { items: rows.map((r) => this.toBoardRow(r)), nextCursor: null, hasMore: false };
    });
  }

  /**
   * The census, as a query over the board.
   *
   * `occupancyPct` divides by *usable* beds, not by all of them: a ward with
   * twenty beds of which four are blocked for maintenance is running at 16/16,
   * not 16/20, and reporting the second makes a full ward look like it has room.
   */
  async census(): Promise<readonly CensusRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT ward_id, ward_code, ward_name, ward_type,
                count(*)                                          AS total,
                count(*) FILTER (WHERE status = 'occupied')       AS occupied,
                count(*) FILTER (WHERE status = 'available')      AS available,
                count(*) FILTER (WHERE status = 'cleaning')       AS cleaning,
                count(*) FILTER (WHERE status IN ('blocked','retired')) AS blocked,
                count(*) FILTER (WHERE hold_id IS NOT NULL)       AS held,
                count(*) FILTER (WHERE cleaning_breached)         AS cleaning_breached,
                count(*) FILTER (WHERE expected_discharge_at IS NOT NULL
                                   AND expected_discharge_at::date = CURRENT_DATE) AS due_today,
                CASE WHEN count(*) FILTER (WHERE status NOT IN ('blocked','retired')) = 0 THEN '0.0'
                     ELSE to_char(100.0 * count(*) FILTER (WHERE status = 'occupied')
                                  / count(*) FILTER (WHERE status NOT IN ('blocked','retired')), 'FM990.0')
                END AS occupancy_pct
           FROM clinical.v_bed_board
          WHERE hospital_id = $1 AND branch_id = $2
          GROUP BY ward_id, ward_code, ward_name, ward_type
          ORDER BY ward_code`,
        [this.hospitalId(), this.branchId()],
      );
      return rows.map((r): CensusRow => ({
        wardId: asText(r['ward_id']),
        wardCode: asText(r['ward_code']),
        wardName: asText(r['ward_name']),
        wardType: asText(r['ward_type']),
        total: asNumber(r['total']),
        occupied: asNumber(r['occupied']),
        available: asNumber(r['available']),
        cleaning: asNumber(r['cleaning']),
        blocked: asNumber(r['blocked']),
        held: asNumber(r['held']),
        occupancyPct: asText(r['occupancy_pct']),
        cleaningBreached: asNumber(r['cleaning_breached']),
        dueForDischargeToday: asNumber(r['due_today']),
      }));
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Allocation
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Find and lock a bed, inside the caller's transaction.
   *
   * `FOR UPDATE SKIP LOCKED` rather than plain `FOR UPDATE`: two admissions
   * happening at once should each get *a* bed, not queue behind each other for
   * the same one and then have the loser fail. Skipping a locked row means the
   * second transaction simply looks at the next candidate.
   *
   * The `NOT EXISTS` on live holds is inside the same statement rather than a
   * prior check, because a hold taken between the check and the lock is exactly
   * the race this method exists to lose safely.
   */
  private async allocate(
    tx: TransactionClient,
    body: AdmitRequest,
  ): Promise<{ readonly bedId: string; readonly classId: string }> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT b.id, b.class_id
         FROM clinical.ip_beds b
        WHERE b.hospital_id = $1 AND b.branch_id = $2
          AND b.is_active
          AND b.status = 'available'
          AND b.class_id = $3
          AND ($4::uuid IS NULL OR b.ward_id = $4)
          AND (NOT $5::boolean OR b.isolation_capable)
          AND (NOT $6::boolean OR b.has_ventilator_point)
          AND (NOT $7::boolean OR b.has_monitor)
          AND (NOT $8::boolean OR b.has_attendant_bed)
          AND NOT EXISTS (
                SELECT 1 FROM clinical.ip_bed_holds h
                 WHERE h.bed_id = b.id AND h.released_at IS NULL AND h.expires_at > now()
                   AND ($9::uuid IS NULL OR h.admission_id IS DISTINCT FROM $9)
              )
        ORDER BY (b.id = $10::uuid) DESC, b.code
        FOR UPDATE SKIP LOCKED
        LIMIT 1`,
      [
        this.hospitalId(),
        this.branchId(),
        body.classId,
        body.wardId ?? null,
        body.needsIsolation,
        body.needsVentilatorPoint,
        body.needsMonitor,
        body.needsAttendantBed,
        null,
        body.preferredBedId ?? null,
      ],
    );

    const row = rows[0];
    if (row !== undefined) {
      return { bedId: asText(row['id']), classId: asText(row['class_id']) };
    }

    // "No bed" is a useless answer to somebody holding a patient. Say what the
    // class actually looks like right now, so they can ask for the right thing.
    const { rows: why } = await tx.query<Record<string, unknown>>(
      `SELECT count(*) FILTER (WHERE status = 'occupied')  AS occupied,
              count(*) FILTER (WHERE status = 'cleaning')  AS cleaning,
              count(*) FILTER (WHERE status = 'blocked')   AS blocked,
              count(*) FILTER (WHERE status = 'available') AS available,
              count(*)                                     AS total
         FROM clinical.ip_beds
        WHERE hospital_id = $1 AND branch_id = $2 AND class_id = $3 AND is_active`,
      [this.hospitalId(), this.branchId(), body.classId],
    );
    const w = why[0] ?? {};
    throw AppError.conflict(
      `No bed in that class is free right now — ${asText(w['total'] ?? 0)} in the class: ` +
        `${asText(w['occupied'] ?? 0)} occupied, ${asText(w['cleaning'] ?? 0)} awaiting a clean, ` +
        `${asText(w['blocked'] ?? 0)} blocked, ${asText(w['available'] ?? 0)} free but held or filtered out.`,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Admission
  // ═══════════════════════════════════════════════════════════════════════════

  async requestAdmission(body: AdmissionRequestBody): Promise<AdmissionDetailView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();
      const branch = this.branchId();
      const id = newId();

      const alloc = await this.numbering.allocate(tx, {
        key: 'IP_NO',
        branchId: branch,
        refType: 'admission',
        refId: id,
      });

      await tx.query(
        `INSERT INTO clinical.ip_admissions (
           id, hospital_id, branch_id, patient_id, er_visit_id, opd_visit_id, ip_no, kind, status,
           registration_complete, attending_doctor_id, admitting_doctor_id, department,
           provisional_diagnosis, icd10, payer_id, entitled_class_id, package_id,
           expected_discharge_at, requested_at, requested_by, notes, created_at, updated_at
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8::clinical."AdmissionKind",'requested',
           $9,$10,$11,$12,$13,$14,$15,$16,$17,$18::timestamptz,now(),$19,$20,now(),now()
         )`,
        [
          id,
          hospital,
          branch,
          body.patientId,
          body.erVisitId ?? null,
          body.opdVisitId ?? null,
          alloc.formatted,
          body.kind,
          // An ER fast-track admission is admitted and treated before the desk
          // catches up. Registration is a paperwork state, never a care gate.
          body.kind !== 'er_fast_track',
          body.attendingDoctorId ?? null,
          body.admittingDoctorId ?? this.actorId(),
          body.department ?? null,
          body.provisionalDiagnosis ?? null,
          body.icd10 ?? null,
          body.payerId ?? null,
          body.entitledClassId ?? null,
          body.packageId ?? null,
          body.expectedDischargeAt ?? null,
          this.actorId(),
          body.notes ?? null,
        ],
      );

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'admission',
        rowId: id,
        businessKey: alloc.formatted,
        dataClass: 'phi',
        before: null,
        after: { patientId: body.patientId, kind: body.kind, erVisitId: body.erVisitId ?? null },
      });

      return this.loadAdmission(tx, id);
    });
  }

  /**
   * Admit: allocate, occupy, and start the clock — one transaction.
   *
   * The deposit is captured but never gates the admission. There is no
   * pay-first anywhere in this system (Parmanand Katara); a shortfall is an
   * event the cash desk follows up, not a door that stays shut.
   */
  async admit(admissionId: string, body: AdmitRequest): Promise<AdmissionDetailView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();

      const { rows: found } = await tx.query<Record<string, unknown>>(
        `SELECT ip_no, patient_id, kind::text AS kind, status::text AS status,
                entitled_class_id, deposit_suggested
           FROM clinical.ip_admissions WHERE id = $1 AND hospital_id = $2`,
        [admissionId, hospital],
      );
      const adm = found[0];
      if (adm === undefined) throw AppError.notFound('That admission is not on this hospital’s record.');
      if (asText(adm['status']) !== 'requested') {
        throw AppError.conflict('That admission has already been admitted, or it was cancelled.');
      }

      const bed = await this.allocate(tx, body);

      await tx.query(
        `INSERT INTO clinical.ip_bed_occupancies (
           id, hospital_id, branch_id, admission_id, bed_id, patient_id, class_id, from_at, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,now(),now(),now())`,
        [newId(), hospital, this.branchId(), admissionId, bed.bedId, asText(adm['patient_id']), bed.classId],
      );

      await tx.query(`UPDATE clinical.ip_beds SET status = 'occupied', updated_at = now() WHERE id = $1`, [
        bed.bedId,
      ]);

      // Any hold this admission was holding has been honoured.
      await tx.query(
        `UPDATE clinical.ip_bed_holds
            SET released_at = now(), released_by = $3, release_reason = 'admitted', updated_at = now()
          WHERE bed_id = $1 AND released_at IS NULL AND hospital_id = $2`,
        [bed.bedId, hospital, this.actorId()],
      );

      const suggested = asNumberOrNull(adm['deposit_suggested']);
      await tx.query(
        `UPDATE clinical.ip_admissions
            SET status = 'admitted', admitted_at = now(), admitted_by = $3,
                consent_id = COALESCE($4, consent_id),
                deposit_taken = $5, deposit_approval_id = $6,
                registration_complete = $7, updated_at = now()
          WHERE id = $1 AND hospital_id = $2`,
        [
          admissionId,
          hospital,
          this.actorId(),
          body.consentId ?? null,
          body.depositTaken,
          body.depositApprovalId ?? null,
          body.registrationComplete && asText(adm['kind']) !== 'er_fast_track',
        ],
      );

      const detail = await this.loadAdmission(tx, admissionId);

      await this.audit.write(tx, {
        action: 'update',
        entity: 'admission',
        rowId: admissionId,
        businessKey: asText(adm['ip_no']),
        dataClass: 'phi',
        before: { status: 'requested' },
        after: { status: 'admitted', bedId: bed.bedId, depositTaken: body.depositTaken },
      });

      await this.outbox.publish(
        tx,
        bedEvent('admission.admitted', admissionId, {
          admissionId,
          ipNo: asText(adm['ip_no']),
          patientId: asText(adm['patient_id']),
          bedId: bed.bedId,
          wardId: detail.bedId === null ? bed.bedId : (detail.classId ?? bed.classId),
          classId: bed.classId,
          kind: asText(adm['kind']),
          erVisitId: detail.erVisitId,
          registrationComplete: detail.registrationComplete,
        }),
      );

      await this.outbox.publish(
        tx,
        bedEvent('bed.occupied', bed.bedId, {
          bedId: bed.bedId,
          bedCode: detail.bedCode ?? '',
          wardId: bed.classId,
          admissionId,
          patientId: asText(adm['patient_id']),
          classId: bed.classId,
        }),
      );

      // A shortfall is a fact somebody follows up, not a barrier. Emitted
      // separately so the cash desk can count them without parsing amounts.
      if (suggested !== null && body.depositTaken < suggested) {
        await this.outbox.publish(
          tx,
          bedEvent('admission.deposit.short', admissionId, {
            admissionId,
            ipNo: asText(adm['ip_no']),
            suggested: suggested.toFixed(2),
            taken: body.depositTaken.toFixed(2),
            approvalId: body.depositApprovalId ?? null,
            reason: getContext().reason ?? 'not stated',
          }),
        );
      }

      return detail;
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Reads
  // ═══════════════════════════════════════════════════════════════════════════

  private toAdmission(r: Record<string, unknown>): AdmissionView {
    const admittedAt = asTextOrNull(r['admitted_at']);
    const dischargedAt = asTextOrNull(r['discharged_at']);
    const until = dischargedAt === null ? Date.now() : new Date(dischargedAt).getTime();
    return {
      id: asText(r['id']),
      ipNo: asText(r['ip_no']),
      patientId: asText(r['patient_id']),
      erVisitId: asTextOrNull(r['er_visit_id']),
      kind: asText(r['kind']),
      status: asText(r['status']),
      registrationComplete: asBool(r['registration_complete']),
      attendingDoctorId: asTextOrNull(r['attending_doctor_id']),
      department: asTextOrNull(r['department']),
      provisionalDiagnosis: asTextOrNull(r['provisional_diagnosis']),
      payerId: asTextOrNull(r['payer_id']),
      entitledClassId: asTextOrNull(r['entitled_class_id']),
      depositSuggested: asNumberOrNull(r['deposit_suggested']),
      depositTaken: asNumber(r['deposit_taken'] ?? 0),
      requestedAt: asText(r['requested_at']),
      admittedAt,
      expectedDischargeAt: asTextOrNull(r['expected_discharge_at']),
      dischargedAt,
      outcome: asTextOrNull(r['outcome']),
      bedId: asTextOrNull(r['bed_id']),
      bedCode: asTextOrNull(r['bed_code']),
      wardName: asTextOrNull(r['ward_name']),
      classId: asTextOrNull(r['class_id']),
      classCode: asTextOrNull(r['class_code']),
      aboveEntitlement: asBool(r['above_entitlement']),
      lengthOfStayHours:
        admittedAt === null
          ? null
          : Math.max(0, Math.round((until - new Date(admittedAt).getTime()) / 3_600_000)),
    };
  }

  /**
   * The admission read model, with where the patient is and whether that is
   * dearer than their payer covers.
   *
   * The entitlement comparison is a tier comparison rather than an id match, so
   * "eligible up to semi-private" is one number against another instead of a
   * list somebody maintains. In India a proportionate deduction applies to the
   * *whole* bill, not just to the room line, which is why this is surfaced at
   * admission and not left to settlement.
   */
  private readonly admissionSelect = `
    SELECT a.*,
           o.bed_id, b.code AS bed_code, w.name AS ward_name,
           o.class_id, c.code AS class_code,
           (e.tier IS NOT NULL AND c.tier > e.tier) AS above_entitlement
      FROM clinical.ip_admissions a
      LEFT JOIN clinical.ip_bed_occupancies o ON o.admission_id = a.id AND o.to_at IS NULL
      LEFT JOIN clinical.ip_beds b        ON b.id = o.bed_id
      LEFT JOIN clinical.ip_wards w       ON w.id = b.ward_id
      LEFT JOIN clinical.ip_bed_classes c ON c.id = o.class_id
      LEFT JOIN clinical.ip_bed_classes e ON e.id = a.entitled_class_id`;

  async listAdmissions(query: AdmissionQuery): Promise<Page<AdmissionView>> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `${this.admissionSelect}
          WHERE a.hospital_id = $1 AND a.branch_id = $2
            AND ($3::text IS NULL OR a.status::text = $3)
            AND ($4::uuid IS NULL OR b.ward_id = $4)
            AND ($5::uuid IS NULL OR a.patient_id = $5)
            AND ($6::uuid IS NULL OR a.attending_doctor_id = $6)
            AND (NOT $7::boolean OR (a.expected_discharge_at IS NOT NULL
                                     AND a.expected_discharge_at::date <= CURRENT_DATE
                                     AND a.status = 'admitted'))
          ORDER BY a.status = 'admitted' DESC, a.admitted_at DESC NULLS LAST, a.requested_at DESC
          LIMIT $8`,
        [
          this.hospitalId(),
          this.branchId(),
          query.status ?? null,
          query.wardId ?? null,
          query.patientId ?? null,
          query.attendingDoctorId ?? null,
          query.dueForDischarge,
          query.limit,
        ],
      );
      return { items: rows.map((r) => this.toAdmission(r)), nextCursor: null, hasMore: false };
    });
  }

  private async loadAdmission(tx: TransactionClient, id: string): Promise<AdmissionDetailView> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `${this.admissionSelect} WHERE a.id = $1 AND a.hospital_id = $2`,
      [id, this.hospitalId()],
    );
    const row = rows[0];
    if (row === undefined) throw AppError.notFound('That admission is not on this hospital’s record.');

    const [transfers, occupancies] = await Promise.all([
      tx.query<Record<string, unknown>>(
        `SELECT t.*, fb.code AS from_bed_code, tb.code AS to_bed_code,
                fc.code AS from_class_code, tc.code AS to_class_code
           FROM clinical.ip_bed_transfers t
           LEFT JOIN clinical.ip_beds fb        ON fb.id = t.from_bed_id
           LEFT JOIN clinical.ip_beds tb        ON tb.id = t.to_bed_id
           LEFT JOIN clinical.ip_bed_classes fc ON fc.id = t.from_class_id
           LEFT JOIN clinical.ip_bed_classes tc ON tc.id = t.to_class_id
          WHERE t.admission_id = $1 ORDER BY t.at DESC`,
        [id],
      ),
      tx.query<Record<string, unknown>>(
        `SELECT o.id, b.code AS bed_code, w.name AS ward_name, c.code AS class_code,
                o.from_at, o.to_at, o.end_reason,
                EXTRACT(epoch FROM (COALESCE(o.to_at, now()) - o.from_at)) / 3600 AS hours
           FROM clinical.ip_bed_occupancies o
           JOIN clinical.ip_beds b        ON b.id = o.bed_id
           JOIN clinical.ip_wards w       ON w.id = b.ward_id
           JOIN clinical.ip_bed_classes c ON c.id = o.class_id
          WHERE o.admission_id = $1 ORDER BY o.from_at`,
        [id],
      ),
    ]);

    return {
      ...this.toAdmission(row),
      notes: asTextOrNull(row['notes']),
      transfers: transfers.rows.map((t): TransferView => ({
        id: asText(t['id']),
        admissionId: asText(t['admission_id']),
        kind: asText(t['kind']),
        reason: asText(t['reason']),
        fromBedCode: asTextOrNull(t['from_bed_code']),
        toBedCode: asTextOrNull(t['to_bed_code']),
        fromClassCode: asTextOrNull(t['from_class_code']),
        toClassCode: asTextOrNull(t['to_class_code']),
        situation: asTextOrNull(t['situation']),
        background: asTextOrNull(t['background']),
        assessment: asTextOrNull(t['assessment']),
        recommendation: asTextOrNull(t['recommendation']),
        linesAndTubes: asStringArray(t['lines_and_tubes']),
        infusions: asStringArray(t['infusions']),
        pendingResults: asStringArray(t['pending_results']),
        allergies: asStringArray(t['allergies']),
        destinationFacility: asTextOrNull(t['destination_facility']),
        stabilityNote: asTextOrNull(t['stability_note']),
        handedOverBy: asTextOrNull(t['handed_over_by']),
        acceptedBy: asTextOrNull(t['accepted_by']),
        acceptedAt: asTextOrNull(t['accepted_at']),
        at: asText(t['at']),
      })),
      occupancies: occupancies.rows.map((o) => ({
        id: asText(o['id']),
        bedCode: asText(o['bed_code']),
        wardName: asText(o['ward_name']),
        classCode: asText(o['class_code']),
        fromAt: asText(o['from_at']),
        toAt: asTextOrNull(o['to_at']),
        endReason: asTextOrNull(o['end_reason']),
        hours: Math.round(asNumber(o['hours']) * 10) / 10,
      })),
    };
  }

  async getAdmission(id: string): Promise<AdmissionDetailView> {
    return this.guard((tx) => this.loadAdmission(tx, id));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Holds
  // ═══════════════════════════════════════════════════════════════════════════

  async hold(body: HoldRequest): Promise<{ readonly id: string; readonly expiresAt: string }> {
    return this.guard(async (tx) => {
      const id = newId();
      const minutes = body.minutes ?? HOLD_TTL_MINUTES[body.reason] ?? 120;

      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO clinical.ip_bed_holds (
           id, hospital_id, branch_id, bed_id, admission_id, patient_id, reason,
           held_at, held_by, expires_at, notes, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7::clinical."HoldReason",
                   now(), $8, now() + make_interval(mins => $9::int), $10, now(), now())
         RETURNING expires_at`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.bedId,
          body.admissionId ?? null,
          body.patientId ?? null,
          body.reason,
          this.actorId(),
          minutes,
          body.notes ?? null,
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The hold was not taken.');

      await tx.query(
        `UPDATE clinical.ip_beds SET status = 'reserved', updated_at = now()
          WHERE id = $1 AND hospital_id = $2 AND status = 'available'`,
        [body.bedId, this.hospitalId()],
      );

      return { id, expiresAt: asText(row['expires_at']) };
    });
  }

  async releaseHold(id: string, body: ReleaseHoldRequest): Promise<{ readonly released: boolean }> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.ip_bed_holds
            SET released_at = now(), released_by = $3, release_reason = $4, updated_at = now()
          WHERE id = $1 AND hospital_id = $2 AND released_at IS NULL
          RETURNING bed_id, held_at`,
        [id, this.hospitalId(), this.actorId(), body.reason],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('That hold is not live.');

      // Reserved becomes available again. A bed nobody was in needs no clean,
      // which is why the trigger lets `reserved → available` through.
      await tx.query(
        `UPDATE clinical.ip_beds SET status = 'available', updated_at = now()
          WHERE id = $1 AND hospital_id = $2 AND status = 'reserved'`,
        [asText(row['bed_id']), this.hospitalId()],
      );

      if (body.reason === 'expired') {
        await this.outbox.publish(
          tx,
          bedEvent('bed.hold.expired', id, {
            holdId: id,
            bedId: asText(row['bed_id']),
            bedCode: '',
            reason: body.reason,
            heldMinutes: Math.max(
              0,
              Math.round((Date.now() - new Date(asText(row['held_at'])).getTime()) / 60_000),
            ),
            patientId: null,
          }),
        );
      }

      return { released: true };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Blocking
  // ═══════════════════════════════════════════════════════════════════════════

  async block(bedId: string, body: BlockRequest): Promise<{ readonly status: string }> {
    return this.guard(async (tx) => {
      const reason = this.reason(body.blocked ? 'Blocking a bed' : 'Returning a bed to service');

      // Beyond twenty-four hours it needs an approval. Not a shape — the shape
      // only insists on a reason — because "how long" is a plan that changes,
      // and refusing at hour 25 would strand a bed nobody may touch.
      if (body.blocked && (body.expectedHours ?? 0) > 24 && body.approvalId === undefined) {
        throw new AppError(
          ProblemType.VALIDATION_FAILED,
          'Blocking a bed for more than twenty-four hours needs an approval. A bed out of service for a week is a bed the hospital does not have, and somebody senior should have agreed to that.',
        );
      }

      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.ip_beds
            SET status = CASE WHEN $3::boolean THEN 'blocked'::clinical."BedStatus" ELSE 'available'::clinical."BedStatus" END,
                block_reason = CASE WHEN $3::boolean THEN $4 ELSE NULL END,
                blocked_at   = CASE WHEN $3::boolean THEN now() ELSE NULL END,
                blocked_by   = CASE WHEN $3::boolean THEN $5::uuid ELSE NULL END,
                updated_at = now()
          WHERE id = $1 AND hospital_id = $2 AND status IN ('available', 'blocked')
          RETURNING code, status::text AS status`,
        [bedId, this.hospitalId(), body.blocked, reason, this.actorId()],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict(
          'That bed is occupied, reserved or being cleaned — it cannot be blocked now.',
        );
      }

      await this.audit.write(tx, {
        action: 'update',
        entity: 'bed',
        rowId: bedId,
        businessKey: asText(row['code']),
        dataClass: 'operational',
        before: null,
        after: { status: asText(row['status']), reason, expectedHours: body.expectedHours ?? null },
      });

      return { status: asText(row['status']) };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Transfer and discharge
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Move a patient.
   *
   * Close the old occupancy, allocate and open the new one, in one transaction
   * — so the census is never momentarily wrong in either direction, and the
   * exclusion constraint sees a consistent picture at commit.
   */
  async transfer(admissionId: string, body: TransferRequest): Promise<AdmissionDetailView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();
      const at = body.at ?? null;

      const { rows: current } = await tx.query<Record<string, unknown>>(
        `SELECT o.id, o.bed_id, o.class_id, o.patient_id, b.ward_id, w.ward_type, w.cleaning_sla_minutes, b.code AS bed_code
           FROM clinical.ip_bed_occupancies o
           JOIN clinical.ip_beds b  ON b.id = o.bed_id
           JOIN clinical.ip_wards w ON w.id = b.ward_id
          WHERE o.admission_id = $1 AND o.to_at IS NULL`,
        [admissionId],
      );
      const from = current[0];

      const toBedId: string | null = body.toBedId ?? null;
      let toClassId: string | null = body.toClassId ?? null;

      if (body.kind === 'intra_facility' || body.kind === 'return') {
        if (toBedId === null) {
          throw new AppError(ProblemType.VALIDATION_FAILED, 'A move needs a destination bed.');
        }
        const { rows: dest } = await tx.query<Record<string, unknown>>(
          `SELECT id, class_id FROM clinical.ip_beds
            WHERE id = $1 AND hospital_id = $2 AND is_active AND status = 'available'
            FOR UPDATE SKIP LOCKED`,
          [toBedId, hospital],
        );
        const d = dest[0];
        if (d === undefined) throw AppError.conflict('That bed is not free. Somebody has just taken it.');
        toClassId = asText(d['class_id']);
      }

      if (from !== undefined) {
        await tx.query(
          `UPDATE clinical.ip_bed_occupancies
              SET to_at = COALESCE($2::timestamptz, now()), end_reason = $3, updated_at = now()
            WHERE id = $1`,
          [asText(from['id']), at, body.kind === 'leave' ? 'leave' : 'transfer'],
        );
        await this.vacate(tx, asText(from['bed_id']), admissionId, body.kind);
      }

      if (toBedId !== null && toClassId !== null && body.kind !== 'leave' && body.kind !== 'transfer_out') {
        await tx.query(
          `INSERT INTO clinical.ip_bed_occupancies (
             id, hospital_id, branch_id, admission_id, bed_id, patient_id, class_id, from_at, created_at, updated_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE($8::timestamptz, now()), now(), now())`,
          [
            newId(),
            hospital,
            this.branchId(),
            admissionId,
            toBedId,
            from === undefined ? '' : asText(from['patient_id']),
            toClassId,
            at,
          ],
        );
        await tx.query(`UPDATE clinical.ip_beds SET status = 'occupied', updated_at = now() WHERE id = $1`, [
          toBedId,
        ]);
      }

      const transferId = newId();
      await tx.query(
        `INSERT INTO clinical.ip_bed_transfers (
           id, hospital_id, branch_id, admission_id, from_bed_id, to_bed_id, from_class_id, to_class_id,
           kind, reason, situation, background, assessment, recommendation,
           lines_and_tubes, infusions, pending_results, allergies,
           destination_facility, stability_note, documents_pack,
           handed_over_by, at, created_at, updated_at
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
           $15::text[],$16::text[],$17::text[],$18::text[],$19,$20,$21::text[],$22,
           COALESCE($23::timestamptz, now()), now(), now()
         )`,
        [
          transferId,
          hospital,
          this.branchId(),
          admissionId,
          from === undefined ? null : asText(from['bed_id']),
          toBedId,
          from === undefined ? null : asText(from['class_id']),
          toClassId,
          body.kind,
          body.reason,
          body.situation ?? null,
          body.background ?? null,
          body.assessment ?? null,
          body.recommendation ?? null,
          body.linesAndTubes,
          body.infusions,
          body.pendingResults,
          body.allergies,
          body.destinationFacility ?? null,
          body.stabilityNote ?? null,
          body.documentsPack,
          this.actorId(),
          at,
        ],
      );

      if (body.kind === 'leave') {
        await tx.query(
          `UPDATE clinical.ip_admissions SET status = 'on_leave', updated_at = now() WHERE id = $1`,
          [admissionId],
        );
      }

      const detail = await this.loadAdmission(tx, admissionId);

      await this.outbox.publish(
        tx,
        bedEvent('patient.transferred', transferId, {
          transferId,
          admissionId,
          patientId: detail.patientId,
          kind: body.kind,
          fromBedId: from === undefined ? null : asText(from['bed_id']),
          toBedId,
          fromClassId: from === undefined ? null : asText(from['class_id']),
          toClassId,
          at: at ?? new Date().toISOString(),
        }),
      );

      return detail;
    });
  }

  async discharge(admissionId: string, body: DischargeRequest): Promise<AdmissionDetailView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();
      const at = body.at ?? null;

      const { rows: current } = await tx.query<Record<string, unknown>>(
        `SELECT o.id, o.bed_id FROM clinical.ip_bed_occupancies o
          WHERE o.admission_id = $1 AND o.to_at IS NULL`,
        [admissionId],
      );

      for (const occ of current) {
        await tx.query(
          `UPDATE clinical.ip_bed_occupancies
              SET to_at = COALESCE($2::timestamptz, now()), end_reason = 'discharge', updated_at = now()
            WHERE id = $1`,
          [asText(occ['id']), at],
        );
        await this.vacate(tx, asText(occ['bed_id']), admissionId, 'discharge');
      }

      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.ip_admissions
            SET status = 'discharged', discharged_at = COALESCE($3::timestamptz, now()),
                discharged_by = $4, outcome = $5, notes = COALESCE($6, notes), updated_at = now()
          WHERE id = $1 AND hospital_id = $2 AND status IN ('admitted', 'on_leave', 'discharge_initiated')
          RETURNING ip_no`,
        [admissionId, hospital, at, this.actorId(), body.outcome, body.notes ?? null],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('That admission is not open.');

      await this.audit.write(tx, {
        action: 'update',
        entity: 'admission',
        rowId: admissionId,
        businessKey: asText(row['ip_no']),
        dataClass: 'phi',
        before: { status: 'admitted' },
        after: { status: 'discharged', outcome: body.outcome },
      });

      return this.loadAdmission(tx, admissionId);
    });
  }

  /**
   * Empty a bed and dispatch its clean.
   *
   * The cleaning task is raised here rather than by a subscriber to
   * `bed.vacated`, because the bed must not be allocatable in the window
   * between the two. A subscriber is milliseconds behind, and a bed board is
   * read by somebody with a patient on a trolley.
   */
  private async vacate(
    tx: TransactionClient,
    bedId: string,
    admissionId: string,
    reason: string,
  ): Promise<void> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `UPDATE clinical.ip_beds SET status = 'cleaning', updated_at = now()
        WHERE id = $1 AND hospital_id = $2
        RETURNING code, ward_id`,
      [bedId, this.hospitalId()],
    );
    const bed = rows[0];
    if (bed === undefined) return;

    const { rows: ward } = await tx.query<Record<string, unknown>>(
      `SELECT ward_type, cleaning_sla_minutes FROM clinical.ip_wards WHERE id = $1`,
      [asText(bed['ward_id'])],
    );
    const sla = asNumber(ward[0]?.['cleaning_sla_minutes'] ?? 60);

    const taskId = newId();
    const { rows: task } = await tx.query<Record<string, unknown>>(
      `INSERT INTO clinical.ip_cleaning_tasks (
         id, hospital_id, branch_id, bed_id, kind, state, sla_minutes, requested_at, due_at, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,'requested',$6, now(), now(), now(), now())
       RETURNING due_at`,
      [taskId, this.hospitalId(), this.branchId(), bedId, reason === 'discharge' ? 'terminal' : 'daily', sla],
    );

    await this.outbox.publish(
      tx,
      bedEvent('bed.vacated', bedId, {
        bedId,
        bedCode: asText(bed['code']),
        wardId: asText(bed['ward_id']),
        wardType: asText(ward[0]?.['ward_type'] ?? ''),
        admissionId,
        reason,
        occupiedMinutes: 0,
      }),
    );

    await this.outbox.publish(
      tx,
      bedEvent('housekeeping.cleaning.requested', taskId, {
        taskId,
        bedId,
        bedCode: asText(bed['code']),
        wardId: asText(bed['ward_id']),
        kind: reason === 'discharge' ? 'terminal' : 'daily',
        slaMinutes: sla,
        dueAt: asText(task[0]?.['due_at'] ?? ''),
      }),
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Housekeeping
  // ═══════════════════════════════════════════════════════════════════════════

  private toCleaning(r: Record<string, unknown>): CleaningTaskView {
    const dueAt = asText(r['due_at']);
    const state = asText(r['state']);
    const open = state !== 'done' && state !== 'inspected';
    const minutesRemaining = Math.round((new Date(dueAt).getTime() - Date.now()) / 60_000);
    return {
      id: asText(r['id']),
      bedId: asText(r['bed_id']),
      bedCode: asText(r['bed_code']),
      wardId: asText(r['ward_id']),
      wardName: asText(r['ward_name']),
      kind: asText(r['kind']),
      state,
      slaMinutes: asNumber(r['sla_minutes']),
      requestedAt: asText(r['requested_at']),
      dueAt,
      acceptedAt: asTextOrNull(r['accepted_at']),
      startedAt: asTextOrNull(r['started_at']),
      completedAt: asTextOrNull(r['completed_at']),
      inspectedAt: asTextOrNull(r['inspected_at']),
      failReason: asTextOrNull(r['fail_reason']),
      minutesRemaining,
      breached: open && minutesRemaining < 0,
    };
  }

  async cleaningWorklist(query: CleaningQuery): Promise<Page<CleaningTaskView>> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT t.*, b.code AS bed_code, b.ward_id, w.name AS ward_name
           FROM clinical.ip_cleaning_tasks t
           JOIN clinical.ip_beds b  ON b.id = t.bed_id
           JOIN clinical.ip_wards w ON w.id = b.ward_id
          WHERE t.hospital_id = $1 AND t.branch_id = $2
            AND ($3::uuid IS NULL OR b.ward_id = $3)
            AND (NOT $4::boolean OR t.state NOT IN ('done', 'inspected'))
            AND (NOT $5::boolean OR (t.state NOT IN ('done','inspected') AND t.due_at < now()))
          ORDER BY t.state NOT IN ('done','inspected') DESC, t.due_at
          LIMIT $6`,
        [
          this.hospitalId(),
          this.branchId(),
          query.wardId ?? null,
          query.openOnly,
          query.breachedOnly,
          query.limit,
        ],
      );
      return { items: rows.map((r) => this.toCleaning(r)), nextCursor: null, hasMore: false };
    });
  }

  /**
   * Move a cleaning task along, and return the bed when it is done.
   *
   * The bed goes to `available` on `inspect`, or on `complete` where the ward
   * does not inspect. The trigger checks the same thing from the other side, so
   * a caller that forgot this step cannot put the bed back on the board.
   */
  async cleaningAction(taskId: string, body: CleaningActionRequest): Promise<CleaningTaskView> {
    return this.guard(async (tx) => {
      const actor = this.actorId();
      const state =
        body.action === 'accept'
          ? 'accepted'
          : body.action === 'start'
            ? 'in_progress'
            : body.action === 'complete'
              ? 'done'
              : body.action === 'inspect'
                ? 'inspected'
                : 'failed';

      if (body.action === 'fail' && body.failReason === undefined) {
        throw new AppError(
          ProblemType.VALIDATION_FAILED,
          'A failed clean says what was wrong, so the next attempt fixes it.',
        );
      }

      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.ip_cleaning_tasks
            SET state = $3::clinical."CleaningState",
                accepted_at  = CASE WHEN $4::text = 'accept'   THEN now() ELSE accepted_at END,
                accepted_by  = CASE WHEN $4::text = 'accept'   THEN $5::uuid ELSE accepted_by END,
                started_at   = CASE WHEN $4::text = 'start'    THEN now() ELSE started_at END,
                completed_at = CASE WHEN $4::text IN ('complete','inspect') THEN COALESCE(completed_at, now()) ELSE completed_at END,
                completed_by = CASE WHEN $4::text IN ('complete','inspect') THEN COALESCE(completed_by, $5::uuid) ELSE completed_by END,
                inspected_at = CASE WHEN $4::text = 'inspect'  THEN now() ELSE inspected_at END,
                inspected_by = CASE WHEN $4::text = 'inspect'  THEN $5::uuid ELSE inspected_by END,
                fail_reason  = COALESCE($6, fail_reason),
                checklist    = COALESCE($7::jsonb, checklist),
                updated_at = now()
          WHERE id = $1 AND hospital_id = $2
          RETURNING bed_id, requested_at, due_at`,
        [taskId, this.hospitalId(), state, body.action, actor, body.failReason ?? null, json(body.checklist)],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.notFound('That cleaning task is not on this hospital’s list.');

      if (body.action === 'complete' || body.action === 'inspect') {
        const { rows: bed } = await tx.query<Record<string, unknown>>(
          `UPDATE clinical.ip_beds SET status = 'available', updated_at = now()
            WHERE id = $1 AND hospital_id = $2 AND status = 'cleaning'
            RETURNING code, ward_id`,
          [asText(row['bed_id']), this.hospitalId()],
        );
        const b = bed[0];
        if (b !== undefined) {
          await this.outbox.publish(
            tx,
            bedEvent('bed.available', asText(row['bed_id']), {
              bedId: asText(row['bed_id']),
              bedCode: asText(b['code']),
              wardId: asText(b['ward_id']),
              turnaroundMinutes: Math.max(
                0,
                Math.round((Date.now() - new Date(asText(row['requested_at'])).getTime()) / 60_000),
              ),
              overridden: false,
            }),
          );
        }
      }

      const { rows: view } = await tx.query<Record<string, unknown>>(
        `SELECT t.*, b.code AS bed_code, b.ward_id, w.name AS ward_name
           FROM clinical.ip_cleaning_tasks t
           JOIN clinical.ip_beds b  ON b.id = t.bed_id
           JOIN clinical.ip_wards w ON w.id = b.ward_id
          WHERE t.id = $1`,
        [taskId],
      );
      const v = view[0];
      if (v === undefined) throw AppError.conflict('The cleaning task was not updated.');
      return this.toCleaning(v);
    });
  }

  /**
   * Put a bed back on the board without a completed clean.
   *
   * The override exists because the rule would otherwise be worked around by
   * marking a fake clean, and an audited exception is better than a false
   * record. The reason lands on the bed row, which is where the trigger reads
   * it — the same field, so there is one place to look afterwards.
   */
  async overrideCleaning(bedId: string): Promise<{ readonly status: string }> {
    return this.guard(async (tx) => {
      const reason = this.reason('Returning a bed to the board without a clean');

      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.ip_beds
            SET status = 'available', block_reason = $3, updated_at = now()
          WHERE id = $1 AND hospital_id = $2 AND status = 'cleaning'
          RETURNING code, ward_id`,
        [bedId, this.hospitalId(), reason],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('That bed is not awaiting a clean.');

      await this.audit.write(tx, {
        action: 'override',
        entity: 'bed',
        rowId: bedId,
        businessKey: asText(row['code']),
        dataClass: 'operational',
        before: { status: 'cleaning' },
        after: { status: 'available', reason },
      });

      await this.outbox.publish(
        tx,
        bedEvent('bed.available', bedId, {
          bedId,
          bedCode: asText(row['code']),
          wardId: asText(row['ward_id']),
          turnaroundMinutes: null,
          overridden: true,
        }),
      );

      return { status: 'available' };
    });
  }

  /**
   * Expire the holds that have run out.
   *
   * Called by the worker. Written as one statement so a slow run cannot expire
   * a hold that was renewed while it was working through a list.
   */
  async expireHolds(): Promise<{ readonly expired: number }> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.ip_bed_holds
            SET released_at = now(), release_reason = 'expired', updated_at = now()
          WHERE hospital_id = $1 AND released_at IS NULL AND expires_at <= now()
          RETURNING id, bed_id, reason::text AS reason, held_at, patient_id`,
        [this.hospitalId()],
      );

      for (const row of rows) {
        await tx.query(
          `UPDATE clinical.ip_beds SET status = 'available', updated_at = now()
            WHERE id = $1 AND status = 'reserved'`,
          [asText(row['bed_id'])],
        );
        await this.outbox.publish(
          tx,
          bedEvent('bed.hold.expired', asText(row['id']), {
            holdId: asText(row['id']),
            bedId: asText(row['bed_id']),
            bedCode: '',
            reason: asText(row['reason']),
            heldMinutes: Math.max(
              0,
              Math.round((Date.now() - new Date(asText(row['held_at'])).getTime()) / 60_000),
            ),
            patientId: asTextOrNull(row['patient_id']),
          }),
        );
      }

      return { expired: rows.length };
    });
  }
}
