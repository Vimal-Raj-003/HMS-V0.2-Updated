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
 * The database's refusals, in the words the person at the trolley needs.
 *
 * Everything here is a constraint that exists because of a specific failure:
 * the recall list that came back short, the device found in two patients, the
 * cast check nobody acted on. The translation says what to do next, not what
 * the constraint is called.
 */
const CONSTRAINT_TRANSLATIONS: Readonly<Record<string, Translation>> = {
  implant_stock_is_identifiable: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A device is booked in with a serial number or a lot number. One with neither cannot be found again when a field safety notice names it, which makes it a device that can never be recalled.',
    nextAction: 'Scan the box, or type the lot number from the label.',
  },
  implant_is_scanned_or_reasoned: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'Record the scan, or say why it could not be scanned. A hand-typed serial with no explanation is the entry a recall cannot match and nobody can question.',
    nextAction: 'Scan the device, or send the grounds for entering it by hand.',
  },
  scanned_implant_carries_its_payload: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A device marked as scanned carries what the scanner read. Without it the scan is a claim, not evidence.',
  },
  manual_entry_is_owned: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A device entered by hand names who entered it.',
  },
  explant_says_why: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'An explant records why the device came out. Infection, loosening, breakage and revision are different signals to the manufacturer and to the registry.',
  },
  explant_after_implant: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A device comes out after it goes in.',
  },
  expired_implant_is_not_available: {
    type: ProblemType.CONFLICT,
    detail: 'This device is past its expiry date and cannot be shown as available.',
    nextAction: 'Quarantine it.',
  },
  recall_names_a_device_or_a_lot: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A recall names a device identifier or a list of lots. One that names neither cannot produce a patient list, and a patient list is the only thing a recall is for.',
  },
  unreachable_means_somebody_tried: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'Marking somebody unreachable needs at least two recorded attempts. Unreachable on the first ring is a phone call nobody made twice.',
  },
  recall_response_is_known: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'That is not a recall response this register knows.',
  },
  recall_kind_is_known: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'That is not a notice kind this register knows.',
  },
  implant_catalogue_is_findable: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A catalogue entry needs a device identifier or a catalogue number. One with neither cannot be looked up by the store, the theatre or a field safety notice.',
  },
  uq_implant_serial: {
    type: ProblemType.CONFLICT,
    detail:
      'This serial number is already on the shelf. Two rows for one device is one device given to two patients.',
  },
  uq_implant_catalogue_udi: {
    type: ProblemType.CONFLICT,
    detail:
      'This device identifier is already in the catalogue. Two entries for one device means a field safety notice quoting it matches one of them and misses the patients recorded against the other.',
    nextAction: 'Amend the existing entry rather than adding a second.',
  },
  uq_implant_catalogue_no: {
    type: ProblemType.CONFLICT,
    detail: 'That catalogue number is already in use for another device.',
  },
  capillary_refill_is_seconds: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'Capillary refill is recorded in seconds, and a limb does not have a sixty-second refill worth writing down.',
  },
  cast_removed_after_applied: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A cast comes off after it goes on.',
  },
  pin_infection_grade_in_range: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'Checketts-Otterburn runs 1 to 6. Grade 3 needs antibiotics and grade 5 usually means the pin comes out, so the number is a decision rather than a note.',
  },
  pin_care_interval_is_positive: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A pin-site care interval is at least one day.',
  },
};

/**
 * Wraps a unit of work so Postgres's refusals arrive as problems a person can act on.
 *
 * The `moduleRefusalMessage` branch is the important one: TR-003 and TR-005
 * raise their own SQLSTATEs with messages written for the screen, and those are
 * passed through verbatim rather than being re-worded here. The trigger is the
 * only place that knows *which* rule fired.
 */
export async function withImplantErrors<T>(work: () => Promise<T>): Promise<T> {
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
