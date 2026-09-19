import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { CorporateService } from './corporate.service.js';
import {
  ageingQuerySchema,
  cancelInvoiceSchema,
  raiseInvoiceSchema,
  recordFollowupSchema,
  setHoldSchema,
  upsertAccountSchema,
  writeOffSchema,
  type AgeingQuery,
  type AgeingRow,
  type CancelInvoiceRequest,
  type CorporateAccountRow,
  type FollowupRow,
  type InvoiceRow,
  type RaiseInvoiceRequest,
  type RecordFollowupRequest,
  type SetHoldRequest,
  type UpsertAccountRequest,
  type WriteOffRequest,
} from './corporate.schemas.js';

/**
 * `/api/v1/finance/corporate/*` — NC-012 and RC-005.
 *
 * ── No route sets an invoice's amount ──────────────────────────────────────
 *
 * `POST /invoices` takes bill ids and reads the money out of the bills. A
 * field for the amount would let an invoice disagree with the bills it names,
 * and the client who reconciles the two would be right and the hospital wrong.
 *
 * ── And none pays one ──────────────────────────────────────────────────────
 *
 * Settlement arrives through the cash and banking routes, which is where a
 * receipt exists and a shift is open. A "mark as paid" button here would be a
 * way to clear a receivable without any money.
 */
@Controller('finance/corporate')
export class CorporateController {
  constructor(@Inject(CorporateService) private readonly svc: CorporateService) {}

  @Permission('finance.corporate.read')
  @Get('accounts')
  async listAccounts(): Promise<readonly CorporateAccountRow[]> {
    return this.svc.listAccounts();
  }

  @Permission('finance.corporate.account.manage')
  @Post('accounts')
  async upsertAccount(
    @Body(new ZodBody(upsertAccountSchema)) body: UpsertAccountRequest,
  ): Promise<CorporateAccountRow> {
    return this.svc.upsertAccount(body);
  }

  /** A hold stops new invoices. It never reaches anything clinical. */
  @Permission('finance.corporate.account.manage')
  @Patch('accounts/:id/hold')
  async setHold(
    @Param('id') id: string,
    @Body(new ZodBody(setHoldSchema)) body: SetHoldRequest,
  ): Promise<CorporateAccountRow> {
    return this.svc.setHold(id, body);
  }

  @Permission('finance.corporate.read')
  @Get('invoices')
  async listInvoices(@Query('accountId') accountId?: string): Promise<readonly InvoiceRow[]> {
    return this.svc.listInvoices(accountId);
  }

  /** Idempotent: a retried consolidation must not invoice a company twice. */
  @Permission('finance.corporate.invoice.raise')
  @Idempotent()
  @Post('invoices')
  async raiseInvoice(@Body(new ZodBody(raiseInvoiceSchema)) body: RaiseInvoiceRequest): Promise<InvoiceRow> {
    return this.svc.raiseInvoice(body);
  }

  @Permission('finance.corporate.invoice.cancel')
  @Post('invoices/:id/cancel')
  async cancelInvoice(
    @Param('id') id: string,
    @Body(new ZodBody(cancelInvoiceSchema)) body: CancelInvoiceRequest,
  ): Promise<InvoiceRow> {
    return this.svc.cancelInvoice(id, body);
  }

  /** The worklist, worst first — by how overdue, not by how large. */
  @Permission('finance.corporate.read')
  @Get('ageing')
  async ageing(@Query(new ZodBody(ageingQuerySchema)) query: AgeingQuery): Promise<readonly AgeingRow[]> {
    return this.svc.ageing(query);
  }

  @Permission('finance.corporate.read')
  @Get('invoices/:id/followups')
  async listFollowups(@Param('id') id: string): Promise<readonly FollowupRow[]> {
    return this.svc.listFollowups(id);
  }

  @Permission('finance.ar.followup.record')
  @Post('invoices/:id/followups')
  async recordFollowup(
    @Param('id') id: string,
    @Body(new ZodBody(recordFollowupSchema)) body: RecordFollowupRequest,
  ): Promise<FollowupRow> {
    return this.svc.recordFollowup(id, body);
  }

  /**
   * The approver is the authenticated caller; `requestedBy` is in the body.
   * The database refuses the case where they are the same person, which is the
   * whole point of the table.
   */
  @Permission('finance.ar.writeoff.approve')
  @Idempotent()
  @Post('invoices/:id/write-off')
  async writeOff(
    @Param('id') id: string,
    @Body(new ZodBody(writeOffSchema)) body: WriteOffRequest,
  ): Promise<InvoiceRow> {
    return this.svc.writeOff(id, body);
  }
}
