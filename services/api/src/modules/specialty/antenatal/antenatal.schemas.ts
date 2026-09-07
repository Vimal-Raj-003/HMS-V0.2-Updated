import { queryFlag } from '@vims/contracts';
import { z } from 'zod';

/**
 * Request shapes for OP-040.
 *
 * ── There is no field for the sex of a foetus ───────────────────────────────
 *
 * Not in a request, not in a response, not in a column. The PC-PNDT Act exists
 * because sex-selective abortion removed tens of millions of girls from the
 * Indian population, and it is enforced by inspecting records. A field that
 * exists is a field that can be filled, whatever guards it — and the migration
 * asserts the absence across every antenatal table so that a future one that
 * adds a column fails at deployment rather than at an inspection.
 *
 * ── And no `gaWeeks`, no `workingEdd`, no `mtpSerial`, no `category` ────────
 *
 * The gestational age is the working date and today. The working date is
 * Naegele's rule superseded by an early scan. The MTP serial is one more than
 * the last one, and the MTP category is the gestation. Each is the number a
 * rule is a line on, and a clinic that could type its own would type the one
 * that clears the line.
 *
 * The one exception is `overrideEdd`, which is a separate route behind a `high`
 * key with a mandatory rationale — because two scans four weeks apart can
 * genuinely disagree and a clinician who has looked at both is entitled to
 * decide. It marks the dating `clinical` so every later reader knows it is soft.
 */

const uuid = z.string().uuid();

export const pregnancySchema = z
  .object({
    patientId: uuid,
    ancNo: z.string().min(1).max(32),
    /** One of these two is required; the database says so and so does the refine. */
    lmp: z.string().date().optional(),
    lmpCertain: z.boolean().default(false),
    cycleDays: z.number().int().min(20).max(45).default(28),
    usgDating: z
      .object({
        scanDate: z.string().date(),
        gaDaysAtScan: z.number().int().min(1).max(300),
        crlMm: z.number().optional(),
        studyRef: z.string().max(120).optional(),
      })
      .optional(),
    gravida: z.number().int().min(1).max(30),
    para: z.number().int().min(0).max(30).default(0),
    living: z.number().int().min(0).max(30).default(0),
    abortions: z.number().int().min(0).max(30).default(0),
    ectopic: z.number().int().min(0).max(30).default(0),
    obstetricHistory: z.array(z.record(z.string(), z.unknown())).max(30).default([]),
    medicalHistory: z.record(z.string(), z.unknown()).default({}),
    bookingBmi: z.number().min(10).max(80).optional(),
    bloodGroup: z.string().max(8).optional(),
    /** The single most consequential field here, and the harm lands on the next baby. */
    rhNegative: z.boolean().optional(),
    rchId: z.string().max(32).optional(),
    pmsma: z.boolean().default(false),
    scheme: z.enum(['jsy', 'jssk', 'pmjay', 'none']).default('none'),
  })
  .refine((v) => v.lmp !== undefined || v.usgDating !== undefined, {
    message: 'A pregnancy needs a last menstrual period or a dating scan.',
  });
export type PregnancyRequest = z.infer<typeof pregnancySchema>;

export const pregnancyUpdateSchema = z
  .object({
    lmp: z.string().date().optional(),
    lmpCertain: z.boolean().optional(),
    cycleDays: z.number().int().min(20).max(45).optional(),
    usgDating: z
      .object({
        scanDate: z.string().date(),
        gaDaysAtScan: z.number().int().min(1).max(300),
        crlMm: z.number().optional(),
        studyRef: z.string().max(120).optional(),
      })
      .optional(),
    bloodGroup: z.string().max(8).optional(),
    rhNegative: z.boolean().optional(),
    bookingBmi: z.number().min(10).max(80).optional(),
    riskCategory: z.enum(['low', 'moderate', 'high']).optional(),
    riskFlags: z.array(z.record(z.string(), z.unknown())).max(40).optional(),
    status: z
      .enum(['active', 'delivered', 'aborted', 'mtp', 'ectopic', 'transferred', 'lost_to_followup'])
      .optional(),
    outcome: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change.' });
export type PregnancyUpdateRequest = z.infer<typeof pregnancyUpdateSchema>;

/** The documented way past the dating derivation. */
export const eddOverrideSchema = z.object({
  workingEdd: z.string().date(),
  rationale: z.string().min(8).max(2000),
});
export type EddOverrideRequest = z.infer<typeof eddOverrideSchema>;

export const visitSchema = z.object({
  encounterId: uuid.optional(),
  visitedAt: z.string().optional(),
  complaints: z.record(z.string(), z.unknown()).default({}),
  /**
   * Bleeding, leaking, headache, visual disturbance, epigastric pain, reduced
   * movements, fever. Any one of them means the visit cannot be signed without
   * a plan.
   */
  dangerSigns: z
    .array(
      z.enum([
        'bleeding',
        'leaking',
        'headache',
        'visual_disturbance',
        'epigastric_pain',
        'reduced_fetal_movements',
        'fever',
        'convulsions',
        'breathlessness',
      ]),
    )
    .max(9)
    .default([]),
  bpSys: z.number().int().min(50).max(300).optional(),
  bpDia: z.number().int().min(20).max(200).optional(),
  bpSysRight: z.number().int().min(50).max(300).optional(),
  bpDiaRight: z.number().int().min(20).max(200).optional(),
  pulse: z.number().int().min(20).max(250).optional(),
  respRate: z.number().int().min(4).max(60).optional(),
  temperatureC: z.number().min(30).max(45).optional(),
  consciousness: z.enum(['alert', 'voice', 'pain', 'unresponsive']).optional(),
  weightKg: z.number().min(25).max(250).optional(),
  pallor: z.string().max(16).optional(),
  oedema: z.string().max(16).optional(),
  urineAlbumin: z.string().max(16).optional(),
  urineSugar: z.string().max(16).optional(),
  sfhCm: z.number().min(8).max(55).optional(),
  lie: z.string().max(24).optional(),
  presentation: z.string().max(24).optional(),
  engagement: z.string().max(24).optional(),
  fhr: z.number().int().min(50).max(240).optional(),
  fetalMovements: z.string().max(24).optional(),
  exam: z.record(z.string(), z.unknown()).default({}),
  supplements: z.record(z.string(), z.unknown()).default({}),
  immunisation: z.record(z.string(), z.unknown()).default({}),
  counselling: z.array(z.string().max(80)).max(20).default([]),
  plan: z.string().max(4000).optional(),
  nextVisitAt: z.string().date().optional(),
});
export type VisitRequest = z.infer<typeof visitSchema>;

export const scheduleItemSchema = z.object({
  kind: z.enum(['visit', 'lab', 'usg', 'vaccine', 'supplement', 'anti_d']),
  code: z.string().min(1).max(40),
  name: z.string().min(1).max(120),
  dueGaWeeks: z.number().int().min(0).max(45),
});
export type ScheduleItemRequest = z.infer<typeof scheduleItemSchema>;

export const scheduleUpdateSchema = z.object({
  status: z.enum(['due', 'ordered', 'done', 'overdue', 'waived']),
  orderId: uuid.optional(),
  resultSummary: z.record(z.string(), z.unknown()).optional(),
  /** Required to waive. Anti-D is waived with a reason, never quietly skipped. */
  waivedReason: z.string().min(4).max(200).optional(),
});
export type ScheduleUpdateRequest = z.infer<typeof scheduleUpdateSchema>;

export const deliveryPlanSchema = z.object({
  plannedMode: z.enum(['vaginal', 'vbac', 'planned_lscs']),
  indication: z.string().max(2000).optional(),
  plannedDate: z.string().date().optional(),
  place: z.string().max(120).optional(),
  pacId: uuid.optional(),
  bloodRequestId: uuid.optional(),
  admissionBookingId: uuid.optional(),
  consents: z.record(z.string(), z.unknown()).default({}),
  newbornPlan: z.record(z.string(), z.unknown()).default({}),
  birthCompanion: z.string().max(120).optional(),
  transport: z.string().max(120).optional(),
});
export type DeliveryPlanRequest = z.infer<typeof deliveryPlanSchema>;

export const formFSchema = z.object({
  scanOrderId: uuid,
  patientId: uuid,
  pregnancyId: uuid.optional(),
  machineId: uuid,
  centreRegNo: z.string().min(1).max(60),
  sonologistId: uuid,
  referringDoctor: z.string().min(1).max(160),
  indicationCode: z.string().min(1).max(40),
  resultSummary: z.string().max(4000).optional(),
});
export type FormFRequest = z.infer<typeof formFSchema>;

/**
 * Signing needs both declarations, and each has to actually have been made.
 * They are the whole point of the form: the woman's that she was not told the
 * sex of the foetus, and the sonologist's that it was not disclosed.
 */
export const formFSignSchema = z.object({
  patientAttested: z.literal(true),
  sonologistAttested: z.literal(true),
  patientSignatureRef: z.string().max(200).optional(),
  resultSummary: z.string().max(4000).optional(),
});
export type FormFSignRequest = z.infer<typeof formFSignSchema>;

export const sonologistSchema = z.object({
  userId: uuid,
  registrationNo: z.string().min(1).max(60),
  qualification: z.string().min(1).max(120),
  validFrom: z.string().date(),
  validTo: z.string().date().optional(),
  reason: z.string().min(8).max(2000),
});
export type SonologistRequest = z.infer<typeof sonologistSchema>;

/**
 * A termination under the MTP Act.
 *
 * There is no `category` — it is the gestation. There is no `mtpSerial` — it is
 * one more than the last. And there is no spousal consent, because none has any
 * standing under the Act and a field for one would invite the practice the Act
 * removed.
 */
export const mtpSchema = z.object({
  patientId: uuid,
  pregnancyId: uuid.optional(),
  /** By ultrasound, not by dates. Every gate turns on it. */
  gaDaysByUsg: z.number().int().min(14).max(300),
  grounds: z
    .enum([
      'rape',
      'incest',
      'minor',
      'change_of_marital_status',
      'physical_disability',
      'mental_illness',
      'foetal_anomaly',
      'humanitarian',
      'contraceptive_failure',
      'risk_to_life',
    ])
    .optional(),
  minor: z.boolean().default(false),
  guardianConsentId: uuid.optional(),
  /** One below twenty weeks, two different doctors from twenty to twenty-four. */
  opinionIds: z.array(uuid).max(4).default([]),
  formCConsentId: uuid,
  /** Beyond twenty-four weeks there is no other route. */
  medicalBoardRef: z.string().max(120).optional(),
  reason: z.string().min(8).max(2000),
});
export type MtpRequest = z.infer<typeof mtpSchema>;

export const mtpPerformSchema = z.object({
  method: z.enum(['medical', 'mva', 'eva', 'de', 'other']),
  regimen: z.record(z.string(), z.unknown()).default({}),
  procedureId: uuid.optional(),
  complications: z.array(z.record(z.string(), z.unknown())).max(20).default([]),
  /** Rhesus-negative women need anti-D after a termination too, and it is
   *  forgotten more often here than after a birth. */
  antiDGiven: z.boolean().default(false),
  contraception: z.record(z.string(), z.unknown()).default({}),
});
export type MtpPerformRequest = z.infer<typeof mtpPerformSchema>;

export const pncSchema = z.object({
  dayNo: z.number().int().min(0).max(365),
  visitedAt: z.string().optional(),
  findings: z.record(z.string(), z.unknown()).default({}),
  bpSys: z.number().int().min(50).max(300).optional(),
  bpDia: z.number().int().min(20).max(200).optional(),
  epdsTotal: z.number().int().min(0).max(30).optional(),
  /** Scored separately because the tenth question is about self-harm. */
  epdsItem10: z.number().int().min(0).max(3).optional(),
  breastfeeding: z.string().max(40).optional(),
  contraception: z.record(z.string(), z.unknown()).default({}),
  referral: z.string().max(2000).optional(),
});
export type PncRequest = z.infer<typeof pncSchema>;

export const pregnancyQuerySchema = z.object({
  patientId: uuid.optional(),
  activeOnly: queryFlag().default(false),
  highRiskOnly: queryFlag().default(false),
  rhNegativeOnly: queryFlag().default(false),
  dueThisWeek: queryFlag().default(false),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type PregnancyQuery = z.infer<typeof pregnancyQuerySchema>;

export const scheduleQuerySchema = z.object({
  pregnancyId: uuid.optional(),
  overdueOnly: queryFlag().default(false),
  kind: z.enum(['visit', 'lab', 'usg', 'vaccine', 'supplement', 'anti_d']).optional(),
  limit: z.coerce.number().int().min(1).max(300).default(200),
});
export type ScheduleQuery = z.infer<typeof scheduleQuerySchema>;

export const mtpQuerySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/u)
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type MtpQuery = z.infer<typeof mtpQuerySchema>;
