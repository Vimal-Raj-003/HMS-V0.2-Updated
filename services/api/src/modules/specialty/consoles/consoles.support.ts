import { Inject, Injectable } from '@nestjs/common';
import { ProblemType } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService, type TransactionClient } from '../../../core/db/database.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { moduleRefusalMessage } from '../../../core/problem/module-sqlstates.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';

/**
 * What the five device-heavy consoles share, and nothing more.
 *
 * They share a tenancy preamble, a set of coercions from `pg`'s text-shaped
 * results, and one error translator. They do **not** share a service base with
 * clinical behaviour in it: a cardiology rule that turned out to also apply to
 * dentistry would be a coincidence, and a shared method is how a coincidence
 * becomes a dependency nobody can safely change later.
 */

export function asText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString();
  return '';
}
export function asTextOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : asText(v);
}
export function asNumber(v: unknown): number {
  return typeof v === 'number' ? v : Number(asText(v));
}
export function asNumberOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : asNumber(v);
}
export function asBool(v: unknown): boolean {
  return v === true || v === 't' || v === 'true';
}
export function asBoolOrNull(v: unknown): boolean | null {
  return v === null || v === undefined ? null : asBool(v);
}
export function asJson(v: unknown): Record<string, unknown> {
  if (v === null || v === undefined) return {};
  if (typeof v === 'object') return v as Record<string, unknown>;
  if (typeof v === 'string') {
    try {
      const parsed: unknown = JSON.parse(v);
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
}
export function asStringArray(v: unknown): readonly string[] {
  return Array.isArray(v) ? v.map((x) => asText(x)) : [];
}
export function asNumberArray(v: unknown): readonly number[] {
  return Array.isArray(v) ? v.map((x) => asNumber(x)) : [];
}

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
 * The CHECK constraints, translated.
 *
 * The trigger-raised refusals do not appear here: they carry their own
 * SQLSTATE and their own sentence, written for the person who hit them, and
 * `moduleRefusalMessage` passes them through untouched. What needs translating
 * is Postgres's own wording for a CHECK, which names a constraint and nothing
 * a clinician can act on.
 */
const CONSTRAINT_TRANSLATIONS: Readonly<Record<string, Translation>> = {
  // ── OP-029 ────────────────────────────────────────────────────────────────
  ecg_intervals_are_plausible: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'One of those intervals is outside what a tracing can show. A PR of 1600 ms is usually a decimal point, and a QRS of 12 ms is usually centiseconds entered as milliseconds.',
  },
  ef_is_a_percentage: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'An ejection fraction runs from 5 to 85 per cent.',
  },
  functional_classes_are_one_to_four: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'NYHA and CCS classes run from I to IV.',
  },
  a_finished_stress_test_says_why_it_stopped: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A stress test with a result records why it was stopped. "Target heart rate reached" and "chest pain with 3 mm of ST depression" are different tests, and the difference is the report.',
  },
  inr_window_belongs_to_a_monitored_drug: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A vitamin-K antagonist needs a target INR range, low below high; a direct oral anticoagulant has none, because it is not monitored by INR.',
  },
  inr_is_an_inr: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'An INR runs from 0.5 to 20. Check the reading.',
  },

  // ── OP-030 ────────────────────────────────────────────────────────────────
  pft_grade_is_ats_ers: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'The effort grade is a single letter A to F, as ATS/ERS defines it.',
  },
  ahi_is_an_index: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'An apnoea-hypopnoea index is events per hour, 0 to 200.',
  },
  pap_pressures_match_the_mode: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'The pressures do not match the mode. CPAP is one pressure; APAP is a range with the minimum below the maximum; bilevel and ASV are an EPAP below an IPAP — the other way round is a machine that cannot deliver a breath.',
    nextAction: 'Check the mode, then the pressures.',
  },
  pap_pressures_are_in_range: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'That pressure is outside what these machines deliver.',
  },
  compliance_period_runs_forwards: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A compliance period starts before it ends.',
  },
  compliance_figures_are_plausible: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'Average nightly use runs from 0 to 24 hours, and the share of nights from 0 to 100 per cent.',
  },

  // ── OP-028 ────────────────────────────────────────────────────────────────
  threshold_is_within_the_audiometer: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A threshold runs from −10 to 120 dB HL. Below that is not a hearing threshold; above it is past the output of the audiometer.',
  },
  threshold_names_an_audiometric_frequency: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'That is not a frequency this transducer is calibrated at. Bone conduction stops at 4 kHz, because bone vibrators have no calibrated output above it.',
  },
  threshold_names_one_ear: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A threshold belongs to one ear. An audiogram has two curves.',
  },
  audiology_result_names_one_ear: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'An audiology result is per ear.',
  },
  a_hearing_aid_is_fitted_to_one_ear: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A hearing aid is fitted to one ear. A bilateral fitting is two devices.',
  },
  ent_questionnaire_scores_are_in_range: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'STOP-BANG runs 0 to 8 and the Epworth scale 0 to 24.',
  },
  uq_audiogram_point: {
    type: ProblemType.CONFLICT,
    detail:
      'That ear, conduction and frequency already has a threshold on this test. Correct it rather than adding a second — two points at 1 kHz is a graph that draws itself differently depending on row order.',
  },
  uq_audiology_result_ear: {
    type: ProblemType.CONFLICT,
    detail: 'That ear already has a result on this test.',
  },
  ent_hearing_aids_serial_key: {
    type: ProblemType.CONFLICT,
    detail:
      'That serial number is already recorded. A serial identifies a physical device, and the same device cannot be dispensed twice.',
  },
  ent_exams_encounter_id_key: {
    type: ProblemType.CONFLICT,
    detail: 'This consultation already has an ENT examination. Open it rather than starting a second.',
  },

  // ── OP-026 ────────────────────────────────────────────────────────────────
  tooth_number_is_a_real_tooth: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'That is not an FDI tooth number. Quadrant then position: 11–18, 21–28, 31–38, 41–48 for adult teeth, 51–55, 61–65, 71–75, 81–85 for primary.',
  },
  acceptance_says_how_the_patient_agreed: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A plan cannot be accepted without recording how the patient agreed: an e-signature, the portal, or a witnessed verbal yes.',
  },
  a_presented_plan_was_presented_by_somebody: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A plan that has left draft was presented by somebody, at a time.',
  },
  plan_line_amounts_are_not_negative: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A plan line has a positive quantity and no negative amounts.',
  },
  uq_dental_plan_no: {
    type: ProblemType.CONFLICT,
    detail: 'That plan number is already in use.',
  },
  uq_dental_plan_item_seq: {
    type: ProblemType.CONFLICT,
    detail: 'That line number is already used on this plan.',
  },
  uq_dental_chart_patient: {
    type: ProblemType.CONFLICT,
    detail: 'This patient already has a chart. It is rebuilt from the log, not created twice.',
  },

  // ── OP-027 ────────────────────────────────────────────────────────────────
  itch_is_a_zero_to_ten_scale: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'An itch score runs from 0 to 10.',
  },
  lesion_number_is_positive: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A lesion number starts at 1.',
  },
  erythema_grade_is_zero_to_four: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'Erythema is graded 0 (none) to 4 (blistering).',
  },
  a_session_delivers_something: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A session delivers a positive dose and carries a sequence number.',
  },
  skin_type_is_fitzpatrick: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'Skin type is Fitzpatrick I to VI. It sets the starting dose, and being two steps out is a burn on the first session.',
  },
  course_doses_make_a_ladder: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A course starts above zero, has a ceiling at or above its starting dose, an increment between 0 and 100 per cent, and one to seven sessions a week.',
  },
  a_course_records_its_shielding: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A phototherapy course records its eye shielding. The cataract arrives twenty years after the course nobody wrote it down for.',
  },
  puva_records_its_psoralen: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'PUVA records its psoralen — the agent, the dose and the time before exposure. Without it the photosensitising step is missing from the record.',
  },
  biopsy_type_is_a_biopsy: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A skin biopsy is a punch, a shave, an excision, an incisional biopsy or a curettage.',
  },
  uq_derm_lesion_no: {
    type: ProblemType.CONFLICT,
    detail: 'That lesion number is already used for this patient.',
  },
  uq_phototherapy_session_seq: {
    type: ProblemType.CONFLICT,
    detail: 'That session number already exists on this course.',
  },
};

/** Wraps a unit of work so Postgres's refusals arrive as problems a person can act on. */
export async function withConsoleErrors<T>(work: () => Promise<T>): Promise<T> {
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
            : new AppError(translation.type, translation.detail, {
                nextAction: translation.nextAction,
              }),
        );
      }
    }

    throw error;
  }
}

/**
 * The tenancy preamble every console service repeats, and the transaction
 * wrapper that turns a database refusal into a problem+json.
 */
@Injectable()
export class ConsoleSupport {
  constructor(
    @Inject(DatabaseService) protected readonly db: DatabaseService,
    @Inject(OutboxService) protected readonly outbox: OutboxService,
    @Inject(AuditService) protected readonly audit: AuditService,
  ) {}

  protected hospitalId(): string {
    const id = getContext().hospitalId;
    if (id === null) throw AppError.unauthenticated();
    return id;
  }

  protected branchId(): string {
    const id = getContext().branchId;
    if (id === null || id === undefined) {
      throw AppError.conflict('This action needs a branch. Choose one and try again.');
    }
    return id;
  }

  protected actorId(): string {
    const id = getContext().userId;
    if (id === null) throw AppError.unauthenticated();
    return id;
  }

  protected guard<T>(fn: (tx: TransactionClient) => Promise<T>): Promise<T> {
    return withConsoleErrors(() => this.db.withTenant(currentTenantContext(), fn));
  }
}
