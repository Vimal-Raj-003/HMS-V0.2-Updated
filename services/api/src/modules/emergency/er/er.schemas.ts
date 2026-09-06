import { z } from 'zod';

/** OP-006 request contracts. */
const uuid = z.string().uuid();

export const idSchema = uuid;
export const pageLimit = z.coerce.number().int().min(1).max(200).default(100);

export const ARRIVAL_MODES = [
  'walk_in',
  'ambulance',
  'police',
  'referred',
  'transfer',
  'mci',
  'brought_dead',
] as const;
export const VISIT_STATUSES = [
  'inbound',
  'arrived',
  'triaged',
  'in_treatment',
  'boarding',
  'disposition_pending',
  'departed',
] as const;
export const ZONE_KINDS = [
  'resus',
  'acute',
  'fast_track',
  'observation',
  'paediatric',
  'isolation',
  'decontamination',
  'triage',
  'waiting',
] as const;
export const BAY_KINDS = [
  'resus_bay',
  'trolley',
  'chair',
  'wheelchair',
  'cubicle',
  'isolation_room',
] as const;
export const DISPOSITION_KINDS = [
  'admit',
  'discharge',
  'refer_out',
  'lama',
  'absconded',
  'death',
  'observation',
  'brought_dead',
] as const;

export const boardQuerySchema = z.object({
  status: z.enum(VISIT_STATUSES).optional(),
  zoneId: uuid.optional(),
  /** Default false: the board is about who is here now, not the day's history. */
  includeDeparted: z.coerce.boolean().default(false),
  limit: pageLimit,
});
export type BoardQuery = z.infer<typeof boardQuerySchema>;

/**
 * Quick registration — the thirty-second path.
 *
 * Everything is optional except how they arrived. A patient who cannot speak
 * gets `Unknown male, approx 40` and a tag; the desk fills in the rest later.
 * Requiring anything more here would be requiring it of somebody on a trolley.
 */
export const quickRegSchema = z.object({
  arrivalMode: z.enum(ARRIVAL_MODES),
  /** Supply this when the patient is already known to the hospital. */
  patientId: uuid.optional(),
  /** Otherwise a tag is allocated automatically. */
  displayName: z.string().trim().max(200).optional(),
  approximateAge: z.coerce.number().int().min(0).max(130).optional(),
  gender: z.enum(['male', 'female', 'other', 'unknown']).optional(),
  chiefComplaint: z.string().trim().max(2000).optional(),
  broughtBy: z.string().trim().max(200).optional(),
  broughtByPhone: z.string().trim().max(20).optional(),
  mlcSuspected: z.boolean().default(false),
  ambulanceRef: z.string().trim().max(40).optional(),
  /** Assign a bay in the same call, so the trolley is allocated at the door. */
  bayId: uuid.optional(),
});
export type QuickRegRequest = z.infer<typeof quickRegSchema>;

/**
 * An ambulance pre-alert (TR-009 §6.11).
 *
 * Creates the inbound record so a bay can be held and, if the criteria fire, a
 * team paged before the patient is through the door.
 */
export const preAlertSchema = z.object({
  expectedAt: z.string().datetime({ offset: true }),
  ambulanceRef: z.string().trim().max(40).optional(),
  displayName: z.string().trim().max(200).optional(),
  approximateAge: z.coerce.number().int().min(0).max(130).optional(),
  gender: z.enum(['male', 'female', 'other', 'unknown']).optional(),
  chiefComplaint: z.string().trim().max(2000).optional(),
  mlcSuspected: z.boolean().default(false),
  /** Hold a bay for them now. */
  bayId: uuid.optional(),
});
export type PreAlertRequest = z.infer<typeof preAlertSchema>;

export const updateVisitSchema = z.object({
  displayName: z.string().trim().max(200).optional(),
  approximateAge: z.coerce.number().int().min(0).max(130).optional(),
  gender: z.enum(['male', 'female', 'other', 'unknown']).optional(),
  chiefComplaint: z.string().trim().max(2000).optional(),
  broughtBy: z.string().trim().max(200).optional(),
  broughtByPhone: z.string().trim().max(20).optional(),
  mlcSuspected: z.boolean().optional(),
  status: z.enum(VISIT_STATUSES).optional(),
  /** Stamps the door-to-doctor clock. Set once. */
  markFirstSeen: z.boolean().optional(),
});
export type UpdateVisitRequest = z.infer<typeof updateVisitSchema>;

export const assignBaySchema = z.object({
  bayId: uuid,
  /** `scan` when the bay barcode was read rather than picked from a list. */
  method: z.enum(['assigned', 'moved', 'scan']).default('assigned'),
  reason: z.string().trim().max(500).optional(),
});
export type AssignBayRequest = z.infer<typeof assignBaySchema>;

/**
 * Reconcile a tag into a real patient. Exit gate 2.
 *
 * The ER number does not change and no record is recreated — the visit gains a
 * patient. Anything that recreated the record would drop the triage, the MLC
 * and the imaging that already point at it.
 */
export const mergeIdentitySchema = z.object({
  patientId: uuid,
  reason: z.string().trim().min(1).max(1000),
});
export type MergeIdentityRequest = z.infer<typeof mergeIdentitySchema>;

export const disposeSchema = z
  .object({
    kind: z.enum(DISPOSITION_KINDS),
    summaryText: z.string().trim().max(8000).optional(),
    admitWardHint: z.string().trim().max(80).optional(),
    referredToFacility: z.string().trim().max(200).optional(),
    referralReason: z.string().trim().max(2000).optional(),
    transportMode: z.string().trim().max(40).optional(),
    lamaWitnessName: z.string().trim().max(200).optional(),
    lamaWitnessRelation: z.string().trim().max(80).optional(),
    lamaRisksExplained: z.boolean().default(false),
    deathAt: z.string().datetime({ offset: true }).optional(),
    deathCauseText: z.string().trim().max(2000).optional(),
    reason: z.string().trim().min(1).max(1000),
  })
  .refine((v) => v.kind !== 'lama' || (v.lamaWitnessName !== undefined && v.lamaRisksExplained), {
    message:
      'A discharge against medical advice needs a named witness and a record that the risks were explained. Without both it is a discharge nobody can defend if the patient deteriorates at home.',
  })
  .refine(
    (v) => v.kind !== 'refer_out' || (v.referredToFacility !== undefined && v.referralReason !== undefined),
    { message: 'A referral names where the patient is going and why.' },
  )
  .refine((v) => !['death', 'brought_dead'].includes(v.kind) || v.deathAt !== undefined, {
    message: 'A death records the time. The certificate cannot be issued without it.',
  });
export type DisposeRequest = z.infer<typeof disposeSchema>;

export const createZoneSchema = z.object({
  code: z.string().trim().min(1).max(24),
  name: z.string().trim().min(1).max(120),
  kind: z.enum(ZONE_KINDS),
  sortOrder: z.coerce.number().int().min(0).max(999).default(0),
});
export type CreateZoneRequest = z.infer<typeof createZoneSchema>;

export const createBaySchema = z.object({
  zoneId: uuid,
  code: z.string().trim().min(1).max(24),
  name: z.string().trim().min(1).max(80),
  kind: z.enum(BAY_KINDS).default('trolley'),
  barcode: z.string().trim().max(64).optional(),
  hasMonitor: z.boolean().default(false),
  hasVentilator: z.boolean().default(false),
  hasOxygen: z.boolean().default(true),
});
export type CreateBayRequest = z.infer<typeof createBaySchema>;

export const cleanBaySchema = z.object({ bayId: uuid });
export type CleanBayRequest = z.infer<typeof cleanBaySchema>;
