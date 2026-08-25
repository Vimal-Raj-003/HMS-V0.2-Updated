import type {
  LabCriticalAlertView,
  LabCriticalCallbackRequest,
  LabNotifyMethod,
  RadCriticalCallbackRequest,
  RadNotifyMethod,
} from '../api/types';

/**
 * `docs/DECISIONS.md` D-10 and OP-004 §5 "Critical value (resolved — not
 * configurable)", as UI logic.
 *
 * ── The rule this module exists to protect ──────────────────────────────────
 *
 * OP-004 §5 settles three things, and they are easy to get backwards:
 *
 *  **(a) The result is never withheld.** The alert fires immediately, before and
 *  independent of authorisation. There is no configuration in this feature that
 *  hides a critical value from a screen, delays it, or gates *seeing* it on
 *  paperwork — `withholdingIsNeverAnOption` below is a constant and a test
 *  asserts it, because the tempting design is exactly the wrong one.
 *
 *  **(b) *Authorising* that result requires a documented communication** — a
 *  read-back from a named clinician, or an explicit "clinician unreachable —
 *  escalated to <tier>". The database refuses the third state; this module makes
 *  the button say so instead of letting the refusal arrive as a 409.
 *
 *  **(c) The order cannot close while a critical alert is unacknowledged.**
 *
 * ── Why "unreachable" is exactly as easy to fill in as "read-back" ──────────
 *
 * If the escalation arm were harder, the pressure would fall back onto
 * withholding the report — which is the hazard D-10 exists to remove. It is a
 * *tracked exception* on the NABL KPI, not a silent bypass, and the screen
 * labels it as one.
 */

/** OP-004 §5(a). A constant rather than a comment, so a test can assert it. */
export const WITHHOLDING_IS_NEVER_AN_OPTION = true as const;

export type CallbackOutcome = 'read_back_confirmed' | 'clinician_unreachable_escalated';

export interface CallbackFormState {
  readonly outcome: CallbackOutcome;
  readonly method: LabNotifyMethod;
  /** Read-back arm: who was told. */
  readonly notifiedToName: string;
  readonly notifiedToRole: string;
  readonly notifiedToContact: string;
  /** Read-back arm: what they repeated back. NABL wants the read-back, not "informed". */
  readonly readBackValue: string;
  /** Escalation arm: where it went instead. */
  readonly escalatedToLevel: string;
  readonly escalatedToRole: string;
  readonly attemptCount: string;
  readonly remarks: string;
}

export const EMPTY_CALLBACK_FORM: CallbackFormState = {
  outcome: 'read_back_confirmed',
  method: 'phone',
  notifiedToName: '',
  notifiedToRole: '',
  notifiedToContact: '',
  readBackValue: '',
  escalatedToLevel: '1',
  escalatedToRole: '',
  attemptCount: '1',
  remarks: '',
};

/**
 * Every reason the form is not yet postable, in the words the screen shows.
 *
 * A list rather than a boolean because "the save button is greyed and I cannot
 * tell why" is the complaint that makes people write results on paper.
 */
export function callbackProblems(form: CallbackFormState): readonly string[] {
  const problems: string[] = [];
  const attempts = Number.parseInt(form.attemptCount, 10);
  if (!Number.isInteger(attempts) || attempts < 1) {
    problems.push('Record how many times you tried — at least one.');
  }

  if (form.outcome === 'read_back_confirmed') {
    if (form.notifiedToName.trim().length < 2) {
      problems.push('Name the clinician you spoke to. "Informed the ward" is not a person.');
    }
    if (form.readBackValue.trim().length < 1) {
      problems.push('Write what they repeated back. NABL asks for the read-back, not for "informed".');
    }
    return problems;
  }

  const level = Number.parseInt(form.escalatedToLevel, 10);
  if (!Number.isInteger(level) || level < 1 || level > 5) {
    problems.push('Give the escalation tier you reached, 1 to 5.');
  }
  if (form.escalatedToRole.trim().length < 2) {
    problems.push('Name the role it went to. "Escalated" with no destination is the bypass D-10 forbids.');
  }
  return problems;
}

export function canRecordCallback(form: CallbackFormState): boolean {
  return callbackProblems(form).length === 0;
}

/**
 * Build the laboratory request.
 *
 * The API's schema is a discriminated union on `outcome`, so the ambiguous
 * middle — "somebody was told and also nobody could be reached" — is not
 * representable. This function preserves that: it returns one arm or the other
 * and never a merged object.
 */
export function toLabCallbackRequest(form: CallbackFormState): LabCriticalCallbackRequest {
  const problems = callbackProblems(form);
  if (problems.length > 0) throw new Error(problems[0] ?? 'The call-back record is incomplete.');

  const attemptCount = Number.parseInt(form.attemptCount, 10);
  const remarks = form.remarks.trim();

  if (form.outcome === 'read_back_confirmed') {
    const role = form.notifiedToRole.trim();
    const contact = form.notifiedToContact.trim();
    return {
      outcome: 'read_back_confirmed',
      method: form.method,
      notifiedToName: form.notifiedToName.trim(),
      ...(role === '' ? {} : { notifiedToRole: role }),
      ...(contact === '' ? {} : { notifiedToContact: contact }),
      readBackValue: form.readBackValue.trim(),
      attemptCount,
      ...(remarks === '' ? {} : { remarks }),
    };
  }

  return {
    outcome: 'clinician_unreachable_escalated',
    method: form.method,
    escalatedToLevel: Number.parseInt(form.escalatedToLevel, 10),
    escalatedToRole: form.escalatedToRole.trim(),
    attemptCount,
    ...(remarks === '' ? {} : { remarks }),
  };
}

/**
 * Build the imaging request.
 *
 * OP-008's schema is one object with a refinement rather than a union, so the
 * ambiguous middle *is* expressible on the wire — which is precisely why this
 * function exists. It sets exactly one of `readBackConfirmed` /
 * `clinicianUnreachable` and never both, so the refusal the refinement would
 * produce never has to happen.
 */
export function toRadCallbackRequest(form: CallbackFormState): RadCriticalCallbackRequest {
  const problems = callbackProblems(form);
  if (problems.length > 0) throw new Error(problems[0] ?? 'The call-back record is incomplete.');

  const attemptCount = Number.parseInt(form.attemptCount, 10);
  const remarks = form.remarks.trim();
  const method: RadNotifyMethod = form.method;

  if (form.outcome === 'read_back_confirmed') {
    const role = form.notifiedToRole.trim();
    const contact = form.notifiedToContact.trim();
    return {
      method,
      notifiedToName: form.notifiedToName.trim(),
      ...(role === '' ? {} : { notifiedToRole: role }),
      ...(contact === '' ? {} : { notifiedToContact: contact }),
      readBackConfirmed: true,
      readBackValue: form.readBackValue.trim(),
      clinicianUnreachable: false,
      attemptCount,
      ...(remarks === '' ? {} : { remarks }),
    };
  }

  return {
    method,
    readBackConfirmed: false,
    clinicianUnreachable: true,
    escalatedToLevel: Number.parseInt(form.escalatedToLevel, 10),
    escalatedToRole: form.escalatedToRole.trim(),
    attemptCount,
    ...(remarks === '' ? {} : { remarks }),
  };
}

/**
 * OP-004 §5(b) — whether this alert's result may now be authorised.
 *
 * A call-back counts when it is either a confirmed read-back or a documented
 * escalation. `first_communicated_at` alone is **not** enough: the API sets it
 * on the first attempt of any kind, and an attempt that reached nobody and
 * escalated to nobody is the gap the rule closes.
 */
export function hasDocumentedCommunication(alert: LabCriticalAlertView): boolean {
  return alert.callbacks.some((callback) => callback.read_back_confirmed || callback.clinician_unreachable);
}

export type AuthorisationVerdict =
  { readonly kind: 'permitted' } | { readonly kind: 'blocked'; readonly message: string };

/**
 * Whether the authorise action may be offered for a set of results.
 *
 * `openCriticalAlerts` are the alerts raised against those results. Note the
 * direction of the rule once more, because it is the one everybody inverts:
 * this gates **authorisation**, never display. The value is on the screen
 * either way.
 */
export function authorisationVerdict(
  openCriticalAlerts: readonly LabCriticalAlertView[],
): AuthorisationVerdict {
  const undocumented = openCriticalAlerts.filter((alert) => !hasDocumentedCommunication(alert));
  if (undocumented.length === 0) return { kind: 'permitted' };

  const names = undocumented.map((alert) => alert.analyte_name).join(', ');
  return {
    kind: 'blocked',
    message:
      undocumented.length === 1
        ? `${names} is a critical value with no documented call-back. Record the read-back, or record that the clinician could not be reached and where it was escalated, then authorise.`
        : `${names} are critical values with no documented call-back. Record a read-back or a documented escalation for each, then authorise.`,
  };
}

/**
 * Minutes remaining before the alert breaches its communication target, or a
 * negative number once it has.
 *
 * `due_by` is the server's; nothing here invents a target. A hospital that has
 * set fifteen minutes for its ICU has done so for a reason.
 */
export function minutesToDue(alert: LabCriticalAlertView, now: Date): number | null {
  if (alert.due_by === null) return null;
  const due = Date.parse(alert.due_by);
  if (Number.isNaN(due)) return null;
  return Math.round((due - now.getTime()) / 60_000);
}

export type CriticalUrgency = 'breached' | 'due_soon' | 'in_time' | 'untimed';

export function urgencyOf(alert: LabCriticalAlertView, now: Date): CriticalUrgency {
  const minutes = minutesToDue(alert, now);
  if (minutes === null) return 'untimed';
  if (minutes < 0) return 'breached';
  if (minutes <= 5) return 'due_soon';
  return 'in_time';
}
