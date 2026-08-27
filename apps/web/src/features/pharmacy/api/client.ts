import type { Page } from '@vims/contracts';
import { newIdempotencyKey, queryString, request } from './http';
import type {
  AddDispenseItemRequest,
  CoSignerInput,
  CompleteDispenseRequest,
  CreateDispenseRequest,
  CreateSaleReturnRequest,
  CustodyCheckRequest,
  CustodyCheckView,
  DayCloseRequest,
  DayCloseView,
  DeclineDispenseItemRequest,
  DispenseView,
  ExpiryActionRequest,
  ExpiryActionView,
  IdentityMethod,
  LabelView,
  PharmacyExpiryRow,
  PharmacyStockRow,
  RaiseRecallRequest,
  RecallTraceView,
  RecallView,
  RegisterEntryRequest,
  RegisterEntryView,
  RequestSubstitutionRequest,
  RxQueueView,
  SaleReturnView,
  SubstitutionView,
} from './types';

/**
 * Every call the pharmacy screens make.
 *
 * Five rules hold across the file. None of them is a style rule.
 *
 *  1. **Nothing here catches.** A refusal is a `ProblemDetails` the screen must
 *     render with its `reference` and `nextAction`. Swallowing a
 *     `clinical-hard-stop` or a `second-person-required` into a `null` leaves a
 *     pharmacist looking at a button that did nothing, with a queue behind them
 *     and no way to know why — which is how medicine gets handed over on the
 *     strength of a shrug.
 *  2. **Nothing here retries.** A refused completion is a decision, not a
 *     hiccup. Retrying it would be a second dispense of the same bag.
 *  3. **Every write carries an idempotency key, minted once per intent.** The
 *     API's interceptor fails closed without one. The key defaults per call so
 *     the *screen* has to opt into reusing one across a retry — which is the
 *     only way a retry is safe.
 *  4. **Every list is cursor-paginated with a bounded limit.** There is no
 *     "fetch everything" path in this file. `docs/07 §4` bans `OFFSET`, and a
 *     client that concatenated pages until `hasMore` went false would be an
 *     `OFFSET` scan wearing a different hat.
 *  5. **No PHI in a query string.** This is the rule this file is most
 *     opinionated about, because the API would let us break it: `GET
 *     /pharmacy/dispenses` accepts a `patientId` filter, and a patient's UUID in
 *     a URL reaches the browser history, the `Referer` header of anything the
 *     page loads, and every reverse-proxy access log between here and the
 *     database. `docs/04 §5` forbids it, so **`listDispenses` does not expose
 *     that filter at all**. A patient identifier in this feature travels in a
 *     request body or in a path segment the API already chose, never in a
 *     query.
 */

const V1 = '/api/v1';

interface Signal {
  readonly signal?: AbortSignal;
}

function withSignal(options: Signal): { signal?: AbortSignal } {
  return options.signal === undefined ? {} : { signal: options.signal };
}

/**
 * The interactive page ceiling (`PAGE_SIZE_MAX_INTERACTIVE` in
 * `packages/contracts`, and the API's own `limit` maximum). A counter worklist
 * of a thousand rows is a rendering problem and a privacy problem at once, so
 * no caller may ask for one — the limit is not a parameter of any function here.
 */
export const PAGE_LIMIT = 50;

// ═════════════════════════════════════════════════════════════════════════════
// OP-003 §3.1 — the prescription queue
// ═════════════════════════════════════════════════════════════════════════════

export async function listRxQueue(
  filters: {
    readonly pharmacyStoreId?: string | undefined;
    readonly status?: string | undefined;
    readonly assignedTo?: string | undefined;
    readonly cursor?: string | undefined;
  } = {},
  options: Signal = {},
): Promise<Page<RxQueueView>> {
  return request(
    `${V1}/pharmacy/queue${queryString({
      pharmacyStoreId: filters.pharmacyStoreId,
      status: filters.status,
      assignedTo: filters.assignedTo,
      cursor: filters.cursor,
      limit: PAGE_LIMIT,
    })}`,
    withSignal(options),
  );
}

export async function getRxQueueEntry(id: string, options: Signal = {}): Promise<RxQueueView> {
  return request(`${V1}/pharmacy/queue/${id}`, withSignal(options));
}

/**
 * OP-003 §3.2 step 1 — the patient is at the counter, and *how* that was
 * established is recorded rather than assumed.
 *
 * "We checked" is not evidence. The difference between a scanned wristband and
 * "asked their name" is the difference between a verified identity and a
 * good-faith belief, and the register has to be able to tell them apart a year
 * later.
 */
export async function markArrived(
  id: string,
  identityMethod: IdentityMethod,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<RxQueueView> {
  return request(`${V1}/pharmacy/queue/${id}/arrive`, {
    method: 'POST',
    body: { identityMethod },
    idempotencyKey,
  });
}

export async function assignRxQueueEntry(
  id: string,
  assignedTo: string,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<RxQueueView> {
  return request(`${V1}/pharmacy/queue/${id}/assign`, {
    method: 'POST',
    body: { assignedTo },
    idempotencyKey,
  });
}

export async function holdRxQueueEntry(
  id: string,
  reason: string,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<RxQueueView> {
  return request(`${V1}/pharmacy/queue/${id}/hold`, {
    method: 'POST',
    body: { reason },
    idempotencyKey,
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// OP-003 §3.2 / §3.3 — the dispense
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The dispense list.
 *
 * `patientId` is deliberately **not** a parameter — see rule 5 at the top of
 * this file. A screen that needs one patient's dispenses reaches them through
 * the queue entry or the dispense id it already has.
 */
export async function listDispenses(
  filters: {
    readonly pharmacyStoreId?: string | undefined;
    readonly status?: string | undefined;
    readonly from?: string | undefined;
    readonly cursor?: string | undefined;
  } = {},
  options: Signal = {},
): Promise<Page<DispenseView>> {
  return request(
    `${V1}/pharmacy/dispenses${queryString({
      pharmacyStoreId: filters.pharmacyStoreId,
      status: filters.status,
      from: filters.from,
      cursor: filters.cursor,
      limit: PAGE_LIMIT,
    })}`,
    withSignal(options),
  );
}

export async function getDispense(id: string, options: Signal = {}): Promise<DispenseView> {
  return request(`${V1}/pharmacy/dispenses/${id}`, withSignal(options));
}

export async function createDispense(
  body: CreateDispenseRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<DispenseView> {
  return request(`${V1}/pharmacy/dispenses`, { method: 'POST', body, idempotencyKey });
}

/**
 * The second pharmacist's signature, taken **before** the controlled line is
 * added.
 *
 * That ordering is the whole control. `pharmacy.enforce_dispense_line` reads
 * `dispenses.second_auth_user_id` at the moment the line is inserted, so the
 * second pharmacist is standing at the counter when the drug is picked rather
 * than signing afterwards for something they did not see.
 */
export async function addSecondAuthoriser(
  id: string,
  body: { readonly coSigner: CoSignerInput; readonly note?: string },
  idempotencyKey: string = newIdempotencyKey(),
): Promise<DispenseView> {
  return request(`${V1}/pharmacy/dispenses/${id}/second-authoriser`, {
    method: 'POST',
    body,
    idempotencyKey,
  });
}

/** Scan → batch validation → line. Refused unless the batch passes. */
export async function addDispenseItem(
  id: string,
  body: AddDispenseItemRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<DispenseView> {
  return request(`${V1}/pharmacy/dispenses/${id}/items`, { method: 'POST', body, idempotencyKey });
}

export async function declineDispenseItem(
  id: string,
  body: DeclineDispenseItemRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<DispenseView> {
  return request(`${V1}/pharmacy/dispenses/${id}/decline`, { method: 'POST', body, idempotencyKey });
}

/**
 * EN-029 on demand.
 *
 * This is **not** the gate. `complete` re-runs the whole evaluation inside its
 * own transaction against the facts as they are at that moment, so a screen that
 * called this and cached the answer would be checking the past. It exists so a
 * pharmacist can see the alerts while they are still picking, which is when
 * telephoning the prescriber is cheap.
 */
export async function runCdssCheck(id: string): Promise<DispenseView> {
  return request(`${V1}/pharmacy/dispenses/${id}/cdss-check`, { method: 'POST' });
}

export async function requestSubstitution(
  id: string,
  body: RequestSubstitutionRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<SubstitutionView> {
  return request(`${V1}/pharmacy/dispenses/${id}/substitutions`, {
    method: 'POST',
    body,
    idempotencyKey,
  });
}

export async function getSubstitution(id: string, options: Signal = {}): Promise<SubstitutionView> {
  return request(`${V1}/pharmacy/substitutions/${id}`, withSignal(options));
}

/**
 * Completion. The stock moves here, once, and the safety net is re-run first.
 *
 * `idempotencyKey` is a required argument rather than a defaulted one for this
 * call alone: the screen mints it when the pharmacist first presses "Complete"
 * and reuses the same key for every retry of that press. A key regenerated on
 * retry is exactly the same thing as having no key at all, and here that means
 * two bags.
 */
export async function completeDispense(
  id: string,
  body: CompleteDispenseRequest,
  idempotencyKey: string,
): Promise<DispenseView> {
  return request(`${V1}/pharmacy/dispenses/${id}/complete`, { method: 'POST', body, idempotencyKey });
}

export async function cancelDispense(
  id: string,
  reason: string,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<DispenseView> {
  return request(`${V1}/pharmacy/dispenses/${id}/cancel`, {
    method: 'POST',
    body: { reason },
    idempotencyKey,
  });
}

/**
 * The labels — `phase-04` exit gate 2, "labels print in English **and** one
 * Indian language".
 *
 * The API takes one to four locales and returns one label row per line per
 * locale. Which Indian language is the hospital's and the patient's business, so
 * the screen chooses it; what this function will not do is send a single locale
 * by accident, because gate 2 is not satisfied by an English label alone.
 */
export async function printLabels(
  id: string,
  locales: readonly string[],
): Promise<{ readonly labels: readonly LabelView[] }> {
  return request(`${V1}/pharmacy/dispenses/${id}/labels`, {
    method: 'POST',
    body: { locales },
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// OP-003 §3.4 — the counter's shelf
// ═════════════════════════════════════════════════════════════════════════════

export async function listPharmacyStock(
  filters: {
    readonly pharmacyStoreId: string;
    readonly q?: string | undefined;
    readonly expiringWithin?: number | undefined;
    readonly cursor?: string | undefined;
  },
  options: Signal = {},
): Promise<{ readonly items: readonly PharmacyStockRow[] }> {
  return request(
    `${V1}/pharmacy/stock${queryString({
      pharmacyStoreId: filters.pharmacyStoreId,
      q: filters.q,
      expiringWithin: filters.expiringWithin,
      cursor: filters.cursor,
      limit: PAGE_LIMIT,
    })}`,
    withSignal(options),
  );
}

export async function listPharmacyExpiry(
  filters: {
    readonly pharmacyStoreId?: string | undefined;
    readonly days?: number | undefined;
    readonly cursor?: string | undefined;
  } = {},
  options: Signal = {},
): Promise<{ readonly items: readonly PharmacyExpiryRow[] }> {
  return request(
    `${V1}/pharmacy/expiry${queryString({
      pharmacyStoreId: filters.pharmacyStoreId,
      days: filters.days,
      cursor: filters.cursor,
      limit: PAGE_LIMIT,
    })}`,
    withSignal(options),
  );
}

export async function actOnExpiry(
  body: ExpiryActionRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<ExpiryActionView> {
  return request(`${V1}/pharmacy/expiry-actions`, { method: 'POST', body, idempotencyKey });
}

// ═════════════════════════════════════════════════════════════════════════════
// OP-003 §3.5 — returns
// ═════════════════════════════════════════════════════════════════════════════

export async function createSaleReturn(
  body: CreateSaleReturnRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<SaleReturnView> {
  return request(`${V1}/pharmacy/returns`, { method: 'POST', body, idempotencyKey });
}

export async function getSaleReturn(id: string, options: Signal = {}): Promise<SaleReturnView> {
  return request(`${V1}/pharmacy/returns/${id}`, withSignal(options));
}

/** Approval is what moves the stock, and it is not the raiser's to give. */
export async function approveSaleReturn(
  id: string,
  note: string | undefined,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<SaleReturnView> {
  return request(`${V1}/pharmacy/returns/${id}/approve`, {
    method: 'POST',
    body: note === undefined || note === '' ? {} : { note },
    idempotencyKey,
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// OP-003 §3.4.6 — recalls
// ═════════════════════════════════════════════════════════════════════════════

export async function listRecalls(
  filters: { readonly status?: string | undefined; readonly cursor?: string | undefined } = {},
  options: Signal = {},
): Promise<Page<RecallView>> {
  return request(
    `${V1}/pharmacy/recalls${queryString({
      status: filters.status,
      cursor: filters.cursor,
      limit: PAGE_LIMIT,
    })}`,
    withSignal(options),
  );
}

export async function getRecall(id: string, options: Signal = {}): Promise<RecallView> {
  return request(`${V1}/pharmacy/recalls/${id}`, withSignal(options));
}

/** Raising it quarantines the batch everywhere, before anybody produces a list. */
export async function raiseRecall(
  body: RaiseRecallRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<RecallView> {
  return request(`${V1}/pharmacy/recalls`, { method: 'POST', body, idempotencyKey });
}

/** The patient list. Separately permissioned, because that list is PHI. */
export async function traceRecall(
  id: string,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<RecallTraceView> {
  return request(`${V1}/pharmacy/recalls/${id}/trace`, { method: 'POST', idempotencyKey });
}

export async function closeRecall(
  id: string,
  reason: string,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<RecallView> {
  return request(`${V1}/pharmacy/recalls/${id}/close`, {
    method: 'POST',
    body: { reason },
    idempotencyKey,
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// OP-003 §3.6 — the controlled-drug registers
// ═════════════════════════════════════════════════════════════════════════════

export async function listRegisterEntries(
  filters: {
    readonly storeId?: string | undefined;
    readonly registerType?: 'ndps' | 'schedule_x' | 'schedule_h1' | undefined;
    readonly itemId?: string | undefined;
    readonly from?: string | undefined;
    readonly cursor?: string | undefined;
  } = {},
  options: Signal = {},
): Promise<Page<RegisterEntryView>> {
  return request(
    `${V1}/pharmacy/controlled-register${queryString({
      storeId: filters.storeId,
      registerType: filters.registerType,
      itemId: filters.itemId,
      from: filters.from,
      cursor: filters.cursor,
      limit: PAGE_LIMIT,
    })}`,
    withSignal(options),
  );
}

/**
 * A register entry. The co-signer is not optional in the type, because it is not
 * optional in the register: NDPS is dual-authorisation, and a shape that could
 * omit the second pharmacist is a shape somebody will eventually send.
 */
export async function recordRegisterEntry(
  body: RegisterEntryRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<RegisterEntryView> {
  return request(`${V1}/pharmacy/controlled-register`, { method: 'POST', body, idempotencyKey });
}

export async function recordCustodyCheck(
  body: CustodyCheckRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<CustodyCheckView> {
  return request(`${V1}/pharmacy/custody-checks`, { method: 'POST', body, idempotencyKey });
}

// ═════════════════════════════════════════════════════════════════════════════
// OP-003 §3.7 — the day close
// ═════════════════════════════════════════════════════════════════════════════

export async function listDayCloses(
  filters: { readonly pharmacyStoreId?: string | undefined; readonly cursor?: string | undefined } = {},
  options: Signal = {},
): Promise<Page<DayCloseView>> {
  return request(
    `${V1}/pharmacy/day-close${queryString({
      pharmacyStoreId: filters.pharmacyStoreId,
      cursor: filters.cursor,
      limit: PAGE_LIMIT,
    })}`,
    withSignal(options),
  );
}

/**
 * Refused while a controlled-drug variance on that business date is unresolved
 * (`pharmacy.enforce_day_close_preconditions`, `phase-04` exit gate 4). The
 * screen renders that refusal rather than pre-empting it — the database is the
 * one that knows.
 */
export async function completeDayClose(
  body: DayCloseRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<DayCloseView> {
  return request(`${V1}/pharmacy/day-close`, { method: 'POST', body, idempotencyKey });
}
