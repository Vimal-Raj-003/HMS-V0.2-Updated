import { Inject, Injectable } from '@nestjs/common';
import { ProblemType, newId, type Page } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService, type TransactionClient } from '../../../core/db/database.service.js';
import { NumberingService } from '../../../core/numbering/numbering.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { CursorService } from '../../../core/pagination/cursor.service.js';
import { PolicyService } from '../../../core/policy/policy.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import { prescribingEvent } from './prescribing.events.js';
import type { CancelOrderRequest, CreateOrderRequest, OrderQuery } from './prescribing.schemas.js';
import type { OrderItemView, OrderView } from './prescribing.types.js';

/**
 * OP-002 §3.4 — CPOE.
 *
 * An order is two facts at once, and the whole design follows from keeping them
 * in one transaction: *this investigation was requested* (clinical) and *this is
 * billable* (financial). `phase-02` exit gate 5 asks for both — the
 * `order.placed` event and the `billing.charge_intents` row — and if they were
 * written separately, the failure mode is the one every hospital already knows:
 * the test is done and never billed, or billed and never done.
 *
 * The charge intent carries **no price** unless the caller supplies one. The
 * tariff engine is RC-003 in Phase 5; inventing a price here, or defaulting it
 * to zero, would produce a bill line that looks priced and is wrong. `unit_price`
 * and `amount` are therefore null, `service_key` names what was ordered, and
 * OP-005 prices it when it exists.
 */
@Injectable()
export class OrdersService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(NumberingService) private readonly numbering: NumberingService,
    @Inject(CursorService) private readonly cursors: CursorService,
    @Inject(PolicyService) private readonly policy: PolicyService,
  ) {}

  async create(body: CreateOrderRequest): Promise<OrderView> {
    const ctx = getContext();
    const branchId = body.branchId ?? ctx.branchId;
    if (branchId === null) {
      throw AppError.conflict(
        'This session is not acting in a branch, and an order is placed at one. Choose a branch and try again.',
      );
    }

    // AERB/ALARA: the justification and the pregnancy status are conditions of
    // placing an imaging order, and the database enforces both. Checking them
    // here turns a constraint violation into two field errors the doctor can act
    // on without leaving the screen.
    if (body.category === 'radiology') {
      const errors = [];
      if (body.clinicalNotes === undefined || body.clinicalNotes.trim().length === 0) {
        errors.push({
          path: 'clinicalNotes',
          code: 'indication_required',
          message: 'An imaging order states its clinical indication — that is the radiation justification.',
        });
      }
      if (body.pregnancyStatus === undefined) {
        errors.push({
          path: 'pregnancyStatus',
          code: 'pregnancy_status_required',
          message:
            'Record the pregnancy status this imaging order was justified against. "unknown" is a valid answer; silence is not.',
        });
      }
      if (errors.length > 0) throw AppError.validation(errors);
    }

    // A pre-admission request is a different authority from ordering a test.
    if (body.category === 'admission') await this.policy.assert('order.admission.request');

    const id = newId();
    await this.db.withTenant(currentTenantContext(), async (tx) => {
      await this.assertPatientVisible(tx, body.patientId);

      const allocation = await this.numbering.allocate(tx, {
        key: 'ORD',
        branchId,
        refType: 'clinical.orders',
        refId: id,
      });

      await tx.query(
        `INSERT INTO clinical.orders (
           id, hospital_id, branch_id, encounter_id, patient_id, visit_id,
           ordering_user_id, order_no, category, priority, status, source,
           clinical_notes, diagnosis_codes, is_billable, billing_status,
           placed_at, pregnancy_status, radiation_justification,
           created_by, updated_by, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6,
           $7, $8, $9::clinical."OrderCategory", $10::clinical."OrderPriority", 'placed', 'opd',
           $11, $12::text[], $13, $14::clinical."OrderBillingStatus",
           now(), $15::clinical."PregnancyStatus", $16,
           $17, $17, now()
         )`,
        [
          id,
          ctx.hospitalId,
          branchId,
          body.encounterId ?? null,
          body.patientId,
          body.visitId ?? null,
          ctx.userId,
          allocation.formatted,
          body.category,
          body.priority,
          body.clinicalNotes ?? null,
          body.diagnosisCodes,
          body.isBillable,
          body.isBillable ? 'pending' : 'not_billable',
          body.pregnancyStatus ?? null,
          body.radiationJustification ?? null,
          ctx.userId,
        ],
      );

      const intents: ChargeIntentRecord[] = [];
      const created: CreatedLine[] = [];
      let lineNo = 0;
      for (const item of body.items) {
        lineNo += 1;
        const itemId = newId();
        const chargeIntentId = body.isBillable ? newId() : null;

        if (chargeIntentId !== null) {
          await tx.query(
            `INSERT INTO billing.charge_intents (
               id, hospital_id, branch_id, patient_id, visit_id, encounter_id,
               source_module, source_table, source_id, service_key, description,
               qty, unit_price, amount, currency, status, created_by, updated_by, updated_at
             ) VALUES (
               $1, $2, $3, $4, $5, $6,
               'OP-002', 'clinical.order_items', $7, $8, $9,
               $10, $11, $12, 'INR', 'pending', $13, $13, now()
             )`,
            [
              chargeIntentId,
              ctx.hospitalId,
              branchId,
              body.patientId,
              body.visitId ?? null,
              body.encounterId ?? null,
              itemId,
              item.serviceKey ?? null,
              item.serviceName,
              item.qty,
              item.unitPrice ?? null,
              item.unitPrice === undefined ? null : Number((item.unitPrice * item.qty).toFixed(2)),
              ctx.userId,
            ],
          );
          intents.push({
            id: chargeIntentId,
            sourceId: itemId,
            serviceKey: item.serviceKey ?? null,
            description: item.serviceName,
            qty: item.qty,
            unitPrice: item.unitPrice ?? null,
          });
        }

        await tx.query(
          `INSERT INTO clinical.order_items (
             id, hospital_id, order_id, line_no, service_key, service_name,
             catalogue_code, modality_code, body_part_code, qty, laterality, contrast,
             fasting_required, status, price_snapshot, currency, charge_intent_id,
             created_by, updated_by, updated_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6,
             $7, $8, $9, $10, $11::clinical."Laterality", $12,
             $13, 'ordered', $14, 'INR', $15,
             $16, $16, now()
           )`,
          [
            itemId,
            ctx.hospitalId,
            id,
            lineNo,
            item.serviceKey ?? null,
            item.serviceName,
            item.catalogueCode ?? null,
            item.modalityCode ?? null,
            item.bodyPartCode ?? null,
            item.qty,
            item.laterality,
            item.contrast,
            item.fastingRequired,
            item.unitPrice ?? null,
            chargeIntentId,
            ctx.userId,
          ],
        );

        created.push({
          orderItemId: itemId,
          serviceKey: item.serviceKey ?? null,
          serviceName: item.serviceName,
          qty: item.qty,
          laterality: item.laterality,
          contrast: item.contrast,
          fastingRequired: item.fastingRequired,
        });
      }

      await this.history(tx, id, null, 'placed', null);

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'clinical.orders',
        rowId: id,
        businessKey: allocation.formatted,
        dataClass: 'phi',
        patientId: body.patientId,
        encounterId: body.encounterId ?? null,
        before: null,
        after: {
          order_no: allocation.formatted,
          category: body.category,
          priority: body.priority,
          item_count: body.items.length,
          is_billable: body.isBillable,
        },
      });

      const placedAt = new Date().toISOString();

      await this.outbox.publish(
        tx,
        prescribingEvent('order.placed', id, {
          orderId: id,
          orderNo: allocation.formatted,
          patientId: body.patientId,
          encounterId: body.encounterId ?? null,
          visitId: body.visitId ?? null,
          orderingUserId: ctx.userId ?? '',
          category: body.category,
          priority: body.priority,
          itemCount: body.items.length,
          isBillable: body.isBillable,
          placedAt,
        }),
      );

      await this.publishCategoryEvent(tx, id, body, placedAt, created);

      for (const intent of intents) {
        await this.outbox.publish(
          tx,
          prescribingEvent('charge.intent.created', intent.id, {
            chargeIntentId: intent.id,
            patientId: body.patientId,
            visitId: body.visitId ?? null,
            encounterId: body.encounterId ?? null,
            admissionId: null,
            sourceModule: 'OP-002',
            sourceTable: 'clinical.order_items',
            sourceId: intent.sourceId,
            serviceKey: intent.serviceKey,
            description: intent.description,
            // Money and quantity travel as decimal strings in an event payload,
            // never as floats (packages/contracts/events/registry.ts).
            qty: decimalString(intent.qty, 4),
            unitPrice: intent.unitPrice === null ? null : decimalString(intent.unitPrice, 2),
            amount: intent.unitPrice === null ? null : decimalString(intent.unitPrice * intent.qty, 2),
            currency: 'INR',
            createdAt: placedAt,
          }),
        );
      }
    });

    return this.get(id);
  }

  async cancel(id: string, body: CancelOrderRequest): Promise<OrderView> {
    const ctx = getContext();
    const before = await this.get(id);
    if (before.status === 'cancelled') {
      throw new AppError(ProblemType.ALREADY_DECIDED, 'This order is already cancelled.');
    }
    if (before.status === 'completed') {
      throw AppError.conflict('This order has been completed and cannot be cancelled.');
    }

    await this.db.withTenant(currentTenantContext(), async (tx) => {
      await tx.query(
        `UPDATE clinical.orders
            SET status = 'cancelled', cancelled_at = now(), cancel_reason = $2,
                updated_by = $3, updated_at = now(), version = version + 1
          WHERE id = $1`,
        [id, body.reason, ctx.userId],
      );
      await tx.query(
        `UPDATE clinical.order_items
            SET status = 'cancelled', cancel_reason = $2, updated_by = $3, updated_at = now()
          WHERE order_id = $1 AND status <> 'cancelled'`,
        [id, body.reason, ctx.userId],
      );

      // The charge intent is reversed, never deleted: OP-005 needs the pair to
      // explain a credit note.
      const reversed = await tx.rows<{ id: string; source_id: string; amount: string | null }>(
        `UPDATE billing.charge_intents
            SET status = 'reversed', reversed_at = now(), reversal_reason = $2,
                updated_by = $3, updated_at = now(), version = version + 1
          WHERE source_table = 'clinical.order_items'
            AND source_id IN (SELECT id FROM clinical.order_items WHERE order_id = $1)
            AND status = 'pending'
        RETURNING id, source_id, amount::text AS amount`,
        [id, body.reason, ctx.userId],
      );

      await this.history(tx, id, before.status, 'cancelled', body.reason);

      await this.audit.write(tx, {
        action: 'delete',
        entity: 'clinical.orders',
        rowId: id,
        businessKey: before.order_no,
        dataClass: 'phi',
        patientId: before.patient_id,
        encounterId: before.encounter_id,
        before: { status: before.status },
        after: { status: 'cancelled', charge_intents_reversed: reversed.length },
        reasonText: body.reason,
      });

      const at = new Date().toISOString();
      await this.outbox.publish(
        tx,
        prescribingEvent('order.cancelled', id, {
          orderId: id,
          orderItemIds: before.items.map((i) => i.id),
          patientId: before.patient_id,
          category: before.category,
          reason: body.reason,
          cancelledBy: ctx.userId ?? '',
          cancelledAt: at,
        }),
      );

      for (const intent of reversed) {
        await this.outbox.publish(
          tx,
          prescribingEvent('charge.intent.reversed', intent.id, {
            chargeIntentId: intent.id,
            patientId: before.patient_id,
            sourceModule: 'OP-002',
            sourceId: intent.source_id,
            amount: intent.amount,
            reason: body.reason,
            reversedBy: ctx.userId,
            reversedAt: at,
          }),
        );
      }
    });

    return this.get(id);
  }

  async get(id: string): Promise<OrderView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const header = await tx.maybeOne<OrderRow>(
        `SELECT id, order_no, patient_id, encounter_id, category::text AS category,
                priority::text AS priority, status::text AS status,
                billing_status::text AS billing_status, clinical_notes,
                pregnancy_status::text AS pregnancy_status, placed_at::text AS placed_at, cancel_reason
           FROM clinical.orders WHERE id = $1`,
        [id],
      );
      if (header === undefined) throw AppError.notFound('The order');
      const items = await tx.rows<OrderItemRow>(
        `SELECT id, line_no, service_key, service_name, qty::text AS qty,
                laterality::text AS laterality, contrast, fasting_required,
                status::text AS status, charge_intent_id, price_snapshot::text AS price_snapshot
           FROM clinical.order_items WHERE order_id = $1 ORDER BY line_no`,
        [id],
      );
      return toOrderView(header, items);
    });
  }

  async list(query: OrderQuery): Promise<Page<OrderView>> {
    const ctx = getContext();
    const hospitalId = ctx.hospitalId ?? '';
    const resource = 'opd.orders';
    const limit = this.cursors.pageSize(query.limit);
    const after = this.cursors.start(query.cursor, { hospitalId, resource });

    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const values: unknown[] = [];
      const bind = (value: unknown): string => `$${values.push(value)}`;
      const clauses: string[] = [];
      if (query.patientId !== undefined) clauses.push(`o.patient_id = ${bind(query.patientId)}::uuid`);
      if (query.category !== undefined) {
        clauses.push(`o.category = ${bind(query.category)}::clinical."OrderCategory"`);
      }
      if (query.status !== undefined)
        clauses.push(`o.status = ${bind(query.status)}::clinical."OrderStatus"`);
      if (after !== null) {
        clauses.push(`(o.created_at, o.id) < (${bind(after.k[0])}::timestamptz, ${bind(after.id)}::uuid)`);
      }
      const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;

      const rows = await tx.rows<OrderRow & { cursor_key: string }>(
        `SELECT o.id, o.order_no, o.patient_id, o.encounter_id, o.category::text AS category,
                o.priority::text AS priority, o.status::text AS status,
                o.billing_status::text AS billing_status, o.clinical_notes,
                o.pregnancy_status::text AS pregnancy_status, o.placed_at::text AS placed_at,
                o.cancel_reason, o.created_at::text AS cursor_key
           FROM clinical.orders o
           ${where}
          ORDER BY o.created_at DESC, o.id DESC
          LIMIT ${bind(limit + 1)}`,
        values,
      );

      const page = this.cursors.keysetPage<OrderRow>(rows, limit, {
        hospitalId,
        resource,
        direction: 'desc',
      });

      const ids = page.items.map((o) => o.id);
      const items =
        ids.length === 0
          ? []
          : await tx.rows<OrderItemRow & { order_id: string }>(
              `SELECT order_id, id, line_no, service_key, service_name, qty::text AS qty,
                      laterality::text AS laterality, contrast, fasting_required,
                      status::text AS status, charge_intent_id, price_snapshot::text AS price_snapshot
                 FROM clinical.order_items WHERE order_id = ANY($1::uuid[]) ORDER BY line_no`,
              [ids],
            );

      return {
        items: page.items.map((header) =>
          toOrderView(
            header,
            items.filter((i) => i.order_id === header.id),
          ),
        ),
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      };
    });
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  /** A patient in another hospital is filtered by RLS and reads as missing. */
  private async assertPatientVisible(tx: TransactionClient, patientId: string): Promise<void> {
    const row = await tx.maybeOne<{ id: string }>(
      `SELECT id FROM patient.patients WHERE id = $1 AND deleted_at IS NULL`,
      [patientId],
    );
    if (row === undefined) throw AppError.notFound('The patient');
  }

  private async history(
    tx: TransactionClient,
    orderId: string,
    from: string | null,
    to: string,
    reason: string | null,
  ): Promise<void> {
    const ctx = getContext();
    await tx.query(
      `INSERT INTO clinical.order_status_history
         (id, hospital_id, order_id, from_status, to_status, reason, actor_user_id, actor_role)
       VALUES ($1, $2, $3, $4::clinical."OrderStatus", $5::clinical."OrderStatus", $6, $7, $8)`,
      [newId(), ctx.hospitalId, orderId, from, to, reason, ctx.userId, ctx.roleKeys[0] ?? null],
    );
  }

  private async publishCategoryEvent(
    tx: TransactionClient,
    id: string,
    body: CreateOrderRequest,
    placedAt: string,
    lines: readonly CreatedLine[],
  ): Promise<void> {
    const items = lines.map((line) => ({
      orderItemId: line.orderItemId,
      serviceKey: line.serviceKey,
      serviceName: line.serviceName,
      qty: decimalString(line.qty, 4),
      laterality: line.laterality,
      contrast: line.contrast,
      fastingRequired: line.fastingRequired,
    }));

    switch (body.category) {
      case 'lab':
        await this.outbox.publish(
          tx,
          prescribingEvent('order.lab.created', id, {
            orderId: id,
            patientId: body.patientId,
            encounterId: body.encounterId ?? null,
            priority: body.priority,
            clinicalIndication: body.clinicalNotes ?? null,
            items,
            placedAt,
          }),
        );
        return;
      case 'radiology':
        await this.outbox.publish(
          tx,
          prescribingEvent('order.rad.created', id, {
            orderId: id,
            patientId: body.patientId,
            encounterId: body.encounterId ?? null,
            priority: body.priority,
            clinicalIndication: body.clinicalNotes ?? null,
            pregnancyStatus: body.pregnancyStatus ?? null,
            items,
            placedAt,
          }),
        );
        return;
      case 'procedure':
      case 'nursing':
      case 'therapy':
      case 'physio':
      case 'diet':
        await this.outbox.publish(
          tx,
          prescribingEvent('order.procedure.created', id, {
            orderId: id,
            patientId: body.patientId,
            encounterId: body.encounterId ?? null,
            category: body.category,
            priority: body.priority,
            items,
            placedAt,
          }),
        );
        return;
      case 'admission':
        await this.outbox.publish(
          tx,
          prescribingEvent('order.admission.requested', id, {
            orderId: id,
            patientId: body.patientId,
            encounterId: body.encounterId ?? null,
            requestedBy: getContext().userId ?? '',
            provisionalDiagnosisCodes: body.diagnosisCodes,
            wardClass: null,
            expectedLosDays: null,
            surgeryLikely: false,
            requestedAt: placedAt,
          }),
        );
        return;
      case 'referral':
      case 'other':
        // OP-021 owns `clinical.referrals` and `order.referral.created` needs the
        // referral row's id. Raising the event with an invented id would put a
        // dangling reference into every consumer, so the generic `order.placed`
        // is all this module publishes until the referral module exists.
        return;
      default:
        return;
    }
  }
}

interface CreatedLine {
  readonly orderItemId: string;
  readonly serviceKey: string | null;
  readonly serviceName: string;
  readonly qty: number;
  readonly laterality: string;
  readonly contrast: boolean;
  readonly fastingRequired: boolean;
}

interface ChargeIntentRecord {
  readonly id: string;
  readonly sourceId: string;
  readonly serviceKey: string | null;
  readonly description: string;
  readonly qty: number;
  readonly unitPrice: number | null;
}

/**
 * Money and quantity in an event payload are decimal strings, so that a
 * consumer in another language cannot introduce a binary-floating-point rounding
 * difference into a bill (`packages/contracts` events registry).
 */
function decimalString(value: number, places: number): string {
  return value.toFixed(places).replace(/\.?0+$/, (match) => (match.startsWith('.') ? '' : match));
}

interface OrderRow {
  readonly id: string;
  readonly order_no: string | null;
  readonly patient_id: string;
  readonly encounter_id: string | null;
  readonly category: string;
  readonly priority: string;
  readonly status: string;
  readonly billing_status: string;
  readonly clinical_notes: string | null;
  readonly pregnancy_status: string | null;
  readonly placed_at: string | null;
  readonly cancel_reason: string | null;
}

interface OrderItemRow {
  readonly id: string;
  readonly line_no: number;
  readonly service_key: string | null;
  readonly service_name: string;
  readonly qty: string;
  readonly laterality: string;
  readonly contrast: boolean;
  readonly fasting_required: boolean;
  readonly status: string;
  readonly charge_intent_id: string | null;
  readonly price_snapshot: string | null;
}

function toOrderView(header: OrderRow, items: readonly OrderItemRow[]): OrderView {
  const lines: OrderItemView[] = items.map((row) => ({
    id: row.id,
    line_no: row.line_no,
    service_key: row.service_key,
    service_name: row.service_name,
    qty: Number(row.qty),
    laterality: row.laterality,
    contrast: row.contrast,
    fasting_required: row.fasting_required,
    status: row.status,
    charge_intent_id: row.charge_intent_id,
    price_snapshot: row.price_snapshot === null ? null : Number(row.price_snapshot),
  }));

  return {
    id: header.id,
    order_no: header.order_no,
    patient_id: header.patient_id,
    encounter_id: header.encounter_id,
    category: header.category,
    priority: header.priority,
    status: header.status,
    billing_status: header.billing_status,
    clinical_notes: header.clinical_notes,
    pregnancy_status: header.pregnancy_status,
    placed_at: header.placed_at,
    cancel_reason: header.cancel_reason,
    items: lines,
  };
}
