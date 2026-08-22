import type { ReasonOption } from '@vims/ui';

/**
 * The coded override reasons, EN-029 §5.
 *
 * **This list is a stop-gap and it is a reported gap, not a design.** The reasons
 * are hospital-configurable master data — `clinical.cdss_override_reasons`, seeded
 * per reason set and validated by the API against the rule's own set — and the
 * Phase-2 API exposes **no endpoint that lists them**. There is no
 * `GET /cdss/override-reasons` and no `masters/{kind}` arm for them.
 *
 * The three options that leaves are: offer free text alone (refused by the API,
 * and banned by EN-029 §5 — "free text alone is not accepted"), offer nothing
 * (which turns every soft stop into a dead end and stops a legitimate
 * prescription), or mirror the seeded codes and say so loudly. The third is the
 * least bad, so the codes below are copied verbatim from
 * `packages/db/src/seed/clinical.ts`.
 *
 * The failure mode is bounded and visible: a hospital that edits its reason set
 * gets a 422 from the API naming the code it did not recognise, which the screen
 * renders with its `reference`. It does not get a silently mis-filed override.
 *
 * Delete this file the moment the reasons are readable over the wire.
 */
export const OVERRIDE_REASONS: readonly ReasonOption[] = [
  { code: 'PRIOR_TOLERANCE', label: 'Patient has tolerated this before' },
  { code: 'BENEFIT_OUTWEIGHS', label: 'Clinical benefit outweighs the risk in this case' },
  { code: 'ALLERGY_DISPUTED', label: 'Reported allergy is an intolerance, not a true allergy' },
  { code: 'DESENSITISED', label: 'Patient desensitised / premedicated' },
  { code: 'SPECIALIST_ADVICE', label: 'Prescribed on specialist advice' },
  { code: 'NO_ALTERNATIVE', label: 'No suitable alternative available' },
  { code: 'MONITORING_PLANNED', label: 'Will monitor levels / INR / renal function' },
  { code: 'DOSE_INTENTIONAL', label: 'Dose is intentional and reviewed' },
  { code: 'ALERT_NOT_RELEVANT', label: 'Alert not clinically relevant to this patient' },
  // EN-029 §5: `other` requires >= 20 characters, which is why it carries
  // `requiresNote` — the dialog then demands the free text as well as the code.
  { code: 'OTHER', label: 'Other (state the reason)', requiresNote: true },
];

export function overrideReasonLabel(code: string): string {
  return OVERRIDE_REASONS.find((reason) => reason.code === code)?.label ?? code;
}
