import { ProblemType } from '@vims/contracts';
import { AppError } from '../../../core/problem/app-error.js';
import { moduleRefusalMessage } from '../../../core/problem/module-sqlstates.js';

interface PostgresErrorShape {
  readonly code: string;
  readonly constraint: string | undefined;
  readonly message: string | undefined;
}

function asPostgresError(error: unknown): PostgresErrorShape | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as { code?: unknown; constraint?: unknown; message?: unknown };
  if (typeof candidate.code !== 'string') return null;
  return {
    code: candidate.code,
    constraint: typeof candidate.constraint === 'string' ? candidate.constraint : undefined,
    message: typeof candidate.message === 'string' ? candidate.message : undefined,
  };
}

interface Translation {
  readonly type: (typeof ProblemType)[keyof typeof ProblemType];
  readonly detail: string;
  readonly nextAction?: string;
}

const CONSTRAINT_TRANSLATIONS: Readonly<Record<string, Translation>> = {
  transfusion_starts_on_a_two_person_bedside_check: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A transfusion starts on a two-person bedside check: two nurses, the wristband as scanned and the bag as scanned. An ABO-incompatible transfusion kills in minutes and the commonest cause is a bag hung on the wrong patient — there is no way to skip, defer or configure this away.',
    nextAction: 'Get a second nurse, scan the wristband and scan the bag.',
  },
  bedside_checkers_are_two_people: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'The two bedside checkers are two people. A second check by the same person is not a second check.',
  },
  issue_checkers_are_two_people: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'Issuing a unit takes two people at the bank, and they are two different people.',
  },
  transfusion_ends_after_it_starts: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A transfusion ends after it starts.',
  },
  uq_one_live_issue_per_unit: {
    type: ProblemType.CONFLICT,
    detail:
      'That unit is already issued and not returned. A bag issued twice is a bag that could be hung twice.',
  },
  unit_expires_after_collection: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A unit expires after it is collected.',
  },
  unit_volume_is_sane: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A bag holds between 20 and 600 millilitres.',
  },
  discard_states_its_reason: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'Discarding a unit records why. It is a donation somebody gave.',
  },
  excursion_states_what_happened: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A temperature excursion records what happened. It is a fact about the bag, not about the fridge.',
  },
  reaction_records_its_management: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A reaction records how it was managed. "Reaction occurred" with nothing else is a line in a register nobody can learn from.',
  },
  reaction_severity_is_known: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'That is not a severity this register knows.',
  },
  shock_records_its_energy: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A shock records its energy in joules. A flowsheet line that says "shock" cannot be reviewed.',
  },
  drug_records_what_and_how_much: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A drug line records what was given and how much.',
  },
  rhythm_line_names_the_rhythm: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A rhythm line names the rhythm.',
  },
  cease_states_its_reason: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'Stopping resuscitation records why. It is the decision the family will ask about.',
  },
  cart_check_kind_is_known: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A cart check is a seal check or a full open-check.',
  },
  full_check_records_its_findings: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A full open-check records what was found. One with nothing recorded is a check somebody did from the corridor.',
  },
  rass_in_range: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'The Richmond agitation-sedation scale runs from −5 to +4.',
  },
  gcs_in_range: { type: ProblemType.VALIDATION_FAILED, detail: 'A Glasgow coma score runs from 3 to 15.' },
  fio2_is_a_percentage: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'Inspired oxygen is a percentage between 21 and 100.',
  },
  uq_icu_flowsheet_hour: {
    type: ProblemType.CONFLICT,
    detail:
      'That hour is already charted. Amend the existing row rather than adding a second reading for the same hour.',
  },
  uq_icu_bundle_shift: {
    type: ProblemType.CONFLICT,
    detail: 'That bundle is already recorded for this shift.',
  },
  uq_blood_unit_no: { type: ProblemType.CONFLICT, detail: 'That unit number is already on the register.' },
  uq_blood_request_no: { type: ProblemType.CONFLICT, detail: 'That request number is already in use.' },
  uq_blood_donor_no: { type: ProblemType.CONFLICT, detail: 'That donor number is already registered.' },
  uq_crash_cart_code: { type: ProblemType.CONFLICT, detail: 'That cart code already exists in this branch.' },
  uq_code_blue_no: { type: ProblemType.CONFLICT, detail: 'That code number is already in use.' },
};

/**
 * Wraps a unit of work so Postgres's refusals arrive as problems a person can act on.
 *
 * The exclusion constraint's translation is the one that matters at 3 a.m.: a
 * lost race is not an error the nurse caused, and the message says what
 * happened and what to do rather than naming a constraint.
 */
export async function withCriticalCareErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const pg = asPostgresError(error);
    if (pg === null) throw error;

    const refusal = moduleRefusalMessage(pg.code, pg.message);
    if (refusal !== null) return Promise.reject(new AppError(ProblemType.CONFLICT, refusal));

    if (pg.constraint !== undefined) {
      const translation = CONSTRAINT_TRANSLATIONS[pg.constraint];
      if (translation !== undefined) {
        return Promise.reject(
          translation.nextAction === undefined
            ? new AppError(translation.type, translation.detail)
            : new AppError(translation.type, translation.detail, { nextAction: translation.nextAction }),
        );
      }
    }

    throw error;
  }
}
