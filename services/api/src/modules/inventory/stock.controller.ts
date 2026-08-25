import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { Idempotent } from '../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../core/policy/permission.decorator.js';
import { ZodBody } from '../../core/validation/zod.pipe.js';
import {
  batchesQuerySchema,
  expiryQuerySchema,
  idSchema,
  ledgerQuerySchema,
  putawaySchema,
  quarantineSchema,
  releaseQuarantineSchema,
  stockQuerySchema,
  type BatchesQuery,
  type ExpiryQuery,
  type LedgerQuery,
  type PutawayRequest,
  type QuarantineRequest,
  type ReleaseQuarantineRequest,
  type StockQuery,
} from './inventory.schemas.js';
import type { FefoBatchView, IntegrityRow, LedgerEntryView, StockBalanceView } from './inventory.types.js';
import { StockService } from './stock.service.js';

/**
 * `/api/v1/inventory` — the stock reads, the batch holds and the integrity
 * check.
 *
 * Everything under this controller that *writes* writes a hold or a bin move.
 * There is no route here that changes a quantity: quantities change through a
 * document — an issue, a transfer, an adjustment, a dispense — and every one of
 * those goes through `StockLedgerService`. A route that let a balance be set
 * directly would be the second writer of `stock_balances`, and the invariant the
 * whole phase rests on would stop being an invariant.
 */
@Controller('inventory')
export class InventoryStockController {
  constructor(@Inject(StockService) private readonly stock: StockService) {}

  @Permission('inventory.stock.list')
  @Get('stock')
  async balances(@Query(new ZodBody(stockQuerySchema)) query: StockQuery): Promise<Page<StockBalanceView>> {
    return this.stock.balances(query);
  }

  @Permission('inventory.stock.read')
  @Get('stock/:itemId/availability')
  async availability(@Param('itemId', new ZodBody(idSchema)) itemId: string): Promise<{
    readonly items: readonly {
      readonly storeId: string;
      readonly storeCode: string;
      readonly storeName: string;
      readonly qtyAvailable: string;
      readonly batchCount: number;
      readonly earliestExpiry: string | null;
    }[];
  }> {
    return this.stock.availability(itemId);
  }

  /** FEFO order, from `inventory.fefo_batches`. */
  @Permission('inventory.batch.list')
  @Get('stock/:itemId/batches')
  async batches(
    @Param('itemId', new ZodBody(idSchema)) itemId: string,
    @Query(new ZodBody(batchesQuerySchema)) query: BatchesQuery,
  ): Promise<{ readonly items: readonly FefoBatchView[] }> {
    return this.stock.fefoBatches(query.storeId, itemId);
  }

  @Permission('inventory.ledger.list')
  @Get('ledger')
  async ledger(@Query(new ZodBody(ledgerQuerySchema)) query: LedgerQuery): Promise<Page<LedgerEntryView>> {
    return this.stock.ledgerEntries(query);
  }

  @Permission('inventory.expiry.read')
  @Get('expiry')
  async expiring(@Query(new ZodBody(expiryQuerySchema)) query: ExpiryQuery): Promise<Page<StockBalanceView>> {
    return this.stock.expiring(query);
  }

  /** Where a batch has been, and — for a recall — who received some of it. */
  @Permission('inventory.batch.trace')
  @Get('batches/:id/trace')
  async trace(@Param('id', new ZodBody(idSchema)) id: string): Promise<{
    readonly batch: {
      readonly id: string;
      readonly batchNo: string;
      readonly itemId: string;
      readonly itemCode: string;
      readonly expiryDate: string | null;
      readonly status: string;
    };
    readonly movements: readonly LedgerEntryView[];
    readonly patients: readonly {
      readonly patientId: string;
      readonly qtyBase: string;
      readonly lastAt: string;
    }[];
    readonly stores: readonly { readonly storeId: string; readonly qtyOnHand: string }[];
  }> {
    return this.stock.traceBatch(id);
  }

  @Permission('inventory.batch.quarantine')
  @Idempotent()
  @Post('batches/:id/quarantine')
  async quarantine(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(quarantineSchema)) body: QuarantineRequest,
  ): Promise<{ readonly quarantineId: string }> {
    return this.stock.quarantine(id, body);
  }

  @Permission('inventory.batch.release')
  @Idempotent()
  @Post('batches/:id/release')
  async release(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(releaseQuarantineSchema)) body: ReleaseQuarantineRequest,
  ): Promise<{ readonly ok: true }> {
    await this.stock.releaseQuarantine(id, body);
    return { ok: true };
  }

  @Permission('inventory.stock.putaway')
  @Idempotent()
  @Post('putaway')
  async putaway(@Body(new ZodBody(putawaySchema)) body: PutawayRequest): Promise<{ readonly moved: number }> {
    return this.stock.putaway(body);
  }

  /**
   * `phase-04` exit gate 6, on demand: `sum(ledger) = on_hand` for every
   * item/batch/store. An empty `rows` is the pass.
   */
  @Permission('inventory.report.read')
  @Get('integrity')
  async integrity(): Promise<{ readonly ok: boolean; readonly rows: readonly IntegrityRow[] }> {
    return this.stock.verifyIntegrity();
  }
}
