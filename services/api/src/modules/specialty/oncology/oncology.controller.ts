import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { OncologyService } from './oncology.service.js';
import {
  administerSchema,
  administrationUpdateSchema,
  caseQuerySchema,
  caseSchema,
  cosignSchema,
  cycleQuerySchema,
  cycleSchema,
  cycleSignSchema,
  deferSchema,
  orderLineSchema,
  pharmacySchema,
  planSchema,
  regimenSchema,
  toxicitySchema,
  type AdministerRequest,
  type AdministrationUpdateRequest,
  type CaseQuery,
  type CaseRequest,
  type CosignRequest,
  type CycleQuery,
  type CycleRequest,
  type CycleSignRequest,
  type DeferRequest,
  type OrderLineRequest,
  type PharmacyRequest,
  type PlanRequest,
  type RegimenRequest,
  type ToxicityRequest,
} from './oncology.schemas.js';
import type {
  AdministrationRow,
  ChemoCycleRow,
  CycleDetail,
  OncoCaseRow,
  OrderLineRow,
  RegimenRow,
  ToxicityRow,
  TreatmentPlanRow,
} from './oncology.types.js';

/**
 * `/api/v1/onco/*` — OP-031 and IP-023.
 *
 * ── One route is a documented way past a refusal, and it is the counts ─────
 *
 * `POST cycles/:id/cosign`. Giving chemotherapy on neutrophils below threshold
 * is sometimes correct — a curable disease in a patient whose marrow will not
 * recover further with more delay — and it is a decision a second oncologist
 * takes in writing. The second signer comes from the session, so a prescriber
 * cannot name a colleague who has not looked.
 *
 * ── And there is no route that reaches the vinca ──────────────────────────
 *
 * No `force`, no `route` on an order line, no override anywhere. Intrathecal
 * vincristine is uniformly fatal, and the strongest thing this build can say
 * about it is that nothing in the API can express it.
 */
@Controller()
export class OncologyController {
  constructor(@Inject(OncologyService) private readonly onco: OncologyService) {}

  // ── The case ──────────────────────────────────────────────────────────────

  @Permission('onco.case.manage')
  @Idempotent()
  @Post('onco/cases')
  async createCase(@Body(new ZodBody(caseSchema)) body: CaseRequest): Promise<OncoCaseRow> {
    return this.onco.createCase(body);
  }

  @Permission('onco.case.read')
  @Get('onco/cases')
  async listCases(@Query(new ZodBody(caseQuerySchema)) query: CaseQuery): Promise<readonly OncoCaseRow[]> {
    return this.onco.listCases(query);
  }

  @Permission('onco.case.read')
  @Get('onco/cases/:id')
  async caseDetail(@Param('id') id: string): Promise<OncoCaseRow> {
    return this.onco.caseDetail(id);
  }

  // ── The library ───────────────────────────────────────────────────────────

  /** Regimens are versioned, never edited: every plan is a pin to a version. */
  @Permission('onco.regimen.configure')
  @Idempotent()
  @Post('onco/regimens')
  async writeRegimen(@Body(new ZodBody(regimenSchema)) body: RegimenRequest): Promise<RegimenRow> {
    return this.onco.writeRegimen(body);
  }

  @Permission('onco.case.read')
  @Get('onco/regimens')
  async listRegimens(): Promise<readonly RegimenRow[]> {
    return this.onco.listRegimens();
  }

  // ── The plan ──────────────────────────────────────────────────────────────

  @Permission('onco.plan.write')
  @Idempotent()
  @Post('onco/plans')
  async writePlan(@Body(new ZodBody(planSchema)) body: PlanRequest): Promise<TreatmentPlanRow> {
    return this.onco.writePlan(body);
  }

  // ── The cycle ─────────────────────────────────────────────────────────────

  @Permission('onco.cycle.schedule')
  @Idempotent()
  @Post('onco/plans/:id/cycles')
  async scheduleCycle(
    @Param('id') id: string,
    @Body(new ZodBody(cycleSchema)) body: CycleRequest,
  ): Promise<CycleDetail> {
    return this.onco.scheduleCycle(id, body);
  }

  @Permission('onco.case.read')
  @Get('onco/cycles')
  async listCycles(
    @Query(new ZodBody(cycleQuerySchema)) query: CycleQuery,
  ): Promise<readonly ChemoCycleRow[]> {
    return this.onco.listCycles(query);
  }

  @Permission('onco.case.read')
  @Get('onco/cycles/:id')
  async cycleDetail(@Param('id') id: string): Promise<CycleDetail> {
    return this.onco.cycleDetail(id);
  }

  /** The dose comes out of the library and the patient's own numbers. */
  @Permission('onco.cycle.schedule')
  @Post('onco/cycles/:id/lines')
  async addLine(
    @Param('id') id: string,
    @Body(new ZodBody(orderLineSchema)) body: OrderLineRequest,
  ): Promise<CycleDetail> {
    return this.onco.addOrderLine(id, body);
  }

  @Permission('onco.cycle.sign')
  @Post('onco/cycles/:id/sign')
  async signCycle(
    @Param('id') id: string,
    @Body(new ZodBody(cycleSignSchema)) body: CycleSignRequest,
  ): Promise<CycleDetail> {
    return this.onco.signCycle(id, body);
  }

  /** The second oncologist, taken from the session rather than the body. */
  @Permission('onco.cycle.cosign')
  @Post('onco/cycles/:id/cosign')
  async cosignCycle(
    @Param('id') id: string,
    @Body(new ZodBody(cosignSchema)) body: CosignRequest,
  ): Promise<CycleDetail> {
    return this.onco.cosignCycle(id, body);
  }

  @Permission('onco.cycle.schedule')
  @Post('onco/cycles/:id/defer')
  async deferCycle(
    @Param('id') id: string,
    @Body(new ZodBody(deferSchema)) body: DeferRequest,
  ): Promise<CycleDetail> {
    return this.onco.deferCycle(id, body);
  }

  // ── Pharmacy, and the chair ───────────────────────────────────────────────

  /** The independent recalculation, and the ability to stop the line. */
  @Permission('onco.pharmacy.verify')
  @Post('onco/order-lines/:id/verify')
  async verifyLine(
    @Param('id') id: string,
    @Body(new ZodBody(pharmacySchema)) body: PharmacyRequest,
  ): Promise<OrderLineRow> {
    return this.onco.verifyLine(id, body);
  }

  @Permission('onco.administer')
  @Idempotent()
  @Post('onco/cycles/:id/administrations')
  async administer(
    @Param('id') id: string,
    @Body(new ZodBody(administerSchema)) body: AdministerRequest,
  ): Promise<CycleDetail> {
    return this.onco.administer(id, body);
  }

  @Permission('onco.administer')
  @Post('onco/administrations/:id')
  async updateAdministration(
    @Param('id') id: string,
    @Body(new ZodBody(administrationUpdateSchema)) body: AdministrationUpdateRequest,
  ): Promise<AdministrationRow> {
    return this.onco.updateAdministration(id, body);
  }

  // ── Toxicity ──────────────────────────────────────────────────────────────

  @Permission('onco.toxicity.record')
  @Idempotent()
  @Post('onco/cases/:id/toxicity')
  async recordToxicity(
    @Param('id') id: string,
    @Body(new ZodBody(toxicitySchema)) body: ToxicityRequest,
  ): Promise<ToxicityRow> {
    return this.onco.recordToxicity(id, body);
  }
}
