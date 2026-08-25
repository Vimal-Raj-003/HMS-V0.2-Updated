import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { Idempotent } from '../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../core/policy/permission.decorator.js';
import { ZodBody } from '../../core/validation/zod.pipe.js';
import { ConsignmentService } from './consignment.service.js';
import { ConsumptionService } from './consumption.service.js';
import {
  consignmentAgreementSchema,
  consignmentReceiptSchema,
  consignmentReconciliationSchema,
  consignmentReturnSchema,
  consignmentUsageQuerySchema,
  consignmentUsageSchema,
  consumptionQuerySchema,
  costCentreQuerySchema,
  costCentreSchema,
  idSchema,
  recordConsumptionSchema,
  reverseSchema,
  signReconciliationSchema,
  storeQuerySchema,
  type ConsignmentAgreementRequest,
  type ConsignmentReceiptRequest,
  type ConsignmentReconciliationRequest,
  type ConsignmentReturnRequest,
  type ConsignmentUsageQuery,
  type ConsignmentUsageRequest,
  type ConsumptionQuery,
  type CostCentreQuery,
  type CostCentreRequest,
  type RecordConsumptionRequest,
  type ReverseRequest,
  type SignReconciliationRequest,
  type StoreQuery,
} from './inventory.schemas.js';
import type { CostCentreView, DocumentView } from './inventory.types.js';
import { z } from 'zod';

const stockQuery = z.object({ storeId: z.string().uuid().optional() });
const periodQuery = z.object({ period: z.string().regex(/^\d{4}-\d{2}$/) });

/**
 * `/api/v1/inventory/consignment/*` — NC-007.
 *
 * `usages` is the route the OT scanner calls, and it is `@Idempotent()` for the
 * reason `phase-04` exit gate 7 implies: a retried scan that recorded a second
 * usage would raise a second replenishment order and bill the patient twice for
 * an implant they have one of.
 */
@Controller('inventory/consignment')
export class ConsignmentController {
  constructor(@Inject(ConsignmentService) private readonly consignment: ConsignmentService) {}

  @Permission('inventory.consignment.agreement.list')
  @Get('agreements')
  async listAgreements(@Query(new ZodBody(storeQuerySchema)) query: StoreQuery): Promise<Page<DocumentView>> {
    return this.consignment.listAgreements(query);
  }

  @Permission('inventory.consignment.agreement.read')
  @Get('agreements/:id')
  async agreement(@Param('id', new ZodBody(idSchema)) id: string): Promise<DocumentView> {
    return this.consignment.agreement(id);
  }

  @Permission('inventory.consignment.agreement.manage')
  @Idempotent()
  @Post('agreements')
  async createAgreement(
    @Body(new ZodBody(consignmentAgreementSchema)) body: ConsignmentAgreementRequest,
  ): Promise<DocumentView> {
    return this.consignment.createAgreement(body);
  }

  @Permission('inventory.consignment.agreement.approve')
  @Idempotent()
  @Post('agreements/:id/approve')
  async approveAgreement(@Param('id', new ZodBody(idSchema)) id: string): Promise<DocumentView> {
    return this.consignment.approveAgreement(id);
  }

  @Permission('inventory.consignment.receive')
  @Idempotent()
  @Post('receipts')
  async receive(
    @Body(new ZodBody(consignmentReceiptSchema)) body: ConsignmentReceiptRequest,
  ): Promise<DocumentView> {
    return this.consignment.receive(body);
  }

  /** Stock on our shelves that is not ours. */
  @Permission('inventory.consignment.stock.read')
  @Get('stock')
  async stock(@Query(new ZodBody(stockQuery)) query: z.infer<typeof stockQuery>): Promise<{
    readonly items: readonly {
      readonly storeId: string;
      readonly itemId: string;
      readonly itemCode: string;
      readonly batchId: string | null;
      readonly batchNo: string | null;
      readonly expiryDate: string | null;
      readonly qtyOnHand: string;
      readonly vendorId: string | null;
      readonly value: string;
    }[];
  }> {
    return this.consignment.stock(query.storeId);
  }

  /** The scan at the table: ledger, usage, traceability and the auto-PO, atomically. */
  @Permission('inventory.consignment.use')
  @Idempotent()
  @Post('usages')
  async recordUsage(
    @Body(new ZodBody(consignmentUsageSchema)) body: ConsignmentUsageRequest,
  ): Promise<DocumentView> {
    return this.consignment.recordUsage(body);
  }

  @Permission('inventory.consignment.usage.list')
  @Get('usages')
  async listUsages(
    @Query(new ZodBody(consignmentUsageQuerySchema)) query: ConsignmentUsageQuery,
  ): Promise<Page<DocumentView>> {
    return this.consignment.listUsages(query);
  }

  @Permission('inventory.consignment.usage.read')
  @Get('usages/:id')
  async usage(@Param('id', new ZodBody(idSchema)) id: string): Promise<DocumentView> {
    return this.consignment.usage(id);
  }

  @Permission('inventory.consignment.approve')
  @Idempotent()
  @Post('usages/:id/reverse')
  async reverseUsage(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(reverseSchema)) body: ReverseRequest,
  ): Promise<DocumentView> {
    return this.consignment.reverseUsage(id, body);
  }

  @Permission('inventory.consignment.return.manage')
  @Idempotent()
  @Post('returns')
  async createReturn(
    @Body(new ZodBody(consignmentReturnSchema)) body: ConsignmentReturnRequest,
  ): Promise<DocumentView> {
    return this.consignment.createReturn(body);
  }

  @Permission('inventory.consignment.reconcile')
  @Idempotent()
  @Post('reconciliations')
  async reconcile(
    @Body(new ZodBody(consignmentReconciliationSchema)) body: ConsignmentReconciliationRequest,
  ): Promise<DocumentView> {
    return this.consignment.reconcile(body);
  }

  @Permission('inventory.consignment.report.read')
  @Get('reconciliations/:id')
  async reconciliation(@Param('id', new ZodBody(idSchema)) id: string): Promise<DocumentView> {
    return this.consignment.reconciliation(id);
  }

  @Permission('inventory.consignment.sign')
  @Idempotent()
  @Post('reconciliations/:id/sign')
  async sign(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(signReconciliationSchema)) body: SignReconciliationRequest,
  ): Promise<DocumentView> {
    return this.consignment.signReconciliation(id, body);
  }
}

/** `/api/v1/inventory/consumption` and `/api/v1/finance/cost-centres` — NC-008. */
@Controller('inventory/consumption')
export class ConsumptionController {
  constructor(@Inject(ConsumptionService) private readonly consumption: ConsumptionService) {}

  @Permission('inventory.consumption.record')
  @Idempotent()
  @Post()
  async record(
    @Body(new ZodBody(recordConsumptionSchema)) body: RecordConsumptionRequest,
  ): Promise<DocumentView> {
    return this.consumption.record(body);
  }

  @Permission('inventory.consumption.list')
  @Get()
  async list(
    @Query(new ZodBody(consumptionQuerySchema)) query: ConsumptionQuery,
  ): Promise<Page<DocumentView>> {
    return this.consumption.list(query);
  }

  @Permission('inventory.consumption.read')
  @Get(':id')
  async get(@Param('id', new ZodBody(idSchema)) id: string): Promise<DocumentView> {
    return this.consumption.get(id);
  }

  /** Reversed, never edited (NC-008 §5) — and the ledger half is a correction. */
  @Permission('inventory.consumption.reverse')
  @Idempotent()
  @Post(':id/reverse')
  async reverse(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(reverseSchema)) body: ReverseRequest,
  ): Promise<DocumentView> {
    return this.consumption.reverse(id, body);
  }
}

@Controller('finance/cost-centres')
export class CostCentresController {
  constructor(@Inject(ConsumptionService) private readonly consumption: ConsumptionService) {}

  @Permission('finance.costcentre.read')
  @Get()
  async list(
    @Query(new ZodBody(costCentreQuerySchema)) query: CostCentreQuery,
  ): Promise<Page<CostCentreView>> {
    return this.consumption.listCostCentres(query);
  }

  @Permission('finance.costcentre.read')
  @Get('consumption')
  async byCostCentre(@Query(new ZodBody(periodQuery)) query: z.infer<typeof periodQuery>): Promise<{
    readonly items: readonly {
      readonly costCentreId: string | null;
      readonly code: string | null;
      readonly name: string | null;
      readonly entries: number;
      readonly value: string;
    }[];
  }> {
    return this.consumption.byCostCentre(query.period);
  }

  @Permission('finance.costcentre.manage')
  @Idempotent()
  @Post()
  async create(@Body(new ZodBody(costCentreSchema)) body: CostCentreRequest): Promise<CostCentreView> {
    return this.consumption.createCostCentre(body);
  }
}
