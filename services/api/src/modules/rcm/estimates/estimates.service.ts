import { Inject, Injectable } from '@nestjs/common';
import { newId, type Page } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService, type TransactionClient } from '../../../core/db/database.service.js';
import { NumberingService } from '../../../core/numbering/numbering.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import { TariffService } from '../tariff/tariff.service.js';
import { estimateEvent } from './estimates.events.js';
import { withEstimateErrors } from './estimates.errors.js';
import type {
  CreateEstimateRequest,
  CreateTemplateRequest,
  EstimateQuery,
  IssueEstimateRequest,
  RecordOutcomeRequest,
  RecordVarianceRequest,
  ShareEstimateRequest,
  TemplateQuery,
  UpdateEstimateRequest,
  VarianceQuery,
} from './estimates.schemas.js';
import type {
  EstimateDetailView,
  EstimateLineView,
  EstimateScenarioView,
  EstimateView,
  TemplateView,
  VarianceSampleView,
  VarianceSummaryRow,
} from './estimates.types.js';

function asText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString();
  return '';
}
function asTextOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : asText(v);
}
function asNumber(v: unknown): number {
  return typeof v === 'number' ? v : Number(asText(v));
}
function asDay(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString().slice(0, 10) : asText(v);
}
function money(n: number): string {
  return n.toFixed(2);
}
function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 86_400_000);
}

/**
 * The threshold above which a bill overrunning its estimate stops being noise.
 *
 * 10% of a ₹2,40,000 quote is ₹24,000 — around a month's income for the families
 * this most affects. Below that the desk absorbs it in conversation; above it,
 * somebody has to tell the family before discharge rather than at it, so it
 * raises `estimate.variance.breached` rather than sitting in a monthly report.
 */
const VARIANCE_ALERT_PCT = 10;

/**
 * RC-008 — cost estimator.
 *
 * ── An estimate is a promise, so the module is built around holding to it ───
 *
 * A family borrows against this number, sells against it, and chooses this
 * hospital because of it. When the discharge bill is 40% higher the money is
 * usually not there, and the argument happens at the counter with a sick
 * relative upstairs. Three things follow:
 *
 * **Every line is priced through `TariffService`, never invented here.** The
 * same resolver every bill line calls. If the estimate and the bill can be
 * priced by two different authorities they will eventually disagree, and the
 * family will be the one who finds out.
 *
 * **An issued estimate is immutable at the database level.** A revision is a new
 * estimate carrying `supersedes_id`; both survive. `revise()` is the only way to
 * change a number a family has already been given.
 *
 * **Every estimate that becomes an admission is scored.** `recordVariance` is
 * exit gate 8, and a breach above {@link VARIANCE_ALERT_PCT} raises an event
 * rather than waiting for a monthly report — the point of noticing is to tell
 * the family before discharge.
 *
 * ── Confidence is on the line, not on the estimate ──────────────────────────
 *
 * A total made of firm lines and a total made of indicative ones are different
 * promises even when the number is identical. Marking each line lets the desk
 * say "the surgery is fixed, the ICU days are not", which is the honest version
 * of a quote and the one that survives the discharge conversation.
 */
@Injectable()
export class EstimatesService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(NumberingService) private readonly numbering: NumberingService,
    @Inject(TariffService) private readonly tariff: TariffService,
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

  /** One transaction, and one place where a refusal becomes something readable. */
  private guard<T>(fn: (tx: TransactionClient) => Promise<T>): Promise<T> {
    return withEstimateErrors(() => this.db.withTenant(currentTenantContext(), fn));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Templates
  // ═══════════════════════════════════════════════════════════════════════════

  async listTemplates(query: TemplateQuery): Promise<Page<TemplateView>> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT t.*, (SELECT count(*) FROM billing.est_template_lines l WHERE l.template_id = t.id) AS line_count
           FROM billing.est_templates t
          WHERE t.hospital_id = $1 AND (NOT $2::boolean OR t.is_active)
          ORDER BY t.code
          LIMIT $3`,
        [this.hospitalId(), query.activeOnly, query.limit + 1],
      );
      const page = rows.slice(0, query.limit);
      return {
        items: page.map((r) => ({
          id: asText(r['id']),
          code: asText(r['code']),
          name: asText(r['name']),
          specialty: asTextOrNull(r['specialty']),
          procedureCode: asTextOrNull(r['procedure_code']),
          assumedLosDays: asNumber(r['assumed_los_days']),
          isActive: Boolean(r['is_active']),
          lineCount: asNumber(r['line_count']),
          lines: [],
        })),
        nextCursor: null,
        hasMore: rows.length > query.limit,
      };
    });
  }

  async createTemplate(body: CreateTemplateRequest): Promise<TemplateView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();
      const id = newId();

      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO billing.est_templates
           (id, hospital_id, code, name, specialty, procedure_code, assumed_los_days, notes,
            created_at, created_by, updated_at, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now(),$9, now(),$9)
         ON CONFLICT ("hospital_id","code") DO NOTHING
         RETURNING *`,
        [
          id,
          hospital,
          body.code,
          body.name,
          body.specialty ?? null,
          body.procedureCode ?? null,
          body.assumedLosDays,
          body.notes ?? null,
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict(`A template with code "${body.code}" already exists.`);

      let order = 0;
      for (const line of body.lines) {
        await tx.query(
          `INSERT INTO billing.est_template_lines
             (id, hospital_id, template_id, service_id, description, quantity, per_day, confidence, sort_order, created_at)
           VALUES ($1,$2,$3,$4,$5,$6::numeric,$7,$8::"billing"."EstimateLineConfidence",$9, now())`,
          [
            newId(),
            hospital,
            id,
            line.serviceId ?? null,
            line.description,
            line.quantity,
            line.perDay,
            line.confidence,
            (order += 10),
          ],
        );
      }

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'est_template',
        rowId: id,
        businessKey: body.code,
        dataClass: 'financial',
        before: null,
        after: { code: body.code, lines: body.lines.length },
      });

      return this.loadTemplate(tx, id);
    });
  }

  private async loadTemplate(tx: TransactionClient, id: string): Promise<TemplateView> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM billing.est_templates WHERE id = $1 AND hospital_id = $2`,
      [id, this.hospitalId()],
    );
    const row = rows[0];
    if (row === undefined) throw AppError.notFound('Estimate template');

    const { rows: lines } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM billing.est_template_lines WHERE template_id = $1 ORDER BY sort_order, description`,
      [id],
    );

    return {
      id: asText(row['id']),
      code: asText(row['code']),
      name: asText(row['name']),
      specialty: asTextOrNull(row['specialty']),
      procedureCode: asTextOrNull(row['procedure_code']),
      assumedLosDays: asNumber(row['assumed_los_days']),
      isActive: Boolean(row['is_active']),
      lineCount: lines.length,
      lines: lines.map((l) => ({
        id: asText(l['id']),
        serviceId: asTextOrNull(l['service_id']),
        description: asText(l['description']),
        quantity: asText(l['quantity']),
        perDay: Boolean(l['per_day']),
        confidence: asText(l['confidence']),
      })),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Estimates
  // ═══════════════════════════════════════════════════════════════════════════

  async listEstimates(query: EstimateQuery): Promise<Page<EstimateView>> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM billing.est_estimates
          WHERE hospital_id = $1
            AND ($2::text IS NULL OR status::text = $2)
            AND ($3::uuid IS NULL OR patient_id = $3)
            AND ($4::text IS NULL OR procedure_code = $4)
          ORDER BY created_at DESC
          LIMIT $5`,
        [
          this.hospitalId(),
          query.status ?? null,
          query.patientId ?? null,
          query.procedureCode ?? null,
          query.limit + 1,
        ],
      );
      const page = rows.slice(0, query.limit);
      return {
        items: page.map((r) => this.toEstimate(r)),
        nextCursor: null,
        hasMore: rows.length > query.limit,
      };
    });
  }

  private toEstimate(r: Record<string, unknown>): EstimateView {
    const validTill = asDay(r['valid_till']);
    return {
      id: asText(r['id']),
      estimateNo: asText(r['estimate_no']),
      title: asText(r['title']),
      patientId: asTextOrNull(r['patient_id']),
      enquirerName: asTextOrNull(r['enquirer_name']),
      procedureCode: asTextOrNull(r['procedure_code']),
      status: asText(r['status']),
      losDays: asNumber(r['los_days']),
      totalGross: asText(r['total_gross']),
      totalDiscount: asText(r['total_discount']),
      totalPayable: asText(r['total_payable']),
      patientShare: asText(r['patient_share']),
      payerShare: asText(r['payer_share']),
      coPayPct: asText(r['co_pay_pct']),
      deductible: asText(r['deductible']),
      currency: asText(r['currency']),
      validTill,
      daysLeft: validTill === null ? null : daysBetween(new Date(), new Date(validTill)),
      issuedAt: asTextOrNull(r['issued_at']),
      supersedesId: asTextOrNull(r['supersedes_id']),
      convertedAt: asTextOrNull(r['converted_at']),
      convertedEncounterId: asTextOrNull(r['converted_encounter_id']),
      declineReason: asTextOrNull(r['decline_reason']),
      createdAt: asText(r['created_at']),
    };
  }

  /**
   * Build a draft, pricing every line through the tariff.
   *
   * A line whose rate the tariff cannot resolve is kept at zero and marked
   * `manual`, not dropped. Dropping it would produce a quote that is quietly too
   * low, which is the failure this whole module exists to prevent; keeping it
   * visible at zero makes the gap something the desk has to look at before
   * issuing.
   */
  async createEstimate(body: CreateEstimateRequest): Promise<EstimateDetailView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();
      const branch = this.branchId();
      const id = newId();

      const allocation = await this.numbering.allocate(tx, {
        key: 'ESTIMATE',
        branchId: branch,
        refType: 'estimate',
        refId: id,
      });

      // Template lines first, then anything the caller added on top.
      interface Draft {
        readonly serviceId: string | null;
        readonly description: string;
        readonly quantity: number;
        readonly unitRate: number | undefined;
        readonly confidence: string;
        readonly source: string;
      }
      const drafts: Draft[] = [];

      if (body.templateId !== undefined) {
        const { rows: tl } = await tx.query<Record<string, unknown>>(
          `SELECT l.* FROM billing.est_template_lines l
             JOIN billing.est_templates t ON t.id = l.template_id
            WHERE l.template_id = $1 AND t.hospital_id = $2
            ORDER BY l.sort_order, l.description`,
          [body.templateId, hospital],
        );
        if (tl.length === 0) throw AppError.notFound('Estimate template');
        for (const l of tl) {
          // A per-day line multiplies by the stay. This is where most of the
          // variance in a real estimate comes from, so it is arithmetic rather
          // than a note for the desk to remember.
          const perDay = Boolean(l['per_day']);
          const qty = asNumber(l['quantity']) * (perDay ? Math.max(body.losDays, 1) : 1);
          drafts.push({
            serviceId: asTextOrNull(l['service_id']),
            description: asText(l['description']),
            quantity: qty,
            unitRate: undefined,
            confidence: asText(l['confidence']),
            source: 'template',
          });
        }
      }

      // A caller line that names the same thing as a template line *replaces*
      // it rather than joining it. Typing "prosthesis, ₹78,000" against a
      // template whose prosthesis line the tariff could not price means "here is
      // the price", not "add a second prosthesis" — and the second one would
      // double that part of the quote.
      const key = (serviceId: string | null, description: string): string =>
        `${serviceId ?? ''}|${description.trim().toLowerCase()}`;

      for (const l of body.lines) {
        const draft: Draft = {
          serviceId: l.serviceId ?? null,
          description: l.description,
          quantity: l.quantity * (l.perDay ? Math.max(body.losDays, 1) : 1),
          unitRate: l.unitRate,
          confidence: l.confidence,
          source: l.unitRate === undefined ? 'tariff' : 'manual',
        };
        const existing = drafts.findIndex(
          (d) => key(d.serviceId, d.description) === key(draft.serviceId, draft.description),
        );
        if (existing >= 0) drafts[existing] = draft;
        else drafts.push(draft);
      }

      await tx.query(
        `INSERT INTO billing.est_estimates
           (id, hospital_id, branch_id, estimate_no, patient_id, enquirer_name, enquirer_phone,
            encounter_id, template_id, payer_id, scheme_id, package_id, bed_class_id,
            procedure_code, title, los_days, status, co_pay_pct, deductible, notes,
            total_gross, total_discount, total_payable, patient_share, payer_share,
            created_at, created_by, updated_at, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,
                 $8,$9,$10,$11,$12,$13,
                 $14,$15,$16,'draft',$17::numeric,$18::numeric,$19,
                 0,0,0,0,0,
                 now(),$20, now(),$20)`,
        [
          id,
          hospital,
          branch,
          allocation.formatted,
          body.patientId ?? null,
          body.enquirerName ?? null,
          body.enquirerPhone ?? null,
          body.encounterId ?? null,
          body.templateId ?? null,
          body.payerId ?? null,
          body.schemeId ?? null,
          body.packageId ?? null,
          body.bedClassId ?? null,
          body.procedureCode ?? null,
          body.title,
          body.losDays,
          body.coPayPct.toFixed(2),
          body.deductible.toFixed(2),
          body.notes ?? null,
          this.actorId(),
        ],
      );

      let order = 0;
      for (const d of drafts) {
        let unitRate = d.unitRate ?? 0;
        let source = d.source;
        let taxTreatment = 'exempt';
        let gstRate = 0;
        let tariffVersionId: string | null = null;

        if (d.unitRate === undefined && d.serviceId !== null) {
          const resolved = await this.tariff.resolve({
            serviceId: d.serviceId,
            branchId: branch,
            ...(body.payerId === undefined ? {} : { payerId: body.payerId }),
            ...(body.schemeId === undefined ? {} : { schemeId: body.schemeId }),
            ...(body.bedClassId === undefined ? {} : { bedClassId: body.bedClassId }),
          });
          if (resolved.outcome === 'missing_rate') {
            // Kept at zero and flagged, never dropped. A silently short quote is
            // the failure the module exists to prevent.
            unitRate = 0;
            source = 'manual';
          } else {
            unitRate = Number(resolved.rate);
            taxTreatment = resolved.taxTreatment;
            gstRate = Number(resolved.gstRate);
            tariffVersionId = resolved.versionId;
            source = d.source === 'template' ? 'template' : 'tariff';
          }
        }

        await tx.query(
          `INSERT INTO billing.est_estimate_lines
             (id, hospital_id, estimate_id, service_id, description, quantity, unit_rate, amount,
              confidence, source, tariff_version_id, tax_treatment, gst_rate, sort_order, created_at)
           VALUES ($1,$2,$3,$4,$5,$6::numeric,$7::numeric, round($6::numeric * $7::numeric, 2),
                   $8::"billing"."EstimateLineConfidence",$9::"billing"."EstimateSource",$10,$11,$12::numeric,$13, now())`,
          [
            newId(),
            hospital,
            id,
            d.serviceId,
            d.description,
            d.quantity,
            money(unitRate),
            d.confidence,
            source,
            tariffVersionId,
            taxTreatment,
            gstRate.toFixed(2),
            (order += 10),
          ],
        );
      }

      await this.recalculate(tx, id);

      await tx.query(
        `INSERT INTO billing.est_estimate_events (id, hospital_id, estimate_id, kind, at, by_id)
         VALUES ($1,$2,$3,'created', now(),$4)`,
        [newId(), hospital, id, this.actorId()],
      );

      return this.loadEstimate(tx, id);
    });
  }

  /**
   * Recompute the totals from the lines and split them between patient and payer.
   *
   * The split is where the family's number comes from, so it is computed in one
   * place: co-pay applies to the payable, the deductible comes off the payer's
   * side first, and the patient never ends up owing more than the whole.
   */
  private async recalculate(tx: TransactionClient, id: string): Promise<void> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT COALESCE(sum(amount), 0) AS gross, COALESCE(sum(discount), 0) AS disc
         FROM billing.est_estimate_lines WHERE estimate_id = $1`,
      [id],
    );
    const gross = asNumber(rows[0]?.['gross'] ?? 0);
    const discount = asNumber(rows[0]?.['disc'] ?? 0);
    const payable = Math.round((gross - discount) * 100) / 100;

    const { rows: est } = await tx.query<Record<string, unknown>>(
      `SELECT co_pay_pct, deductible, payer_id, scheme_id FROM billing.est_estimates WHERE id = $1`,
      [id],
    );
    const e = est[0];
    if (e === undefined) throw AppError.notFound('Estimate');

    const coPayPct = asNumber(e['co_pay_pct']);
    const deductible = asNumber(e['deductible']);
    const hasPayer = e['payer_id'] !== null || e['scheme_id'] !== null;

    let patientShare = payable;
    let payerShare = 0;
    if (hasPayer) {
      const coPay = Math.round(payable * (coPayPct / 100) * 100) / 100;
      // Everything not covered lands on the family, and it cannot exceed the
      // whole bill however the co-pay and deductible combine.
      patientShare = Math.min(payable, Math.round((coPay + deductible) * 100) / 100);
      payerShare = Math.round((payable - patientShare) * 100) / 100;
    }

    await tx.query(
      `UPDATE billing.est_estimates
          SET total_gross = $2::numeric, total_discount = $3::numeric, total_payable = $4::numeric,
              patient_share = $5::numeric, payer_share = $6::numeric, updated_at = now()
        WHERE id = $1`,
      [id, money(gross), money(discount), money(payable), money(patientShare), money(payerShare)],
    );
  }

  async getEstimate(id: string): Promise<EstimateDetailView> {
    return this.guard((tx) => this.loadEstimate(tx, id));
  }

  private async loadEstimate(tx: TransactionClient, id: string): Promise<EstimateDetailView> {
    const hospital = this.hospitalId();
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM billing.est_estimates WHERE id = $1 AND hospital_id = $2`,
      [id, hospital],
    );
    const row = rows[0];
    if (row === undefined) throw AppError.notFound('Estimate');

    const { rows: lines } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM billing.est_estimate_lines WHERE estimate_id = $1 ORDER BY sort_order, description`,
      [id],
    );
    const { rows: scen } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM billing.est_estimate_scenarios WHERE estimate_id = $1 ORDER BY total_payable`,
      [id],
    );
    const { rows: evts } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM billing.est_estimate_events WHERE estimate_id = $1 ORDER BY at`,
      [id],
    );
    const { rows: vr } = await tx.query<Record<string, unknown>>(
      `SELECT s.*, e.estimate_no FROM billing.est_variance_samples s
         JOIN billing.est_estimates e ON e.id = s.estimate_id
        WHERE s.estimate_id = $1`,
      [id],
    );

    const lineViews: EstimateLineView[] = lines.map((l) => ({
      id: asText(l['id']),
      serviceId: asTextOrNull(l['service_id']),
      description: asText(l['description']),
      quantity: asText(l['quantity']),
      unitRate: asText(l['unit_rate']),
      amount: asText(l['amount']),
      discount: asText(l['discount']),
      confidence: asText(l['confidence']),
      source: asText(l['source']),
      taxTreatment: asText(l['tax_treatment']),
      gstRate: asText(l['gst_rate']),
    }));

    return {
      ...this.toEstimate(row),
      lines: lineViews,
      scenarios: scen.map((s) => this.toScenario(s)),
      events: evts.map((v) => ({
        id: asText(v['id']),
        kind: asText(v['kind']),
        channel: asTextOrNull(v['channel']),
        note: asTextOrNull(v['note']),
        at: asText(v['at']),
      })),
      variance: vr[0] === undefined ? null : this.toVariance(vr[0]),
      softLineCount: lineViews.filter((l) => l.confidence === 'indicative' || l.confidence === 'contingent')
        .length,
      unpricedLineCount: lineViews.filter((l) => l.unitRate === '0.00' && l.confidence !== 'contingent')
        .length,
    };
  }

  private toScenario(r: Record<string, unknown>): EstimateScenarioView {
    return {
      id: asText(r['id']),
      bedClassId: asTextOrNull(r['bed_class_id']),
      label: asText(r['label']),
      totalPayable: asText(r['total_payable']),
      patientShare: asText(r['patient_share']),
      deltaVsChosen: asText(r['delta_vs_chosen']),
      isChosen: Boolean(r['is_chosen']),
    };
  }

  async updateEstimate(id: string, body: UpdateEstimateRequest): Promise<EstimateDetailView> {
    return this.guard(async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE billing.est_estimates
            SET title = COALESCE($3, title),
                los_days = COALESCE($4::int, los_days),
                co_pay_pct = COALESCE($5::numeric, co_pay_pct),
                deductible = COALESCE($6::numeric, deductible),
                notes = COALESCE($7, notes),
                patient_id = COALESCE($8::uuid, patient_id),
                enquirer_name = COALESCE($9, enquirer_name),
                enquirer_phone = COALESCE($10, enquirer_phone),
                updated_at = now(), updated_by = $11
          WHERE id = $1 AND hospital_id = $2 AND status = 'draft'`,
        [
          id,
          this.hospitalId(),
          body.title ?? null,
          body.losDays ?? null,
          body.coPayPct === undefined ? null : body.coPayPct.toFixed(2),
          body.deductible === undefined ? null : body.deductible.toFixed(2),
          body.notes ?? null,
          body.patientId ?? null,
          body.enquirerName ?? null,
          body.enquirerPhone ?? null,
          this.actorId(),
        ],
      );
      if (rowCount === 0) {
        throw AppError.conflict(
          'Only a draft estimate can be amended. An issued one is what the family was given — revise it instead, and both numbers survive.',
        );
      }
      // The co-pay or the stay may have moved, so the split has to be redone.
      await this.recalculate(tx, id);
      return this.loadEstimate(tx, id);
    });
  }

  /**
   * Issue it. From here the number is fixed.
   *
   * The room-class scenarios are computed now rather than on demand: "what if we
   * take a general ward bed?" is the commonest question a family asks, and the
   * answer belongs on the quote they take home rather than behind a second trip
   * to the counter.
   */
  async issueEstimate(id: string, body: IssueEstimateRequest): Promise<EstimateDetailView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();

      const { rows: before } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM billing.est_estimates WHERE id = $1 AND hospital_id = $2 FOR UPDATE`,
        [id, hospital],
      );
      const prior = before[0];
      if (prior === undefined) throw AppError.notFound('Estimate');
      if (asText(prior['status']) !== 'draft') {
        throw AppError.conflict('This estimate has already been issued.');
      }
      if (asNumber(prior['total_payable']) <= 0) {
        throw AppError.conflict(
          'This estimate totals zero. Either its lines have no rates yet or it has no lines — issuing it would give the family a number that cannot be true.',
        );
      }

      // A line at zero that is not marked `contingent` is a hole, not a
      // decision. Issuing over it hands the family a total that is quietly too
      // low, which is the exact failure this module exists to prevent — so the
      // gap is surfaced now rather than at discharge.
      const { rows: unpriced } = await tx.query<{ description: string }>(
        `SELECT description FROM billing.est_estimate_lines
          WHERE estimate_id = $1 AND unit_rate = 0 AND confidence <> 'contingent'
          ORDER BY sort_order`,
        [id],
      );
      if (unpriced.length > 0) {
        throw AppError.conflict(
          `These lines have no price yet: ${unpriced.map((u) => u.description).join(', ')}. Price them, mark them contingent, or remove them — a quote with a silent zero in it is too low, and the family finds out at discharge.`,
        );
      }

      const validTill = new Date(Date.now() + body.validDays * 86_400_000).toISOString().slice(0, 10);

      await this.buildScenarios(tx, id, prior, body.scenarioBedClassIds);

      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE billing.est_estimates
            SET status = 'issued', issued_at = now(), issued_by = $3, valid_till = $4::date,
                updated_at = now(), updated_by = $3
          WHERE id = $1 AND hospital_id = $2
          RETURNING *`,
        [id, hospital, this.actorId(), validTill],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The estimate could not be issued.');

      await tx.query(
        `INSERT INTO billing.est_estimate_events (id, hospital_id, estimate_id, kind, note, at, by_id)
         VALUES ($1,$2,$3,'issued',$4, now(),$5)`,
        [newId(), hospital, id, body.reason, this.actorId()],
      );

      await this.audit.write(tx, {
        action: 'approve',
        entity: 'est_estimate',
        rowId: id,
        businessKey: asText(row['estimate_no']),
        dataClass: 'financial',
        before: { status: 'draft' },
        after: {
          status: 'issued',
          totalPayable: asText(row['total_payable']),
          patientShare: asText(row['patient_share']),
          validTill,
        },
        reasonText: body.reason,
      });

      await this.outbox.publish(
        tx,
        estimateEvent('estimate.issued', id, {
          estimateId: id,
          estimateNo: asText(row['estimate_no']),
          patientId: asTextOrNull(row['patient_id']),
          totalPayable: asText(row['total_payable']),
          patientShare: asText(row['patient_share']),
          validTill,
          procedureCode: asTextOrNull(row['procedure_code']),
        }),
      );

      return this.loadEstimate(tx, id);
    });
  }

  /**
   * Price the same lines in other room classes.
   *
   * Only lines carrying a service can be re-resolved; a manually priced line is
   * carried across unchanged, because the desk typed that number for a reason
   * and silently re-pricing it would be inventing a figure nobody chose.
   */
  private async buildScenarios(
    tx: TransactionClient,
    id: string,
    estimate: Record<string, unknown>,
    bedClassIds: readonly string[],
  ): Promise<void> {
    const hospital = this.hospitalId();
    const branch = asText(estimate['branch_id']);
    const chosenClass = asTextOrNull(estimate['bed_class_id']);
    const chosenPayable = asNumber(estimate['total_payable']);
    const coPayPct = asNumber(estimate['co_pay_pct']);
    const deductible = asNumber(estimate['deductible']);
    const hasPayer = estimate['payer_id'] !== null || estimate['scheme_id'] !== null;
    const payerId = asTextOrNull(estimate['payer_id']);
    const schemeId = asTextOrNull(estimate['scheme_id']);

    const split = (payable: number): number => {
      if (!hasPayer) return payable;
      const coPay = Math.round(payable * (coPayPct / 100) * 100) / 100;
      return Math.min(payable, Math.round((coPay + deductible) * 100) / 100);
    };

    // The class the estimate itself assumes, so the comparison has a baseline.
    await tx.query(
      `INSERT INTO billing.est_estimate_scenarios
         (id, hospital_id, estimate_id, bed_class_id, label, total_payable, patient_share,
          delta_vs_chosen, is_chosen, created_at)
       VALUES ($1,$2,$3,$4,$5,$6::numeric,$7::numeric, 0, true, now())`,
      [newId(), hospital, id, chosenClass, 'As quoted', money(chosenPayable), money(split(chosenPayable))],
    );

    const { rows: lines } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM billing.est_estimate_lines WHERE estimate_id = $1`,
      [id],
    );

    // Deduplicated here rather than left to `ON CONFLICT`: the unique index is
    // partial (`WHERE bed_class_id IS NOT NULL`), and Postgres cannot infer a
    // partial index from a bare conflict target — it needs the predicate
    // repeated. Removing the duplicates is clearer than restating the index.
    const wanted = [...new Set(bedClassIds)].filter((b) => b !== chosenClass);

    for (const bedClassId of wanted) {
      let payable = 0;
      let repriced = 0;
      for (const l of lines) {
        const serviceId = asTextOrNull(l['service_id']);
        const qty = asNumber(l['quantity']);
        if (serviceId === null || asText(l['source']) === 'manual') {
          payable += asNumber(l['amount']) - asNumber(l['discount']);
          continue;
        }
        const resolved = await this.tariff.resolve({
          serviceId,
          branchId: branch,
          bedClassId,
          ...(payerId === null ? {} : { payerId }),
          ...(schemeId === null ? {} : { schemeId }),
        });
        if (resolved.outcome === 'missing_rate') {
          payable += asNumber(l['amount']) - asNumber(l['discount']);
        } else {
          payable += Math.round(Number(resolved.rate) * qty * 100) / 100;
          repriced += 1;
        }
      }
      payable = Math.round(payable * 100) / 100;

      // Nothing in this estimate has a rate for that class, so every line fell
      // back to the quoted one and the "alternative" would be a copy. Writing it
      // would show a family a priced comparison that was never priced; leaving
      // it out says, correctly, that we cannot answer for that class.
      if (repriced === 0) continue;

      await tx.query(
        `INSERT INTO billing.est_estimate_scenarios
           (id, hospital_id, estimate_id, bed_class_id, label, total_payable, patient_share,
            delta_vs_chosen, is_chosen, created_at)
         VALUES ($1,$2,$3,$4,$5,$6::numeric,$7::numeric,$8::numeric, false, now())`,
        [
          newId(),
          hospital,
          id,
          bedClassId,
          'Alternative room class',
          money(payable),
          money(split(payable)),
          money(Math.round((payable - chosenPayable) * 100) / 100),
        ],
      );
    }
  }

  async shareEstimate(id: string, body: ShareEstimateRequest): Promise<EstimateDetailView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM billing.est_estimates WHERE id = $1 AND hospital_id = $2`,
        [id, hospital],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.notFound('Estimate');
      if (asText(row['status']) === 'draft') {
        throw AppError.conflict('A draft cannot be sent to a family. Issue it first.');
      }

      await tx.query(
        `INSERT INTO billing.est_estimate_events (id, hospital_id, estimate_id, kind, channel, note, at, by_id)
         VALUES ($1,$2,$3,'shared',$4,$5, now(),$6)`,
        [newId(), hospital, id, body.channel, body.reason, this.actorId()],
      );

      await this.outbox.publish(
        tx,
        estimateEvent('estimate.shared', id, {
          estimateId: id,
          estimateNo: asText(row['estimate_no']),
          channel: body.channel,
        }),
      );

      return this.loadEstimate(tx, id);
    });
  }

  async recordOutcome(id: string, body: RecordOutcomeRequest): Promise<EstimateDetailView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();

      const { rows: before } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM billing.est_estimates WHERE id = $1 AND hospital_id = $2 FOR UPDATE`,
        [id, hospital],
      );
      const prior = before[0];
      if (prior === undefined) throw AppError.notFound('Estimate');
      const from = asText(prior['status']);
      if (!['issued', 'accepted'].includes(from)) {
        throw AppError.conflict(`An estimate in status "${from}" has no outcome to record.`);
      }

      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE billing.est_estimates
            SET status = $3::"billing"."EstimateStatus",
                converted_at = CASE WHEN $3 = 'converted' THEN now() ELSE converted_at END,
                converted_encounter_id = COALESCE($4::uuid, converted_encounter_id),
                decline_reason = COALESCE($5, decline_reason),
                updated_at = now(), updated_by = $6
          WHERE id = $1 AND hospital_id = $2
          RETURNING *`,
        [id, hospital, body.outcome, body.encounterId ?? null, body.reason ?? null, this.actorId()],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The outcome could not be recorded.');

      await tx.query(
        `INSERT INTO billing.est_estimate_events (id, hospital_id, estimate_id, kind, note, at, by_id)
         VALUES ($1,$2,$3,$4::"billing"."EstimateEventKind",$5, now(),$6)`,
        [newId(), hospital, id, body.outcome, body.reason ?? null, this.actorId()],
      );

      if (body.outcome === 'converted' && body.encounterId !== undefined) {
        await this.outbox.publish(
          tx,
          estimateEvent('estimate.converted', id, {
            estimateId: id,
            estimateNo: asText(row['estimate_no']),
            encounterId: body.encounterId,
            totalPayable: asText(row['total_payable']),
          }),
        );
      }
      if (body.outcome === 'declined') {
        await this.outbox.publish(
          tx,
          estimateEvent('estimate.declined', id, {
            estimateId: id,
            estimateNo: asText(row['estimate_no']),
            reason: body.reason ?? '',
          }),
        );
      }

      return this.loadEstimate(tx, id);
    });
  }

  /**
   * Revise an issued estimate by superseding it.
   *
   * The only way to change a number a family has already been given. Both
   * estimates survive, so "you told us ₹1,80,000" can be answered with what was
   * said, when, and what replaced it.
   */
  async reviseEstimate(id: string, body: CreateEstimateRequest): Promise<EstimateDetailView> {
    const previous = await this.getEstimate(id);
    if (previous.status === 'draft') {
      throw AppError.conflict('A draft has not been given to anybody. Amend it rather than revising it.');
    }

    const revision = await this.createEstimate(body);

    return this.guard(async (tx) => {
      const hospital = this.hospitalId();

      await tx.query(
        `UPDATE billing.est_estimates SET supersedes_id = $2, updated_at = now() WHERE id = $1`,
        [revision.id, id],
      );
      await tx.query(
        `UPDATE billing.est_estimates SET status = 'superseded', updated_at = now(), updated_by = $2
          WHERE id = $1 AND status NOT IN ('converted','superseded')`,
        [id, this.actorId()],
      );
      await tx.query(
        `INSERT INTO billing.est_estimate_events (id, hospital_id, estimate_id, kind, note, at, by_id)
         VALUES ($1,$2,$3,'superseded',$4, now(),$5)`,
        [newId(), hospital, id, `Superseded by ${revision.estimateNo}`, this.actorId()],
      );

      await this.outbox.publish(
        tx,
        estimateEvent('estimate.superseded', revision.id, {
          estimateId: revision.id,
          supersedesId: id,
          previousPayable: previous.totalPayable,
          newPayable: revision.totalPayable,
        }),
      );

      return this.loadEstimate(tx, revision.id);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Variance — exit gate 8
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Reconcile the quote against the bill it became.
   *
   * The database checks the arithmetic, so a variance figure cannot flatter
   * whoever recorded it. A breach above {@link VARIANCE_ALERT_PCT} raises an
   * event rather than waiting for a monthly report: the point of noticing is to
   * tell the family before discharge, not to explain it afterwards.
   */
  async recordVariance(id: string, body: RecordVarianceRequest): Promise<VarianceSampleView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();

      const { rows: est } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM billing.est_estimates WHERE id = $1 AND hospital_id = $2`,
        [id, hospital],
      );
      const e = est[0];
      if (e === undefined) throw AppError.notFound('Estimate');
      if (asText(e['status']) === 'draft') {
        throw AppError.conflict(
          'A draft was never given to anybody, so there is nothing to measure it against.',
        );
      }

      const estimated = asNumber(e['total_payable']);
      if (estimated <= 0) {
        throw AppError.conflict('This estimate has no total to measure against.');
      }

      const varianceAmount = Math.round((body.actualTotal - estimated) * 100) / 100;
      const variancePct = Math.round((varianceAmount * 10000) / estimated) / 100;
      const sampleId = newId();

      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO billing.est_variance_samples
           (id, hospital_id, estimate_id, procedure_code, template_id, bed_class_id, bill_id,
            estimated_total, actual_total, estimated_patient_share, actual_patient_share,
            variance_amount, variance_pct, estimated_los, actual_los, explanation,
            recorded_at, recorded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,
                 $8::numeric,$9::numeric,$10::numeric,$11::numeric,
                 $12::numeric,$13::numeric,$14,$15,$16, now(),$17)
         RETURNING *`,
        [
          sampleId,
          hospital,
          id,
          asTextOrNull(e['procedure_code']),
          e['template_id'] ?? null,
          e['bed_class_id'] ?? null,
          body.billId ?? null,
          money(estimated),
          money(body.actualTotal),
          asText(e['patient_share']),
          money(body.actualPatientShare),
          money(varianceAmount),
          variancePct.toFixed(2),
          asNumber(e['los_days']),
          body.actualLos ?? null,
          body.explanation ?? null,
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The variance could not be recorded.');

      await this.outbox.publish(
        tx,
        estimateEvent('estimate.variance.recorded', id, {
          estimateId: id,
          estimateNo: asText(e['estimate_no']),
          estimatedTotal: money(estimated),
          actualTotal: money(body.actualTotal),
          varianceAmount: money(Math.abs(varianceAmount)),
          variancePct: variancePct.toFixed(2),
          procedureCode: asTextOrNull(e['procedure_code']),
        }),
      );

      if (variancePct > VARIANCE_ALERT_PCT) {
        await this.outbox.publish(
          tx,
          estimateEvent('estimate.variance.breached', id, {
            estimateId: id,
            estimateNo: asText(e['estimate_no']),
            patientId: asTextOrNull(e['patient_id']),
            variancePct: variancePct.toFixed(2),
            varianceAmount: money(varianceAmount),
            thresholdPct: VARIANCE_ALERT_PCT,
          }),
        );
      }

      return this.toVariance({ ...row, estimate_no: asText(e['estimate_no']) });
    });
  }

  private toVariance(r: Record<string, unknown>): VarianceSampleView {
    return {
      id: asText(r['id']),
      estimateId: asText(r['estimate_id']),
      estimateNo: asTextOrNull(r['estimate_no']),
      procedureCode: asTextOrNull(r['procedure_code']),
      estimatedTotal: asText(r['estimated_total']),
      actualTotal: asText(r['actual_total']),
      estimatedPatientShare: asText(r['estimated_patient_share']),
      actualPatientShare: asText(r['actual_patient_share']),
      varianceAmount: asText(r['variance_amount']),
      variancePct: asText(r['variance_pct']),
      estimatedLos: asNumber(r['estimated_los']),
      actualLos: r['actual_los'] === null ? null : asNumber(r['actual_los']),
      explanation: asTextOrNull(r['explanation']),
      recordedAt: asText(r['recorded_at']),
    };
  }

  async listVariance(query: VarianceQuery): Promise<Page<VarianceSampleView>> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT s.*, e.estimate_no FROM billing.est_variance_samples s
           JOIN billing.est_estimates e ON e.id = s.estimate_id
          WHERE s.hospital_id = $1 AND ($2::text IS NULL OR s.procedure_code = $2)
          ORDER BY s.recorded_at DESC
          LIMIT $3`,
        [this.hospitalId(), query.procedureCode ?? null, query.limit + 1],
      );
      const page = rows.slice(0, query.limit);
      return {
        items: page.map((r) => this.toVariance(r)),
        nextCursor: null,
        hasMore: rows.length > query.limit,
      };
    });
  }

  /**
   * What the samples have taught us, per procedure.
   *
   * Computed from the raw samples on read rather than served from
   * `est_variance_summaries`: a summary refreshed by a job is stale exactly when
   * somebody looks at it after a bad month, and the sample counts here are small
   * enough that the percentiles cost nothing. The summary table stays for the
   * periodic snapshot a trend needs.
   */
  async varianceSummary(): Promise<{ readonly items: readonly VarianceSummaryRow[] }> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT COALESCE(procedure_code, '(unclassified)') AS procedure_code,
                count(*)                                       AS sample_count,
                round(avg(variance_pct), 2)                    AS mean_pct,
                round(percentile_cont(0.5) WITHIN GROUP (ORDER BY variance_pct)::numeric, 2) AS median_pct,
                round(percentile_cont(0.9) WITHIN GROUP (ORDER BY variance_pct)::numeric, 2) AS p90_pct,
                round(100.0 * count(*) FILTER (WHERE variance_amount > 0) / count(*), 2)     AS overrun_pct,
                round(max(variance_pct), 2)                    AS worst_pct
           FROM billing.est_variance_samples
          WHERE hospital_id = $1
          GROUP BY COALESCE(procedure_code, '(unclassified)')
          ORDER BY round(avg(variance_pct), 2) DESC`,
        [this.hospitalId()],
      );
      return {
        items: rows.map((r) => ({
          procedureCode: asText(r['procedure_code']),
          sampleCount: asNumber(r['sample_count']),
          meanVariancePct: asText(r['mean_pct']),
          medianVariancePct: asText(r['median_pct']),
          p90VariancePct: asText(r['p90_pct']),
          overrunRatePct: asText(r['overrun_pct']),
          worstVariancePct: asText(r['worst_pct']),
        })),
      };
    });
  }
}
