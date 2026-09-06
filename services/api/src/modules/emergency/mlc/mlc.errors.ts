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
 * TR-008's CHECK constraints, in the words the person who hit them needs.
 *
 * The triggers are not listed: they raise SQLSTATE `TR008` with a message
 * already written for a human — the discharge gate names exactly what is
 * outstanding, and the prohibited-findings refusal cites the two judgments.
 * Repeating those here would give the codebase two versions of the sentences
 * that matter most.
 */
const CONSTRAINT_TRANSLATIONS: Readonly<Record<string, Translation>> = {
  mlc_cancellation_is_owned_and_reasoned: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'Cancelling an MLC names the Medical Superintendent who decided it and why. The entry stays in the register either way.',
    nextAction: 'Send the reason in the `x-reason` header.',
  },
  mlc_case_has_a_subject: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'An MLC attaches to somebody — a patient, an ER visit, an admission, or a tag. The register has to be able to find the person years later.',
  },
  mlc_sensitive_categories_are_flagged: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'Sexual assault, dowry-related and custodial cases are sensitive by category, not by choice. A case that is one of these and is not flagged is a case whose access controls silently did not apply.',
  },
  mlc_gate_override_is_owned_and_reasoned: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'Overriding the discharge gate names who authorised it and why.',
    nextAction: 'Send the reason in the `x-reason` header.',
  },
  uq_mlc_no_per_branch: {
    type: ProblemType.CONFLICT,
    detail: 'That MLC number is already in this register.',
  },
  custody_transfer_names_both_hands: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A custody transfer names both hands: who gave it and who took it. An item that moved with nobody on either end is an item nobody is answerable for.',
  },
  custody_external_transfer_names_the_officer: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'Evidence leaving the hospital names the officer and the station it went to.',
  },
  custody_broken_seal_says_what_was_found: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A broken seal is recorded with what was actually found. This is the entry a defence lawyer will ask about, and a tick-box answers nothing.',
  },
  uq_mlc_custody_seq: {
    type: ProblemType.CONFLICT,
    detail:
      'Another transfer of this item was recorded while you were writing. Re-read the chain and try again.',
  },
  digital_evidence_is_hashed: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A photograph or video is registered with the file it names and the digest taken on the device. Without the digest it is a picture, not evidence.',
  },
  evidence_sha256_is_hex: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A SHA-256 digest is 64 lowercase hexadecimal characters.',
  },
  sealed_evidence_has_a_seal: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'Sealed means there is a tamper-evident seal number to be sealed under.',
  },
  disposed_evidence_names_the_authority: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'Disposal of evidence names the legal clearance it was done under.',
  },
  uq_mlc_evidence_item_no: {
    type: ProblemType.CONFLICT,
    detail: 'That item number is already used on this case. Re-read the evidence list and try again.',
  },
  final_report_is_signed: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A final report records who signed it, when, and the digest of the document that was signed.',
  },
  dsc_signed_report_names_the_certificate: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A digitally signed report names the certificate it was signed with. Signing on paper instead is a different, recorded state — send no `dscRef` and it is filed as wet-signed.',
  },
  addendum_says_what_it_corrects: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'An addendum states what was wrong with the version it corrects.',
    nextAction: 'Send the reason in the `x-reason` header.',
  },
  uq_mlc_report_version: {
    type: ProblemType.CONFLICT,
    detail: 'That report version already exists on this case.',
  },
  pocso_reporting_is_not_optional: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'POCSO §19 makes reporting mandatory and §21 makes failing to report an offence. An adult survivor may decline; a child’s record has no such state.',
  },
  pocso_records_the_sjpu_and_cwc_intimation: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A POCSO case records the Special Juvenile Police Unit and Child Welfare Committee intimation.',
  },
  sexual_assault_treatment_is_free: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'BNSS §397 makes treatment of a sexual-assault survivor free. There is no state in which this record bills.',
  },
  mccd_waits_for_the_pm_decision: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'The cause of death on an unnatural death is the post-mortem’s to state. Record whether a PM is required before issuing the MCCD.',
  },
  body_release_to_relatives_needs_the_noc: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A body goes to relatives against the police no-objection number, on the record.',
  },
  record_release_needs_a_written_authority: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'The clinical record leaves only against a written authority and a named approver. Police receive the intimation and the injury report; the chart itself needs a court order.',
  },
  mlc_request_is_answered_one_way: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A request is either answered or refused, not both.',
  },
  grievous_injury_names_its_ground: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A grievous classification names which limb of BNS §116 it rests on. "Grievous" with no ground is an opinion a court cannot test.',
  },
  injury_pin_is_on_the_diagram: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'The injury pin sits somewhere on the body map: 0 to 100 percent on each axis.',
  },
  injury_dimensions_are_positive: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'Injury dimensions are measurements, not adjustments.',
  },
  uq_mlc_injury_seq: {
    type: ProblemType.CONFLICT,
    detail: 'That injury number is already used on this case. Re-read the body map and try again.',
  },
  acknowledged_intimation_names_the_officer: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'An acknowledged intimation names the officer who signed for it. Otherwise "acknowledged" is the hospital marking its own homework.',
  },
  dispatched_intimation_has_a_time: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A dispatched intimation records when it went.',
  },
  failed_intimation_says_why: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A failed dispatch records why, so somebody can send it another way.',
  },
  handover_names_the_officer_and_the_authority: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A handover names the officer, the station and the requisition it answers. Evidence leaves the hospital once.',
  },
};

/**
 * Turn what the database refused into a refusal the caller can act on.
 *
 * TR-008's triggers raise SQLSTATE `TR008` with messages written for the person
 * who hit them, and two of those messages are the module's whole point: the
 * discharge gate names exactly what is outstanding, and the prohibited-findings
 * refusal cites the judgments. Passing them through unchanged is deliberate.
 */
export function mapMlcDatabaseError(error: unknown): unknown {
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
      'That record already exists on this case. Nothing was written — re-read it and try again.',
    );
  }

  return error;
}

/** Runs `fn` and translates anything the database refuses into a stated refusal. */
export async function withMlcErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw mapMlcDatabaseError(error);
  }
}
