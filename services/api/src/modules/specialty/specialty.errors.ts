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

/**
 * The framework's triggers raise `SP001` and carry their own prose, so they
 * pass through `moduleRefusalMessage` verbatim. What is here is the CHECK
 * constraints and the unique indexes, which have no message of their own.
 */
const CONSTRAINT_TRANSLATIONS: Readonly<Record<string, Translation>> = {
  console_code_is_a_prefix: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A console code is uppercase letters, digits and underscores — it becomes the prefix on this console’s permission keys, events and print templates.',
  },
  console_names_its_licence_key: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A console names the licence key that gates it, in the form module.<something>.enabled. Without one it could not be switched off, and every console must be.',
  },
  uq_specialty_console_code: {
    type: ProblemType.CONFLICT,
    detail: 'A console with that code is already registered for this hospital.',
  },
  uq_device_result_type_code: {
    type: ProblemType.CONFLICT,
    detail: 'That device result type code is already declared for this hospital.',
  },
  stage_ends_after_it_starts: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A stage of a visit ends after it starts.',
  },
  closed_stage_is_owned: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'Closing a stage names who closed it.',
  },
  uq_one_open_stage_per_encounter: {
    type: ProblemType.CONFLICT,
    detail:
      'This patient already has that stage open. Two open legs of the same stage make the turnaround report count one wait twice and hide the second lane.',
    nextAction: 'Close the open stage before starting it again.',
  },
  device_result_types_console_id_fkey: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'That console is not registered, so nothing can be declared against it.',
  },
};

/** Wraps a unit of work so Postgres’s refusals arrive as problems a person can act on. */
export async function withSpecialtyErrors<T>(work: () => Promise<T>): Promise<T> {
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
