import { Inject, Injectable } from '@nestjs/common';
import { newId, type Page } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService, type TransactionClient } from '../../../core/db/database.service.js';
import { NumberingService } from '../../../core/numbering/numbering.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import { erEvent } from './er.events.js';
import { withErErrors } from './er.errors.js';
import type {
  AssignBayRequest,
  BoardQuery,
  CleanBayRequest,
  CreateBayRequest,
  CreateZoneRequest,
  DisposeRequest,
  MergeIdentityRequest,
  PreAlertRequest,
  QuickRegRequest,
  UpdateVisitRequest,
} from './er.schemas.js';
import type { ErBayView, ErBoardView, ErVisitDetailView, ErVisitView, ErZoneView } from './er.types.js';

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

// The ESI target times used to live here. They are now
// `ESI_TARGET_MINUTES` in `@vims/contracts/scores`, next to the function that
// produces the level they belong to — the tablet needs them to render a
// countdown before the round trip, and two copies of a NABH indicator is one
// copy too many. The board reads `target_seen_by`, which TR-001 stamps from
// that table when it writes the triage record.

/**
 * OP-006 — ER intake, the board and dispositions.
 *
 * ── Nothing here waits for identity, and nothing here waits for money ───────
 *
 * `quickReg` takes an arrival mode and nothing else. A patient who cannot speak
 * gets a tag, a wristband and a bay, and `mergeIdentity` reconciles the UHID
 * hours later without touching the ER number or recreating a single row —
 * exit gate 2 is precisely that every triage, MLC and imaging record still
 * points at the same visit afterwards.
 *
 * There is no payment check in this file because there is nothing in the OP-006
 * schema to check against. *Parmanand Katara v. Union of India* (1989) makes
 * emergency treatment a duty that cannot be conditioned on formalities; the
 * strongest way to honour that is to leave nowhere for a gate to be added later.
 *
 * ── The board is one query ──────────────────────────────────────────────────
 *
 * Visits, zones and bays come back together, because the board refreshes every
 * few seconds on a wall-mounted screen and three round trips is three chances
 * to render a half-updated department. `esi_level` is denormalised onto the
 * visit for the same reason.
 */
@Injectable()
export class ErService {
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
    return withErErrors(() => this.db.withTenant(currentTenantContext(), fn));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The board
  // ═══════════════════════════════════════════════════════════════════════════

  async board(query: BoardQuery): Promise<ErBoardView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();
      const branch = this.branchId();

      const { rows: visits } = await tx.query<Record<string, unknown>>(
        `SELECT v.*, b.code AS bay_code
           FROM clinical.er_visits v
           LEFT JOIN clinical.er_bays b ON b.id = v.bay_id
          WHERE v.hospital_id = $1 AND v.branch_id = $2
            AND ($3::text IS NULL OR v.status::text = $3)
            AND ($4::uuid IS NULL OR v.zone_id = $4)
            AND ($5::boolean OR v.status <> 'departed')
          ORDER BY
            -- Inbound first: a patient still in the ambulance is the one a bay
            -- has to be held for.
            (v.status = 'inbound') DESC,
            -- Then strictly by acuity, then by who has waited longest. Anything
            -- else is a queue that rewards being noticed.
            --
            -- Under a declared MCI the acuity is a START tag rather than an ESI
            -- level, and it maps onto the same scale so one sort serves both.
            -- Black sorts last, below the un-triaged: expectant means the
            -- patient is not treated while red and yellow are waiting, and that
            -- belongs in the ORDER BY rather than in somebody's head at 2 a.m.
            COALESCE(
              v.esi_level,
              CASE v.triage_tag
                WHEN 'red' THEN 1
                WHEN 'yellow' THEN 3
                WHEN 'green' THEN 5
                WHEN 'black' THEN 10
              END,
              9
            ) ASC,
            COALESCE(v.arrived_at, v.expected_at) ASC
          LIMIT $6`,
        [hospital, branch, query.status ?? null, query.zoneId ?? null, query.includeDeparted, query.limit],
      );

      const { rows: zones } = await tx.query<Record<string, unknown>>(
        `SELECT z.*,
                (SELECT count(*) FROM clinical.er_bays b WHERE b.zone_id = z.id AND b.is_active) AS bay_count,
                (SELECT count(*) FROM clinical.er_bays b WHERE b.zone_id = z.id AND b.status = 'occupied') AS occupied_count,
                (SELECT count(*) FROM clinical.er_bays b WHERE b.zone_id = z.id AND b.status = 'cleaning') AS cleaning_count
           FROM clinical.er_zones z
          WHERE z.hospital_id = $1 AND z.branch_id = $2 AND z.is_active
          ORDER BY z.sort_order, z.code`,
        [hospital, branch],
      );

      const { rows: bays } = await tx.query<Record<string, unknown>>(
        `SELECT b.*, z.code AS zone_code
           FROM clinical.er_bays b JOIN clinical.er_zones z ON z.id = b.zone_id
          WHERE b.hospital_id = $1 AND b.branch_id = $2 AND b.is_active
          ORDER BY z.sort_order, b.code`,
        [hospital, branch],
      );

      const visitViews = visits.map((v) => this.toVisit(v));

      return {
        visits: visitViews,
        zones: zones.map((z) => this.toZone(z)),
        bays: bays.map((b) => this.toBay(b)),
        counts: {
          inbound: visitViews.filter((v) => v.status === 'inbound').length,
          waiting: visitViews.filter((v) => v.status === 'arrived' || v.status === 'triaged').length,
          inTreatment: visitViews.filter((v) => v.status === 'in_treatment').length,
          boarding: visitViews.filter((v) => v.status === 'boarding').length,
          breached: visitViews.filter((v) => v.targetBreached).length,
          unidentified: visitViews.filter((v) => v.isUnidentified).length,
          baysFree: bays.filter((b) => asText(b['status']) === 'free').length,
          baysCleaning: bays.filter((b) => asText(b['status']) === 'cleaning').length,
        },
      };
    });
  }

  private toZone(r: Record<string, unknown>): ErZoneView {
    return {
      id: asText(r['id']),
      code: asText(r['code']),
      name: asText(r['name']),
      kind: asText(r['kind']),
      sortOrder: asNumber(r['sort_order']),
      bayCount: asNumber(r['bay_count'] ?? 0),
      occupiedCount: asNumber(r['occupied_count'] ?? 0),
      cleaningCount: asNumber(r['cleaning_count'] ?? 0),
    };
  }

  private toBay(r: Record<string, unknown>): ErBayView {
    return {
      id: asText(r['id']),
      zoneId: asText(r['zone_id']),
      zoneCode: asText(r['zone_code'] ?? ''),
      code: asText(r['code']),
      name: asText(r['name']),
      kind: asText(r['kind']),
      status: asText(r['status']),
      currentVisitId: asTextOrNull(r['current_visit_id']),
      hasMonitor: Boolean(r['has_monitor']),
      hasVentilator: Boolean(r['has_ventilator']),
      hasOxygen: Boolean(r['has_oxygen']),
      vacatedAt: asTextOrNull(r['vacated_at']),
    };
  }

  private toVisit(r: Record<string, unknown>): ErVisitView {
    const arrivedAt = asTextOrNull(r['arrived_at']);
    const dispositionAt = asTextOrNull(r['disposition_at']);
    const firstSeenAt = asTextOrNull(r['first_seen_at']);
    const targetSeenBy = asTextOrNull(r['target_seen_by']);

    const now = Date.now();
    const erLosMinutes =
      arrivedAt === null
        ? null
        : Math.max(
            0,
            Math.round(
              ((dispositionAt === null ? now : Date.parse(dispositionAt)) - Date.parse(arrivedAt)) / 60_000,
            ),
          );

    // Percentage of the ESI target consumed. Stops climbing once somebody has
    // actually seen them — the target is door-to-doctor, not door-to-anything.
    let targetUsedPct: number | null = null;
    let targetBreached = false;
    if (targetSeenBy !== null && arrivedAt !== null) {
      const budgetMs = Date.parse(targetSeenBy) - Date.parse(arrivedAt);
      const usedMs = (firstSeenAt === null ? now : Date.parse(firstSeenAt)) - Date.parse(arrivedAt);
      // A level-1 budget is zero: any unseen moment is already a breach, and a
      // division by zero would hide exactly the case that matters most.
      targetUsedPct = budgetMs <= 0 ? (usedMs > 0 ? 100 : 0) : Math.round((usedMs / budgetMs) * 100);
      targetBreached = firstSeenAt === null && usedMs > budgetMs;
    }

    return {
      id: asText(r['id']),
      erNo: asText(r['er_no']),
      patientId: asTextOrNull(r['patient_id']),
      tempIdentity: asTextOrNull(r['temp_identity']),
      displayName: asTextOrNull(r['display_name']),
      approximateAge: asNumberOrNull(r['approximate_age']),
      gender: asTextOrNull(r['gender']),
      arrivalMode: asText(r['arrival_mode']),
      broughtBy: asTextOrNull(r['brought_by']),
      chiefComplaint: asTextOrNull(r['chief_complaint']),
      mlcSuspected: Boolean(r['mlc_suspected']),
      esiLevel: asNumberOrNull(r['esi_level']),
      triageTag: asTextOrNull(r['triage_tag']),
      status: asText(r['status']),
      zoneId: asTextOrNull(r['zone_id']),
      bayId: asTextOrNull(r['bay_id']),
      bayCode: asTextOrNull(r['bay_code']),
      expectedAt: asTextOrNull(r['expected_at']),
      arrivedAt,
      triagedAt: asTextOrNull(r['triaged_at']),
      targetSeenBy,
      firstSeenAt,
      dispositionAt,
      isUnidentified: Boolean(r['is_unidentified']),
      erLosMinutes,
      targetUsedPct,
      targetBreached,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Arrival
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * The thirty-second path.
   *
   * A patient with no name gets `ER-TAG-<n>` and everything else follows. The
   * tag is allocated from the same numbering service as the ER number so two
   * tablets registering at once cannot collide.
   */
  async quickReg(body: QuickRegRequest): Promise<ErVisitDetailView> {
    return this.guard(async (tx) => {
      const id = newId();
      const view = await this.createVisit(tx, id, {
        arrivalMode: body.arrivalMode,
        patientId: body.patientId,
        displayName: body.displayName,
        approximateAge: body.approximateAge,
        gender: body.gender,
        chiefComplaint: body.chiefComplaint,
        broughtBy: body.broughtBy,
        broughtByPhone: body.broughtByPhone,
        mlcSuspected: body.mlcSuspected,
        ambulanceRef: body.ambulanceRef,
        inbound: false,
      });

      await this.outbox.publish(
        tx,
        erEvent('er.patient.arrived', id, {
          visitId: id,
          erNo: view.erNo,
          patientId: view.patientId,
          tempIdentity: view.tempIdentity,
          arrivalMode: body.arrivalMode,
          mlcSuspected: body.mlcSuspected,
        }),
      );

      if (body.bayId !== undefined) {
        await this.assignBayIn(tx, id, { bayId: body.bayId, method: 'assigned' });
      }

      return this.loadVisit(tx, id);
    });
  }

  /** An ambulance is on its way. Exit gate 1 starts here. */
  async preAlert(body: PreAlertRequest): Promise<ErVisitDetailView> {
    return this.guard(async (tx) => {
      const id = newId();
      const view = await this.createVisit(tx, id, {
        arrivalMode: 'ambulance',
        displayName: body.displayName,
        approximateAge: body.approximateAge,
        gender: body.gender,
        chiefComplaint: body.chiefComplaint,
        mlcSuspected: body.mlcSuspected,
        ambulanceRef: body.ambulanceRef,
        inbound: true,
        expectedAt: body.expectedAt,
      });

      await this.outbox.publish(
        tx,
        erEvent('er.prealert.received', id, {
          visitId: id,
          erNo: view.erNo,
          expectedAt: body.expectedAt,
          arrivalMode: 'ambulance',
          ambulanceRef: body.ambulanceRef ?? null,
        }),
      );

      // A held bay is the difference between a resus bay being ready and being
      // found. §6.11's pre-alert is only useful if it reserves something.
      if (body.bayId !== undefined) {
        await this.assignBayIn(tx, id, { bayId: body.bayId, method: 'assigned' });
      }

      return this.loadVisit(tx, id);
    });
  }

  private async createVisit(
    tx: TransactionClient,
    id: string,
    input: {
      readonly arrivalMode: string;
      readonly patientId?: string | undefined;
      readonly displayName?: string | undefined;
      readonly approximateAge?: number | undefined;
      readonly gender?: string | undefined;
      readonly chiefComplaint?: string | undefined;
      readonly broughtBy?: string | undefined;
      readonly broughtByPhone?: string | undefined;
      readonly mlcSuspected: boolean;
      readonly ambulanceRef?: string | undefined;
      readonly inbound: boolean;
      readonly expectedAt?: string | undefined;
    },
  ): Promise<ErVisitView> {
    const hospital = this.hospitalId();
    const branch = this.branchId();

    const erAlloc = await this.numbering.allocate(tx, {
      key: 'ER_NO',
      branchId: branch,
      refType: 'er_visit',
      refId: id,
    });

    // No patient means a tag, always — the CHECK in §B.1 will not have it any
    // other way, and that is the point of the constraint.
    const unidentified = input.patientId === undefined;
    let tempIdentity: string | null = null;
    if (unidentified) {
      const tagAlloc = await this.numbering.allocate(tx, {
        key: 'ER_TAG',
        branchId: branch,
        refType: 'er_tag',
        refId: id,
      });
      tempIdentity = tagAlloc.formatted;
    }

    const { rows } = await tx.query<Record<string, unknown>>(
      `INSERT INTO clinical.er_visits
         (id, hospital_id, branch_id, er_no, patient_id, temp_identity, display_name,
          approximate_age, gender, arrival_mode, brought_by, brought_by_phone, ambulance_ref,
          chief_complaint, mlc_suspected, status, expected_at, arrived_at, is_unidentified,
          created_at, created_by, updated_at, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,
               $8,$9,$10::"clinical"."ErArrivalMode",$11,$12,$13,
               $14,$15,$16::"clinical"."ErVisitStatus",$17::timestamptz,$18::timestamptz,$19,
               now(),$20, now(),$20)
       RETURNING *`,
      [
        id,
        hospital,
        branch,
        erAlloc.formatted,
        input.patientId ?? null,
        tempIdentity,
        input.displayName ?? (unidentified ? 'Unknown patient' : null),
        input.approximateAge ?? null,
        input.gender ?? null,
        input.arrivalMode,
        input.broughtBy ?? null,
        input.broughtByPhone ?? null,
        input.ambulanceRef ?? null,
        input.chiefComplaint ?? null,
        input.mlcSuspected,
        input.inbound ? 'inbound' : 'arrived',
        input.expectedAt ?? null,
        input.inbound ? null : new Date().toISOString(),
        unidentified,
        this.actorId(),
      ],
    );
    const row = rows[0];
    if (row === undefined) throw AppError.conflict('The ER visit could not be created.');

    await this.audit.write(tx, {
      action: 'insert',
      entity: 'er_visit',
      rowId: id,
      businessKey: erAlloc.formatted,
      dataClass: 'phi',
      before: null,
      after: { arrivalMode: input.arrivalMode, unidentified, mlcSuspected: input.mlcSuspected },
    });

    return this.toVisit(row);
  }

  async getVisit(id: string): Promise<ErVisitDetailView> {
    return this.guard((tx) => this.loadVisit(tx, id));
  }

  private async loadVisit(tx: TransactionClient, id: string): Promise<ErVisitDetailView> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT v.*, b.code AS bay_code
         FROM clinical.er_visits v
         LEFT JOIN clinical.er_bays b ON b.id = v.bay_id
        WHERE v.id = $1 AND v.hospital_id = $2`,
      [id, this.hospitalId()],
    );
    const row = rows[0];
    if (row === undefined) throw AppError.notFound('ER visit');

    const { rows: moves } = await tx.query<Record<string, unknown>>(
      `SELECT m.*, b.code AS bay_code
         FROM clinical.er_bay_movements m JOIN clinical.er_bays b ON b.id = m.bay_id
        WHERE m.visit_id = $1 ORDER BY m.moved_in_at`,
      [id],
    );
    const { rows: disp } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM clinical.er_dispositions WHERE visit_id = $1`,
      [id],
    );
    const d = disp[0];

    return {
      ...this.toVisit(row),
      movements: moves.map((m) => ({
        id: asText(m['id']),
        bayId: asText(m['bay_id']),
        bayCode: asText(m['bay_code']),
        movedInAt: asText(m['moved_in_at']),
        movedOutAt: asTextOrNull(m['moved_out_at']),
        method: asText(m['method']),
      })),
      disposition:
        d === undefined
          ? null
          : {
              id: asText(d['id']),
              kind: asText(d['kind']),
              admissionRequestId: asTextOrNull(d['admission_request_id']),
              referredToFacility: asTextOrNull(d['referred_to_facility']),
              lamaWitnessName: asTextOrNull(d['lama_witness_name']),
              deathAt: asTextOrNull(d['death_at']),
              summaryText: asTextOrNull(d['summary_text']),
              decidedAt: asText(d['decided_at']),
            },
    };
  }

  async updateVisit(id: string, body: UpdateVisitRequest): Promise<ErVisitDetailView> {
    return this.guard(async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE clinical.er_visits
            SET display_name = COALESCE($3, display_name),
                approximate_age = COALESCE($4::int, approximate_age),
                gender = COALESCE($5, gender),
                chief_complaint = COALESCE($6, chief_complaint),
                brought_by = COALESCE($7, brought_by),
                brought_by_phone = COALESCE($8, brought_by_phone),
                mlc_suspected = COALESCE($9::boolean, mlc_suspected),
                status = COALESCE($10::"clinical"."ErVisitStatus", status),
                -- The door-to-doctor clock stops once, on the first sight of a
                -- clinician. Re-stamping it would make a slow department look
                -- fast.
                first_seen_at = CASE WHEN $11::boolean AND first_seen_at IS NULL THEN now() ELSE first_seen_at END,
                arrived_at = CASE WHEN status = 'inbound' AND $10 IS NOT NULL AND $10 <> 'inbound'
                                  THEN now() ELSE arrived_at END,
                updated_at = now(), updated_by = $12
          WHERE id = $1 AND hospital_id = $2`,
        [
          id,
          this.hospitalId(),
          body.displayName ?? null,
          body.approximateAge ?? null,
          body.gender ?? null,
          body.chiefComplaint ?? null,
          body.broughtBy ?? null,
          body.broughtByPhone ?? null,
          body.mlcSuspected ?? null,
          body.status ?? null,
          body.markFirstSeen ?? false,
          this.actorId(),
        ],
      );
      if (rowCount === 0) throw AppError.notFound('ER visit');
      return this.loadVisit(tx, id);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Bays
  // ═══════════════════════════════════════════════════════════════════════════

  async assignBay(visitId: string, body: AssignBayRequest): Promise<ErVisitDetailView> {
    return this.guard(async (tx) => {
      await this.assignBayIn(tx, visitId, body);
      return this.loadVisit(tx, visitId);
    });
  }

  /**
   * Move a patient into a bay.
   *
   * Vacating the old bay puts it in `cleaning`, never straight to `free`. A bay
   * that silently became free is how the next patient is put on an unwiped
   * trolley.
   */
  private async assignBayIn(
    tx: TransactionClient,
    visitId: string,
    body: { readonly bayId: string; readonly method: string; readonly reason?: string | undefined },
  ): Promise<void> {
    const hospital = this.hospitalId();

    const { rows: bays } = await tx.query<Record<string, unknown>>(
      `SELECT b.*, z.code AS zone_code FROM clinical.er_bays b
         JOIN clinical.er_zones z ON z.id = b.zone_id
        WHERE b.id = $1 AND b.hospital_id = $2 FOR UPDATE OF b`,
      [body.bayId, hospital],
    );
    const bay = bays[0];
    if (bay === undefined) throw AppError.notFound('ER bay');
    if (asText(bay['status']) === 'occupied' && asTextOrNull(bay['current_visit_id']) !== visitId) {
      throw AppError.conflict(`Bay ${asText(bay['code'])} already has a patient in it.`);
    }
    if (['blocked', 'out_of_service'].includes(asText(bay['status']))) {
      throw AppError.conflict(`Bay ${asText(bay['code'])} is not available.`);
    }

    // Close the previous bay and send it for cleaning.
    const { rows: openMoves } = await tx.query<Record<string, unknown>>(
      `UPDATE clinical.er_bay_movements SET moved_out_at = now()
        WHERE visit_id = $1 AND moved_out_at IS NULL
        RETURNING bay_id`,
      [visitId],
    );
    for (const m of openMoves) {
      const previous = asText(m['bay_id']);
      if (previous === body.bayId) continue;
      await this.vacateBay(tx, previous);
    }

    await tx.query(
      `INSERT INTO clinical.er_bay_movements (id, hospital_id, visit_id, bay_id, moved_in_at, method, reason, by_id)
       VALUES ($1,$2,$3,$4, now(),$5,$6,$7)`,
      [newId(), hospital, visitId, body.bayId, body.method, body.reason ?? null, this.actorId()],
    );

    await tx.query(
      `UPDATE clinical.er_bays SET status = 'occupied', current_visit_id = $2, vacated_at = NULL, updated_at = now()
        WHERE id = $1`,
      [body.bayId, visitId],
    );
    await tx.query(
      `UPDATE clinical.er_visits SET bay_id = $2, zone_id = $3, updated_at = now() WHERE id = $1`,
      [visitId, body.bayId, asText(bay['zone_id'])],
    );

    await this.outbox.publish(
      tx,
      erEvent('er.bay.assigned', body.bayId, {
        visitId,
        bayId: body.bayId,
        bayCode: asText(bay['code']),
        zoneCode: asText(bay['zone_code']),
        method: body.method,
      }),
    );
  }

  private async vacateBay(tx: TransactionClient, bayId: string): Promise<void> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `UPDATE clinical.er_bays
          SET status = 'cleaning', current_visit_id = NULL, vacated_at = now(), updated_at = now()
        WHERE id = $1
        RETURNING code, (SELECT z.code FROM clinical.er_zones z WHERE z.id = zone_id) AS zone_code`,
      [bayId],
    );
    const row = rows[0];
    if (row === undefined) return;

    await this.outbox.publish(
      tx,
      erEvent('er.bay.vacated', bayId, {
        bayId,
        bayCode: asText(row['code']),
        zoneCode: asText(row['zone_code'] ?? ''),
        needsCleaning: true,
      }),
    );
  }

  /** Housekeeping says the bay is clean. NC-018 will call this in Phase 7. */
  async markBayClean(body: CleanBayRequest): Promise<ErBayView> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.er_bays
            SET status = 'free', vacated_at = NULL, updated_at = now()
          WHERE id = $1 AND hospital_id = $2 AND status = 'cleaning'
          RETURNING *, (SELECT z.code FROM clinical.er_zones z WHERE z.id = zone_id) AS zone_code`,
        [body.bayId, this.hospitalId()],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('That bay is not waiting to be cleaned.');
      return this.toBay(row);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Identity — exit gate 2
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * A tag becomes a real patient.
   *
   * The visit gains a `patient_id`. Nothing is recreated and the ER number does
   * not change, which is the whole of exit gate 2: every triage record, MLC
   * entry and imaging study already points at this visit id, and they keep
   * pointing at it.
   */
  async mergeIdentity(visitId: string, body: MergeIdentityRequest): Promise<ErVisitDetailView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();

      const { rows: before } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM clinical.er_visits WHERE id = $1 AND hospital_id = $2 FOR UPDATE`,
        [visitId, hospital],
      );
      const prior = before[0];
      if (prior === undefined) throw AppError.notFound('ER visit');
      if (prior['is_unidentified'] !== true) {
        throw AppError.conflict('This visit is already attached to a patient.');
      }

      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.er_visits
            SET patient_id = $3, merged_into_patient_id = $3, merged_at = now(),
                is_unidentified = false, updated_at = now(), updated_by = $4
          WHERE id = $1 AND hospital_id = $2
          RETURNING *`,
        [visitId, hospital, body.patientId, this.actorId()],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The identity could not be reconciled.');

      await this.audit.write(tx, {
        action: 'update',
        entity: 'er_visit',
        rowId: visitId,
        businessKey: asText(row['er_no']),
        dataClass: 'phi',
        before: { tempIdentity: asTextOrNull(prior['temp_identity']), patientId: null },
        after: { patientId: body.patientId },
        reasonText: body.reason,
      });

      await this.outbox.publish(
        tx,
        erEvent('er.identity.merged', visitId, {
          visitId,
          erNo: asText(row['er_no']),
          tempIdentity: asText(prior['temp_identity']),
          patientId: body.patientId,
        }),
      );

      return this.loadVisit(tx, visitId);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Disposition
  // ═══════════════════════════════════════════════════════════════════════════

  async dispose(visitId: string, body: DisposeRequest): Promise<ErVisitDetailView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();

      const { rows: visits } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM clinical.er_visits WHERE id = $1 AND hospital_id = $2 FOR UPDATE`,
        [visitId, hospital],
      );
      const visit = visits[0];
      if (visit === undefined) throw AppError.notFound('ER visit');
      if (asText(visit['status']) === 'departed') {
        throw AppError.conflict('This ER visit has already been closed.');
      }

      // An admission is a request Phase 7 picks up. Minted here so the ER can
      // hand over without waiting for IP-001 to exist.
      const admissionRequestId = body.kind === 'admit' ? newId() : null;

      const id = newId();
      await tx.query(
        `INSERT INTO clinical.er_dispositions
           (id, hospital_id, visit_id, kind, admission_request_id, admit_ward_hint,
            referred_to_facility, referral_reason, transport_mode,
            lama_witness_name, lama_witness_relation, lama_risks_explained,
            death_at, death_cause_text, summary_text, decided_by, decided_at, created_at)
         VALUES ($1,$2,$3,$4::"clinical"."ErDispositionKind",$5,$6,
                 $7,$8,$9,
                 $10,$11,$12,
                 $13::timestamptz,$14,$15,$16, now(), now())`,
        [
          id,
          hospital,
          visitId,
          body.kind,
          admissionRequestId,
          body.admitWardHint ?? null,
          body.referredToFacility ?? null,
          body.referralReason ?? null,
          body.transportMode ?? null,
          body.lamaWitnessName ?? null,
          body.lamaWitnessRelation ?? null,
          body.lamaRisksExplained,
          body.deathAt ?? null,
          body.deathCauseText ?? null,
          body.summaryText ?? null,
          this.actorId(),
        ],
      );

      // `observation` keeps the patient in the department, so the bay stays
      // theirs and the LOS clock keeps running.
      const departs = body.kind !== 'observation';
      await tx.query(
        `UPDATE clinical.er_visits
            SET status = $2::"clinical"."ErVisitStatus",
                disposition_at = now(),
                departed_at = CASE WHEN $3::boolean THEN now() ELSE departed_at END,
                bay_id = CASE WHEN $3::boolean THEN NULL ELSE bay_id END,
                updated_at = now(), updated_by = $4
          WHERE id = $1`,
        [visitId, departs ? 'departed' : 'in_treatment', departs, this.actorId()],
      );

      if (departs) {
        const { rows: openMoves } = await tx.query<Record<string, unknown>>(
          `UPDATE clinical.er_bay_movements SET moved_out_at = now()
            WHERE visit_id = $1 AND moved_out_at IS NULL RETURNING bay_id`,
          [visitId],
        );
        for (const m of openMoves) await this.vacateBay(tx, asText(m['bay_id']));
      }

      const arrivedAt = asTextOrNull(visit['arrived_at']);
      const losMinutes =
        arrivedAt === null ? 0 : Math.max(0, Math.round((Date.now() - Date.parse(arrivedAt)) / 60_000));

      await this.audit.write(tx, {
        action: 'update',
        entity: 'er_disposition',
        rowId: id,
        businessKey: asText(visit['er_no']),
        dataClass: 'phi',
        before: { status: asText(visit['status']) },
        after: { kind: body.kind, erLosMinutes: losMinutes },
        reasonText: body.reason,
      });

      await this.outbox.publish(
        tx,
        erEvent('er.disposition.decided', visitId, {
          visitId,
          erNo: asText(visit['er_no']),
          kind: body.kind,
          admissionRequestId,
          erLosMinutes: losMinutes,
        }),
      );

      return this.loadVisit(tx, visitId);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Layout
  // ═══════════════════════════════════════════════════════════════════════════

  async listZones(): Promise<Page<ErZoneView>> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT z.*,
                (SELECT count(*) FROM clinical.er_bays b WHERE b.zone_id = z.id AND b.is_active) AS bay_count,
                (SELECT count(*) FROM clinical.er_bays b WHERE b.zone_id = z.id AND b.status = 'occupied') AS occupied_count,
                (SELECT count(*) FROM clinical.er_bays b WHERE b.zone_id = z.id AND b.status = 'cleaning') AS cleaning_count
           FROM clinical.er_zones z
          WHERE z.hospital_id = $1 AND z.branch_id = $2
          ORDER BY z.sort_order, z.code`,
        [this.hospitalId(), this.branchId()],
      );
      return { items: rows.map((r) => this.toZone(r)), nextCursor: null, hasMore: false };
    });
  }

  async createZone(body: CreateZoneRequest): Promise<ErZoneView> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO clinical.er_zones (id, hospital_id, branch_id, code, name, kind, sort_order, created_at, created_by, updated_at, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6::"clinical"."ErZoneKind",$7, now(),$8, now(),$8)
         ON CONFLICT ("hospital_id","branch_id","code") DO NOTHING
         RETURNING *`,
        [
          newId(),
          this.hospitalId(),
          this.branchId(),
          body.code,
          body.name,
          body.kind,
          body.sortOrder,
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict(`A zone with code "${body.code}" already exists.`);
      return this.toZone({ ...row, bay_count: 0, occupied_count: 0, cleaning_count: 0 });
    });
  }

  async createBay(body: CreateBayRequest): Promise<ErBayView> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO clinical.er_bays
           (id, hospital_id, branch_id, zone_id, code, name, kind, barcode,
            has_monitor, has_ventilator, has_oxygen, created_at, created_by, updated_at, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7::"clinical"."ErBayKind",$8,$9,$10,$11, now(),$12, now(),$12)
         ON CONFLICT ("hospital_id","branch_id","code") DO NOTHING
         RETURNING *, (SELECT z.code FROM clinical.er_zones z WHERE z.id = zone_id) AS zone_code`,
        [
          newId(),
          this.hospitalId(),
          this.branchId(),
          body.zoneId,
          body.code,
          body.name,
          body.kind,
          body.barcode ?? null,
          body.hasMonitor,
          body.hasVentilator,
          body.hasOxygen,
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict(`A bay with code "${body.code}" already exists.`);
      return this.toBay(row);
    });
  }
}
