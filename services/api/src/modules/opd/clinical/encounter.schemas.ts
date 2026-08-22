import { z } from 'zod';

/**
 * Request contracts for OP-002 §6's encounter, diagnosis, allergy and timeline
 * routes. Same placement reasoning as `vitals.schemas.ts`.
 */

const uuid = z.string().uuid();
const cursor = z.string().max(2048).optional();
const limit = z.coerce.number().int().min(1).max(100).default(25);

/** Free text a person will read later: long enough to be a sentence, bounded. */
const reason = z.string().trim().min(8, 'Give a reason somebody reading the record can act on').max(1000);

/**
 * The consultation note body.
 *
 * Deliberately an open object rather than a fixed shape: OP-002 §3.2 builds the
 * examination from EN-039 specialty form templates, which are configuration.
 * `docs/03` §Table rules names jsonb legitimate for exactly this. It is stored
 * verbatim in `clinical.document_versions.content`, hashed by the database, and
 * never truncated — "clinical text fields: no truncation, no silent loss"
 * (phase-02 §Constraints).
 */
const noteBody = z.record(z.string(), z.unknown());

export const ENCOUNTER_TYPES = [
  'opd',
  'tele',
  'er',
  'ip_consult',
  'daycare',
  'procedure',
  'health_checkup',
] as const;

export const DIAGNOSIS_RANKS = ['primary', 'secondary'] as const;
export const DIAGNOSIS_CERTAINTIES = ['provisional', 'confirmed', 'rule_out', 'chronic'] as const;
export const LATERALITIES = ['left', 'right', 'bilateral', 'not_applicable'] as const;
export const SIGN_METHODS = ['system', 'dsc', 'aadhaar_esign', 'webauthn', 'countersign'] as const;

/**
 * OP-002 §5: "Consultation may start only for visits in `waiting_doctor` (or
 * `waiting_vitals` if doctor overrides 'see without vitals' — **logged**)."
 *
 * The override is a reason, not a boolean, for the same reason every other
 * override in this codebase is: a boolean records that somebody clicked, a
 * reason records why.
 */
export const startEncounterSchema = z.object({
  visitId: uuid,
  type: z.enum(ENCOUNTER_TYPES).default('opd'),
  /** Defaults to the visit's practitioner. */
  practitionerKey: uuid.optional(),
  departmentKey: uuid.optional(),
  specialityKey: uuid.optional(),
  /** A resident's encounter needs a consultant's countersignature (OP-002 §2). */
  cosignRequired: z.boolean().default(false),
  seeWithoutVitals: z.object({ reason }).optional(),
});

export type StartEncounterRequest = z.infer<typeof startEncounterSchema>;

/**
 * `PATCH /encounters/{id}` — the autosave.
 *
 * `version` is the optimistic lock. Two tabs, or a tablet syncing an offline
 * draft against a note the doctor has since edited on the desktop, must not
 * silently overwrite each other; the loser is told so it can merge.
 */
export const updateEncounterSchema = z.object({
  version: z.number().int().min(0),
  chiefComplaintText: z.string().trim().max(20000).optional(),
  chiefComplaintCodes: z.array(z.string().trim().min(1).max(64)).max(32).optional(),
  treatmentPlan: z.string().trim().max(20000).optional(),
  advice: z.string().trim().max(20000).optional(),
  adviceCodes: z.array(uuid).max(32).optional(),
  followUpDate: z.string().date().optional(),
  followUpIntervalDays: z.number().int().min(0).max(3650).optional(),
  /** OP-002 §14 AC-16: completing with no diagnosis is allowed only with a reason. */
  noDiagnosisReason: z.string().trim().min(4).max(1000).optional(),
  /** Merged into the draft note. Drafts are mutable; signed versions never are. */
  note: noteBody.optional(),
});

export type UpdateEncounterRequest = z.infer<typeof updateEncounterSchema>;

export const pauseEncounterSchema = z.object({
  reason: z.string().trim().max(1000).optional(),
});

export type PauseEncounterRequest = z.infer<typeof pauseEncounterSchema>;

export const cancelEncounterSchema = z.object({ reason });
export type CancelEncounterRequest = z.infer<typeof cancelEncounterSchema>;

const diagnosisSchema = z.object({
  /** `mdm_code_systems.key` — `ICD10`, `ICD11` or `SNOMEDCT`. */
  codeSystemKey: z.enum(['ICD10', 'ICD11', 'SNOMEDCT']),
  code: z.string().trim().min(1).max(64),
  codeVersion: z.string().trim().max(32).optional(),
  snomedCode: z.string().trim().max(32).optional(),
  description: z.string().trim().min(1).max(500),
  rank: z.enum(DIAGNOSIS_RANKS).default('secondary'),
  certainty: z.enum(DIAGNOSIS_CERTAINTIES).default('provisional'),
  severity: z.string().trim().max(24).optional(),
  laterality: z.enum(LATERALITIES).default('not_applicable'),
  onsetDate: z.string().date().optional(),
  isChronic: z.boolean().default(false),
  isNotifiable: z.boolean().default(false),
});

/**
 * OP-002 §5: "primary diagnosis exactly one". At most one is a unique index in
 * the migration; this refuses a *request* that names two, so the doctor is told
 * which two rather than being handed a constraint name.
 */
export const recordDiagnosesSchema = z
  .object({ diagnoses: z.array(diagnosisSchema).min(1).max(30) })
  .superRefine((value, ctx) => {
    const primaries = value.diagnoses.filter((d) => d.rank === 'primary');
    if (primaries.length > 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['diagnoses'],
        message: `Exactly one diagnosis may be primary; ${String(primaries.length)} were marked primary.`,
      });
    }
  });

export type RecordDiagnosesRequest = z.infer<typeof recordDiagnosesSchema>;

/**
 * The dosing weight (`docs/04` §7, phase-02 exit gate 3).
 *
 * `measured` does not accept a number: the weight is read from the named
 * `clinical.vitals` row, so "measured" can never mean "typed in and called
 * measured". `stated` and `estimated` do accept one, and both stamp the
 * asserter and the instant — the migration's
 * `encounters_dosing_weight_attributed` CHECK refuses the row otherwise.
 */
export const setDosingWeightSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('measured'), vitalsId: uuid }),
  z.object({ source: z.literal('stated'), weightKg: z.number().min(0.3).max(400) }),
  z.object({ source: z.literal('estimated'), weightKg: z.number().min(0.3).max(400) }),
]);

export type SetDosingWeightRequest = z.infer<typeof setDosingWeightSchema>;

/**
 * The per-kilogram dose precondition.
 *
 * Not a dose calculator and not a CDSS rule — those belong to EN-029 and to the
 * prescribing module. This answers the one question the encounter owns: *may a
 * weight-based dose be computed for this patient at all?* It refuses when the
 * dosing weight is unknown, which is the hard stop `docs/04` §7 lists among the
 * ones configuration can never remove.
 */
export const dosingCheckSchema = z.object({
  mgPerKg: z.number().gt(0).max(1000),
  drugLabel: z.string().trim().max(200).optional(),
});

export type DosingCheckRequest = z.infer<typeof dosingCheckSchema>;

export const completeEncounterSchema = z.object({
  note: noteBody.optional(),
  signMethod: z.enum(SIGN_METHODS).default('system'),
  followUpDate: z.string().date().optional(),
  noDiagnosisReason: z.string().trim().min(4).max(1000).optional(),
});

export type CompleteEncounterRequest = z.infer<typeof completeEncounterSchema>;

/**
 * OP-002 §14 AC-9 — amend a signed note.
 *
 * The reason is mandatory in the schema, mandatory in the permission catalogue
 * (`opd.encounter.amend` is `requiresReason`, so the policy engine also demands
 * an `x-reason` header) and mandatory in the database (`document_versions_amendment_reason`).
 * Three independent enforcements, because an amendment with no reason is an
 * overwrite wearing a version number.
 */
export const amendEncounterSchema = z.object({
  reason,
  note: noteBody,
  signMethod: z.enum(SIGN_METHODS).default('system'),
});

export type AmendEncounterRequest = z.infer<typeof amendEncounterSchema>;

export const listEncountersQuerySchema = z.object({
  patient: uuid.optional(),
  visit: uuid.optional(),
  status: z.enum(['draft', 'in_progress', 'paused', 'completed', 'amended', 'cancelled']).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  cursor,
  limit,
});

export type ListEncountersQuery = z.infer<typeof listEncountersQuerySchema>;

export const ALLERGY_CATEGORIES = ['drug', 'food', 'environment', 'latex', 'biologic', 'other'] as const;
export const ALLERGY_SEVERITIES = ['mild', 'moderate', 'severe', 'anaphylaxis'] as const;
export const ALLERGY_CRITICALITIES = ['low', 'high', 'unable_to_assess'] as const;

/**
 * OP-002 §6 `POST /patients/{id}/allergies`.
 *
 * The severity vocabulary is the clinical one from the `allergy.recorded` event
 * (mild / moderate / severe / anaphylaxis) rather than the generic alert
 * severity the column stores; the service maps between them in one place, so
 * every caller and every consumer sees the same four words.
 */
export const recordAllergySchema = z.object({
  category: z.enum(ALLERGY_CATEGORIES),
  substanceText: z.string().trim().min(1).max(300),
  codeSystemKey: z.string().trim().max(64).optional(),
  substanceCode: z.string().trim().max(64).optional(),
  reaction: z.array(z.string().trim().min(1).max(120)).max(12).default([]),
  reactionText: z.string().trim().max(2000).optional(),
  severity: z.enum(ALLERGY_SEVERITIES).default('moderate'),
  criticality: z.enum(ALLERGY_CRITICALITIES).default('unable_to_assess'),
  informant: z.enum(['patient', 'family', 'practitioner', 'record', 'unknown']).default('patient'),
  verification: z.enum(['unconfirmed', 'confirmed', 'refuted']).default('unconfirmed'),
  onsetOn: z.string().date().optional(),
  notes: z.string().trim().max(2000).optional(),
});

export type RecordAllergyRequest = z.infer<typeof recordAllergySchema>;

export const TIMELINE_TYPES = [
  'encounter',
  'diagnosis',
  'vitals',
  'document',
  'visit',
  'allergy',
  'problem',
] as const;

/**
 * `GET /patients/{id}/timeline` — phase-02 exit gate 6: five years of history
 * in under a second at p95.
 *
 * The window is bounded by default rather than open, and the page is a keyset
 * page over a UNION of per-source queries each of which has its own
 * `(hospital_id, patient_id, <time> DESC)` index. `types` narrows the union so
 * a filtered timeline reads fewer indexes, not more rows.
 */
export const timelineQuerySchema = z.object({
  types: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value === undefined ? undefined : value.split(',').map((t) => t.trim())))
    .pipe(z.array(z.enum(TIMELINE_TYPES)).min(1).max(TIMELINE_TYPES.length).optional()),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  cursor,
  limit,
});

export type TimelineQuery = z.infer<typeof timelineQuerySchema>;

export const idSchema = uuid;
