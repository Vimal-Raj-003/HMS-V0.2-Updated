import { newIdempotencyKey, queryString, request } from './http';
import type {
  AccessionSampleRequest,
  AmendRadReportRequest,
  AmendResultRequest,
  CollectSampleRequest,
  CosignInvestigationReportRequest,
  CreateRadOrderRequest,
  CreateRadReportRequest,
  CriticalFindingRequest,
  CriticalFindingView,
  DoseSummaryView,
  FormFRequest,
  GenerateLabReportRequest,
  InvestigationReportView,
  InvestigationStudyView,
  IssueLabelsRequest,
  LabCriticalAlertView,
  LabCriticalCallbackRequest,
  LabLabelView,
  LabOrderView,
  LabQcRunView,
  LabQcStateView,
  LabRejectionReasonItem,
  LabReportView,
  LabResultChainLink,
  LabResultView,
  LabSampleView,
  LabTestCatalogueItem,
  LabWorklistItem,
  Page,
  PacsStudyView,
  QcActionRequest,
  QcRunRequest,
  QcUnlockRequest,
  RadCriticalCallbackRequest,
  RadOrderView,
  RadReportView,
  ReadingWorklistItem,
  ReceiveSampleRequest,
  ReconcileStudyRequest,
  RejectSampleRequest,
  ReleaseResultsRequest,
  ResultEntryRequest,
  SafetyScreenRequest,
  SignInvestigationReportRequest,
  SignRadReportRequest,
  UpdateRadReportRequest,
  ViewerGrantView,
  ViewerTokenRequest,
} from './types';

/**
 * Every call the diagnostics screens make.
 *
 * Four rules hold across the file. Each is a patient-safety or a statutory rule
 * rather than a style rule:
 *
 *  1. **Nothing here catches.** A refusal is a `ProblemDetails` the screen must
 *     render with its `reference` and `nextAction`. Swallowing a PC-PNDT refusal
 *     (`statutory-limit`) or a QC lockout into a `null` would leave a
 *     radiographer staring at a form that did nothing and no way to know why.
 *  2. **Nothing here retries.** A refused sign is a decision, not a hiccup, and
 *     a re-posted critical-value call-back is a second entry in a NABL register
 *     that describes one phone call.
 *  3. **Every list is cursor-paginated.** Every `list*` function takes a
 *     `cursor` and a bounded `limit` and returns the API's `Page<T>`; there is
 *     no "fetch everything" path anywhere in this file. `docs/07 §4` bans
 *     `OFFSET`, and a client that concatenated pages until `hasMore` went false
 *     would be an `OFFSET` scan wearing a different hat.
 *  4. **No PHI in a query string this feature controls.** Filters are coded
 *     enums, cursors are opaque signed tokens, and patient identity travels as
 *     an opaque UUID in a path segment or a body. `docs/04 §5` — no PHI in URLs
 *     or logs.
 *
 * Where the API takes a barcode in the path (`/lab/samples/{barcode}`) that is
 * the API's own choice, made deliberately: every one of those actions happens
 * with a tube in one hand and a scanner in the other, and a route needing a UUID
 * would need a lookup screen first — which is where somebody picks the wrong
 * patient. A specimen barcode is not a patient identifier.
 */

const V1 = '/api/v1';

interface Signal {
  readonly signal?: AbortSignal;
}

function withSignal(options: Signal): { signal?: AbortSignal } {
  return options.signal === undefined ? {} : { signal: options.signal };
}

/**
 * The interactive page ceiling from `packages/contracts`
 * (`PAGE_SIZE_MAX_INTERACTIVE`). A worklist of a thousand rows is a rendering
 * problem and a privacy problem at once, so no caller may ask for one.
 */
export const PAGE_LIMIT = 50;

// ═════════════════════════════════════════════════════════════════════════════
// OP-004 — laboratory catalogue
// ═════════════════════════════════════════════════════════════════════════════

export async function listLabTests(
  filters: {
    readonly q?: string | undefined;
    readonly discipline?: string | undefined;
    readonly cursor?: string | undefined;
  } = {},
  options: Signal = {},
): Promise<{ readonly items: readonly LabTestCatalogueItem[] }> {
  return request(
    `${V1}/lab/catalogue/tests${queryString({
      q: filters.q,
      discipline: filters.discipline,
      cursor: filters.cursor,
      limit: PAGE_LIMIT,
    })}`,
    withSignal(options),
  );
}

/**
 * The coded rejection reasons (OP-004 §3.2.3).
 *
 * Gated on `mdm.read` rather than on a laboratory key, and deliberately so: a
 * phlebotomist who must choose a coded reason cannot be asked to hold a
 * configuration permission to see the list they must choose from.
 */
export async function listRejectionReasons(
  options: Signal = {},
): Promise<{ readonly items: readonly LabRejectionReasonItem[] }> {
  return request(`${V1}/lab/catalogue/rejection-reasons`, withSignal(options));
}

// ═════════════════════════════════════════════════════════════════════════════
// OP-004 §3.1–§3.2 — orders, labels, specimens
// ═════════════════════════════════════════════════════════════════════════════

export async function listLabOrders(
  filters: {
    readonly status?: string | undefined;
    readonly priority?: string | undefined;
    readonly patientId?: string | undefined;
    readonly cursor?: string | undefined;
  } = {},
  options: Signal = {},
): Promise<Page<LabOrderView>> {
  return request(
    `${V1}/lab/orders${queryString({
      status: filters.status,
      priority: filters.priority,
      patientId: filters.patientId,
      cursor: filters.cursor,
      limit: PAGE_LIMIT,
    })}`,
    withSignal(options),
  );
}

export async function getLabOrder(id: string, options: Signal = {}): Promise<LabOrderView> {
  return request(`${V1}/lab/orders/${id}`, withSignal(options));
}

/**
 * EN-013 §3: the labels, and with them the specimen rows they name.
 *
 * A reprint must say why. EN-013 §5 bullet 6 goes further and forbids reprinting
 * a *collected* sample's label at all without the relabel workflow, which this
 * build does not have — so the collection screen offers a reprint only while the
 * specimen is still awaiting collection, and says so.
 */
export async function issueLabels(
  orderId: string,
  body: IssueLabelsRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<{ readonly labels: readonly LabLabelView[] }> {
  return request(`${V1}/lab/orders/${orderId}/labels`, { method: 'POST', body, idempotencyKey });
}

export async function getSampleByBarcode(barcode: string, options: Signal = {}): Promise<LabSampleView> {
  return request(`${V1}/lab/samples/${encodeURIComponent(barcode)}`, withSignal(options));
}

/**
 * OP-004 §3.2.1 / §5 bullet 1 — two scans, or a named override with a reason.
 * There is no third answer, and `lib/collection.ts` is what refuses to build one.
 */
export async function collectSample(
  barcode: string,
  body: CollectSampleRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<LabSampleView> {
  return request(`${V1}/lab/samples/${encodeURIComponent(barcode)}/collect`, {
    method: 'POST',
    body,
    idempotencyKey,
  });
}

export async function receiveSample(
  barcode: string,
  body: ReceiveSampleRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<LabSampleView> {
  return request(`${V1}/lab/samples/${encodeURIComponent(barcode)}/receive`, {
    method: 'POST',
    body,
    idempotencyKey,
  });
}

export async function accessionSample(
  barcode: string,
  body: AccessionSampleRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<LabSampleView> {
  return request(`${V1}/lab/samples/${encodeURIComponent(barcode)}/accession`, {
    method: 'POST',
    body,
    idempotencyKey,
  });
}

/**
 * OP-004 §3.2.3 — rejection against a coded reason.
 *
 * `lab.sample.reject` is `requiresReason` in the catalogue, so the policy guard
 * demands an `x-reason` header *before the handler runs*. Passing the reason
 * only in the body would be refused with a 403 the screen could not explain, so
 * the caller must supply both and the signature makes that impossible to forget.
 */
export async function rejectSample(
  barcode: string,
  body: RejectSampleRequest,
  reason: string,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<LabSampleView> {
  return request(`${V1}/lab/samples/${encodeURIComponent(barcode)}/reject`, {
    method: 'POST',
    body,
    reason,
    idempotencyKey,
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// OP-004 §3.3–§3.4 — bench, verification, authorisation
// ═════════════════════════════════════════════════════════════════════════════

export async function listBenchWorklist(
  filters: {
    readonly discipline: string;
    readonly stage: 'pending' | 'awaiting_release';
    readonly cursor?: string | undefined;
  },
  options: Signal = {},
): Promise<Page<LabWorklistItem>> {
  return request(
    `${V1}/lab/worklists/bench${queryString({
      discipline: filters.discipline,
      stage: filters.stage,
      cursor: filters.cursor,
      limit: PAGE_LIMIT,
    })}`,
    withSignal(options),
  );
}

export async function enterResults(
  results: readonly ResultEntryRequest[],
  idempotencyKey: string = newIdempotencyKey(),
): Promise<{ readonly results: readonly LabResultView[] }> {
  return request(`${V1}/lab/results`, { method: 'POST', body: { results }, idempotencyKey });
}

/** Level 1 — technical verification. The API refuses a verifier who entered it. */
export async function verifyResults(
  body: ReleaseResultsRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<{ readonly results: readonly LabResultView[] }> {
  return request(`${V1}/lab/results/verify`, { method: 'POST', body, idempotencyKey });
}

/**
 * Level 2 — medical authorisation, the step that releases a result to a report.
 *
 * For a critical value this is the only step D-10 gates, and the **database** is
 * what refuses it until the call-back is on file. `lib/critical.ts` mirrors the
 * rule so the button is disabled with an explanation rather than enabled into a
 * 409, but the client is not the control and must never be treated as one.
 */
export async function authoriseResults(
  body: ReleaseResultsRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<{ readonly results: readonly LabResultView[] }> {
  return request(`${V1}/lab/results/authorise`, { method: 'POST', body, idempotencyKey });
}

/** `lab.result.amend` is `requiresReason`; the header and the body both carry it. */
export async function amendResult(
  id: string,
  body: AmendResultRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<LabResultView> {
  return request(`${V1}/lab/results/${id}/amend`, {
    method: 'POST',
    body,
    reason: body.reason,
    idempotencyKey,
  });
}

export async function getLabResult(id: string, options: Signal = {}): Promise<LabResultView> {
  return request(`${V1}/lab/results/${id}`, withSignal(options));
}

/** The hash chain, re-derived by the database. What a NABL assessor asks for. */
export async function getResultChain(
  id: string,
  options: Signal = {},
): Promise<{ readonly links: readonly LabResultChainLink[] }> {
  return request(`${V1}/lab/results/${id}/chain`, withSignal(options));
}

export async function listPatientResults(
  patientId: string,
  filters: { readonly testKey?: string | undefined; readonly cursor?: string | undefined } = {},
  options: Signal = {},
): Promise<Page<LabResultView>> {
  return request(
    `${V1}/lab/patients/${patientId}/results${queryString({
      testKey: filters.testKey,
      cursor: filters.cursor,
      limit: PAGE_LIMIT,
    })}`,
    withSignal(options),
  );
}

export async function generateLabReport(
  orderId: string,
  body: GenerateLabReportRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<LabReportView> {
  return request(`${V1}/lab/reports/${orderId}/generate`, { method: 'POST', body, idempotencyKey });
}

// ═════════════════════════════════════════════════════════════════════════════
// OP-004 §3.5 — the critical-value loop
// ═════════════════════════════════════════════════════════════════════════════

/**
 * `lab.critical.read` and `lab.critical.notify` are `clinicalSafetyExempt`:
 * `EN-040 §5` puts the panic-value loop outside licence enforcement entirely. A
 * hospital in arrears still gets its potassium of 6.8 to a human.
 */
export async function listCriticalValues(
  filters: { readonly open?: boolean | undefined; readonly cursor?: string | undefined } = {},
  options: Signal = {},
): Promise<Page<LabCriticalAlertView>> {
  return request(
    `${V1}/lab/critical-values${queryString({
      open: filters.open ?? true,
      cursor: filters.cursor,
      limit: PAGE_LIMIT,
    })}`,
    withSignal(options),
  );
}

export async function getCriticalValue(id: string, options: Signal = {}): Promise<LabCriticalAlertView> {
  return request(`${V1}/lab/critical-values/${id}`, withSignal(options));
}

/** One documented communication attempt: a read-back, or a named escalation. */
export async function recordCriticalCallback(
  id: string,
  body: LabCriticalCallbackRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<LabCriticalAlertView> {
  return request(`${V1}/lab/critical-values/${id}/notify`, { method: 'POST', body, idempotencyKey });
}

export async function acknowledgeCriticalValue(
  id: string,
  body: { readonly note?: string },
  idempotencyKey: string = newIdempotencyKey(),
): Promise<LabCriticalAlertView> {
  return request(`${V1}/lab/critical-values/${id}/acknowledge`, { method: 'POST', body, idempotencyKey });
}

// ═════════════════════════════════════════════════════════════════════════════
// EN-031 — quality control
// ═════════════════════════════════════════════════════════════════════════════

export async function getQcState(
  filters: {
    readonly instrumentId?: string | undefined;
    readonly testKey?: string | undefined;
    readonly cursor?: string | undefined;
  } = {},
  options: Signal = {},
): Promise<{ readonly items: readonly LabQcStateView[] }> {
  return request(
    `${V1}/lab/qc/state${queryString({
      instrumentId: filters.instrumentId,
      testKey: filters.testKey,
      cursor: filters.cursor,
      limit: PAGE_LIMIT,
    })}`,
    withSignal(options),
  );
}

export async function recordQcRun(
  body: QcRunRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<LabQcRunView> {
  return request(`${V1}/lab/qc/runs`, { method: 'POST', body, idempotencyKey });
}

export async function getQcRun(id: string, options: Signal = {}): Promise<LabQcRunView> {
  return request(`${V1}/lab/qc/runs/${id}`, withSignal(options));
}

export async function recordQcAction(
  body: QcActionRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<{ readonly actionId: string }> {
  return request(`${V1}/lab/qc/actions`, { method: 'POST', body, idempotencyKey });
}

/** `lab.qc.unlock` clears a lockout against a **passing run**, never against an opinion. */
export async function unlockQc(
  lockoutId: string,
  body: QcUnlockRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<{ readonly state: string }> {
  return request(`${V1}/lab/qc/lockouts/${lockoutId}/unlock`, {
    method: 'POST',
    body,
    reason: body.reason,
    idempotencyKey,
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// OP-008 — radiology orders and the safety screen
// ═════════════════════════════════════════════════════════════════════════════

export async function createRadOrder(
  body: CreateRadOrderRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<RadOrderView> {
  return request(`${V1}/rad/orders`, { method: 'POST', body, idempotencyKey });
}

export async function listRadOrders(
  filters: {
    readonly status?: string | undefined;
    readonly modality?: string | undefined;
    readonly priority?: string | undefined;
    readonly cursor?: string | undefined;
  } = {},
  options: Signal = {},
): Promise<Page<RadOrderView>> {
  return request(
    `${V1}/rad/orders${queryString({
      status: filters.status,
      modality: filters.modality,
      priority: filters.priority,
      cursor: filters.cursor,
      limit: PAGE_LIMIT,
    })}`,
    withSignal(options),
  );
}

export async function getRadOrder(id: string, options: Signal = {}): Promise<RadOrderView> {
  return request(`${V1}/rad/orders/${id}`, withSignal(options));
}

/** OP-008 §3.1.2 — pregnancy, contrast/renal, allergy and MRI answers. */
export async function saveSafetyScreen(
  id: string,
  body: SafetyScreenRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<RadOrderView> {
  return request(`${V1}/rad/orders/${id}/safety-screen`, { method: 'PATCH', body, idempotencyKey });
}

/**
 * PC-PNDT Form F (OP-008 §5, AC §14.9).
 *
 * `rad.pnpdt.manage` carries three kinds of friction at once — `sensitiveGrant`,
 * `requiresReason`, `requiresStepUp` — and the catalogue is right to put them
 * there: the Act makes the recording clinician personally liable. The reason
 * header is therefore mandatory on this call.
 */
export async function recordFormF(
  orderItemId: string,
  body: FormFRequest,
  reason: string,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<{ readonly formSerialNo: string }> {
  return request(`${V1}/rad/order-items/${orderItemId}/form-f`, {
    method: 'POST',
    body,
    reason,
    idempotencyKey,
  });
}

export async function getPatientDoseSummary(
  patientId: string,
  options: Signal = {},
): Promise<DoseSummaryView> {
  return request(`${V1}/rad/patients/${patientId}/dose-summary`, withSignal(options));
}

// ═════════════════════════════════════════════════════════════════════════════
// OP-008 §3.4 — reading and reporting
// ═════════════════════════════════════════════════════════════════════════════

export async function listReadingWorklist(
  filters: {
    readonly modality?: string | undefined;
    readonly status?: string | undefined;
    readonly cursor?: string | undefined;
  } = {},
  options: Signal = {},
): Promise<Page<ReadingWorklistItem>> {
  return request(
    `${V1}/rad/reading-worklist${queryString({
      modality: filters.modality,
      status: filters.status,
      cursor: filters.cursor,
      limit: PAGE_LIMIT,
    })}`,
    withSignal(options),
  );
}

export async function createRadReport(
  body: CreateRadReportRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<RadReportView> {
  return request(`${V1}/rad/reports`, { method: 'POST', body, idempotencyKey });
}

export async function getRadReport(id: string, options: Signal = {}): Promise<RadReportView> {
  return request(`${V1}/rad/reports/${id}`, withSignal(options));
}

/** Autosave. Deliberately not idempotent: an autosave is a last-write-wins overwrite. */
export async function updateRadReport(id: string, body: UpdateRadReportRequest): Promise<RadReportView> {
  return request(`${V1}/rad/reports/${id}`, { method: 'PATCH', body });
}

/** OP-008 §3.4.5 — the wet read. It reaches the referrer watermarked "Preliminary". */
export async function issuePreliminary(
  id: string,
  body: SignRadReportRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<RadReportView> {
  return request(`${V1}/rad/reports/${id}/preliminary`, { method: 'POST', body, idempotencyKey });
}

/** `rad.report.sign` is `requiresStepUp`: a stale session is refused at the door. */
export async function signRadReport(
  id: string,
  body: SignRadReportRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<RadReportView> {
  return request(`${V1}/rad/reports/${id}/sign`, { method: 'POST', body, idempotencyKey });
}

/** `rad.report.amend` is `requiresReason`; the reason also prints on the amended report. */
export async function amendRadReport(
  id: string,
  body: AmendRadReportRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<RadReportView> {
  return request(`${V1}/rad/reports/${id}/amend`, {
    method: 'POST',
    body,
    reason: body.reason,
    idempotencyKey,
  });
}

export async function raiseCriticalFinding(
  reportId: string,
  body: CriticalFindingRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<CriticalFindingView> {
  return request(`${V1}/rad/reports/${reportId}/critical`, { method: 'POST', body, idempotencyKey });
}

export async function recordRadCriticalCallback(
  findingId: string,
  body: RadCriticalCallbackRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<CriticalFindingView> {
  return request(`${V1}/rad/critical-findings/${findingId}/callbacks`, {
    method: 'POST',
    body,
    idempotencyKey,
  });
}

export async function listCriticalFindings(
  filters: {
    readonly modality?: string | undefined;
    readonly status?: string | undefined;
    readonly cursor?: string | undefined;
  } = {},
  options: Signal = {},
): Promise<Page<CriticalFindingView>> {
  return request(
    `${V1}/rad/critical-findings${queryString({
      modality: filters.modality,
      status: filters.status,
      cursor: filters.cursor,
      limit: PAGE_LIMIT,
    })}`,
    withSignal(options),
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// EN-008 — PACS
// ═════════════════════════════════════════════════════════════════════════════

export async function listPacsStudies(
  filters: { readonly reconciliationStatus?: string | undefined; readonly cursor?: string | undefined } = {},
  options: Signal = {},
): Promise<Page<PacsStudyView>> {
  return request(
    `${V1}/pacs/studies${queryString({
      reconciliationStatus: filters.reconciliationStatus,
      cursor: filters.cursor,
      limit: PAGE_LIMIT,
    })}`,
    withSignal(options),
  );
}

/**
 * The reconciliation queue — EN-008 §3.3 and AC §14.4.
 *
 * A separate route rather than `listPacsStudies({ reconciliationStatus:
 * 'needs_review' })` because it is separately permissioned:
 * `rad.study.reconcile`, not `rad.study.read`. The API applies the filter
 * server-side, so a caller cannot widen it.
 */
export async function listReconciliationQueue(
  filters: { readonly cursor?: string | undefined } = {},
  options: Signal = {},
): Promise<Page<PacsStudyView>> {
  return request(
    `${V1}/pacs/reconciliation${queryString({ cursor: filters.cursor, limit: PAGE_LIMIT })}`,
    withSignal(options),
  );
}

export async function getPacsStudy(id: string, options: Signal = {}): Promise<PacsStudyView> {
  return request(`${V1}/pacs/studies/${id}`, withSignal(options));
}

/**
 * EN-008 §5: "never silently attach to wrong patient."
 *
 * `rad.study.reconcile` is `requiresReason`, so this is always a named human
 * decision. Confirming a match the archive made on the accession number is one
 * click; confirming a **fallback** match is not, because a fallback match is a
 * guess made on demographics — the service refuses it unless the human states
 * which patient they mean, and `lib/reconciliation.ts` mirrors that so the
 * screen asks rather than letting the refusal arrive as a 422.
 */
export async function reconcileStudy(
  id: string,
  body: ReconcileStudyRequest,
  reason: string,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<PacsStudyView> {
  return request(`${V1}/pacs/studies/${id}/reconcile`, { method: 'POST', body, reason, idempotencyKey });
}

/**
 * A short-lived viewer grant.
 *
 * The route returns a **token and an Orthanc object id, never an image**
 * (EN-008 §5: "direct Orthanc ports not exposed beyond hub/viewer gateway").
 * Every issue is written to `pacs_view_audit` before the token exists, so an
 * image view is auditable even if the viewer never loads.
 */
export async function issueViewerToken(
  studyId: string,
  body: ViewerTokenRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<ViewerGrantView> {
  return request(`${V1}/pacs/studies/${studyId}/viewer-token`, { method: 'POST', body, idempotencyKey });
}

// ═════════════════════════════════════════════════════════════════════════════
// OP-022 — investigation console
// ═════════════════════════════════════════════════════════════════════════════

export async function listInvestigationWorklist(
  filters: {
    readonly status?: string | undefined;
    readonly modalityGroup?: string | undefined;
    readonly cursor?: string | undefined;
  } = {},
  options: Signal = {},
): Promise<Page<InvestigationStudyView>> {
  return request(
    `${V1}/investigations/worklist${queryString({
      status: filters.status,
      modalityGroup: filters.modalityGroup,
      cursor: filters.cursor,
      limit: PAGE_LIMIT,
    })}`,
    withSignal(options),
  );
}

export async function getInvestigationStudy(
  id: string,
  options: Signal = {},
): Promise<InvestigationStudyView> {
  return request(`${V1}/investigations/studies/${id}`, withSignal(options));
}

export async function checkInInvestigation(
  id: string,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<InvestigationStudyView> {
  return request(`${V1}/investigations/studies/${id}/check-in`, { method: 'POST', body: {}, idempotencyKey });
}

/**
 * OP-022 §5 / AC §14.2 — identity verification before capture.
 *
 * `identityVerified` is `z.literal(true)` on the API, so "started without an
 * identity check" is not a state a request can even describe.
 */
export async function startInvestigation(
  id: string,
  body: { readonly identityVerified: true; readonly identityMethod: string },
  idempotencyKey: string = newIdempotencyKey(),
): Promise<InvestigationStudyView> {
  return request(`${V1}/investigations/studies/${id}/start`, { method: 'POST', body, idempotencyKey });
}

export async function completeInvestigation(
  id: string,
  body: { readonly techniqueNotes?: string; readonly repeatFlag: boolean; readonly repeatReason?: string },
  idempotencyKey: string = newIdempotencyKey(),
): Promise<InvestigationStudyView> {
  return request(`${V1}/investigations/studies/${id}/done`, { method: 'POST', body, idempotencyKey });
}

export async function createInvestigationReport(
  studyId: string,
  body: { readonly impression?: string; readonly critical: boolean },
  idempotencyKey: string = newIdempotencyKey(),
): Promise<InvestigationReportView> {
  return request(`${V1}/investigations/studies/${studyId}/reports`, {
    method: 'POST',
    body: { ...body, body: {} },
    idempotencyKey,
  });
}

export async function getInvestigationReport(
  id: string,
  options: Signal = {},
): Promise<InvestigationReportView> {
  return request(`${V1}/investigations/reports/${id}`, withSignal(options));
}

export async function sendInvestigationForCosign(
  id: string,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<InvestigationReportView> {
  return request(`${V1}/investigations/reports/${id}/send-for-cosign`, {
    method: 'POST',
    body: {},
    idempotencyKey,
  });
}

/**
 * OP-022 §3.3.1 / §5 — the PC-PNDT content validator lives on **this** route.
 *
 * Unlike radiology, where no such field exists to override, an investigation
 * service may legitimately be an obstetric ultrasound written on a non-DICOM
 * machine, so the Act's text check lives here with its override trail. The
 * override is a named doctor and a written reason, never a click.
 */
export async function signInvestigationReport(
  id: string,
  body: SignInvestigationReportRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<InvestigationReportView> {
  return request(`${V1}/investigations/reports/${id}/sign`, { method: 'POST', body, idempotencyKey });
}

export async function cosignInvestigationReport(
  id: string,
  body: CosignInvestigationReportRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<InvestigationReportView> {
  return request(`${V1}/investigations/reports/${id}/cosign`, { method: 'POST', body, idempotencyKey });
}

export async function flagInvestigationCritical(
  id: string,
  body: { readonly summary: string; readonly informedName: string; readonly method: string },
  idempotencyKey: string = newIdempotencyKey(),
): Promise<InvestigationReportView> {
  return request(`${V1}/investigations/reports/${id}/critical`, { method: 'POST', body, idempotencyKey });
}
