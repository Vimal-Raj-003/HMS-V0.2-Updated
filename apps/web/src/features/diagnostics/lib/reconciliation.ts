import type { PacsStudyView } from '../api/types';

/**
 * EN-008 §3.3, §5 and AC §14.4 — "never silently attach to wrong patient".
 *
 * The archive links a study to a patient automatically only when it matched on
 * an identity the RIS itself minted: the **accession number**, or the **Study
 * Instance UID** the worklist published. Everything else — a demographic
 * resemblance, a hand-typed PatientID, a study that arrived with nothing at all
 * — is a *guess*, and a guess goes to this queue rather than into a chart.
 *
 * **Name is not a match key anywhere in the spec, and it is not one here.** The
 * screen offers no "match by name" action, no fuzzy candidate list ranked by
 * surname, and no bulk-confirm. A confirmation of a guessed match names the
 * patient, in a field the human fills in, and `rad.study.reconcile` is
 * `requiresReason` so the decision is signed.
 *
 * The API refuses the same thing (`pacs.service.ts` `reconcile`) and the CHECK
 * `pacs_studies_match_requires_review` refuses it again from underneath. This
 * module exists so the screen asks the right question rather than discovering
 * the refusal as a 422 after the click.
 */

/** The bases on which the archive may auto-link. Everything else is a guess. */
export const TRUSTED_MATCH_BASES: readonly string[] = ['accession', 'study_uid', 'mwl', 'manual'];

export type ReconcileMode =
  /** Matched on an identity the RIS minted: one click confirms it. */
  | { readonly kind: 'confirm_trusted'; readonly basis: string }
  /** A demographic resemblance or nothing at all: the human must name the patient. */
  | { readonly kind: 'name_the_patient'; readonly basis: string }
  /** Already settled — the API answers `ALREADY_DECIDED`, so the screen says so first. */
  | { readonly kind: 'already_reconciled' };

export function reconcileMode(study: PacsStudyView): ReconcileMode {
  if (study.reconciliationStatus === 'reconciled') return { kind: 'already_reconciled' };
  if (TRUSTED_MATCH_BASES.includes(study.matchedBy) && study.patientId !== null) {
    return { kind: 'confirm_trusted', basis: study.matchedBy };
  }
  return { kind: 'name_the_patient', basis: study.matchedBy };
}

/**
 * Why this study is in the queue, in words a technologist can act on.
 *
 * "needs_review" on its own tells nobody anything; what they need to know is
 * whether the archive had an identifier to work with at all.
 */
export function whyInQueue(study: PacsStudyView): string {
  switch (study.matchedBy) {
    case 'fallback':
      return 'The archive matched this on a demographic resemblance, not on an accession number. Confirming it means naming the patient it belongs to.';
    case 'unmatched':
      return 'This study arrived with no accession number and no Study Instance UID the worklist recognises. Nothing links it to a patient yet.';
    case 'accession':
      return 'Matched on the accession number, but the study has not been confirmed against the order.';
    case 'study_uid':
      return 'Matched on the Study Instance UID published to the modality worklist, but not yet confirmed.';
    case 'mwl':
      return 'Matched from the modality worklist entry, but not yet confirmed.';
    case 'manual':
      return 'A person linked this study by hand. It stays here until a second look confirms it.';
    default:
      return `The archive recorded the match basis as "${study.matchedBy}", which this screen does not recognise. Treat it as unconfirmed.`;
  }
}

/**
 * EN-035 AC §14.6 — an unreconciled study is quarantined and cannot be reported.
 *
 * The reading worklist shows the fact rather than hiding the row: a radiologist
 * who cannot find the study they were told about will go and look for it in the
 * archive directly, which is worse.
 */
export function isQuarantined(study: PacsStudyView): boolean {
  return study.reconciliationStatus === 'needs_review' || study.patientId === null;
}

/**
 * Human-readable study size.
 *
 * `sizeBytes` is a decimal string because the column is `bigint` — a CT with
 * thin slices passes `Number.MAX_SAFE_INTEGER` sooner than intuition suggests,
 * and `JSON.parse` would have silently rounded it. Parsed once, here, with the
 * unparseable case rendered as unknown rather than as zero.
 */
export function formatStudySize(sizeBytes: string): string {
  const bytes = Number(sizeBytes);
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit] ?? 'TB'}`;
}
