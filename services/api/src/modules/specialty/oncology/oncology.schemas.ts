import { queryFlag } from '@vims/contracts';
import { z } from 'zod';

/**
 * Request shapes for OP-031 and IP-023.
 *
 * ── There is no `bsa`, no `crcl`, no `calcDose`, no `finalDose` ─────────────
 *
 * Chemotherapy is dosed per square metre of body surface, and body surface is
 * √(height × weight / 3600). A prescriber sends two measurements; the database
 * does the rest. A person doing that multiplication on a ward round and writing
 * the answer in a box is the most documented fatal error in oncology, and the
 * proof it cannot happen here is that no request can carry the answer.
 *
 * ── And there is no route on an order line ──────────────────────────────────
 *
 * The route comes from the regimen. Intrathecal vincristine is uniformly fatal
 * and has killed dozens of people worldwide, every time in a system that had a
 * field where the route could be typed. There is no such field here, the
 * regimen library itself refuses the combination, and the order-line trigger
 * refuses it again.
 *
 * ── And no `maxGrade` on a toxicity assessment ──────────────────────────────
 *
 * The worst grade in a list is a maximum, and a clinician who types one has
 * already decided what the list means.
 */

const uuid = z.string().uuid();

export const caseSchema = z.object({
  patientId: uuid,
  caseNo: z.string().min(1).max(32),
  primarySiteIcdo3: z.string().min(1).max(16),
  morphologyIcdo3: z.string().max(16).optional(),
  laterality: z.enum(['left', 'right', 'bilateral', 'not_applicable']).default('not_applicable'),
  grade: z.string().max(16).optional(),
  dxDate: z.string().date(),
  dxBasis: z.enum(['histology', 'cytology', 'imaging', 'clinical']),
  biomarkers: z.record(z.string(), z.unknown()).default({}),
  tnm: z.record(z.string(), z.unknown()).default({}),
  ecog: z.number().int().min(0).max(5).optional(),
  kps: z.number().int().min(0).max(100).optional(),
  intent: z.enum(['curative', 'adjuvant', 'neoadjuvant', 'palliative']),
  oncologistId: uuid,
});
export type CaseRequest = z.infer<typeof caseSchema>;

export const regimenSchema = z.object({
  code: z.string().min(1).max(40),
  name: z.string().min(1).max(160),
  indicationSites: z.array(z.string().max(40)).max(30).default([]),
  cycleLengthDays: z.number().int().min(1).max(365),
  plannedCycles: z.number().int().min(1).max(60),
  emetogenicity: z.enum(['minimal', 'low', 'moderate', 'high']).default('moderate'),
  /** The counts a cycle is not given below. They differ by regimen. */
  labThresholds: z
    .object({
      anc: z.number().optional(),
      platelets: z.number().optional(),
      creatinineMax: z.number().optional(),
      bilirubinMax: z.number().optional(),
    })
    .default({}),
  reason: z.string().min(8).max(2000),
  drugs: z
    .array(
      z.object({
        seq: z.number().int().min(1).max(40),
        drugId: uuid.optional(),
        drugName: z.string().min(1).max(120),
        /** The rules that matter turn on the class, not the product. */
        drugClass: z.enum([
          'vinca',
          'anthracycline',
          'platinum',
          'taxane',
          'antimetabolite',
          'alkylating',
          'antibody',
          'other',
        ]),
        doseBasis: z.enum(['mg_m2', 'mg_kg', 'auc', 'flat', 'mg_m2_capped']),
        doseValue: z.number().positive().max(100000),
        unit: z.string().min(1).max(12),
        bsaCap: z.number().min(1).max(3).optional(),
        /** Vincristine's is 2 mg, and it exists because the arithmetic kills. */
        absoluteCap: z.number().positive().max(100000).optional(),
        route: z.enum(['iv', 'po', 'sc', 'im', 'it', 'ivbolus', 'topical']),
        infusionMin: z.number().int().min(0).max(2880).optional(),
        diluent: z.string().max(60).optional(),
        volumeMl: z.number().int().min(0).max(5000).optional(),
        stabilityH: z.number().int().min(0).max(720).optional(),
        vesicant: z.boolean().default(false),
        days: z.array(z.number().int().min(1).max(60)).min(1).max(30),
        cumulativeCap: z.number().positive().max(100000).optional(),
        capUnit: z.string().max(16).optional(),
        isPremed: z.boolean().default(false),
        isSupportive: z.boolean().default(false),
      }),
    )
    .min(1)
    .max(40),
});
export type RegimenRequest = z.infer<typeof regimenSchema>;

export const planSchema = z.object({
  caseId: uuid,
  regimenId: uuid,
  intent: z.enum(['curative', 'adjuvant', 'neoadjuvant', 'palliative']),
  startDate: z.string().date(),
  plannedCycles: z.number().int().min(1).max(60),
  /** The measurements. Everything else on the plan is computed from them. */
  heightCm: z.number().min(30).max(250),
  weightKg: z.number().min(1).max(400),
  ageYears: z.number().int().min(0).max(130),
  /** A pharmacokinetic constant in Cockcroft-Gault, not a demographic. */
  female: z.boolean(),
  creatinineMgDl: z.number().min(0.1).max(20).optional(),
  bsaMethod: z.enum(['mosteller', 'dubois']).default('mosteller'),
  consentId: uuid.optional(),
});
export type PlanRequest = z.infer<typeof planSchema>;

export const cycleSchema = z.object({
  cycleNo: z.number().int().min(1).max(60),
  dayNo: z.number().int().min(1).max(60).default(1),
  scheduledAt: z.string(),
  /** The bloods. What is out of range is computed against the regimen. */
  fitness: z
    .object({
      ancK: z.number().optional(),
      plateletsK: z.number().optional(),
      creatinine: z.number().optional(),
      bilirubin: z.number().optional(),
      weightKg: z.number().optional(),
      ecog: z.number().int().min(0).max(5).optional(),
      checkedAt: z.string().optional(),
    })
    .default({}),
});
export type CycleRequest = z.infer<typeof cycleSchema>;

/**
 * Signing. The second signer is not in this body — countersigning is a second
 * person's act at a second moment, behind a second key, for the same reason the
 * opioid countersignature is.
 */
export const cycleSignSchema = z.object({
  fitness: z
    .object({
      ancK: z.number().optional(),
      plateletsK: z.number().optional(),
      creatinine: z.number().optional(),
      bilirubin: z.number().optional(),
      weightKg: z.number().optional(),
      ecog: z.number().int().min(0).max(5).optional(),
      checkedAt: z.string().optional(),
    })
    .optional(),
});
export type CycleSignRequest = z.infer<typeof cycleSignSchema>;

export const cosignSchema = z.object({
  reason: z.string().min(8).max(2000),
});
export type CosignRequest = z.infer<typeof cosignSchema>;

export const deferSchema = z.object({
  reason: z.string().min(4).max(2000),
});
export type DeferRequest = z.infer<typeof deferSchema>;

/**
 * An order line names the regimen drug it comes from, and nothing else about
 * the drug. The dose basis, the route, the days and every cap are the library's.
 */
export const orderLineSchema = z.object({
  regimenDrugId: uuid,
  reductionPct: z.number().min(0).max(100).default(0),
  reductionReason: z.string().max(200).optional(),
});
export type OrderLineRequest = z.infer<typeof orderLineSchema>;

export const pharmacySchema = z.object({
  status: z.enum(['approved', 'queried', 'rejected']),
  notes: z.string().max(2000).optional(),
});
export type PharmacyRequest = z.infer<typeof pharmacySchema>;

export const administerSchema = z.object({
  orderLineId: uuid,
  /** The second nurse. The database refuses one who is the first. */
  verifyNurse2Id: uuid,
  barcodeVerified: z.boolean().default(false),
  chairId: uuid.optional(),
  rate: z.string().max(40).optional(),
  access: z.enum(['peripheral', 'port', 'picc', 'central']).default('peripheral'),
});
export type AdministerRequest = z.infer<typeof administerSchema>;

export const administrationUpdateSchema = z
  .object({
    endedAt: z.string().optional(),
    completed: z.boolean().optional(),
    reactions: z.array(z.record(z.string(), z.unknown())).max(20).optional(),
    /** A vesicant out of the vein: a surgical emergency and a reportable incident. */
    extravasation: z.record(z.string(), z.unknown()).optional(),
    vitals: z.array(z.record(z.string(), z.unknown())).max(60).optional(),
    interruptions: z.array(z.record(z.string(), z.unknown())).max(20).optional(),
    notes: z.string().max(4000).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change.' });
export type AdministrationUpdateRequest = z.infer<typeof administrationUpdateSchema>;

export const toxicitySchema = z.object({
  cycleId: uuid.optional(),
  source: z.enum(['clinician', 'pro']).default('clinician'),
  items: z
    .array(
      z.object({
        term: z.string().min(1).max(160),
        grade: z.number().int().min(1).max(5),
        attribution: z.enum(['unrelated', 'unlikely', 'possible', 'probable', 'definite']).optional(),
      }),
    )
    .min(1)
    .max(40),
});
export type ToxicityRequest = z.infer<typeof toxicitySchema>;

export const caseQuerySchema = z.object({
  patientId: uuid.optional(),
  activeOnly: queryFlag().default(false),
  nearingCapOnly: queryFlag().default(false),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type CaseQuery = z.infer<typeof caseQuerySchema>;

export const cycleQuerySchema = z.object({
  planId: uuid.optional(),
  on: z.string().date().optional(),
  pendingPharmacyOnly: queryFlag().default(false),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type CycleQuery = z.infer<typeof cycleQuerySchema>;
