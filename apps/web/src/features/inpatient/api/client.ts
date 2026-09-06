import { newIdempotencyKey, queryString, request } from './http';
import type {
  AdmissionDetailView,
  AdmissionView,
  BedBoardRow,
  CensusRow,
  BloodUnitRow,
  ChargeRunView,
  CleaningTaskView,
  CodeDetail,
  CodeRow,
  CssdLoadRow,
  ClearanceView,
  EscalationRow,
  MarDoseRow,
  OtCaseDetail,
  OtCaseRow,
  RecallResult,
  RunningBillView,
  WardPatientRow,
} from './types';

/**
 * Every call Phase 7A makes.
 *
 * ── Admitting names a class, not a bed ──────────────────────────────────────
 *
 * There is no `bedId` on `admit`, only `preferredBedId`. A client naming a bed
 * read the board a moment ago and is about to lose a race it cannot see; the
 * server allocates under a lock and the preference is tried first.
 */

const V1 = '/api/v1';

interface Signal {
  readonly signal?: AbortSignal;
}
function withSignal(options: Signal): { signal?: AbortSignal } {
  return options.signal === undefined ? {} : { signal: options.signal };
}
interface PageOf<T> {
  readonly items: readonly T[];
}

export async function getBoard(
  filters: {
    readonly wardId?: string;
    readonly wardType?: string;
    readonly classId?: string;
    readonly status?: string;
    readonly freeOnly?: boolean;
  } = {},
  options: Signal = {},
): Promise<PageOf<BedBoardRow>> {
  return request(
    `${V1}/ip/board${queryString({
      wardId: filters.wardId,
      wardType: filters.wardType,
      classId: filters.classId,
      status: filters.status,
      freeOnly: filters.freeOnly,
    })}`,
    withSignal(options),
  );
}

export async function getCensus(options: Signal = {}): Promise<readonly CensusRow[]> {
  return request(`${V1}/ip/census`, withSignal(options));
}

export async function getAdmissions(
  filters: {
    readonly status?: string;
    readonly wardId?: string;
    readonly patientId?: string;
    readonly dueForDischarge?: boolean;
  } = {},
  options: Signal = {},
): Promise<PageOf<AdmissionView>> {
  return request(
    `${V1}/ip/admissions${queryString({
      status: filters.status,
      wardId: filters.wardId,
      patientId: filters.patientId,
      dueForDischarge: filters.dueForDischarge,
    })}`,
    withSignal(options),
  );
}

export async function getAdmission(id: string, options: Signal = {}): Promise<AdmissionDetailView> {
  return request(`${V1}/ip/admissions/${id}`, withSignal(options));
}

export interface AdmitBody {
  readonly classId: string;
  readonly wardId?: string;
  readonly needsIsolation?: boolean;
  readonly needsVentilatorPoint?: boolean;
  readonly needsMonitor?: boolean;
  readonly needsAttendantBed?: boolean;
  /** A preference, tried first. Not an instruction — the lock decides. */
  readonly preferredBedId?: string;
  readonly depositTaken?: number;
  readonly depositApprovalId?: string;
}

export async function admit(id: string, body: AdmitBody): Promise<AdmissionDetailView> {
  return request(`${V1}/ip/admissions/${id}/admit`, {
    method: 'POST',
    body,
    idempotencyKey: newIdempotencyKey(),
  });
}

export interface TransferBody {
  readonly kind: string;
  readonly toBedId?: string;
  readonly reason: string;
  readonly situation?: string;
  readonly background?: string;
  readonly assessment?: string;
  readonly recommendation?: string;
  readonly linesAndTubes?: readonly string[];
  readonly infusions?: readonly string[];
  readonly pendingResults?: readonly string[];
  readonly allergies?: readonly string[];
  readonly destinationFacility?: string;
  readonly stabilityNote?: string;
}

export async function transfer(id: string, body: TransferBody): Promise<AdmissionDetailView> {
  return request(`${V1}/ip/admissions/${id}/transfers`, { method: 'POST', body });
}

export async function discharge(
  id: string,
  body: { readonly outcome: string; readonly notes?: string },
): Promise<AdmissionDetailView> {
  return request(`${V1}/ip/admissions/${id}/discharge`, { method: 'PATCH', body });
}

export async function holdBed(body: {
  readonly bedId: string;
  readonly reason: string;
  readonly admissionId?: string;
  readonly minutes?: number;
}): Promise<{ readonly id: string; readonly expiresAt: string }> {
  return request(`${V1}/ip/holds`, { method: 'POST', body, idempotencyKey: newIdempotencyKey() });
}

export async function releaseHold(id: string, reason: string): Promise<{ readonly released: boolean }> {
  return request(`${V1}/ip/holds/${id}/release`, { method: 'PATCH', body: { reason } });
}

export async function blockBed(
  id: string,
  body: { readonly blocked: boolean; readonly expectedHours?: number; readonly approvalId?: string },
  reason: string,
): Promise<{ readonly status: string }> {
  return request(`${V1}/ip/beds/${id}/block`, { method: 'PATCH', body, reason });
}

export async function getCleaning(
  filters: { readonly wardId?: string; readonly openOnly?: boolean; readonly breachedOnly?: boolean } = {},
  options: Signal = {},
): Promise<PageOf<CleaningTaskView>> {
  return request(
    `${V1}/ip/cleaning${queryString({
      wardId: filters.wardId,
      openOnly: filters.openOnly,
      breachedOnly: filters.breachedOnly,
    })}`,
    withSignal(options),
  );
}

export async function cleaningAction(
  id: string,
  body: { readonly action: string; readonly failReason?: string },
): Promise<CleaningTaskView> {
  return request(`${V1}/ip/cleaning/${id}`, { method: 'PATCH', body });
}

/** The audited exception. The reason lands on the bed row, where the trigger reads it. */
export async function skipCleaning(bedId: string, reason: string): Promise<{ readonly status: string }> {
  return request(`${V1}/ip/beds/${bedId}/skip-cleaning`, { method: 'PATCH', body: {}, reason });
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 7B
//
// `administer` takes the two scan payloads and nothing that could stand in for
// them. There is no `force`, no `override` and no `skipScan` in this client,
// because there is no such thing on the server and no flag anywhere that turns
// the requirement off.
// ─────────────────────────────────────────────────────────────────────────────

export async function getWard(
  filters: { readonly wardId?: string } = {},
  options: Signal = {},
): Promise<PageOf<WardPatientRow>> {
  return request(`${V1}/nursing/ward${queryString({ wardId: filters.wardId })}`, withSignal(options));
}

export async function getMarRound(
  filters: {
    readonly admissionId?: string;
    readonly wardId?: string;
    readonly dueOnly?: boolean;
    readonly overdueOnly?: boolean;
  } = {},
  options: Signal = {},
): Promise<PageOf<MarDoseRow>> {
  return request(
    `${V1}/nursing/mar${queryString({
      admissionId: filters.admissionId,
      wardId: filters.wardId,
      dueOnly: filters.dueOnly,
      overdueOnly: filters.overdueOnly,
    })}`,
    withSignal(options),
  );
}

export interface AdministerBody {
  /** What the scanner read off the wristband. */
  readonly patientScan: string;
  /** What the scanner read off the drug. */
  readonly drugScan: string;
  /** Required for a high-alert drug, and refused if it is you. */
  readonly witnessedBy?: string;
  readonly givenDose?: string;
  readonly site?: string;
  readonly prnIndication?: string;
}

export async function administer(doseId: string, body: AdministerBody): Promise<MarDoseRow> {
  return request(`${V1}/nursing/mar/doses/${doseId}/administer`, { method: 'POST', body });
}

export async function omitDose(
  doseId: string,
  body: { readonly state: string; readonly reasonCode: string; readonly note?: string },
): Promise<MarDoseRow> {
  return request(`${V1}/nursing/mar/doses/${doseId}/omit`, { method: 'PATCH', body });
}

export async function verifyOrder(orderId: string, note?: string): Promise<{ readonly verified: boolean }> {
  return request(`${V1}/nursing/mar/orders/${orderId}/verify`, {
    method: 'PATCH',
    body: note === undefined ? {} : { note },
  });
}

export async function getEscalations(
  filters: { readonly wardId?: string; readonly openOnly?: boolean } = {},
  options: Signal = {},
): Promise<PageOf<EscalationRow>> {
  return request(
    `${V1}/nursing/escalations${queryString({ wardId: filters.wardId, openOnly: filters.openOnly })}`,
    withSignal(options),
  );
}

export async function acknowledgeEscalation(id: string, note?: string): Promise<EscalationRow> {
  return request(`${V1}/nursing/escalations/${id}/acknowledge`, {
    method: 'PATCH',
    body: note === undefined ? {} : { note },
  });
}

export async function resolveEscalation(id: string, outcome: string): Promise<EscalationRow> {
  return request(`${V1}/nursing/escalations/${id}/resolve`, { method: 'PATCH', body: { outcome } });
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 7C
//
// `runCharges` is safe to call twice. It is idempotent against a unique index
// on (admission, charge date, charge code, occupancy), so a retry, a
// double-click and two overlapping workers all produce the same bill.
// ─────────────────────────────────────────────────────────────────────────────

export async function getRunningBill(
  admissionId: string,
  includeSuperseded = false,
  options: Signal = {},
): Promise<RunningBillView> {
  return request(
    `${V1}/ipbill/running${queryString({ admissionId, includeSuperseded })}`,
    withSignal(options),
  );
}

export async function runCharges(body: {
  readonly forDate?: string;
  readonly admissionId?: string;
  readonly trigger?: string;
}): Promise<ChargeRunView> {
  return request(`${V1}/ipbill/charge-runs`, {
    method: 'POST',
    body,
    idempotencyKey: newIdempotencyKey(),
  });
}

export async function getChargeRuns(options: Signal = {}): Promise<readonly ChargeRunView[]> {
  return request(`${V1}/ipbill/charge-runs`, withSignal(options));
}

export async function getClearance(admissionId: string, options: Signal = {}): Promise<ClearanceView> {
  return request(`${V1}/ipbill/clearance/${admissionId}`, withSignal(options));
}

export async function clearDischarge(admissionId: string): Promise<ClearanceView> {
  return request(`${V1}/ipbill/clearance/${admissionId}/clear`, { method: 'PATCH', body: {} });
}

export async function overrideClearance(
  admissionId: string,
  acknowledgement: string,
  reason: string,
): Promise<ClearanceView> {
  return request(`${V1}/ipbill/clearance/${admissionId}/override`, {
    method: 'PATCH',
    body: { acknowledgement },
    reason,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 7D
//
// There is no `force`, no `emergencyMode` and no `skipTimeout` in this client,
// because there is none on the server. An emergency case gets a bumped elective
// case with a recorded reason — not a shorter checklist.
// ─────────────────────────────────────────────────────────────────────────────

export async function getOtBoard(
  filters: { readonly theatreId?: string; readonly date?: string; readonly openOnly?: boolean } = {},
  options: Signal = {},
): Promise<PageOf<OtCaseRow>> {
  return request(
    `${V1}/theatre/board${queryString({
      theatreId: filters.theatreId,
      date: filters.date,
      openOnly: filters.openOnly,
    })}`,
    withSignal(options),
  );
}

export async function getOtCase(id: string, options: Signal = {}): Promise<OtCaseDetail> {
  return request(`${V1}/theatre/cases/${id}`, withSignal(options));
}

export async function recordPreop(
  id: string,
  body: {
    readonly consentTaken?: boolean;
    readonly siteMarked?: boolean;
    readonly pacCleared?: boolean;
    readonly crossmatchRef?: string;
    readonly antibioticGiven?: boolean;
  },
): Promise<OtCaseDetail> {
  return request(`${V1}/theatre/cases/${id}/preop`, { method: 'PATCH', body });
}

/** One of the three phases. The order is enforced by the server. */
export async function runChecklist(
  id: string,
  phase: 'sign_in' | 'time_out' | 'sign_out',
  items: Readonly<Record<string, boolean | string>> = {},
): Promise<OtCaseDetail> {
  return request(`${V1}/theatre/cases/${id}/checklist`, { method: 'POST', body: { phase, items } });
}

export async function recordIntraop(
  id: string,
  body: Readonly<Record<string, unknown>>,
): Promise<OtCaseDetail> {
  return request(`${V1}/theatre/cases/${id}/intraop`, { method: 'PATCH', body });
}

export async function recordCounts(
  id: string,
  body: {
    readonly swabIn: number;
    readonly swabOut: number;
    readonly instrumentIn: number;
    readonly instrumentOut: number;
    readonly sharpsIn: number;
    readonly sharpsOut: number;
    readonly resolution?: string;
  },
): Promise<OtCaseDetail> {
  return request(`${V1}/theatre/cases/${id}/counts`, { method: 'PATCH', body });
}

export async function closeCase(
  id: string,
  body: { readonly operativeNote?: string; readonly postOpOrders?: string },
): Promise<OtCaseDetail> {
  return request(`${V1}/theatre/cases/${id}/close`, { method: 'PATCH', body });
}

export async function getCssdLoads(
  filters: { readonly state?: string } = {},
  options: Signal = {},
): Promise<PageOf<CssdLoadRow>> {
  return request(`${V1}/cssd/loads${queryString({ state: filters.state })}`, withSignal(options));
}

export async function recordIndicators(
  id: string,
  body: {
    readonly bowieDick?: string;
    readonly chemicalIndicator?: string;
    readonly biologicalIndicator?: string;
  },
): Promise<CssdLoadRow> {
  return request(`${V1}/cssd/loads/${id}/indicators`, { method: 'PATCH', body });
}

export async function releaseLoad(id: string): Promise<CssdLoadRow> {
  return request(`${V1}/cssd/loads/${id}/release`, { method: 'PATCH', body: {} });
}

/** Produces a list of patients, so it takes a reason. */
export async function recallLoad(id: string, reason: string): Promise<RecallResult> {
  return request(`${V1}/cssd/loads/${id}/recall`, { method: 'PATCH', body: {}, reason });
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 7E + 7F
//
// `transfuse` takes a second nurse and two scans, and nothing that could stand
// in for any of them. There is no `override` in this client because there is
// none on the server and no column in the schema that could express one.
// ─────────────────────────────────────────────────────────────────────────────

export async function getCodes(
  filters: { readonly openOnly?: boolean } = {},
  options: Signal = {},
): Promise<PageOf<CodeRow>> {
  return request(`${V1}/code/calls${queryString({ openOnly: filters.openOnly })}`, withSignal(options));
}

export async function getCode(id: string, options: Signal = {}): Promise<CodeDetail> {
  return request(`${V1}/code/calls/${id}`, withSignal(options));
}

export async function callCode(body: {
  readonly location: string;
  readonly patientId?: string;
  readonly cartId?: string;
}): Promise<CodeDetail> {
  return request(`${V1}/code/calls`, { method: 'POST', body, idempotencyKey: newIdempotencyKey() });
}

export async function recordCodeEvent(
  id: string,
  body: {
    readonly kind: string;
    readonly rhythm?: string;
    readonly joules?: number;
    readonly drug?: string;
    readonly dose?: string;
    readonly route?: string;
    readonly note?: string;
  },
): Promise<CodeDetail> {
  return request(`${V1}/code/calls/${id}/events`, { method: 'POST', body });
}

export async function closeCode(
  id: string,
  body: { readonly outcome: string; readonly ceaseReason?: string; readonly debriefNote?: string },
): Promise<CodeDetail> {
  return request(`${V1}/code/calls/${id}/close`, { method: 'PATCH', body });
}

export async function restockCart(id: string, resealedNo: string): Promise<CodeDetail> {
  return request(`${V1}/code/calls/${id}/restock`, {
    method: 'PATCH',
    body: { kind: 'full', findings: { restocked: true }, resealedNo },
  });
}

export async function getBloodInventory(
  filters: {
    readonly component?: string;
    readonly bloodGroup?: string;
    readonly availableOnly?: boolean;
  } = {},
  options: Signal = {},
): Promise<PageOf<BloodUnitRow>> {
  return request(
    `${V1}/blood/inventory${queryString({
      component: filters.component,
      bloodGroup: filters.bloodGroup,
      availableOnly: filters.availableOnly,
    })}`,
    withSignal(options),
  );
}
