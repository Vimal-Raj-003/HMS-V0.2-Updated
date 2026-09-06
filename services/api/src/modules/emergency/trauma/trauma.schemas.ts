import { z } from 'zod';
import { queryFlag } from '@vims/contracts';

/**
 * TR-001 request contracts.
 *
 * ── What is deliberately not accepted ───────────────────────────────────────
 *
 * No request body on this module carries a computed value. Not the ESI level,
 * not the GCS total, not RTS, ISS, NISS or TRISS. `phase-06` puts it plainly:
 * "Never let a UI compute a score the server does not agree with." The client
 * sends observations; the server runs the same pure function the client ran and
 * stores what *it* got.
 *
 * The single exception is `assignedLevel`, and it is only readable next to
 * `overrideReason` — an override is a clinician disagreeing with the algorithm
 * on the record, which is a different thing from a client submitting a number.
 */
const uuid = z.string().uuid();

export const idSchema = uuid;
export const pageLimit = z.coerce.number().int().min(1).max(200).default(100);

export const TRIAGE_SYSTEMS = ['esi', 'start', 'jump_start'] as const;
export const TRIAGE_TAGS = ['red', 'yellow', 'green', 'black'] as const;
export const ACTIVATION_TIERS = ['level_1', 'level_2', 'consult'] as const;
export const AIS_REGIONS = ['head_neck', 'face', 'chest', 'abdomen', 'extremity', 'external'] as const;

/**
 * The roles a trauma page goes to.
 *
 * A closed list rather than free text: the page fan-out is matched against the
 * roster, and a typo in a role name is a page nobody receives.
 */
export const PAGE_ROLES = [
  'trauma_surgeon',
  'em_physician',
  'anaesthetist',
  'orthopaedics',
  'neurosurgery',
  'radiology',
  'blood_bank',
  'ot_coordinator',
  'icu',
] as const;

/** ATLS interventions that carry a clock. Free text goes in `detail`. */
export const INTERVENTION_KINDS = [
  'airway',
  'intubation',
  'surgical_airway',
  'needle_decompression',
  'chest_drain',
  'tourniquet',
  'pelvic_binder',
  'iv_access',
  'io_access',
  'blood_product',
  'mtp_activation',
  'txa',
  'tetanus',
  'antibiotic',
  'fast_scan',
  'ct',
  'to_theatre',
  'other',
] as const;

const observations = z.object({
  heartRate: z.coerce.number().int().min(0).max(300).optional(),
  respiratoryRate: z.coerce.number().int().min(0).max(120).optional(),
  systolicBp: z.coerce.number().int().min(0).max(300).optional(),
  diastolicBp: z.coerce.number().int().min(0).max(250).optional(),
  spo2: z.coerce.number().int().min(0).max(100).optional(),
  temperatureC: z.coerce.number().min(20).max(45).optional(),
  painScore: z.coerce.number().int().min(0).max(10).optional(),
  glucose: z.coerce.number().int().min(0).max(1200).optional(),
  gcsEye: z.coerce.number().int().min(1).max(4).optional(),
  gcsVerbal: z.coerce.number().int().min(1).max(5).optional(),
  gcsMotor: z.coerce.number().int().min(1).max(6).optional(),
  gcsIntubated: z.boolean().default(false),
});

/**
 * Triage a patient, or re-triage one.
 *
 * `esi` needs `resourceCount` and the two yes/no decision points; `start`
 * needs a tag. Both are accepted here and the discriminant is `system`,
 * because in a declared MCI the same nurse switches ladders mid-shift and a
 * second endpoint would be a second thing to find.
 */
export const triageSchema = observations.extend({
  system: z.enum(TRIAGE_SYSTEMS).default('esi'),

  // ── ESI decision points ───────────────────────────────────────────────────
  /** Decision A. Intubated, apnoeic, pulseless, unresponsive — needs it now. */
  needsLifeSavingIntervention: z.boolean().default(false),
  /** Decision B. "Would I give this patient my last open bed?" */
  highRisk: z.boolean().default(false),
  /** Decision C. Distinct resources: labs, imaging, IV fluids, consults. */
  resourceCount: z.coerce.number().int().min(0).max(20).default(0),

  // ── START / JumpSTART ─────────────────────────────────────────────────────
  tag: z.enum(TRIAGE_TAGS).optional(),

  ageYears: z.coerce.number().int().min(0).max(130),
  chiefComplaint: z.string().trim().max(2000).optional(),
  /** Stroke, STEMI, sepsis, obstetric, paediatric — each starts its own clock. */
  pathways: z.array(z.string().trim().max(40)).max(10).default([]),

  /**
   * Only meaningful with `overrideReason`. Sent alone it is refused: a level
   * with no stated disagreement is a level the algorithm should have produced.
   */
  assignedLevel: z.coerce.number().int().min(1).max(5).optional(),
  overrideReason: z.string().trim().min(8).max(1000).optional(),

  /** Written in a resus bay with no signal and synced later. */
  deviceId: z.string().trim().max(64).optional(),
  deviceSequence: z.coerce.number().int().min(0).optional(),
  recordedOffline: z.boolean().default(false),
});
export type TriageRequest = z.infer<typeof triageSchema>;

export const activateSchema = z.object({
  erVisitId: uuid,
  tier: z.enum(ACTIVATION_TIERS),
  triageRecordId: uuid.optional(),
  /** Which published criteria fired. Empty is allowed only with judgement. */
  criteriaFired: z.array(z.string().trim().max(80)).max(20).default([]),
  /** A clinician activating on gestalt. Always allowed, always recorded. */
  clinicalJudgement: z.boolean().default(false),
  /** Defaults to the tier's standard fan-out when omitted. */
  pageRoles: z.array(z.enum(PAGE_ROLES)).max(12).optional(),
});
export type ActivateRequest = z.infer<typeof activateSchema>;

export const acknowledgePageSchema = z.object({
  etaMinutes: z.coerce.number().int().min(0).max(240).optional(),
  /** Set when the responder is already in the department. */
  arrived: z.boolean().default(false),
});
export type AcknowledgePageRequest = z.infer<typeof acknowledgePageSchema>;

/** The reason comes from the `x-reason` header, not from here — EN-024 §5. */
export const standDownSchema = z.object({
  finalIss: z.coerce.number().int().min(0).max(75).optional(),
});
export type StandDownRequest = z.infer<typeof standDownSchema>;

const isoTime = z.string().datetime({ offset: true });

export const surveySchema = z.object({
  erVisitId: uuid,
  activationId: uuid.optional(),
  injuryAt: isoTime.optional(),
  ctAt: isoTime.optional(),
  otAt: isoTime.optional(),

  airwayPatent: z.boolean().optional(),
  airwayAdjunct: z.string().trim().max(40).optional(),
  collarAt: isoTime.optional(),
  intubatedAt: isoTime.optional(),

  breathSoundsEqual: z.boolean().optional(),
  needleDecompAt: isoTime.optional(),
  chestDrainAt: isoTime.optional(),

  tourniquetOnAt: isoTime.optional(),
  tourniquetOffAt: isoTime.optional(),
  tourniquetSite: z.string().trim().max(40).optional(),
  pelvicBinderAt: isoTime.optional(),
  ivAccessCount: z.coerce.number().int().min(0).max(10).optional(),
  ioAccess: z.boolean().optional(),
  crystalloidMl: z.coerce.number().int().min(0).max(20000).optional(),
  bloodUnits: z.coerce.number().int().min(0).max(100).optional(),
  mtpActivatedAt: isoTime.optional(),
  fastResult: z.enum(['positive', 'negative', 'equivocal', 'not_done']).optional(),

  pupilLeftMm: z.coerce.number().int().min(1).max(9).optional(),
  pupilRightMm: z.coerce.number().int().min(1).max(9).optional(),
  pupilsReactive: z.boolean().optional(),

  exposedAt: isoTime.optional(),
  logRolledAt: isoTime.optional(),
  temperatureC: z.coerce.number().min(20).max(45).optional(),

  tetanusAt: isoTime.optional(),
  txaAt: isoTime.optional(),
  antibioticAt: isoTime.optional(),

  ampleHistory: z
    .object({
      allergies: z.string().trim().max(500).optional(),
      medications: z.string().trim().max(500).optional(),
      pastHistory: z.string().trim().max(500).optional(),
      lastMeal: z.string().trim().max(200).optional(),
      events: z.string().trim().max(1000).optional(),
    })
    .optional(),
  mechanism: z.string().trim().max(64).optional(),
});
export type SurveyRequest = z.infer<typeof surveySchema>;

export const interventionSchema = z.object({
  kind: z.enum(INTERVENTION_KINDS),
  detail: z.string().trim().max(500).optional(),
  /** Defaults to now. Back-dating is allowed — it is often the honest time. */
  atTime: isoTime.optional(),
});
export type InterventionRequest = z.infer<typeof interventionSchema>;

export const injurySchema = z.object({
  region: z.enum(AIS_REGIONS),
  aisSeverity: z.coerce.number().int().min(1).max(6),
  aisCode: z.string().trim().max(24).optional(),
  description: z.string().trim().min(2).max(300),
  side: z.enum(['left', 'right', 'bilateral', 'midline']).optional(),
});
export type InjuryRequest = z.infer<typeof injurySchema>;

/**
 * Compute the scores.
 *
 * The arrival physiology is supplied rather than read from the latest
 * observations, and that is the whole point: TRISS on current numbers two hours
 * into a resuscitation says the patient was always going to survive. When the
 * caller omits them the service reads the *first* triage record, which is the
 * arrival set by definition.
 */
export const computeScoresSchema = z.object({
  erVisitId: uuid,
  arrivalGcs: z.coerce.number().int().min(3).max(15).optional(),
  arrivalSbp: z.coerce.number().int().min(0).max(300).optional(),
  arrivalRr: z.coerce.number().int().min(0).max(120).optional(),
  arrivalHeartRate: z.coerce.number().int().min(0).max(300).optional(),
  ageYears: z.coerce.number().int().min(0).max(130).optional(),
  mechanism: z.enum(['blunt', 'penetrating']).default('blunt'),
});
export type ComputeScoresRequest = z.infer<typeof computeScoresSchema>;

/** An amendment supersedes a locked version. The reason is the `x-reason` header. */
export const amendScoreSchema = computeScoresSchema.extend({
  supersedesId: uuid,
});
export type AmendScoreRequest = z.infer<typeof amendScoreSchema>;

export const declareMciSchema = z.object({
  name: z.string().trim().min(3).max(200),
  source: z.enum(['local', 'control_room']).default('local'),
});
export type DeclareMciRequest = z.infer<typeof declareMciSchema>;

export const standDownMciSchema = z.object({
  afterActionReport: z
    .object({
      patientsSeen: z.coerce.number().int().min(0).max(10000),
      whatWorked: z.string().trim().max(4000).optional(),
      whatDidNot: z.string().trim().max(4000).optional(),
      actions: z.array(z.string().trim().max(300)).max(30).default([]),
    })
    .optional(),
});
export type StandDownMciRequest = z.infer<typeof standDownMciSchema>;

export const traumaBoardQuerySchema = z.object({
  /** Default false: the board is about the team running now. */
  includeClosed: queryFlag().default(false),
  limit: pageLimit,
});
export type TraumaBoardQuery = z.infer<typeof traumaBoardQuerySchema>;
