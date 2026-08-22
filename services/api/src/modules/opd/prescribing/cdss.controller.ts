import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { CdssAlertsService, type AlertListItem } from './cdss.alerts.service.js';
import { PrescriptionService } from './prescription.service.js';
import {
  alertQuerySchema,
  alertResponseSchema,
  evaluateSchema,
  fatigueQuerySchema,
  idSchema,
  type AlertQuery,
  type AlertResponseRequest,
  type EvaluateRequest,
  type FatigueQuery,
} from './prescribing.schemas.js';
import type { AlertFatigueReport, EvaluationView } from './prescribing.types.js';

/**
 * `/api/v1/cdss` — EN-029 §6.
 *
 * `POST /cdss/evaluate` is deliberately **not** `@Idempotent()`. It is the call
 * the consultation screen makes as the doctor types, and every invocation is a
 * distinct evaluation against a context that may have changed since the last
 * one; replaying a cached answer is precisely the behaviour a safety check must
 * not have. It creates no business row that a retry could duplicate — only
 * append-only alert evidence, which is meant to record every showing.
 *
 * None of these keys may be licence-gated: `cdss.evaluate`, `cdss.alert.read`,
 * `cdss.alert.respond` and `cdss.emergency.declare` are all
 * `clinicalSafetyExempt` in the catalogue (EN-040 §5, D-9), because a hard stop
 * that a lapsed subscription could switch off is not a hard stop.
 */
@Controller('cdss')
export class CdssController {
  constructor(
    @Inject(PrescriptionService) private readonly prescriptions: PrescriptionService,
    @Inject(CdssAlertsService) private readonly alerts: CdssAlertsService,
  ) {}

  /** EN-029 §6 `POST /cdss/evaluate` — the hot path, before persistence. */
  @Permission('cdss.evaluate')
  @Post('evaluate')
  async evaluate(@Body(new ZodBody(evaluateSchema)) body: EvaluateRequest): Promise<EvaluationView> {
    return this.prescriptions.evaluate(body);
  }

  /** EN-029 §6 `GET /cdss/alerts` — the alert history, PHI-audited. */
  @Permission('cdss.alert.read')
  @Get('alerts')
  async list(@Query(new ZodBody(alertQuerySchema)) query: AlertQuery): Promise<Page<AlertListItem>> {
    return this.alerts.list(query);
  }

  /**
   * EN-029 §6 `POST /cdss/alerts/{id}/respond` — acknowledge, override, or
   * countersign.
   *
   * The catalogue marks `cdss.alert.respond` `requiresReason`, so the policy
   * guard demands an `x-reason` header; the coded reason in the body is the one
   * the fatigue dashboard aggregates. Both are required, and they answer
   * different questions: the header is why this user is doing something
   * reason-bearing at all, the code is why *this alert* was not heeded.
   */
  @Permission('cdss.alert.respond')
  @Post('alerts/:id/respond')
  async respond(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(alertResponseSchema)) body: AlertResponseRequest,
  ): Promise<{ readonly actionId: string }> {
    return this.alerts.respond(id, body);
  }

  /** `phase-02` exit gate 8 — alerts per 1000 orders, override rate, by reason. */
  @Permission('cdss.report.read')
  @Get('reports/alert-fatigue')
  async fatigue(@Query(new ZodBody(fatigueQuerySchema)) query: FatigueQuery): Promise<AlertFatigueReport> {
    return this.alerts.fatigue(query);
  }
}
