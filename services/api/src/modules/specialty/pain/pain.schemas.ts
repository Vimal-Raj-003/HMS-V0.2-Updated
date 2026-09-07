import { queryFlag } from '@vims/contracts';
import { z } from 'zod';

/**
 * Request shapes for OP-016.
 *
 * ── There is no `mme` field ─────────────────────────────────────────────────
 *
 * The morphine equivalent is the daily dose times a dated conversion factor,
 * computed in a trigger, and every threshold in opioid prescribing is a line on
 * it. A clinic that can type its own MME types the number that keeps the
 * prescription under the line. The proof it cannot is that no request can
 * express one.
 *
 * ── And no `secondReviewerId` on the prescription ───────────────────────────
 *
 * A countersignature is a second person's act at a second moment, so it is a
 * second route behind a second key. Sending it in the prescription body would
 * let the prescriber name a colleague who has not looked at it — which is the
 * failure the threshold exists to catch, with better paperwork.
 */

const uuid = z.string().uuid();

export const painEpisodeSchema = z.object({
  patientId: uuid,
  referralId: uuid.optional(),
  type: z.enum(['acute', 'subacute', 'chronic', 'cancer', 'aps_inpatient']),
  mechanism: z.enum(['nociceptive', 'neuropathic', 'nociplastic', 'mixed']).optional(),
  primaryDxIcd10: z.string().max(16).optional(),
  onsetDate: z.string().date().optional(),
  sites: z.array(z.record(z.string(), z.unknown())).max(20).default([]),
  leadPhysicianId: uuid,
  /**
   * Whether this episode involves opioids at all. Turning it on is what makes
   * the agreement and the MME governance apply, so it is a decision somebody
   * makes rather than something inferred from a prescription not yet written.
   */
  opioidTherapy: z.boolean().default(false),
  riskScores: z.record(z.string(), z.unknown()).default({}),
});
export type PainEpisodeRequest = z.infer<typeof painEpisodeSchema>;

export const painAssessmentSchema = z
  .object({
    encounterId: uuid.optional(),
    kind: z.enum(['initial', 'followup', 'pre_procedure', 'post_procedure', 'tele', 'diary_summary']),
    nrsNow: z.number().int().min(0).max(10).optional(),
    nrsAvg: z.number().int().min(0).max(10).optional(),
    nrsWorst: z.number().int().min(0).max(10).optional(),
    nrsLeast: z.number().int().min(0).max(10).optional(),
    scale: z.enum(['nrs', 'vas', 'wong_baker', 'flacc', 'painad']).default('nrs'),
    instruments: z.record(z.string(), z.unknown()).default({}),
    sleep: z.string().max(40).optional(),
    /** Patient Global Impression of Change, 1–7. The outcome that asks the patient. */
    pgic: z.number().int().min(1).max(7).optional(),
    workStatus: z.string().max(40).optional(),
    sideEffects: z.record(z.string(), z.unknown()).default({}),
    formResponseId: uuid.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.nrsWorst !== undefined && v.nrsLeast !== undefined && v.nrsWorst < v.nrsLeast) {
      ctx.addIssue({
        code: 'custom',
        path: ['nrsWorst'],
        message:
          'The worst pain cannot be below the least. That is a form filled in the wrong order, and every trend built on it is wrong.',
      });
    }
  });
export type PainAssessmentRequest = z.infer<typeof painAssessmentSchema>;

export const agreementSchema = z.object({
  patientId: uuid,
  consentId: uuid.optional(),
  termsVersion: z.string().min(1).max(24),
  /** How long it runs. A clinic whose agreements never expire has none. */
  validTo: z.string().date(),
});
export type AgreementRequest = z.infer<typeof agreementSchema>;

export const revokeAgreementSchema = z.object({
  reason: z.string().trim().min(8).max(2000),
});
export type RevokeAgreementRequest = z.infer<typeof revokeAgreementSchema>;

/**
 * An opioid prescription, as the governance log records it.
 *
 * No `mme`, no `endDate`, no `agreementId`, no `secondReviewerId`. All four are
 * the database's: the first two computed, the third looked up, the fourth a
 * different person's act on a different route.
 */
export const opioidSchema = z.object({
  patientId: uuid,
  rxId: uuid.optional(),
  drugKey: z.string().min(1).max(60),
  drugName: z.string().min(1).max(160),
  route: z.enum(['oral', 'transdermal', 'iv', 'sc', 'im', 'rectal', 'sublingual', 'intranasal']),
  strength: z.string().min(1).max(60),
  /** Milligrams a day, or micrograms an hour for a patch. */
  dailyDose: z.number().positive().max(10_000),
  doseUnit: z.enum(['mg', 'mcg_per_hour']),
  daysSupply: z.number().int().min(1).max(180),
  quantity: z.number().positive().max(10_000),
  startDate: z.string().date(),
  /**
   * Required by the database at or above the review threshold. Optional here
   * because the prescriber does not know the MME until the server computes it —
   * so a clinic that under-doses gets no friction, and one that does not gets
   * a sentence naming the number.
   */
  justification: z.string().max(2000).optional(),
  naloxonePrescribed: z.boolean().default(false),
  naloxoneDeclined: z.string().max(1000).optional(),
  udsLastAt: z.string().date().optional(),
});
export type OpioidRequest = z.infer<typeof opioidSchema>;

/**
 * The countersignature.
 *
 * The reviewer is the session's, never the body's, and the database refuses one
 * who is the prescriber.
 */
export const secondReviewSchema = z.object({
  justification: z.string().trim().min(12).max(2000),
});
export type SecondReviewRequest = z.infer<typeof secondReviewSchema>;

export const interventionSchema = z.object({
  patientId: uuid,
  procedureId: uuid.optional(),
  interventionCode: z.string().min(1).max(40),
  name: z.string().min(1).max(160),
  levels: z.array(z.string().max(24)).max(20).default([]),
  side: z.enum(['left', 'right', 'bilateral', 'not_applicable']).default('not_applicable'),
  guidance: z.enum(['fluoroscopy', 'ultrasound', 'ct', 'landmark', 'endoscopic']),
  drugs: z.array(z.record(z.string(), z.unknown())).max(20).default([]),
  /** Triamcinolone-equivalent milligrams. Counts against the annual ceiling. */
  steroidMgEquiv: z.number().min(0).max(1000).optional(),
  rfParams: z.record(z.string(), z.unknown()).default({}),
  contrastPattern: z.string().max(80).optional(),
  fluoroSec: z.number().int().min(0).max(7200).optional(),
  doseMgy: z.number().min(0).max(100_000).optional(),
  nrsPre: z.number().int().min(0).max(10).optional(),
  nrsPost30min: z.number().int().min(0).max(10).optional(),
  sensoryBlock: z.string().max(80).optional(),
  complications: z.record(z.string(), z.unknown()).default({}),
  /** Requires both scores, by CHECK. An outcome with no measurement is an opinion. */
  outcome: z.enum(['good', 'partial', 'none']).optional(),
});
export type InterventionRequest = z.infer<typeof interventionSchema>;

export const painQuerySchema = z.object({
  patientId: uuid.optional(),
  openOnly: queryFlag().default(false),
  /** Only episodes on opioids. The governance worklist. */
  opioidOnly: queryFlag().default(false),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type PainQuery = z.infer<typeof painQuerySchema>;

export const opioidQuerySchema = z.object({
  patientId: uuid.optional(),
  /** Only prescriptions at or above the review threshold. */
  highDoseOnly: queryFlag().default(false),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type OpioidQuery = z.infer<typeof opioidQuerySchema>;
