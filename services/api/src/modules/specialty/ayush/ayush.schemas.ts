import { queryFlag } from '@vims/contracts';
import { z } from 'zod';

/**
 * Request shapes for OP-037.
 *
 * ── A prescription line has no `system` ─────────────────────────────────────
 *
 * It comes from the consultation, and the consultation's came from the
 * practitioner's council registration. A field here would be a third answer to
 * a question that already has one, and the wrong one would be the one a clinic
 * could type.
 *
 * ── Nor a `scheduleE1` or `heavyMetal` ─────────────────────────────────────
 *
 * Both are the formulary's classification of the medicine, stamped onto the
 * line by a trigger. A prescriber who could clear `heavyMetal` could prescribe
 * a Bhasma for a year.
 *
 * ── Nor a `phase` on a therapy session ─────────────────────────────────────
 *
 * The phase comes from the procedure master. A session that could name its own
 * would name `purva` and walk straight past the oleation rule, which is the
 * one rule in this module that people die without.
 *
 * ── And no `genderMatchOverride` anywhere ──────────────────────────────────
 *
 * The exception to the gender match is a consent id — the patient's own
 * recorded choice. There is no boolean, because a boolean is something an
 * administrator can set.
 */

const uuid = z.string().uuid();

const AYUSH_SYSTEMS = ['ayurveda', 'homoeopathy', 'unani', 'siddha', 'yoga_naturopathy'] as const;

// ── Registrations ───────────────────────────────────────────────────────────

export const registrationSchema = z
  .object({
    practitionerId: uuid,
    system: z.enum(AYUSH_SYSTEMS),
    council: z.enum(['ncism', 'nch', 'state_board']),
    registrationNo: z.string().min(3).max(60),
    validFrom: z.string().date(),
    validTo: z.string().date().optional(),
    /**
     * Reasoned, because this is the one act in the module that could put a
     * patient in front of an unregistered practitioner.
     */
    reason: z.string().min(8).max(2000),
  })
  .refine((v) => v.validTo === undefined || v.validTo >= v.validFrom, {
    message: 'A registration runs forwards.',
    path: ['validTo'],
  })
  .refine((v) => (v.system === 'homoeopathy') === (v.council === 'nch') || v.council === 'state_board', {
    message:
      'Homoeopathy is registered by the National Commission for Homoeopathy; the other four by the National Commission for Indian System of Medicine.',
    path: ['council'],
  });
export type RegistrationRequest = z.infer<typeof registrationSchema>;

export const registrationQuerySchema = z.object({
  practitionerId: uuid.optional(),
  system: z.enum(AYUSH_SYSTEMS).optional(),
  liveOnly: queryFlag().default(false),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type RegistrationQuery = z.infer<typeof registrationQuerySchema>;

// ── Consultations ───────────────────────────────────────────────────────────

export const consultSchema = z.object({
  patientId: uuid,
  encounterId: uuid.optional(),
  practitionerId: uuid,
  /** Checked against a live registration by the database, not by this schema. */
  system: z.enum(AYUSH_SYSTEMS),
  /**
   * Deliberately shapeless. Ashtavidha pareeksha has eight named examinations
   * and Envagai thervu has eight different ones; a column set covering both
   * would be mostly null and entirely unchecked.
   */
  assessment: z.record(z.string(), z.unknown()).default({}),
  plan: z.record(z.string(), z.unknown()).default({}),
  pathyaApathya: z.record(z.string(), z.unknown()).default({}),
  lifestyle: z.record(z.string(), z.unknown()).default({}),
  notes: z.string().max(8000).optional(),
});
export type ConsultRequest = z.infer<typeof consultSchema>;

const diagnosisSchema = z.object({
  /** The Ministry's standardised terminology. Required — an uncoded diagnosis
   *  cannot be counted, exported to ABDM, or audited. */
  namasteCode: z.string().min(1).max(40),
  term: z.string().min(1).max(200),
  icd11Tm2: z.string().max(40).optional(),
  icd10: z.string().max(20).optional(),
  primary: z.boolean().default(false),
});

export const consultUpdateSchema = z.object({
  assessment: z.record(z.string(), z.unknown()).optional(),
  diagnoses: z.array(diagnosisSchema).max(20).optional(),
  plan: z.record(z.string(), z.unknown()).optional(),
  pathyaApathya: z.record(z.string(), z.unknown()).optional(),
  lifestyle: z.record(z.string(), z.unknown()).optional(),
  notes: z.string().max(8000).optional(),
});
export type ConsultUpdateRequest = z.infer<typeof consultUpdateSchema>;

export const consultSignSchema = z.object({
  diagnoses: z.array(diagnosisSchema).min(1).max(20),
});
export type ConsultSignRequest = z.infer<typeof consultSignSchema>;

export const consultQuerySchema = z.object({
  patientId: uuid.optional(),
  system: z.enum(AYUSH_SYSTEMS).optional(),
  unsignedOnly: queryFlag().default(false),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ConsultQuery = z.infer<typeof consultQuerySchema>;

// ── Prescriptions ───────────────────────────────────────────────────────────

export const prescriptionSchema = z
  .object({
    medicineId: uuid,
    dose: z.string().min(1).max(60),
    unit: z.string().min(1).max(20),
    /** Honey, warm water, milk, ghee. In Ayurveda it changes what the medicine
     *  does, so it is part of the prescription rather than an afterthought. */
    anupana: z.string().max(120).optional(),
    kala: z.string().max(60).optional(),
    potency: z.string().max(20).optional(),
    scale: z.enum(['C', 'X', 'LM', 'Q']).optional(),
    repetition: z.string().max(60).optional(),
    durationDays: z.number().int().min(1).max(365),
    /** The liver and kidney monitoring a long heavy-metal course requires. */
    monitoringOrderId: uuid.optional(),
  })
  .refine((v) => (v.potency === undefined) === (v.scale === undefined), {
    message: 'A potency has a scale, or there is neither.',
    path: ['scale'],
  });
export type PrescriptionRequest = z.infer<typeof prescriptionSchema>;

export const medicineSchema = z.object({
  system: z.enum(AYUSH_SYSTEMS),
  code: z.string().min(1).max(80),
  name: z.string().min(1).max(200),
  type: z.enum(['classical', 'proprietary', 'homoeo_remedy', 'raw_drug', 'inhouse']),
  classicalRef: z.record(z.string(), z.unknown()).optional(),
  form: z.string().max(40).optional(),
  manufacturer: z.string().max(200).optional(),
  licenceNo: z.string().max(60).optional(),
  /**
   * Only reachable when a medicine is first created. The column-level grant
   * refuses an update to either, so a hospital cannot clear `heavyMetal` on a
   * Bhasma it has already listed.
   */
  scheduleE1: z.boolean().default(false),
  heavyMetal: z.boolean().default(false),
  contraindications: z.array(z.unknown()).default([]),
  interactions: z.array(z.unknown()).default([]),
});
export type MedicineRequest = z.infer<typeof medicineSchema>;

export const medicineQuerySchema = z.object({
  consultId: uuid.optional(),
  system: z.enum(AYUSH_SYSTEMS).optional(),
  q: z.string().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type MedicineQuery = z.infer<typeof medicineQuerySchema>;

// ── Courses and therapy ─────────────────────────────────────────────────────

const planDaySchema = z.object({
  day: z.number().int().min(1).max(120),
  code: z.string().min(1).max(80),
  note: z.string().max(300).optional(),
});

export const courseSchema = z.object({
  patientId: uuid,
  consultId: uuid,
  admissionId: uuid.optional(),
  system: z.enum(AYUSH_SYSTEMS),
  name: z.string().min(3).max(200),
  planDays: z.array(planDaySchema).min(1).max(200),
  startDate: z.string().date(),
});
export type CourseRequest = z.infer<typeof courseSchema>;

export const courseUpdateSchema = z
  .object({
    consentId: uuid.optional(),
    status: z.enum(['planned', 'consented', 'in_progress', 'completed', 'aborted']).optional(),
    endDate: z.string().date().optional(),
    abortReason: z.string().min(8).max(2000).optional(),
  })
  .refine((v) => v.status !== 'aborted' || v.abortReason !== undefined, {
    message: 'An aborted course says why.',
    path: ['abortReason'],
  });
export type CourseUpdateRequest = z.infer<typeof courseUpdateSchema>;

export const courseQuerySchema = z.object({
  patientId: uuid.optional(),
  openOnly: queryFlag().default(false),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type CourseQuery = z.infer<typeof courseQuerySchema>;

export const sessionScheduleSchema = z.object({
  dayNo: z.number().int().min(1).max(120),
  procedureCode: z.string().min(1).max(80),
  roomId: uuid.optional(),
});
export type SessionScheduleRequest = z.infer<typeof sessionScheduleSchema>;

export const sessionLogSchema = z
  .object({
    therapistIds: z.array(uuid).max(6).default([]),
    /** The genders of the people who performed it, matched against the
     *  patient's by the database. */
    therapistGenders: z
      .array(z.enum(['male', 'female', 'other']))
      .max(6)
      .default([]),
    /** The patient's own recorded choice to proceed without a match. A consent
     *  id and not a boolean, because a boolean is something an administrator
     *  can set. */
    genderWaiverConsentId: uuid.optional(),
    prechecks: z.record(z.string(), z.unknown()),
    medicinesUsed: z.array(z.unknown()).default([]),
    params: z.record(z.string(), z.unknown()).default({}),
    lakshana: z.enum(['samyak', 'ayoga', 'atiyoga']).optional(),
    adverseEvent: z.string().min(4).max(2000).optional(),
    tolerance: z.string().max(40).optional(),
    postAdvice: z.string().max(2000).optional(),
    performedAt: z.string(),
  })
  .refine((v) => v.therapistIds.length === v.therapistGenders.length, {
    message: 'A therapist list and a gender list describe the same people.',
    path: ['therapistGenders'],
  });
export type SessionLogRequest = z.infer<typeof sessionLogSchema>;

export const sessionSkipSchema = z.object({
  skipReason: z.string().min(4).max(2000),
});
export type SessionSkipRequest = z.infer<typeof sessionSkipSchema>;

export const sessionReviewSchema = z.object({
  reviewNote: z.string().min(4).max(4000),
});
export type SessionReviewRequest = z.infer<typeof sessionReviewSchema>;
