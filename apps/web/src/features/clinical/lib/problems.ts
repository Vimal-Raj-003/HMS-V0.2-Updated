import { ApiProblem } from '@/lib/api';

/**
 * Reading a `problem+json` refusal for what it *means*, so the screen can print
 * an instruction instead of a status code.
 *
 * `docs/06` §1.1 heuristic 9 wants four things from an error: what happened,
 * what it means clinically, what to do next, and the reference for the helpdesk.
 * `ProblemCard` renders all four when the API supplies them — and the Phase-2
 * clinical API does supply them. What it cannot do is decide that a particular
 * refusal changes the *shape* of the screen: a hard stop must remove the submit
 * control, a missing weight must open the weight field, an optimistic-lock
 * conflict must offer a reload that keeps the doctor's text. That decision is
 * here.
 *
 * The `type` is an absolute URI (`https://errors.vimshms.com/clinical-hard-stop`),
 * so it is matched on its last segment rather than by string equality against a
 * host that may change.
 */

export function problemKind(error: unknown): string | null {
  if (!(error instanceof ApiProblem)) return null;
  const type = error.problem.type;
  const slash = type.lastIndexOf('/');
  return slash === -1 ? type : type.slice(slash + 1);
}

/** 422 `clinical-hard-stop` — the prescription, order or dose was stopped. */
export function isHardStop(error: unknown): boolean {
  return problemKind(error) === 'clinical-hard-stop';
}

/** 422 `business-rule-violated` — most often a soft stop with no coded reason. */
export function isBusinessRule(error: unknown): boolean {
  return problemKind(error) === 'business-rule-violated';
}

/** 409 `optimistic-lock-conflict` — somebody saved this encounter first. */
export function isVersionConflict(error: unknown): boolean {
  return problemKind(error) === 'optimistic-lock-conflict';
}

/** 403 `second-person-required` — a hard stop cannot be cleared by its prescriber. */
export function isSecondPersonRequired(error: unknown): boolean {
  return problemKind(error) === 'second-person-required';
}

/**
 * The missing-weight refusal, turned into the instruction it is.
 *
 * `POST /encounters/{id}/dosing-weight/check` answers a per-kilogram dose with a
 * `clinical-hard-stop` when `dosing_weight_source` is `unknown`. Rendered raw
 * that is a red card saying "Stopped for patient safety" over a 422 — true, but
 * not actionable. What the doctor needs to read is *record a weight first*, and
 * the API already says exactly that in `nextAction`; this makes sure the screen
 * never falls back to a status code when it does not.
 *
 * Returns `null` when the error is not that refusal, so a caller cannot
 * accidentally show a weight prompt for an unrelated failure.
 */
export interface WeightRequired {
  readonly title: string;
  readonly instruction: string;
  readonly clinicalImpact: string;
  readonly reference: string;
}

export function weightRequired(error: unknown): WeightRequired | null {
  if (!(error instanceof ApiProblem) || !isHardStop(error)) return null;
  const detail = error.problem.detail ?? '';
  const mentionsWeight = /weight/i.test(detail) || /weight/i.test(error.problem.nextAction ?? '');
  if (!mentionsWeight) return null;

  return {
    title: 'A weight is needed before this dose can be worked out',
    instruction:
      error.problem.nextAction ??
      'Record a weight on this consultation — measured from the vitals room, or stated, with who said so.',
    clinicalImpact:
      error.problem.clinicalImpact ??
      'A per-kilogram dose computed from a guessed weight is a dosing error, and in a child a ten-fold one.',
    reference: error.reference,
  };
}

/**
 * The alert ids a hard-stop refusal names.
 *
 * `hardStopError` puts one `errors[]` entry per blocking alert, with the alert
 * event id in `code` and the line in `path`. Those ids are what a countersigning
 * consultant posts against, so they are surfaced rather than discarded — without
 * them the second clinician has nothing to open.
 */
export function blockedAlertIds(error: unknown): readonly string[] {
  if (!(error instanceof ApiProblem)) return [];
  return (error.problem.errors ?? [])
    .map((fieldError) => fieldError.code)
    .filter((code): code is string => code !== undefined && code !== '');
}

/** Field messages keyed by their path, for attaching a message to its input. */
export function fieldMessages(error: unknown): ReadonlyMap<string, string> {
  if (!(error instanceof ApiProblem)) return new Map();
  return error.fieldErrors;
}
