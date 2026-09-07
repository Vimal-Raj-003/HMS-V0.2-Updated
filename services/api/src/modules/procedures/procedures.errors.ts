import { ProblemType } from '@vims/contracts';
import { AppError } from '../../core/problem/app-error.js';
import { moduleRefusalMessage } from '../../core/problem/module-sqlstates.js';

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
  one_case_per_room: {
    type: ProblemType.CONFLICT,
    detail:
      'That room is already taken for part of that time. Two cases in one room is how a patient waits on a trolley outside a door somebody else is behind.',
    nextAction: 'Pick another room or another hour — the board shows what is free.',
  },
  booking_ends_after_it_starts: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A booking ends after it starts.',
  },
  cancelled_booking_says_why: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'Cancelling or moving a booking records why. Somebody rearranged their day around it.',
  },
  timeout_is_two_people: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A time-out is two different people. One person confirming is a person agreeing with themselves, which is the exact failure the pause exists to catch.',
    nextAction: 'Ask the second person in the room to confirm.',
  },
  timeout_answers_every_question: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A time-out with a box unticked is not a time-out. If any answer is no, the procedure stops — it is not filed and worked around.',
  },
  sedation_names_who_gave_it: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'Sedation and general anaesthesia are somebody’s responsibility by name.',
  },
  procedure_ends_after_it_starts: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A procedure ends after it starts.',
  },
  signed_procedure_is_owned: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A signature names the signer.',
  },
  aldrete_is_out_of_ten: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'The modified Aldrete score runs from 0 to 10.',
  },
  high_alert_drug_has_a_second_person: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A high-alert drug is checked by a second person, and that person is not the one giving it. Insulin, heparin, concentrated electrolytes and opioids are on this list because the errors they cause are not recoverable.',
    nextAction: 'Ask the nurse at the next chair to verify.',
  },
  a_changed_dose_says_why: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A dose different from the one ordered is a decision, and it records why. The prescriber will read this before they write the next one.',
  },
  doses_are_positive: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A dose is a positive number.',
  },
  administration_ends_after_it_starts: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'An infusion ends after it starts.',
  },
  course_day_is_within_the_course: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'Day 7 of a 5-day course is a course that finished two days ago.',
  },
  held_task_says_why: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'Holding, cancelling or missing a task records why. The patient is waiting for it.',
  },
  suture_counts_are_counts: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A suture count is not negative.',
  },
  uq_procedure_order_no: {
    type: ProblemType.CONFLICT,
    detail: 'That procedure number is already in use.',
  },
  uq_procedure_room_code: {
    type: ProblemType.CONFLICT,
    detail: 'A room with that code already exists in this hospital.',
  },
  uq_checklist_per_order: {
    type: ProblemType.CONFLICT,
    detail: 'That checklist is already open for this procedure. Amend it rather than starting a second.',
  },
  procedure_recovery_procedure_id_key: {
    type: ProblemType.CONFLICT,
    detail: 'This procedure already has a recovery record.',
  },
};

/** Wraps a unit of work so Postgres’s refusals arrive as problems a person can act on. */
export async function withProcedureErrors<T>(work: () => Promise<T>): Promise<T> {
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

    // The room exclusion arrives as a plain 23P01 with no constraint name on
    // some paths; it is the one conflict a booking screen must never render as
    // "something went wrong".
    if (pg.code === '23P01' && (pg.message ?? '').includes('one_case_per_room')) {
      const translation = CONSTRAINT_TRANSLATIONS['one_case_per_room'];
      if (translation !== undefined) {
        return Promise.reject(
          new AppError(translation.type, translation.detail, {
            ...(translation.nextAction === undefined ? {} : { nextAction: translation.nextAction }),
          }),
        );
      }
    }

    throw error;
  }
}
