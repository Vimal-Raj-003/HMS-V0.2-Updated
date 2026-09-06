import { queryFlag } from '@vims/contracts';
import { z } from 'zod';

/**
 * Phase 7E + 7F request schemas.
 *
 * ── `transfuse` has four required fields and no fifth ───────────────────────
 *
 * Two checkers, the wristband scan and the bag scan. There is no `override`,
 * no `emergency`, no `singleCheck`. `phase-07`: the bedside check "cannot be
 * skipped, deferred or configured away" — and a request field that could is
 * exactly such a bypass.
 */

const uuid = z.string().uuid();

export const flowsheetSchema = z.object({
  admissionId: uuid,
  patientId: uuid,
  atHour: z.string().datetime({ offset: true }).optional(),
  heartRate: z.number().int().min(0).max(300).optional(),
  systolicBp: z.number().int().min(0).max(300).optional(),
  diastolicBp: z.number().int().min(0).max(250).optional(),
  meanArterialBp: z.number().int().min(0).max(250).optional(),
  cvpMmhg: z.number().int().min(-10).max(50).optional(),
  temperatureC: z.number().min(25).max(45).optional(),
  spo2: z.number().int().min(0).max(100).optional(),
  fio2: z.number().int().min(21).max(100).optional(),
  respiratoryRate: z.number().int().min(0).max(80).optional(),
  ventMode: z.string().trim().max(20).optional(),
  peepCmH2o: z.number().min(0).max(30).optional(),
  tidalVolumeMl: z.number().int().min(0).max(2000).optional(),
  gcs: z.number().int().min(3).max(15).optional(),
  rass: z.number().int().min(-5).max(4).optional(),
  urineOutputMl: z.number().int().min(0).max(5000).optional(),
  infusions: z.record(z.string(), z.unknown()).optional(),
  /** Which reading came from a device and which from a nurse. */
  sources: z.record(z.string(), z.string()).optional(),
});
export type FlowsheetRequest = z.infer<typeof flowsheetSchema>;

export const scoreSchema = z.object({
  admissionId: uuid,
  scale: z.enum(['apache_ii', 'sofa', 'qsofa', 'saps_ii']),
  components: z.record(z.string(), z.number()),
});
export type ScoreRequest = z.infer<typeof scoreSchema>;

export const bundleSchema = z.object({
  admissionId: uuid,
  bundle: z.enum(['vap', 'clabsi', 'cauti', 'sedation', 'dvt', 'stress_ulcer', 'glycaemic']),
  shift: z.enum(['morning', 'evening', 'night']),
  /** Every element, true or false. Complete means all of them. */
  elements: z.record(z.string(), z.boolean()),
  exceptions: z.array(z.string().trim().min(1).max(200)).max(10).default([]),
});
export type BundleRequest = z.infer<typeof bundleSchema>;

export const cartSchema = z.object({
  code: z.string().trim().min(1).max(20),
  location: z.string().trim().min(1).max(160),
  wardId: uuid.optional(),
  sealNo: z.string().trim().max(40).optional(),
  earliestExpiryOn: z.string().date().optional(),
});
export type CartRequest = z.infer<typeof cartSchema>;

export const cartCheckSchema = z
  .object({
    kind: z.enum(['seal', 'full']),
    sealIntact: z.boolean().optional(),
    sealNoSeen: z.string().trim().max(40).optional(),
    /** Required for a full check. One with nothing recorded is a check from the corridor. */
    findings: z.record(z.string(), z.unknown()).optional(),
    discrepancies: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
    resealedNo: z.string().trim().max(40).optional(),
  })
  .refine((v) => v.kind !== 'full' || v.findings !== undefined, {
    message: 'A full open-check records what was found against the list.',
    path: ['findings'],
  });
export type CartCheckRequest = z.infer<typeof cartCheckSchema>;

export const codeSchema = z.object({
  location: z.string().trim().min(1).max(160),
  patientId: uuid.optional(),
  admissionId: uuid.optional(),
  cartId: uuid.optional(),
  wardId: uuid.optional(),
});
export type CodeRequest = z.infer<typeof codeSchema>;

export const codeEventSchema = z
  .object({
    kind: z.enum(['rhythm', 'shock', 'drug', 'cpr_cycle', 'airway', 'access', 'rosc', 'note']),
    rhythm: z.enum(['vf', 'pvt', 'asystole', 'pea', 'sinus', 'af', 'other']).optional(),
    joules: z.number().int().min(1).max(400).optional(),
    drug: z.string().trim().max(120).optional(),
    dose: z.string().trim().max(60).optional(),
    route: z.string().trim().max(40).optional(),
    note: z.string().trim().max(1000).optional(),
    at: z.string().datetime({ offset: true }).optional(),
  })
  .refine((v) => v.kind !== 'shock' || v.joules !== undefined, {
    message: 'A shock records its energy. A line that says "shock" cannot be reviewed.',
    path: ['joules'],
  })
  .refine((v) => v.kind !== 'drug' || (v.drug !== undefined && v.dose !== undefined), {
    message: 'A drug line records what was given and how much.',
    path: ['drug'],
  })
  .refine((v) => v.kind !== 'rhythm' || v.rhythm !== undefined, {
    message: 'A rhythm line names the rhythm.',
    path: ['rhythm'],
  });
export type CodeEventRequest = z.infer<typeof codeEventSchema>;

export const codeCloseSchema = z.object({
  outcome: z.enum(['rosc', 'died', 'transferred', 'false_alarm']),
  ceaseReason: z.string().trim().min(8).max(2000).optional(),
  debriefNote: z.string().trim().max(4000).optional(),
});
export type CodeCloseRequest = z.infer<typeof codeCloseSchema>;

export const donorSchema = z.object({
  donorNo: z.string().trim().min(1).max(60),
  name: z.string().trim().min(1).max(200),
  bloodGroup: z.enum(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']).optional(),
  phone: z.string().trim().max(20).optional(),
  dateOfBirth: z.string().date().optional(),
});
export type DonorRequest = z.infer<typeof donorSchema>;

export const unitSchema = z.object({
  unitNo: z.string().trim().min(1).max(60),
  donorId: uuid.optional(),
  component: z.enum([
    'whole_blood',
    'packed_red_cells',
    'fresh_frozen_plasma',
    'platelet_concentrate',
    'single_donor_platelets',
    'cryoprecipitate',
  ]),
  bloodGroup: z.enum(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']),
  volumeMl: z.number().int().min(20).max(600),
  collectedOn: z.string().date(),
  expiresOn: z.string().date(),
  storageLocation: z.string().trim().max(120).optional(),
});
export type UnitRequest = z.infer<typeof unitSchema>;

const ttiResult = z.enum(['non_reactive', 'reactive', 'pending', 'indeterminate']);

export const ttiSchema = z.object({
  hiv: ttiResult,
  hbv: ttiResult,
  hcv: ttiResult,
  syphilis: ttiResult,
  malaria: ttiResult,
});
export type TtiRequest = z.infer<typeof ttiSchema>;

export const bloodRequestSchema = z.object({
  patientId: uuid,
  admissionId: uuid.optional(),
  otCaseId: uuid.optional(),
  component: z.enum([
    'whole_blood',
    'packed_red_cells',
    'fresh_frozen_plasma',
    'platelet_concentrate',
    'single_donor_platelets',
    'cryoprecipitate',
  ]),
  unitsRequested: z.number().int().min(1).max(60),
  urgency: z.enum(['routine', 'urgent', 'emergency', 'massive_transfusion']).default('routine'),
  indication: z.string().trim().min(8).max(2000),
});
export type BloodRequestBody = z.infer<typeof bloodRequestSchema>;

export const sampleSchema = z.object({
  /** 1 or 2. The second must be drawn by a different person. */
  which: z.union([z.literal(1), z.literal(2)]),
  bloodGroup: z.enum(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']),
});
export type SampleRequest = z.infer<typeof sampleSchema>;

export const bloodIssueSchema = z.object({
  requestId: uuid,
  unitId: uuid,
  /** The second person at the bank. Cannot be you. */
  checkedBy: uuid,
  coolerRef: z.string().trim().max(40).optional(),
});
export type BloodIssueRequest = z.infer<typeof bloodIssueSchema>;

/** Four fields, all required, and no fifth that stands in for any of them. */
export const transfuseSchema = z.object({
  /** The second nurse at the bedside. Cannot be you. */
  checkedBy: uuid,
  /** What the scanner read off the wristband. */
  wristbandScan: z.string().trim().min(1).max(200),
  /** What the scanner read off the bag. */
  unitScan: z.string().trim().min(1).max(200),
});
export type TransfuseRequest = z.infer<typeof transfuseSchema>;

export const reactionSchema = z.object({
  kind: z.enum([
    'febrile',
    'allergic',
    'anaphylaxis',
    'haemolytic_acute',
    'haemolytic_delayed',
    'taco',
    'trali',
    'bacterial',
    'other',
  ]),
  severity: z.enum(['mild', 'moderate', 'severe', 'life_threatening', 'death']),
  volumeInMl: z.number().int().min(0).max(1000).optional(),
  symptoms: z.array(z.string().trim().min(1).max(160)).max(20).default([]),
  management: z.string().trim().min(8).max(4000),
  bagReturned: z.boolean().default(false),
});
export type ReactionRequest = z.infer<typeof reactionSchema>;

export const inventoryQuerySchema = z.object({
  component: z.string().trim().max(40).optional(),
  bloodGroup: z.string().trim().max(6).optional(),
  availableOnly: queryFlag().default(true),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export type InventoryQuery = z.infer<typeof inventoryQuerySchema>;

export const codeQuerySchema = z.object({
  openOnly: queryFlag().default(false),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type CodeQuery = z.infer<typeof codeQuerySchema>;
