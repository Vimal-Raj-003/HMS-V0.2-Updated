import { queryFlag } from '@vims/contracts';
import { z } from 'zod';

/**
 * Request shapes for OP-012 and IP-022.
 *
 * ── There is no `isolationZone` field ───────────────────────────────────────
 *
 * The zone is computed from the serology by the database, and it is the one
 * control standing between a hepatitis-positive patient and the four people who
 * use that chair after them. A field a clerk can type is a field a clerk can
 * type wrongly, and this particular typo is a cohort. The proof it cannot be
 * overridden is that nothing in this file can express it.
 *
 * ── And no `ufRateMlKgH` ────────────────────────────────────────────────────
 *
 * The rate is the goal over the hours over the dry weight, and every fluid
 * ceiling in dialysis is a line on it. A unit that could type its own rate
 * would type the one that stays under the line.
 *
 * `ufGoalL` *is* here, and deliberately: a patient who is already hypotensive
 * is pulled less than dry weight on purpose, and a console that could not
 * express that would be forcing the harm it exists to prevent. What the
 * database refuses is the other direction.
 *
 * ── And no `useNo` on a dialyser ────────────────────────────────────────────
 *
 * The use number is one more than the last one logged, and it is the number the
 * whole of reuse safety rests on. Letting the floor supply it puts the count
 * back on the strip of tape.
 */

const uuid = z.string().uuid();

export const programSchema = z.object({
  patientId: uuid,
  modality: z.enum(['hd', 'hdf', 'sled', 'pd_capd', 'pd_apd']),
  aetiologyIcd10: z.string().max(16).optional(),
  startDate: z.string().date(),
  dryWeightKg: z.number().min(10).max(400),
  /**
   * `{hbsag, hcv, hiv, testedAt}`. All three results and the date are required
   * — the zone is computed from all of them, and a serology with no date is a
   * zone nobody can vouch for.
   */
  viralStatus: z.object({
    hbsag: z.boolean(),
    hcv: z.boolean(),
    hiv: z.boolean(),
    testedAt: z.string(),
  }),
  bloodGroup: z.string().max(8).optional(),
  nephrologistId: uuid.optional(),
  transportNeeded: z.boolean().default(false),
  notes: z.string().max(4000).optional(),
});
export type ProgramRequest = z.infer<typeof programSchema>;

export const programUpdateSchema = z
  .object({
    dryWeightKg: z.number().min(10).max(400).optional(),
    viralStatus: z
      .object({ hbsag: z.boolean(), hcv: z.boolean(), hiv: z.boolean(), testedAt: z.string() })
      .optional(),
    nephrologistId: uuid.optional(),
    transportNeeded: z.boolean().optional(),
    status: z.enum(['active', 'transferred', 'transplanted', 'recovered', 'stopped', 'died']).optional(),
    notes: z.string().max(4000).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change.' });
export type ProgramUpdateRequest = z.infer<typeof programUpdateSchema>;

export const accessSchema = z.object({
  programId: uuid,
  type: z.enum(['avf', 'avg', 'tunnelled_catheter', 'non_tunnelled_catheter', 'pd_catheter']),
  site: z.string().min(2).max(80),
  side: z.enum(['left', 'right', 'bilateral', 'not_applicable']).default('not_applicable'),
  createdOn: z.string().date().optional(),
  createdBySurgeon: uuid.optional(),
  status: z.enum(['planned', 'maturing', 'active', 'failed', 'removed']).default('maturing'),
});
export type AccessRequest = z.infer<typeof accessSchema>;

export const accessUpdateSchema = z.object({
  /**
   * Moving an access to `active` is what permits it to be cannulated, and
   * cannulating a fistula that has not matured destroys it — so it is a
   * separate key from running the machine.
   */
  status: z.enum(['planned', 'maturing', 'active', 'failed', 'removed']),
  complications: z.array(z.record(z.string(), z.unknown())).max(20).default([]),
});
export type AccessUpdateRequest = z.infer<typeof accessUpdateSchema>;

export const prescriptionSchema = z.object({
  programId: uuid,
  frequencyPerWeek: z.number().int().min(1).max(7),
  durationMin: z.number().int().min(30).max(720),
  dialyserItemId: uuid.optional(),
  dialyserMaxUses: z.number().int().min(1).max(30).default(1),
  qb: z.number().int().min(50).max(600),
  qd: z.number().int().min(100).max(1000),
  dialysate: z.object({
    k: z.number(),
    ca: z.number(),
    na: z.number(),
    hco3: z.number(),
    tempC: z.number().optional(),
  }),
  /**
   * The ultrafiltration ceiling, in millilitres per kilogram per hour. This is
   * where a faster rate is authorised when one is genuinely needed — an
   * isolated ultrafiltration for pulmonary oedema — and doing it here makes it
   * a versioned prescribing act with an author rather than a click at the
   * chair.
   */
  ufMaxRateMlKgH: z.number().min(1).max(20).default(13),
  heparin: z.record(z.string(), z.unknown()).default({}),
  anticoagMode: z.enum(['heparin', 'lmwh', 'citrate', 'heparin_free', 'saline_flush']).default('heparin'),
  epoPlan: z.record(z.string(), z.unknown()).default({}),
  ironPlan: z.record(z.string(), z.unknown()).default({}),
  targetKtv: z.number().min(0.5).max(3).optional(),
  effectiveFrom: z.string().date(),
});
export type PrescriptionRequest = z.infer<typeof prescriptionSchema>;

export const machineSchema = z.object({
  code: z.string().min(1).max(40),
  model: z.string().max(120).optional(),
  serial: z.string().max(80).optional(),
  assetId: uuid.optional(),
  zone: z.enum(['general', 'hbv', 'hcv', 'hiv']),
});
export type MachineRequest = z.infer<typeof machineSchema>;

export const machineStatusSchema = z.object({
  status: z.enum(['available', 'in_use', 'disinfecting', 'maintenance', 'breakdown']),
  lastDisinfection: z.record(z.string(), z.unknown()).optional(),
  hoursRun: z.number().int().min(0).max(200000).optional(),
  lastServiceAt: z.string().optional(),
  nextServiceDueAt: z.string().optional(),
});
export type MachineStatusRequest = z.infer<typeof machineStatusSchema>;

/**
 * Re-zoning is its own route because it is its own decision. It is refused
 * outright while the machine holds a booking, and the reason goes to audit.
 */
export const machineRezoneSchema = z.object({
  zone: z.enum(['general', 'hbv', 'hcv', 'hiv']),
  reason: z.string().min(12).max(2000),
});
export type MachineRezoneRequest = z.infer<typeof machineRezoneSchema>;

export const sessionSchema = z.object({
  programId: uuid,
  machineId: uuid.optional(),
  chairNo: z.string().max(16).optional(),
  admissionId: uuid.optional(),
  prescriptionId: uuid.optional(),
  scheduledAt: z.string(),
  scheduledEnd: z.string().optional(),
  shift: z.enum(['morning', 'afternoon', 'evening', 'night']).optional(),
});
export type SessionRequest = z.infer<typeof sessionSchema>;

export const sessionUpdateSchema = z
  .object({
    status: z.enum(['scheduled', 'checked_in', 'on_machine', 'completed', 'no_show', 'cancelled']).optional(),
    machineId: uuid.nullable().optional(),
    accessId: uuid.optional(),
    preWeightKg: z.number().min(10).max(400).optional(),
    pre: z.record(z.string(), z.unknown()).optional(),
    ufGoalL: z.number().min(0).max(15).optional(),
    connectAt: z.string().optional(),
    disconnectAt: z.string().optional(),
    postWeightKg: z.number().min(10).max(400).optional(),
    post: z.record(z.string(), z.unknown()).optional(),
    actualUfL: z.number().min(0).max(15).optional(),
    dialyserLabel: z.string().max(60).optional(),
    dialyserUseNo: z.number().int().min(1).max(30).optional(),
    complications: z.array(z.record(z.string(), z.unknown())).max(30).optional(),
    medsGiven: z.array(z.record(z.string(), z.unknown())).max(50).optional(),
    adequacyLabs: z.record(z.string(), z.unknown()).optional(),
    technicianId: uuid.optional(),
    nurseId: uuid.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change.' });
export type SessionUpdateRequest = z.infer<typeof sessionUpdateSchema>;

/** Ending a session early is a different clinical fact, so it is its own route. */
export const abortSchema = z.object({
  reason: z.string().min(4).max(2000),
  actualUfL: z.number().min(0).max(15).optional(),
  postWeightKg: z.number().min(10).max(400).optional(),
  complications: z.array(z.record(z.string(), z.unknown())).max(30).default([]),
});
export type AbortRequest = z.infer<typeof abortSchema>;

export const observationSchema = z.object({
  recordedAt: z.string().optional(),
  systolic: z.number().int().min(40).max(300).optional(),
  diastolic: z.number().int().min(20).max(200).optional(),
  pulse: z.number().int().min(20).max(250).optional(),
  temperatureC: z.number().min(30).max(45).optional(),
  qb: z.number().int().min(0).max(600).optional(),
  qd: z.number().int().min(0).max(1000).optional(),
  arterialMmhg: z.number().int().min(-400).max(400).optional(),
  venousMmhg: z.number().int().min(-400).max(400).optional(),
  tmpMmhg: z.number().int().min(-400).max(600).optional(),
  ufRemovedL: z.number().min(0).max(15).optional(),
  ufRateLh: z.number().min(0).max(5).optional(),
  conductivity: z.number().min(10).max(20).optional(),
  symptoms: z.array(z.record(z.string(), z.unknown())).max(20).default([]),
  intervention: z.string().max(2000).optional(),
});
export type ObservationRequest = z.infer<typeof observationSchema>;

export const dialyserSchema = z.object({
  programId: uuid,
  label: z.string().min(1).max(60),
  itemId: uuid.optional(),
  sessionId: uuid.optional(),
});
export type DialyserRequest = z.infer<typeof dialyserSchema>;

export const reprocessSchema = z.object({
  tcvPct: z.number().min(0).max(120),
  integrityOk: z.boolean(),
  chemical: z.string().max(60).optional(),
});
export type ReprocessRequest = z.infer<typeof reprocessSchema>;

export const discardSchema = z.object({
  reason: z.string().min(3).max(80),
});
export type DiscardRequest = z.infer<typeof discardSchema>;

export const programQuerySchema = z.object({
  patientId: uuid.optional(),
  zone: z.enum(['general', 'hbv', 'hcv', 'hiv']).optional(),
  activeOnly: queryFlag().default(false),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type ProgramQuery = z.infer<typeof programQuerySchema>;

export const sessionQuerySchema = z.object({
  programId: uuid.optional(),
  patientId: uuid.optional(),
  machineId: uuid.optional(),
  on: z.string().date().optional(),
  liveOnly: queryFlag().default(false),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type SessionQuery = z.infer<typeof sessionQuerySchema>;

export const dialyserQuerySchema = z.object({
  programId: uuid.optional(),
  label: z.string().max(60).optional(),
  usableOnly: queryFlag().default(false),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type DialyserQuery = z.infer<typeof dialyserQuerySchema>;
