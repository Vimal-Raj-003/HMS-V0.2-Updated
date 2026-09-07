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

  // ── OP-015, OP-017, OP-011, OP-035 ────────────────────────────────────────
  a_goal_is_measurable: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A goal carries a metric, a baseline and a target. "Improve mobility" is a sentiment, and an outcome report over sentiments is empty.',
  },
  a_resolved_goal_says_what_happened: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A goal that is no longer active records what happened to it and who decided. That is the department\u2019s outcome data.',
  },
  an_extension_names_itself: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'Extending an authorisation records who extended it, when, and why.',
  },
  an_authorisation_is_a_positive_number: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'An authorisation is for at least one session. Leave it empty for an open-ended course.',
  },
  an_attended_session_happened: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'An attended session records when it started and how long it lasted.',
  },
  session_pain_scores_are_zero_to_ten: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'Pain scores run from 0 to 10.',
  },
  uq_one_active_therapy_plan: {
    type: ProblemType.CONFLICT,
    detail:
      'This episode already has an active plan. Writing a new one supersedes it \u2014 two active plans is two courses of treatment against one authorisation.',
    nextAction: 'Refresh the episode and write the new plan from the current assessment.',
  },
  uq_therapy_plan_version: {
    type: ProblemType.CONFLICT,
    detail: 'That plan version already exists on this episode.',
  },
  uq_therapy_session_seq: {
    type: ProblemType.CONFLICT,
    detail: 'That session number already exists on this episode.',
  },
  uq_therapy_session_charge: {
    type: ProblemType.CONFLICT,
    detail:
      'That charge has already been raised against another session. Therapy is where the same short act repeats forty times against one authorisation, and a duplicate charge is invisible in a list of forty identical rows.',
    nextAction: 'Check whether this session has already been billed.',
  },
  wound_measurements_are_measurements: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'Those dimensions are outside what a wound measures. Check the units.',
  },
  wound_number_is_positive: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A wound number starts at 1.',
  },
  uq_wound_no: {
    type: ProblemType.CONFLICT,
    detail: 'That wound number is already used for this patient.',
  },
  a_food_has_a_composition: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A food carries at least its energy, protein, carbohydrate and fat per 100 g. Without them a plan built on it silently under-counts.',
  },
  a_plan_period_runs_forwards: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A diet plan ends on or after the day it starts.',
  },
  an_active_diet_plan_is_signed: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'An active diet plan is signed. A kitchen cooks from it.',
  },
  uq_one_active_diet_plan: {
    type: ProblemType.CONFLICT,
    detail:
      'This patient already has an active diet plan. Two is a kitchen and a patient reading different documents.',
    nextAction: 'Activate the new plan, which supersedes the old one, rather than creating a second.',
  },
  sga_is_a_b_or_c: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A Subjective Global Assessment is A, B or C.',
  },
  an_iddsi_order_is_complete: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'An IDDSI order names a food level (3\u20137) and a fluid level (0\u20134), or it is nil by mouth and names neither. The numbers overlap without meaning the same thing, so a kitchen cannot infer the missing one.',
  },
  iddsi_levels_are_iddsi_levels: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'IDDSI numbers food 3 to 7 and drinks 0 to 4.',
  },
  // ── OP-013, OP-014 ────────────────────────────────────────────────────────
  a_vial_holds_doses: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A vial holds a positive number of doses.',
  },
  a_discarded_vial_says_why: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'Discarding a vial records why — the clock, the vial monitor, a breach, contamination, or empty.',
  },
  a_voided_dose_says_why: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'Voiding a dose records who struck it and why. The immunisation record is what a school, an outbreak investigation and the national registry read.',
  },
  uq_one_live_dose_per_antigen: {
    type: ProblemType.CONFLICT,
    detail:
      'That antigen and dose number is already recorded for this patient. In an immunisation record a double entry reads as a double dose.',
    nextAction: 'Void the existing record with a reason if it was entered in error.',
  },
  a_dose_not_given_says_why: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A scheduled dose that was skipped, refused or judged contraindicated records why. "Not given" with no reason is indistinguishable from a child nobody followed up.',
  },
  an_aefi_follows_a_dose: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'An adverse event following immunisation names at least one dose it followed.',
  },
  a_skipped_station_says_why: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A station that was not done records why, and the reason goes on the report. A silent skip is how a report comes to read as complete over a scan nobody did.',
  },
  a_done_station_names_who: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A completed station names who completed it.',
  },
  a_package_has_a_sequence: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A health check package needs at least one station in its sequence.',
  },
  a_package_age_range_runs_forwards: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A package\u2019s minimum age is at or below its maximum.',
  },
  a_cancelled_booking_says_why: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A cancelled booking records why.',
  },
  uq_hc_task_station: {
    type: ProblemType.CONFLICT,
    detail: 'That station is already on this routing slip.',
  },
  uq_hc_routing_slip: {
    type: ProblemType.CONFLICT,
    detail: 'That routing slip number is already in use today.',
  },
  uq_hc_report_version: {
    type: ProblemType.CONFLICT,
    detail: 'That report version already exists for this check.',
  },

  // ── OP-016 ────────────────────────────────────────────────────────────────
  a_second_reviewer_is_a_second_person: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A prescription cannot be countersigned by the person who wrote it. A review carrying the prescriber\u2019s own name is the audit finding rather than the control.',
  },
  a_review_is_a_person_and_a_time: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A countersignature records who reviewed it and when.',
  },
  a_prescription_supplies_something: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A prescription has a positive daily dose, a positive days supply and a quantity.',
  },
  an_agreement_expires: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'An opioid treatment agreement runs to a date after it was signed. One that never expires is one nobody revisits.',
  },
  a_revoked_agreement_says_why: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'Revoking an agreement records why. Every further opioid on the episode is refused from that moment, and the patient will be at the counter when it happens.',
  },
  uq_one_live_opioid_agreement: {
    type: ProblemType.CONFLICT,
    detail:
      'This episode already has an agreement in force. Two is a patient who signed two sets of terms and a clinic that will quote whichever suits.',
    nextAction: 'Revoke the existing agreement with a reason before signing a new one.',
  },
  an_outcome_rests_on_a_measurement: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'An intervention with an outcome records the pain score before and thirty minutes after. \u201cGood\u201d with no numbers is a clinic that cannot tell an injection that works from one that does not.',
  },
  intervention_scores_are_zero_to_ten: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'Pain scores run from 0 to 10.',
  },
  guidance_is_recorded: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'Record how the needle was guided: fluoroscopy, ultrasound, CT, landmark or endoscopic. A landmark technique where guidelines expect imaging is a finding, and an unrecorded one is invisible.',
  },
  pain_scores_are_zero_to_ten: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'Pain scores run from 0 to 10, and the global impression of change from 1 to 7.',
  },
  worst_is_not_below_least: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'The worst pain cannot be below the least. That is a form filled in the wrong order, and every trend built on it is wrong.',
  },
  a_conversion_factor_converts: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A conversion factor is positive, and is per milligram or per microgram an hour.',
  },
  a_factor_period_runs_forwards: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A conversion factor ends on or after the day it takes effect.',
  },

  // ── OP-040 ────────────────────────────────────────────────────────────────
  the_obstetric_formula_adds_up: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'The obstetric formula does not add up. Gravida counts this pregnancy too, so it cannot be less than the deliveries, miscarriages and ectopics together.',
  },
  a_cycle_is_a_cycle: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A menstrual cycle runs from 20 to 45 days. The dating is adjusted from it.',
  },
  a_closed_pregnancy_has_a_closing_time: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A pregnancy that is no longer active carries the moment it closed, and an active one does not.',
  },
  a_danger_sign_needs_a_plan: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'This visit records a danger sign, so it cannot be signed without a plan. Ticking one and signing is the commonest way a stillbirth comes to have a normal antenatal record behind it.',
    nextAction: 'Write what is being done about it — a scan, a cardiotocograph, a same-day review.',
  },
  a_signed_visit_names_its_signer: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A signature has a name and a time, or neither.',
  },
  antenatal_vitals_are_plausible: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'One of those observations is outside what a person has. A systolic below the diastolic is usually two fields swapped, and a fundal height of 5 cm is usually inches.',
  },
  a_schedule_item_status_is_known: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A scheduled item is due, ordered, done, overdue or waived.',
  },
  a_waived_item_says_why: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'Waiving a scheduled item needs a reason. For anti-D that reason is usually that the baby is Rhesus negative — and it is the difference between a decision and an omission.',
  },
  a_registration_runs_forwards: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A PC-PNDT registration ends after it begins.',
  },
  a_gestation_is_a_gestation: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A gestational age by ultrasound runs from 2 to about 43 weeks, in days.',
  },
  a_performed_termination_names_its_method_and_doctor: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A termination that has been performed records the method and the practitioner who performed it.',
  },
  the_epds_is_scored_in_range: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'The Edinburgh scale totals 0 to 30, and each of its ten questions scores 0 to 3.',
  },
  a_postnatal_day_is_after_the_birth: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A postnatal day runs from 0 to 365.',
  },
  uq_pregnancy_anc_no: {
    type: ProblemType.CONFLICT,
    detail: 'That antenatal card number is already in use at this hospital.',
  },
  uq_anc_visit_no: {
    type: ProblemType.CONFLICT,
    detail: 'Two visits were numbered at the same moment. Try again.',
  },
  uq_form_f_per_scan: {
    type: ProblemType.CONFLICT,
    detail:
      'That scan already has a Form F. One scan, one form — which is what makes the register countable.',
  },
  uq_mtp_serial: {
    type: ProblemType.CONFLICT,
    detail: 'Two register entries took the same serial at the same moment. Try again.',
  },
  uq_pcpndt_sonologist: {
    type: ProblemType.CONFLICT,
    detail: 'That registration is already on the centre’s PC-PNDT register.',
  },
  uq_anc_schedule_item: {
    type: ProblemType.CONFLICT,
    detail: 'That item is already on this pregnancy’s schedule.',
  },
  uq_delivery_plan_version: {
    type: ProblemType.CONFLICT,
    detail: 'Two delivery plan versions were written at the same moment. Try again.',
  },
  uq_pnc_visit_day: {
    type: ProblemType.CONFLICT,
    detail: 'A postnatal visit for that day is already recorded.',
  },

  // ── OP-012 / IP-022 ───────────────────────────────────────────────────────
  dry_weight_is_a_weight: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A dry weight runs from 10 to 400 kg. Below that it is usually a decimal point.',
  },
  a_programme_status_is_known: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A dialysis programme is active, transferred, transplanted, recovered, stopped or ended by death.',
  },
  a_prescription_is_deliverable: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'One of those figures is outside what a machine can run: 1–7 sessions a week, 30–720 minutes, a blood flow of 50–600 and a dialysate flow of 100–1000 ml/min, at most 30 uses of a dialyser, and an ultrafiltration ceiling between 1 and 20 ml/kg/hour.',
  },
  the_bath_is_fully_specified: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'The dialysate needs potassium, calcium, sodium and bicarbonate. A bath with a missing figure is one that gets defaulted somewhere downstream, and a potassium chosen for the wrong patient is an arrhythmia on the machine.',
  },
  a_session_ends_after_it_starts: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A session ends after it starts.',
  },
  a_session_disconnects_after_it_connects: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A patient is disconnected after they are connected, not before.',
  },
  one_patient_per_machine: {
    type: ProblemType.CONFLICT,
    detail:
      'That machine already has somebody on it for part of that window. Two patients on one machine is one of them arriving for four hours of treatment and finding a stranger in the chair.',
    nextAction: 'Pick another machine in the same isolation zone, or move the session to a free window.',
  },
  uq_one_live_dialysis_session: {
    type: ProblemType.CONFLICT,
    detail:
      'This patient is already recorded as on a machine. Somebody is either on two at once, or a session from an earlier shift was never closed.',
    nextAction: 'Complete or abort the open session first.',
  },
  an_aborted_session_says_why: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A session that ended early records why. It is a different clinical fact from a cancellation, and it is the one a mortality review reads.',
  },
  a_dialyser_is_named_with_its_use_number: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A dialyser is recorded with the number of the use this was — a label on its own counts nothing.',
  },
  a_use_number_starts_at_one: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'The first use of a dialyser is use 1.',
  },
  a_discarded_dialyser_says_why: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A condemned dialyser records why — the reuse limit, a failed pressure hold, or a cell volume below the floor.',
  },
  total_cell_volume_is_a_percentage: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'Total cell volume is a percentage of the original, from 0 to 120.',
  },
  uq_dialyser_use_no: {
    type: ProblemType.CONFLICT,
    detail: 'That use of that dialyser has already been logged.',
  },
  uq_dialyser_use_session: {
    type: ProblemType.CONFLICT,
    detail:
      'That session already has a dialyser against it. One session uses one filter, and a second would mean the circuit was changed mid-treatment — which is a new session, not a second entry.',
  },
  uq_dialysis_machine_code: {
    type: ProblemType.CONFLICT,
    detail: 'A machine with that code is already registered at this branch.',
  },
  uq_dialysis_prescription_version: {
    type: ProblemType.CONFLICT,
    detail: 'Another prescription version was written for this patient at the same moment. Try again.',
  },
  an_access_status_is_known: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A vascular access is planned, maturing, active, failed or removed.',
  },
  a_blood_pressure_is_a_blood_pressure: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'Systolic runs 40–300, diastolic 20–200, and the systolic is the higher of the two. A pair the wrong way round is usually two fields swapped.',
  },
  uq_one_live_swallow_order: {
    type: ProblemType.CONFLICT,
    detail:
      'This patient already has a live swallow order. Two is a ward with two answers to what they may safely eat, and the one they act on is whichever they happened to read.',
    nextAction: 'Supersede the existing order with the new one, giving a reason.',
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
