import { apiFetch } from '@/lib/api';
import { idempotentFetch } from './http';
import type {
  DedupeCandidateItem,
  DemographicHistoryItem,
  Gender,
  MergePreview,
  MergeResult,
  Page,
  PatientDetail,
  PatientListItem,
  UnmergeResult,
  VisitListItem,
} from './types';

/**
 * The front office's calls into `/api/v1/patients` (OP-001 §6).
 *
 * Every one goes through the same-origin proxy in `app/api/v1/[...path]`, so the
 * bearer token stays in an httpOnly cookie the browser cannot read.
 *
 * `reason` appears on exactly the calls whose permission key is
 * `requiresReason` in the catalogue — `patient.record.update`,
 * `patient.record.create_override` and `patient.merge.execute`. For those the
 * policy engine returns 403 `reason_required` when the `x-reason` header is
 * absent, so the parameter is **required** here rather than optional: a caller
 * cannot forget it and discover the omission as a permission error at a counter
 * with twenty people queueing.
 *
 * The reason travels twice on purpose, the same split `features/admin` uses: the
 * header is what the policy engine reads before the handler runs; the body is
 * what lands in `patient.demographic_history`, in `patient.merges.reason` and in
 * the audit register. They are deliberately the same string.
 */

const BASE = '/api/v1/patients';

function query(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const rendered = search.toString();
  return rendered === '' ? '' : `?${rendered}`;
}

interface Signal {
  readonly signal?: AbortSignal;
}

function withSignal(options: Signal): { signal?: AbortSignal } {
  return options.signal === undefined ? {} : { signal: options.signal };
}

// ── search ───────────────────────────────────────────────────────────────────

/**
 * OP-001 §6 `GET /patients?q=&mobile=&uhid=&abha=&identifier=`.
 *
 * The five parameters are **not** combined by the server: each names a different
 * index, and a query that ORs them together uses none of them. `PatientSearchService`
 * routes on precedence, so this client sends exactly one of them — whichever
 * `detectSearchMode` classified the typed text as.
 */
export interface PatientSearchCriteria {
  readonly q?: string;
  readonly mobile?: string;
  readonly uhid?: string;
  readonly abha?: string;
  readonly identifier?: string;
  readonly includeInactive?: boolean;
}

export async function searchPatients(
  criteria: PatientSearchCriteria,
  cursor?: string,
  options: Signal = {},
): Promise<Page<PatientListItem>> {
  return apiFetch<Page<PatientListItem>>(
    `${BASE}${query({ ...criteria, cursor, limit: 20 })}`,
    withSignal(options),
  );
}

/**
 * The recent-patients list (phase-01 §1.2). `GET /patients` with no criteria is
 * the recent list by contract — see `PatientSearchService`.
 */
export async function listRecentPatients(options: Signal = {}): Promise<Page<PatientListItem>> {
  return apiFetch<Page<PatientListItem>>(`${BASE}${query({ limit: 8 })}`, withSignal(options));
}

// ── read ─────────────────────────────────────────────────────────────────────

export async function getPatient(id: string, options: Signal = {}): Promise<PatientDetail> {
  return apiFetch<PatientDetail>(`${BASE}/${id}`, withSignal(options));
}

export async function getPatientHistory(
  id: string,
  cursor?: string,
  options: Signal = {},
): Promise<Page<DemographicHistoryItem>> {
  return apiFetch<Page<DemographicHistoryItem>>(
    `${BASE}/${id}/history${query({ cursor, limit: 25 })}`,
    withSignal(options),
  );
}

/**
 * `GET /visits?patientId=` — the visit history strip on Patient 360.
 *
 * It is a *different module's* route (OPD scheduling) under a different
 * permission (`visit.list`), which is why the screen gates it separately and
 * renders the rest of the record when the session does not hold it. A
 * receptionist holds it; an auditor with `patient.record.read` alone does not,
 * and losing the whole 360 view over one absent strip would be wrong.
 */
export async function listPatientVisits(
  patientId: string,
  options: Signal = {},
): Promise<Page<VisitListItem>> {
  return apiFetch<Page<VisitListItem>>(
    `/api/v1/visits${query({ patientId, limit: 25 })}`,
    withSignal(options),
  );
}

// ── register ─────────────────────────────────────────────────────────────────

export interface RegisterAddressInput {
  readonly line1?: string;
  readonly line2?: string;
  readonly city?: string;
  readonly district?: string;
  readonly state?: string;
  readonly countryCode?: string;
  readonly pincode?: string;
}

export interface RegisterContactInput {
  readonly kind: 'emergency' | 'attendant' | 'guardian' | 'next_of_kin' | 'nominee';
  readonly name: string;
  readonly relationshipCode?: string;
  readonly phone: string;
  readonly isGuardian: boolean;
  readonly isPrimary: boolean;
}

/**
 * The three statements a **client** may assert. `known` is deliberately absent:
 * `patient.trg_allergies_sync_statement` promotes the statement to `known` when
 * an active entry exists, and a client that could set it by hand would produce a
 * banner reading "allergies recorded" over an empty list. Recording the entries
 * themselves is EN-029, which is not this phase.
 */
export interface RegisterAllergyInput {
  readonly statement: 'not_recorded' | 'unable_to_assess' | 'none_known';
  readonly unableReason?: string;
}

export interface RegisterPatientInput {
  readonly branchId?: string;
  readonly titleCode?: string;
  readonly firstName: string;
  readonly middleName?: string;
  readonly lastName?: string;
  readonly gender: Gender;
  readonly dob?: string;
  readonly ageYears?: number;
  readonly ageMonths?: number;
  readonly ageDays?: number;
  readonly bloodGroup?: string;
  readonly maritalStatus?: string;
  readonly mobile: string;
  readonly altPhone?: string;
  readonly email?: string;
  readonly whatsappOptIn?: boolean;
  readonly preferredLanguage?: string;
  readonly religionCode?: string;
  readonly occupationCode?: string;
  /** The government photo ID shown at the desk. **Never Aadhaar** (OP-001 §5). */
  readonly idTypeCode?: string;
  readonly idLast4?: string;
  readonly abhaNumber?: string;
  readonly abhaAddress?: string;
  readonly address?: RegisterAddressInput;
  readonly category?: string;
  readonly payerType?: string;
  readonly payerRef?: string;
  readonly referralSourceCode?: string;
  readonly referredByText?: string;
  readonly isVip?: boolean;
  readonly isDifferentlyAbled?: boolean;
  readonly isPregnant?: boolean;
  readonly sourceChannel?: 'counter' | 'kiosk' | 'online' | 'app' | 'call_centre' | 'ivr' | 'camp';
  readonly allergy?: RegisterAllergyInput;
  readonly contacts?: readonly RegisterContactInput[];
  /**
   * OP-001 §3.1 / §14 AC-2. Present **only** when a human has read the candidate
   * list and decided these are different people. There is no code path that adds
   * it automatically: see `registration-desk.tsx`, where the hard stop cannot be
   * dismissed into a retry.
   */
  readonly overrideDuplicate?: {
    readonly acknowledgedPatientIds: readonly string[];
    readonly reason: string;
  };
}

/**
 * `POST /patients` is `@Idempotent()`, so the key is a required argument rather
 * than something this function invents: a key minted here would be new on every
 * call, which is precisely the retry the interceptor exists to absorb. The desk
 * owns the key and mints one per submission (`docs/06` §6.6).
 */
export async function registerPatient(
  input: RegisterPatientInput,
  idempotencyKey: string,
): Promise<PatientDetail> {
  const override = input.overrideDuplicate;
  // `patient.record.create_override` is `requiresReason`, so the override path
  // needs the header too. A plain registration needs none, and sending one would
  // put a reason in the audit register for an action nobody had to justify.
  return idempotentFetch<PatientDetail>(BASE, {
    method: 'POST',
    body: input,
    idempotencyKey,
    ...(override === undefined ? {} : { reason: override.reason }),
  });
}

// ── amend ────────────────────────────────────────────────────────────────────

export interface UpdatePatientInput {
  readonly version: number;
  readonly reason: string;
  readonly channel?: 'desk' | 'portal' | 'kiosk' | 'import' | 'abdm' | 'api';
  readonly titleCode?: string | null;
  readonly firstName?: string;
  readonly middleName?: string | null;
  readonly lastName?: string | null;
  readonly gender?: Gender;
  readonly dob?: string;
  readonly bloodGroup?: string;
  readonly maritalStatus?: string | null;
  readonly mobile?: string;
  readonly altPhone?: string | null;
  readonly email?: string | null;
  readonly whatsappOptIn?: boolean;
  readonly preferredLanguage?: string;
  readonly religionCode?: string | null;
  readonly occupationCode?: string | null;
  readonly address?: RegisterAddressInput;
  readonly category?: string;
  readonly payerType?: string;
  readonly payerRef?: string | null;
  readonly isVip?: boolean;
  readonly isDifferentlyAbled?: boolean;
  readonly isPregnant?: boolean;
}

export async function updatePatient(id: string, input: UpdatePatientInput): Promise<PatientDetail> {
  return apiFetch<PatientDetail>(`${BASE}/${id}`, {
    method: 'PATCH',
    body: input,
    reason: input.reason,
  });
}

// ── dedupe & merge ───────────────────────────────────────────────────────────

export async function listDedupeCandidates(
  filters: { readonly status: string; readonly minScore: number },
  cursor?: string,
  options: Signal = {},
): Promise<Page<DedupeCandidateItem>> {
  return apiFetch<Page<DedupeCandidateItem>>(
    `${BASE}/dedupe${query({ ...filters, cursor, limit: 25 })}`,
    withSignal(options),
  );
}

export interface PrepareMergeInput {
  readonly survivorId: string;
  readonly victimId: string;
  readonly reason: string;
  readonly fieldChoices: Readonly<Record<string, 'survivor' | 'victim'>>;
}

/**
 * Step one of OP-001 §5's mandatory two-step merge: writes the pending merge and
 * its snapshots and returns the impact, without touching a single row of either
 * record.
 */
export async function prepareMerge(input: PrepareMergeInput, idempotencyKey: string): Promise<MergePreview> {
  return idempotentFetch<MergePreview>(`${BASE}/merge`, {
    method: 'POST',
    body: { step: 'prepare', ...input },
    reason: input.reason,
    idempotencyKey,
  });
}

/**
 * Step two: executes **that specific prepared merge** by id. The split is the
 * point — the officer confirms the exact comparison they were shown, so a record
 * that changed between the two steps cannot be merged unseen.
 */
export async function commitMerge(
  mergeId: string,
  reason: string,
  idempotencyKey: string,
): Promise<MergeResult> {
  return idempotentFetch<MergeResult>(`${BASE}/merge`, {
    method: 'POST',
    body: { step: 'commit', mergeId },
    reason,
    idempotencyKey,
  });
}

export async function unmerge(
  mergeId: string,
  reason: string,
  idempotencyKey: string,
): Promise<UnmergeResult> {
  return idempotentFetch<UnmergeResult>(`${BASE}/unmerge`, {
    method: 'POST',
    body: { mergeId, reason },
    reason,
    idempotencyKey,
  });
}
