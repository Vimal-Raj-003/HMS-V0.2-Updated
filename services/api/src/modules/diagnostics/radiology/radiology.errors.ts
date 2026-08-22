import { ProblemType } from '@vims/contracts';
import { AppError } from '../../../core/problem/app-error.js';

/**
 * Translates the refusals the Phase-3 database raises into RFC 9457 problems
 * that say what the refusal *is*.
 *
 * Three of the guards in `migration.sql §C.7` are not validation. They are the
 * statute, an atomic-energy obligation and a patient-safety contract, and each
 * one has to reach the screen as itself:
 *
 *  * **PC-PNDT** (`rad.enforce_form_f`, `rad.enforce_form_f_immutability`) —
 *    the Pre-Conception and Pre-Natal Diagnostic Techniques (Prohibition of Sex
 *    Selection) Act 1994. Section 23 makes the recording clinician personally
 *    liable to imprisonment. `STATUTORY_LIMIT` is the problem type for exactly
 *    this: a refusal nobody in the hospital has the authority to relax. Mapping
 *    it to `validation-failed` would put it in the same visual bucket as a
 *    mistyped date and invite somebody to look for the field they got wrong.
 *  * **AERB dose** (`rad.enforce_dose_recorded`) — `docs/DECISIONS.md D-41`:
 *    not configurable, and blocking at signature rather than at exam completion
 *    precisely so the answer is "the RDSR has not landed yet", not "type a
 *    number". `BUSINESS_RULE_VIOLATED` with the next action naming the dose
 *    entry route.
 *  * **The critical finding** (`rad.enforce_critical_finding_raised`) — the
 *    report is never withheld; what the database insists on is that the finding
 *    row exists before the signature, because that row is what the escalation
 *    ladder and the 60-minute NABH indicator are measured from.
 *
 * Everything else is rethrown untouched: a guess at what an unfamiliar
 * constraint means is worse than the raw failure, which at least reaches the
 * logs intact.
 */
export function mapDatabaseRefusal(error: unknown): never {
  const message = messageOf(error);

  if (message.startsWith('PC-PNDT:')) {
    throw new AppError(ProblemType.STATUTORY_LIMIT, message, {
      clinicalImpact:
        'The Pre-Conception and Pre-Natal Diagnostic Techniques (Prohibition of Sex Selection) Act 1994 makes this record a statutory precondition, not paperwork that can follow later.',
      nextAction:
        'Complete and sign Form F for this examination — both declarations — on a machine registered under the Act, then try again.',
      reference: 'PC-PNDT Act 1994, ss. 3, 4, 5, 6 and 29',
    });
  }

  if (message.startsWith('AERB:')) {
    throw new AppError(ProblemType.BUSINESS_RULE_VIOLATED, message, {
      clinicalImpact:
        'The dose register is the evidence an AERB inspection asks for. A signed report with no dose figure behind it is a gap in it.',
      nextAction:
        'Record the dose for this exam (RDSR, DICOM header, MPPS or a documented manual entry) and sign again.',
      reference: 'docs/DECISIONS.md D-41',
    });
  }

  if (message.includes('countersigned by its own author')) {
    throw new AppError(ProblemType.SEGREGATION_OF_DUTIES, message, {
      nextAction: 'The countersignature has to come from a consultant other than the author.',
      reference: 'OP-022 §5',
    });
  }

  if (message.includes('requires a consultant countersignature')) {
    throw new AppError(ProblemType.APPROVAL_REQUIRED, message, {
      nextAction: 'Send the draft for countersignature; the consultant’s signature is what makes it final.',
      reference: 'OP-022 §5',
    });
  }

  if (message.startsWith('OP-008 §5:')) {
    throw new AppError(ProblemType.BUSINESS_RULE_VIOLATED, message, {
      clinicalImpact:
        'The report itself is never withheld. What must exist before the signature is the finding row the escalation ladder is measured from.',
      nextAction: 'Raise the critical finding first, then sign; the call-back can follow within the hour.',
    });
  }

  throw error;
}

/**
 * Runs `fn` and translates a database refusal on the way out.
 *
 * Wrapping the whole transaction rather than each statement is deliberate: the
 * triggers fire on `INSERT`/`UPDATE` of rows this module writes several
 * statements apart, and a caller should not have to know which statement
 * happened to be the one the Act objected to.
 */
export async function withDatabaseRefusals<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof AppError) throw error;
    return mapDatabaseRefusal(error);
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : '';
}
