import { Inject, Injectable } from '@nestjs/common';
import { ESI_TARGET_MINUTES, ProblemType, newId, scoreGcs, type Page } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService, type TransactionClient } from '../../../core/db/database.service.js';
import { NumberingService } from '../../../core/numbering/numbering.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import { withFleetErrors } from './fleet.errors.js';
import { fleetEvent } from './fleet.events.js';
import {
  STATE_EMS_SOURCES,
  type AcknowledgePrealertRequest,
  type BoardQuery,
  type ChecklistRequest,
  type CloseTripRequest,
  type CrewRequest,
  type CreateVehicleRequest,
  type DispatchRequest,
  type DivertPrealertRequest,
  type DivertRequest,
  type DocumentRequest,
  type FleetQuery,
  type FleetRequestRequest,
  type FuelRequest,
  type HandoverRequest,
  type MilestoneRequest,
  type PcrRequest,
  type PhDrugRequest,
  type PhInterventionRequest,
  type PositionRequest,
  type PrealertRequest,
  type ShiftRequest,
  type VehicleStatusRequest,
  type VitalsRequest,
} from './fleet.schemas.js';
import type {
  DispatchBoardView,
  FleetRequestView,
  FleetTripView,
  FleetVehicleView,
  HandoverView,
  PrealertView,
  PrehospitalDrugView,
  PrehospitalInterventionView,
  PrehospitalRecordView,
  PrehospitalVitalView,
  TripDetailView,
  VehicleDocumentView,
} from './fleet.types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Row coercion
// ─────────────────────────────────────────────────────────────────────────────

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
function minutesBetween(from: unknown, to: unknown): number | null {
  const a = asTextOrNull(from);
  const b = asTextOrNull(to);
  if (a === null || b === null) return null;
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60_000);
}
function json(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

/** The pre-alert acknowledgement target. Past it, the ER in-charge is called. */
const PREALERT_ACK_TARGET_SECONDS = 120;
/** Over this, the ambulance is standing in the corridor rather than working. */
const OFFLOAD_TARGET_MINUTES = 15;
/** GPS and the odometer disagreeing by more than this needs a human. */
const DISTANCE_TOLERANCE = 0.1;

/**
 * The TR-001 field criteria, evaluated on what the crew found.
 *
 * The same thresholds the ER uses at triage, applied to the road so the
 * pre-alert can say what it is likely to be. It suggests; it never activates.
 * An activation nobody placed is an activation nobody owns.
 */
function fieldActivationCriteria(v: {
  readonly systolicBp: number | null;
  readonly respiratoryRate: number | null;
  readonly gcsTotal: number | null;
  readonly intubated: boolean;
}): { readonly tier: string; readonly criteria: readonly string[] } | null {
  const criteria: string[] = [];
  let levelOne = false;

  if (v.systolicBp !== null && v.systolicBp < 90) {
    criteria.push('field_systolic_bp_under_90');
    levelOne = true;
  }
  if (v.intubated) {
    criteria.push('field_intubation');
    levelOne = true;
  }
  if (v.gcsTotal !== null && !v.intubated && v.gcsTotal <= 8) {
    criteria.push('field_gcs_8_or_less');
    levelOne = true;
  }
  if (v.respiratoryRate !== null && (v.respiratoryRate < 10 || v.respiratoryRate > 29)) {
    criteria.push('field_respiratory_rate_outside_10_29');
    levelOne = true;
  }
  if (v.gcsTotal !== null && !v.intubated && v.gcsTotal > 8 && v.gcsTotal <= 13) {
    criteria.push('field_gcs_9_to_13');
  }

  if (criteria.length === 0) return null;
  return { tier: levelOne ? 'level_1' : 'level_2', criteria };
}

/**
 * NC-013 + TR-009 — the ambulance and the patient in it.
 *
 * ── Exit gate 1 lives in `completeHandover` ─────────────────────────────────
 *
 * "The handover carries the pre-hospital vitals into triage with zero
 * re-keying." That is not a UI convenience here — it is a database write. The
 * last road observation set becomes the first `clinical.triage_records` row,
 * with the same numbers, and the handover records which triage row it made. A
 * nurse retyping a blood pressure at 3 a.m. is a transposed digit, and a
 * transposed digit is a triage level.
 *
 * ── The dispatch rule is explained here and enforced elsewhere ──────────────
 *
 * `dispatchable` and `blockers` on a vehicle view are for the console, so a
 * dispatcher sees a greyed row rather than pressing a button and being refused.
 * The refusal itself is a trigger on `ops.fleet_trips`, because a dispatcher is
 * not the only thing that creates a trip.
 */
@Injectable()
export class FleetService {
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
    if (value === null || value.trim().length < 8) {
      throw new AppError(
        ProblemType.VALIDATION_FAILED,
        `${what} needs a reason of at least eight characters, sent in the \`x-reason\` header.`,
      );
    }
    return value.trim();
  }

  private guard<T>(fn: (tx: TransactionClient) => Promise<T>): Promise<T> {
    return withFleetErrors(() => this.db.withTenant(currentTenantContext(), fn));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The fleet register
  // ═══════════════════════════════════════════════════════════════════════════

  async createVehicle(body: CreateVehicleRequest): Promise<FleetVehicleView> {
    return this.guard(async (tx) => {
      const id = newId();
      await tx.query(
        `INSERT INTO ops.fleet_vehicles (
           id, hospital_id, branch_id, fleet_code, registration_no, type, make, model, year,
           equipment, gps_device_id, fuel_type, tank_capacity_l, ownership, base_station_id,
           status, current_odometer, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6::ops."VehicleType", $7, $8, $9,
           $10::jsonb, $11, $12, $13, $14, $15,
           'not_ready', $16, now(), now()
         )`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.fleetCode,
          body.registrationNo,
          body.type,
          body.make ?? null,
          body.model ?? null,
          body.year ?? null,
          JSON.stringify(body.equipment),
          body.gpsDeviceId ?? null,
          body.fuelType ?? null,
          body.tankCapacityL ?? null,
          body.ownership,
          body.baseStationId ?? null,
          body.currentOdometer,
        ],
      );
      return this.loadVehicle(tx, id);
    });
  }

  async setVehicleStatus(id: string, body: VehicleStatusRequest): Promise<FleetVehicleView> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE ops.fleet_vehicles
            SET status = $2::ops."VehicleStatus", status_reason = $3, updated_at = now()
          WHERE id = $1 AND hospital_id = $4
          RETURNING fleet_code`,
        [id, body.status, body.statusReason ?? null, this.hospitalId()],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.notFound('That vehicle does not exist.');

      // Anything that takes a vehicle off the road is worth an event: the
      // minimum-availability rule reads it, and so does the dispatcher's board.
      if (['maintenance', 'breakdown', 'out_of_service', 'retired'].includes(body.status)) {
        await this.outbox.publish(
          tx,
          fleetEvent('fleet.vehicle.grounded', id, {
            vehicleId: id,
            fleetCode: asText(row['fleet_code']),
            reason: body.statusReason ?? body.status,
            status: body.status,
          }),
        );
      }

      return this.loadVehicle(tx, id);
    });
  }

  async recordDocument(vehicleId: string, body: DocumentRequest): Promise<FleetVehicleView> {
    return this.guard(async (tx) => {
      await tx.query(
        `INSERT INTO ops.fleet_vehicle_documents
           (id, hospital_id, vehicle_id, type, number, issued_on, expiry_on, file_ref, mandatory, created_at, updated_at)
         VALUES ($1, $2, $3, $4::ops."VehicleDocumentType", $5, $6::date, $7::date, $8, $9, now(), now())
         ON CONFLICT (vehicle_id, type) DO UPDATE SET
           number     = EXCLUDED.number,
           issued_on  = EXCLUDED.issued_on,
           expiry_on  = EXCLUDED.expiry_on,
           file_ref   = COALESCE(EXCLUDED.file_ref, ops.fleet_vehicle_documents.file_ref),
           mandatory  = EXCLUDED.mandatory,
           updated_at = now()`,
        [
          newId(),
          this.hospitalId(),
          vehicleId,
          body.type,
          body.number ?? null,
          body.issuedOn ?? null,
          body.expiryOn ?? null,
          body.fileRef ?? null,
          body.mandatory,
        ],
      );
      return this.loadVehicle(tx, vehicleId);
    });
  }

  async listVehicles(query: FleetQuery): Promise<Page<FleetVehicleView>> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT id FROM ops.fleet_vehicles
          WHERE hospital_id = $1 AND branch_id = $2
            AND ($3::text IS NULL OR status::text = $3)
            AND ($4::text IS NULL OR type::text = $4)
            AND ($5::boolean OR status <> 'retired')
          ORDER BY fleet_code
          LIMIT $6`,
        [
          this.hospitalId(),
          this.branchId(),
          query.status ?? null,
          query.type ?? null,
          query.includeRetired,
          query.limit,
        ],
      );
      const items: FleetVehicleView[] = [];
      for (const row of rows) items.push(await this.loadVehicle(tx, asText(row['id'])));
      return { items, nextCursor: null, hasMore: false };
    });
  }

  private async loadVehicle(tx: TransactionClient, id: string): Promise<FleetVehicleView> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM ops.fleet_vehicles WHERE id = $1 AND hospital_id = $2`,
      [id, this.hospitalId()],
    );
    const row = rows[0];
    if (row === undefined) throw AppError.notFound('That vehicle does not exist.');

    const { rows: docRows } = await tx.query<Record<string, unknown>>(
      `SELECT *, (expiry_on - current_date) AS days_to_expiry
         FROM ops.fleet_vehicle_documents WHERE vehicle_id = $1 ORDER BY type`,
      [id],
    );
    const documents: VehicleDocumentView[] = docRows.map((d) => ({
      id: asText(d['id']),
      type: asText(d['type']),
      number: asTextOrNull(d['number']),
      issuedOn: asTextOrNull(d['issued_on']),
      expiryOn: asTextOrNull(d['expiry_on']),
      mandatory: asBool(d['mandatory']),
      daysToExpiry: asNumberOrNull(d['days_to_expiry']),
    }));

    // The same conditions the trigger checks, read rather than enforced.
    const blockers: string[] = [];
    for (const d of documents) {
      if (d.mandatory && d.daysToExpiry !== null && d.daysToExpiry < 0) {
        blockers.push(`${d.type.replace(/_/gu, ' ')} expired ${String(Math.abs(d.daysToExpiry))} days ago`);
      }
    }
    const status = asText(row['status']);
    if (['maintenance', 'breakdown', 'out_of_service', 'retired'].includes(status)) {
      blockers.push(`vehicle is ${status.replace(/_/gu, ' ')}`);
    }
    if (status === 'not_ready') blockers.push('shift-start check not passed');

    return {
      id,
      fleetCode: asText(row['fleet_code']),
      registrationNo: asText(row['registration_no']),
      type: asText(row['type']),
      status,
      statusReason: asTextOrNull(row['status_reason']),
      make: asTextOrNull(row['make']),
      model: asTextOrNull(row['model']),
      equipment: row['equipment'] ?? [],
      currentOdometer: asNumber(row['current_odometer']),
      lastLat: asTextOrNull(row['last_lat']),
      lastLng: asTextOrNull(row['last_lng']),
      lastPositionAt: asTextOrNull(row['last_position_at']),
      currentTripId: asTextOrNull(row['current_trip_id']),
      isActive: asBool(row['is_active']),
      documents,
      dispatchable: blockers.length === 0,
      blockers,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Crew
  // ═══════════════════════════════════════════════════════════════════════════

  async addCrew(body: CrewRequest): Promise<{ readonly id: string }> {
    return this.guard(async (tx) => {
      const id = newId();
      await tx.query(
        `INSERT INTO ops.fleet_crew
           (id, hospital_id, branch_id, user_id, employee_ref, name, role, licence_ref, licence_expiry,
            badge_no, phone, als_qualified, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::ops."CrewRole", $8, $9::date, $10, $11, $12, now(), now())`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.userId ?? null,
          body.employeeRef ?? null,
          body.name,
          body.role,
          body.licenceRef ?? null,
          body.licenceExpiry ?? null,
          body.badgeNo ?? null,
          body.phone ?? null,
          body.alsQualified,
        ],
      );
      return { id };
    });
  }

  async openShift(body: ShiftRequest): Promise<{ readonly id: string }> {
    return this.guard(async (tx) => {
      const id = newId();
      await tx.query(
        `INSERT INTO ops.fleet_crew_shifts
           (id, hospital_id, crew_id, vehicle_id, shift_start, shift_end, roster_ref, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7, 'on_duty', now(), now())`,
        [
          id,
          this.hospitalId(),
          body.crewId,
          body.vehicleId ?? null,
          body.shiftStart,
          body.shiftEnd ?? null,
          body.rosterRef ?? null,
        ],
      );
      return { id };
    });
  }

  /**
   * The shift-start or post-trip check.
   *
   * A pass on a shift-start check is what moves a vehicle from `not_ready` to
   * `available` — the vehicle's readiness is a consequence of the check rather
   * than a field somebody sets, so it cannot drift from what was actually
   * inspected.
   */
  async recordChecklist(body: ChecklistRequest): Promise<FleetVehicleView> {
    return this.guard(async (tx) => {
      const failed = body.responses.filter((r) => !r.ok);
      const failedMandatory = failed.filter((r) => r.mandatory);
      const passed = failedMandatory.length === 0;

      await tx.query(
        `INSERT INTO ops.fleet_checklists
           (id, hospital_id, vehicle_id, trip_id, crew_shift_id, kind, responses, failed_items, passed, at, by_id)
         VALUES ($1, $2, $3, $4, $5, $6::ops."ChecklistKind", $7::jsonb, $8::jsonb, $9, now(), $10)`,
        [
          newId(),
          this.hospitalId(),
          body.vehicleId,
          body.tripId ?? null,
          body.crewShiftId ?? null,
          body.kind,
          JSON.stringify(body.responses),
          JSON.stringify(failed),
          passed,
          this.actorId(),
        ],
      );

      if (body.kind === 'shift_start') {
        await tx.query(
          `UPDATE ops.fleet_vehicles
              SET status = CASE
                    WHEN $2::boolean AND status IN ('not_ready', 'available') THEN 'available'::ops."VehicleStatus"
                    WHEN NOT $2::boolean AND status IN ('not_ready', 'available') THEN 'not_ready'::ops."VehicleStatus"
                    ELSE status END,
                  status_reason = CASE WHEN $2::boolean THEN NULL ELSE $3 END,
                  updated_at = now()
            WHERE id = $1`,
          [body.vehicleId, passed, failedMandatory.map((r) => r.item).join(', ') || null],
        );
        if (body.crewShiftId !== undefined) {
          await tx.query(
            `UPDATE ops.fleet_crew_shifts SET checklist_passed = $2, updated_at = now() WHERE id = $1`,
            [body.crewShiftId, passed],
          );
        }
      }

      return this.loadVehicle(tx, body.vehicleId);
    });
  }

  async overrideChecklist(id: string): Promise<FleetVehicleView> {
    return this.guard(async (tx) => {
      const reason = this.reason('Sending a vehicle out with a failed check');
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE ops.fleet_checklists
            SET override_by = $2, override_reason = $3, passed = true
          WHERE id = $1 AND hospital_id = $4
          RETURNING vehicle_id`,
        [id, this.actorId(), reason, this.hospitalId()],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.notFound('That checklist does not exist.');

      const vehicleId = asText(row['vehicle_id']);
      await tx.query(
        `UPDATE ops.fleet_vehicles
            SET status = CASE WHEN status = 'not_ready' THEN 'available'::ops."VehicleStatus" ELSE status END,
                status_reason = $2, updated_at = now()
          WHERE id = $1`,
        [vehicleId, `Dispatched with a failed check: ${reason}`],
      );

      await this.audit.write(tx, {
        action: 'update',
        entity: 'fleet_vehicle',
        rowId: vehicleId,
        businessKey: vehicleId,
        dataClass: 'operational',
        before: { checklistPassed: false },
        after: { overridden: true, reason },
      });

      return this.loadVehicle(tx, vehicleId);
    });
  }

  async recordFuel(body: FuelRequest): Promise<{ readonly kmPerLitre: string | null }> {
    return this.guard(async (tx) => {
      const { rows: last } = await tx.query<Record<string, unknown>>(
        `SELECT odometer FROM ops.fleet_fuel_logs
          WHERE vehicle_id = $1 AND hospital_id = $2 ORDER BY at DESC LIMIT 1`,
        [body.vehicleId, this.hospitalId()],
      );
      const previous = asNumberOrNull(last[0]?.['odometer']);

      if (previous !== null && body.odometer < previous) {
        throw new AppError(
          ProblemType.VALIDATION_FAILED,
          `The odometer reads ${String(body.odometer)}, below the ${String(previous)} recorded at the last fill. A reading that goes backwards is a typo or a swapped vehicle, and either way the consumption figure would be nonsense.`,
        );
      }

      const kmPerLitre =
        previous === null || body.litres <= 0
          ? null
          : Math.round(((body.odometer - previous) / body.litres) * 100) / 100;

      // An implausible figure is flagged, not refused: a long idle in traffic
      // and a siphoned tank look the same from here, and only one is fraud.
      const flags: string[] = [];
      if (kmPerLitre !== null && kmPerLitre > 0 && kmPerLitre < 3) flags.push('consumption_unusually_high');
      if (kmPerLitre !== null && kmPerLitre > 25) flags.push('consumption_implausibly_low');

      await tx.query(
        `INSERT INTO ops.fleet_fuel_logs
           (id, hospital_id, vehicle_id, at, driver_id, litres, amount, odometer, station, source,
            receipt_ref, km_per_litre, anomaly_flags, created_at)
         VALUES ($1, $2, $3, now(), $4, $5, $6, $7, $8, $9, $10, $11, $12, now())`,
        [
          newId(),
          this.hospitalId(),
          body.vehicleId,
          this.actorId(),
          body.litres,
          body.amount,
          body.odometer,
          body.station ?? null,
          body.source,
          body.receiptRef ?? null,
          kmPerLitre,
          flags,
        ],
      );

      await tx.query(
        `UPDATE ops.fleet_vehicles SET current_odometer = GREATEST(current_odometer, $2), updated_at = now()
          WHERE id = $1`,
        [body.vehicleId, body.odometer],
      );

      return { kmPerLitre: kmPerLitre === null ? null : kmPerLitre.toFixed(2) };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Requests and dispatch
  // ═══════════════════════════════════════════════════════════════════════════

  async createRequest(body: FleetRequestRequest): Promise<FleetRequestView> {
    return this.guard(async (tx) => {
      const id = newId();
      const alloc = await this.numbering.allocate(tx, {
        key: 'AMB_REQ',
        branchId: this.branchId(),
        refType: 'fleet_request',
        refId: id,
      });

      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO ops.fleet_requests (
           id, hospital_id, branch_id, request_no, source, priority, patient_id, er_visit_id,
           pickup, drop, requested_at, required_at, clinical_need, escorts,
           requester_user_id, requester_contact, external_case_id, status, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5::ops."TripRequestSource", $6::ops."TripPriority", $7, $8,
           $9::jsonb, $10::jsonb, now(), $11::timestamptz, $12::ops."ClinicalNeed", $13::jsonb,
           $14, $15, $16, 'new', now(), now()
         ) RETURNING *`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          alloc.formatted,
          body.source,
          body.priority,
          body.patientId ?? null,
          body.erVisitId ?? null,
          JSON.stringify(body.pickup),
          json(body.drop),
          body.requiredAt ?? null,
          body.clinicalNeed,
          json(body.escorts),
          this.actorId(),
          body.requesterContact ?? null,
          body.externalCaseId ?? null,
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The request was not created.');
      return this.toRequest(row);
    });
  }

  async dispatch(body: DispatchRequest): Promise<TripDetailView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();
      const branch = this.branchId();

      const { rows: reqRows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM ops.fleet_requests WHERE id = $1 AND hospital_id = $2 FOR UPDATE`,
        [body.requestId, hospital],
      );
      const request = reqRows[0];
      if (request === undefined) throw AppError.notFound('That request does not exist.');
      if (asText(request['status']) === 'assigned') {
        throw AppError.conflict('That request already has an ambulance on the way.');
      }

      // An ALS need on a BLS vehicle is a crew arriving without a monitor. The
      // check is here rather than in the database because it is a *matching*
      // rule, and a hospital with one ambulance legitimately sends it anyway.
      const { rows: vehRows } = await tx.query<Record<string, unknown>>(
        `SELECT type, current_odometer, fleet_code FROM ops.fleet_vehicles WHERE id = $1 AND hospital_id = $2`,
        [body.vehicleId, hospital],
      );
      const vehicle = vehRows[0];
      if (vehicle === undefined) throw AppError.notFound('That vehicle does not exist.');
      if (asText(request['clinical_need']) === 'als' && asText(vehicle['type']) !== 'als') {
        throw AppError.conflict(
          `This call needs advanced life support and ${asText(vehicle['fleet_code'])} is a ${asText(vehicle['type']).toUpperCase()} vehicle. Send an ALS ambulance, or change the clinical need on the request and say why.`,
        );
      }

      const id = newId();
      const alloc = await this.numbering.allocate(tx, {
        key: 'AMB_TRIP',
        branchId: branch,
        refType: 'fleet_trip',
        refId: id,
      });

      await tx.query(
        `INSERT INTO ops.fleet_trips (
           id, hospital_id, branch_id, trip_no, request_id, vehicle_id, crew, status,
           dispatched_at, start_odometer, patient_id, er_visit_id, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7::jsonb, 'assigned',
           now(), $8, $9, $10, now(), now()
         )`,
        [
          id,
          hospital,
          branch,
          alloc.formatted,
          body.requestId,
          body.vehicleId,
          JSON.stringify(body.crew),
          body.startOdometer ?? asNumber(vehicle['current_odometer']),
          asTextOrNull(request['patient_id']),
          asTextOrNull(request['er_visit_id']),
        ],
      );

      await tx.query(`UPDATE ops.fleet_requests SET status = 'assigned', updated_at = now() WHERE id = $1`, [
        body.requestId,
      ]);
      await tx.query(
        `UPDATE ops.fleet_vehicles SET status = 'on_trip', current_trip_id = $2, updated_at = now() WHERE id = $1`,
        [body.vehicleId, id],
      );

      await this.outbox.publish(
        tx,
        fleetEvent('fleet.trip.dispatched', id, {
          tripId: id,
          tripNo: alloc.formatted,
          vehicleId: body.vehicleId,
          fleetCode: asText(vehicle['fleet_code']),
          priority: asText(request['priority']),
          source: asText(request['source']),
        }),
      );

      return this.loadTrip(tx, id);
    });
  }

  async recordMilestone(tripId: string, body: MilestoneRequest): Promise<TripDetailView> {
    return this.guard(async (tx) => {
      const column: Readonly<Record<string, string>> = {
        en_route: 'en_route_at',
        at_scene: 'at_scene_at',
        patient_onboard: 'departed_scene_at',
        arrived_hospital: 'arrived_hospital_at',
        returning: 'available_at',
      };
      const statusFor: Readonly<Record<string, string>> = {
        en_route: 'en_route',
        at_scene: 'at_scene',
        patient_onboard: 'patient_onboard',
        arrived_hospital: 'arrived_hospital',
        returning: 'returning',
      };
      const col = column[body.milestone];
      const nextStatus = statusFor[body.milestone];
      if (col === undefined || nextStatus === undefined) {
        throw AppError.conflict('That is not a milestone this module records.');
      }

      // `COALESCE` so a repeated tap on a jolting tablet does not move the time.
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE ops.fleet_trips
            SET ${col} = COALESCE(${col}, now()),
                patient_contact_at = CASE WHEN $3 = 'at_scene' THEN COALESCE(patient_contact_at, now()) ELSE patient_contact_at END,
                status = $2::ops."TripStatus",
                updated_at = now()
          WHERE id = $1 AND hospital_id = $4
          RETURNING *`,
        [tripId, nextStatus, body.milestone, this.hospitalId()],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.notFound('That trip does not exist.');

      if (body.lat !== undefined && body.lng !== undefined) {
        await this.writePositions(tx, asText(row['vehicle_id']), tripId, [
          { at: new Date().toISOString(), lat: body.lat, lng: body.lng, source: 'phone' },
        ]);
      }

      await this.outbox.publish(
        tx,
        fleetEvent('fleet.trip.milestone', tripId, {
          tripId,
          tripNo: asText(row['trip_no']),
          status: nextStatus,
          at: new Date().toISOString(),
          minutesFromDispatch: minutesBetween(row['dispatched_at'], new Date().toISOString()),
        }),
      );

      return this.loadTrip(tx, tripId);
    });
  }

  async divert(tripId: string, body: DivertRequest): Promise<TripDetailView> {
    return this.guard(async (tx) => {
      const reason = this.reason('Diverting an ambulance');
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE ops.fleet_trips
            SET status = 'diverted'::ops."TripStatus",
                diversion_reason = $2, diversion_by = $3, destination_external = $4, updated_at = now()
          WHERE id = $1 AND hospital_id = $5
          RETURNING trip_no`,
        [tripId, reason, this.actorId(), body.destinationExternal, this.hospitalId()],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.notFound('That trip does not exist.');

      await this.audit.write(tx, {
        action: 'update',
        entity: 'fleet_trip',
        rowId: tripId,
        businessKey: asText(row['trip_no']),
        dataClass: 'operational',
        before: null,
        after: { diverted: true, to: body.destinationExternal, reason },
      });

      await this.outbox.publish(
        tx,
        fleetEvent('fleet.trip.diverted', tripId, {
          tripId,
          tripNo: asText(row['trip_no']),
          reason,
          divertedBy: this.actorId(),
          destination: body.destinationExternal,
        }),
      );

      return this.loadTrip(tx, tripId);
    });
  }

  /**
   * Close the trip.
   *
   * The distance reconciliation is the point: GPS says one thing, the odometer
   * says another, and a gap over ten percent stops the invoice rather than
   * quietly pricing whichever the tariff happens to read.
   */
  async closeTrip(tripId: string, body: CloseTripRequest): Promise<TripDetailView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();
      const { rows: tripRows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM ops.fleet_trips WHERE id = $1 AND hospital_id = $2 FOR UPDATE`,
        [tripId, hospital],
      );
      const trip = tripRows[0];
      if (trip === undefined) throw AppError.notFound('That trip does not exist.');

      const gpsKm = await this.gpsDistanceKm(tx, tripId);
      const start = asNumberOrNull(trip['start_odometer']);
      const odoKm = start === null ? null : body.endOdometer - start;

      const flagged =
        gpsKm !== null && odoKm !== null && odoKm > 0 && Math.abs(gpsKm - odoKm) / odoKm > DISTANCE_TOLERANCE;

      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE ops.fleet_trips
            SET status = 'completed'::ops."TripStatus",
                end_odometer = $2, gps_distance_km = $3, distance_flagged = $4,
                waiting_minutes = $5, remarks = COALESCE($6, remarks),
                available_at = COALESCE(available_at, now()),
                closed_by = $7, closed_at = now(), updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [tripId, body.endOdometer, gpsKm, flagged, body.waitingMinutes, body.remarks ?? null, this.actorId()],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The trip was not closed.');

      await tx.query(
        `UPDATE ops.fleet_vehicles
            SET status = 'available', current_trip_id = NULL,
                current_odometer = GREATEST(current_odometer, $2), updated_at = now()
          WHERE id = $1`,
        [asText(trip['vehicle_id']), body.endOdometer],
      );

      const offload = await this.offloadMinutes(tx, tripId);
      await this.outbox.publish(
        tx,
        fleetEvent('fleet.trip.completed', tripId, {
          tripId,
          tripNo: asText(row['trip_no']),
          billingStatus: asText(row['billing_status']),
          distanceFlagged: flagged,
          responseMinutes: minutesBetween(row['dispatched_at'], row['at_scene_at']),
          offloadMinutes: offload,
        }),
      );

      return this.loadTrip(tx, tripId);
    });
  }

  async recordPositions(vehicleId: string, body: PositionRequest): Promise<{ readonly written: number }> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT current_trip_id FROM ops.fleet_vehicles WHERE id = $1 AND hospital_id = $2`,
        [vehicleId, this.hospitalId()],
      );
      if (rows[0] === undefined) throw AppError.notFound('That vehicle does not exist.');
      const tripId = asTextOrNull(rows[0]['current_trip_id']);

      await this.writePositions(tx, vehicleId, tripId, body.positions);
      return { written: body.positions.length };
    });
  }

  private async writePositions(
    tx: TransactionClient,
    vehicleId: string,
    tripId: string | null,
    positions: readonly {
      readonly at: string;
      readonly lat: number;
      readonly lng: number;
      readonly speedKmh?: number | undefined;
      readonly heading?: number | undefined;
      readonly ignition?: boolean | undefined;
      readonly source?: string | undefined;
      readonly accuracyM?: number | undefined;
    }[],
  ): Promise<void> {
    const hospital = this.hospitalId();
    for (const p of positions) {
      await tx.query(
        `INSERT INTO ops.fleet_positions
           (id, hospital_id, vehicle_id, trip_id, at, lat, lng, speed_kmh, heading, ignition, source, accuracy_m)
         VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7, $8, $9, $10, $11, $12)`,
        [
          newId(),
          hospital,
          vehicleId,
          tripId,
          p.at,
          p.lat,
          p.lng,
          p.speedKmh ?? null,
          p.heading ?? null,
          p.ignition ?? null,
          p.source ?? 'device',
          p.accuracyM ?? null,
        ],
      );
    }

    const latest = positions[positions.length - 1];
    if (latest !== undefined) {
      await tx.query(
        `UPDATE ops.fleet_vehicles
            SET last_lat = $2, last_lng = $3, last_position_at = $4::timestamptz, updated_at = now()
          WHERE id = $1 AND (last_position_at IS NULL OR last_position_at < $4::timestamptz)`,
        [vehicleId, latest.lat, latest.lng, latest.at],
      );
    }
  }

  /**
   * Trip distance from the breadcrumbs, leg by leg.
   *
   * Summed in SQL with `ops.haversine_km` rather than pulled into Node: a
   * forty-minute trip at one fix every five seconds is roughly five hundred
   * rows, and there is no reason for any of them to cross the wire.
   */
  private async gpsDistanceKm(tx: TransactionClient, tripId: string): Promise<number | null> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT round(sum(ops.haversine_km(prev_lat, prev_lng, lat, lng))::numeric, 2) AS km
         FROM (
           SELECT lat, lng,
                  lag(lat) OVER (ORDER BY at) AS prev_lat,
                  lag(lng) OVER (ORDER BY at) AS prev_lng
             FROM ops.fleet_positions
            WHERE trip_id = $1 AND hospital_id = $2
         ) legs
        WHERE prev_lat IS NOT NULL`,
      [tripId, this.hospitalId()],
    );
    return asNumberOrNull(rows[0]?.['km']);
  }

  private async offloadMinutes(tx: TransactionClient, tripId: string): Promise<number | null> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT offload_minutes FROM clinical.ph_handovers WHERE trip_id = $1 AND hospital_id = $2`,
      [tripId, this.hospitalId()],
    );
    return asNumberOrNull(rows[0]?.['offload_minutes']);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The patient care record
  // ═══════════════════════════════════════════════════════════════════════════

  async openPcr(body: PcrRequest): Promise<TripDetailView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();
      const { rows: exists } = await tx.query<Record<string, unknown>>(
        `SELECT id FROM clinical.ph_pcr WHERE trip_id = $1 AND hospital_id = $2`,
        [body.tripId, hospital],
      );

      if (exists[0] === undefined) {
        await tx.query(
          `INSERT INTO clinical.ph_pcr (
             id, hospital_id, trip_id, patient_id, patient_temp, complaint, mechanism, scene,
             start_category, mci_tag_no, allergies, medications, history, destination_reason,
             offline_captured, device_id, device_sequence, synced_at, created_at, created_by, updated_at
           ) VALUES (
             $1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8::jsonb,
             $9, $10, $11, $12, $13, $14,
             $15, $16, $17, CASE WHEN $15::boolean THEN now() ELSE NULL END, now(), $18, now()
           )`,
          [
            newId(),
            hospital,
            body.tripId,
            body.patientId ?? null,
            json(body.patientTemp),
            body.complaint ?? null,
            json(body.mechanism),
            json(body.scene),
            body.startCategory ?? null,
            body.mciTagNo ?? null,
            body.allergies ?? null,
            body.medications ?? null,
            body.history ?? null,
            body.destinationReason ?? null,
            body.offlineCaptured,
            body.deviceId ?? null,
            body.deviceSequence ?? null,
            this.actorId(),
          ],
        );
      } else {
        // Merged rather than replaced: the record is filled in over a journey by
        // whoever has a hand free.
        await tx.query(
          `UPDATE clinical.ph_pcr SET
             patient_id         = COALESCE($2::uuid, patient_id),
             patient_temp       = COALESCE($3::jsonb, patient_temp),
             complaint          = COALESCE($4, complaint),
             mechanism          = COALESCE($5::jsonb, mechanism),
             scene              = COALESCE($6::jsonb, scene),
             start_category     = COALESCE($7, start_category),
             mci_tag_no         = COALESCE($8, mci_tag_no),
             allergies          = COALESCE($9, allergies),
             medications        = COALESCE($10, medications),
             history            = COALESCE($11, history),
             destination_reason = COALESCE($12, destination_reason),
             updated_at         = now()
           WHERE trip_id = $1`,
          [
            body.tripId,
            body.patientId ?? null,
            json(body.patientTemp),
            body.complaint ?? null,
            json(body.mechanism),
            json(body.scene),
            body.startCategory ?? null,
            body.mciTagNo ?? null,
            body.allergies ?? null,
            body.medications ?? null,
            body.history ?? null,
            body.destinationReason ?? null,
          ],
        );
      }

      return this.loadTrip(tx, body.tripId);
    });
  }

  async recordVitals(tripId: string, body: VitalsRequest): Promise<TripDetailView> {
    return this.guard(async (tx) => {
      const pcrId = await this.requirePcr(tx, tripId);
      await tx.query(
        `INSERT INTO clinical.ph_vitals (
           id, hospital_id, pcr_id, at, seq, heart_rate, systolic_bp, diastolic_bp, respiratory_rate,
           spo2, temperature_c, glucose, gcs_eye, gcs_verbal, gcs_motor, gcs_intubated, pupils,
           pain_score, source, device_id, created_at
         ) VALUES (
           $1, $2, $3, $4::timestamptz, $5, $6, $7, $8, $9,
           $10, $11, $12, $13, $14, $15, $16, $17::jsonb,
           $18, $19, $20, now()
         )`,
        [
          newId(),
          this.hospitalId(),
          pcrId,
          body.at,
          body.seq,
          body.heartRate ?? null,
          body.systolicBp ?? null,
          body.diastolicBp ?? null,
          body.respiratoryRate ?? null,
          body.spo2 ?? null,
          body.temperatureC ?? null,
          body.glucose ?? null,
          body.gcsEye ?? null,
          body.gcsIntubated ? null : (body.gcsVerbal ?? null),
          body.gcsMotor ?? null,
          body.gcsIntubated,
          json(body.pupils),
          body.painScore ?? null,
          body.source,
          body.deviceId ?? null,
        ],
      );
      return this.loadTrip(tx, tripId);
    });
  }

  async recordIntervention(tripId: string, body: PhInterventionRequest): Promise<TripDetailView> {
    return this.guard(async (tx) => {
      const pcrId = await this.requirePcr(tx, tripId);
      await tx.query(
        `INSERT INTO clinical.ph_interventions
           (id, hospital_id, pcr_id, at, type, details, performed_by, created_at)
         VALUES ($1, $2, $3, $4::timestamptz, $5::clinical."InterventionType", $6::jsonb, $7, now())`,
        [newId(), this.hospitalId(), pcrId, body.at, body.type, json(body.details), body.performedBy ?? null],
      );
      return this.loadTrip(tx, tripId);
    });
  }

  async recordDrug(tripId: string, body: PhDrugRequest): Promise<TripDetailView> {
    return this.guard(async (tx) => {
      const pcrId = await this.requirePcr(tx, tripId);
      await tx.query(
        `INSERT INTO clinical.ph_drugs
           (id, hospital_id, pcr_id, at, drug_id, drug_name, dose, unit, route, given_by,
            is_controlled, register_ref, created_at)
         VALUES ($1, $2, $3, $4::timestamptz, $5, $6, $7, $8, $9, $10, $11, $12, now())`,
        [
          newId(),
          this.hospitalId(),
          pcrId,
          body.at,
          body.drugId ?? null,
          body.drugName,
          body.dose,
          body.unit,
          body.route,
          body.givenBy ?? null,
          body.isControlled,
          body.registerRef ?? null,
        ],
      );
      return this.loadTrip(tx, tripId);
    });
  }

  async signPcr(tripId: string): Promise<TripDetailView> {
    return this.guard(async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE clinical.ph_pcr
            SET signed_by_emt_at = COALESCE(signed_by_emt_at, now()),
                signed_by_emt_id = COALESCE(signed_by_emt_id, $2),
                updated_at = now()
          WHERE trip_id = $1 AND hospital_id = $3`,
        [tripId, this.actorId(), this.hospitalId()],
      );
      if (rowCount === 0) throw AppError.notFound('No patient care record exists for that trip.');
      return this.loadTrip(tx, tripId);
    });
  }

  private async requirePcr(tx: TransactionClient, tripId: string): Promise<string> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT id FROM clinical.ph_pcr WHERE trip_id = $1 AND hospital_id = $2`,
      [tripId, this.hospitalId()],
    );
    const id = asTextOrNull(rows[0]?.['id']);
    if (id === null) {
      throw AppError.conflict('Open the patient care record before writing to it.');
    }
    return id;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Pre-alert and handover — exit gate 1
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Raise the pre-alert, and put the patient on the ER board.
   *
   * The OP-006 visit is created here rather than on arrival, which is the whole
   * point of a pre-alert: the board shows an inbound patient with an ETA, and a
   * bay can be held for somebody who is still in the ambulance.
   */
  async raisePrealert(tripId: string, body: PrealertRequest): Promise<TripDetailView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();
      const branch = this.branchId();
      const pcrId = await this.requirePcr(tx, tripId);

      const suggestion = await this.fieldSuggestion(tx, pcrId);

      // The inbound visit. `status = 'inbound'` is what OP-006's board sorts to
      // the top: a patient still in the ambulance is the one a bay is held for.
      const visitId = newId();
      const erAlloc = await this.numbering.allocate(tx, {
        key: 'ER_NO',
        branchId: branch,
        refType: 'er_visit',
        refId: visitId,
      });
      const tagAlloc = await this.numbering.allocate(tx, {
        key: 'ER_TAG',
        branchId: branch,
        refType: 'er_tag',
        refId: visitId,
      });

      const { rows: pcrRows } = await tx.query<Record<string, unknown>>(
        `SELECT patient_temp, complaint, scene FROM clinical.ph_pcr WHERE id = $1`,
        [pcrId],
      );
      const pcr = pcrRows[0] ?? {};
      const temp = (pcr['patient_temp'] ?? {}) as Record<string, unknown>;
      const scene = (pcr['scene'] ?? {}) as Record<string, unknown>;

      await tx.query(
        `INSERT INTO clinical.er_visits (
           id, hospital_id, branch_id, er_no, temp_identity, display_name, approximate_age, gender,
           arrival_mode, chief_complaint, mlc_suspected, status, expected_at, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8,
           'ambulance', $9, $10, 'inbound', $11::timestamptz, now(), now()
         )`,
        [
          visitId,
          hospital,
          branch,
          erAlloc.formatted,
          tagAlloc.formatted,
          asTextOrNull(temp['name']) ?? 'Inbound by ambulance',
          null,
          asTextOrNull(temp['sex']),
          asTextOrNull(pcr['complaint']),
          scene['mlcSuspected'] === true,
          body.etaAt ?? null,
        ],
      );

      const id = newId();
      await tx.query(
        `INSERT INTO clinical.ph_prealerts (
           id, hospital_id, pcr_id, trip_id, raised_at, raised_by, atmist, pathway,
           suggested_activation, eta_at, er_visit_id, status, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, now(), $5, $6::jsonb, $7::clinical."PrehospitalPathway",
           $8, $9::timestamptz, $10, 'raised', now(), now()
         )`,
        [
          id,
          hospital,
          pcrId,
          tripId,
          this.actorId(),
          JSON.stringify(body.atmist),
          body.pathway,
          suggestion?.tier ?? 'none',
          body.etaAt ?? null,
          visitId,
        ],
      );

      await tx.query(`UPDATE ops.fleet_trips SET er_visit_id = $2, updated_at = now() WHERE id = $1`, [
        tripId,
        visitId,
      ]);

      await this.outbox.publish(
        tx,
        fleetEvent('prehospital.prealert.raised', id, {
          prealertId: id,
          tripId,
          pathway: body.pathway,
          suggestedActivation: suggestion?.tier ?? 'none',
          etaAt: body.etaAt ?? null,
          atmist: body.atmist,
        }),
      );

      return this.loadTrip(tx, tripId);
    });
  }

  async acknowledgePrealert(id: string, body: AcknowledgePrealertRequest): Promise<PrealertView> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.ph_prealerts
            SET status = 'acknowledged'::clinical."PrealertStatus",
                acknowledged_by = $2, acknowledged_at = now(), bay_id = COALESCE($3::uuid, bay_id),
                updated_at = now()
          WHERE id = $1 AND hospital_id = $4 AND status = 'raised'
          RETURNING *`,
        [id, this.actorId(), body.bayId ?? null, this.hospitalId()],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict('That pre-alert has already been answered, or does not exist.');
      }

      // Holding the bay is what makes a pre-alert worth raising. §6.11.
      if (body.bayId !== undefined) {
        await tx.query(
          `UPDATE clinical.er_bays
              SET status = 'occupied', current_visit_id = $2, updated_at = now()
            WHERE id = $1 AND hospital_id = $3 AND status = 'free'`,
          [body.bayId, asTextOrNull(row['er_visit_id']), this.hospitalId()],
        );
      }

      await this.outbox.publish(
        tx,
        fleetEvent('prehospital.prealert.acknowledged', id, {
          prealertId: id,
          tripId: asText(row['trip_id']),
          acknowledgedBy: this.actorId(),
          secondsToAcknowledge: Math.max(
            0,
            Math.round(
              (new Date(asText(row['acknowledged_at'])).getTime() -
                new Date(asText(row['raised_at'])).getTime()) /
                1000,
            ),
          ),
          bayId: body.bayId ?? null,
        }),
      );

      return this.toPrealert(row);
    });
  }

  /**
   * Stand a pre-alert down.
   *
   * The patient refused transport, or died at the scene, or the crew was
   * cancelled. Without this the only ways out of `raised` are arrival and
   * diversion, and an inbound patient who is never coming sits on the ER board
   * holding a bay — which is worse than not having warned them at all.
   */
  async standDownPrealert(id: string): Promise<PrealertView> {
    return this.guard(async (tx) => {
      const reason = this.reason('Standing a pre-alert down');
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.ph_prealerts
            SET status = 'stood_down'::clinical."PrealertStatus",
                updates = updates || jsonb_build_array(jsonb_build_object(
                  'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SSZ'),
                  'note', $2::text
                )),
                updated_at = now()
          WHERE id = $1 AND hospital_id = $3 AND status IN ('raised', 'acknowledged')
          RETURNING *`,
        [id, `Stood down: ${reason}`, this.hospitalId()],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('That pre-alert is not open.');

      // The held bay goes back. A bay reserved for somebody who is not coming
      // is the same problem as a bay nobody cleaned.
      const bayId = asTextOrNull(row['bay_id']);
      if (bayId !== null) {
        await tx.query(
          `UPDATE clinical.er_bays SET status = 'free', current_visit_id = NULL, updated_at = now()
            WHERE id = $1 AND hospital_id = $2`,
          [bayId, this.hospitalId()],
        );
      }

      return this.toPrealert(row);
    });
  }

  async divertPrealert(id: string, body: DivertPrealertRequest): Promise<PrealertView> {
    return this.guard(async (tx) => {
      const reason = this.reason('Turning an inbound ambulance away');
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.ph_prealerts
            SET status = 'diverted'::clinical."PrealertStatus",
                diverted_to = $2, divert_reason = $3, updated_at = now()
          WHERE id = $1 AND hospital_id = $4 AND status IN ('raised', 'acknowledged')
          RETURNING *`,
        [id, body.divertedTo, reason, this.hospitalId()],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('That pre-alert cannot be diverted now.');
      return this.toPrealert(row);
    });
  }

  /**
   * Complete the handover. **Exit gate 1.**
   *
   * The last road observation set becomes the first triage record, written here
   * rather than presented for a nurse to retype. The GCS is recomputed by the
   * shared function so the triage row holds a total this system agrees with,
   * and the handover records which triage row it made — so "did the vitals
   * carry?" is answerable from the data rather than from the demo.
   */
  async completeHandover(tripId: string, body: HandoverRequest): Promise<TripDetailView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();
      const branch = this.branchId();
      const pcrId = await this.requirePcr(tx, tripId);

      const { rows: tripRows } = await tx.query<Record<string, unknown>>(
        `SELECT arrived_hospital_at, er_visit_id FROM ops.fleet_trips WHERE id = $1 AND hospital_id = $2`,
        [tripId, hospital],
      );
      const trip = tripRows[0];
      if (trip === undefined) throw AppError.notFound('That trip does not exist.');

      const erVisitId = body.erVisitId ?? asTextOrNull(trip['er_visit_id']);
      if (erVisitId === null && body.mciTagNo === undefined) {
        throw AppError.conflict(
          'A handover names who the patient now is — an ER visit or an MCI tag. Handing somebody to nobody is how they end up in a corridor belonging to no team.',
        );
      }

      const arrivedAt = asTextOrNull(trip['arrived_hospital_at']) ?? new Date().toISOString();
      const offload = minutesBetween(arrivedAt, new Date().toISOString());

      // ── The carry ─────────────────────────────────────────────────────────
      let triageId: string | null = null;
      if (body.carryVitalsIntoTriage && erVisitId !== null) {
        triageId = await this.carryVitalsIntoTriage(tx, pcrId, erVisitId, branch, body.ageYears);
      }

      const id = newId();
      await tx.query(
        `INSERT INTO clinical.ph_handovers (
           id, hospital_id, pcr_id, trip_id, er_visit_id, mci_tag_no, started_at, completed_at,
           checklist, emt_sign_id, receiver_sign_id, offload_minutes, discrepancies,
           equipment_exchanged, controlled_drug_reconciled, vitals_carried_triage_id, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7::timestamptz, now(),
           $8::jsonb, $9, $10, $11, $12,
           $13::jsonb, $14, $15, now(), now()
         )
         ON CONFLICT (pcr_id) DO UPDATE SET
           completed_at             = now(),
           receiver_sign_id         = EXCLUDED.receiver_sign_id,
           controlled_drug_reconciled = EXCLUDED.controlled_drug_reconciled,
           offload_minutes          = EXCLUDED.offload_minutes,
           vitals_carried_triage_id = COALESCE(EXCLUDED.vitals_carried_triage_id, clinical.ph_handovers.vitals_carried_triage_id),
           updated_at               = now()`,
        [
          id,
          hospital,
          pcrId,
          tripId,
          erVisitId,
          body.mciTagNo ?? null,
          arrivedAt,
          json(body.checklist),
          this.actorId(),
          body.receiverUserId,
          offload,
          body.discrepancies ?? null,
          json(body.equipmentExchanged),
          body.controlledDrugReconciled,
          triageId,
        ],
      );

      await tx.query(
        `UPDATE ops.fleet_trips
            SET status = 'handover_complete'::ops."TripStatus",
                handover_complete_at = COALESCE(handover_complete_at, now()), updated_at = now()
          WHERE id = $1`,
        [tripId],
      );

      // The pre-alert is frozen from here. Everything after this is an update.
      await tx.query(
        `UPDATE clinical.ph_prealerts
            SET status = 'arrived'::clinical."PrealertStatus", updated_at = now()
          WHERE trip_id = $1 AND status IN ('raised', 'acknowledged')`,
        [tripId],
      );

      await this.outbox.publish(
        tx,
        fleetEvent('prehospital.handover.completed', id, {
          handoverId: id,
          tripId,
          erVisitId,
          mciTagNo: body.mciTagNo ?? null,
          offloadMinutes: offload,
          vitalsCarriedTriageId: triageId,
        }),
      );

      return this.loadTrip(tx, tripId);
    });
  }

  /**
   * Copy the last road observation set into the first triage record.
   *
   * Only when the visit has no triage yet — a re-triage in the department is a
   * clinical act by a nurse who has seen the patient, and the ambulance's
   * numbers must not overwrite it.
   *
   * The row carries `source = 'prehospital_handover'` and **no category**: the
   * crew never recorded ESI's decision points, so a level here would be one
   * this system invented. The nurse's own triage arrives as sequence 2 and both
   * survive. `er_visits.esi_level` and `triaged_at` are deliberately not set —
   * the patient is not triaged until somebody triages them.
   */
  private async carryVitalsIntoTriage(
    tx: TransactionClient,
    pcrId: string,
    erVisitId: string,
    branchId: string,
    ageYears: number | undefined,
  ): Promise<string | null> {
    const hospital = this.hospitalId();

    const { rows: existing } = await tx.query<Record<string, unknown>>(
      `SELECT count(*) AS n FROM clinical.triage_records WHERE er_visit_id = $1`,
      [erVisitId],
    );
    if (asNumber(existing[0]?.['n'] ?? 0) > 0) return null;

    const { rows: vitalRows } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM clinical.ph_vitals WHERE pcr_id = $1 ORDER BY at DESC, seq DESC LIMIT 1`,
      [pcrId],
    );
    const v = vitalRows[0];
    if (v === undefined) return null;

    // Recomputed rather than copied: the triage row must hold a total this
    // system agrees with, from the same function TR-001 uses.
    let gcsTotal: number | null = null;
    const eye = asNumberOrNull(v['gcs_eye']);
    const motor = asNumberOrNull(v['gcs_motor']);
    const intubated = asBool(v['gcs_intubated']);
    if (eye !== null && motor !== null) {
      try {
        gcsTotal = scoreGcs({
          eye,
          motor,
          verbal: intubated ? undefined : (asNumberOrNull(v['gcs_verbal']) ?? undefined),
          intubated,
          ...(ageYears === undefined ? {} : { ageYears }),
        }).total;
      } catch {
        // An incomplete road GCS carries the components without a total rather
        // than blocking the handover. The nurse completes it at triage.
        gcsTotal = null;
      }
    }

    const id = newId();
    await tx.query(
      `INSERT INTO clinical.triage_records (
         id, hospital_id, branch_id, er_visit_id, system, source, sequence_no,
         heart_rate, respiratory_rate, systolic_bp, diastolic_bp, spo2, temperature_c,
         pain_score, glucose, gcs_eye, gcs_verbal, gcs_motor, gcs_total, gcs_intubated,
         chief_complaint, pathways, triaged_at, triaged_by, device_id, recorded_offline, created_at
       ) VALUES (
         $1, $2, $3, $4, 'esi', 'prehospital_handover', 1,
         $5, $6, $7, $8, $9, $10,
         $11, $12, $13, $14, $15, $16, $17,
         $18, ARRAY['prehospital_handover'], now(), $19, $20, false, now()
       )`,
      [
        id,
        hospital,
        branchId,
        erVisitId,
        asNumberOrNull(v['heart_rate']),
        asNumberOrNull(v['respiratory_rate']),
        asNumberOrNull(v['systolic_bp']),
        asNumberOrNull(v['diastolic_bp']),
        asNumberOrNull(v['spo2']),
        asTextOrNull(v['temperature_c']),
        asNumberOrNull(v['pain_score']),
        asNumberOrNull(v['glucose']),
        eye,
        intubated ? null : asNumberOrNull(v['gcs_verbal']),
        motor,
        gcsTotal,
        intubated,
        'Carried from the pre-hospital record at handover',
        this.actorId(),
        asTextOrNull(v['device_id']),
      ],
    );

    // The visit is triaged in the sense that observations exist; the *level* is
    // still the nurse's. OP-006's CHECK is satisfied by neither being set.
    await tx.query(
      `UPDATE clinical.er_visits
          SET status = CASE WHEN status = 'inbound' THEN 'arrived'::clinical."ErVisitStatus" ELSE status END,
              arrived_at = COALESCE(arrived_at, now()),
              updated_at = now()
        WHERE id = $1`,
      [erVisitId],
    );

    return id;
  }

  private async fieldSuggestion(
    tx: TransactionClient,
    pcrId: string,
  ): Promise<{ readonly tier: string; readonly criteria: readonly string[] } | null> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM clinical.ph_vitals WHERE pcr_id = $1 ORDER BY at DESC, seq DESC LIMIT 1`,
      [pcrId],
    );
    const v = rows[0];
    if (v === undefined) return null;

    const eye = asNumberOrNull(v['gcs_eye']);
    const verbal = asNumberOrNull(v['gcs_verbal']);
    const motor = asNumberOrNull(v['gcs_motor']);
    const total = eye === null || motor === null ? null : eye + motor + (verbal ?? 0);

    return fieldActivationCriteria({
      systolicBp: asNumberOrNull(v['systolic_bp']),
      respiratoryRate: asNumberOrNull(v['respiratory_rate']),
      gcsTotal: total,
      intubated: asBool(v['gcs_intubated']),
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The board
  // ═══════════════════════════════════════════════════════════════════════════

  async board(query: BoardQuery): Promise<DispatchBoardView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();
      const branch = this.branchId();

      const { rows: queueRows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM ops.fleet_requests
          WHERE hospital_id = $1 AND branch_id = $2 AND status IN ('new', 'queued')
          ORDER BY CASE priority WHEN 'emergency' THEN 1 WHEN 'urgent' THEN 2 ELSE 3 END,
                   requested_at
          LIMIT $3`,
        [hospital, branch, query.limit],
      );

      const { rows: tripRows } = await tx.query<Record<string, unknown>>(
        `SELECT t.*, v.fleet_code, v.registration_no
           FROM ops.fleet_trips t JOIN ops.fleet_vehicles v ON v.id = t.vehicle_id
          WHERE t.hospital_id = $1 AND t.branch_id = $2
            AND ($3::boolean OR t.status NOT IN ('completed', 'cancelled', 'aborted'))
          ORDER BY t.created_at DESC
          LIMIT $4`,
        [hospital, branch, query.includeClosed, query.limit],
      );

      const { rows: vehicleRows } = await tx.query<Record<string, unknown>>(
        `SELECT id FROM ops.fleet_vehicles
          WHERE hospital_id = $1 AND branch_id = $2 AND status <> 'retired'
          ORDER BY fleet_code`,
        [hospital, branch],
      );
      const vehicles: FleetVehicleView[] = [];
      for (const row of vehicleRows) vehicles.push(await this.loadVehicle(tx, asText(row['id'])));

      const { rows: inboundRows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM clinical.ph_prealerts
          WHERE hospital_id = $1 AND status IN ('raised', 'acknowledged')
          ORDER BY COALESCE(eta_at, raised_at)
          LIMIT $2`,
        [hospital, query.limit],
      );

      return {
        queue: queueRows.map((r) => this.toRequest(r)),
        trips: tripRows.map((r) => this.toTrip(r)),
        vehicles,
        inbound: inboundRows.map((r) => this.toPrealert(r)),
        generatedAt: new Date().toISOString(),
      };
    });
  }

  /**
   * What is inbound, for the receiving team.
   *
   * Separate from the dispatch board because the two audiences hold different
   * keys and need different things: the dispatcher wants vehicles and a queue,
   * the ER wants ATMIST and an ETA. Gating the ER's view on `fleet.trip.read`
   * would mean giving a triage nurse the fleet console to see who is coming.
   */
  async inbound(): Promise<Page<PrealertView>> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM clinical.ph_prealerts
          WHERE hospital_id = $1 AND status IN ('raised', 'acknowledged')
          ORDER BY COALESCE(eta_at, raised_at)
          LIMIT 100`,
        [this.hospitalId()],
      );
      return { items: rows.map((r) => this.toPrealert(r)), nextCursor: null, hasMore: false };
    });
  }

  async getTrip(id: string): Promise<TripDetailView> {
    return this.guard((tx) => this.loadTrip(tx, id));
  }

  private async loadTrip(tx: TransactionClient, id: string): Promise<TripDetailView> {
    const hospital = this.hospitalId();
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT t.*, v.fleet_code, v.registration_no
         FROM ops.fleet_trips t JOIN ops.fleet_vehicles v ON v.id = t.vehicle_id
        WHERE t.id = $1 AND t.hospital_id = $2`,
      [id, hospital],
    );
    const row = rows[0];
    if (row === undefined) throw AppError.notFound('That trip does not exist.');

    let request: FleetRequestView | null = null;
    const requestId = asTextOrNull(row['request_id']);
    if (requestId !== null) {
      const { rows: reqRows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM ops.fleet_requests WHERE id = $1`,
        [requestId],
      );
      if (reqRows[0] !== undefined) request = this.toRequest(reqRows[0]);
    }

    return { trip: this.toTrip(row), request, pcr: await this.loadPcr(tx, id) };
  }

  private async loadPcr(tx: TransactionClient, tripId: string): Promise<PrehospitalRecordView | null> {
    const hospital = this.hospitalId();
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM clinical.ph_pcr WHERE trip_id = $1 AND hospital_id = $2`,
      [tripId, hospital],
    );
    const row = rows[0];
    if (row === undefined) return null;
    const pcrId = asText(row['id']);

    const [
      { rows: vitalRows },
      { rows: intRows },
      { rows: drugRows },
      { rows: alertRows },
      { rows: handRows },
    ] = await Promise.all([
      tx.query<Record<string, unknown>>(
        `SELECT * FROM clinical.ph_vitals WHERE pcr_id = $1 ORDER BY at, seq`,
        [pcrId],
      ),
      tx.query<Record<string, unknown>>(
        `SELECT * FROM clinical.ph_interventions WHERE pcr_id = $1 ORDER BY at`,
        [pcrId],
      ),
      tx.query<Record<string, unknown>>(`SELECT * FROM clinical.ph_drugs WHERE pcr_id = $1 ORDER BY at`, [
        pcrId,
      ]),
      tx.query<Record<string, unknown>>(
        `SELECT * FROM clinical.ph_prealerts WHERE pcr_id = $1 ORDER BY raised_at`,
        [pcrId],
      ),
      tx.query<Record<string, unknown>>(`SELECT * FROM clinical.ph_handovers WHERE pcr_id = $1`, [pcrId]),
    ]);

    const { rows: contactRows } = await tx.query<Record<string, unknown>>(
      `SELECT patient_contact_at FROM ops.fleet_trips WHERE id = $1`,
      [tripId],
    );
    const contactAt = asTextOrNull(contactRows[0]?.['patient_contact_at']);

    const vitals: PrehospitalVitalView[] = vitalRows.map((v) => {
      const eye = asNumberOrNull(v['gcs_eye']);
      const motor = asNumberOrNull(v['gcs_motor']);
      const verbal = asNumberOrNull(v['gcs_verbal']);
      const intubated = asBool(v['gcs_intubated']);
      const total = eye === null || motor === null ? null : eye + motor + (verbal ?? 0);
      return {
        id: asText(v['id']),
        at: asText(v['at']),
        seq: asNumber(v['seq']),
        heartRate: asNumberOrNull(v['heart_rate']),
        systolicBp: asNumberOrNull(v['systolic_bp']),
        diastolicBp: asNumberOrNull(v['diastolic_bp']),
        respiratoryRate: asNumberOrNull(v['respiratory_rate']),
        spo2: asNumberOrNull(v['spo2']),
        temperatureC: asTextOrNull(v['temperature_c']),
        glucose: asNumberOrNull(v['glucose']),
        gcsEye: eye,
        gcsVerbal: verbal,
        gcsMotor: motor,
        gcsIntubated: intubated,
        gcsDisplay: total === null ? null : intubated ? `${String(total)}T` : String(total),
        painScore: asNumberOrNull(v['pain_score']),
        source: asText(v['source']),
      };
    });

    const interventions: PrehospitalInterventionView[] = intRows.map((i) => ({
      id: asText(i['id']),
      at: asText(i['at']),
      type: asText(i['type']),
      details: i['details'] ?? null,
      performedBy: asTextOrNull(i['performed_by']),
      minutesFromContact: minutesBetween(contactAt, i['at']),
    }));

    const drugs: PrehospitalDrugView[] = drugRows.map((d) => ({
      id: asText(d['id']),
      at: asText(d['at']),
      drugName: asText(d['drug_name']),
      dose: asText(d['dose']),
      unit: asText(d['unit']),
      route: asText(d['route']),
      givenBy: asTextOrNull(d['given_by']),
      isControlled: asBool(d['is_controlled']),
      registerRef: asTextOrNull(d['register_ref']),
    }));

    const handoverRow = handRows[0];
    const handover: HandoverView | null =
      handoverRow === undefined
        ? null
        : {
            id: asText(handoverRow['id']),
            tripId,
            erVisitId: asTextOrNull(handoverRow['er_visit_id']),
            mciTagNo: asTextOrNull(handoverRow['mci_tag_no']),
            startedAt: asText(handoverRow['started_at']),
            completedAt: asTextOrNull(handoverRow['completed_at']),
            offloadMinutes: asNumberOrNull(handoverRow['offload_minutes']),
            controlledDrugReconciled: asBool(handoverRow['controlled_drug_reconciled']),
            discrepancies: asTextOrNull(handoverRow['discrepancies']),
            vitalsCarriedTriageId: asTextOrNull(handoverRow['vitals_carried_triage_id']),
          };

    const latest = vitals[vitals.length - 1];
    const suggestion =
      latest === undefined
        ? null
        : fieldActivationCriteria({
            systolicBp: latest.systolicBp,
            respiratoryRate: latest.respiratoryRate,
            gcsTotal:
              latest.gcsEye === null || latest.gcsMotor === null
                ? null
                : latest.gcsEye + latest.gcsMotor + (latest.gcsVerbal ?? 0),
            intubated: latest.gcsIntubated,
          });

    return {
      id: pcrId,
      tripId,
      patientId: asTextOrNull(row['patient_id']),
      patientTemp: row['patient_temp'] ?? null,
      complaint: asTextOrNull(row['complaint']),
      mechanism: row['mechanism'] ?? null,
      scene: row['scene'] ?? null,
      startCategory: asTextOrNull(row['start_category']),
      mciTagNo: asTextOrNull(row['mci_tag_no']),
      allergies: asTextOrNull(row['allergies']),
      medications: asTextOrNull(row['medications']),
      history: asTextOrNull(row['history']),
      offlineCaptured: asBool(row['offline_captured']),
      signedByEmtAt: asTextOrNull(row['signed_by_emt_at']),
      createdAt: asText(row['created_at']),
      vitals,
      interventions,
      drugs,
      prealerts: alertRows.map((a) => this.toPrealert(a)),
      handover,
      suggestedActivation: suggestion,
    };
  }

  private toRequest(row: Record<string, unknown>): FleetRequestView {
    const source = asText(row['source']);
    return {
      id: asText(row['id']),
      requestNo: asText(row['request_no']),
      source,
      priority: asText(row['priority']),
      clinicalNeed: asText(row['clinical_need']),
      pickup: row['pickup'] ?? null,
      drop: row['drop'] ?? null,
      requestedAt: asText(row['requested_at']),
      requiredAt: asTextOrNull(row['required_at']),
      status: asText(row['status']),
      patientId: asTextOrNull(row['patient_id']),
      erVisitId: asTextOrNull(row['er_visit_id']),
      externalCaseId: asTextOrNull(row['external_case_id']),
      freeAtPointOfUse: (STATE_EMS_SOURCES as readonly string[]).includes(source),
      waitingMinutes: minutesBetween(row['requested_at'], new Date().toISOString()) ?? 0,
    };
  }

  private toTrip(row: Record<string, unknown>): FleetTripView {
    const arrived = asTextOrNull(row['arrived_hospital_at']);
    const handoverAt = asTextOrNull(row['handover_complete_at']);
    return {
      id: asText(row['id']),
      tripNo: asText(row['trip_no']),
      requestId: asTextOrNull(row['request_id']),
      vehicleId: asText(row['vehicle_id']),
      fleetCode: asTextOrNull(row['fleet_code']),
      registrationNo: asTextOrNull(row['registration_no']),
      crew: row['crew'] ?? [],
      status: asText(row['status']),
      dispatchedAt: asTextOrNull(row['dispatched_at']),
      enRouteAt: asTextOrNull(row['en_route_at']),
      atSceneAt: asTextOrNull(row['at_scene_at']),
      patientContactAt: asTextOrNull(row['patient_contact_at']),
      departedSceneAt: asTextOrNull(row['departed_scene_at']),
      arrivedHospitalAt: arrived,
      handoverCompleteAt: handoverAt,
      startOdometer: asNumberOrNull(row['start_odometer']),
      endOdometer: asNumberOrNull(row['end_odometer']),
      gpsDistanceKm: asTextOrNull(row['gps_distance_km']),
      distanceFlagged: asBool(row['distance_flagged']),
      waitingMinutes: asNumber(row['waiting_minutes'] ?? 0),
      patientId: asTextOrNull(row['patient_id']),
      erVisitId: asTextOrNull(row['er_visit_id']),
      destinationExternal: asTextOrNull(row['destination_external']),
      diversionReason: asTextOrNull(row['diversion_reason']),
      billingStatus: asText(row['billing_status']),
      remarks: asTextOrNull(row['remarks']),
      cancelReason: asTextOrNull(row['cancel_reason']),
      responseMinutes: minutesBetween(row['dispatched_at'], row['at_scene_at']),
      offloadMinutes: minutesBetween(arrived, handoverAt),
      elapsedMinutes: minutesBetween(row['dispatched_at'], new Date().toISOString()) ?? 0,
    };
  }

  private toPrealert(row: Record<string, unknown>): PrealertView {
    const raisedAt = asText(row['raised_at']);
    const ackAt = asTextOrNull(row['acknowledged_at']);
    const etaAt = asTextOrNull(row['eta_at']);
    return {
      id: asText(row['id']),
      tripId: asText(row['trip_id']),
      pathway: asText(row['pathway']),
      atmist: row['atmist'] ?? null,
      suggestedActivation: asText(row['suggested_activation']),
      status: asText(row['status']),
      raisedAt,
      etaAt,
      bayId: asTextOrNull(row['bay_id']),
      erVisitId: asTextOrNull(row['er_visit_id']),
      acknowledgedBy: asTextOrNull(row['acknowledged_by']),
      acknowledgedAt: ackAt,
      divertedTo: asTextOrNull(row['diverted_to']),
      divertReason: asTextOrNull(row['divert_reason']),
      updates: row['updates'] ?? [],
      secondsToAcknowledge:
        ackAt === null
          ? null
          : Math.max(0, Math.round((new Date(ackAt).getTime() - new Date(raisedAt).getTime()) / 1000)),
      etaMinutes: etaAt === null ? null : minutesBetween(new Date().toISOString(), etaAt),
    };
  }
}

/** Re-exported so a caller can render the same targets the service measures. */
export const FLEET_TARGETS = {
  prealertAckSeconds: PREALERT_ACK_TARGET_SECONDS,
  offloadMinutes: OFFLOAD_TARGET_MINUTES,
  esiTargetMinutes: ESI_TARGET_MINUTES,
} as const;
