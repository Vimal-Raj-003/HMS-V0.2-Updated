import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { TransplantService } from './transplant.service.js';
import {
  artCycleSchema,
  artQuerySchema,
  artUpdateSchema,
  brainstemSchema,
  donationConsentSchema,
  donationSchema,
  donorSchema,
  recipientSchema,
  secondExamSchema,
  transplantQuerySchema,
  type ArtCycleRequest,
  type ArtQuery,
  type ArtUpdateRequest,
  type BrainstemRequest,
  type DonationConsentRequest,
  type DonationRequest,
  type DonorRequest,
  type RecipientRequest,
  type SecondExamRequest,
  type TransplantQuery,
} from './transplant.schemas.js';
import type { ArtCycleRow, BrainstemRow, DonationRow, DonorRow, RecipientRow } from './transplant.types.js';

/**
 * `/api/v1/transplant/*` and `/art/*` — IP-019 and OP-024.
 *
 * ── No route waives the Authorisation Committee ────────────────────────────
 *
 * A living donor who is not on the Act's list of near relatives needs it, and
 * that is the only route. There is no expedite, no waive and no override —
 * India's transplant law exists because organs were bought from people who were
 * poor, and the Committee is the single thing standing between a record and
 * that trade.
 *
 * ── And none that shortens the six hours ───────────────────────────────────
 *
 * The interval between the two brain-stem examinations *is* the test: a single
 * examination cannot distinguish brain-stem death from a reversible state.
 */
@Controller()
export class TransplantController {
  constructor(@Inject(TransplantService) private readonly svc: TransplantService) {}

  // ── The register ──────────────────────────────────────────────────────────

  @Permission('transplant.recipient.manage')
  @Idempotent()
  @Post('transplant/recipients')
  async listRecipient(@Body(new ZodBody(recipientSchema)) body: RecipientRequest): Promise<RecipientRow> {
    return this.svc.listRecipient(body);
  }

  @Permission('transplant.read')
  @Get('transplant/recipients')
  async listRecipients(
    @Query(new ZodBody(transplantQuerySchema)) query: TransplantQuery,
  ): Promise<readonly RecipientRow[]> {
    return this.svc.listRecipients(query);
  }

  /** The relationship the Act names, or the Committee's reference. Nothing else. */
  @Permission('transplant.donation.record')
  @Idempotent()
  @Post('transplant/donations')
  async recordDonation(@Body(new ZodBody(donationSchema)) body: DonationRequest): Promise<DonationRow> {
    return this.svc.recordDonation(body);
  }

  @Permission('transplant.recipient.manage')
  @Post('transplant/donations/:id')
  async updateDonation(
    @Param('id') id: string,
    @Body(new ZodBody(donationConsentSchema)) body: DonationConsentRequest,
  ): Promise<DonationRow> {
    return this.svc.updateDonation(id, body);
  }

  @Permission('transplant.read')
  @Get('transplant/donations')
  async listDonations(
    @Query(new ZodBody(transplantQuerySchema)) query: TransplantQuery,
  ): Promise<readonly DonationRow[]> {
    return this.svc.listDonations(query);
  }

  // ── Brain-stem death ──────────────────────────────────────────────────────

  @Permission('transplant.brainstem.certify')
  @Idempotent()
  @Post('transplant/brainstem')
  async recordFirstExam(@Body(new ZodBody(brainstemSchema)) body: BrainstemRequest): Promise<BrainstemRow> {
    return this.svc.recordFirstExam(body);
  }

  /** Six hours after the first, and not before. */
  @Permission('transplant.brainstem.certify')
  @Post('transplant/brainstem/:id/second-exam')
  async recordSecondExam(
    @Param('id') id: string,
    @Body(new ZodBody(secondExamSchema)) body: SecondExamRequest,
  ): Promise<BrainstemRow> {
    return this.svc.recordSecondExam(id, body);
  }

  // ── Assisted reproduction ─────────────────────────────────────────────────

  @Permission('art.donor.manage')
  @Idempotent()
  @Post('art/donors')
  async registerDonor(@Body(new ZodBody(donorSchema)) body: DonorRequest): Promise<DonorRow> {
    return this.svc.registerDonor(body);
  }

  @Permission('art.read')
  @Get('art/donors')
  async listDonors(@Query(new ZodBody(artQuerySchema)) query: ArtQuery): Promise<readonly DonorRow[]> {
    return this.svc.listDonors(query);
  }

  @Permission('art.cycle.manage')
  @Idempotent()
  @Post('art/cycles')
  async openCycle(@Body(new ZodBody(artCycleSchema)) body: ArtCycleRequest): Promise<ArtCycleRow> {
    return this.svc.openCycle(body);
  }

  @Permission('art.cycle.manage')
  @Post('art/cycles/:id')
  async updateCycle(
    @Param('id') id: string,
    @Body(new ZodBody(artUpdateSchema)) body: ArtUpdateRequest,
  ): Promise<ArtCycleRow> {
    return this.svc.updateCycle(id, body);
  }

  @Permission('art.read')
  @Get('art/cycles')
  async listCycles(@Query(new ZodBody(artQuerySchema)) query: ArtQuery): Promise<readonly ArtCycleRow[]> {
    return this.svc.listCycles(query);
  }
}
