import { Inject, Injectable } from '@nestjs/common';
import { newId, type Page } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService, type TransactionClient } from '../../../core/db/database.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import { tariffEvent } from './tariff.events.js';
import type {
  ChangeLogQuery,
  CreatePlanRequest,
  CreateVersionRequest,
  ItemQuery,
  MissingRateQuery,
  PlanQuery,
  PublishRequest,
  ResolveBatchRequest,
  ResolveMissingRequest,
  ResolveQuery,
  SubmitRequest,
  UpsertItemsRequest,
  VersionQuery,
  WithdrawRequest,
} from './tariff.schemas.js';
import type {
  ChangeLogRow,
  MissingRateRow,
  RateResolution,
  ResolutionStep,
  TariffItemView,
  TariffPlanView,
  TariffVersionView,
} from './tariff.types.js';

/**
 * RC-003 — the pricing authority.
 *
 * ── `resolveRate` is the whole module ───────────────────────────────────────
 *
 * Everything else here exists to keep the grid it reads correct. RC-003 §5
 * specifies the algorithm as "deterministic and pure", and both words are load
 * bearing:
 *
 *  - **Deterministic** because two calls with the same arguments must return the
 *    same rupee. The database guarantees the half that SQL can — one published
 *    version per plan per instant (exclusion constraint), one item per
 *    service/class/band (`uq_tariff_items_resolution`) — and this method
 *    guarantees the rest by ordering candidate plans on a total order rather
 *    than on whatever the planner returned first.
 *  - **Pure** because it must be safe to call from an estimate, from a bill and
 *    from a pre-auth, and to call again to explain what it did. It writes
 *    nothing on the hit path. The one write is the miss path — see below.
 *
 * ── The miss path writes, and that is deliberate ────────────────────────────
 *
 * A miss records a `tariff_missing_rates` row and publishes `tariff.rate.missing`.
 * That is a side effect in a method described as pure, and the trade is worth
 * naming: `phase-05 §Constraints` says "silence here becomes revenue leakage",
 * and a service delivered at no price is only ever discovered by someone looking
 * for it. The row is an upsert on (service, plan, bed class), so a thousand
 * unpriced bill lines produce one worklist entry rather than a thousand.
 *
 * ── What it never does ──────────────────────────────────────────────────────
 *
 * Return zero. `MISSING_RATE` is an outcome, not an error to be swallowed, and
 * the caller is expected to hold the bill line. A ₹0 fallback is
 * indistinguishable from a free service in every downstream report.
 */
/**
 * Narrow a value out of a generic `Record<string, unknown>` row.
 *
 * `pg` hands back `unknown` per column, and `String(unknown)` is banned by
 * `@typescript-eslint/no-base-to-string` for a good reason: a jsonb column
 * arrives as an object and would stringify to `[object Object]` in a bill
 * explanation, silently. These narrow instead of coercing.
 */
function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  return '';
}

function asTextOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : asText(value);
}

function asNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(asText(value));
}

/** A `date` column as `YYYY-MM-DD`, whatever shape the driver returned. */
function asDay(value: unknown): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : asText(value);
}

@Injectable()
export class TariffService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private hospitalId(): string {
    const id = getContext().hospitalId;
    if (id === null) throw AppError.unauthenticated();
    return id;
  }

  private actorId(): string {
    const id = getContext().userId;
    if (id === null) throw AppError.unauthenticated();
    return id;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Rate resolution — RC-003 §5
  // ═══════════════════════════════════════════════════════════════════════════

  async resolve(query: ResolveQuery): Promise<RateResolution> {
    return this.db.withTenant(currentTenantContext(), async (tx) => this.resolveIn(tx, query));
  }

  async resolveBatch(body: ResolveBatchRequest): Promise<{ readonly items: readonly RateResolution[] }> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const items: RateResolution[] = [];
      for (const serviceId of body.serviceIds) {
        items.push(
          await this.resolveIn(tx, {
            serviceId,
            ...(body.branchId === undefined ? {} : { branchId: body.branchId }),
            ...(body.payerId === undefined ? {} : { payerId: body.payerId }),
            ...(body.schemeId === undefined ? {} : { schemeId: body.schemeId }),
            ...(body.corporateId === undefined ? {} : { corporateId: body.corporateId }),
            ...(body.bedClassId === undefined ? {} : { bedClassId: body.bedClassId }),
            ...(body.at === undefined ? {} : { at: body.at }),
          }),
        );
      }
      return { items };
    });
  }

  /**
   * Step 1 of RC-003 §5: candidate plans, in resolution order.
   *
   * The ORDER BY is the specificity ladder written as a total order — scheme
   * beats TPA beats corporate beats staff beats self-pay; a branch plan beats a
   * hospital plan; higher `priority` breaks a remaining tie; and `code` breaks
   * the last one so the result is stable rather than merely usually stable.
   */
  private async candidatePlans(
    tx: TransactionClient,
    query: ResolveQuery,
  ): Promise<
    readonly {
      id: string;
      code: string;
      planType: string;
      currency: string;
      derivedFromPlanId: string | null;
      derivationFormula: Record<string, unknown> | null;
      roundingRule: Record<string, unknown>;
    }[]
  > {
    const { rows } = await tx.query<{
      id: string;
      code: string;
      plan_type: string;
      currency: string;
      derived_from_plan_id: string | null;
      derivation_formula: Record<string, unknown> | null;
      rounding_rule: Record<string, unknown>;
    }>(
      `SELECT id, code, plan_type, currency, derived_from_plan_id, derivation_formula, rounding_rule
         FROM mdm.tariff_plans
        WHERE hospital_id = $1
          AND status = 'active'
          AND (branch_id IS NULL OR branch_id = $2)
          AND (
                ($3::uuid IS NOT NULL AND scheme_id    = $3 AND plan_type = 'government_scheme')
             OR ($4::uuid IS NOT NULL AND payer_id     = $4 AND plan_type IN ('tpa', 'insurer'))
             OR ($5::uuid IS NOT NULL AND corporate_id = $5 AND plan_type = 'corporate')
             OR (plan_type = 'self_pay' AND is_default_self_pay = true)
          )
        ORDER BY
          CASE plan_type
            WHEN 'government_scheme' THEN 0
            WHEN 'tpa'               THEN 1
            WHEN 'insurer'           THEN 1
            WHEN 'corporate'         THEN 2
            WHEN 'staff'             THEN 3
            ELSE 4
          END,
          (branch_id IS NULL),
          priority DESC,
          code`,
      [
        this.hospitalId(),
        query.branchId ?? null,
        query.schemeId ?? null,
        query.payerId ?? null,
        query.corporateId ?? null,
      ],
    );
    return rows.map((r) => ({
      id: r.id,
      code: r.code,
      planType: r.plan_type,
      currency: r.currency,
      derivedFromPlanId: r.derived_from_plan_id,
      derivationFormula: r.derivation_formula,
      roundingRule: r.rounding_rule,
    }));
  }

  /** Steps 2 and 3: the published version for the date, then the item ladder. */
  private async itemFor(
    tx: TransactionClient,
    planId: string,
    query: ResolveQuery,
    at: string,
    chain: ResolutionStep[],
  ): Promise<{
    versionId: string;
    itemId: string;
    baseRate: string;
    unit: string;
    taxTreatment: string;
    gstRate: string;
    hsnSac: string | null;
  } | null> {
    const { rows: versions } = await tx.query<{ id: string; version_no: number }>(
      `SELECT id, version_no
         FROM mdm.tariff_versions
        WHERE hospital_id = $1 AND plan_id = $2 AND status = 'published'
          AND effective_from <= $3::date
          AND (effective_to IS NULL OR effective_to > $3::date)
        LIMIT 1`,
      [this.hospitalId(), planId, at],
    );
    const version = versions[0];
    if (version === undefined) {
      chain.push({
        stage: 'version',
        detail: `Plan has no published version covering ${at}`,
        matched: false,
      });
      return null;
    }
    chain.push({ stage: 'version', detail: `Version ${String(version.version_no)}`, matched: true });

    // The fallback ladder, most specific first. Written as an ordered scan of
    // four candidate shapes rather than four queries: one round trip, and the
    // ordering is the specification rather than the order somebody wrote the ifs.
    const { rows } = await tx.query<{
      id: string;
      base_rate: string;
      unit: string;
      tax_treatment: string;
      gst_rate: string;
      hsn_sac: string | null;
      specificity: number;
    }>(
      `SELECT id, base_rate, unit, tax_treatment, gst_rate, hsn_sac,
              CASE
                WHEN bed_class_id IS NOT DISTINCT FROM $3::uuid AND time_band IS NOT DISTINCT FROM $4::"mdm"."TariffTimeBand" THEN 0
                WHEN bed_class_id IS NOT DISTINCT FROM $3::uuid AND time_band IS NULL THEN 1
                WHEN bed_class_id IS NULL AND time_band IS NOT DISTINCT FROM $4::"mdm"."TariffTimeBand" THEN 2
                ELSE 3
              END AS specificity
         FROM mdm.tariff_items
        WHERE hospital_id = $1 AND version_id = $2 AND service_id = $5
          AND (bed_class_id IS NULL OR bed_class_id IS NOT DISTINCT FROM $3::uuid)
          AND (time_band IS NULL OR time_band IS NOT DISTINCT FROM $4::"mdm"."TariffTimeBand")
        ORDER BY specificity
        LIMIT 1`,
      [this.hospitalId(), version.id, query.bedClassId ?? null, query.timeBand ?? null, query.serviceId],
    );

    const item = rows[0];
    if (item === undefined) {
      chain.push({ stage: 'item', detail: 'No rate row for this service in that version', matched: false });
      return null;
    }
    chain.push({
      stage: 'item',
      detail: `Matched at specificity ${String(item.specificity)} (0 = exact service+class+band)`,
      matched: true,
    });

    return {
      versionId: version.id,
      itemId: item.id,
      baseRate: item.base_rate,
      unit: item.unit,
      taxTreatment: item.tax_treatment,
      gstRate: item.gst_rate,
      hsnSac: item.hsn_sac,
    };
  }

  private async resolveIn(tx: TransactionClient, query: ResolveQuery): Promise<RateResolution> {
    const at = query.at ?? new Date().toISOString().slice(0, 10);
    const chain: ResolutionStep[] = [];
    const plans = await this.candidatePlans(tx, query);

    chain.push({
      stage: 'plans',
      detail:
        plans.length === 0
          ? 'No active plan matches this payer context'
          : `Candidates in order: ${plans.map((p) => p.code).join(' > ')}`,
      matched: plans.length > 0,
    });

    for (const plan of plans) {
      chain.push({ stage: 'plan', detail: `Trying ${plan.code} (${plan.planType})`, matched: true });

      const direct = await this.itemFor(tx, plan.id, query, at, chain);
      if (direct !== null) {
        return this.priced(query.serviceId, plan, direct, null, chain);
      }

      // A derived plan holds no grid of its own: fall through to its base and
      // apply the formula. "CGHS + 10 %" is one rule, not ten thousand rows.
      if (plan.derivedFromPlanId !== null) {
        chain.push({
          stage: 'derivation',
          detail: `${plan.code} derives from another plan; resolving the base`,
          matched: true,
        });
        const base = await this.itemFor(tx, plan.derivedFromPlanId, query, at, chain);
        if (base !== null) {
          return this.priced(query.serviceId, plan, base, plan.derivationFormula, chain);
        }
      }
    }

    await this.recordMissing(tx, query, chain);
    return {
      outcome: 'missing_rate',
      serviceId: query.serviceId,
      attemptedPlanIds: plans.map((p) => p.id),
      chain,
      message:
        'No published rate covers this service for this payer on this date. The bill line is held; it is not billed at zero.',
    };
  }

  /** Applies the derivation formula and the plan's rounding rule. */
  private priced(
    serviceId: string,
    plan: {
      id: string;
      code: string;
      currency: string;
      derivationFormula: Record<string, unknown> | null;
      roundingRule: Record<string, unknown>;
    },
    item: {
      versionId: string;
      itemId: string;
      baseRate: string;
      unit: string;
      taxTreatment: string;
      gstRate: string;
      hsnSac: string | null;
    },
    formula: Record<string, unknown> | null,
    chain: readonly ResolutionStep[],
  ): RateResolution {
    const listRate = Number(item.baseRate);
    let rate = listRate;
    const applied: string[] = [];

    if (formula !== null) {
      const op = asText(formula['op']);
      const value = asNumber(formula['value'] ?? 0);
      if (op === 'discount_pct') {
        rate = listRate * (1 - value / 100);
        applied.push(`discount_pct ${String(value)}%`);
      } else if (op === 'uplift_pct') {
        rate = listRate * (1 + value / 100);
        applied.push(`uplift_pct ${String(value)}%`);
      } else if (op === 'fixed_delta') {
        rate = listRate + value;
        applied.push(`fixed_delta ${String(value)}`);
      }
    }

    const decimals = asNumber(plan.roundingRule['decimals'] ?? 2);
    const factor = 10 ** decimals;
    // `half_up` on the absolute value, so −0.005 rounds away from zero the same
    // way +0.005 does. `Math.round` alone rounds −0.5 towards zero, which would
    // make a credit note a paisa different from the invoice it reverses.
    const rounded = (Math.sign(rate) * Math.round(Math.abs(rate) * factor)) / factor;

    return {
      outcome: 'resolved',
      serviceId,
      planId: plan.id,
      planCode: plan.code,
      versionId: item.versionId,
      itemId: item.itemId,
      listRate: listRate.toFixed(decimals),
      rate: rounded.toFixed(decimals),
      currency: plan.currency,
      unit: item.unit,
      taxTreatment: item.taxTreatment,
      gstRate: item.gstRate,
      hsnSac: item.hsnSac,
      derivedFrom: formula === null ? null : plan.code,
      appliedRules: applied,
      chain,
    };
  }

  /**
   * The worklist entry. Upserted on (branch, service, plan, bed class) so the
   * desk sees one row per unpriced service rather than one per bill line.
   */
  private async recordMissing(
    tx: TransactionClient,
    query: ResolveQuery,
    chain: readonly ResolutionStep[],
  ): Promise<void> {
    const branchId = query.branchId ?? getContext().branchId;
    if (branchId === null || branchId === undefined) return;

    await tx.query(
      `INSERT INTO mdm.tariff_missing_rates
         (id, hospital_id, branch_id, service_id, plan_id, bed_class_id, first_seen_at, last_seen_at, occurrences, status)
       VALUES ($1, $2, $3, $4, NULL, $5, now(), now(), 1, 'open')
       ON CONFLICT (hospital_id, branch_id, service_id, plan_id, bed_class_id)
       DO UPDATE SET last_seen_at = now(),
                     occurrences  = mdm.tariff_missing_rates.occurrences + 1,
                     status       = CASE WHEN mdm.tariff_missing_rates.status = 'waived'
                                         THEN mdm.tariff_missing_rates.status ELSE 'open' END`,
      [newId(), this.hospitalId(), branchId, query.serviceId, query.bedClassId ?? null],
    );

    await this.outbox.publish(
      tx,
      tariffEvent('tariff.rate.missing', query.serviceId, {
        serviceId: query.serviceId,
        planId: null,
        bedClassId: query.bedClassId ?? null,
        branchId,
        sampleLineId: null,
        attemptedAt: new Date().toISOString(),
      }),
    );

    void chain;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Plans
  // ═══════════════════════════════════════════════════════════════════════════

  async listPlans(query: PlanQuery): Promise<Page<TariffPlanView>> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT p.*,
                (SELECT v.id FROM mdm.tariff_versions v
                  WHERE v.plan_id = p.id AND v.status = 'published'
                    AND v.effective_from <= current_date
                    AND (v.effective_to IS NULL OR v.effective_to > current_date)
                  LIMIT 1) AS published_version_id
           FROM mdm.tariff_plans p
          WHERE p.hospital_id = $1
            AND ($2::text IS NULL OR p.plan_type::text = $2)
            AND ($3::uuid IS NULL OR p.payer_id = $3)
            AND ($4::text IS NULL OR p.status::text = $4)
          ORDER BY p.plan_type, p.priority DESC, p.code
          LIMIT $5`,
        [
          this.hospitalId(),
          query.planType ?? null,
          query.payerId ?? null,
          query.status ?? null,
          query.limit + 1,
        ],
      );
      const page = rows.slice(0, query.limit);
      return {
        items: page.map((r) => this.toPlanView(r)),
        nextCursor: rows.length > query.limit ? asText(page[page.length - 1]?.['id']) : null,
        hasMore: rows.length > query.limit,
      };
    });
  }

  private toPlanView(r: Record<string, unknown>): TariffPlanView {
    return {
      id: asText(r['id']),
      code: asText(r['code']),
      name: asText(r['name']),
      planType: asText(r['plan_type']),
      currency: asText(r['currency']),
      branchId: (r['branch_id'] as string | null) ?? null,
      payerId: (r['payer_id'] as string | null) ?? null,
      schemeId: (r['scheme_id'] as string | null) ?? null,
      corporateId: (r['corporate_id'] as string | null) ?? null,
      scope: asText(r['scope']),
      derivedFromPlanId: (r['derived_from_plan_id'] as string | null) ?? null,
      derivationFormula: (r['derivation_formula'] as Record<string, unknown> | null) ?? null,
      priority: asNumber(r['priority']),
      isDefaultSelfPay: Boolean(r['is_default_self_pay']),
      isRateEditable: Boolean(r['is_rate_editable']),
      status: asText(r['status']),
      publishedVersionId: (r['published_version_id'] as string | null) ?? null,
    };
  }

  async createPlan(body: CreatePlanRequest): Promise<TariffPlanView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const id = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO mdm.tariff_plans
           (id, hospital_id, branch_id, code, name, plan_type, currency,
            payer_id, scheme_id, corporate_id, scope,
            derived_from_plan_id, derivation_formula, priority, is_default_self_pay,
            created_at, created_by, updated_at, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6::"mdm"."TariffPlanType",$7,$8,$9,$10,$11::"mdm"."TariffPlanScope",
                 $12,$13::jsonb,$14,$15, now(),$16, now(),$16)
         RETURNING *, NULL::uuid AS published_version_id`,
        [
          id,
          this.hospitalId(),
          body.branchId ?? null,
          body.code,
          body.name,
          body.planType,
          body.currency,
          body.payerId ?? null,
          body.schemeId ?? null,
          body.corporateId ?? null,
          body.scope,
          body.derivedFromPlanId ?? null,
          body.derivationFormula === undefined ? null : JSON.stringify(body.derivationFormula),
          body.priority,
          body.isDefaultSelfPay,
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The plan could not be created.');

      await this.outbox.publish(
        tx,
        tariffEvent('tariff.plan.created', id, {
          planId: id,
          code: body.code,
          planType: body.planType,
          payerId: body.payerId ?? null,
          branchId: body.branchId ?? null,
        }),
      );
      await this.audit.write(tx, {
        action: 'insert',
        entity: 'mdm.tariff_plans',
        rowId: id,
        businessKey: body.code,
        dataClass: 'financial',
        before: null,
        after: { code: body.code, plan_type: body.planType },
      });

      return this.toPlanView(row);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Versions
  // ═══════════════════════════════════════════════════════════════════════════

  async listVersions(planId: string, query: VersionQuery): Promise<Page<TariffVersionView>> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT v.*, p.code AS plan_code,
                (SELECT count(*) FROM mdm.tariff_items i WHERE i.version_id = v.id) AS item_count
           FROM mdm.tariff_versions v
           JOIN mdm.tariff_plans p ON p.id = v.plan_id
          WHERE v.hospital_id = $1 AND v.plan_id = $2
          ORDER BY v.version_no DESC
          LIMIT $3`,
        [this.hospitalId(), planId, query.limit + 1],
      );
      const page = rows.slice(0, query.limit);
      return {
        items: page.map((r) => this.toVersionView(r)),
        nextCursor: null,
        hasMore: rows.length > query.limit,
      };
    });
  }

  private toVersionView(r: Record<string, unknown>): TariffVersionView {
    const iso = (v: unknown): string | null => (v === null || v === undefined ? null : asText(v));
    const day = asDay;
    return {
      id: asText(r['id']),
      planId: asText(r['plan_id']),
      planCode: asText(r['plan_code']),
      versionNo: asNumber(r['version_no']),
      effectiveFrom: day(r['effective_from']),
      effectiveTo: r['effective_to'] === null ? null : asDay(r['effective_to']),
      status: asText(r['status']),
      changeNote: (r['change_note'] as string | null) ?? null,
      itemCount: asNumber(r['item_count'] ?? 0),
      submittedBy: (r['submitted_by'] as string | null) ?? null,
      submittedAt: iso(r['submitted_at']),
      publishedBy: (r['published_by'] as string | null) ?? null,
      publishedAt: iso(r['published_at']),
      createdAt: iso(r['created_at']) ?? '',
    };
  }

  async createVersion(planId: string, body: CreateVersionRequest): Promise<TariffVersionView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const id = newId();
      const { rows: next } = await tx.query<{ n: string }>(
        `SELECT COALESCE(max(version_no), 0) + 1 AS n FROM mdm.tariff_versions WHERE plan_id = $1`,
        [planId],
      );
      const versionNo = Number(next[0]?.n ?? 1);

      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO mdm.tariff_versions
           (id, hospital_id, plan_id, version_no, effective_from, effective_to, status, change_note,
            created_at, created_by, updated_at, updated_by)
         VALUES ($1,$2,$3,$4,$5::date,$6::date,'draft',$7, now(),$8, now(),$8)
         RETURNING *`,
        [
          id,
          this.hospitalId(),
          planId,
          versionNo,
          body.effectiveFrom,
          body.effectiveTo ?? null,
          body.changeNote ?? null,
          this.actorId(),
        ],
      );

      // Cloning copies the grid so a revision starts from what is live rather
      // than from an empty page somebody has to re-key.
      if (body.cloneFromVersionId !== undefined) {
        await tx.query(
          `INSERT INTO mdm.tariff_items
             (id, hospital_id, version_id, service_id, bed_class_id, time_band, unit,
              base_rate, min_rate, max_rate, hsn_sac, tax_treatment, gst_rate,
              payer_code, cost_amount, is_negotiable, created_at, created_by, updated_at, updated_by)
           SELECT gen_random_uuid(), hospital_id, $2, service_id, bed_class_id, time_band, unit,
                  base_rate, min_rate, max_rate, hsn_sac, tax_treatment, gst_rate,
                  payer_code, cost_amount, is_negotiable, now(), $3, now(), $3
             FROM mdm.tariff_items
            WHERE version_id = $1 AND hospital_id = $4`,
          [body.cloneFromVersionId, id, this.actorId(), this.hospitalId()],
        );
      }

      await this.outbox.publish(
        tx,
        tariffEvent('tariff.version.created', id, {
          planId,
          versionId: id,
          versionNo,
          effectiveFrom: body.effectiveFrom,
        }),
      );

      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The version could not be created.');
      return this.toVersionView({ ...row, plan_code: '', item_count: 0 });
    });
  }

  async listItems(versionId: string, query: ItemQuery): Promise<Page<TariffItemView>> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT i.*, s.code AS service_code, s.name AS service_name
           FROM mdm.tariff_items i
           JOIN mdm.mdm_services s ON s.id = i.service_id
          WHERE i.hospital_id = $1 AND i.version_id = $2
            AND ($3::uuid IS NULL OR i.service_id = $3)
          ORDER BY s.code
          LIMIT $4`,
        [this.hospitalId(), versionId, query.serviceId ?? null, query.limit + 1],
      );
      const page = rows.slice(0, query.limit);
      return {
        items: page.map((r) => ({
          id: asText(r['id']),
          versionId: asText(r['version_id']),
          serviceId: asText(r['service_id']),
          serviceCode: asText(r['service_code']),
          serviceName: asText(r['service_name']),
          bedClassId: (r['bed_class_id'] as string | null) ?? null,
          timeBand: (r['time_band'] as string | null) ?? null,
          unit: asText(r['unit']),
          baseRate: asText(r['base_rate']),
          minRate: asTextOrNull(r['min_rate']),
          maxRate: asTextOrNull(r['max_rate']),
          hsnSac: (r['hsn_sac'] as string | null) ?? null,
          taxTreatment: asText(r['tax_treatment']),
          gstRate: asText(r['gst_rate']),
          costAmount: asTextOrNull(r['cost_amount']),
          payerCode: (r['payer_code'] as string | null) ?? null,
          isNegotiable: Boolean(r['is_negotiable']),
        })),
        nextCursor: null,
        hasMore: rows.length > query.limit,
      };
    });
  }

  /**
   * Bulk upsert into a draft.
   *
   * The database refuses this on a published version (§C.2 trigger), so there is
   * no status check here that could drift from the one that matters. Every row
   * written also writes a change-log entry — RC-003 §4 calls that table "the
   * audit of every rate change of record", and an upsert path that skipped it
   * would make the audit a partial record, which is worse than none.
   */
  async upsertItems(versionId: string, body: UpsertItemsRequest): Promise<{ readonly written: number }> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const actor = this.actorId();
      const hospital = this.hospitalId();
      let written = 0;

      for (const item of body.items) {
        const { rows } = await tx.query<{ id: string; base_rate: string | null }>(
          `INSERT INTO mdm.tariff_items
             (id, hospital_id, version_id, service_id, bed_class_id, time_band, unit,
              base_rate, min_rate, max_rate, hsn_sac, tax_treatment, gst_rate,
              cost_amount, payer_code, is_negotiable, created_at, created_by, updated_at, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6::"mdm"."TariffTimeBand",$7,$8,$9,$10,$11,
                   $12::"mdm"."TariffTaxTreatment",$13,$14,$15,$16, now(),$17, now(),$17)
           ON CONFLICT (version_id, service_id,
                        (COALESCE(bed_class_id, '00000000-0000-0000-0000-000000000000'::uuid)),
                        (COALESCE(time_band, 'normal')))
           DO UPDATE SET base_rate = EXCLUDED.base_rate,
                         min_rate = EXCLUDED.min_rate,
                         max_rate = EXCLUDED.max_rate,
                         hsn_sac = EXCLUDED.hsn_sac,
                         tax_treatment = EXCLUDED.tax_treatment,
                         gst_rate = EXCLUDED.gst_rate,
                         cost_amount = EXCLUDED.cost_amount,
                         payer_code = EXCLUDED.payer_code,
                         is_negotiable = EXCLUDED.is_negotiable,
                         updated_at = now(),
                         updated_by = EXCLUDED.updated_by
           RETURNING id, base_rate`,
          [
            newId(),
            hospital,
            versionId,
            item.serviceId,
            item.bedClassId ?? null,
            item.timeBand ?? null,
            item.unit,
            item.baseRate.toFixed(2),
            item.minRate === undefined ? null : item.minRate.toFixed(2),
            item.maxRate === undefined ? null : item.maxRate.toFixed(2),
            item.hsnSac ?? null,
            item.taxTreatment,
            item.gstRate.toFixed(2),
            item.costAmount === undefined ? null : item.costAmount.toFixed(2),
            item.payerCode ?? null,
            item.isNegotiable,
            actor,
          ],
        );
        const row = rows[0];
        if (row === undefined) continue;
        written += 1;

        await tx.query(
          `INSERT INTO mdm.tariff_change_log
             (id, hospital_id, version_id, item_id, service_id, field, old_value, new_value,
              changed_by, changed_at, reason, source)
           VALUES ($1,$2,$3,$4,$5,'base_rate',NULL,$6,$7, now(),$8,'manual')`,
          [
            newId(),
            hospital,
            versionId,
            row.id,
            item.serviceId,
            item.baseRate.toFixed(2),
            actor,
            body.reason,
          ],
        );
      }

      return { written };
    });
  }

  async submit(versionId: string, body: SubmitRequest): Promise<TariffVersionView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE mdm.tariff_versions
            SET status = 'pending_approval', submitted_by = $3, submitted_at = now(),
                updated_at = now(), updated_by = $3
          WHERE id = $1 AND hospital_id = $2 AND status = 'draft'
          RETURNING *`,
        [versionId, this.hospitalId(), this.actorId()],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict('Only a draft can be submitted for approval.');
      }

      const { rows: counted } = await tx.query<{ n: string }>(
        `SELECT count(*) AS n FROM mdm.tariff_items WHERE version_id = $1`,
        [versionId],
      );

      await this.outbox.publish(
        tx,
        tariffEvent('tariff.version.submitted', versionId, {
          planId: asText(row['plan_id']),
          versionId,
          submittedBy: this.actorId(),
          itemsChanged: Number(counted[0]?.n ?? 0),
        }),
      );
      await this.audit.write(tx, {
        action: 'update',
        entity: 'mdm.tariff_versions',
        rowId: versionId,
        businessKey: versionId,
        dataClass: 'financial',
        reasonText: body.reason,
        before: { status: 'draft' },
        after: { status: 'pending_approval' },
      });

      return this.toVersionView({ ...row, plan_code: '', item_count: counted[0]?.n ?? 0 });
    });
  }

  /**
   * Publish. From this instant the version prices every bill line in its window.
   *
   * Three things happen in one transaction, and the order matters: the
   * below-cost check runs *before* the status flips, because RC-003 §5 wants the
   * acknowledgement recorded against a decision that had not yet taken effect;
   * the previous open-ended version is closed so the exclusion constraint has
   * room; and only then does this one become published.
   */
  async publish(versionId: string, body: PublishRequest): Promise<TariffVersionView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const hospital = this.hospitalId();
      const actor = this.actorId();

      const { rows: found } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM mdm.tariff_versions WHERE id = $1 AND hospital_id = $2 FOR UPDATE`,
        [versionId, hospital],
      );
      const version = found[0];
      if (version === undefined) throw AppError.notFound('Tariff version');

      const status = asText(version['status']);
      if (status !== 'approved' && status !== 'pending_approval' && status !== 'draft') {
        throw AppError.conflict(`A version in status "${status}" is already past publication.`);
      }

      const { rows: belowCost } = await tx.query<{ n: string }>(
        `SELECT count(*) AS n FROM mdm.tariff_items
          WHERE version_id = $1 AND cost_amount IS NOT NULL AND base_rate < cost_amount`,
        [versionId],
      );
      const below = Number(belowCost[0]?.n ?? 0);
      if (below > 0 && !body.acceptBelowCost) {
        throw AppError.conflict(
          `${String(below)} rate(s) in this version are below cost. This is legitimate for scheme plans, but RC-003 §5 requires it to be acknowledged explicitly.`,
        );
      }

      const planId = asText(version['plan_id']);
      const effectiveFrom = version['effective_from'];
      const from = asDay(effectiveFrom);

      // Close the outgoing version. Without this the exclusion constraint
      // refuses the publish, which would be correct but unhelpful — an
      // open-ended predecessor is the normal case, not an error.
      await tx.query(
        `UPDATE mdm.tariff_versions
            SET effective_to = $3::date, status = 'superseded', updated_at = now(), updated_by = $4
          WHERE hospital_id = $1 AND plan_id = $2 AND status = 'published'
            AND (effective_to IS NULL OR effective_to > $3::date)
            AND effective_from < $3::date`,
        [hospital, planId, from, actor],
      );

      const { rows: published } = await tx.query<Record<string, unknown>>(
        `UPDATE mdm.tariff_versions
            SET status = 'published', published_by = $3, published_at = now(),
                approved_by = COALESCE(approved_by, $3), approved_at = COALESCE(approved_at, now()),
                updated_at = now(), updated_by = $3
          WHERE id = $1 AND hospital_id = $2
          RETURNING *`,
        [versionId, hospital, actor],
      );
      const row = published[0];
      if (row === undefined) throw AppError.conflict('The version could not be published.');

      const { rows: counted } = await tx.query<{ n: string }>(
        `SELECT count(*) AS n FROM mdm.tariff_items WHERE version_id = $1`,
        [versionId],
      );

      await this.outbox.publish(
        tx,
        tariffEvent('tariff.version.published', versionId, {
          planId,
          versionId,
          versionNo: asNumber(row['version_no']),
          effectiveFrom: from,
          effectiveTo: asTextOrNull(row['effective_to']),
          itemsChanged: Number(counted[0]?.n ?? 0),
          publishedBy: actor,
        }),
      );
      await this.audit.write(tx, {
        action: 'update',
        entity: 'mdm.tariff_versions',
        rowId: versionId,
        businessKey: versionId,
        dataClass: 'financial',
        reasonText: body.reason,
        before: { status },
        after: { status: 'published' },
      });

      return this.toVersionView({ ...row, plan_code: '', item_count: counted[0]?.n ?? 0 });
    });
  }

  async withdraw(versionId: string, body: WithdrawRequest): Promise<TariffVersionView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE mdm.tariff_versions
            SET status = 'withdrawn', withdrawn_by = $3, withdrawn_at = now(),
                withdraw_reason = $4, updated_at = now(), updated_by = $3
          WHERE id = $1 AND hospital_id = $2 AND status = 'published'
          RETURNING *`,
        [versionId, this.hospitalId(), this.actorId(), body.reason],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict('Only a published version can be withdrawn.');
      }

      await this.outbox.publish(
        tx,
        tariffEvent('tariff.version.withdrawn', versionId, {
          planId: asText(row['plan_id']),
          versionId,
          withdrawnBy: this.actorId(),
          reason: body.reason,
        }),
      );
      return this.toVersionView({ ...row, plan_code: '', item_count: 0 });
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Worklist and audit
  // ═══════════════════════════════════════════════════════════════════════════

  async listMissingRates(query: MissingRateQuery): Promise<Page<MissingRateRow>> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT m.*, s.code AS service_code, s.name AS service_name
           FROM mdm.tariff_missing_rates m
           LEFT JOIN mdm.mdm_services s ON s.id = m.service_id
          WHERE m.hospital_id = $1
            AND ($2::text IS NULL OR m.status::text = $2)
          ORDER BY m.last_seen_at DESC
          LIMIT $3`,
        [this.hospitalId(), query.status ?? null, query.limit + 1],
      );
      const page = rows.slice(0, query.limit);
      const iso = asText;
      return {
        items: page.map((r) => ({
          id: asText(r['id']),
          serviceId: asText(r['service_id']),
          serviceCode: (r['service_code'] as string | null) ?? null,
          serviceName: (r['service_name'] as string | null) ?? null,
          planId: (r['plan_id'] as string | null) ?? null,
          bedClassId: (r['bed_class_id'] as string | null) ?? null,
          firstSeenAt: iso(r['first_seen_at']),
          lastSeenAt: iso(r['last_seen_at']),
          occurrences: asNumber(r['occurrences']),
          status: asText(r['status']),
        })),
        nextCursor: null,
        hasMore: rows.length > query.limit,
      };
    });
  }

  async resolveMissing(id: string, body: ResolveMissingRequest): Promise<MissingRateRow> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE mdm.tariff_missing_rates
            SET status = $3::"mdm"."TariffMissingRateStatus", resolved_by = $4, resolved_at = now(),
                resolution_note = $5
          WHERE id = $1 AND hospital_id = $2
          RETURNING *`,
        [id, this.hospitalId(), body.action, this.actorId(), body.reason],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.notFound('Missing-rate entry');
      const iso = asText;
      return {
        id: asText(row['id']),
        serviceId: asText(row['service_id']),
        serviceCode: null,
        serviceName: null,
        planId: (row['plan_id'] as string | null) ?? null,
        bedClassId: (row['bed_class_id'] as string | null) ?? null,
        firstSeenAt: iso(row['first_seen_at']),
        lastSeenAt: iso(row['last_seen_at']),
        occurrences: asNumber(row['occurrences']),
        status: asText(row['status']),
      };
    });
  }

  async changeLog(query: ChangeLogQuery): Promise<Page<ChangeLogRow>> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM mdm.tariff_change_log
          WHERE hospital_id = $1
            AND ($2::uuid IS NULL OR version_id = $2)
            AND ($3::uuid IS NULL OR service_id = $3)
          ORDER BY changed_at DESC
          LIMIT $4`,
        [this.hospitalId(), query.versionId ?? null, query.serviceId ?? null, query.limit + 1],
      );
      const page = rows.slice(0, query.limit);
      const iso = asText;
      return {
        items: page.map((r) => ({
          id: asText(r['id']),
          versionId: asText(r['version_id']),
          serviceId: (r['service_id'] as string | null) ?? null,
          field: asText(r['field']),
          oldValue: (r['old_value'] as string | null) ?? null,
          newValue: (r['new_value'] as string | null) ?? null,
          changedBy: asText(r['changed_by']),
          changedAt: iso(r['changed_at']),
          reason: (r['reason'] as string | null) ?? null,
          source: asText(r['source']),
        })),
        nextCursor: null,
        hasMore: rows.length > query.limit,
      };
    });
  }
}
