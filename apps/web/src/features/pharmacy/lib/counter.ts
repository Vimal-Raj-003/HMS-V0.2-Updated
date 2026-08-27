import type {
  AcknowledgementInput,
  CompleteDispenseRequest,
  DispenseAlertView,
  DispenseItemView,
  DispenseView,
} from '../api/types';

/**
 * OP-003 §3.2 and `phase-04 §4.4` as UI logic — the four things the dispensing
 * counter refuses to do, expressed where the button can read them.
 *
 * Everything in this module mirrors a rule the API enforces anyway. That is the
 * point rather than a redundancy: the API's job is to be *right*, and it is, on
 * every path including the one nobody drew. This module's job is to make the
 * refusal legible **before** a pharmacist with a queue behind them presses a
 * button and gets a 409 they have to interpret. If the two ever disagree the API
 * wins, and the screen renders its `ProblemDetails` rather than its own opinion.
 *
 * ── The rule this module exists to protect ──────────────────────────────────
 *
 * `docs/06` §1.2: a **hard stop** is "modal, cannot be dismissed, requires a
 * documented override reason". There is exactly one way past an allergy or
 * interaction alert at this counter, and it is to telephone the prescriber and
 * write down what was decided. There is no dismiss, no "×", no Escape, no
 * "don't show this again", and — critically — no request shape that omits the
 * reason: `CompleteDispenseRequest.acknowledgements` carries a reason per alert
 * and the API re-runs the evaluation inside the completing transaction, so an
 * acknowledgement for an alert that no longer fires is simply unused and an
 * alert with no acknowledgement blocks. `HARD_STOPS_ARE_NEVER_DISMISSIBLE` is a
 * constant rather than a comment so that a test can assert it and a change would
 * have to delete it deliberately.
 */

/** `docs/06` §1.2. A constant, so `counter.spec.ts` can hold it to it. */
export const HARD_STOPS_ARE_NEVER_DISMISSIBLE = true as const;

/**
 * The CDSS families **this counter** is the second net for.
 *
 * Mirrored from `COUNTER_BLOCKING_FAMILIES` in `pharmacy/dispense.service.ts`,
 * and it is deliberately these two and not "every hard stop". The rest of
 * EN-029's floor is prescriber-facing and fires on facts a pharmacist cannot
 * change — `schedule_guardrail`, for instance, hard-stops when the *prescriber's*
 * profile carries no registration number. Blocking a morphine dispense at the
 * counter for that would stop a pain patient's supply for an administrative
 * reason, which is the behaviour India's ~92 % fall in morphine consumption is
 * made of. So those alerts are shown, loudly, and do not hold the button.
 */
export const COUNTER_BLOCKING_FAMILIES: ReadonlySet<string> = new Set(['allergy', 'ddi']);

/** NDPS. Two pharmacists, or nothing leaves the safe. */
export const DUAL_AUTH_SCHEDULES: ReadonlySet<string> = new Set(['ndps_narcotic', 'ndps_psychotropic']);

/** Rule 65(9)(a), Drugs and Cosmetics Rules 1945 — no retail sale without a prescription. */
export const PRESCRIPTION_ONLY_SCHEDULES: ReadonlySet<string> = new Set([
  'h',
  'h1',
  'x',
  'ndps_narcotic',
  'ndps_psychotropic',
]);

/** The API's floor for any reason field on this module. Shorter is not a reason. */
export const REASON_MIN_LENGTH = 8;

/** One hard stop, with the line it was raised against — which an ack needs. */
export interface CounterAlert {
  readonly dispenseItemId: string;
  readonly lineNo: number;
  readonly itemName: string;
  readonly alert: DispenseAlertView;
}

/** The composite key an acknowledgement draft is held under. */
export function ackKeyOf(dispenseItemId: string, alertKey: string): string {
  return `${dispenseItemId}::${alertKey}`;
}

/**
 * Every unacknowledged hard stop on the dispense, paired with its line.
 *
 * `DispenseView.blockingAlerts` is already this list, flattened — but flattened
 * without the `dispenseItemId`, and an acknowledgement cannot be built without
 * one. So it is rebuilt from the lines, which is where the API keeps the
 * association.
 */
export function hardStops(dispense: DispenseView): readonly CounterAlert[] {
  const out: CounterAlert[] = [];
  for (const item of dispense.items) {
    for (const alert of item.alerts) {
      if (alert.interruption !== 'hard_stop' || alert.acknowledged) continue;
      out.push({
        dispenseItemId: item.id,
        lineNo: item.lineNo,
        itemName: item.itemName,
        alert,
      });
    }
  }
  return out;
}

/** The subset that actually holds the button: allergy and interaction. */
export function blockingHardStops(dispense: DispenseView): readonly CounterAlert[] {
  return hardStops(dispense).filter((entry) => COUNTER_BLOCKING_FAMILIES.has(entry.alert.family));
}

/**
 * The rest: real hard stops, shown as hard stops, that the API does not refuse
 * the completion for. They are not warnings and are not styled as warnings —
 * they are simply somebody else's gate, already applied upstream.
 */
export function advisoryHardStops(dispense: DispenseView): readonly CounterAlert[] {
  return hardStops(dispense).filter((entry) => !COUNTER_BLOCKING_FAMILIES.has(entry.alert.family));
}

/** Whether any line on this dispense is a narcotic or psychotropic. */
export function controlledLines(dispense: DispenseView): readonly DispenseItemView[] {
  return dispense.items.filter((item) => DUAL_AUTH_SCHEDULES.has(item.schedule));
}

export function requiresSecondPharmacist(dispense: DispenseView): boolean {
  return controlledLines(dispense).length > 0;
}

export type SecondPersonVerdict =
  | { readonly kind: 'not_required' }
  | { readonly kind: 'satisfied'; readonly userId: string }
  | { readonly kind: 'missing'; readonly message: string }
  | { readonly kind: 'same_person'; readonly message: string };

/**
 * `phase-04` exit gate 4 — "narcotic issue requires two users".
 *
 * The `same_person` arm is not theoretical. The tempting implementation of a
 * two-person control is a checkbox that says "second pharmacist verified", and
 * the API refuses exactly that: `PharmacyCoSignService` compares the co-signer's
 * user id with the acting user's and answers with a segregation-of-duties
 * refusal whose words this arm repeats. The screen must make the second
 * signature a real second sign-in, because a control one person can satisfy is
 * not a control.
 */
export function secondPersonVerdict(dispense: DispenseView): SecondPersonVerdict {
  if (!requiresSecondPharmacist(dispense)) return { kind: 'not_required' };
  const second = dispense.secondAuthUserId;
  if (second === null) {
    return {
      kind: 'missing',
      message:
        'This dispense contains a narcotic or psychotropic drug and has no second authorising pharmacist. A second authorised pharmacist must sign in on this screen with their own password before the drug is picked.',
    };
  }
  if (second === dispense.pharmacistUserId) {
    return {
      kind: 'same_person',
      message:
        'The same person cannot be both the dispensing and the authorising pharmacist. Two signatures from one person are one signature.',
    };
  }
  return { kind: 'satisfied', userId: second };
}

export type CompletionVerdict =
  { readonly kind: 'permitted' } | { readonly kind: 'blocked'; readonly reasons: readonly string[] };

/**
 * Whether "Complete" may be offered at all, and if not, every reason — in the
 * words the screen shows.
 *
 * A list rather than a boolean because "the button is greyed and I cannot tell
 * why" is the complaint that makes people hand medicine over without recording
 * it. Each reason names the lawful path, never a way around.
 */
export function completionVerdict(
  dispense: DispenseView,
  acknowledgements: ReadonlyMap<string, string>,
): CompletionVerdict {
  const reasons: string[] = [];

  if (dispense.status !== 'draft') {
    reasons.push(
      `This dispense is "${dispense.status}". Only a draft can be completed — if it already says completed, the patient has their medicines.`,
    );
  }

  const fillable = dispense.items.filter((item) => Number(item.qtyBase) > 0);
  if (fillable.length === 0) {
    reasons.push('Nothing has been scanned onto this dispense yet. There is nothing to give the patient.');
  }

  const second = secondPersonVerdict(dispense);
  if (second.kind === 'missing' || second.kind === 'same_person') reasons.push(second.message);

  for (const entry of blockingHardStops(dispense)) {
    const recorded = acknowledgements.get(ackKeyOf(entry.dispenseItemId, entry.alert.key))?.trim() ?? '';
    if (recorded.length < REASON_MIN_LENGTH) {
      reasons.push(
        `Line ${String(entry.lineNo)} — ${entry.itemName}: "${entry.alert.title}" is a hard stop. Telephone the prescriber, then write down what was decided. It cannot be dismissed.`,
      );
    }
  }

  return reasons.length === 0 ? { kind: 'permitted' } : { kind: 'blocked', reasons };
}

/**
 * Build the completion request.
 *
 * It throws rather than posting an incomplete one. A request that reached the
 * API missing an acknowledgement would be refused anyway — the check is re-run
 * inside the completing transaction — but the refusal would arrive as a 409 in
 * front of a queue, and the pharmacist would have lost the reason they had
 * already typed.
 */
export function toCompleteRequest(
  dispense: DispenseView,
  acknowledgements: ReadonlyMap<string, string>,
  counselling: { readonly counselled: boolean; readonly language: string },
): CompleteDispenseRequest {
  const verdict = completionVerdict(dispense, acknowledgements);
  if (verdict.kind === 'blocked') {
    throw new Error(verdict.reasons[0] ?? 'This dispense cannot be completed yet.');
  }

  const acks: AcknowledgementInput[] = [];
  for (const entry of hardStops(dispense)) {
    const reason = acknowledgements.get(ackKeyOf(entry.dispenseItemId, entry.alert.key))?.trim() ?? '';
    if (reason.length < REASON_MIN_LENGTH) continue;
    acks.push({ dispenseItemId: entry.dispenseItemId, alertKey: entry.alert.key, reason });
  }

  const language = counselling.language.trim();
  return {
    acknowledgements: acks,
    counselling: {
      counselled: counselling.counselled,
      ...(language === '' ? {} : { language }),
      points: [],
    },
  };
}

// ── partial fill (OP-003 §3.2 step 4) ────────────────────────────────────────

export interface ScanLineDraft {
  /** What the scanner typed, or what was keyed when the label would not read. */
  readonly scanned: string;
  readonly qtyEntered: string;
  readonly qtyOrderedBase: string;
  readonly partialReason: string;
  readonly prescriptionItemId: string;
  /** Naming a later-expiring batch than FEFO chose. Needs a reason, always. */
  readonly fefoOverrideReason: string;
}

export const EMPTY_SCAN_LINE: ScanLineDraft = {
  scanned: '',
  qtyEntered: '',
  qtyOrderedBase: '',
  partialReason: '',
  fefoOverrideReason: '',
  prescriptionItemId: '',
};

/**
 * Whether this line gives less than was prescribed.
 *
 * An unparseable quantity is *not* a partial fill — it is an invalid quantity,
 * and `scanProblems` says so separately. Treating it as partial would demand a
 * reason for a typo and teach the operator that the reason box is noise.
 */
export function isPartialFill(draft: ScanLineDraft): boolean {
  const entered = Number(draft.qtyEntered);
  const ordered = Number(draft.qtyOrderedBase);
  if (!Number.isFinite(entered) || !Number.isFinite(ordered) || ordered <= 0) return false;
  return entered < ordered;
}

/** Every reason this scan cannot be posted, in the words the screen shows. */
export function scanProblems(draft: ScanLineDraft): readonly string[] {
  const problems: string[] = [];
  if (draft.scanned.trim() === '') {
    problems.push('Scan the pack. A dispense line is built from a scan, not from a memory of one.');
  }
  const entered = Number(draft.qtyEntered);
  if (!Number.isFinite(entered) || entered <= 0) {
    problems.push('Enter how many units are going into the bag.');
  }
  if (isPartialFill(draft) && draft.partialReason.trim().length < 4) {
    problems.push(
      'This line gives less than was prescribed, so it is a partial fill and needs a reason the prescriber can read.',
    );
  }
  return problems;
}

export function canPostScan(draft: ScanLineDraft): boolean {
  return scanProblems(draft).length === 0;
}

// ── the OTC counter (OP-003 §3.3, `phase-04` exit gate 3) ────────────────────

export type OtcVerdict =
  { readonly kind: 'permitted' } | { readonly kind: 'refused'; readonly message: string };

/**
 * `phase-04` exit gate 3, second half: "attempt to sell a Schedule H drug OTC →
 * blocked with reason".
 *
 * The API refuses this in `assertSchedulePermitted` and the database refuses it
 * again in `pharmacy.enforce_dispense_line`. This is the third statement of the
 * same fact, and the only one that can put the rule in front of somebody before
 * they have scanned the box.
 */
export function otcVerdict(schedule: string, itemName: string): OtcVerdict {
  if (!PRESCRIPTION_ONLY_SCHEDULES.has(schedule)) return { kind: 'permitted' };
  return {
    kind: 'refused',
    message: `${itemName} is a Schedule ${schedule.toUpperCase()} drug and cannot be sold over the counter. Rule 65(9)(a) of the Drugs and Cosmetics Rules 1945 permits retail sale only against a registered practitioner's prescription. Capture the prescription and dispense it against that instead.`,
  };
}

// ── labels (`phase-04` exit gate 2) ──────────────────────────────────────────

/**
 * The default label language, and the eleven a hospital may add.
 *
 * `CLAUDE.md` §4 names the same superset the design system does. `en-IN` is
 * always printed because it is the fallback every pharmacist in the building can
 * read back to the patient; the second is the patient's.
 */
export const LABEL_BASE_LOCALE = 'en-IN';

export const LABEL_SECOND_LOCALES: readonly { readonly code: string; readonly label: string }[] = [
  { code: 'hi', label: 'हिन्दी · Hindi' },
  { code: 'ta', label: 'தமிழ் · Tamil' },
  { code: 'te', label: 'తెలుగు · Telugu' },
  { code: 'ml', label: 'മലയാളം · Malayalam' },
  { code: 'kn', label: 'ಕನ್ನಡ · Kannada' },
  { code: 'mr', label: 'मराठी · Marathi' },
  { code: 'bn', label: 'বাংলা · Bengali' },
  { code: 'gu', label: 'ગુજરાતી · Gujarati' },
  { code: 'or', label: 'ଓଡ଼ିଆ · Odia' },
  { code: 'pa', label: 'ਪੰਜਾਬੀ · Punjabi' },
  { code: 'ar', label: 'العربية · Arabic' },
];

/**
 * The locales a label print asks for.
 *
 * Always two, never one. `phase-04` exit gate 2 requires "labels print in
 * English **and** one Indian language", and a function that could return a
 * single-element array is a function that will, on the day somebody's dropdown
 * defaults to empty. If the chosen second locale is `en-IN` — which the
 * dropdown does not offer, but a stale preference could hold — a distinct
 * fallback is substituted rather than printing the same label twice.
 */
export function labelLocales(secondLocale: string): readonly string[] {
  const second = secondLocale.trim();
  if (second === '' || second === LABEL_BASE_LOCALE) return [LABEL_BASE_LOCALE, 'hi'];
  return [LABEL_BASE_LOCALE, second];
}
