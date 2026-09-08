import { queryFlag } from '@vims/contracts';
import { z } from 'zod';

/**
 * Request shapes for OP-018, OP-021 and IP-020.
 *
 * ── There is no `listCode` on a prescription line ───────────────────────────
 *
 * Which of the four lists a drug belongs to is a fact about the drug, held in
 * `mdm.telemedicine_drug_rules` and stamped onto the line by a trigger at the
 * moment of prescribing. A request field would be a doctor asserting the list,
 * which is the one thing the Guidelines do not let anybody do.
 *
 * ── Nor a `replyDueAt` on a referral ───────────────────────────────────────
 *
 * The date a reply is due follows from the urgency: four hours, forty-eight
 * hours, fourteen days. Letting the referrer set it would make every emergency
 * referral due whenever the referrer felt like being told.
 *
 * ── Nor an `adherencePct` on a pathway ─────────────────────────────────────
 *
 * It is counted from the step records. A settable adherence figure is a
 * hospital's own audit reporting on itself.
 */

const uuid = z.string().uuid();

// ── OP-018, telemedicine ────────────────────────────────────────────────────

export const teleConsultSchema = z
  .object({
    patientId: uuid,
    practitionerId: uuid,
    /** The register the Guidelines make the doctor's credential. */
    practitionerRegNo: z.string().min(3).max(60),
    mode: z.enum(['video', 'audio', 'text']),
    firstConsult: z.boolean().default(true),
    followsConsultId: uuid.optional(),
    initiatedBy: z.enum(['patient', 'practitioner', 'caregiver', 'health_worker']).default('patient'),
    consentId: uuid.optional(),
    /**
     * How the patient in front of the camera was shown to be the patient in the
     * record. Free-shaped because the methods differ — ABHA, a government ID
     * held up, a known caregiver — but not optional: a prescription to an
     * unverified patient is a prescription to somebody unknown.
     */
    identityVerification: z.record(z.string(), z.unknown()),
    startedAt: z.string(),
    complaint: z.string().max(4000).optional(),
  })
  .refine((v) => v.firstConsult || v.followsConsultId !== undefined, {
    message: 'A follow-up says what it follows.',
    path: ['followsConsultId'],
  })
  .refine((v) => v.initiatedBy === 'patient' || v.consentId !== undefined, {
    message: 'A consultation the patient did not start needs consent recorded against it.',
    path: ['consentId'],
  });
export type TeleConsultRequest = z.infer<typeof teleConsultSchema>;

export const teleConsultCloseSchema = z.object({
  endedAt: z.string().optional(),
  advice: z.string().max(8000).optional(),
  /** The honest outcome when the lists refuse: see them. */
  referredInPerson: z.boolean().optional(),
});
export type TeleConsultCloseRequest = z.infer<typeof teleConsultCloseSchema>;

export const telePrescriptionSchema = z.object({
  drugKey: z.string().min(1).max(80),
  drugName: z.string().min(1).max(200),
  dose: z.string().min(1).max(80),
  frequency: z.string().min(1).max(80),
  /**
   * The Guidelines make a tele-prescription a bounded course. Ninety days is
   * the ceiling; the database holds the same number.
   */
  durationDays: z.number().int().min(1).max(90),
});
export type TelePrescriptionRequest = z.infer<typeof telePrescriptionSchema>;

export const teleQuerySchema = z.object({
  patientId: uuid.optional(),
  mode: z.enum(['video', 'audio', 'text']).optional(),
  openOnly: queryFlag().default(false),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type TeleQuery = z.infer<typeof teleQuerySchema>;

// ── OP-021, referrals ───────────────────────────────────────────────────────

export const referralSchema = z
  .object({
    patientId: uuid,
    encounterId: uuid,
    toDepartmentKey: uuid.optional(),
    toPractitionerKey: uuid.optional(),
    externalFacility: z.string().max(300).optional(),
    urgency: z.enum(['routine', 'urgent', 'emergency']).default('routine'),
    reason: z.string().min(8).max(4000),
    sharedNote: z.string().max(8000).optional(),
  })
  .refine(
    (v) =>
      v.toDepartmentKey !== undefined ||
      v.toPractitionerKey !== undefined ||
      v.externalFacility !== undefined,
    { message: 'A referral goes somewhere.', path: ['toDepartmentKey'] },
  );
export type ReferralRequest = z.infer<typeof referralSchema>;

export const referralReplySchema = z.object({
  /** Four characters is not a bar; "ok" is. */
  replyText: z.string().min(4).max(8000),
  targetVisitId: uuid.optional(),
  /** Closing follows the reply, in the same call, because the two are one act. */
  close: z.boolean().default(false),
});
export type ReferralReplyRequest = z.infer<typeof referralReplySchema>;

export const referralCancelSchema = z.object({
  reason: z.string().min(8).max(2000),
});
export type ReferralCancelRequest = z.infer<typeof referralCancelSchema>;

export const referralQuerySchema = z.object({
  patientId: uuid.optional(),
  urgency: z.enum(['routine', 'urgent', 'emergency']).optional(),
  /** The list the module exists to produce. */
  overdueOnly: queryFlag().default(false),
  awaitingReplyOnly: queryFlag().default(false),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ReferralQuery = z.infer<typeof referralQuerySchema>;

// ── IP-020, clinical pathways ───────────────────────────────────────────────

const pathwayStepDefinition = z.object({
  key: z.string().min(1).max(80),
  day: z.number().int().min(0).max(120),
  label: z.string().max(200).optional(),
});

export const pathwaySchema = z.object({
  patientId: uuid,
  admissionId: uuid.optional(),
  pathwayKey: z.string().min(1).max(80),
  pathwayName: z.string().min(1).max(200),
  version: z.number().int().min(1).default(1),
  steps: z.array(pathwayStepDefinition).min(1).max(200),
  startedAt: z.string(),
});
export type PathwayRequest = z.infer<typeof pathwaySchema>;

export const pathwayStepSchema = z
  .object({
    stepKey: z.string().min(1).max(80),
    dayNo: z.number().int().min(0).max(120),
    outcome: z.enum(['done', 'varied', 'not_applicable']),
    doneAt: z.string().optional(),
    varianceReason: z.string().min(4).max(2000).optional(),
    /**
     * Four categories, and which one is the point. Three of them are the
     * hospital's problem and one is not, and a free-text field would collapse
     * that distinction into prose nobody counts.
     */
    varianceCategory: z.enum(['clinical', 'patient', 'system', 'resource']).optional(),
  })
  .refine((v) => v.outcome !== 'done' || v.doneAt !== undefined, {
    message: 'A completed step says when.',
    path: ['doneAt'],
  })
  .refine(
    (v) => v.outcome !== 'varied' || (v.varianceReason !== undefined && v.varianceCategory !== undefined),
    { message: 'A variance carries a reason and one of the four categories.', path: ['varianceCategory'] },
  );
export type PathwayStepRequest = z.infer<typeof pathwayStepSchema>;

export const pathwayQuerySchema = z.object({
  patientId: uuid.optional(),
  pathwayKey: z.string().max(80).optional(),
  openOnly: queryFlag().default(false),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type PathwayQuery = z.infer<typeof pathwayQuerySchema>;
