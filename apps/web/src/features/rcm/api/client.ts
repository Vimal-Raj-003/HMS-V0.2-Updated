import type { Page } from '@vims/contracts';
import { newIdempotencyKey, queryString, request } from './http';
import type {
  BillDetailView,
  BillSummaryView,
  BillingExceptionView,
  ChangeLogRow,
  CreateVersionRequest,
  DecideDiscountRequest,
  DiscountRequestView,
  FinalizeRequest,
  MissingRateRow,
  PackageActivationView,
  PackageView,
  PreauthDetailView,
  PreauthQueryView,
  PreauthView,
  PayIntentView,
  PayPaymentView,
  PayReconExceptionView,
  PayRefundView,
  PublishRequest,
  RateResolution,
  ReasonRequest,
  RequestDiscountRequest,
  VarianceRequestView,
  EstimateDetailView,
  EstimateVarianceSummaryRow,
  EstimateVarianceView,
  EstimateView,
  LeakDashboardView,
  LeakFindingDetailView,
  LeakFindingView,
  LeakScanView,
  PayoutPeriodView,
  PayoutStatementDetailView,
  PayoutStatementView,
  ResolveMissingRequest,
  SchemeCaseDetailView,
  SchemeCaseView,
  SchemeCashAttemptView,
  SchemeClaimDetailView,
  SchemeClaimView,
  SchemeShortfallView,
  SchemeView,
  TariffItemView,
  TariffPlanView,
  TariffVersionView,
} from './types';

/**
 * Every call the tariff console makes.
 *
 * The rules are the ones every other feature client follows: nothing catches,
 * nothing retries, every write carries an idempotency key minted once per
 * intent, and every list is server-paginated. One addition specific to RC-003 —
 * **`resolveRate` is never called speculatively**. It is a read, but a miss
 * writes a worklist row and raises `tariff.rate.missing`, so a screen that
 * resolved on every keystroke would manufacture a leakage alert per character.
 */

const V1 = '/api/v1';

interface Signal {
  readonly signal?: AbortSignal;
}

function withSignal(options: Signal): { signal?: AbortSignal } {
  return options.signal === undefined ? {} : { signal: options.signal };
}

export const PAGE_LIMIT = 50;

export async function listPlans(
  filters: { readonly planType?: string | undefined; readonly status?: string | undefined } = {},
  options: Signal = {},
): Promise<Page<TariffPlanView>> {
  return request(
    `${V1}/tariff/plans${queryString({
      planType: filters.planType,
      status: filters.status,
      limit: PAGE_LIMIT,
    })}`,
    withSignal(options),
  );
}

export async function listVersions(planId: string, options: Signal = {}): Promise<Page<TariffVersionView>> {
  return request(
    `${V1}/tariff/plans/${planId}/versions${queryString({ limit: PAGE_LIMIT })}`,
    withSignal(options),
  );
}

export async function createVersion(
  planId: string,
  body: CreateVersionRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<TariffVersionView> {
  return request(`${V1}/tariff/plans/${planId}/versions`, { method: 'POST', body, idempotencyKey });
}

export async function listItems(versionId: string, options: Signal = {}): Promise<Page<TariffItemView>> {
  return request(
    `${V1}/tariff/versions/${versionId}/items${queryString({ limit: PAGE_LIMIT })}`,
    withSignal(options),
  );
}

export async function submitVersion(
  versionId: string,
  body: ReasonRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<TariffVersionView> {
  return request(`${V1}/tariff/versions/${versionId}/submit`, { method: 'POST', body, idempotencyKey });
}

/** A different key from `submit`, held by a different role. See RC-003 §5. */
export async function publishVersion(
  versionId: string,
  body: PublishRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<TariffVersionView> {
  return request(`${V1}/tariff/versions/${versionId}/publish`, { method: 'POST', body, idempotencyKey });
}

export async function withdrawVersion(
  versionId: string,
  body: ReasonRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<TariffVersionView> {
  return request(`${V1}/tariff/versions/${versionId}/withdraw`, { method: 'POST', body, idempotencyKey });
}

/**
 * The hot path, called on an explicit action only — never on a keystroke.
 * A miss is a legitimate outcome, not an error, so this does not throw on one.
 */
export async function resolveRate(
  query: {
    readonly serviceId: string;
    readonly at?: string | undefined;
    readonly payerId?: string | undefined;
    readonly corporateId?: string | undefined;
    readonly bedClassId?: string | undefined;
  },
  options: Signal = {},
): Promise<RateResolution> {
  return request(
    `${V1}/tariff/resolve${queryString({
      serviceId: query.serviceId,
      at: query.at,
      payerId: query.payerId,
      corporateId: query.corporateId,
      bedClassId: query.bedClassId,
    })}`,
    withSignal(options),
  );
}

export async function listMissingRates(
  filters: { readonly status?: string | undefined } = {},
  options: Signal = {},
): Promise<Page<MissingRateRow>> {
  return request(
    `${V1}/tariff/missing-rates${queryString({ status: filters.status, limit: PAGE_LIMIT })}`,
    withSignal(options),
  );
}

export async function resolveMissingRate(
  id: string,
  body: ResolveMissingRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<MissingRateRow> {
  return request(`${V1}/tariff/missing-rates/${id}/resolve`, { method: 'POST', body, idempotencyKey });
}

export async function listChangeLog(
  filters: { readonly versionId?: string | undefined } = {},
  options: Signal = {},
): Promise<Page<ChangeLogRow>> {
  return request(
    `${V1}/tariff/change-log${queryString({ versionId: filters.versionId, limit: PAGE_LIMIT })}`,
    withSignal(options),
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// OP-005 — billing
//
// Every write carries `x-reason` where the permission demands one. The policy
// guard reads it from the header rather than the body, so a reason typed into a
// form and sent only in the payload is refused with a 403 that looks like a
// permissions problem and is not.
// ═════════════════════════════════════════════════════════════════════════════

export async function listBills(
  filters: {
    readonly patientId?: string | undefined;
    readonly status?: string | undefined;
  } = {},
  options: Signal = {},
): Promise<Page<BillSummaryView>> {
  return request(
    `${V1}/billing/bills${queryString({
      patientId: filters.patientId,
      status: filters.status,
      limit: PAGE_LIMIT,
    })}`,
    withSignal(options),
  );
}

export async function getBill(id: string, options: Signal = {}): Promise<BillDetailView> {
  return request(`${V1}/billing/bills/${id}`, withSignal(options));
}

export async function finalizeBill(
  id: string,
  body: FinalizeRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<BillDetailView> {
  return request(`${V1}/billing/bills/${id}/finalize`, {
    method: 'POST',
    body,
    idempotencyKey,
    reason: body.reason,
  });
}

export async function requestDiscount(
  billId: string,
  body: RequestDiscountRequest & { readonly reason: string },
  idempotencyKey: string = newIdempotencyKey(),
): Promise<DiscountRequestView> {
  return request(`${V1}/billing/bills/${billId}/discount-requests`, {
    method: 'POST',
    body,
    idempotencyKey,
    reason: body.reason,
  });
}

/** A different key from the request, held by a different role. */
export async function decideDiscount(
  id: string,
  body: DecideDiscountRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<DiscountRequestView> {
  return request(`${V1}/billing/discount-requests/${id}/decide`, {
    method: 'POST',
    body,
    idempotencyKey,
    reason: body.reason,
  });
}

export async function listBillingExceptions(
  filters: { readonly status?: string | undefined } = {},
  options: Signal = {},
): Promise<Page<BillingExceptionView>> {
  return request(
    `${V1}/billing/exceptions${queryString({ status: filters.status, limit: PAGE_LIMIT })}`,
    withSignal(options),
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// EN-010 — payments
// ═════════════════════════════════════════════════════════════════════════════

export async function listPayments(options: Signal = {}): Promise<Page<PayPaymentView>> {
  return request(`${V1}/payments/payments${queryString({ limit: PAGE_LIMIT })}`, withSignal(options));
}

export async function listPayIntents(
  filters: { readonly status?: string | undefined } = {},
  options: Signal = {},
): Promise<Page<PayIntentView>> {
  return request(
    `${V1}/payments/intents${queryString({ status: filters.status, limit: PAGE_LIMIT })}`,
    withSignal(options),
  );
}

export async function listReconExceptions(
  filters: { readonly status?: string | undefined } = {},
  options: Signal = {},
): Promise<Page<PayReconExceptionView>> {
  return request(
    `${V1}/payments/recon-exceptions${queryString({ status: filters.status, limit: PAGE_LIMIT })}`,
    withSignal(options),
  );
}

export async function resolveReconException(
  id: string,
  body: { readonly reason: string },
  idempotencyKey: string = newIdempotencyKey(),
): Promise<PayReconExceptionView> {
  return request(`${V1}/payments/recon-exceptions/${id}/resolve`, {
    method: 'POST',
    body,
    idempotencyKey,
    reason: body.reason,
  });
}

export async function approveRefund(
  id: string,
  body: { readonly reason: string },
  idempotencyKey: string = newIdempotencyKey(),
): Promise<PayRefundView> {
  return request(`${V1}/payments/refunds/${id}/approve`, {
    method: 'POST',
    body,
    idempotencyKey,
    reason: body.reason,
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// OP-023 — packages
// ═════════════════════════════════════════════════════════════════════════════

export async function listPackages(
  filters: { readonly status?: string | undefined } = {},
  options: Signal = {},
): Promise<Page<PackageView>> {
  return request(
    `${V1}/packages${queryString({ status: filters.status, limit: PAGE_LIMIT })}`,
    withSignal(options),
  );
}

export async function getActivation(id: string, options: Signal = {}): Promise<PackageActivationView> {
  return request(`${V1}/packages/activations/${id}`, withSignal(options));
}

export async function listVariances(
  filters: { readonly activationId?: string | undefined } = {},
  options: Signal = {},
): Promise<Page<VarianceRequestView>> {
  return request(
    `${V1}/packages/variances${queryString({ activationId: filters.activationId })}`,
    withSignal(options),
  );
}

/** A different key from the request, held by finance. */
export async function decideVariance(
  id: string,
  body: {
    readonly decision: 'approved' | 'rejected' | 'absorbed';
    readonly billAction: 'bill_patient' | 'bill_insurer' | 'absorb' | 'convert';
    readonly reason: string;
  },
  idempotencyKey: string = newIdempotencyKey(),
): Promise<VarianceRequestView> {
  return request(`${V1}/packages/variances/${id}/decide`, {
    method: 'POST',
    body,
    idempotencyKey,
    reason: body.reason,
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// EN-002 + RC-002 — insurance and pre-authorisation
// ═════════════════════════════════════════════════════════════════════════════

export async function listPreauths(
  filters: { readonly status?: string | undefined } = {},
  options: Signal = {},
): Promise<Page<PreauthView>> {
  return request(
    `${V1}/insurance/preauths${queryString({ status: filters.status, limit: PAGE_LIMIT })}`,
    withSignal(options),
  );
}

export async function getPreauth(id: string, options: Signal = {}): Promise<PreauthDetailView> {
  return request(`${V1}/insurance/preauths/${id}`, withSignal(options));
}

export async function submitPreauth(
  id: string,
  body: { readonly reason: string; readonly decisionHours?: number },
  idempotencyKey: string = newIdempotencyKey(),
): Promise<PreauthView> {
  return request(`${V1}/insurance/preauths/${id}/submit`, {
    method: 'POST',
    body,
    idempotencyKey,
    reason: body.reason,
  });
}

/** A different key from submit, held by finance. */
export async function recordPreauthDecision(
  id: string,
  body: {
    readonly status: 'approved' | 'partially_approved' | 'denied';
    readonly approvedAmount?: number;
    readonly approvedLosDays?: number;
    readonly validTill?: string;
    readonly payerRefNo?: string;
    readonly denialReasonCode?: string;
    readonly reason: string;
  },
  idempotencyKey: string = newIdempotencyKey(),
): Promise<PreauthView> {
  return request(`${V1}/insurance/preauths/${id}/decision`, {
    method: 'POST',
    body,
    idempotencyKey,
    reason: body.reason,
  });
}

export async function replyPreauthQuery(
  id: string,
  body: { readonly replyText: string },
  idempotencyKey: string = newIdempotencyKey(),
): Promise<PreauthQueryView> {
  return request(`${V1}/insurance/queries/${id}/reply`, { method: 'POST', body, idempotencyKey });
}

// ── RC-007 · government schemes ──────────────────────────────────────────────

export async function listSchemes(options: Signal = {}): Promise<Page<SchemeView>> {
  return request(`${V1}/schemes${queryString({ limit: PAGE_LIMIT })}`, withSignal(options));
}

export async function listSchemeCases(
  filters: { readonly status?: string | undefined } = {},
  options: Signal = {},
): Promise<Page<SchemeCaseView>> {
  return request(
    `${V1}/schemes/cases${queryString({ status: filters.status, limit: PAGE_LIMIT })}`,
    withSignal(options),
  );
}

export async function getSchemeCase(id: string, options: Signal = {}): Promise<SchemeCaseDetailView> {
  return request(`${V1}/schemes/cases/${id}`, withSignal(options));
}

export async function listSchemeClaims(
  filters: { readonly status?: string | undefined } = {},
  options: Signal = {},
): Promise<Page<SchemeClaimView>> {
  return request(
    `${V1}/schemes/claims${queryString({ status: filters.status, limit: PAGE_LIMIT })}`,
    withSignal(options),
  );
}

export async function getSchemeClaim(id: string, options: Signal = {}): Promise<SchemeClaimDetailView> {
  return request(`${V1}/schemes/claims/${id}`, withSignal(options));
}

/**
 * The refusal log.
 *
 * Not a debug view: this is the answer to "show me what happened when somebody
 * tried to take cash from an Ayushman patient", which is the question an NHA
 * audit actually asks.
 */
export async function listCashAttempts(options: Signal = {}): Promise<Page<SchemeCashAttemptView>> {
  return request(`${V1}/schemes/cash-attempts${queryString({ limit: PAGE_LIMIT })}`, withSignal(options));
}

export async function listSchemeShortfalls(
  filters: { readonly status?: string | undefined } = {},
  options: Signal = {},
): Promise<Page<SchemeShortfallView>> {
  return request(
    `${V1}/schemes/shortfalls${queryString({ status: filters.status, limit: PAGE_LIMIT })}`,
    withSignal(options),
  );
}

export async function submitSchemeClaim(
  id: string,
  body: { readonly reason: string },
  idempotencyKey: string = newIdempotencyKey(),
): Promise<SchemeClaimDetailView> {
  return request(`${V1}/schemes/claims/${id}/submit`, {
    method: 'POST',
    body,
    idempotencyKey,
    reason: body.reason,
  });
}

export async function appealSchemeShortfall(
  id: string,
  body: {
    readonly action: 'appeal' | 'request_writeoff';
    readonly appealRef?: string;
    readonly reason: string;
  },
  idempotencyKey: string = newIdempotencyKey(),
): Promise<SchemeShortfallView> {
  return request(`${V1}/schemes/shortfalls/${id}/appeal`, {
    method: 'POST',
    body,
    idempotencyKey,
    reason: body.reason,
  });
}

/** The second pair of hands. Held by finance, never by the desk that appealed. */
export async function approveSchemeWriteOff(
  id: string,
  body: { readonly reason: string },
  idempotencyKey: string = newIdempotencyKey(),
): Promise<SchemeShortfallView> {
  return request(`${V1}/schemes/shortfalls/${id}/writeoff`, {
    method: 'POST',
    body,
    idempotencyKey,
    reason: body.reason,
  });
}

// ── RC-008 · cost estimator ──────────────────────────────────────────────────

export async function listEstimates(
  filters: { readonly status?: string | undefined } = {},
  options: Signal = {},
): Promise<Page<EstimateView>> {
  return request(
    `${V1}/estimates${queryString({ status: filters.status, limit: PAGE_LIMIT })}`,
    withSignal(options),
  );
}

export async function getEstimate(id: string, options: Signal = {}): Promise<EstimateDetailView> {
  return request(`${V1}/estimates/${id}`, withSignal(options));
}

export async function listEstimateVariance(options: Signal = {}): Promise<Page<EstimateVarianceView>> {
  return request(`${V1}/estimates/variance${queryString({ limit: PAGE_LIMIT })}`, withSignal(options));
}

/**
 * What the samples have taught us, per procedure.
 *
 * The number that matters to a hospital is not any single overrun but whether a
 * procedure's quotes run light every time.
 */
export async function getVarianceSummary(
  options: Signal = {},
): Promise<{ readonly items: readonly EstimateVarianceSummaryRow[] }> {
  return request(`${V1}/estimates/variance/summary`, withSignal(options));
}

export async function issueEstimate(
  id: string,
  body: { readonly validDays: number; readonly reason: string },
  idempotencyKey: string = newIdempotencyKey(),
): Promise<EstimateDetailView> {
  return request(`${V1}/estimates/${id}/issue`, {
    method: 'POST',
    body,
    idempotencyKey,
    reason: body.reason,
  });
}

/** `reason` is mandatory: `est.share` is an export, and EN-024 §5 requires one. */
export async function shareEstimate(
  id: string,
  body: { readonly channel: string; readonly reason: string },
  idempotencyKey: string = newIdempotencyKey(),
): Promise<EstimateDetailView> {
  return request(`${V1}/estimates/${id}/share`, {
    method: 'POST',
    body,
    idempotencyKey,
    reason: body.reason,
  });
}

// ── RC-006 · revenue leakage audit ───────────────────────────────────────────

export async function listLeakFindings(
  filters: { readonly status?: string | undefined } = {},
  options: Signal = {},
): Promise<Page<LeakFindingView>> {
  return request(
    `${V1}/leakage/findings${queryString({ status: filters.status, limit: PAGE_LIMIT })}`,
    withSignal(options),
  );
}

export async function getLeakFinding(id: string, options: Signal = {}): Promise<LeakFindingDetailView> {
  return request(`${V1}/leakage/findings/${id}`, withSignal(options));
}

export async function listLeakScans(options: Signal = {}): Promise<Page<LeakScanView>> {
  return request(`${V1}/leakage/scans${queryString({ limit: PAGE_LIMIT })}`, withSignal(options));
}

/** What the audit found, and what came back. */
export async function getLeakDashboard(reason: string, options: Signal = {}): Promise<LeakDashboardView> {
  return request(`${V1}/leakage/dashboard`, { ...withSignal(options), reason });
}

/**
 * Agree a gap is real.
 *
 * This is the permission to bill it, not the billing — nothing moves until
 * somebody raises the charge and records the recovery. Two steps on purpose:
 * one button that agreed and billed at once would be the auto-post §5.7 forbids.
 */
export async function acceptLeakFinding(
  id: string,
  body: { readonly reason: string },
  idempotencyKey: string = newIdempotencyKey(),
): Promise<LeakFindingDetailView> {
  return request(`${V1}/leakage/findings/${id}/accept`, {
    method: 'POST',
    body,
    idempotencyKey,
    reason: body.reason,
  });
}

export async function dismissLeakFinding(
  id: string,
  body: { readonly reason: string },
  idempotencyKey: string = newIdempotencyKey(),
): Promise<LeakFindingDetailView> {
  return request(`${V1}/leakage/findings/${id}/dismiss`, {
    method: 'POST',
    body,
    idempotencyKey,
    reason: body.reason,
  });
}

export async function runLeakScan(
  body: { readonly trigger: string },
  idempotencyKey: string = newIdempotencyKey(),
): Promise<LeakScanView> {
  return request(`${V1}/leakage/scans`, { method: 'POST', body, idempotencyKey });
}

// ── NC-034 · doctor payouts ──────────────────────────────────────────────────

export async function listPayoutPeriods(options: Signal = {}): Promise<Page<PayoutPeriodView>> {
  return request(`${V1}/payouts/periods${queryString({ limit: PAGE_LIMIT })}`, withSignal(options));
}

export async function listPayoutStatements(
  filters: { readonly periodId?: string | undefined; readonly status?: string | undefined } = {},
  options: Signal = {},
): Promise<Page<PayoutStatementView>> {
  return request(
    `${V1}/payouts/statements${queryString({
      periodId: filters.periodId,
      status: filters.status,
      limit: PAGE_LIMIT,
    })}`,
    withSignal(options),
  );
}

export async function getPayoutStatement(
  id: string,
  options: Signal = {},
): Promise<PayoutStatementDetailView> {
  return request(`${V1}/payouts/statements/${id}`, withSignal(options));
}

/** Builds every statement from what each doctor performed. */
export async function computePayoutPeriod(
  id: string,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<unknown> {
  return request(`${V1}/payouts/periods/${id}/compute`, { method: 'POST', body: {}, idempotencyKey });
}

/** The second pair of hands. Refused while a dispute is open. */
export async function approvePayoutStatement(
  id: string,
  body: { readonly reason: string },
  idempotencyKey: string = newIdempotencyKey(),
): Promise<PayoutStatementDetailView> {
  return request(`${V1}/payouts/statements/${id}/approve`, {
    method: 'POST',
    body,
    idempotencyKey,
    reason: body.reason,
  });
}

export async function payPayoutStatement(
  id: string,
  body: { readonly paymentRef: string; readonly reason: string },
  idempotencyKey: string = newIdempotencyKey(),
): Promise<PayoutStatementDetailView> {
  return request(`${V1}/payouts/statements/${id}/pay`, {
    method: 'POST',
    body,
    idempotencyKey,
    reason: body.reason,
  });
}
