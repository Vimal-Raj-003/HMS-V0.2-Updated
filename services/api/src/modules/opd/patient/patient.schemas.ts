import { z } from 'zod';
import { queryFlag } from '@vims/contracts';

/**
 * The request contracts for OP-001 §6's patient routes.
 *
 * They live here rather than in `packages/contracts` because that package is
 * outside this module's remit for this change; when the registration screen is
 * built they should move, unchanged, so the browser validates against the same
 * object the server does (`docs/09` §4). Nothing here is exported to another
 * module.
 */

const uuid = z.string().uuid();

/** Free text a person will read later: long enough to be a sentence, bounded. */
const reason = z.string().trim().min(8, 'Give a reason somebody reading the register can act on').max(1000);

export const GENDERS = ['male', 'female', 'other', 'unknown'] as const;
export const BLOOD_GROUPS = [
  'a_pos',
  'a_neg',
  'b_pos',
  'b_neg',
  'ab_pos',
  'ab_neg',
  'o_pos',
  'o_neg',
  'bombay',
  'unknown',
] as const;
export const CATEGORIES = [
  'general',
  'senior_citizen',
  'infant',
  'staff',
  'staff_dependant',
  'corporate',
  'insurance',
  'scheme',
  'charity',
  'vip',
  'international',
] as const;
export const PAYER_TYPES = ['self', 'insurance', 'corporate', 'scheme', 'staff', 'charity'] as const;
export const SOURCE_CHANNELS = ['counter', 'kiosk', 'online', 'app', 'call_centre', 'ivr', 'camp'] as const;
export const IDENTIFIER_TYPES = [
  'abha_number',
  'abha_address',
  'national_id',
  'passport',
  'voter_id',
  'driving_licence',
  'pan',
  'insurance_member',
  'corporate_emp',
  'scheme_card',
  'old_mrn',
  'legacy_uhid',
  'other',
] as const;
export const CONTACT_KINDS = ['emergency', 'attendant', 'guardian', 'next_of_kin', 'nominee'] as const;

/**
 * The four-arm allergy statement, minus one arm.
 *
 * `known` is deliberately not accepted from a client. `patient.allergies` owns
 * it: the `trg_allergies_sync_statement` trigger promotes the statement to
 * `known` when an active entry exists and demotes it when the last one goes,
 * and a client that could set `known` by hand would produce a banner that says
 * "allergies recorded" over an empty list. Recording the entries themselves is
 * EN-029, not this module.
 */
export const CLIENT_SETTABLE_ALLERGY_STATEMENTS = ['not_recorded', 'unable_to_assess', 'none_known'] as const;

/**
 * `unable_to_assess` without a reason is refused by the database
 * (`patients_allergy_unable_reason`), and only that arm may carry one
 * (`patients_allergy_reason_scoped`). Both halves are enforced here too so the
 * caller gets a field error instead of a 500 from a constraint.
 */
const allergyStatementSchema = z
  .object({
    statement: z.enum(CLIENT_SETTABLE_ALLERGY_STATEMENTS),
    unableReason: z.string().trim().min(8).max(1000).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.statement === 'unable_to_assess' && value.unableReason === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['unableReason'],
        message:
          'Say why the allergy history could not be established — an unexplained “unable to assess” tells the next clinician nothing.',
      });
    }
    if (value.statement !== 'unable_to_assess' && value.unableReason !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['unableReason'],
        message: 'Only “unable to assess” may carry a reason.',
      });
    }
  });

const identifierSchema = z.object({
  type: z.enum(IDENTIFIER_TYPES),
  value: z.string().trim().min(1).max(128),
  idTypeCode: z.string().trim().max(32).optional(),
  issuedBy: z.string().trim().max(160).optional(),
  isPrimary: z.boolean().default(false),
});

const contactSchema = z.object({
  kind: z.enum(CONTACT_KINDS),
  name: z.string().trim().min(1).max(200),
  relationshipCode: z.string().trim().max(32).optional(),
  phone: z.string().trim().min(6).max(20),
  isGuardian: z.boolean().default(false),
  isPrimary: z.boolean().default(false),
});

const addressSchema = z.object({
  line1: z.string().trim().max(200).optional(),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().max(120).optional(),
  district: z.string().trim().max(120).optional(),
  state: z.string().trim().max(120).optional(),
  countryCode: z.string().trim().length(2).default('IN'),
  pincode: z.string().trim().max(12).optional(),
});

/**
 * OP-001 §3.1's mandatory minimum: name, gender, mobile, and a basis for age.
 *
 * Photo, address and emergency contact are configurable-mandatory per hospital
 * (§16 Q3) and that configuration does not exist yet, so they are optional here
 * rather than hard-coded to somebody else's policy.
 *
 * **There is no Aadhaar field, in any form.** See `PatientService.register`.
 */
export const registerPatientSchema = z
  .object({
    branchId: uuid.optional(),

    titleCode: z.string().trim().max(32).optional(),
    firstName: z.string().trim().min(1).max(120),
    middleName: z.string().trim().max(120).optional(),
    lastName: z.string().trim().max(120).optional(),
    localName: z.string().trim().max(400).optional(),

    gender: z.enum(GENDERS).default('unknown'),
    dob: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
      .optional(),
    ageYears: z.number().int().min(0).max(150).optional(),
    ageMonths: z.number().int().min(0).max(1800).optional(),
    ageDays: z.number().int().min(0).max(60_000).optional(),

    bloodGroup: z.enum(BLOOD_GROUPS).default('unknown'),
    maritalStatus: z.string().trim().max(24).optional(),

    mobile: z.string().trim().min(6).max(20),
    altPhone: z.string().trim().max(20).optional(),
    email: z.string().trim().email().max(320).optional(),
    whatsappOptIn: z.boolean().default(false),

    preferredLanguage: z.string().trim().max(16).default('en-IN'),
    nationalityCode: z.string().trim().length(3).default('IND'),
    religionCode: z.string().trim().max(32).optional(),
    occupationCode: z.string().trim().max(32).optional(),

    /** The government photo ID shown at the desk. Never Aadhaar — see above. */
    idTypeCode: z.string().trim().max(32).optional(),
    idLast4: z
      .string()
      .regex(/^[0-9]{4}$/)
      .optional(),

    abhaNumber: z.string().trim().max(20).optional(),
    abhaAddress: z.string().trim().max(120).optional(),

    address: addressSchema.optional(),

    category: z.enum(CATEGORIES).default('general'),
    payerType: z.enum(PAYER_TYPES).default('self'),
    payerRef: z.string().trim().max(64).optional(),

    referralSourceCode: z.string().trim().max(32).optional(),
    referredByText: z.string().trim().max(200).optional(),

    isVip: z.boolean().default(false),
    isDifferentlyAbled: z.boolean().default(false),
    isPregnant: z.boolean().default(false),

    sourceChannel: z.enum(SOURCE_CHANNELS).default('counter'),

    allergy: allergyStatementSchema.optional(),
    identifiers: z.array(identifierSchema).max(20).default([]),
    contacts: z.array(contactSchema).max(10).default([]),

    /**
     * OP-001 §3.1: a duplicate score at or above 0.85 is a hard stop that only
     * `patient.record.create_override` can pass, and only with a reason. The
     * reason is stored on the new record (`created_override_reason`) and in the
     * audit row — an override nobody can explain later is not an override, it is
     * a duplicate.
     */
    overrideDuplicate: z
      .object({
        acknowledgedPatientIds: z.array(uuid).min(1).max(20),
        reason,
      })
      .optional(),
  })
  .superRefine((value, ctx) => {
    const hasAge =
      value.ageYears !== undefined || value.ageMonths !== undefined || value.ageDays !== undefined;
    if (value.dob === undefined && !hasAge) {
      ctx.addIssue({
        code: 'custom',
        path: ['dob'],
        message: 'Give a date of birth, or an age if the patient does not know it.',
      });
    }

    // OP-001 §5: "Corporate/scheme category requires valid payer ref (employee
    // id / card no) verified against EN-002/RC-007 payer master with validity
    // dates." The payer master does not exist yet, so only the half that can be
    // checked without it is checked — a corporate patient with no employee
    // number is a bill nobody can raise, and finding that out at discharge is
    // the expensive time to find it out.
    if (['insurance', 'corporate', 'scheme'].includes(value.payerType) && value.payerRef === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['payerRef'],
        message:
          'A corporate, insurance or scheme patient needs the employee number, policy number or card number.',
      });
    }
  });

export type RegisterPatientRequest = z.infer<typeof registerPatientSchema>;

/**
 * OP-001 §3.2.2: "changes to name/DOB/gender/mobile need reason and are
 * versioned". The reason is mandatory for **every** field here, not only those
 * four — `patient.record.update` is `requiresReason` in the catalogue, so the
 * policy engine has already refused the request without an `x-reason` header
 * before this schema is reached. The body's reason is the one written to
 * `patient.demographic_history`; the header exists to satisfy the policy.
 *
 * Allergy fields are absent on purpose: they are a clinical assertion under
 * `patient.alert.manage`, not demographics under `patient.record.update`.
 */
export const updatePatientSchema = z.object({
  version: z.number().int().min(0),
  reason,
  channel: z.enum(['desk', 'portal', 'kiosk', 'import', 'abdm', 'api']).default('desk'),

  titleCode: z.string().trim().max(32).nullable().optional(),
  firstName: z.string().trim().min(1).max(120).optional(),
  middleName: z.string().trim().max(120).nullable().optional(),
  lastName: z.string().trim().max(120).nullable().optional(),
  localName: z.string().trim().max(400).nullable().optional(),
  gender: z.enum(GENDERS).optional(),
  dob: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
    .optional(),
  bloodGroup: z.enum(BLOOD_GROUPS).optional(),
  maritalStatus: z.string().trim().max(24).nullable().optional(),
  mobile: z.string().trim().min(6).max(20).optional(),
  altPhone: z.string().trim().max(20).nullable().optional(),
  email: z.string().trim().email().max(320).nullable().optional(),
  whatsappOptIn: z.boolean().optional(),
  preferredLanguage: z.string().trim().max(16).optional(),
  religionCode: z.string().trim().max(32).nullable().optional(),
  occupationCode: z.string().trim().max(32).nullable().optional(),
  address: addressSchema.partial().optional(),
  category: z.enum(CATEGORIES).optional(),
  payerType: z.enum(PAYER_TYPES).optional(),
  payerRef: z.string().trim().max(64).nullable().optional(),
  isVip: z.boolean().optional(),
  isDifferentlyAbled: z.boolean().optional(),
  isPregnant: z.boolean().optional(),
});

export type UpdatePatientRequest = z.infer<typeof updatePatientSchema>;

const cursor = z.string().max(2048).optional();
const limit = z.coerce.number().int().min(1).max(100).default(25);

/**
 * OP-001 §6 `GET /patients?q=&mobile=&uhid=&abha=`.
 *
 * The four parameters are not combined. Each names a different index, and a
 * query that ORs them together uses none of them — see `PatientSearchService`
 * for the routing table and the precedence when a caller sends more than one.
 */
export const searchPatientsQuerySchema = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  mobile: z.string().trim().min(3).max(20).optional(),
  uhid: z.string().trim().min(1).max(32).optional(),
  abha: z.string().trim().min(3).max(120).optional(),
  /**
   * Any `patient.identifiers` value — passport, insurance member number,
   * corporate employee id, legacy MRN. OP-001 §3.2.1 lists "ID" among the things
   * the search box accepts and the migration built `idx_identifiers_value_prefix`
   * for it; §6's query string does not name it, so it is added here rather than
   * folded into `q`, where it would have had to share a predicate with UHID and
   * lose one of the two indexes.
   */
  identifier: z.string().trim().min(3).max(128).optional(),
  /** Include merged and inactive records. Off by default on every path. */
  includeInactive: queryFlag().default(false),
  cursor,
  limit,
});

export type SearchPatientsQuery = z.infer<typeof searchPatientsQuerySchema>;

export const historyQuerySchema = z.object({ cursor, limit });
export type HistoryQuery = z.infer<typeof historyQuerySchema>;

export const dedupeQueueQuerySchema = z.object({
  status: z.enum(['open', 'merged', 'not_duplicate', 'deferred']).default('open'),
  minScore: z.coerce.number().min(0).max(1).default(0),
  cursor,
  limit,
});

export type DedupeQueueQuery = z.infer<typeof dedupeQueueQuerySchema>;

/**
 * OP-001 §5: "Merge only by MRD role with **2-step confirm**".
 *
 * Step one names the two records and produces a persisted preview — the merge
 * row, both snapshots and the impact counts — without touching anything. Step
 * two names that preview by id and executes it. Splitting them is the point:
 * the officer confirms the *specific* comparison they were shown, so a record
 * changing between the two steps cannot be merged unseen.
 */
export const mergeRequestSchema = z.discriminatedUnion('step', [
  z.object({
    step: z.literal('prepare'),
    survivorId: uuid,
    victimId: uuid,
    reason,
    /** Which record's value wins per contested field, for the register. */
    fieldChoices: z.record(z.string(), z.enum(['survivor', 'victim'])).default({}),
  }),
  z.object({
    step: z.literal('commit'),
    mergeId: uuid,
  }),
]);

export type MergeRequest = z.infer<typeof mergeRequestSchema>;

export const unmergeRequestSchema = z.object({
  mergeId: uuid,
  reason,
});

export type UnmergeRequest = z.infer<typeof unmergeRequestSchema>;

export const idSchema = uuid;
