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
  confirmed_open_fracture_is_graded: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'An open fracture is confirmed with its Gustilo grade. The grade decides the antibiotic regimen and whether plastics are called, so a confirmation without it signs off a fracture whose treatment nobody can derive.',
  },
  gustilo_is_for_open_fractures: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'Gustilo-Anderson grades an open fracture. This one is recorded as closed.',
  },
  confirmation_is_owned: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A confirmed classification records who signed it and when.',
  },
  salter_harris_is_paediatric: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'Salter-Harris classifies a physeal injury, which needs a growth plate. On a mature skeleton it is a miscode, and it changes the treatment.',
  },
  nonunion_override_is_owned_and_reasoned: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'Declaring non-union before six months names the surgeon and the grounds. It converts a fracture that might have healed into an operation.',
    nextAction: 'Send the grounds in the `x-reason` header.',
  },
  united_fracture_has_a_union_date: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A united fracture records when it united. The interval is the outcome measure.',
  },
  union_is_after_injury: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A fracture unites after it happens.',
  },
  closed_fracture_says_why: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'Closing a fracture record for any reason other than union states which reason.',
  },
  ao_components_in_range: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'AO/OTA runs bone 1-9, segment 1-4, type A/B/C, group and subgroup 1-3. Anything else renders a code no registry accepts and no surgeon recognises.',
  },
  ao_code_is_built_in_order: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'An AO code is built outwards: bone and segment before a type, a type before a group, a group before a subgroup. A subgroup with no group is half a code.',
  },
  confirmed_fracture_is_classified_to_type: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A confirmed fracture is classified at least to type level — that is the point at which the code means something clinically, and below it the registry cannot use the row.',
  },
  fracture_version_starts_at_one: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'The first version of a fracture record is 1.',
  },
  uq_fracture_version: {
    type: ProblemType.CONFLICT,
    detail: 'Another change was recorded while you were editing. Re-read the fracture and try again.',
  },
  uq_fracture_plan_version: {
    type: ProblemType.CONFLICT,
    detail: 'Another plan was set while you were writing. Re-read the fracture and try again.',
  },
  union_scores_in_range: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'RUST scores 4 to 12 across four cortices; mRUST scores 4 to 16.',
  },
  displacement_measures_are_sane: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'Translation is a percentage, shortening is a positive distance, and angulation is 0 to 180 degrees.',
  },
  followup_offset_runs_forward: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A follow-up is scheduled forward from the anchor date, not before it.',
  },
  completed_followup_has_a_time: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A completed follow-up records when it happened.',
  },
  uq_ortho_followup_offset: {
    type: ProblemType.CONFLICT,
    detail: 'That protocol already has a visit at this offset on this episode.',
  },
  ortho_anchor_is_known: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A follow-up schedule is anchored on the injury, the surgery, or the first visit.',
  },
  prom_score_within_its_scale: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A patient-reported score sits between zero and the instrument’s maximum.',
  },
  prom_offset_runs_forward: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'An outcome measure is collected at or after the anchor date.',
  },
};

/**
 * Turn what the database refused into a refusal the caller can act on.
 *
 * The triggers are not in the table above: they raise `TR002` with a message
 * already written for a human — the wrong-site refusal names both sides and
 * the bone, and the film refusal says how far before the injury it was taken.
 *
 * `moduleRefusalMessage` covers every module's SQLSTATE rather than just this
 * one, because a fracture written from the ER can be refused by OP-006's rules
 * on the way past.
 */
export function mapFractureDatabaseError(error: unknown): unknown {
  if (error instanceof AppError) return error;
  const pg = asPostgresError(error);
  if (pg === null) return error;

  const refusal = moduleRefusalMessage(pg.code, pg.message);
  if (refusal !== null) return new AppError(ProblemType.CONFLICT, refusal);

  if (pg.constraint !== undefined) {
    const byConstraint = CONSTRAINT_TRANSLATIONS[pg.constraint];
    if (byConstraint !== undefined) {
      return new AppError(byConstraint.type, byConstraint.detail, {
        ...(byConstraint.nextAction === undefined ? {} : { nextAction: byConstraint.nextAction }),
      });
    }
  }

  if (pg.code === '23505') {
    return new AppError(
      ProblemType.CONFLICT,
      'That record already exists. Nothing was written — re-read it and try again.',
    );
  }

  return error;
}

/** Runs `fn` and translates anything the database refuses into a stated refusal. */
export async function withFractureErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw mapFractureDatabaseError(error);
  }
}
