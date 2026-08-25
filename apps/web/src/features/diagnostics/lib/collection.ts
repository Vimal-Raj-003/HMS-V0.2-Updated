import type { CollectSampleRequest, LabCollectionSite } from '../api/types';

/**
 * OP-004 §3.2.1 and §5 bullet 1 — the two-identifier check at collection.
 *
 * > "A collection is confirmed by scanning the patient and the container, or by
 * >  recording why that was impossible. OP-004 §5 allows no third answer."
 *
 * The API says the same thing twice: `collectSampleSchema` refines it, and
 * `lab_samples_two_identifier_check` asserts it in SQL. This module is the third
 * statement, and it exists for a reason the other two cannot serve: it is what
 * lets the **button** be disabled with a sentence, instead of enabled into a 400
 * that a phlebotomist standing at a bedside has to interpret.
 *
 * The override is deliberately *not* hidden behind a preference. EN-013 §5 and
 * OP-004 §5 both allow a documented override — a wristband that will not scan, a
 * dead printer, a neonate with no band — and a product that made that path
 * unreachable would simply move the workaround out of the audit trail. What it
 * refuses is the *silent* one: a collection recorded with neither scans nor a
 * reason.
 *
 * `minimumOverrideReasonLength` mirrors the API's `min(8)`. A shorter local
 * limit would let "ok" through to a 400; a longer one would refuse text the API
 * accepts.
 */

export const MIN_OVERRIDE_REASON = 8;

export interface CollectionFormState {
  readonly patientScanVerified: boolean;
  readonly containerScanVerified: boolean;
  readonly identityOverrideReason: string;
  readonly collectionSite: LabCollectionSite;
  readonly fasting: boolean | null;
  readonly fastingHours: string;
  readonly drawSite: string;
}

export const EMPTY_COLLECTION_FORM: CollectionFormState = {
  patientScanVerified: false,
  containerScanVerified: false,
  identityOverrideReason: '',
  collectionSite: 'opd_collection_room',
  fasting: null,
  fastingHours: '',
  drawSite: '',
};

export type IdentityVerdict =
  /** Both scans present. The ordinary path, and the only one that needs no words. */
  | { readonly kind: 'both_scans' }
  /** Neither or only one scan, but a documented reason. Audited, and lawful. */
  | { readonly kind: 'documented_override'; readonly reason: string }
  /** Not confirmable. Carries the sentence the screen shows. */
  | { readonly kind: 'blocked'; readonly message: string };

export function identityVerdict(form: CollectionFormState): IdentityVerdict {
  if (form.patientScanVerified && form.containerScanVerified) return { kind: 'both_scans' };

  const reason = form.identityOverrideReason.trim();
  if (reason.length >= MIN_OVERRIDE_REASON) return { kind: 'documented_override', reason };

  const missing = !form.patientScanVerified
    ? !form.containerScanVerified
      ? 'the patient and the container'
      : 'the patient'
    : 'the container';

  if (reason.length === 0) {
    return {
      kind: 'blocked',
      message: `Scan ${missing}, or record why that was not possible. OP-004 §5 allows no third answer.`,
    };
  }
  return {
    kind: 'blocked',
    message: `The override reason is too short. Write at least ${MIN_OVERRIDE_REASON} characters somebody reading the NABL register can act on.`,
  };
}

export function canCollect(form: CollectionFormState): boolean {
  return identityVerdict(form).kind !== 'blocked';
}

/**
 * Build the request. Throws rather than posting an unverifiable collection.
 *
 * Throwing is the right shape here: the screen has already asked
 * `identityVerdict` and disabled the button, so reaching this line means a code
 * path got past the gate — and a thrown error is loud where a silently-omitted
 * `identityOverrideReason` would be a specimen recorded as scan-verified when it
 * was not.
 */
export function toCollectRequest(form: CollectionFormState): CollectSampleRequest {
  const verdict = identityVerdict(form);
  if (verdict.kind === 'blocked') throw new Error(verdict.message);

  const fastingHours = Number.parseFloat(form.fastingHours);
  const drawSite = form.drawSite.trim();

  return {
    patientScanVerified: form.patientScanVerified,
    containerScanVerified: form.containerScanVerified,
    ...(verdict.kind === 'documented_override' ? { identityOverrideReason: verdict.reason } : {}),
    collectionSite: form.collectionSite,
    ...(form.fasting === null ? {} : { fasting: form.fasting }),
    ...(Number.isFinite(fastingHours) && fastingHours >= 0 ? { fastingHours } : {}),
    ...(drawSite === '' ? {} : { drawSite }),
  };
}

/**
 * EN-013 §5 bullet 6 — a sample label is never reprinted after collection
 * without the relabel workflow, which this build does not have.
 *
 * So the screen offers a reprint only while the specimen is still awaiting
 * collection, and says why when it does not. Reprinting a collected tube's label
 * is how two tubes end up wearing the same barcode with different blood in them.
 */
export function mayReprintLabel(sampleStatus: string): boolean {
  return sampleStatus === 'pending' || sampleStatus === 'awaiting_collection';
}

/**
 * OP-004 §3.2.3 — a rejected specimen is never resulted.
 *
 * The screen greys the bench actions for one, because "reject then result
 * anyway" is a path that produces a number from blood the laboratory has already
 * declared unfit.
 */
export function isRejected(sampleStatus: string): boolean {
  return sampleStatus === 'rejected';
}

/**
 * The order of the pre-analytical states, so the screen can show the specimen's
 * position in the chain rather than a bare status word.
 */
export const SAMPLE_STAGES = [
  'pending',
  'awaiting_collection',
  'collected',
  'dispatched',
  'received',
  'accessioned',
] as const;

export function stageIndex(status: string): number {
  return SAMPLE_STAGES.indexOf(status as (typeof SAMPLE_STAGES)[number]);
}
