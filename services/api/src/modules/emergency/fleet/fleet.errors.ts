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
 * NC-013 and TR-009's CHECK constraints, in the words the person who hit them
 * needs.
 *
 * The triggers are not listed: they raise `NC013` or `TR009` with a message
 * already written for a human — the expired-papers refusal names the document
 * and its date, and the handover refusal counts the outstanding doses.
 */
const CONSTRAINT_TRANSLATIONS: Readonly<Record<string, Translation>> = {
  fleet_trip_milestones_ordered: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'The trip clock runs forward: en route after dispatch, at scene after that, arrival after leaving. Every one of these intervals is a response time somebody reports, and a negative one gets averaged into it.',
  },
  fleet_trip_odometer_runs_forward: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'The closing odometer is at least the opening one.',
  },
  fleet_trip_waiting_is_a_duration: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'Waiting time is a duration, not an adjustment.',
  },
  flagged_distance_blocks_billing: {
    type: ProblemType.CONFLICT,
    detail:
      'GPS and the odometer disagree by more than a tenth on this trip. Somebody looks before it is billed — it is either a fault or a detour, and both deserve a human.',
  },
  diversion_is_owned_and_reasoned: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'Turning an ambulance away from where it was going names the reason and the person who decided. A death in transit after an unexplained diversion is unanswerable.',
    nextAction: 'Send the reason in the `x-reason` header.',
  },
  cancelled_trip_says_why: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A cancelled or aborted trip records why.',
  },
  mandatory_document_has_an_expiry: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A mandatory document carries an expiry date. One with no date is a paper nobody checked, and the dispatch rule cannot see it.',
  },
  document_expiry_after_issue: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A document expires after it was issued.',
  },
  checklist_override_is_owned_and_reasoned: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'Sending a vehicle out with a failed mandatory check names who authorised it and why. It goes out with a known gap, on somebody’s authority.',
    nextAction: 'Send the reason in the `x-reason` header.',
  },
  fuel_entry_is_positive: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A refuelling is a positive number of litres against an odometer reading.',
  },
  shift_ends_after_it_starts: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A shift ends after it starts.',
  },
  station_coordinates_are_on_earth: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'Latitude runs -90 to 90 and longitude -180 to 180.',
  },
  position_coordinates_are_on_earth: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'That GPS fix is not on Earth. Check the device.',
  },
  uq_fleet_registration: {
    type: ProblemType.CONFLICT,
    detail: 'That registration number is already in the fleet.',
  },
  uq_fleet_code: {
    type: ProblemType.CONFLICT,
    detail: 'That fleet code is already in use.',
  },
  uq_fleet_trip_no: {
    type: ProblemType.CONFLICT,
    detail: 'That trip number already exists.',
  },
  uq_fleet_request_no: {
    type: ProblemType.CONFLICT,
    detail: 'That request number already exists.',
  },
  uq_fleet_document_per_type: {
    type: ProblemType.CONFLICT,
    detail: 'That document type is already recorded for this vehicle. Update it rather than adding a second.',
  },
  handover_completes_after_it_starts: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A handover completes after it starts.',
  },
  prealert_divert_is_owned_and_reasoned: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'Turning an inbound ambulance away names where it is going instead, and why.',
    nextAction: 'Send the reason in the `x-reason` header.',
  },
  acknowledged_prealert_names_who: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'An acknowledged pre-alert names who answered it. Otherwise "acknowledged" is the ER marking its own homework while an ambulance is en route.',
  },
  prealert_activation_suggestion_is_known: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'The activation suggestion is none, level 1 or level 2.',
  },
  ph_vitals_gcs_components_in_range: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'GCS components are eye 1-4, verbal 1-5, motor 1-6.',
  },
  ph_vitals_intubated_has_no_verbal: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'An intubated patient has no verbal score, on the road as in the department. Inventing one inflates the GCS the ER triages on.',
  },
  ph_drug_dose_is_positive: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A dose is a positive number.',
  },
};

/**
 * Turn what the database refused into a refusal the caller can act on.
 *
 * `moduleRefusalMessage` covers every module's SQLSTATE, not just these two:
 * a fleet trip closing can be refused by TR-009's unsigned-record rule, and a
 * handover can be refused by TR-008's discharge gate downstream.
 */
export function mapFleetDatabaseError(error: unknown): unknown {
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
export async function withFleetErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw mapFleetDatabaseError(error);
  }
}
