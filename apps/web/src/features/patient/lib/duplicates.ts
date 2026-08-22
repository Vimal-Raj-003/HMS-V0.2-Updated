import { ApiProblem } from '@/lib/api';

/**
 * Reading OP-001 §3.1's duplicate hard stop out of the problem document.
 *
 * When `POST /patients` finds a candidate scoring ≥ 0.85 it refuses with a 422
 * `clinical-hard-stop` and puts the candidates in `errors[]`, because that is the
 * only structured channel RFC 9457 gives it. Each entry looks like:
 *
 *   path:    "overrideDuplicate/acknowledgedPatientIds/0"
 *   code:    "duplicate_suspected"
 *   message: "0021-45871 — SHARMA, Ramesh, male, 45 (id 018f…, score 0.90, mobile+dob, name+gender+dob)"
 *
 * Parsing a formatted string is not something to be pleased about, and the
 * comment in `patient.service.ts` says as much. Two things make it safe enough to
 * build a hard stop on:
 *
 *  1. **The parse is total.** Anything it cannot read is kept verbatim as
 *     `raw`, so the clerk still sees exactly what the server said.
 *  2. **A candidate with no id is not acknowledgeable**, and
 *     `canOverride` returns false for the whole set when any candidate lacks one.
 *     The server requires `acknowledgedPatientIds` to cover every blocking
 *     candidate; an override built from a half-parsed list would be refused
 *     anyway, and offering the button would teach the desk to press it twice.
 *
 * The right long-term fix is a typed `candidates` extension on the problem
 * document. That is a change to `packages/contracts` and `services/api`, both
 * outside this change's remit — recorded in the report rather than done quietly.
 */

export interface DuplicateCandidate {
  /** `null` when the message could not be parsed — see `canOverrideDuplicates`. */
  readonly patientId: string | null;
  readonly uhid: string | null;
  /**
   * Name, sex and age exactly as the server composed them — `SHARMA, Ramesh,
   * male, 45`. It is one field rather than three because the server sends one
   * string, and splitting a name on commas is how "SHARMA, Ramesh" becomes two
   * patients.
   */
  readonly descriptor: string | null;
  readonly score: number | null;
  readonly rules: readonly string[];
  /** Always the server's exact sentence, so nothing is hidden by a failed parse. */
  readonly raw: string;
}

const CANDIDATE_CODE = 'duplicate_suspected';

/**
 * `<uhid> — <name…> (id <uuid>, score <0.00>, <rule>, <rule>…)`
 *
 * The descriptor is matched lazily up to the parenthesised tail rather than by
 * counting commas: names contain commas (`SHARMA, Ramesh`) and so does the tail.
 */
const MESSAGE =
  /^(?<uhid>[^—]+)—\s*(?<descriptor>.*?)\s*\(id\s+(?<id>[0-9a-fA-F-]{36}),\s*score\s+(?<score>[0-9.]+)(?:,\s*(?<rules>[^)]*))?\)\s*$/u;

function parseMessage(message: string): DuplicateCandidate {
  const match = MESSAGE.exec(message);
  const groups = match?.groups;
  if (groups === undefined) {
    return { patientId: null, uhid: null, descriptor: null, score: null, rules: [], raw: message };
  }
  const score = Number.parseFloat(groups['score'] ?? '');
  const rules = (groups['rules'] ?? '')
    .split(',')
    .map((rule) => rule.trim())
    .filter((rule) => rule.length > 0);
  return {
    patientId: groups['id'] ?? null,
    uhid: (groups['uhid'] ?? '').trim(),
    descriptor: (groups['descriptor'] ?? '').trim(),
    score: Number.isNaN(score) ? null : score,
    rules,
    raw: message,
  };
}

/**
 * Whether this failure is the duplicate hard stop, as opposed to any other 422.
 *
 * Both halves are checked. The problem type alone would also match a future
 * clinical hard stop on this route; the field code alone would match a validation
 * failure that happened to reuse the code.
 */
export function isDuplicateHardStop(error: unknown): error is ApiProblem {
  if (!(error instanceof ApiProblem)) return false;
  if (!error.problem.type.endsWith('/clinical-hard-stop')) return false;
  return (error.problem.errors ?? []).some((field) => field.code === CANDIDATE_CODE);
}

export function parseDuplicateCandidates(error: ApiProblem): readonly DuplicateCandidate[] {
  return (error.problem.errors ?? [])
    .filter((field) => field.code === CANDIDATE_CODE)
    .map((field) => parseMessage(field.message));
}

/**
 * Whether an override can even be attempted for this candidate set.
 *
 * The server refuses an override whose `acknowledgedPatientIds` does not cover
 * every blocking candidate, so an unparseable candidate makes the whole set
 * un-overridable. The screen then says so, and points at the only safe route:
 * find the existing record.
 */
export function canOverrideDuplicates(candidates: readonly DuplicateCandidate[]): boolean {
  return candidates.length > 0 && candidates.every((candidate) => candidate.patientId !== null);
}

export function acknowledgedIds(candidates: readonly DuplicateCandidate[]): readonly string[] {
  const ids: string[] = [];
  for (const candidate of candidates) {
    if (candidate.patientId !== null) ids.push(candidate.patientId);
  }
  return ids;
}

/**
 * The API's minimum reason length (`patient.schemas.ts`: "Give a reason somebody
 * reading the register can act on", `min(8)`).
 *
 * Duplicated here so the desk is told before the round trip, not after. If the
 * server's rule changes, this being stale costs one rejected save with a clear
 * field error — not a silent divergence.
 */
export const MIN_REASON_LENGTH = 8;

export function isUsableReason(reason: string): boolean {
  return reason.trim().length >= MIN_REASON_LENGTH;
}
