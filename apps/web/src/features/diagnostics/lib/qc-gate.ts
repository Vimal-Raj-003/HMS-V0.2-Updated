import type { LabQcRunView, LabQcStateView } from '../api/types';

/**
 * EN-031 §3.3.3 and §5 bullet 1 — the release gate, on the client side of it.
 *
 * ── The rule, in the stricter of the two wordings ───────────────────────────
 *
 * OP-004 §3.3.1 speaks of `qc_hold` blocking *verification*, with a pathologist
 * override. EN-031 §5 bullet 1 blocks **auto-verification and manual release**,
 * and puts the only exception at Lab Director level
 * (`labq.qc.release_override`), recorded as a `labq_qc_actions` row with
 * `patient_impact = released_with_authorisation`, a written reason, and a
 * monthly management report. The two specs disagree; this module implements
 * EN-031, cites both, and the disagreement is reported rather than silently
 * resolved.
 *
 * ── Fail closed ─────────────────────────────────────────────────────────────
 *
 * EN-031 §13 and AC 17: **if the QC status cannot be read, release is blocked
 * with a clear operational message — never silently allowed.** That is the whole
 * reason `releaseVerdict` takes `LabQcStateView | null | undefined` and a
 * `stateUnavailable` flag rather than a plain boolean: the natural TypeScript
 * shortcut (`state?.permits_release ?? true`) is exactly the bug, and it reads
 * as reasonable.
 *
 * ── `1-2s` is a warning, never a rejection ──────────────────────────────────
 *
 * EN-031 §3.3.2 and AC 3. A single point beyond two standard deviations is the
 * expected behaviour of a control roughly one run in twenty; a laboratory that
 * stops for it stops constantly, and a laboratory that stops constantly stops
 * looking. `blocksRelease` therefore refuses to treat `r_1_2s` as a stopper even
 * if it is the only rule a run violated.
 */

/** EN-031 §3.3.2 — the warning-only rule. */
export const WARNING_ONLY_RULES: readonly string[] = ['r_1_2s'];

export type ReleaseVerdict =
  | { readonly kind: 'permitted' }
  | {
      readonly kind: 'blocked';
      /** What the screen says, in ward language. */
      readonly message: string;
      /** EN-031 AC 2 — the block must show the QC state that caused it. */
      readonly qcStateRef: string | null;
      /** Whether a Lab Director override is the lawful way out (EN-031 §5). */
      readonly overridable: boolean;
    };

/**
 * Whether patient results for this analyte may be released.
 *
 * @param state the analyte's QC state row, or `null` when the API returned none
 * @param stateUnavailable true when the QC query failed or has not resolved —
 *        the fail-closed case, which is deliberately *not* the same as `null`
 */
export function releaseVerdict(
  state: LabQcStateView | null | undefined,
  stateUnavailable: boolean,
): ReleaseVerdict {
  if (stateUnavailable) {
    return {
      kind: 'blocked',
      message:
        'Quality-control status could not be read, so release is held. EN-031 §13 requires this gate to fail closed: a result released while the QC state is unknown is a result released on hope.',
      qcStateRef: null,
      overridable: false,
    };
  }

  if (state === null || state === undefined) {
    return {
      kind: 'blocked',
      message:
        'No quality-control state exists for this analyte on this instrument. An analyte that has never been evaluated is not releasable — run the control first.',
      qcStateRef: null,
      overridable: false,
    };
  }

  if (state.permits_release) return { kind: 'permitted' };

  const reason = state.reason ?? `QC state is "${state.state}"`;
  return {
    kind: 'blocked',
    message: `Release is held: ${reason}. Record the corrective action, run the control again, and release only against a passing run — or, if the results must go out, a Lab Director authorisation under EN-031 §5.`,
    qcStateRef: state.active_lockout_id ?? state.id,
    overridable: true,
  };
}

/**
 * Whether a QC run's violations stop the run.
 *
 * `has_rejection` is the database's verdict and is authoritative. This helper
 * exists for the chart legend and for the case where a run violated only the
 * warning rule: EN-031 AC 3 says that must not read as a rejection.
 */
export function blocksRelease(run: Pick<LabQcRunView, 'has_rejection' | 'violated_rules'>): boolean {
  if (!run.has_rejection) return false;
  const stoppers = run.violated_rules.filter((rule) => !WARNING_ONLY_RULES.includes(rule));
  return stoppers.length > 0;
}

/**
 * The Westgard rules in the words a bench technologist uses.
 *
 * A code like `r_R_4s` on a screen is a lookup somebody has to do at the worst
 * possible moment, so the rule is spelled out beside it — and the two are shown
 * together rather than the label replacing the code, because the code is what
 * the SOP and the analyzer print.
 */
const RULE_LABELS: Readonly<Record<string, string>> = {
  r_1_2s: 'One control beyond 2 SD — warning only, inspect but do not stop',
  r_1_3s: 'One control beyond 3 SD — random error, reject the run',
  r_2_2s: 'Two consecutive beyond the same 2 SD limit — systematic error',
  r_R_4s: 'Range across controls exceeds 4 SD — random error',
  r_4_1s: 'Four consecutive beyond the same 1 SD limit — systematic drift',
  r_10x: 'Ten consecutive on one side of the mean — systematic shift',
  r_8x: 'Eight consecutive on one side of the mean — systematic shift',
  r_12x: 'Twelve consecutive on one side of the mean — systematic shift',
  r_7T: 'Seven consecutive trending in one direction',
  r_2of3_2s: 'Two of three beyond the same 2 SD limit',
  r_3_1s: 'Three consecutive beyond the same 1 SD limit',
  r_6x: 'Six consecutive on one side of the mean',
  r_9x: 'Nine consecutive on one side of the mean',
};

export function describeRule(code: string): string {
  return RULE_LABELS[code] ?? `Rule ${code} — see the laboratory's QC SOP`;
}

/**
 * The coded causes and actions EN-031 §3.3.4 prescribes.
 *
 * Coded rather than free text because these feed the monthly management review
 * and the six-sigma calculation; "machine was funny" is not an analysable cause.
 */
export const QC_CAUSE_CODES: readonly { readonly code: string; readonly label: string }[] = [
  { code: 'control_degraded', label: 'Control material degraded' },
  { code: 'control_expired', label: 'Control material expired' },
  { code: 'reagent_lot_change', label: 'Reagent lot changed' },
  { code: 'calibration_drift', label: 'Calibration drift' },
  { code: 'instrument_fault', label: 'Instrument fault' },
  { code: 'pipetting_error', label: 'Pipetting error' },
  { code: 'temperature_excursion', label: 'Temperature excursion' },
  { code: 'operator_error', label: 'Operator error' },
  { code: 'random_error', label: 'Random error, no cause identified' },
];

export const QC_ACTION_CODES: readonly { readonly code: string; readonly label: string }[] = [
  { code: 'repeat_qc', label: 'Repeat the QC' },
  { code: 'new_control_vial', label: 'Open a new control vial' },
  { code: 'recalibrate', label: 'Recalibrate' },
  { code: 'reagent_change', label: 'Change the reagent' },
  { code: 'maintenance', label: 'Perform maintenance' },
  { code: 'engineer_call', label: 'Call the service engineer' },
];
