import { Inject, Injectable } from '@nestjs/common';
import { newId, type Page } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService, type TransactionClient } from '../../../core/db/database.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import { paymentEvent } from './payments.events.js';
import type {
  ApproveRefundRequest,
  CancelIntentRequest,
  CreateIntentRequest,
  IntentQuery,
  ReconQuery,
  RequestRefundRequest,
  ResolveReconRequest,
  WebhookRequest,
} from './payments.schemas.js';
import type {
  PayIntentView,
  PayPaymentView,
  PayReconExceptionView,
  PayRefundView,
  WebhookOutcome,
} from './payments.types.js';

function asText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString();
  return '';
}
function asTextOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : asText(v);
}

/**
 * EN-010 — the payment gateway.
 *
 * ── The webhook is the only thing that means money arrived ──────────────────
 *
 * OP-005 §5: "Payment confirmation only on gateway webhook/POS response (never
 * on client claim)." A browser saying it paid is a claim. So `createIntent`
 * writes what we *asked for* and returns a QR or a link; nothing is credited
 * until `handleWebhook` receives a signed delivery saying it happened.
 *
 * ── A redelivery is a success, not an error ─────────────────────────────────
 *
 * Providers retry — Razorpay for 24 hours — and a redelivery during a deploy is
 * routine. The `event_id` unique index catches it, and this returns
 * `outcome: 'duplicate'` with **HTTP 200**. Returning a 4xx would make the
 * provider retry the delivery we have already handled, forever. `phase-05` exit
 * gate 3 is exactly this: "a webhook replay does not double-credit".
 *
 * ── An unverified webhook is stored, never processed ────────────────────────
 *
 * A forged delivery is evidence of an attempt on the payment path. It is written
 * with `signature_ok = false`, raises `pay.webhook.rejected`, and is never acted
 * on. Discarding it would destroy the only record that somebody tried.
 *
 * ── Money that matches nothing is `unapplied`, not lost ─────────────────────
 *
 * A payment against an intent nobody can find still happened. It becomes a
 * reconciliation exception rather than an error the caller swallows, because the
 * patient's money is in the hospital's account either way.
 */
@Injectable()
export class PaymentsService {
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

  // ═══════════════════════════════════════════════════════════════════════════
  // Intents
  // ═══════════════════════════════════════════════════════════════════════════

  async listIntents(query: IntentQuery): Promise<Page<PayIntentView>> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM billing.pay_intents
          WHERE hospital_id = $1
            AND ($2::uuid IS NULL OR ref_id = $2)
            AND ($3::text IS NULL OR status::text = $3)
          ORDER BY created_at DESC LIMIT $4`,
        [this.hospitalId(), query.refId ?? null, query.status ?? null, query.limit + 1],
      );
      const page = rows.slice(0, query.limit);
      return {
        items: page.map((r) => this.toIntent(r)),
        nextCursor: null,
        hasMore: rows.length > query.limit,
      };
    });
  }

  private toIntent(r: Record<string, unknown>): PayIntentView {
    return {
      id: asText(r['id']),
      kind: asText(r['kind']),
      refType: asText(r['ref_type']),
      refId: asText(r['ref_id']),
      amount: asText(r['amount']),
      currency: asText(r['currency']),
      methodHint: asText(r['method_hint']),
      status: asText(r['status']),
      qrImageUrl: asTextOrNull(r['qr_image_url']),
      linkUrl: asTextOrNull(r['link_url']),
      expiresAt: asTextOrNull(r['expires_at']),
      createdAt: asText(r['created_at']),
    };
  }

  /**
   * Ask the gateway for a way to pay.
   *
   * The provider call itself belongs behind `packages/payments`' adapter
   * interface (EN-010 §4.1) and is not made here — this records the intent and
   * returns it. Wiring a live Razorpay client needs credentials the hospital has
   * not supplied (docs/08 names them as an open question), and a service that
   * invented a fake order id would be indistinguishable from a working one until
   * the first real payment failed.
   */
  async createIntent(body: CreateIntentRequest): Promise<PayIntentView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const hospital = this.hospitalId();
      const branch = this.branchId();

      const { rows: accounts } = await tx.query<{ id: string }>(
        `SELECT id FROM billing.pay_gateway_accounts
          WHERE hospital_id = $1 AND active = true
            AND (branch_id IS NULL OR branch_id = $2)
          ORDER BY (branch_id IS NULL) LIMIT 1`,
        [hospital, branch],
      );
      const account = accounts[0];
      if (account === undefined) {
        throw AppError.conflict(
          'No active payment gateway is configured for this branch. Configure one before taking online payments.',
        );
      }

      const id = newId();
      const expiresAt = new Date(Date.now() + body.expiresInMinutes * 60_000).toISOString();

      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO billing.pay_intents
           (id, hospital_id, branch_id, gateway_account_id, kind, ref_type, ref_id,
            patient_id, amount, currency, method_hint, status, terminal_id, expires_at,
            created_at, created_by, updated_at, updated_by)
         VALUES ($1,$2,$3,$4,$5::"billing"."PayIntentKind",$6,$7,
                 $8,$9,$10,$11,'created',$12,$13::timestamptz, now(),$14, now(),$14)
         RETURNING *`,
        [
          id,
          hospital,
          branch,
          account.id,
          body.kind,
          body.refType,
          body.refId,
          body.patientId ?? null,
          body.amount.toFixed(2),
          body.currency,
          body.methodHint,
          body.terminalId ?? null,
          expiresAt,
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The payment intent could not be created.');

      await this.outbox.publish(
        tx,
        paymentEvent('pay.intent.created', id, {
          intentId: id,
          refType: body.refType,
          refId: body.refId,
          amount: body.amount.toFixed(2),
          kind: body.kind,
          methodHint: body.methodHint,
        }),
      );
      return this.toIntent(row);
    });
  }

  async cancelIntent(id: string, body: CancelIntentRequest): Promise<PayIntentView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE billing.pay_intents
            SET status = 'cancelled', updated_at = now(), updated_by = $3
          WHERE id = $1 AND hospital_id = $2 AND status IN ('created','pending')
          RETURNING *`,
        [id, this.hospitalId(), this.actorId()],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict('Only an unpaid intent can be cancelled.');
      }
      await this.audit.write(tx, {
        action: 'update',
        entity: 'billing.pay_intents',
        rowId: id,
        businessKey: id,
        dataClass: 'financial',
        reasonText: body.reason,
        before: { status: 'created' },
        after: { status: 'cancelled' },
      });
      return this.toIntent(row);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The webhook — exit gate 3
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Handle one provider delivery.
   *
   * Always returns 200-shaped outcomes. A provider that receives a 4xx retries,
   * so the only thing a non-2xx achieves for a duplicate is a permanent retry
   * loop against an event already handled.
   */
  async handleWebhook(body: WebhookRequest, signatureOk: boolean): Promise<WebhookOutcome> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const hospital = this.hospitalId();
      const receivedAt = new Date().toISOString();

      // Written first, whatever else happens. An unverified delivery is evidence.
      const { rows: logged } = await tx.query<{ id: string }>(
        `INSERT INTO billing.pay_webhook_events
           (id, hospital_id, provider, event_id, type, payload, signature_ok, received_at, status)
         VALUES ($1,$2,$3::"billing"."PayProvider",$4,$5,$6::jsonb,$7,$8::timestamptz,'received')
         ON CONFLICT (hospital_id, provider, event_id, received_at) DO NOTHING
         RETURNING id`,
        [
          newId(),
          hospital,
          body.provider,
          body.eventId,
          body.type,
          JSON.stringify(body.payload),
          signatureOk,
          receivedAt,
        ],
      );

      // The unique index caught a redelivery of an event already stored at this
      // instant. Belt: the explicit lookup below catches one redelivered later,
      // which is the common case.
      const { rows: seen } = await tx.query<{ n: string }>(
        `SELECT count(*) AS n FROM billing.pay_webhook_events
          WHERE hospital_id = $1 AND provider = $2::"billing"."PayProvider" AND event_id = $3`,
        [hospital, body.provider, body.eventId],
      );
      if (Number(seen[0]?.n ?? 0) > 1 || logged[0] === undefined) {
        return {
          outcome: 'duplicate',
          detail:
            'This event was already received and handled. Nothing was credited a second time (phase-05 exit gate 3).',
        };
      }

      if (!signatureOk) {
        await tx.query(
          `UPDATE billing.pay_webhook_events SET status = 'ignored', processed_at = now(),
                  error = 'signature verification failed'
            WHERE hospital_id = $1 AND provider = $2::"billing"."PayProvider" AND event_id = $3`,
          [hospital, body.provider, body.eventId],
        );
        await this.outbox.publish(
          tx,
          paymentEvent('pay.webhook.rejected', body.eventId, {
            provider: body.provider,
            eventId: body.eventId,
            type: body.type,
            receivedAt,
          }),
        );
        return {
          outcome: 'rejected',
          detail: 'Signature verification failed. The delivery is stored as evidence and was not acted on.',
        };
      }

      if (body.type !== 'payment.captured' && body.type !== 'payment.failed') {
        await this.markProcessed(tx, hospital, body, 'ignored');
        return { outcome: 'ignored', detail: `Nothing to do for event type "${body.type}".` };
      }

      const { rows: intents } = await tx.query<{ id: string; amount: string }>(
        `SELECT id, amount FROM billing.pay_intents
          WHERE hospital_id = $1 AND provider_order_id = $2`,
        [hospital, body.providerOrderId ?? ''],
      );
      const intent = intents[0];

      if (intent === undefined) {
        // The money is real even though we cannot match it. Never dropped.
        const exceptionId = newId();
        await tx.query(
          `INSERT INTO billing.pay_recon_exceptions
             (id, hospital_id, exception_type, refs, amount, status, notes, created_at, updated_at)
           VALUES ($1,$2,'unapplied',$3::jsonb,$4,'open',$5, now(), now())`,
          [
            exceptionId,
            hospital,
            JSON.stringify({ providerOrderId: body.providerOrderId, eventId: body.eventId }),
            body.amount?.toFixed(2) ?? null,
            'A captured payment matched no intent. The money arrived; the reference did not.',
          ],
        );
        await this.outbox.publish(
          tx,
          paymentEvent('pay.recon.exception', exceptionId, {
            exceptionId,
            exceptionType: 'unapplied',
            amount: body.amount?.toFixed(2) ?? null,
            refs: { providerOrderId: body.providerOrderId ?? null, eventId: body.eventId },
          }),
        );
        await this.markProcessed(tx, hospital, body, 'processed');
        return {
          outcome: 'processed',
          detail: 'The payment matched no intent and was queued as an unapplied reconciliation exception.',
        };
      }

      const paymentId = newId();
      const captured = body.type === 'payment.captured';

      await tx.query(
        `INSERT INTO billing.pay_payments
           (id, hospital_id, intent_id, provider_payment_id, method, amount, fee,
            status, captured_at, rrn, utr, error_code, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5::"billing"."PayMethod",$6,$7,
                 $8::"billing"."PayPaymentStatus",$9,$10,$11,$12, now(), now())
         ON CONFLICT (provider_payment_id) DO NOTHING`,
        [
          paymentId,
          hospital,
          intent.id,
          body.providerPaymentId ?? body.eventId,
          body.method ?? 'upi',
          (body.amount ?? Number(intent.amount)).toFixed(2),
          (body.fee ?? 0).toFixed(2),
          captured ? 'captured' : 'failed',
          captured ? new Date().toISOString() : null,
          body.rrn ?? null,
          body.utr ?? null,
          body.errorCode ?? null,
        ],
      );

      await tx.query(
        `UPDATE billing.pay_intents SET status = $2::"billing"."PayIntentStatus", updated_at = now()
          WHERE id = $1`,
        [intent.id, captured ? 'paid' : 'failed'],
      );

      await this.outbox.publish(
        tx,
        captured
          ? paymentEvent('pay.payment.captured', paymentId, {
              paymentId,
              intentId: intent.id,
              providerPaymentId: body.providerPaymentId ?? body.eventId,
              method: body.method ?? 'upi',
              amount: (body.amount ?? Number(intent.amount)).toFixed(2),
              fee: (body.fee ?? 0).toFixed(2),
              capturedAt: new Date().toISOString(),
            })
          : paymentEvent('pay.payment.failed', paymentId, {
              paymentId,
              intentId: intent.id,
              errorCode: body.errorCode ?? null,
            }),
      );

      await this.markProcessed(tx, hospital, body, 'processed');
      return {
        outcome: 'processed',
        detail: captured ? 'Payment captured and credited once.' : 'Payment failure recorded.',
      };
    });
  }

  private async markProcessed(
    tx: TransactionClient,
    hospital: string,
    body: WebhookRequest,
    status: 'processed' | 'ignored',
  ): Promise<void> {
    await tx.query(
      `UPDATE billing.pay_webhook_events
          SET status = $4::"billing"."PayWebhookStatus", processed_at = now()
        WHERE hospital_id = $1 AND provider = $2::"billing"."PayProvider" AND event_id = $3`,
      [hospital, body.provider, body.eventId, status],
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Refunds — maker and checker
  // ═══════════════════════════════════════════════════════════════════════════

  async requestRefund(paymentId: string, body: RequestRefundRequest): Promise<PayRefundView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const id = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO billing.pay_refunds
           (id, hospital_id, payment_id, amount, reason_code, requested_by, status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,'requested', now(), now())
         RETURNING *`,
        [id, this.hospitalId(), paymentId, body.amount.toFixed(2), body.reasonCode, this.actorId()],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The refund could not be raised.');

      await this.outbox.publish(
        tx,
        paymentEvent('pay.refund.requested', id, {
          refundId: id,
          paymentId,
          amount: body.amount.toFixed(2),
          reasonCode: body.reasonCode,
          requestedBy: this.actorId(),
        }),
      );
      return this.toRefund(row);
    });
  }

  /**
   * Approve. The database refuses a refund exceeding its payment, and the
   * catalogue refuses one person holding both halves — a refund goes back
   * through the instrument it came from, so originating and releasing one
   * unilaterally is the largest fraud exposure in the payment path.
   */
  async approveRefund(id: string, body: ApproveRefundRequest): Promise<PayRefundView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE billing.pay_refunds
            SET status = 'approved', approved_by = $3, updated_at = now()
          WHERE id = $1 AND hospital_id = $2 AND status = 'requested'
            AND requested_by <> $3
          RETURNING *`,
        [id, this.hospitalId(), this.actorId()],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict(
          'Only a pending refund can be approved, and never by the person who asked for it.',
        );
      }
      await this.audit.write(tx, {
        action: 'update',
        entity: 'billing.pay_refunds',
        rowId: id,
        businessKey: asText(row['reason_code']),
        dataClass: 'financial',
        reasonText: body.reason,
        before: { status: 'requested' },
        after: { status: 'approved' },
      });
      return this.toRefund(row);
    });
  }

  private toRefund(r: Record<string, unknown>): PayRefundView {
    return {
      id: asText(r['id']),
      paymentId: asText(r['payment_id']),
      amount: asText(r['amount']),
      reasonCode: asText(r['reason_code']),
      status: asText(r['status']),
      requestedBy: asText(r['requested_by']),
      approvedBy: asTextOrNull(r['approved_by']),
      processedAt: asTextOrNull(r['processed_at']),
    };
  }

  async listPayments(query: IntentQuery): Promise<Page<PayPaymentView>> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM billing.pay_payments WHERE hospital_id = $1
          ORDER BY created_at DESC LIMIT $2`,
        [this.hospitalId(), query.limit + 1],
      );
      const page = rows.slice(0, query.limit);
      return {
        items: page.map((r) => ({
          id: asText(r['id']),
          intentId: asText(r['intent_id']),
          providerPaymentId: asText(r['provider_payment_id']),
          method: asText(r['method']),
          amount: asText(r['amount']),
          fee: asText(r['fee']),
          status: asText(r['status']),
          capturedAt: asTextOrNull(r['captured_at']),
          rrn: asTextOrNull(r['rrn']),
          utr: asTextOrNull(r['utr']),
        })),
        nextCursor: null,
        hasMore: rows.length > query.limit,
      };
    });
  }

  async listReconExceptions(query: ReconQuery): Promise<Page<PayReconExceptionView>> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM billing.pay_recon_exceptions
          WHERE hospital_id = $1
            AND ($2::text IS NULL OR status = $2)
            AND ($3::text IS NULL OR exception_type::text = $3)
          ORDER BY created_at DESC LIMIT $4`,
        [this.hospitalId(), query.status ?? null, query.exceptionType ?? null, query.limit + 1],
      );
      const page = rows.slice(0, query.limit);
      return {
        items: page.map((r) => ({
          id: asText(r['id']),
          exceptionType: asText(r['exception_type']),
          amount: asTextOrNull(r['amount']),
          refs: (r['refs'] as Record<string, unknown> | null) ?? {},
          status: asText(r['status']),
          notes: asTextOrNull(r['notes']),
          createdAt: asText(r['created_at']),
        })),
        nextCursor: null,
        hasMore: rows.length > query.limit,
      };
    });
  }

  async resolveReconException(id: string, body: ResolveReconRequest): Promise<PayReconExceptionView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE billing.pay_recon_exceptions
            SET status = 'resolved', resolved_at = now(), resolved_by = $3, notes = $4, updated_at = now()
          WHERE id = $1 AND hospital_id = $2 AND status = 'open'
          RETURNING *`,
        [id, this.hospitalId(), this.actorId(), body.reason],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('Only an open exception can be resolved.');
      return {
        id: asText(row['id']),
        exceptionType: asText(row['exception_type']),
        amount: asTextOrNull(row['amount']),
        refs: (row['refs'] as Record<string, unknown> | null) ?? {},
        status: asText(row['status']),
        notes: asTextOrNull(row['notes']),
        createdAt: asText(row['created_at']),
      };
    });
  }
}
