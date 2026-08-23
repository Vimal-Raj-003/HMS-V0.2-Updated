import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { LabCatalogueService } from './catalogue.service.js';
import {
  addOnTestsSchema,
  cancelTestsSchema,
  catalogueQuerySchema,
  createLabOrderSchema,
  idSchema,
  issueLabelsSchema,
  labOrderQuerySchema,
  type AddOnTestsRequest,
  type CancelTestsRequest,
  type CatalogueQuery,
  type CreateLabOrderRequest,
  type IssueLabelsRequest,
  type LabOrderQuery,
} from './lab.schemas.js';
import type {
  LabLabelView,
  LabOrderView,
  LabRejectionReasonItem,
  LabTestCatalogueItem,
} from './lab.types.js';
import { LabOrdersService } from './orders.service.js';
import { LabSamplesService } from './samples.service.js';

/**
 * `/api/v1/lab/catalogue/*` — the two catalogue reads OP-004 needs that
 * `modules/masters` does not already serve.
 *
 * Both are master data, so both carry `mdm.read` rather than a lab-specific
 * key: whoever may read the department list may read the test list, and the
 * phlebotomist who has to pick a coded rejection reason cannot be asked to hold
 * a configuration permission to see the list they must choose from.
 */
@Controller('lab/catalogue')
export class LabCatalogueController {
  constructor(@Inject(LabCatalogueService) private readonly catalogue: LabCatalogueService) {}

  @Permission('mdm.read')
  @Get('tests')
  async tests(
    @Query(new ZodBody(catalogueQuerySchema)) query: CatalogueQuery,
  ): Promise<{ readonly items: readonly LabTestCatalogueItem[] }> {
    return this.catalogue.listTests(query);
  }

  @Permission('mdm.read')
  @Get('rejection-reasons')
  async rejectionReasons(): Promise<{ readonly items: readonly LabRejectionReasonItem[] }> {
    return this.catalogue.listRejectionReasons();
  }
}

/**
 * `/api/v1/lab/orders` — OP-004 §3.1 and §6.
 *
 * Every record-creating POST is `@Idempotent()`. A lab order is a charge and a
 * specimen: a retried request that created a second order would draw a second
 * tube and bill a second time, and the retry is exactly what a tablet on a ward
 * Wi-Fi does. Cancellation carries the flag for the same reason in reverse.
 */
@Controller('lab/orders')
export class LabOrdersController {
  constructor(
    @Inject(LabOrdersService) private readonly orders: LabOrdersService,
    @Inject(LabSamplesService) private readonly samples: LabSamplesService,
  ) {}

  @Permission('lab.order.create')
  @Idempotent()
  @Post()
  async create(@Body(new ZodBody(createLabOrderSchema)) body: CreateLabOrderRequest): Promise<LabOrderView> {
    return this.orders.create(body);
  }

  @Permission('lab.order.list')
  @Get()
  async list(@Query(new ZodBody(labOrderQuerySchema)) query: LabOrderQuery): Promise<Page<LabOrderView>> {
    return this.orders.list(query);
  }

  @Permission('lab.order.read')
  @Get(':id')
  async get(@Param('id', new ZodBody(idSchema)) id: string): Promise<LabOrderView> {
    return this.orders.get(id);
  }

  /** `OP-004 §3.1.4` — a test added to a specimen already in the laboratory. */
  @Permission('lab.order.addon')
  @Idempotent()
  @Post(':id/tests')
  async addOn(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(addOnTestsSchema)) body: AddOnTestsRequest,
  ): Promise<LabOrderView> {
    return this.orders.addOn(id, body);
  }

  @Permission('lab.order.cancel')
  @Idempotent()
  @Post(':id/cancel-tests')
  async cancelTests(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(cancelTestsSchema)) body: CancelTestsRequest,
  ): Promise<LabOrderView> {
    return this.orders.cancelTests(id, body);
  }

  /**
   * `EN-013 §3` — the labels, and with them the specimen rows they name. Both
   * happen in one act because a barcode printed for a tube the system does not
   * know about is the unlabelled-specimen problem in a new costume.
   */
  @Permission('lab.sample.label')
  @Idempotent()
  @Post(':id/labels')
  async labels(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(issueLabelsSchema)) body: IssueLabelsRequest,
  ): Promise<{ readonly labels: readonly LabLabelView[] }> {
    return this.samples.issueLabels(id, body);
  }
}
