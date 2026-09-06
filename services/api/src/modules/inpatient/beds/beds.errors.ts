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
  one_patient_per_bed: {
    type: ProblemType.CONFLICT,
    detail:
      'That bed already has a patient in it for that period. Somebody claimed it between the board loading and this request — which is exactly what this constraint is for.',
    nextAction: 'Reload the board and allocate again; the allocator will pick another bed in the class.',
  },
  occupancy_ends_after_it_starts: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A patient leaves a bed after they arrive in it.',
  },
  closed_occupancy_says_why: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'Closing an occupancy says why. A transfer and a discharge price differently and read differently on a census, and "it ended" is neither.',
  },
  discharge_after_admission: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A patient is discharged after they are admitted.',
  },
  admitted_admission_has_a_time: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'An admitted patient has an admission time. It is what the room clock counts from.',
  },
  discharged_admission_has_an_outcome: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A discharge records its outcome. Routine, against advice, absconded, transferred out and died are five different statutory obligations.',
  },
  deposit_is_not_negative: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A deposit is zero or more.',
  },
  blocked_bed_says_why: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'Blocking a bed states why. A blocked bed is one the hospital does not have.',
  },
  hold_expires_after_it_is_taken: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A hold expires after it is taken.',
  },
  released_hold_says_why: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'Releasing a hold says whether the patient came, the time ran out, or it was cancelled.',
  },
  uq_one_live_hold_per_bed: {
    type: ProblemType.CONFLICT,
    detail:
      'That bed is already held for somebody. Two people each told the bed is theirs is the same failure as two patients in it, discovered slightly earlier.',
  },
  cleaning_sla_is_positive: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A cleaning window is between one minute and a day.',
  },
  completed_cleaning_is_owned: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A completed clean names who did it.',
  },
  failed_cleaning_says_why: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A failed clean says what was wrong, so the next attempt fixes it.',
  },
  uq_admission_ip_no: {
    type: ProblemType.CONFLICT,
    detail: 'That IP number is already in use.',
  },
  uq_bed_code: {
    type: ProblemType.CONFLICT,
    detail: 'A bed with that code already exists in this branch.',
  },
  uq_ward_code: {
    type: ProblemType.CONFLICT,
    detail: 'A ward with that code already exists in this branch.',
  },
};

/**
 * Wraps a unit of work so Postgres's refusals arrive as problems a person can act on.
 *
 * The exclusion constraint's translation is the one that matters at 3 a.m.: a
 * lost race is not an error the nurse caused, and the message says what
 * happened and what to do rather than naming a constraint.
 */
export async function withBedErrors<T>(work: () => Promise<T>): Promise<T> {
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
