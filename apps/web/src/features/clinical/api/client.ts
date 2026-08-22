import { newIdempotencyKey, queryString, request } from './http';
import type {
  AcknowledgeVitalsAlertRequest,
  AlertFatigueReport,
  AlertListItem,
  AlertResponseRequest,
  AllergyItem,
  AmendEncounterRequest,
  CompleteEncounterRequest,
  CreateOrderRequest,
  CreatePrescriptionRequest,
  CreateVitalsRequest,
  DiagnosisInput,
  DosingContext,
  DrugSearchResult,
  EncounterDetail,
  EvaluateRequest,
  EvaluationView,
  MedicationItem,
  NoteHistory,
  OrderView,
  Page,
  PrescriptionView,
  ProblemItem,
  RecheckRequest,
  RecordAllergyRequest,
  ReferenceRangeRow,
  TimelineItem,
  UpdateEncounterRequest,
  VitalsAlertView,
  VitalsDetail,
  VitalsRow,
} from './types';

/**
 * Every call the four clinical screens make.
 *
 * Three rules hold across the file, and each one is a patient-safety rule rather
 * than a style rule:
 *
 *  1. **Nothing here catches.** A refusal is a `ProblemDetails` the screen must
 *     render with its `reference`, `clinicalImpact` and `nextAction`. Swallowing
 *     a `clinical-hard-stop` into a `null` is how a doctor ends up with a blank
 *     panel where a refusal should have been, and no way to know the
 *     prescription was not written.
 *  2. **Nothing here retries.** The query client already declines to retry a
 *     4xx, and a refused prescription is a decision, not a hiccup. There is no
 *     code path in this feature that re-submits a prescription the API stopped.
 *  3. **`reason` is a required parameter on exactly the calls whose permission
 *     key is `requiresReason`** — `opd.encounter.amend`, `rx.amend`,
 *     `cdss.alert.respond` — so a caller cannot forget it and discover the
 *     omission as a 403 in production.
 */

const V1 = '/api/v1';

interface Signal {
  readonly signal?: AbortSignal;
}

function withSignal(options: Signal): { signal?: AbortSignal } {
  return options.signal === undefined ? {} : { signal: options.signal };
}

// ── vitals (OP-007 §6) ───────────────────────────────────────────────────────

/**
 * The hospital's configured bands.
 *
 * Gated on `vitals.configure`, which is the module's own choice (OP-007 §6 puts
 * `/reference-ranges` on the config row) and which the **vitals nurse does not
 * hold**. See `lib/ranges.ts` and `components/vitals-room-screen.tsx`: the
 * screen asks only when the session holds the key, and when it does not it says
 * that live flagging is unavailable rather than inventing a threshold.
 */
export async function listReferenceRanges(options: Signal = {}): Promise<Page<ReferenceRangeRow>> {
  return request<Page<ReferenceRangeRow>>(
    `${V1}/vitals/reference-ranges${queryString({ limit: 100 })}`,
    withSignal(options),
  );
}

export async function listVitals(
  filters: { readonly patient: string; readonly limit?: number },
  options: Signal = {},
): Promise<Page<VitalsRow>> {
  return request<Page<VitalsRow>>(
    `${V1}/vitals/records${queryString({ patient: filters.patient, limit: filters.limit ?? 10 })}`,
    withSignal(options),
  );
}

export async function getVitals(id: string, options: Signal = {}): Promise<VitalsDetail> {
  return request<VitalsDetail>(`${V1}/vitals/records/${id}`, withSignal(options));
}

export async function recordVitals(
  body: CreateVitalsRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<VitalsDetail> {
  return request<VitalsDetail>(`${V1}/vitals/records`, { method: 'POST', body, idempotencyKey });
}

export async function acknowledgeVitalsAlert(
  vitalsId: string,
  alertId: string,
  body: AcknowledgeVitalsAlertRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<VitalsAlertView> {
  return request<VitalsAlertView>(`${V1}/vitals/records/${vitalsId}/alerts/${alertId}/ack`, {
    method: 'POST',
    body,
    idempotencyKey,
  });
}

export async function requestRecheck(
  body: RecheckRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<{ readonly requested: true }> {
  return request<{ readonly requested: true }>(`${V1}/vitals/recheck-requests`, {
    method: 'POST',
    body,
    idempotencyKey,
  });
}

// ── encounters (OP-002 §6) ───────────────────────────────────────────────────

export async function getEncounter(id: string, options: Signal = {}): Promise<EncounterDetail> {
  return request<EncounterDetail>(`${V1}/encounters/${id}`, withSignal(options));
}

export async function startEncounter(
  body: { readonly visitId: string; readonly type?: string; readonly cosignRequired?: boolean },
  idempotencyKey: string = newIdempotencyKey(),
): Promise<EncounterDetail> {
  return request<EncounterDetail>(`${V1}/encounters`, { method: 'POST', body, idempotencyKey });
}

/** The five-second autosave. Not idempotency-keyed: it is a patch under an optimistic lock. */
export async function updateEncounter(id: string, body: UpdateEncounterRequest): Promise<EncounterDetail> {
  return request<EncounterDetail>(`${V1}/encounters/${id}`, { method: 'PATCH', body });
}

export async function recordDiagnoses(
  id: string,
  diagnoses: readonly DiagnosisInput[],
  idempotencyKey: string = newIdempotencyKey(),
): Promise<EncounterDetail> {
  return request<EncounterDetail>(`${V1}/encounters/${id}/diagnoses`, {
    method: 'POST',
    body: { diagnoses },
    idempotencyKey,
  });
}

export async function setDosingWeight(
  id: string,
  body:
    | { readonly source: 'measured'; readonly vitalsId: string }
    | { readonly source: 'stated'; readonly weightKg: number }
    | { readonly source: 'estimated'; readonly weightKg: number },
  idempotencyKey: string = newIdempotencyKey(),
): Promise<EncounterDetail> {
  return request<EncounterDetail>(`${V1}/encounters/${id}/dosing-weight`, {
    method: 'POST',
    body,
    idempotencyKey,
  });
}

/**
 * The per-kilogram precondition (exit gate 3).
 *
 * Refuses with `clinical-hard-stop` when the encounter has no dosing weight.
 * That refusal is an instruction — "record a weight first" — and
 * `lib/problems.ts` is what turns it into one on screen.
 */
export async function checkDosing(
  id: string,
  body: { readonly mgPerKg: number; readonly drugLabel?: string },
): Promise<DosingContext> {
  return request<DosingContext>(`${V1}/encounters/${id}/dosing-weight/check`, { method: 'POST', body });
}

export async function completeEncounter(
  id: string,
  body: CompleteEncounterRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<EncounterDetail> {
  return request<EncounterDetail>(`${V1}/encounters/${id}/complete`, {
    method: 'POST',
    body,
    idempotencyKey,
  });
}

/**
 * `opd.encounter.amend` is `requiresReason`, so the reason travels twice: as the
 * `x-reason` header the policy guard demands *before* the handler runs, and in
 * the body, where it is what the amended version is stamped with. They are the
 * same sentence on purpose — a doctor types one reason, not two.
 */
export async function amendEncounter(
  id: string,
  body: AmendEncounterRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<EncounterDetail> {
  return request<EncounterDetail>(`${V1}/encounters/${id}/amend`, {
    method: 'POST',
    body,
    reason: body.reason,
    idempotencyKey,
  });
}

export async function getNoteVersions(id: string, options: Signal = {}): Promise<NoteHistory> {
  return request<NoteHistory>(`${V1}/encounters/${id}/note-versions`, withSignal(options));
}

// ── patient clinical record ──────────────────────────────────────────────────

export async function getTimeline(
  patientId: string,
  filters: { readonly types?: string; readonly limit?: number } = {},
  options: Signal = {},
): Promise<Page<TimelineItem>> {
  return request<Page<TimelineItem>>(
    `${V1}/patients/${patientId}/timeline${queryString({
      ...(filters.types === undefined ? {} : { types: filters.types }),
      limit: filters.limit ?? 50,
    })}`,
    withSignal(options),
  );
}

export async function getProblems(patientId: string, options: Signal = {}): Promise<readonly ProblemItem[]> {
  return request<readonly ProblemItem[]>(`${V1}/patients/${patientId}/problems`, withSignal(options));
}

export async function getMedications(
  patientId: string,
  options: Signal = {},
): Promise<readonly MedicationItem[]> {
  return request<readonly MedicationItem[]>(`${V1}/patients/${patientId}/medications`, withSignal(options));
}

export async function getAllergies(patientId: string, options: Signal = {}): Promise<readonly AllergyItem[]> {
  return request<readonly AllergyItem[]>(`${V1}/patients/${patientId}/allergies`, withSignal(options));
}

export async function recordAllergy(
  patientId: string,
  body: RecordAllergyRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<AllergyItem> {
  return request<AllergyItem>(`${V1}/patients/${patientId}/allergies`, {
    method: 'POST',
    body,
    idempotencyKey,
  });
}

// ── prescribing and CDSS ─────────────────────────────────────────────────────

export async function searchDrugs(
  term: string,
  options: Signal = {},
): Promise<{ readonly items: readonly DrugSearchResult[] }> {
  return request<{ readonly items: readonly DrugSearchResult[] }>(
    `${V1}/drugs/search${queryString({ q: term, limit: 20 })}`,
    withSignal(options),
  );
}

/**
 * The safety check, run as the doctor builds the prescription.
 *
 * Deliberately **not** idempotency-keyed: it is a fresh evaluation against a
 * context that may have changed since the last one, and replaying a cached
 * answer is precisely the behaviour a safety check must not have. The API says
 * the same thing on its side of the wire.
 */
export async function evaluate(body: EvaluateRequest, options: Signal = {}): Promise<EvaluationView> {
  return request<EvaluationView>(`${V1}/cdss/evaluate`, {
    method: 'POST',
    body,
    ...withSignal(options),
  });
}

export async function createPrescription(
  body: CreatePrescriptionRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<PrescriptionView> {
  return request<PrescriptionView>(`${V1}/prescriptions`, { method: 'POST', body, idempotencyKey });
}

export async function getPrescription(id: string, options: Signal = {}): Promise<PrescriptionView> {
  return request<PrescriptionView>(`${V1}/prescriptions/${id}`, withSignal(options));
}

export async function recheckPrescription(id: string): Promise<EvaluationView> {
  return request<EvaluationView>(`${V1}/prescriptions/${id}/cdss-check`, { method: 'POST', body: {} });
}

export async function signPrescription(
  id: string,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<PrescriptionView> {
  return request<PrescriptionView>(`${V1}/prescriptions/${id}/sign`, {
    method: 'POST',
    body: { signMethod: 'system' },
    idempotencyKey,
  });
}

export async function cosignPrescription(
  id: string,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<PrescriptionView> {
  return request<PrescriptionView>(`${V1}/prescriptions/${id}/cosign`, {
    method: 'POST',
    body: { signMethod: 'countersign' },
    idempotencyKey,
  });
}

export async function listAlerts(
  filters: { readonly patientId?: string; readonly encounterId?: string },
  options: Signal = {},
): Promise<Page<AlertListItem>> {
  return request<Page<AlertListItem>>(
    `${V1}/cdss/alerts${queryString({
      ...(filters.patientId === undefined ? {} : { patientId: filters.patientId }),
      ...(filters.encounterId === undefined ? {} : { encounterId: filters.encounterId }),
      limit: 50,
    })}`,
    withSignal(options),
  );
}

/**
 * The clinician's response to one alert — and, for a product hard stop, the only
 * lawful way past it.
 *
 * `cdss.alert.respond` is `requiresReason`, so `reason` is a **required**
 * parameter here rather than an optional one. The API additionally refuses a
 * hard-stop response that is not an override, one from the prescriber who raised
 * it, and one against a floor entry that admits no countersignature at all. This
 * client makes none of those judgements; it just never sends a request that
 * pretends otherwise.
 */
export async function respondToAlert(
  alertId: string,
  body: AlertResponseRequest,
  reason: string,
): Promise<{ readonly actionId: string }> {
  return request<{ readonly actionId: string }>(`${V1}/cdss/alerts/${alertId}/respond`, {
    method: 'POST',
    body,
    reason,
  });
}

export async function getAlertFatigue(days: number, options: Signal = {}): Promise<AlertFatigueReport> {
  return request<AlertFatigueReport>(
    `${V1}/cdss/reports/alert-fatigue${queryString({ days })}`,
    withSignal(options),
  );
}

// ── CPOE ─────────────────────────────────────────────────────────────────────

export async function createOrder(
  body: CreateOrderRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<OrderView> {
  return request<OrderView>(`${V1}/orders`, { method: 'POST', body, idempotencyKey });
}

export async function listOrders(patientId: string, options: Signal = {}): Promise<Page<OrderView>> {
  return request<Page<OrderView>>(
    `${V1}/orders${queryString({ patientId, limit: 25 })}`,
    withSignal(options),
  );
}

export async function cancelOrder(
  id: string,
  reason: string,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<OrderView> {
  return request<OrderView>(`${V1}/orders/${id}/cancel`, {
    method: 'POST',
    body: { reason },
    reason,
    idempotencyKey,
  });
}
