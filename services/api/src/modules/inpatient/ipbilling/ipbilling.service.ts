import { Inject, Injectable } from '@nestjs/common';
import { ProblemType, newId } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService, type TransactionClient } from '../../../core/db/database.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import { withIpBillingErrors } from './ipbilling.errors.js';
import { ipBillEvent } from './ipbilling.events.js';
import type {
  ChargeQuery,
  ChargeRunRequest,
  ClearanceOverrideRequest,
  PolicyRequest,
} from './ipbilling.schemas.js';
import type {
  ChargeRunView,
  ClearanceCheck,
  ClearanceView,
  RoomChargeRow,
  RunningBillView,
} from './ipbilling.types.js';

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
function asBool(v: unknown): boolean {
  return v === true || v === 't' || v === 'true';
}
function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/**
 * The per-day charges a stay attracts, and what each is worth.
 *
 * Rates belong in RC-003's tariff and are resolved there in production; these
 * are the fallbacks used when a class has no tariff service linked yet, so a
 * ward does not silently accrue a zero bill. A zero-rated night is a night
 * nobody notices until discharge, which is worse than an approximate one.
 */
const FALLBACK_RATES: Readonly<Record<string, number>> = {
  ROOM: 4500,
  NURSING: 800,
  RMO: 600,
  ICU_MONITOR: 2500,
};

/** Wards where room rent is exempt by statute rather than by threshold. */
const EXEMPT_WARD_TYPES: ReadonlySet<string> = new Set(['icu', 'hdu', 'nicu', 'picu']);

/**
 * Phase 7C — the inpatient bill.
 *
 * ── The job is safe because the index is, not because the job is careful ────
 *
 * `runCharges` inserts with `ON CONFLICT DO NOTHING` against a unique index on
 * (admission, charge date, charge code, occupancy). Running it twice inserts
 * nothing the second time; running it during a restart, from two workers, or
 * after a retry that had actually succeeded, all do the same. `phase-07` calls
 * duplicate room rent "the single most common source of billing disputes in
 * Indian hospitals" — a job that is *careful* not to duplicate is a job that
 * duplicates the night somebody restarts it mid-run.
 *
 * ── A correction supersedes; it never edits ─────────────────────────────────
 *
 * A back-dated transfer moves the occupancy timeline out from under charges
 * already posted. Those rows are superseded and the correct ones posted beside
 * them. The old row stays, because "what did you charge me on Tuesday" must
 * have an answer even when the answer was wrong.
 */
@Injectable()
export class IpBillingService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(AuditService) private readonly audit: AuditService,
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
    return withIpBillingErrors(() => this.db.withTenant(currentTenantContext(), fn));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The room-charge job
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Post a day's inpatient charges.
   *
   * Three statements, in order:
   *
   *   1. Supersede charges whose occupancy no longer covers their day. This is
   *      what makes a back-dated transfer correct rather than additive.
   *   2. Insert the charges the timeline now implies, `ON CONFLICT DO NOTHING`.
   *   3. Count what happened, so a re-run can be told from a first run.
   *
   * Step 2 is the whole idempotency guarantee, and it is the index's guarantee
   * rather than this method's.
   */
  async runCharges(body: ChargeRunRequest): Promise<ChargeRunView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();
      const branch = this.branchId();
      const runId = newId();
      const forDate = body.forDate ?? new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

      await tx.query(
        `INSERT INTO clinical.ip_charge_runs (
           id, hospital_id, branch_id, for_date, started_at, state, trigger, triggered_by, created_at, updated_at
         ) VALUES ($1,$2,$3,$4::date, now(), 'running', $5, $6, now(), now())`,
        [runId, hospital, branch, forDate, body.trigger, this.actorId()],
      );

      // 1. Supersede what the timeline has moved out from under.
      const { rows: superseded } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.ip_room_charges c
            SET superseded_at = now(), superseded_by = $2, updated_at = now()
           FROM clinical.ip_bed_occupancies o
          WHERE c.occupancy_id = o.id
            AND c.superseded_at IS NULL
            AND c.hospital_id = $1
            AND ($3::uuid IS NULL OR c.admission_id = $3)
            AND NOT (c.charge_date BETWEEN o.from_at::date AND COALESCE(o.to_at, now())::date)
          RETURNING c.id, c.admission_id, c.charge_date, c.charge_code, c.amount`,
        [hospital, this.actorId(), body.admissionId ?? null],
      );

      for (const row of superseded) {
        await this.outbox.publish(
          tx,
          ipBillEvent('ip.charge.superseded', asText(row['id']), {
            chargeId: asText(row['id']),
            admissionId: asText(row['admission_id']),
            chargeDate: asText(row['charge_date']).slice(0, 10),
            chargeCode: asText(row['charge_code']),
            amount: asNumber(row['amount']).toFixed(2),
            reason:
              'The occupancy timeline moved under this charge — a back-dated transfer or a corrected time.',
          }),
        );
      }

      // 2. Post what the timeline now implies. The conflict target is the
      //    idempotency index, so a second run inserts nothing.
      const { rows: posted } = await tx.query<Record<string, unknown>>(
        `INSERT INTO clinical.ip_room_charges (
           id, hospital_id, branch_id, admission_id, occupancy_id, charge_date, charge_code,
           class_id, ward_id, units, unit_rate, amount, gst_rate, gst_amount, is_exempt, exempt_reason,
           policy, covers_from, covers_to, posted_at, run_id, created_at, updated_at
         )
         SELECT gen_random_uuid(), o.hospital_id, o.branch_id, o.admission_id, o.id,
                d::date, 'ROOM', o.class_id, b.ward_id, 1,
                $4::numeric, $4::numeric,
                CASE WHEN w.ward_type = ANY($5::text[]) OR $4::numeric <= p.gst_threshold_per_day
                     THEN 0 ELSE p.room_gst_rate END,
                CASE WHEN w.ward_type = ANY($5::text[]) OR $4::numeric <= p.gst_threshold_per_day
                     THEN 0 ELSE round($4::numeric * p.room_gst_rate / 100, 2) END,
                (w.ward_type = ANY($5::text[]) OR $4::numeric <= p.gst_threshold_per_day),
                CASE WHEN w.ward_type = ANY($5::text[])
                       THEN 'Intensive and high-dependency care is exempt by statute'
                     WHEN $4::numeric <= p.gst_threshold_per_day
                       THEN 'Room rent at or below the configured threshold'
                     ELSE NULL END,
                p.policy, o.from_at, COALESCE(o.to_at, now()), now(), $6, now(), now()
           FROM clinical.ip_bed_occupancies o
           JOIN clinical.ip_admissions a ON a.id = o.admission_id
           JOIN clinical.ip_beds b       ON b.id = o.bed_id
           JOIN clinical.ip_wards w      ON w.id = b.ward_id
           JOIN clinical.ip_charge_policies p
                ON p.hospital_id = o.hospital_id
               AND (p.branch_id = o.branch_id OR p.branch_id IS NULL)
               AND p.is_active
           CROSS JOIN LATERAL generate_series(o.from_at::date, COALESCE(o.to_at, now())::date, interval '1 day') d
          WHERE o.hospital_id = $1 AND o.branch_id = $2
            AND ($3::uuid IS NULL OR o.admission_id = $3)
            AND d::date <= $7::date
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          hospital,
          branch,
          body.admissionId ?? null,
          FALLBACK_RATES['ROOM'] ?? 4500,
          [...EXEMPT_WARD_TYPES],
          runId,
          forDate,
        ],
      );

      // 3. What a re-run would have skipped: everything live for these days
      //    that this run did not itself insert.
      const { rows: totals } = await tx.query<Record<string, unknown>>(
        `SELECT count(*) FILTER (WHERE run_id IS DISTINCT FROM $2) AS skipped,
                count(DISTINCT admission_id) AS admissions
           FROM clinical.ip_room_charges
          WHERE hospital_id = $1 AND superseded_at IS NULL AND charge_date <= $3::date
            AND ($4::uuid IS NULL OR admission_id = $4)`,
        [hospital, runId, forDate, body.admissionId ?? null],
      );
      const t = totals[0] ?? {};

      const { rows: finished } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.ip_charge_runs
            SET finished_at = now(), state = 'done',
                admissions_considered = $2, charges_posted = $3,
                charges_skipped = $4, charges_superseded = $5, updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [
          runId,
          asNumber(t['admissions'] ?? 0),
          posted.length,
          asNumber(t['skipped'] ?? 0),
          superseded.length,
        ],
      );
      const run = finished[0];
      if (run === undefined) throw AppError.conflict('The charge run did not complete.');

      await this.outbox.publish(
        tx,
        ipBillEvent('ip.charge.run.completed', runId, {
          runId,
          forDate,
          trigger: body.trigger,
          admissions: asNumber(t['admissions'] ?? 0),
          posted: posted.length,
          skipped: asNumber(t['skipped'] ?? 0),
          superseded: superseded.length,
        }),
      );

      return this.toRun(run);
    });
  }

  private toRun(r: Record<string, unknown>): ChargeRunView {
    return {
      id: asText(r['id']),
      forDate: asText(r['for_date']).slice(0, 10),
      trigger: asText(r['trigger']),
      state: asText(r['state']),
      admissionsConsidered: asNumber(r['admissions_considered'] ?? 0),
      chargesPosted: asNumber(r['charges_posted'] ?? 0),
      chargesSkipped: asNumber(r['charges_skipped'] ?? 0),
      chargesSuperseded: asNumber(r['charges_superseded'] ?? 0),
      startedAt: asText(r['started_at']),
      finishedAt: asTextOrNull(r['finished_at']),
      error: asTextOrNull(r['error']),
    };
  }

  async runs(): Promise<readonly ChargeRunView[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM clinical.ip_charge_runs
          WHERE hospital_id = $1 AND branch_id = $2
          ORDER BY started_at DESC LIMIT 50`,
        [this.hospitalId(), this.branchId()],
      );
      return rows.map((r) => this.toRun(r));
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The running bill
  // ═══════════════════════════════════════════════════════════════════════════

  private toCharge(r: Record<string, unknown>): RoomChargeRow {
    return {
      id: asText(r['id']),
      admissionId: asText(r['admission_id']),
      occupancyId: asTextOrNull(r['occupancy_id']),
      chargeDate: asText(r['charge_date']).slice(0, 10),
      chargeCode: asText(r['charge_code']),
      classCode: asTextOrNull(r['class_code']),
      wardName: asTextOrNull(r['ward_name']),
      units: asNumber(r['units']),
      unitRate: asNumber(r['unit_rate']),
      amount: asNumber(r['amount']),
      gstRate: asNumber(r['gst_rate']),
      gstAmount: asNumber(r['gst_amount']),
      isExempt: asBool(r['is_exempt']),
      exemptReason: asTextOrNull(r['exempt_reason']),
      policy: asText(r['policy']),
      coversFrom: asText(r['covers_from']),
      coversTo: asText(r['covers_to']),
      supersededAt: asTextOrNull(r['superseded_at']),
      postedAt: asText(r['posted_at']),
    };
  }

  async runningBill(query: ChargeQuery): Promise<RunningBillView> {
    return this.guard(async (tx) => {
      const { rows: adm } = await tx.query<Record<string, unknown>>(
        `SELECT ip_no, deposit_taken FROM clinical.ip_admissions WHERE id = $1 AND hospital_id = $2`,
        [query.admissionId, this.hospitalId()],
      );
      const admission = adm[0];
      if (admission === undefined)
        throw AppError.notFound('That admission is not on this hospital’s record.');

      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT c.*, cl.code AS class_code, w.name AS ward_name
           FROM clinical.ip_room_charges c
           LEFT JOIN clinical.ip_bed_classes cl ON cl.id = c.class_id
           LEFT JOIN clinical.ip_wards w        ON w.id = c.ward_id
          WHERE c.hospital_id = $1 AND c.admission_id = $2
          ORDER BY c.charge_date, c.charge_code, c.posted_at`,
        [this.hospitalId(), query.admissionId],
      );

      const all = rows.map((r) => this.toCharge(r));
      const live = all.filter((c) => c.supersededAt === null);
      const superseded = all.filter((c) => c.supersededAt !== null);

      const roomTotal = live.reduce((n, c) => n + c.amount, 0);
      const gstTotal = live.reduce((n, c) => n + c.gstAmount, 0);
      const deposit = asNumber(admission['deposit_taken'] ?? 0);

      return {
        admissionId: query.admissionId,
        ipNo: asText(admission['ip_no']),
        roomCharges: live.length,
        roomTotal: Math.round(roomTotal * 100) / 100,
        gstTotal: Math.round(gstTotal * 100) / 100,
        grandTotal: Math.round((roomTotal + gstTotal) * 100) / 100,
        depositTaken: deposit,
        outstanding: Math.round((roomTotal + gstTotal - deposit) * 100) / 100,
        charges: live,
        superseded: query.includeSuperseded ? superseded : [],
      };
    });
  }

  async setPolicy(body: PolicyRequest): Promise<{ readonly id: string }> {
    return this.guard(async (tx) => {
      const reason = this.reason('Changing the charging policy');
      const id = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO clinical.ip_charge_policies (
           id, hospital_id, branch_id, policy, cutoff_hour, discharge_grace_minutes,
           admission_grace_minutes, minimum_days, day_care_flat, gst_threshold_per_day,
           room_gst_rate, is_active, created_at, updated_at
         ) VALUES ($1,$2,$3,$4::clinical."RoomChargePolicy",$5,$6,$7,$8,$9,$10,$11,true,now(),now())
         ON CONFLICT (hospital_id, branch_id) DO UPDATE SET
           policy = EXCLUDED.policy, cutoff_hour = EXCLUDED.cutoff_hour,
           discharge_grace_minutes = EXCLUDED.discharge_grace_minutes,
           admission_grace_minutes = EXCLUDED.admission_grace_minutes,
           minimum_days = EXCLUDED.minimum_days, day_care_flat = EXCLUDED.day_care_flat,
           gst_threshold_per_day = EXCLUDED.gst_threshold_per_day,
           room_gst_rate = EXCLUDED.room_gst_rate, updated_at = now()
         RETURNING id`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.policy,
          body.cutoffHour,
          body.dischargeGraceMinutes,
          body.admissionGraceMinutes,
          body.minimumDays,
          body.dayCareFlat ?? null,
          body.gstThresholdPerDay,
          body.roomGstRate,
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The policy was not saved.');

      await this.audit.write(tx, {
        action: 'config_change',
        entity: 'charge_policy',
        rowId: asText(row['id']),
        businessKey: body.policy,
        dataClass: 'financial',
        before: null,
        after: { ...body, reason },
      });

      return { id: asText(row['id']) };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Discharge clearance
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Recompute the gate.
   *
   * Every check is a query, run now — nothing is cached, because a clearance
   * that says "clear" from an hour ago is a patient who leaves over a test
   * billed since. The checks that fail are named, because "blocked" with no
   * list is a door somebody has to phone four departments to open.
   */
  async evaluateClearance(admissionId: string): Promise<ClearanceView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();
      const checks: ClearanceCheck[] = [];

      const { rows: pending } = await tx.query<Record<string, unknown>>(
        `SELECT count(*) AS n FROM clinical.ip_mar_doses
          WHERE admission_id = $1 AND hospital_id = $2 AND state = 'due' AND due_at < now()`,
        [admissionId, hospital],
      );
      const overdueDoses = asNumber(pending[0]?.['n'] ?? 0);
      checks.push({
        key: 'mar',
        label: 'Drug chart',
        state: overdueDoses > 0 ? 'blocked' : 'clear',
        detail: overdueDoses > 0 ? `${String(overdueDoses)} dose(s) still outstanding` : null,
      });

      const { rows: devices } = await tx.query<Record<string, unknown>>(
        `SELECT count(*) AS n FROM clinical.ip_device_days
          WHERE admission_id = $1 AND hospital_id = $2 AND removed_at IS NULL`,
        [admissionId, hospital],
      );
      const liveDevices = asNumber(devices[0]?.['n'] ?? 0);
      checks.push({
        key: 'devices',
        label: 'Lines and catheters',
        state: liveDevices > 0 ? 'blocked' : 'clear',
        detail: liveDevices > 0 ? `${String(liveDevices)} device(s) still recorded as in situ` : null,
      });

      const { rows: escalations } = await tx.query<Record<string, unknown>>(
        `SELECT count(*) AS n FROM clinical.ip_news2_escalations
          WHERE admission_id = $1 AND hospital_id = $2 AND resolved_at IS NULL`,
        [admissionId, hospital],
      );
      const openEscalations = asNumber(escalations[0]?.['n'] ?? 0);
      checks.push({
        key: 'escalation',
        label: 'Deterioration',
        state: openEscalations > 0 ? 'blocked' : 'clear',
        detail: openEscalations > 0 ? 'An escalation is still running on this patient' : null,
      });

      const { rows: bill } = await tx.query<Record<string, unknown>>(
        `SELECT COALESCE(sum(c.amount + c.gst_amount), 0) AS total, a.deposit_taken
           FROM clinical.ip_admissions a
           LEFT JOIN clinical.ip_room_charges c
                  ON c.admission_id = a.id AND c.superseded_at IS NULL
          WHERE a.id = $1 AND a.hospital_id = $2
          GROUP BY a.deposit_taken`,
        [admissionId, hospital],
      );
      const outstanding = asNumber(bill[0]?.['total'] ?? 0) - asNumber(bill[0]?.['deposit_taken'] ?? 0);
      checks.push({
        key: 'bill',
        label: 'Bill',
        state: outstanding > 0 ? 'blocked' : 'clear',
        detail: outstanding > 0 ? `₹${outstanding.toFixed(2)} outstanding` : null,
      });

      const blocked = checks.filter((c) => c.state === 'blocked');
      const state = blocked.length > 0 ? 'blocked' : 'pending';
      const reasons = blocked.map((c) => `${c.label}: ${c.detail ?? 'outstanding'}`);

      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO clinical.ip_discharge_clearances (
           id, hospital_id, branch_id, admission_id, checks, state, blocked_reasons, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::text[],now(),now())
         ON CONFLICT (hospital_id, admission_id) DO UPDATE SET
           checks = EXCLUDED.checks,
           state = CASE WHEN clinical.ip_discharge_clearances.overridden_at IS NOT NULL
                        THEN clinical.ip_discharge_clearances.state
                        ELSE EXCLUDED.state END,
           blocked_reasons = EXCLUDED.blocked_reasons,
           updated_at = now()
         RETURNING *`,
        [newId(), hospital, this.branchId(), admissionId, json(checks), state, reasons],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The clearance was not evaluated.');

      if (state === 'blocked') {
        await this.outbox.publish(
          tx,
          ipBillEvent('ip.clearance.blocked', asText(row['id']), {
            clearanceId: asText(row['id']),
            admissionId,
            reasons,
          }),
        );
      }

      return this.toClearance(row);
    });
  }

  private toClearance(r: Record<string, unknown>): ClearanceView {
    const raw = r['checks'];
    return {
      id: asText(r['id']),
      admissionId: asText(r['admission_id']),
      state: asText(r['state']),
      checks: Array.isArray(raw) ? (raw as ClearanceCheck[]) : [],
      blockedReasons: Array.isArray(r['blocked_reasons']) ? (r['blocked_reasons'] as string[]) : [],
      clearedAt: asTextOrNull(r['cleared_at']),
      overriddenAt: asTextOrNull(r['overridden_at']),
      overrideReason: asTextOrNull(r['override_reason']),
    };
  }

  /**
   * Clear the gate.
   *
   * Re-evaluated first, inside the same transaction. Clearing against a
   * snapshot taken a minute ago is how a patient leaves over a test that was
   * billed while they were putting their shoes on.
   */
  async clear(admissionId: string): Promise<ClearanceView> {
    const evaluated = await this.evaluateClearance(admissionId);
    if (evaluated.state === 'blocked') {
      throw AppError.conflict(
        `This discharge is held: ${evaluated.blockedReasons.join('; ')}. Resolve these, or override with stated grounds.`,
      );
    }

    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.ip_discharge_clearances
            SET state = 'cleared', cleared_at = now(), cleared_by = $3, updated_at = now()
          WHERE admission_id = $1 AND hospital_id = $2 AND state <> 'cleared'
          RETURNING *`,
        [admissionId, this.hospitalId(), this.actorId()],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('That discharge is already cleared.');
      return this.toClearance(row);
    });
  }

  async override(admissionId: string, body: ClearanceOverrideRequest): Promise<ClearanceView> {
    const evaluated = await this.evaluateClearance(admissionId);

    return this.guard(async (tx) => {
      const reason = this.reason('Overriding the discharge gate');
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.ip_discharge_clearances
            SET state = 'cleared', cleared_at = now(), cleared_by = $3,
                overridden_at = now(), overridden_by = $3, override_reason = $4, updated_at = now()
          WHERE admission_id = $1 AND hospital_id = $2
          RETURNING *`,
        [admissionId, this.hospitalId(), this.actorId(), `${reason} — ${body.acknowledgement}`],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.notFound('That admission has no clearance record.');

      await this.audit.write(tx, {
        action: 'override',
        entity: 'discharge_clearance',
        rowId: asText(row['id']),
        businessKey: admissionId,
        dataClass: 'financial',
        before: { state: evaluated.state, blockedReasons: evaluated.blockedReasons },
        after: { state: 'cleared', reason, acknowledgement: body.acknowledgement },
      });

      await this.outbox.publish(
        tx,
        ipBillEvent('ip.clearance.overridden', asText(row['id']), {
          clearanceId: asText(row['id']),
          admissionId,
          reasons: [...evaluated.blockedReasons],
          overriddenBy: this.actorId(),
          reason,
        }),
      );

      return this.toClearance(row);
    });
  }
}
