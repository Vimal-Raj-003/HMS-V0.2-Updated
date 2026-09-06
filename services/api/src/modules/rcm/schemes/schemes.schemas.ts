import { z } from 'zod';
import { queryFlag } from '@vims/contracts';

/** RC-007 request contracts. */
const uuid = z.string().uuid();
const money = z.coerce.number().min(0).max(99_999_999.99);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date is YYYY-MM-DD');

export const idSchema = uuid;
export const pageLimit = z.coerce.number().int().min(1).max(200).default(50);

export const SCHEME_TYPES = ['pmjay', 'cghs', 'echs', 'esic', 'state', 'other'] as const;
export const CASH_BLOCK_SCOPES = ['active_case', 'always', 'off'] as const;
export const CLAIM_FORMATS = [
  'pmjay_json',
  'cghs_pdf',
  'echs_xml',
  'esic_csv',
  'state_csv',
  'manual',
] as const;
export const VERIFICATION_METHODS = ['portal', 'api', 'biometric', 'otp', 'card', 'manual'] as const;
export const VERIFICATION_OUTCOMES = [
  'verified',
  'not_found',
  'mismatch',
  'expired',
  'exhausted',
  'error',
] as const;
export const CASE_STATUSES = [
  'open',
  'preauth_pending',
  'approved',
  'in_treatment',
  'discharged',
  'claim_submitted',
  'settled',
  'rejected',
  'closed',
] as const;
export const COLLECTION_POINTS = [
  'cash_counter',
  'pharmacy',
  'advance',
  'ip_deposit',
  'api',
  'other',
] as const;
export const SHORTFALL_CATEGORIES = [
  'deduction',
  'disallowance',
  'rate_difference',
  'non_payable',
  'window_missed',
  'document_deficiency',
] as const;

export const schemeQuerySchema = z.object({
  type: z.enum(SCHEME_TYPES).optional(),
  activeOnly: queryFlag().default(true),
  limit: pageLimit,
});
export type SchemeQuery = z.infer<typeof schemeQuerySchema>;

export const createSchemeSchema = z.object({
  code: z.string().trim().min(1).max(24),
  name: z.string().trim().min(1).max(160),
  type: z.enum(SCHEME_TYPES),
  authority: z.string().trim().max(160).optional(),
  stateCode: z.string().trim().max(8).optional(),
  empanelmentNo: z.string().trim().max(64).optional(),
  /**
   * How far the cash block reaches. `active_case` is the default and the one
   * §5.6 is really about; `always` exists for a scheme whose MoU is absolute.
   * `off` records the attempt and lets the tender through — for a scheme that
   * genuinely permits a co-payment.
   */
  cashBlockScope: z.enum(CASH_BLOCK_SCOPES).default('active_case'),
  requiresPreauth: z.boolean().default(true),
  claimFormat: z.enum(CLAIM_FORMATS).default('manual'),
  claimWindowDays: z.coerce.number().int().min(1).max(365).default(30),
  effectiveFrom: isoDate,
});
export type CreateSchemeRequest = z.infer<typeof createSchemeSchema>;

export const packageQuerySchema = z.object({
  schemeId: uuid.optional(),
  search: z.string().trim().max(120).optional(),
  limit: pageLimit,
});
export type PackageQuery = z.infer<typeof packageQuerySchema>;

export const captureBeneficiarySchema = z.object({
  schemeId: uuid,
  patientId: uuid,
  memberId: z.string().trim().min(1).max(64),
  familyId: z.string().trim().max(64).optional(),
  nameOnCard: z.string().trim().max(200).optional(),
  relation: z.enum(['self', 'spouse', 'child', 'parent', 'dependent']).default('self'),
  validFrom: isoDate.optional(),
  validTill: isoDate.optional(),
});
export type CaptureBeneficiaryRequest = z.infer<typeof captureBeneficiarySchema>;

/**
 * Record what the authority said.
 *
 * A `verified` outcome needs the entitlement, because "eligible" with no balance
 * is not something a desk can plan an admission against — and because from this
 * moment the patient tenders no cash, which is too consequential to turn on
 * without a number behind it.
 */
export const verifyBeneficiarySchema = z
  .object({
    method: z.enum(VERIFICATION_METHODS),
    outcome: z.enum(VERIFICATION_OUTCOMES),
    entitlementAmount: money.optional(),
    entitlementBalance: money.optional(),
    validFrom: isoDate.optional(),
    validTill: isoDate.optional(),
    verificationRef: z.string().trim().max(120).optional(),
    message: z.string().trim().max(2000).optional(),
  })
  .refine((v) => v.outcome !== 'verified' || v.entitlementBalance !== undefined, {
    message: 'A verified entitlement needs the balance the authority reported.',
  })
  .refine(
    (v) =>
      v.entitlementAmount === undefined ||
      v.entitlementBalance === undefined ||
      v.entitlementBalance <= v.entitlementAmount,
    { message: 'The remaining balance cannot exceed the entitlement.' },
  );
export type VerifyBeneficiaryRequest = z.infer<typeof verifyBeneficiarySchema>;

export const caseQuerySchema = z.object({
  status: z.enum(CASE_STATUSES).optional(),
  patientId: uuid.optional(),
  schemeId: uuid.optional(),
  limit: pageLimit,
});
export type SchemeCaseQuery = z.infer<typeof caseQuerySchema>;

export const openCaseSchema = z.object({
  schemeId: uuid,
  beneficiaryId: uuid,
  encounterId: uuid.optional(),
  admissionId: uuid.optional(),
  admittedAt: z.string().datetime().optional(),
});
export type OpenSchemeCaseRequest = z.infer<typeof openCaseSchema>;

export const addCasePackageSchema = z.object({
  packageId: uuid,
  quantity: z.coerce.number().int().min(1).max(20).default(1),
  implantAmount: money.default(0),
  isPrimary: z.boolean().default(false),
});
export type AddCasePackageRequest = z.infer<typeof addCasePackageSchema>;

export const updateCaseSchema = z.object({
  status: z.enum(CASE_STATUSES).optional(),
  authorityCaseNo: z.string().trim().max(64).optional(),
  admittedAt: z.string().datetime().optional(),
  dischargedAt: z.string().datetime().optional(),
});
export type UpdateSchemeCaseRequest = z.infer<typeof updateCaseSchema>;

export const closeCaseSchema = z.object({ reason: z.string().trim().min(1).max(1000) });
export type CloseSchemeCaseRequest = z.infer<typeof closeCaseSchema>;

/**
 * Ask whether this patient may tender cash right now, and record the answer.
 *
 * Every collection point calls this *before* it opens the drawer. The database
 * trigger is the guarantee; this is what turns the guarantee into a sentence the
 * cashier can read and a row an auditor can count.
 */
export const cashCheckSchema = z.object({
  patientId: uuid,
  amount: money,
  mode: z.string().trim().min(1).max(24).default('cash'),
  collectionPoint: z.enum(COLLECTION_POINTS).default('cash_counter'),
});
export type CashCheckRequest = z.infer<typeof cashCheckSchema>;

export const cashAttemptQuerySchema = z.object({
  patientId: uuid.optional(),
  schemeId: uuid.optional(),
  limit: pageLimit,
});
export type CashAttemptQuery = z.infer<typeof cashAttemptQuerySchema>;

export const claimQuerySchema = z.object({
  status: z.string().trim().max(24).optional(),
  caseId: uuid.optional(),
  limit: pageLimit,
});
export type ClaimQuery = z.infer<typeof claimQuerySchema>;

export const assembleClaimSchema = z.object({
  caseId: uuid,
  /**
   * The checklist. Passed rather than derived so a scheme that has just changed
   * its requirements can be satisfied today; the defaults cover the four every
   * scheme asks for.
   */
  requiredDocuments: z
    .array(z.string().trim().min(1).max(40))
    .max(20)
    .default(['discharge_summary', 'case_sheet', 'investigation', 'id_proof']),
});
export type AssembleClaimRequest = z.infer<typeof assembleClaimSchema>;

export const attachDocumentSchema = z.object({
  docType: z.string().trim().min(1).max(40),
  fileId: uuid,
});
export type AttachDocumentRequest = z.infer<typeof attachDocumentSchema>;

export const submitClaimSchema = z.object({ reason: z.string().trim().min(1).max(1000) });
export type SubmitClaimRequest = z.infer<typeof submitClaimSchema>;

/**
 * What the authority decided, and what it paid.
 *
 * The per-line breakdown is required for anything short of a full approval: a
 * lump-sum deduction with no line behind it cannot be appealed, and an appeal is
 * the only way that money comes back.
 */
export const recordClaimDecisionSchema = z
  .object({
    status: z.enum(['approved', 'partially_approved', 'rejected', 'paid']),
    approvedAmount: money,
    paidAmount: money.optional(),
    utr: z.string().trim().max(60).optional(),
    authorityClaimNo: z.string().trim().max(64).optional(),
    remarks: z.string().trim().max(2000).optional(),
    lineDecisions: z
      .array(
        z.object({
          lineId: uuid,
          approvedAmount: money,
          disallowReason: z.string().trim().max(500).optional(),
        }),
      )
      .max(100)
      .default([]),
    shortfallCategory: z.enum(SHORTFALL_CATEGORIES).optional(),
    shortfallReasonCode: z.string().trim().max(40).optional(),
    reason: z.string().trim().min(1).max(1000),
  })
  .refine((v) => v.status !== 'paid' || (v.paidAmount !== undefined && v.paidAmount > 0), {
    message: 'A paid claim needs the amount that actually arrived.',
  });
export type RecordClaimDecisionRequest = z.infer<typeof recordClaimDecisionSchema>;

export const shortfallQuerySchema = z.object({
  status: z.enum(['open', 'appealed', 'recovered', 'written_off']).optional(),
  limit: pageLimit,
});
export type ShortfallQuery = z.infer<typeof shortfallQuerySchema>;

export const appealShortfallSchema = z.object({
  action: z.enum(['appeal', 'request_writeoff']),
  appealRef: z.string().trim().max(64).optional(),
  reason: z.string().trim().min(1).max(1000),
});
export type AppealShortfallRequest = z.infer<typeof appealShortfallSchema>;

export const approveWriteOffSchema = z.object({ reason: z.string().trim().min(1).max(1000) });
export type ApproveWriteOffRequest = z.infer<typeof approveWriteOffSchema>;
