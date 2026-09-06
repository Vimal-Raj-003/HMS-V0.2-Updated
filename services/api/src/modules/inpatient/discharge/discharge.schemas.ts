import { queryFlag } from '@vims/contracts';
import { z } from 'zod';

/**
 * Phase 7G request schemas — IP-002 and IP-017.
 *
 * ── What is deliberately absent ─────────────────────────────────────────────
 *
 * `signSummary` takes no `force`, no `skipReconciliation`, no
 * `unreconciledAccepted`. `release` takes no `mlcOverride`, no `withoutMccd`,
 * no `emergency`. Both refusals live in database triggers, and a request field
 * that could express the bypass is the bypass — the trigger would still refuse,
 * but the screen would have promised something it cannot deliver, and somebody
 * would eventually make the trigger match the screen.
 *
 * The one field that looks like an escape hatch is `amendReason` on
 * `amendSummary`, and it is the opposite: it is what makes an amendment
 * possible at all, and the database refuses a version 2 without it.
 */

const uuid = z.string().uuid();
const iso = z.string().datetime({ offset: true });

/** A paragraph somebody will read under stress. Ten characters is a placeholder. */
const paragraph = z.string().trim().min(10).max(20_000);

export const initiateSchema = z.object({
  admissionId: uuid,
  patientId: uuid,
  kind: z.enum(['routine', 'referred_out', 'transferred_out', 'died']).default('routine'),
  destination: z.enum(['home', 'another_hospital', 'hospice', 'rehab', 'mortuary']).optional(),
  followUpAt: iso.optional(),
  followUpWith: z.string().trim().min(1).max(160).optional(),
});
export type InitiateRequest = z.infer<typeof initiateSchema>;

/**
 * One medicine's decision.
 *
 * `action` has no `unresolved` member. Unresolved is the state a row is born
 * in, not a decision anybody records — offering it here would let a screen
 * "resolve" a medicine by re-asserting that nobody had decided.
 */
export const reconcileSchema = z.object({
  drugName: z.string().trim().min(1).max(200),
  homeDose: z.string().trim().max(120).optional(),
  inpatientDose: z.string().trim().max(120).optional(),
  dischargeDose: z.string().trim().max(120).optional(),
  action: z.enum(['continue_same', 'stop', 'change', 'new_medicine']),
  /** Required by the database for everything except `continue_same`. */
  reason: z.string().trim().min(3).max(2000).optional(),
});
export type ReconcileRequest = z.infer<typeof reconcileSchema>;

export const reconcileBatchSchema = z.object({
  medicines: z.array(reconcileSchema).min(1).max(60),
});
export type ReconcileBatchRequest = z.infer<typeof reconcileBatchSchema>;

const summaryBody = {
  patientId: uuid,
  admissionDiagnosis: z.string().trim().max(4000).optional(),
  finalDiagnosis: paragraph,
  icd10Codes: z.array(z.string().trim().min(1).max(12)).max(20).default([]),
  proceduresPerformed: z.array(z.string().trim().min(1).max(300)).max(30).default([]),
  courseInHospital: paragraph,
  significantFindings: z.string().trim().max(20_000).optional(),
  conditionOnDischarge: paragraph,
  dischargeMedications: z.array(z.record(z.string(), z.unknown())).max(60).optional(),
  followUpPlan: paragraph,
  /**
   * What to come back for. The database enforces a floor of ten characters,
   * because "as advised" is the sentence a patient dies at home behind.
   */
  redFlagAdvice: paragraph,
  dietAdvice: z.string().trim().max(4000).optional(),
  patientCopyLocale: z.string().trim().max(12).optional(),
};

export const draftSummarySchema = z.object(summaryBody);
export type DraftSummaryRequest = z.infer<typeof draftSummarySchema>;

export const amendSummarySchema = z.object({
  ...summaryBody,
  amendReason: z.string().trim().min(10).max(2000),
});
export type AmendSummaryRequest = z.infer<typeof amendSummarySchema>;

export const damaSchema = z.object({
  risksExplained: paragraph,
  witnessName: z.string().trim().min(1).max(160),
});
export type DamaRequest = z.infer<typeof damaSchema>;

export const completeSchema = z.object({
  destination: z.enum(['home', 'another_hospital', 'hospice', 'rehab', 'mortuary', 'absconded']).optional(),
  gatePassNo: z.string().trim().max(60).optional(),
});
export type CompleteRequest = z.infer<typeof completeSchema>;

export const dischargeQuerySchema = z.object({
  /** Still open: initiated, nobody has left yet. */
  openOnly: queryFlag().default(true),
  kind: z.enum(['routine', 'dama', 'absconded', 'referred_out', 'transferred_out', 'died']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type DischargeQuery = z.infer<typeof dischargeQuerySchema>;

// ─────────────────────────────────────────────────────────────────────────────
// IP-017
// ─────────────────────────────────────────────────────────────────────────────

export const declareDeathSchema = z.object({
  patientId: uuid,
  admissionId: uuid.optional(),
  mlcId: uuid.optional(),
  declaredAt: iso,
  causeOfDeath: paragraph,
  /** The numbered tag. Every later identification is checked against it. */
  bodyTagNo: z.string().trim().min(1).max(40),
  postMortemRequired: z.boolean().default(false),
});
export type DeclareDeathRequest = z.infer<typeof declareDeathSchema>;

export const receiveBodySchema = z.object({
  /** Scanned at the mortuary door and compared with the tag on the file. */
  bodyTagScan: z.string().trim().min(1).max(40),
  coldStorageUnit: z.string().trim().min(1).max(40),
  lastOfficeDone: z.boolean().default(false),
});
export type ReceiveBodyRequest = z.infer<typeof receiveBodySchema>;

export const mccdSchema = z.object({
  /** Form 4 for an institutional death, 4A otherwise. */
  mccdForm: z.enum(['4', '4A']),
  mccdNo: z.string().trim().min(1).max(60),
  registrarReportedAt: iso.optional(),
});
export type MccdRequest = z.infer<typeof mccdSchema>;

export const postMortemSchema = z.object({
  postMortemAt: iso,
  postMortemRef: z.string().trim().min(1).max(60),
});
export type PostMortemRequest = z.infer<typeof postMortemSchema>;

export const verifyNokSchema = z.object({
  nokName: z.string().trim().min(1).max(200),
  nokRelationship: z.string().trim().min(1).max(60),
  nokIdType: z.enum(['aadhaar', 'voter_id', 'passport', 'driving_licence', 'ration_card', 'other']),
  nokIdRef: z.string().trim().min(1).max(80),
});
export type VerifyNokRequest = z.infer<typeof verifyNokSchema>;

/**
 * Releasing the body.
 *
 * Two fields. The tag is scanned again at the door — the same two-tag rule as
 * receiving — and a note may be added. There is nothing here that could
 * substitute for the certificate, the verified claimant, the closed MLC or the
 * post-mortem, because the database will not accept a substitute for any of them.
 */
export const releaseSchema = z.object({
  bodyTagScan: z.string().trim().min(1).max(40),
  releaseNote: z.string().trim().max(4000).optional(),
});
export type ReleaseRequest = z.infer<typeof releaseSchema>;

export const mortuaryQuerySchema = z.object({
  /** Bodies still in the building. */
  inHouseOnly: queryFlag().default(true),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type MortuaryQuery = z.infer<typeof mortuaryQuerySchema>;
