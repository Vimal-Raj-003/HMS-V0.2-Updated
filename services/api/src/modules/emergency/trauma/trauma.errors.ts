import { ProblemType } from '@vims/contracts';
import { moduleRefusalMessage } from '../../../core/problem/module-sqlstates.js';
import { AppError } from '../../../core/problem/app-error.js';

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
 * TR-001's CHECK constraints, in the words the person who hit them needs.
 *
 * The triggers are not listed: they raise SQLSTATE `TR001` with a message
 * already written for a human, and repeating it here would give the codebase two
 * versions of the same sentence to keep in step.
 */
const CONSTRAINT_TRANSLATIONS: Readonly<Record<string, Translation>> = {
  triage_override_says_why: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'An override needs a reason, and a reason without an override is not an override. The nurse in front of the patient is usually right — the record just has to say why.',
    nextAction: 'Send the reason with the level, or drop both and take the computed level.',
  },
  triage_esi_in_range: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'ESI runs from 1 to 5.',
  },
  triage_suggested_in_range: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'The computed ESI level runs from 1 to 5.',
  },
  triage_has_a_category: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A triage produces a category: an ESI level, or a START tag. A triage record with neither says the patient was looked at and nothing was decided.',
  },
  triage_gcs_components_in_range: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'GCS components are eye 1-4, verbal 1-5, motor 1-6.',
  },
  triage_intubated_has_no_verbal: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'An intubated patient has no verbal score. Recording one inflates the GCS, and a GCS one point out is the difference between a level-2 and a level-1 activation.',
  },
  triage_sequence_starts_at_one: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'The first triage of a visit is number 1.',
  },
  uq_triage_sequence_per_visit: {
    type: ProblemType.CONFLICT,
    detail:
      'Another triage was recorded for this patient while you were writing. Re-read the visit and triage again — nothing was lost.',
  },
  activation_page_times_ordered: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A page is acknowledged after it is sent, and the responder arrives after acknowledging.',
  },
  activation_page_failure_says_why: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A page that failed records why, so somebody can send it another way.',
  },
  uq_activation_page_per_role: {
    type: ProblemType.CONFLICT,
    detail: 'That role has already been paged for this activation.',
  },
  activation_stand_down_is_owned: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A stand-down needs the person who called it and a reason. A silent stand-down is how the next page gets ignored.',
    nextAction: 'Send the reason in the `x-reason` header.',
  },
  activation_has_a_basis: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'An activation records either the criteria that fired or that it was clinical judgement. Both are legitimate; neither being recorded is not.',
  },
  activation_final_iss_in_range: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'ISS runs from 0 to 75.',
  },
  trauma_score_locked_is_signed: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A locked score records who locked it and when.',
  },
  trauma_score_amendment_says_why: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'An amendment states what was wrong with the version it supersedes. Without it the registry has two numbers and no account of the difference.',
    nextAction: 'Send the reason in the `x-reason` header.',
  },
  trauma_score_ranges: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'ISS and NISS run 0-75, RTS 0-7.8408, and TRISS is a probability between 0 and 1.',
  },
  trauma_score_niss_at_least_iss: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'NISS takes the three worst injuries anywhere and ISS takes the worst in each of three regions, so NISS is never the smaller of the two. This one is arithmetic, not policy.',
  },
  trauma_score_version_starts_at_one: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'The first score of a visit is version 1.',
  },
  uq_trauma_score_version: {
    type: ProblemType.CONFLICT,
    detail: 'That score version already exists. Re-read the visit and compute again.',
  },
  trauma_injury_ais_in_range: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'AIS severity runs from 1 to 6. A 6 is an injury described as unsurvivable and forces ISS to 75.',
  },
  trauma_injury_region_is_known: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'AIS has six regions: head/neck, face, chest, abdomen, extremity, external. ISS is the sum of squares over three of them, so a seventh would change the arithmetic.',
  },
  survey_tourniquet_times_ordered: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A tourniquet comes off after it goes on. A tourniquet nobody timed is a limb.',
  },
  survey_injury_before_door: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'The injury happened before the patient reached the door.',
  },
  survey_volumes_non_negative: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'Volumes given and lines placed are counts, not adjustments.',
  },
  mci_incidents_hospital_id_incident_code_key: {
    type: ProblemType.CONFLICT,
    detail: 'That incident code is already in use.',
  },
};

/**
 * Turn what the database refused into a refusal the caller can act on.
 *
 * TR-001's triggers raise the custom SQLSTATE `TR001` with a message already
 * written for the person who hit it — the level-1 page rule, the append-only
 * triage record, the locked score. Passing it through keeps one wording, next to
 * the rule it describes.
 */
export function mapTraumaDatabaseError(error: unknown): unknown {
  if (error instanceof AppError) return error;
  const pg = asPostgresError(error);
  if (pg === null) return error;

  // Any module's SQLSTATE, not just this one: a trigger fires where the
  // write happens, and TR-008's discharge gate fires inside OP-006.
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
      'That record already exists for this visit. Nothing was written — re-read it and try again.',
    );
  }

  return error;
}

/** Runs `fn` and translates anything the database refuses into a stated refusal. */
export async function withTraumaErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw mapTraumaDatabaseError(error);
  }
}
