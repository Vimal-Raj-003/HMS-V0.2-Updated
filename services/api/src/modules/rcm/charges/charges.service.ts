import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import { DatabaseService, type TransactionClient } from '../../../core/db/database.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { BillingService } from '../billing/billing.service.js';
import type { PendingQuery, PostChargesRequest, ReverseChargeRequest } from './charges.schemas.js';
import type { ChargeIntentRow, PostChargesResult } from './charges.types.js';

/**
 * Row values arrive as `unknown`, and a bare `String(v)` on an object gives
 * "[object Object]" — which reads like data and is not. Narrowing first means a
 * shape nobody expected shows up as an empty string rather than as a bill line
 * described as an object.
 */
function asText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  if (v instanceof Date) return v.toISOString();
  return '';
}
function asTextOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const text = asText(v);
  return text === '' ? null : text;
}

/**
 * RC-006 — the bridge between a clinical act and a bill line.
 *
 * ── The half that was missing ──────────────────────────────────────────────
 *
 * `billing.charge_intents` was built with everything a hand-off needs: a
 * `status` that runs pending → posted, a `bill_line_id` to point at what it
 * became, a unique index on `(hospital_id, source_table, source_id)` so an act
 * cannot be charged twice, and a trigger refusing to cancel a charge that has
 * already reached a bill. What it never had was anybody to write a row or
 * anybody to drain one — so the table stood empty, thirty specialty consoles
 * produced nothing billable, and the hospital did the work for free.
 *
 * This service is the drain. Consoles raise intents through
 * `ConsoleSupport.raiseChargeIntent` in the transaction that records the act;
 * a biller posts them onto a bill here.
 *
 * ── It does not price ──────────────────────────────────────────────────────
 *
 * Posting hands each intent to `BillingService.postItems`, which resolves the
 * rate through RC-003 against the tariff in force on the day and the payer on
 * the bill. Pricing in two places is pricing that disagrees, and the day it
 * disagrees is the day a corporate plan changes.
 *
 * ── And it is safe to run twice ────────────────────────────────────────────
 *
 * `postItems` conflicts on `(bill_id, source_module, source_ref_id)` and skips,
 * and the reconciliation below is an `UPDATE ... FROM` keyed on the same pair.
 * So a run that posts the lines and then fails before marking the intents
 * leaves the intents pending — and the next run finds the lines already there,
 * skips them, and marks the intents. Self-healing rather than idempotent by
 * bookkeeping, which is the only kind that survives a crash.
 */
@Injectable()
export class ChargesService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(BillingService) private readonly billing: BillingService,
  ) {}

  private hospitalId(): string {
    const id = getContext().hospitalId;
    if (id === null) throw AppError.unauthenticated();
    return id;
  }

  private actorId(): string {
    const id = getContext().userId;
    if (id === null) throw AppError.unauthenticated();
    return id;
  }

  /** What has been done and not yet billed. The biller's worklist. */
  async listPending(query: PendingQuery): Promise<readonly ChargeIntentRow[]> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM billing.charge_intents c
          WHERE c.hospital_id = $1
            AND ($2::uuid IS NULL OR c.patient_id = $2::uuid)
            AND ($3::uuid IS NULL OR c.visit_id = $3::uuid)
            AND ($4::uuid IS NULL OR c.admission_id = $4::uuid)
            AND ($5::text IS NULL OR c.source_module = $5::text)
            AND ($6::boolean IS NOT TRUE OR c.status = 'pending')
          ORDER BY c.created_at
          LIMIT $7`,
        [
          this.hospitalId(),
          query.patientId ?? null,
          query.visitId ?? null,
          query.admissionId ?? null,
          query.sourceModule ?? null,
          query.unbilledOnly,
          query.limit,
        ],
      );
      return rows.map((r) => this.toRow(r));
    });
  }

  /**
   * Posts pending intents onto a bill.
   *
   * An intent naming no service is left alone rather than posted at a price of
   * nothing: RC-003 cannot price what it cannot name, and a zero-rupee line on
   * a patient's bill is worse than a line that is not there yet, because it
   * reads as "free" rather than "not yet worked out".
   */
  async post(billId: string, body: PostChargesRequest): Promise<PostChargesResult> {
    const intents = await this.db.withTenant(currentTenantContext(), async (tx) => {
      const bill = await this.loadBill(tx, billId);
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM billing.charge_intents c
          WHERE c.hospital_id = $1
            AND c.status = 'pending'
            AND c.patient_id = $2
            AND ($3::uuid[] = '{}'::uuid[] OR c.id = ANY($3::uuid[]))
          ORDER BY c.created_at
          FOR UPDATE`,
        [this.hospitalId(), asText(bill['patient_id']), body.intentIds],
      );
      return rows;
    });

    const priceable = intents.filter((r) => asTextOrNull(r['service_key']) !== null);
    const unpriceable = intents.length - priceable.length;

    if (priceable.length === 0) {
      return { posted: 0, skipped: 0, unpriced: 0, unpriceable, billId };
    }

    // Through the billing service, so every line is priced, taxed and made
    // idempotent by the code that already does all three.
    const result = await this.billing.postItems(billId, {
      items: priceable.map((r) => ({
        itemType: body.itemType,
        description: asText(r['description']),
        qty: Number(asText(r['qty'])),
        serviceId: asText(r['service_key']),
        sourceModule: asText(r['source_module']),
        sourceRefId: asText(r['source_id']),
        // ISO, not `String(date)`. `pg` returns a JS Date here, and
        // `postItems` takes the first ten characters as the day it prices
        // against — so the default `Date` formatting would hand RC-003
        // "Mon Sep 0" and the tariff lookup would fail on a date it could not
        // parse.
        performedAt: new Date(asText(r['created_at'])).toISOString(),
      })),
    });

    const marked = await this.db.withTenant(currentTenantContext(), async (tx) => {
      // Keyed on the pair the bill line carries, so this is the same statement
      // whether it runs after a fresh post or after a retry that skipped them.
      const { rows } = await tx.query<{ readonly id: string }>(
        `UPDATE billing.charge_intents c
            SET status = 'posted', bill_id = $2, bill_line_id = i.id, posted_at = now(),
                unit_price = i.unit_price, amount = i.gross,
                updated_at = now(), updated_by = $3
           FROM billing.bill_items i
          WHERE i.bill_id = $2
            AND i.source_module = c.source_module
            AND i.source_ref_id = c.source_id
            AND c.hospital_id = $1
            AND c.status = 'pending'
            AND c.id = ANY($4::uuid[])
        RETURNING c.id`,
        [this.hospitalId(), billId, this.actorId(), priceable.map((r) => asText(r['id']))],
      );

      for (const row of rows) {
        await this.audit.write(tx, {
          action: 'insert',
          entity: 'charge_intent',
          rowId: row.id,
          businessKey: billId,
          dataClass: 'financial',
          patientId: null,
          encounterId: null,
          reasonText: null,
          before: { status: 'pending' },
          after: { status: 'posted', billId },
        });
      }
      return rows.length;
    });

    return {
      posted: marked,
      skipped: result.posted + result.skipped - marked,
      unpriced: result.unpriced,
      unpriceable,
      billId,
    };
  }

  /**
   * Reverses a charge that has reached a bill.
   *
   * The database refuses to *cancel* one — a billed line is reversed with a
   * reason, and the pair is what a credit note is made of. This records the
   * reversal on the intent; the credit note itself is OP-005's.
   */
  async reverse(id: string, body: ReverseChargeRequest): Promise<ChargeIntentRow> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE billing.charge_intents
            SET status = 'reversed', reversed_at = now(), reversal_reason = $3,
                updated_at = now(), updated_by = $4
          WHERE id = $1 AND hospital_id = $2 AND status = 'posted'
          RETURNING *`,
        [id, this.hospitalId(), body.reason, this.actorId()],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict(
          'Only a charge that has reached a bill is reversed. A pending one is cancelled by the module that raised it.',
        );
      }

      await this.audit.write(tx, {
        action: 'update',
        entity: 'charge_intent',
        rowId: id,
        businessKey: asText(row['bill_id']),
        dataClass: 'financial',
        patientId: asText(row['patient_id']),
        encounterId: null,
        reasonText: body.reason,
        before: { status: 'posted' },
        after: { status: 'reversed' },
      });

      return this.toRow(row);
    });
  }

  private async loadBill(tx: TransactionClient, billId: string): Promise<Record<string, unknown>> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM billing.bills WHERE id = $1 AND hospital_id = $2`,
      [billId, this.hospitalId()],
    );
    const bill = rows[0];
    if (bill === undefined) throw AppError.notFound('That bill was not found.');
    return bill;
  }

  private toRow(r: Record<string, unknown>): ChargeIntentRow {
    return {
      id: asText(r['id']),
      patientId: asText(r['patient_id']),
      visitId: asTextOrNull(r['visit_id']),
      encounterId: asTextOrNull(r['encounter_id']),
      admissionId: asTextOrNull(r['admission_id']),
      sourceModule: asText(r['source_module']),
      sourceTable: asText(r['source_table']),
      sourceId: asText(r['source_id']),
      serviceKey: asTextOrNull(r['service_key']),
      description: asText(r['description']),
      qty: asText(r['qty']),
      currency: asText(r['currency']),
      status: asText(r['status']),
      billId: asTextOrNull(r['bill_id']),
      billLineId: asTextOrNull(r['bill_line_id']),
      postedAt: asTextOrNull(r['posted_at']),
      reversedAt: asTextOrNull(r['reversed_at']),
      reversalReason: asTextOrNull(r['reversal_reason']),
      createdAt: asText(r['created_at']),
      // RC-003 prices a service; an intent that names none is a biller's
      // question, not a posting.
      unpriceable: asTextOrNull(r['service_key']) === null,
    };
  }
}
