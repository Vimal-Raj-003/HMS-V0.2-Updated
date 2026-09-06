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

/**
 * The four IP-002/IP-017 triggers raise `IP002` and carry their own prose, so
 * they never reach this table — `moduleRefusalMessage` passes their message
 * through verbatim. What is here is the CHECK constraints, which have no
 * message of their own.
 */
const CONSTRAINT_TRANSLATIONS: Readonly<Record<string, Translation>> = {
  reconciliation_decision_says_why: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'Stopping, changing or starting a medicine records why. Only "continue as before" needs no reason — stopping somebody’s statin silently is how it never gets restarted.',
    nextAction: 'Write the reason for the change on that medicine.',
  },
  resolved_reconciliation_is_owned: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A decision about a medicine names who made it and when. Continuing one is still a decision.',
  },
  summary_signature_is_owned: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A signature names the signer, and a countersignature names the countersigner.',
  },
  cosigner_is_a_second_person: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A countersignature is a second person reading the document. Countersigning your own summary is signing it twice.',
    nextAction: 'Ask the consultant responsible for the patient to countersign.',
  },
  amendment_states_its_reason: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A new version of a signed summary says what changed and why. The reason is printed on the version, because the reader has the old one too.',
  },
  summary_carries_red_flag_advice: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'The summary needs red-flag advice: what would mean the patient should come straight back. It is the paragraph that brings a deteriorating patient in, and "as advised" is not it.',
    nextAction: 'Write the specific warning signs for this patient.',
  },
  dama_records_what_was_explained: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A discharge against medical advice records what was explained, who witnessed it, and when it was signed. Leaving is the patient’s right; the record of it protects them and the hospital equally.',
    nextAction: 'Record the risks as they were explained, and the witness who heard it.',
  },
  completed_discharge_is_owned: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'Marking a patient as having left names who saw them leave.',
  },
  discharge_completes_after_it_starts: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A patient cannot have left before the discharge was started.',
  },
  cause_of_death_is_stated: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A death file states the cause of death.',
  },
  mccd_form_is_known: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'The certificate is Form 4 for an institutional death or Form 4A otherwise.',
  },
  release_after_declaration: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A body cannot be released before the death was declared.',
  },
  uq_discharge_per_admission: {
    type: ProblemType.CONFLICT,
    detail: 'This admission already has a discharge in progress. Open it rather than starting a second.',
  },
  uq_summary_version: {
    type: ProblemType.CONFLICT,
    detail:
      'That version of the summary already exists. Somebody else amended it while this was open — reload and amend from the current version.',
  },
  uq_mortuary_record_no: {
    type: ProblemType.CONFLICT,
    detail: 'That mortuary record number is already on the register.',
  },
  uq_body_tag_no: {
    type: ProblemType.CONFLICT,
    detail:
      'That body tag is already in use. Two bodies under one tag is how the wrong one is released; issue the next tag.',
  },
};

/** Wraps a unit of work so Postgres’s refusals arrive as problems a person can act on. */
export async function withDischargeErrors<T>(work: () => Promise<T>): Promise<T> {
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
