import type { PregnancyStatus, RadOrderItemView, RadOrderView, SafetyScreenRequest } from '../api/types';

/**
 * OP-008 §3.1.2 and §5 — the imaging safety screen, as a gate rather than as a
 * form.
 *
 * ── Why this is a gate and not a questionnaire ──────────────────────────────
 *
 * OP-008 §5 bullet 1 and AC §14.2: **scheduling is blocked until pregnancy
 * status is recorded.** §5 bullet 2 and AC §14.3: an eGFR below 30 is a hard
 * stop that only a radiologist may pass, with a reason. §5 bullet 3 and AC
 * §14.10: the MRI checklist is mandatory and an unsafe implant blocks the study
 * unless a radiologist documents MR-conditional evidence. A screen that
 * collected these answers and then let the study proceed regardless would be a
 * form, and a form is not a control.
 *
 * ── What this module deliberately does not know ─────────────────────────────
 *
 * **It does not know the patient's sex or age.** OP-008 §3.1.2 phrases the
 * pregnancy question as applying to females aged 10–55; `RadOrderView` carries
 * neither field, and this feature does not fetch them. The gate therefore keys
 * on `isIonising`, which the API sets per order line from the procedure master.
 * That is stricter than the spec — it asks the question for every ionising exam
 * — and stricter in the safe direction: the failure mode of asking is an extra
 * click, and the failure mode of not asking is an irradiated foetus.
 *
 * ── Blocking versus advisory ────────────────────────────────────────────────
 *
 * `docs/06` §10 warns against styling every warning as a blocking modal, because
 * that is how alert fatigue is manufactured. So the verdict separates the two:
 * `blocking` stops the study, `advisories` are shown as a banner and never stop
 * anything. The metformin hold is an advisory. An unsafe MRI implant is not.
 */

export const EGFR_HARD_STOP = 30;

export interface SafetyScreenState {
  readonly pregnancyStatus: PregnancyStatus;
  readonly lmpDate: string;
  readonly radiationJustification: string;
  readonly contrastRequired: boolean;
  readonly egfr: string;
  readonly contrastAllergyKnown: boolean;
  readonly metforminHoldAdvised: boolean;
  readonly contrastApprovalReason: string;
  readonly mriSafetyCompleted: boolean;
  readonly mriUnsafeImplant: boolean;
  readonly mriOverrideReason: string;
  readonly sedationRequired: boolean;
}

export const EMPTY_SAFETY_SCREEN: SafetyScreenState = {
  pregnancyStatus: 'unknown',
  lmpDate: '',
  radiationJustification: '',
  contrastRequired: false,
  egfr: '',
  contrastAllergyKnown: false,
  metforminHoldAdvised: false,
  contrastApprovalReason: '',
  mriSafetyCompleted: false,
  mriUnsafeImplant: false,
  mriOverrideReason: '',
  sedationRequired: false,
};

export interface SafetyRequirements {
  readonly ionising: boolean;
  readonly magneticResonance: boolean;
  readonly pcpndt: boolean;
}

export function requirementsOf(items: readonly RadOrderItemView[]): SafetyRequirements {
  return {
    ionising: items.some((item) => item.isIonising),
    magneticResonance: items.some((item) => item.modality.toUpperCase() === 'MR'),
    pcpndt: items.some((item) => item.isPcpndt),
  };
}

export interface SafetyVerdict {
  /** Reasons the study may not proceed. Empty means it may. */
  readonly blocking: readonly string[];
  /** Things the team must know but which stop nothing (`docs/06` §10). */
  readonly advisories: readonly string[];
}

export function safetyVerdict(form: SafetyScreenState, need: SafetyRequirements): SafetyVerdict {
  const blocking: string[] = [];
  const advisories: string[] = [];

  // ── pregnancy (OP-008 §3.1.2, §5 bullet 1, AC §14.2) ──────────────────────
  if (need.ionising) {
    if (form.pregnancyStatus === 'unknown') {
      blocking.push(
        'Record the pregnancy status before an ionising exam is scheduled. "Not asked" and "not pregnant" are different answers and only one of them is safe.',
      );
    }
    if (
      (form.pregnancyStatus === 'yes' || form.pregnancyStatus === 'possible') &&
      form.radiationJustification.trim().length < 8
    ) {
      blocking.push(
        'A pregnant or possibly pregnant patient may be imaged with ionising radiation only against a written justification. Write why the exposure is justified and what alternative was considered.',
      );
    }
    if (form.pregnancyStatus === 'possible' && form.lmpDate.trim() === '') {
      advisories.push(
        'The 10-day / 28-day rule needs the last menstrual period. Record it, or state in the justification why it is unavailable.',
      );
    }
  }

  // ── contrast, renal function, allergy (OP-008 §3.1.2, §5 bullet 2) ────────
  if (form.contrastRequired) {
    const egfr = Number.parseFloat(form.egfr);
    if (!Number.isFinite(egfr)) {
      blocking.push(
        'Iodinated contrast needs a recent eGFR. Pull the last creatinine, order one, or use the point-of-care analyser.',
      );
    } else if (egfr < EGFR_HARD_STOP) {
      if (form.contrastApprovalReason.trim().length < 8) {
        blocking.push(
          `eGFR ${egfr} is below ${EGFR_HARD_STOP}. Contrast at this level of renal function needs a named radiologist's approval and a written reason, or a non-contrast alternative.`,
        );
      } else {
        advisories.push(
          `Contrast is proceeding at eGFR ${egfr} under a recorded radiologist approval. Hydration protocol and post-procedure renal follow-up apply.`,
        );
      }
    }

    if (form.contrastAllergyKnown && form.contrastApprovalReason.trim().length < 8) {
      blocking.push(
        'A documented iodinated-contrast allergy needs either a premedication protocol or a non-contrast alternative, and only a radiologist may override it. Record the decision and who made it.',
      );
    }
    if (form.contrastAllergyKnown) {
      advisories.push(
        'Premedication protocol: prednisolone 50 mg at 13 h, 7 h and 1 h before, with diphenhydramine 50 mg at 1 h. Emergency path is hydrocortisone 200 mg IV.',
      );
    }
    if (form.metforminHoldAdvised) {
      advisories.push('Metformin is to be held for 48 hours after contrast and restarted on a renal check.');
    }
  }

  // ── MRI screening (OP-008 §3.1.2, §5 bullet 3, AC §14.10) ─────────────────
  if (need.magneticResonance) {
    if (!form.mriSafetyCompleted) {
      blocking.push(
        'The MRI safety questionnaire is mandatory: pacemaker, implants, aneurysm clips, cochlear devices, metal fragments, claustrophobia and weight limit. An unanswered questionnaire is an unscreened patient in a 3-tesla magnet.',
      );
    }
    if (form.mriUnsafeImplant && form.mriOverrideReason.trim().length < 8) {
      blocking.push(
        'An implant flagged unsafe blocks the scan. It proceeds only when a radiologist documents the MR-conditional evidence — device, model, field strength and conditions.',
      );
    }
    if (form.mriUnsafeImplant && form.mriOverrideReason.trim().length >= 8) {
      advisories.push(
        'This scan proceeds against a flagged implant on documented MR-conditional evidence. The conditions on that evidence bind the sequence and the field strength.',
      );
    }
  }

  // ── PC-PNDT (OP-008 §5 bullet 1, AC §14.9) ────────────────────────────────
  if (need.pcpndt) {
    advisories.push(
      'This is a prenatal diagnostic procedure under the PC-PNDT Act. Form F must be completed and signed before the study can be marked complete, and the machine and doctor registration numbers print on the report.',
    );
  }

  if (form.sedationRequired) {
    advisories.push('Sedation is requested: fasting status, escort and recovery monitoring apply.');
  }

  return { blocking, advisories };
}

export function mayProceed(form: SafetyScreenState, need: SafetyRequirements): boolean {
  return safetyVerdict(form, need).blocking.length === 0;
}

/** Build the PATCH body, omitting what was never answered rather than sending zeroes. */
export function toSafetyScreenRequest(form: SafetyScreenState): SafetyScreenRequest {
  const egfr = Number.parseFloat(form.egfr);
  const justification = form.radiationJustification.trim();
  const contrastApproval = form.contrastApprovalReason.trim();
  const mriOverride = form.mriOverrideReason.trim();

  return {
    pregnancyStatus: form.pregnancyStatus,
    ...(form.lmpDate.trim() === '' ? {} : { lmpDate: form.lmpDate.trim() }),
    ...(justification === '' ? {} : { radiationJustification: justification }),
    contrastRequired: form.contrastRequired,
    ...(Number.isFinite(egfr) ? { egfr } : {}),
    contrastAllergyKnown: form.contrastAllergyKnown,
    metforminHoldAdvised: form.metforminHoldAdvised,
    ...(contrastApproval === '' ? {} : { contrastApprovalReason: contrastApproval }),
    mriSafetyCompleted: form.mriSafetyCompleted,
    mriUnsafeImplant: form.mriUnsafeImplant,
    ...(mriOverride === '' ? {} : { mriOverrideReason: mriOverride }),
    sedationRequired: form.sedationRequired,
  };
}

/**
 * Read an existing order's answers back into the form.
 *
 * The order view carries only the settled flags, not the whole questionnaire, so
 * the eGFR and the free-text reasons come back blank. That is honest: they are
 * stored, they are audited, and a screen that pretended to show them from a
 * projection which does not carry them would be showing a guess.
 */
export function safetyScreenFrom(order: RadOrderView): SafetyScreenState {
  const pregnancy = (order.pregnancyStatus ?? 'unknown') as PregnancyStatus;
  return {
    ...EMPTY_SAFETY_SCREEN,
    pregnancyStatus: pregnancy,
    contrastRequired: order.contrastRequired,
    contrastAllergyKnown: order.contrastAllergyKnown,
    mriUnsafeImplant: order.mriUnsafeImplant,
  };
}

/**
 * OP-008 §3.6.2 and AC §14.6 — the cumulative-dose banner shown while ordering.
 *
 * The spec asks for it in words rather than in a number: "this patient had 4 CTs
 * in 6 months, cumulative X mSv". A bare figure means nothing to the person
 * deciding whether to order the fifth.
 */
export function doseBannerText(summary: {
  readonly ctCount12m: number;
  readonly studyCount12m: number;
  readonly msv12m: string;
  readonly cumulativeMsvLifetime: string;
  readonly thresholdBreached: boolean;
}): string | null {
  if (summary.studyCount12m === 0) return null;
  const ct = summary.ctCount12m === 1 ? '1 CT' : `${summary.ctCount12m} CTs`;
  const base = `This patient has had ${ct} in the last 12 months — ${summary.msv12m} mSv in that period, ${summary.cumulativeMsvLifetime} mSv recorded lifetime.`;
  return summary.thresholdBreached
    ? `${base} That is past the hospital's review threshold: justify this exposure explicitly or find a non-ionising answer to the question.`
    : base;
}
