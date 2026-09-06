import { queryFlag } from '@vims/contracts';
import { z } from 'zod';

/**
 * TR-002 + OP-009 request contracts.
 *
 * ── `side` is required, and `bilateral` is not a value ──────────────────────
 *
 * Two limbs are two entries. A plan, a cast and an implant each belong to one
 * of them, and a row saying "both" is a row that cannot be operated on. The
 * plan carries its own side so the database can compare the two — see §B.1.
 */
const uuid = z.string().uuid();

export const idSchema = uuid;
export const pageLimit = z.coerce.number().int().min(1).max(200).default(50);
const isoTime = z.string().datetime({ offset: true });

export const SIDES = ['left', 'right', 'midline', 'not_applicable'] as const;
export const GUSTILO = ['I', 'II', 'IIIA', 'IIIB', 'IIIC'] as const;
export const SALTER_HARRIS = ['I', 'II', 'III', 'IV', 'V'] as const;
export const AETIOLOGY = [
  'traumatic',
  'pathological',
  'osteoporotic',
  'stress',
  'periprosthetic',
  'iatrogenic',
] as const;

export const TREATMENT_INTENTS = [
  'conservative',
  'closed_reduction_cast',
  'percutaneous_pinning',
  'orif',
  'im_nail',
  'external_fixation',
  'arthroplasty',
  'amputation',
  'traction',
  'observation',
] as const;

export const WEIGHT_BEARING = ['nwb', 'ttwb', 'pwb', 'wbat', 'fwb'] as const;

export const EVENT_KINDS = [
  'diagnosed',
  'reduction',
  'surgery',
  'cast_applied',
  'cast_changed',
  'cast_removed',
  'exfix_applied',
  'exfix_removed',
  'pin_site_care',
  'wound_event',
  'imaging',
  'physio_milestone',
  'complication',
  'union',
  'hardware_removal',
  'reopened',
  'closed',
  'note',
] as const;

export const FILM_LABELS = [
  'injury',
  'post_reduction',
  'post_op',
  'healing_2w',
  'healing_6w',
  'healing_12w',
  'healing_24w',
  'hardware_review',
  'ct',
  'mri',
  'other',
] as const;

export const UNION_STATUSES = ['not_united', 'progressing', 'united', 'delayed', 'nonunion'] as const;

export const COMPLICATIONS = [
  'infection',
  'nonunion',
  'malunion',
  'delayed_union',
  'compartment_syndrome',
  'neurovascular_injury',
  'implant_failure',
  'stiffness',
  'avascular_necrosis',
  'dvt',
  'fat_embolism',
  'refracture',
  'other',
] as const;

export const createFractureSchema = z.object({
  patientId: uuid,
  erVisitId: uuid.optional(),
  admissionId: uuid.optional(),
  traumaInjuryId: uuid.optional(),
  orthoEpisodeId: uuid.optional(),

  boneCode: z.string().trim().min(2).max(40),
  boneDisplay: z.string().trim().min(2).max(120),
  /** Never optional for a paired bone. `not_applicable` must be deliberate. */
  side: z.enum(SIDES),

  aoBone: z.coerce.number().int().min(1).max(9).optional(),
  aoSegment: z.coerce.number().int().min(1).max(4).optional(),
  aoType: z.enum(['A', 'B', 'C']).optional(),
  aoGroup: z.coerce.number().int().min(1).max(3).optional(),
  aoSubgroup: z.coerce.number().int().min(1).max(3).optional(),
  aoQualifiers: z.array(z.string().trim().max(24)).max(6).default([]),
  aoVersion: z.enum(['2007', '2018']).default('2018'),

  isOpen: z.boolean().default(false),
  gustilo: z.enum(GUSTILO).optional(),
  tscherne: z.enum(['C0', 'C1', 'C2', 'C3']).optional(),

  paediatric: z.boolean().default(false),
  salterHarris: z.enum(SALTER_HARRIS).optional(),

  aetiology: z.enum(AETIOLOGY).default('traumatic'),
  periprostheticClass: z.string().trim().max(24).optional(),
  dislocation: z.boolean().default(false),

  associated: z
    .object({
      nvDeficit: z.boolean().optional(),
      compartmentRisk: z.boolean().optional(),
      skinThreat: z.boolean().optional(),
      vascularInjury: z.boolean().optional(),
    })
    .optional(),
  /** `{ system: 'Weber', value: 'B' }` — Neer, Garden, Schatzker, Sanders. */
  regionalClassification: z
    .object({ system: z.string().trim().max(40), value: z.string().trim().max(40) })
    .optional(),

  icd10: z.string().trim().max(12).optional(),
  mechanism: z.record(z.string(), z.unknown()).optional(),
  injuryAt: isoTime.optional(),
  injuryAtEstimated: z.boolean().default(false),

  isMlc: z.boolean().default(false),
  mlcId: uuid.optional(),
  notes: z.string().trim().max(4000).optional(),

  /**
   * The arrival the open-fracture antibiotic hour is measured from. Supplied
   * because the fracture may be registered hours after the patient arrived,
   * and measuring from registration would make the wait invisible.
   */
  arrivedAt: isoTime.optional(),
});
export type CreateFractureRequest = z.infer<typeof createFractureSchema>;

/** The reason for a reclassification rides in `x-reason`. */
export const updateFractureSchema = createFractureSchema.partial().omit({ patientId: true, arrivedAt: true });
export type UpdateFractureRequest = z.infer<typeof updateFractureSchema>;

export const confirmSchema = z.object({
  /** Set when a resident confirms: a consultant co-signs within 24 hours. */
  cosignRequired: z.boolean().default(false),
});
export type ConfirmRequest = z.infer<typeof confirmSchema>;

export const planSchema = z.object({
  intent: z.enum(TREATMENT_INTENTS),
  /** Checked against the fracture. A mismatch is refused by the database. */
  side: z.enum(SIDES),
  damageControl: z.boolean().default(false),
  urgency: z.enum(['emergency', 'urgent', 'early', 'elective']).default('elective'),
  plannedProcedureCode: z.string().trim().max(40).optional(),
  plannedImplantFamily: z.string().trim().max(120).optional(),
  plannedDate: isoTime.optional(),
  weightBearing: z.enum(WEIGHT_BEARING).default('nwb'),
  pwbPct: z.coerce.number().int().min(0).max(100).optional(),
  wbReviewDate: z.string().date().optional(),
  romRestrictions: z.string().trim().max(1000).optional(),
  dvtProphylaxis: z.boolean().default(false),
  consentDocRef: z.string().trim().max(300).optional(),
});
export type PlanRequest = z.infer<typeof planSchema>;

export const eventSchema = z.object({
  kind: z.enum(EVENT_KINDS),
  at: isoTime.optional(),
  refType: z.string().trim().max(32).optional(),
  refId: uuid.optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type FractureEventRequest = z.infer<typeof eventSchema>;

export const filmSchema = z.object({
  label: z.enum(FILM_LABELS),
  takenAt: isoTime,
  studyUid: z.string().trim().max(120).optional(),
  studyId: uuid.optional(),
  isKeyImage: z.boolean().default(false),
  /** Set only by the matcher. A person attaching a film says so by omission. */
  autoAttached: z.boolean().default(false),
});
export type FilmRequest = z.infer<typeof filmSchema>;

export const findingSchema = z.object({
  filmId: uuid,
  angulationDeg: z.coerce.number().min(0).max(180).optional(),
  translationPct: z.coerce.number().int().min(0).max(100).optional(),
  shorteningMm: z.coerce.number().int().min(0).max(300).optional(),
  rotationDeg: z.coerce.number().min(0).max(180).optional(),
  /** RUST 4–12 across four cortices; mRUST 4–16. */
  rustScore: z.coerce.number().int().min(4).max(12).optional(),
  mrustScore: z.coerce.number().int().min(4).max(16).optional(),
  alignmentMaintained: z.boolean().optional(),
  implantStatus: z.enum(['na', 'intact', 'loosening', 'broken', 'backed_out', 'migrated']).optional(),
  jointCongruity: z.enum(['na', 'congruent', 'step_off']).optional(),
  unionStatus: z.enum(UNION_STATUSES).default('not_united'),
  notes: z.string().trim().max(2000).optional(),
});
export type FindingRequest = z.infer<typeof findingSchema>;

/** The reason rides in `x-reason` when non-union is declared early. */
export const unionSchema = z.object({
  outcome: z.enum(['united', 'nonunion', 'delayed']),
  at: isoTime.optional(),
  /** Set when there is no healing film and the call is clinical. */
  clinicalJustification: z.string().trim().max(1000).optional(),
});
export type UnionRequest = z.infer<typeof unionSchema>;

export const complicationSchema = z.object({
  kind: z.enum(COMPLICATIONS),
  onsetAt: isoTime,
  severity: z.enum(['minor', 'moderate', 'severe', 'limb_threatening']).default('moderate'),
  clavienDindo: z.string().trim().max(8).optional(),
  management: z.string().trim().max(2000).optional(),
  notes: z.string().trim().max(2000).optional(),
});
export type ComplicationRequest = z.infer<typeof complicationSchema>;

export const bundleSchema = z.object({
  antibioticAt: isoTime.optional(),
  tetanusAt: isoTime.optional(),
  photoAt: isoTime.optional(),
  dressingAt: isoTime.optional(),
  splintAt: isoTime.optional(),
  debridementAt: isoTime.optional(),
  plasticsReferralAt: isoTime.optional(),
  definitiveCoverAt: isoTime.optional(),
});
export type BundleRequest = z.infer<typeof bundleSchema>;

export const registryQuerySchema = z.object({
  patientId: uuid.optional(),
  status: z.enum(['open', 'united', 'closed_other', 'reopened']).optional(),
  openOnly: queryFlag().default(false),
  /** Registry export wants only the confirmed ones — a provisional AO code is
   *  not a dataset row. */
  confirmedOnly: queryFlag().default(false),
  limit: pageLimit,
});
export type RegistryQuery = z.infer<typeof registryQuerySchema>;

// ── OP-009 ───────────────────────────────────────────────────────────────────

export const episodeSchema = z.object({
  patientId: uuid,
  encounterId: uuid.optional(),
  /** Everything is offset from this. `injury` for a fracture, `surgery` after. */
  anchorKind: z.enum(['injury', 'surgery', 'first_visit']).default('injury'),
  anchorAt: isoTime,
  presentingComplaint: z.string().trim().max(2000).optional(),
  xrayFirst: z.boolean().default(false),
});
export type EpisodeRequest = z.infer<typeof episodeSchema>;

export const examSchema = z.object({
  rom: z
    .array(
      z.object({
        joint: z.string().trim().min(2).max(40),
        side: z.enum(['left', 'right']),
        movement: z.string().trim().min(2).max(40),
        activeDeg: z.coerce.number().int().min(-30).max(220).optional(),
        passiveDeg: z.coerce.number().int().min(-30).max(220).optional(),
        /** The reference travels with the row, so a later master edit cannot
         *  retrospectively change what a reading meant. */
        normalDeg: z.coerce.number().int().min(0).max(220).optional(),
        power: z.coerce.number().int().min(0).max(5).optional(),
      }),
    )
    .max(40)
    .default([]),
  neurovascular: z.record(z.string(), z.unknown()).optional(),
  specialTests: z.record(z.string(), z.unknown()).optional(),
  notes: z.string().trim().max(4000).optional(),
});
export type ExamRequest = z.infer<typeof examSchema>;

export const followupSchema = z.object({
  protocolKey: z.string().trim().min(2).max(60),
  fractureId: uuid.optional(),
  /** Offsets in weeks from the episode's anchor, not from today. */
  visits: z
    .array(
      z.object({
        label: z.string().trim().min(2).max(80),
        offsetWeeks: z.coerce.number().min(0).max(520),
        actions: z.array(z.string().trim().max(60)).max(10).default([]),
      }),
    )
    .min(1)
    .max(24),
});
export type FollowupRequest = z.infer<typeof followupSchema>;

export const promSchema = z.object({
  instrument: z.enum(['oxford_hip', 'oxford_knee', 'dash', 'harris_hip', 'eq5d', 'vas_pain']),
  fractureId: uuid.optional(),
  atWeeks: z.coerce.number().min(0).max(520),
  responses: z.record(z.string(), z.unknown()),
  score: z.coerce.number().min(0).max(1000).optional(),
});
export type PromRequest = z.infer<typeof promSchema>;
