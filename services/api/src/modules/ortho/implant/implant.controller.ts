import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { ImplantService } from './implant.service.js';
import {
  adjustStockSchema,
  castApplySchema,
  castCheckSchema,
  castQuerySchema,
  castRemoveSchema,
  castRequestSchema,
  catalogueQuerySchema,
  catalogueSchema,
  explantSchema,
  pinCareSchema,
  pinSiteSchema,
  recallContactSchema,
  recallSchema,
  receiveStockSchema,
  recordUsageSchema,
  stockQuerySchema,
  traceQuerySchema,
  type AdjustStockRequest,
  type CastApplyRequest,
  type CastCheckRequest,
  type CastQuery,
  type CastRemoveRequest,
  type CastRequestBody,
  type CatalogueQuery,
  type CatalogueRequest,
  type ExplantRequest,
  type PinCareRequest,
  type PinSiteRequest,
  type RecallContactRequest,
  type RecallRequest,
  type ReceiveStockRequest,
  type RecordUsageRequest,
  type StockQuery,
  type TraceQuery,
} from './implant.schemas.js';
import type {
  CastApplicationView,
  CastDetailView,
  CastRequestView,
  CatalogueView,
  RecallDetailView,
  RecallView,
  StockView,
  TraceResult,
  UsageView,
} from './implant.types.js';

/**
 * `/api/v1/implants/*` and `/api/v1/casts/*` — TR-003 and TR-005.
 *
 * ── Recording is at the trolley; the trace is not ───────────────────────────
 *
 * `POST /implants/usages` needs `implant.usage.record`, which the scrub nurse
 * holds, because the box is in their hand and the barcode is on it. The trace
 * needs `implant.trace.query` and a reason: it turns a device identifier into a
 * list of patient names, and who ran it and why is part of the record.
 *
 * ── There is no endpoint that deletes an implant record ─────────────────────
 *
 * A device that came out is explanted, not erased. The row is the only evidence
 * of what was once inside that patient, and a recall list must still find it.
 */
@Controller()
export class ImplantController {
  constructor(@Inject(ImplantService) private readonly implants: ImplantService) {}

  // ── The catalogue ──────────────────────────────────────────────────────────

  @Permission('implant.catalogue.read')
  @Get('implants/catalogue')
  async searchCatalogue(
    @Query(new ZodBody(catalogueQuerySchema)) query: CatalogueQuery,
  ): Promise<Page<CatalogueView>> {
    return this.implants.searchCatalogue(query);
  }

  @Permission('implant.catalogue.manage')
  @Idempotent()
  @Post('implants/catalogue')
  async upsertCatalogue(@Body(new ZodBody(catalogueSchema)) body: CatalogueRequest): Promise<CatalogueView> {
    return this.implants.upsertCatalogue(body);
  }

  // ── The shelf ──────────────────────────────────────────────────────────────

  @Permission('implant.stock.read')
  @Get('implants/stock')
  async listStock(@Query(new ZodBody(stockQuerySchema)) query: StockQuery): Promise<Page<StockView>> {
    return this.implants.listStock(query);
  }

  @Permission('implant.stock.receive')
  @Idempotent()
  @Post('implants/stock')
  async receiveStock(
    @Body(new ZodBody(receiveStockSchema)) body: ReceiveStockRequest,
  ): Promise<readonly StockView[]> {
    return this.implants.receiveStock(body);
  }

  @Permission('implant.stock.adjust')
  @Patch('implants/stock/:id')
  async adjustStock(
    @Param('id') id: string,
    @Body(new ZodBody(adjustStockSchema)) body: AdjustStockRequest,
  ): Promise<StockView> {
    return this.implants.adjustStock(id, body);
  }

  // ── Into the patient ───────────────────────────────────────────────────────

  @Permission('implant.usage.record')
  @Idempotent()
  @Post('implants/usages')
  async recordUsage(@Body(new ZodBody(recordUsageSchema)) body: RecordUsageRequest): Promise<UsageView> {
    return this.implants.recordUsage(body);
  }

  @Permission('implant.usage.read')
  @Get('implants/patients/:patientId')
  async listForPatient(@Param('patientId') patientId: string): Promise<Page<UsageView>> {
    return this.implants.listUsagesForPatient(patientId);
  }

  @Permission('implant.usage.explant')
  @Patch('implants/usages/:id/explant')
  async explant(
    @Param('id') id: string,
    @Body(new ZodBody(explantSchema)) body: ExplantRequest,
  ): Promise<UsageView> {
    return this.implants.explant(id, body);
  }

  // ── The recall ─────────────────────────────────────────────────────────────

  @Permission('implant.trace.query')
  @Get('implants/trace')
  async trace(@Query(new ZodBody(traceQuerySchema)) query: TraceQuery): Promise<TraceResult> {
    return this.implants.trace(query);
  }

  @Permission('implant.recall.read')
  @Get('implants/recalls')
  async listRecalls(): Promise<Page<RecallView>> {
    return this.implants.listRecalls();
  }

  @Permission('implant.recall.manage')
  @Idempotent()
  @Post('implants/recalls')
  async openRecall(@Body(new ZodBody(recallSchema)) body: RecallRequest): Promise<RecallDetailView> {
    return this.implants.openRecall(body);
  }

  @Permission('implant.recall.read')
  @Get('implants/recalls/:id')
  async getRecall(@Param('id') id: string): Promise<RecallDetailView> {
    return this.implants.getRecall(id);
  }

  @Permission('implant.recall.contact')
  @Patch('implants/recalls/:id/cases/:caseId')
  async recordContact(
    @Param('id') id: string,
    @Param('caseId') caseId: string,
    @Body(new ZodBody(recallContactSchema)) body: RecallContactRequest,
  ): Promise<RecallDetailView> {
    return this.implants.recordContact(id, caseId, body);
  }

  @Permission('implant.recall.manage')
  @Patch('implants/recalls/:id/close')
  async closeRecall(@Param('id') id: string): Promise<RecallDetailView> {
    return this.implants.closeRecall(id);
  }

  // ── TR-005 ─────────────────────────────────────────────────────────────────

  @Permission('cast.request.create')
  @Idempotent()
  @Post('casts/requests')
  async createRequest(@Body(new ZodBody(castRequestSchema)) body: CastRequestBody): Promise<CastRequestView> {
    return this.implants.createCastRequest(body);
  }

  @Permission('cast.request.read')
  @Get('casts')
  async listCasts(@Query(new ZodBody(castQuerySchema)) query: CastQuery): Promise<Page<CastApplicationView>> {
    return this.implants.listCasts(query);
  }

  @Permission('cast.request.read')
  @Get('casts/:id')
  async getCast(@Param('id') id: string): Promise<CastDetailView> {
    return this.implants.getCast(id);
  }

  @Permission('cast.apply')
  @Idempotent()
  @Post('casts')
  async applyCast(@Body(new ZodBody(castApplySchema)) body: CastApplyRequest): Promise<CastDetailView> {
    return this.implants.applyCast(body);
  }

  @Permission('cast.check.record')
  @Post('casts/:id/checks')
  async recordCheck(
    @Param('id') id: string,
    @Body(new ZodBody(castCheckSchema)) body: CastCheckRequest,
  ): Promise<CastDetailView> {
    return this.implants.recordCheck(id, body);
  }

  @Permission('cast.remove')
  @Patch('casts/:id/remove')
  async removeCast(
    @Param('id') id: string,
    @Body(new ZodBody(castRemoveSchema)) body: CastRemoveRequest,
  ): Promise<CastDetailView> {
    return this.implants.removeCast(id, body);
  }

  @Permission('cast.pinsite.manage')
  @Post('casts/:id/pin-sites')
  async addPinSite(
    @Param('id') id: string,
    @Body(new ZodBody(pinSiteSchema)) body: PinSiteRequest,
  ): Promise<CastDetailView> {
    return this.implants.addPinSite(id, body);
  }

  @Permission('cast.pinsite.manage')
  @Patch('casts/:id/pin-sites/:pinId')
  async recordPinCare(
    @Param('id') id: string,
    @Param('pinId') pinId: string,
    @Body(new ZodBody(pinCareSchema)) body: PinCareRequest,
  ): Promise<CastDetailView> {
    return this.implants.recordPinCare(id, pinId, body);
  }
}
