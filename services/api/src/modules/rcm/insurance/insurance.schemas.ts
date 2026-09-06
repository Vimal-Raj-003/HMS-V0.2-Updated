import { z } from 'zod';

/** EN-002 + RC-002 request contracts. */
const uuid = z.string().uuid();
const money = z.coerce.number().min(0).max(99_999_999.99);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date is YYYY-MM-DD');

export const idSchema = uuid;
export const pageLimit = z.coerce.number().int().min(1).max(200).default(50);

export const PAYER_TYPES = ['insurer', 'tpa', 'corporate', 'government_scheme', 'embassy', 'other'] as const;
export const CASE_MODES = ['cashless', 'reimbursement', 'corporate_credit', 'scheme'] as const;
export const PREAUTH_TYPES = [
  'initial',
  'enhancement',
  'extension',
  'final_authorisation',
  'retrospective',
] as const;
export const PREAUTH_CHANNELS = ['portal', 'email', 'api', 'nhcx', 'fax', 'courier'] as const;

export const payerQuerySchema = z.object({
  payerType: z.enum(PAYER_TYPES).optional(),
  limit: pageLimit,
});
export type PayerQuery = z.infer<typeof payerQuerySchema>;

export const createPayerSchema = z.object({
  code: z.string().trim().min(1).max(32),
  name: z.string().trim().min(1).max(200),
  payerType: z.enum(PAYER_TYPES),
  irdaiRegNo: z.string().trim().max(40).optional(),
  portalUrl: z.string().trim().max(500).optional(),
});
export type CreatePayerRequest = z.infer<typeof createPayerSchema>;

export const capturePolicySchema = z.object({
  patientId: uuid,
  payerId: uuid,
  tpaId: uuid.optional(),
  planId: uuid.optional(),
  policyNo: z.string().trim().min(1).max(64),
  memberId: z.string().trim().max(64).optional(),
  holderName: z.string().trim().max(200).optional(),
  relationship: z.string().trim().max(32).optional(),
  sumInsured: money.optional(),
  validFrom: isoDate.optional(),
  validTo: isoDate.optional(),
});
export type CapturePolicyRequest = z.infer<typeof capturePolicySchema>;

export const openCaseSchema = z.object({
  patientId: uuid,
  payerId: uuid,
  policyId: uuid.optional(),
  tpaId: uuid.optional(),
  encounterId: uuid.optional(),
  admissionId: uuid.optional(),
  mode: z.enum(CASE_MODES).default('cashless'),
  priority: z.coerce.number().int().min(0).max(10).default(0),
});
export type OpenCaseRequest = z.infer<typeof openCaseSchema>;

export const caseQuerySchema = z.object({
  status: z.string().trim().max(24).optional(),
  patientId: uuid.optional(),
  limit: pageLimit,
});
export type CaseQuery = z.infer<typeof caseQuerySchema>;

export const createPreauthSchema = z.object({
  caseId: uuid,
  type: z.enum(PREAUTH_TYPES).default('initial'),
  parentRequestId: uuid.optional(),
  requestedAmount: money,
  diagnosisCodes: z.array(z.string().trim().max(16)).max(20).default([]),
  procedureCodes: z.array(z.string().trim().max(32)).max(20).default([]),
  isEmergency: z.boolean().default(false),
  doctorId: uuid.optional(),
  channel: z.enum(PREAUTH_CHANNELS).default('portal'),
});
export type CreatePreauthRequest = z.infer<typeof createPreauthSchema>;

export const submitPreauthSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
  /**
   * Hours the payer has to decide, from the empanelment SLA. Passed rather than
   * looked up so a desk can honour a contract the master has not caught up with,
   * and the value is recorded on the SLA event either way.
   */
  decisionHours: z.coerce.number().int().min(1).max(720).default(24),
});
export type SubmitPreauthRequest = z.infer<typeof submitPreauthSchema>;

/**
 * Record what the payer said.
 *
 * `approvedAmount` and `validTill` are required for every approving outcome —
 * the database refuses an approval without them, because "approved" with no
 * number is not something a biller can act on.
 */
export const recordDecisionSchema = z
  .object({
    status: z.enum(['approved', 'partially_approved', 'denied']),
    approvedAmount: money.optional(),
    approvedRoomClassId: uuid.optional(),
    approvedLosDays: z.coerce.number().int().min(0).max(365).optional(),
    validFrom: isoDate.optional(),
    validTill: isoDate.optional(),
    payerRefNo: z.string().trim().max(64).optional(),
    denialReasonCode: z.string().trim().max(40).optional(),
    reason: z.string().trim().min(1).max(1000),
  })
  .refine((v) => v.status === 'denied' || (v.approvedAmount !== undefined && v.validTill !== undefined), {
    message: 'An approval needs an amount and a validity date.',
  })
  .refine((v) => v.status !== 'denied' || v.denialReasonCode !== undefined, {
    message: 'A denial needs a reason code.',
  });
export type RecordDecisionRequest = z.infer<typeof recordDecisionSchema>;

export const raiseQuerySchema = z.object({
  category: z.enum(['medical', 'document', 'policy', 'billing', 'other']).default('medical'),
  text: z.string().trim().min(1).max(4000),
  slaHours: z.coerce.number().int().min(1).max(720).default(24),
});
export type RaiseQueryRequest = z.infer<typeof raiseQuerySchema>;

export const replyQuerySchema = z.object({
  replyText: z.string().trim().min(1).max(4000),
});
export type ReplyQueryRequest = z.infer<typeof replyQuerySchema>;

export const preauthQuerySchema = z.object({
  status: z.string().trim().max(24).optional(),
  caseId: uuid.optional(),
  limit: pageLimit,
});
export type PreauthListQuery = z.infer<typeof preauthQuerySchema>;

export const withdrawPreauthSchema = z.object({ reason: z.string().trim().min(1).max(1000) });
export type WithdrawPreauthRequest = z.infer<typeof withdrawPreauthSchema>;
