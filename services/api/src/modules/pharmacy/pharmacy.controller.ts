import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { Idempotent } from '../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../core/policy/permission.decorator.js';
import { ZodBody } from '../../core/validation/zod.pipe.js';
import { DispenseService } from './dispense.service.js';
import { NarcoticsService } from './narcotics.service.js';
import { PharmacyOpsService } from './pharmacy-ops.service.js';
import {
  addDispenseItemSchema,
  approveSaleReturnSchema,
  arriveSchema,
  assignSchema,
  cancelDispenseSchema,
  closeRecallSchema,
  coldChainReadingSchema,
  completeDispenseSchema,
  createDispenseSchema,
  createSaleReturnSchema,
  custodyCheckSchema,
  dayCloseQuerySchema,
  dayCloseSchema,
  decideSubstitutionSchema,
  declineDispenseItemSchema,
  destructionSchema,
  dispenseQuerySchema,
  enqueueRxSchema,
  expiryActionSchema,
  expiryQuerySchema,
  holdSchema,
  idSchema,
  interventionSchema,
  labelSchema,
  queueQuerySchema,
  raiseRecallSchema,
  recallQuerySchema,
  registerEntrySchema,
  registerQuerySchema,
  requestSubstitutionSchema,
  secondAuthoriserSchema,
  stockQuerySchema,
  type AddDispenseItemRequest,
  type ApproveSaleReturnRequest,
  type ArriveRequest,
  type AssignRequest,
  type CancelDispenseRequest,
  type CloseRecallRequest,
  type ColdChainReadingRequest,
  type CompleteDispenseRequest,
  type CreateDispenseRequest,
  type CreateSaleReturnRequest,
  type CustodyCheckRequest,
  type DayCloseQuery,
  type DayCloseRequest,
  type DecideSubstitutionRequest,
  type DeclineDispenseItemRequest,
  type DestructionRequest,
  type DispenseQuery,
  type EnqueueRxRequest,
  type ExpiryActionRequest,
  type HoldRequest,
  type InterventionRequest,
  type LabelRequest,
  type PharmacyExpiryQuery,
  type PharmacyStockQuery,
  type QueueQuery,
  type RaiseRecallRequest,
  type RecallQuery,
  type RegisterEntryRequest,
  type RegisterQuery,
  type RequestSubstitutionRequest,
  type SecondAuthoriserRequest,
} from './pharmacy.schemas.js';
import type {
  CustodyCheckView,
  DayCloseView,
  DispenseView,
  ExpiryActionView,
  InterventionView,
  LabelView,
  RecallTraceView,
  RecallView,
  RegisterEntryView,
  RxQueueView,
  SaleReturnView,
  SubstitutionView,
} from './pharmacy.types.js';
import { RxQueueService } from './queue.service.js';

/** `/api/v1/pharmacy/queue` — OP-003 §3, the counter's worklist. */
@Controller('pharmacy/queue')
export class PharmacyQueueController {
  constructor(@Inject(RxQueueService) private readonly queue: RxQueueService) {}

  @Permission('pharmacy.queue.list')
  @Get()
  async list(@Query(new ZodBody(queueQuerySchema)) query: QueueQuery): Promise<Page<RxQueueView>> {
    return this.queue.list(query);
  }

  @Permission('pharmacy.queue.read')
  @Get(':id')
  async get(@Param('id', new ZodBody(idSchema)) id: string): Promise<RxQueueView> {
    return this.queue.get(id);
  }

  /**
   * Intake. Called by the `rx.created` relay consumer and by the front office
   * when a patient brings a paper copy to the counter; the uniqueness index on
   * `(prescription_id, pharmacy_store_id)` makes both paths idempotent against
   * each other, which is what a queue fed by an at-least-once relay needs.
   */
  @Permission('pharmacy.queue.manage')
  @Idempotent()
  @Post()
  async enqueue(@Body(new ZodBody(enqueueRxSchema)) body: EnqueueRxRequest): Promise<RxQueueView> {
    return this.queue.enqueue(body);
  }

  @Permission('pharmacy.queue.manage')
  @Idempotent()
  @Post(':id/arrive')
  async arrive(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(arriveSchema)) body: ArriveRequest,
  ): Promise<RxQueueView> {
    return this.queue.arrive(id, body);
  }

  @Permission('pharmacy.queue.manage')
  @Idempotent()
  @Post(':id/assign')
  async assign(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(assignSchema)) body: AssignRequest,
  ): Promise<RxQueueView> {
    return this.queue.assign(id, body);
  }

  @Permission('pharmacy.queue.manage')
  @Idempotent()
  @Post(':id/hold')
  async hold(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(holdSchema)) body: HoldRequest,
  ): Promise<RxQueueView> {
    return this.queue.hold(id, body);
  }
}

/**
 * `/api/v1/pharmacy/dispenses` — OP-003 §3.
 *
 * Every POST is `@Idempotent()`. A retried `complete` would dispense twice: the
 * patient gets one bag, the shelf loses two, and the retry is exactly what a
 * counter tablet does when the Wi-Fi drops between the till and the printer.
 * The status check refuses the second attempt anyway; the idempotency key is
 * what makes the *response* the same rather than an error the operator has to
 * interpret with a queue behind them.
 */
@Controller('pharmacy/dispenses')
export class PharmacyDispenseController {
  constructor(@Inject(DispenseService) private readonly dispense: DispenseService) {}

  @Permission('pharmacy.dispense.list')
  @Get()
  async list(@Query(new ZodBody(dispenseQuerySchema)) query: DispenseQuery): Promise<Page<DispenseView>> {
    return this.dispense.list(query);
  }

  @Permission('pharmacy.dispense.read')
  @Get(':id')
  async get(@Param('id', new ZodBody(idSchema)) id: string): Promise<DispenseView> {
    return this.dispense.get(id);
  }

  @Permission('pharmacy.dispense.create')
  @Idempotent()
  @Post()
  async create(@Body(new ZodBody(createDispenseSchema)) body: CreateDispenseRequest): Promise<DispenseView> {
    return this.dispense.create(body);
  }

  /**
   * The second pharmacist's signature for a controlled-drug dispense.
   *
   * Decorated `pharmacy.narcotic.prepare` — the single-signature precondition —
   * because `pharmacy.narcotic.dispense` is `requiresSecondPerson` and a route
   * carrying it would deny every user. The real key is asserted inside
   * `PharmacyCoSignService` with the co-signer attached.
   */
  @Permission('pharmacy.narcotic.prepare')
  @Idempotent()
  @Post(':id/second-authoriser')
  async secondAuthoriser(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(secondAuthoriserSchema)) body: SecondAuthoriserRequest,
  ): Promise<DispenseView> {
    return this.dispense.addSecondAuthoriser(id, body);
  }

  /** Scan → batch validation → line. Refused if the batch does not pass. */
  @Permission('pharmacy.dispense.create')
  @Idempotent()
  @Post(':id/items')
  async addItem(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(addDispenseItemSchema)) body: AddDispenseItemRequest,
  ): Promise<DispenseView> {
    return this.dispense.addItem(id, body);
  }

  @Permission('pharmacy.dispense.create')
  @Idempotent()
  @Post(':id/decline')
  async decline(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(declineDispenseItemSchema)) body: DeclineDispenseItemRequest,
  ): Promise<DispenseView> {
    return this.dispense.declineItem(id, body);
  }

  /** EN-029 on demand. Completion re-runs it regardless; this is not the gate. */
  @Permission('pharmacy.dispense.create')
  @Post(':id/cdss-check')
  async check(@Param('id', new ZodBody(idSchema)) id: string): Promise<DispenseView> {
    return this.dispense.check(id);
  }

  @Permission('pharmacy.substitution.request')
  @Idempotent()
  @Post(':id/substitutions')
  async requestSubstitution(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(requestSubstitutionSchema)) body: RequestSubstitutionRequest,
  ): Promise<SubstitutionView> {
    return this.dispense.requestSubstitution(id, body);
  }

  /** Stock moves here, once, and the safety net is re-run before it does. */
  @Permission('pharmacy.dispense.complete')
  @Idempotent()
  @Post(':id/complete')
  async complete(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(completeDispenseSchema)) body: CompleteDispenseRequest,
  ): Promise<DispenseView> {
    return this.dispense.complete(id, body);
  }

  @Permission('pharmacy.dispense.cancel')
  @Idempotent()
  @Post(':id/cancel')
  async cancel(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(cancelDispenseSchema)) body: CancelDispenseRequest,
  ): Promise<DispenseView> {
    return this.dispense.cancel(id, body);
  }

  @Permission('pharmacy.label.print')
  @Post(':id/labels')
  async labels(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(labelSchema)) body: LabelRequest,
  ): Promise<{ readonly labels: readonly LabelView[] }> {
    return this.dispense.labels(id, body);
  }
}

/** `/api/v1/pharmacy/substitutions/{id}/decide` — the prescriber's answer. */
@Controller('pharmacy/substitutions')
export class PharmacySubstitutionController {
  constructor(@Inject(DispenseService) private readonly dispense: DispenseService) {}

  @Permission('pharmacy.substitution.read')
  @Get(':id')
  async get(@Param('id', new ZodBody(idSchema)) id: string): Promise<SubstitutionView> {
    return this.dispense.substitution(id);
  }

  @Permission('rx.substitution.approve')
  @Idempotent()
  @Post(':id/decide')
  async decide(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(decideSubstitutionSchema)) body: DecideSubstitutionRequest,
  ): Promise<SubstitutionView> {
    return this.dispense.decideSubstitution(id, body);
  }
}

/**
 * `/api/v1/pharmacy/*` — the controlled-drug registers.
 *
 * Every route here is decorated `pharmacy.narcotic.prepare` and asserts its real
 * `requiresSecondPerson` key inside the service. `permission.decorator.ts`
 * throws at module load if one of those keys is used as a decorator, so this is
 * not a convention that can quietly rot.
 */
@Controller('pharmacy')
export class PharmacyNarcoticsController {
  constructor(@Inject(NarcoticsService) private readonly narcotics: NarcoticsService) {}

  @Permission('pharmacy.narcotic.list')
  @Get('controlled-register')
  async list(
    @Query(new ZodBody(registerQuerySchema)) query: RegisterQuery,
  ): Promise<Page<RegisterEntryView>> {
    return this.narcotics.list(query);
  }

  @Permission('pharmacy.narcotic.read')
  @Get('controlled-register/:id')
  async entry(@Param('id', new ZodBody(idSchema)) id: string): Promise<RegisterEntryView> {
    return this.narcotics.entry(id);
  }

  /** Asserts `pharmacy.narcotic.issue` inside, with the second pharmacist. */
  @Permission('pharmacy.narcotic.prepare')
  @Idempotent()
  @Post('controlled-register')
  async record(
    @Body(new ZodBody(registerEntrySchema)) body: RegisterEntryRequest,
  ): Promise<RegisterEntryView> {
    return this.narcotics.recordEntry(body);
  }

  /** Asserts `pharmacy.narcotic.custody` inside, with the second counter. */
  @Permission('pharmacy.narcotic.prepare')
  @Idempotent()
  @Post('custody-checks')
  async custodyCheck(
    @Body(new ZodBody(custodyCheckSchema)) body: CustodyCheckRequest,
  ): Promise<CustodyCheckView> {
    return this.narcotics.custodyCheck(body);
  }

  @Permission('pharmacy.narcotic.read')
  @Get('custody-checks/:id')
  async custody(@Param('id', new ZodBody(idSchema)) id: string): Promise<CustodyCheckView> {
    return this.narcotics.custody(id);
  }

  /**
   * Asserts `pharmacy.narcotic.destroy` inside. That key is also
   * `requiresReason`, so the request must carry an `x-reason` header as well as
   * a co-signer — the policy engine refuses it otherwise.
   */
  @Permission('pharmacy.narcotic.prepare')
  @Idempotent()
  @Post('controlled-destructions')
  async destroy(@Body(new ZodBody(destructionSchema)) body: DestructionRequest): Promise<RegisterEntryView> {
    return this.narcotics.destroy(body);
  }
}

/** `/api/v1/pharmacy/*` — returns, expiry, recall, cold chain and the day close. */
@Controller('pharmacy')
export class PharmacyOpsController {
  constructor(@Inject(PharmacyOpsService) private readonly ops: PharmacyOpsService) {}

  @Permission('pharmacy.stock.list')
  @Get('stock')
  async stock(@Query(new ZodBody(stockQuerySchema)) query: PharmacyStockQuery): Promise<{
    readonly items: readonly {
      readonly itemId: string;
      readonly itemCode: string;
      readonly itemName: string;
      readonly schedule: string;
      readonly batchId: string | null;
      readonly batchNo: string | null;
      readonly expiryDate: string | null;
      readonly qtyOnHand: string;
      readonly mrp: string | null;
    }[];
  }> {
    return this.ops.stock(query);
  }

  @Permission('pharmacy.return.create')
  @Idempotent()
  @Post('returns')
  async createReturn(
    @Body(new ZodBody(createSaleReturnSchema)) body: CreateSaleReturnRequest,
  ): Promise<SaleReturnView> {
    return this.ops.createReturn(body);
  }

  @Permission('pharmacy.return.read')
  @Get('returns/:id')
  async saleReturn(@Param('id', new ZodBody(idSchema)) id: string): Promise<SaleReturnView> {
    return this.ops.saleReturn(id);
  }

  /** Approval is what moves the stock, and it is not the raiser's to give. */
  @Permission('pharmacy.return.approve')
  @Idempotent()
  @Post('returns/:id/approve')
  async approveReturn(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(approveSaleReturnSchema)) body: ApproveSaleReturnRequest,
  ): Promise<SaleReturnView> {
    return this.ops.approveReturn(id, body);
  }

  @Permission('pharmacy.expiry.read')
  @Get('expiry')
  async expiring(@Query(new ZodBody(expiryQuerySchema)) query: PharmacyExpiryQuery): Promise<{
    readonly items: readonly {
      readonly storeId: string;
      readonly itemId: string;
      readonly itemCode: string;
      readonly itemName: string;
      readonly batchId: string;
      readonly batchNo: string;
      readonly expiryDate: string;
      readonly daysToExpiry: number;
      readonly qtyOnHand: string;
      readonly valueAtCost: string;
    }[];
  }> {
    return this.ops.expiring(query);
  }

  @Permission('pharmacy.expiry.manage')
  @Idempotent()
  @Post('expiry-actions')
  async expiryAction(
    @Body(new ZodBody(expiryActionSchema)) body: ExpiryActionRequest,
  ): Promise<ExpiryActionView> {
    return this.ops.actOnExpiry(body);
  }

  @Permission('pharmacy.recall.read')
  @Get('recalls')
  async listRecalls(@Query(new ZodBody(recallQuerySchema)) query: RecallQuery): Promise<Page<RecallView>> {
    return this.ops.listRecalls(query);
  }

  @Permission('pharmacy.recall.read')
  @Get('recalls/:id')
  async recall(@Param('id', new ZodBody(idSchema)) id: string): Promise<RecallView> {
    return this.ops.recall(id);
  }

  /** Raising it quarantines the batch everywhere, before anybody produces a list. */
  @Permission('pharmacy.recall.manage')
  @Idempotent()
  @Post('recalls')
  async raiseRecall(@Body(new ZodBody(raiseRecallSchema)) body: RaiseRecallRequest): Promise<RecallView> {
    return this.ops.raiseRecall(body);
  }

  /** The patient list. Separately permissioned, because that list is PHI. */
  @Permission('pharmacy.recall.trace')
  @Idempotent()
  @Post('recalls/:id/trace')
  async trace(@Param('id', new ZodBody(idSchema)) id: string): Promise<RecallTraceView> {
    return this.ops.traceRecall(id);
  }

  @Permission('pharmacy.recall.manage')
  @Idempotent()
  @Post('recalls/:id/close')
  async closeRecall(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(closeRecallSchema)) body: CloseRecallRequest,
  ): Promise<RecallView> {
    return this.ops.closeRecall(id, body);
  }

  @Permission('pharmacy.coldchain.record')
  @Idempotent()
  @Post('cold-chain/readings')
  async temperature(
    @Body(new ZodBody(coldChainReadingSchema)) body: ColdChainReadingRequest,
  ): Promise<{ readonly excursion: boolean }> {
    return this.ops.recordTemperature(body);
  }

  @Permission('pharmacy.intervention.record')
  @Idempotent()
  @Post('interventions')
  async intervention(
    @Body(new ZodBody(interventionSchema)) body: InterventionRequest,
  ): Promise<InterventionView> {
    return this.ops.recordIntervention(body);
  }

  @Permission('pharmacy.day_close.list')
  @Get('day-close')
  async listDayCloses(
    @Query(new ZodBody(dayCloseQuerySchema)) query: DayCloseQuery,
  ): Promise<Page<DayCloseView>> {
    return this.ops.listDayCloses(query);
  }

  /**
   * Refused by `pharmacy.enforce_day_close_preconditions` while a controlled-drug
   * variance on that date is unresolved — `phase-04` exit gate 4.
   */
  @Permission('pharmacy.day_close.complete')
  @Idempotent()
  @Post('day-close')
  async dayClose(@Body(new ZodBody(dayCloseSchema)) body: DayCloseRequest): Promise<DayCloseView> {
    return this.ops.dayClose(body);
  }
}
