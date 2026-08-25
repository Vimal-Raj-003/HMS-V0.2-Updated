import { Inject, Injectable } from '@nestjs/common';
import { ProblemType, newId, type Page } from '@vims/contracts';
import { AuditService } from '../../core/audit/audit.service.js';
import { getContext } from '../../core/context/request-context.js';
import { DatabaseService, type TransactionClient } from '../../core/db/database.service.js';
import { OutboxService } from '../../core/outbox/outbox.service.js';
import { CursorService } from '../../core/pagination/cursor.service.js';
import { AppError } from '../../core/problem/app-error.js';
import { currentTenantContext } from '../../core/tenancy/tenant-context.js';
import { binder, hospitalId, requireBranch } from '../inventory/inventory.common.js';
import { pharmacyEvent, withPharmacyErrors } from './pharmacy.common.js';
import type {
  ArriveRequest,
  AssignRequest,
  EnqueueRxRequest,
  HoldRequest,
  QueueQuery,
} from './pharmacy.schemas.js';
import type { RxQueueView } from './pharmacy.types.js';

/**
 * OP-003 §3 — the prescription queue at the counter.
 *
 * ── Where a queue entry comes from ──────────────────────────────────────────
 *
 * `phase-04 §4.4` says the queue is "fed by `rx.created` events from Phase 2".
 * The relay that turns an outbox row into a Redis message lives in
 * `services/worker`, which is outside this phase's scope, so the intake is
 * exposed as a route: `enqueue()` takes a signed prescription id and builds the
 * queue entry from the prescription itself. A consumer of `rx.created` calls it,
 * and so does a front-office screen when a patient walks up with a paper copy of
 * a prescription written in this hospital. The uniqueness index on
 * `(prescription_id, pharmacy_store_id)` makes both paths idempotent against
 * each other, which is what a queue fed by an at-least-once relay needs.
 *
 * ── Why the flags are computed here and stored ──────────────────────────────
 *
 * `has_controlled` and `has_allergy_flag` decide where the entry sits in the
 * queue and what the counter is warned about *before* the pharmacist starts.
 * `phase-04 §4.4` is explicit that a controlled item or an allergy flag "is not
 * something the counter should discover at the last item" — by then the patient
 * has been waiting, the other three lines are bagged, and the pressure is
 * entirely on the side of proceeding.
 *
 * The flags are a *snapshot* for sorting and warning. They are not the safety
 * check: `DispenseService` re-runs the full CDSS evaluation at completion, and
 * that is what actually blocks.
 */
@Injectable()
export class RxQueueService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(CursorService) private readonly cursors: CursorService,
  ) {}

  async enqueue(body: EnqueueRxRequest): Promise<RxQueueView> {
    const ctx = getContext();
    const branchId = requireBranch();

    const id = await withPharmacyErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const rx = await tx.maybeOne<{
          id: string;
          patient_id: string;
          encounter_id: string | null;
          doctor_user_id: string;
          status: string;
          rx_no: string | null;
        }>(
          `SELECT id, patient_id, encounter_id, doctor_user_id, status::text AS status, rx_no
             FROM clinical.prescriptions WHERE id = $1`,
          [body.prescriptionId],
        );
        if (rx === undefined) throw AppError.notFound('The prescription');
        if (rx.status !== 'signed' && rx.status !== 'partially_dispensed') {
          throw new AppError(
            ProblemType.BUSINESS_RULE_VIOLATED,
            `That prescription is "${rx.status}". Only a signed prescription reaches a pharmacy queue — an unsigned one is a draft the prescriber is still writing.`,
          );
        }

        // An entry already on this counter's queue is the same submission
        // arriving twice, which is what an at-least-once relay does. Return it
        // rather than refusing: the caller wanted the prescription queued, and
        // it is.
        const existing = await tx.maybeOne<{ id: string }>(
          `SELECT id FROM pharmacy.rx_queue WHERE prescription_id = $1 AND pharmacy_store_id = $2`,
          [body.prescriptionId, body.pharmacyStoreId],
        );
        if (existing !== undefined) return existing.id;

        const lines = await tx.rows<{ schedule_class: string | null; hard_stop_fired: boolean }>(
          `SELECT schedule_class::text AS schedule_class, hard_stop_fired
             FROM clinical.prescription_items
            WHERE prescription_id = $1 AND status = 'active'`,
          [body.prescriptionId],
        );
        if (lines.length === 0) {
          throw new AppError(
            ProblemType.BUSINESS_RULE_VIOLATED,
            'That prescription has no active lines, so there is nothing for the counter to fill.',
          );
        }

        const hasControlled = lines.some((l) =>
          ['x', 'ndps_narcotic', 'ndps_psychotropic'].includes(l.schedule_class ?? ''),
        );
        const hasAllergyFlag = lines.some((l) => l.hard_stop_fired);

        const queueId = newId();
        const slaMinutes = body.slaMinutes ?? (hasControlled ? 20 : 30);

        await tx.query(
          `INSERT INTO pharmacy.rx_queue
             (id, hospital_id, branch_id, pharmacy_store_id, prescription_id, patient_id,
              encounter_id, prescriber_user_id, status, priority, item_count, has_allergy_flag,
              has_controlled, queued_at, sla_due_at, created_by, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6,
                   $7, $8, 'pending'::pharmacy."PhRxQueueStatus", $9, $10, $11,
                   $12, now(), now() + ($13 || ' minutes')::interval, $14, $14, now())`,
          [
            queueId,
            ctx.hospitalId,
            branchId,
            body.pharmacyStoreId,
            body.prescriptionId,
            rx.patient_id,
            rx.encounter_id,
            rx.doctor_user_id,
            // A controlled prescription outranks a routine one even when nobody
            // set a priority: it needs a second pharmacist, and finding one
            // takes longer than filling the rest of the queue.
            Math.max(body.priority, hasControlled ? 5 : 0),
            lines.length,
            hasAllergyFlag,
            hasControlled,
            String(slaMinutes),
            ctx.userId,
          ],
        );

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'pharmacy.rx_queue',
          rowId: queueId,
          businessKey: rx.rx_no ?? body.prescriptionId,
          dataClass: 'phi',
          patientId: rx.patient_id,
          encounterId: rx.encounter_id,
          before: null,
          after: {
            pharmacy_store_id: body.pharmacyStoreId,
            item_count: lines.length,
            has_controlled: hasControlled,
          },
        });

        await this.outbox.publish(
          tx,
          pharmacyEvent('pharmacy.rx.received', queueId, {
            queueId,
            prescriptionId: body.prescriptionId,
            patientId: rx.patient_id,
            pharmacyStoreId: body.pharmacyStoreId,
            itemCount: lines.length,
            hasControlled,
            hasAllergyFlag,
            priority: Math.max(body.priority, hasControlled ? 5 : 0),
            queuedAt: new Date().toISOString(),
            slaDueAt: new Date(Date.now() + slaMinutes * 60_000).toISOString(),
          }),
        );

        return queueId;
      }),
    );

    return this.get(id);
  }

  /** The patient is at the counter, and their identity has been verified. */
  async arrive(id: string, body: ArriveRequest): Promise<RxQueueView> {
    return this.transition(id, ['pending', 'on_hold'], 'patient_arrived', (tx, ctx) =>
      tx.query(
        `UPDATE pharmacy.rx_queue
            SET identity_verified = true, identity_method = $2, arrived_at = now(),
                updated_at = now(), updated_by = $3
          WHERE id = $1`,
        [id, body.identityMethod, ctx.userId],
      ),
    );
  }

  async assign(id: string, body: AssignRequest): Promise<RxQueueView> {
    return this.transition(id, ['pending', 'patient_arrived', 'on_hold'], 'in_progress', (tx, ctx) =>
      tx.query(
        `UPDATE pharmacy.rx_queue
            SET assigned_to = $2, started_at = COALESCE(started_at, now()),
                updated_at = now(), updated_by = $3
          WHERE id = $1`,
        [id, body.assignedTo, ctx.userId],
      ),
    );
  }

  async hold(id: string, body: HoldRequest): Promise<RxQueueView> {
    return this.transition(
      id,
      ['pending', 'patient_arrived', 'in_progress', 'awaiting_approval'],
      'on_hold',
      (tx, ctx) =>
        tx.query(
          `UPDATE pharmacy.rx_queue SET cancel_reason = $2, updated_at = now(), updated_by = $3
            WHERE id = $1`,
          [id, body.reason, ctx.userId],
        ),
      body.reason,
    );
  }

  /** Called by `DispenseService` inside its own transaction when a fill lands. */
  async markCompleted(
    tx: TransactionClient,
    id: string,
    status: 'completed' | 'partial' | 'cancelled',
  ): Promise<void> {
    const ctx = getContext();
    await tx.query(
      `UPDATE pharmacy.rx_queue
          SET status = $2::pharmacy."PhRxQueueStatus", completed_at = now(),
              updated_at = now(), updated_by = $3, version = version + 1
        WHERE id = $1`,
      [id, status, ctx.userId],
    );
  }

  // ── reads ────────────────────────────────────────────────────────────────

  async get(id: string): Promise<RxQueueView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const row = await tx.maybeOne<QueueRow>(`${QUEUE_SQL} WHERE q.id = $1`, [id]);
      if (row === undefined) throw AppError.notFound('The queue entry');
      return toQueueView(row);
    });
  }

  /**
   * The counter's worklist: highest priority first, then oldest first.
   *
   * The sort is `(priority DESC, queued_at ASC)` and the cursor keys on both,
   * because a queue sorted only by time makes a controlled prescription wait
   * behind eleven routine ones, and a queue sorted only by priority starves
   * everybody who is not urgent.
   */
  async list(query: QueueQuery): Promise<Page<RxQueueView>> {
    const hospital = hospitalId();
    const resource = 'pharmacy.rx_queue';
    const limit = this.cursors.pageSize(query.limit);
    const after = this.cursors.start(query.cursor, { hospitalId: hospital, resource });

    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const values: unknown[] = [];
      const bind = binder(values);
      const clauses: string[] = [];
      if (query.pharmacyStoreId !== undefined) {
        clauses.push(`q.pharmacy_store_id = ${bind(query.pharmacyStoreId)}::uuid`);
      }
      if (query.status !== undefined) {
        clauses.push(`q.status = ${bind(query.status)}::pharmacy."PhRxQueueStatus"`);
      }
      if (query.assignedTo !== undefined) clauses.push(`q.assigned_to = ${bind(query.assignedTo)}::uuid`);
      if (after !== null) {
        clauses.push(
          `(-q.priority, q.queued_at, q.id) > (${bind(after.k[0])}::int, ${bind(after.k[1])}::timestamptz, ${bind(after.id)}::uuid)`,
        );
      }
      const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;

      const rows = await tx.rows<QueueRow>(
        `${QUEUE_SQL} ${where}
          ORDER BY q.priority DESC, q.queued_at ASC, q.id ASC
          LIMIT ${bind(limit + 1)}`,
        values,
      );

      const page = this.cursors.page<QueueRow>(rows, limit, {
        hospitalId: hospital,
        resource,
        direction: 'asc',
        sortKeys: (row) => [-row.priority, row.queued_at],
      });
      return { items: page.items.map(toQueueView), nextCursor: page.nextCursor, hasMore: page.hasMore };
    });
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private async transition(
    id: string,
    from: readonly string[],
    to: string,
    write: (tx: TransactionClient, ctx: ReturnType<typeof getContext>) => Promise<unknown>,
    reasonText?: string,
  ): Promise<RxQueueView> {
    const ctx = getContext();

    await withPharmacyErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const current = await tx.maybeOne<{ status: string; patient_id: string }>(
          `SELECT status::text AS status, patient_id FROM pharmacy.rx_queue WHERE id = $1 FOR UPDATE`,
          [id],
        );
        if (current === undefined) throw AppError.notFound('The queue entry');
        if (!from.includes(current.status)) {
          throw new AppError(
            ProblemType.ALREADY_DECIDED,
            `This queue entry is "${current.status}", so it cannot become "${to}".`,
          );
        }

        await write(tx, ctx);
        await tx.query(
          `UPDATE pharmacy.rx_queue
              SET status = $2::pharmacy."PhRxQueueStatus", updated_at = now(), updated_by = $3,
                  version = version + 1
            WHERE id = $1`,
          [id, to, ctx.userId],
        );

        await this.audit.write(tx, {
          action: 'update',
          entity: 'pharmacy.rx_queue',
          rowId: id,
          businessKey: id,
          dataClass: 'phi',
          patientId: current.patient_id,
          reasonText: reasonText ?? null,
          before: { status: current.status },
          after: { status: to },
        });
      }),
    );

    return this.get(id);
  }
}

const QUEUE_SQL = `SELECT q.id, q.pharmacy_store_id, q.prescription_id, q.patient_id, q.encounter_id,
        q.prescriber_user_id, q.status::text AS status, q.priority, q.item_count,
        q.has_allergy_flag, q.has_controlled, q.assigned_to, q.identity_verified,
        q.identity_method, q.queued_at::text AS queued_at, q.arrived_at::text AS arrived_at,
        q.started_at::text AS started_at, q.completed_at::text AS completed_at,
        q.sla_due_at::text AS sla_due_at, q.cancel_reason
   FROM pharmacy.rx_queue q`;

interface QueueRow {
  readonly id: string;
  readonly pharmacy_store_id: string;
  readonly prescription_id: string;
  readonly patient_id: string;
  readonly encounter_id: string | null;
  readonly prescriber_user_id: string | null;
  readonly status: string;
  readonly priority: number;
  readonly item_count: number;
  readonly has_allergy_flag: boolean;
  readonly has_controlled: boolean;
  readonly assigned_to: string | null;
  readonly identity_verified: boolean;
  readonly identity_method: string | null;
  readonly queued_at: string;
  readonly arrived_at: string | null;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly sla_due_at: string | null;
  readonly cancel_reason: string | null;
}

function toQueueView(row: QueueRow): RxQueueView {
  return {
    id: row.id,
    pharmacyStoreId: row.pharmacy_store_id,
    prescriptionId: row.prescription_id,
    patientId: row.patient_id,
    encounterId: row.encounter_id,
    prescriberUserId: row.prescriber_user_id,
    status: row.status,
    priority: row.priority,
    itemCount: row.item_count,
    hasAllergyFlag: row.has_allergy_flag,
    hasControlled: row.has_controlled,
    assignedTo: row.assigned_to,
    identityVerified: row.identity_verified,
    identityMethod: row.identity_method,
    queuedAt: new Date(row.queued_at).toISOString(),
    arrivedAt: row.arrived_at === null ? null : new Date(row.arrived_at).toISOString(),
    startedAt: row.started_at === null ? null : new Date(row.started_at).toISOString(),
    completedAt: row.completed_at === null ? null : new Date(row.completed_at).toISOString(),
    slaDueAt: row.sla_due_at === null ? null : new Date(row.sla_due_at).toISOString(),
    cancelReason: row.cancel_reason,
  };
}
