/**
 * Admin console DTOs (EN-007 §6, EN-041 §6).
 */
import { z } from 'zod';
import { abacConditionsSchema } from '../rbac/abac.js';
import { emailSchema, indianMobileSchema } from './auth.js';

// ── users ────────────────────────────────────────────────────────────────────

export const userTypeSchema = z.enum(['staff', 'external', 'partner', 'device', 'service', 'patient']);
export const userStatusSchema = z.enum(['invited', 'active', 'locked', 'suspended', 'deactivated']);

export const personNameSchema = z.object({
  /** Family name is emphasised in the patient banner and on documents (docs/06 §4.2). */
  family: z.string().trim().min(1).max(120),
  given: z.string().trim().min(1).max(120),
  middle: z.string().trim().max(120).optional(),
  prefix: z.string().trim().max(32).optional(),
  suffix: z.string().trim().max(32).optional(),
});

export const professionalDetailsSchema = z.object({
  /** Medical council registration number — printed on every prescription (NMC norms). */
  registrationNo: z.string().trim().max(64).optional(),
  council: z.string().trim().max(120).optional(),
  /** ABDM Healthcare Professional Registry id (EN-011). */
  hprId: z.string().trim().max(64).optional(),
  speciality: z.string().trim().max(120).optional(),
  qualification: z.string().trim().max(200).optional(),
  /** Signature image for reports; changing it requires approval (EN-007 §3.2.3). */
  signatureFileId: z.string().uuid().optional(),
});

export const createUserRequestSchema = z.object({
  username: z.string().trim().min(3).max(64).regex(/^[a-zA-Z0-9._-]+$/, 'Letters, numbers, dot, underscore and hyphen only'),
  email: emailSchema.optional(),
  mobile: indianMobileSchema.optional(),
  name: personNameSchema,
  employeeId: z.string().trim().max(64).optional(),
  type: userTypeSchema.default('staff'),
  professional: professionalDetailsSchema.optional(),
  preferences: z
    .object({
      locale: z.string().max(16).optional(),
      theme: z.enum(['light', 'dark', 'system']).optional(),
    })
    .optional(),
  /** At least one role assignment, or the user lands on an empty workspace. */
  roleAssignments: z
    .array(
      z.object({
        roleId: z.string().uuid(),
        branchId: z.string().uuid().nullable(),
        scope: abacConditionsSchema.default({}),
        validFrom: z.string().datetime({ offset: true }).optional(),
        validTo: z.string().datetime({ offset: true }).nullable().optional(),
      }),
    )
    .min(1, 'Assign at least one role, or the user will have nowhere to land'),
  /** Invitation channel. Expiry is 48 h (EN-007 §3.2.1). */
  inviteVia: z.enum(['email', 'sms', 'none']).default('email'),
});

export type CreateUserRequest = z.infer<typeof createUserRequestSchema>;

export const updateUserRequestSchema = createUserRequestSchema
  .partial()
  .omit({ roleAssignments: true, inviteVia: true, username: true })
  .extend({ version: z.number().int().nonnegative() });

export const deactivateUserRequestSchema = z.object({
  reason: z.string().trim().min(5, 'A reason is required and is recorded in the audit log').max(500),
  /** Who inherits their pending approvals (EN-038 §3.5 bulk reassignment). */
  reassignApprovalsToUserId: z.string().uuid().optional(),
});

export const listUsersQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: userStatusSchema.optional(),
  roleKey: z.string().max(64).optional(),
  branchId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(),
  /** Dormant-account hygiene report (EN-007 §10). */
  noLoginSinceDays: z.coerce.number().int().min(1).max(3650).optional(),
  cursor: z.string().max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

// ── roles ────────────────────────────────────────────────────────────────────

export const createRoleRequestSchema = z.object({
  key: z.string().trim().min(3).max(64).regex(/^[a-z][a-z0-9_]*$/, 'Lower snake_case'),
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(1000),
  /** Clone from a system template rather than starting blank (EN-007 §3.3.2). */
  templateKey: z.string().max(64).optional(),
  permissions: z.array(z.string().min(3).max(96)),
  abacDefaults: abacConditionsSchema.default({}),
  homeWorkspace: z.string().min(3).max(64),
});

export const updateRoleRequestSchema = createRoleRequestSchema.partial().omit({ key: true }).extend({
  version: z.number().int().nonnegative(),
  /** Every role edit needs a reason: it changes who can do what (EN-007 §5). */
  reason: z.string().trim().min(5).max(500),
});

export const assignRoleRequestSchema = z.object({
  roleId: z.string().uuid(),
  branchId: z.string().uuid().nullable(),
  scope: abacConditionsSchema.default({}),
  validFrom: z.string().datetime({ offset: true }).optional(),
  /** Temporary elevation, e.g. a covering pharmacist for 7 days (EN-007 §3.2.3). */
  validTo: z.string().datetime({ offset: true }).nullable().optional(),
  justification: z.string().trim().min(5).max(1000),
});

/** EN-007 §3.3.5: "Effective permission simulator: pick user + context → shows allowed actions and why". */
export const policySimulateRequestSchema = z.object({
  userId: z.string().uuid(),
  action: z.string().min(3).max(96),
  resource: z.object({
    type: z.string().min(1).max(64),
    id: z.string().optional(),
    branchId: z.string().uuid().nullable().optional(),
    departmentId: z.string().uuid().nullable().optional(),
    wardId: z.string().uuid().nullable().optional(),
    patientId: z.string().uuid().nullable().optional(),
    amount: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
    percent: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  }),
});

export const policySimulateResponseSchema = z.object({
  allowed: z.boolean(),
  reason: z.string().nullable(),
  /** The rule trace — why, step by step. This is the whole point of the simulator. */
  trace: z.array(z.string()),
  obligations: z.array(z.string()),
});

// ── settings ─────────────────────────────────────────────────────────────────

export const settingScopeSchema = z.enum(['hospital', 'branch', 'department', 'user']);

export const putSettingRequestSchema = z.object({
  key: z.string().min(3).max(128),
  scope: settingScopeSchema,
  scopeId: z.string().uuid().nullable(),
  value: z.unknown(),
  /** Required for `requiresApproval` and `dualControl` keys. */
  reason: z.string().trim().max(500).optional(),
});

// ── numbering series (EN-007 §3.1.4) ─────────────────────────────────────────

export const numberingResetPolicySchema = z.enum(['fy', 'year', 'month', 'day', 'never']);

export const createNumberingSeriesRequestSchema = z.object({
  key: z
    .string()
    .trim()
    .min(2)
    .max(48)
    .regex(/^[A-Z][A-Z0-9_]*$/, 'Upper SNAKE_CASE, e.g. BILL_OP'),
  scope: z.enum(['hospital', 'branch']),
  branchId: z.string().uuid().nullable(),
  /**
   * Pattern tokens: `{BR}` branch code, `{FY}` financial year (`2026-27`),
   * `{YYYY}`, `{YY}`, `{MM}`, `{DD}`, `{SEQ:n}` zero-padded sequence.
   * docs/03 §Numbering series gives `{BR}/{FY}/{SEQ:6}` as the worked example.
   */
  pattern: z
    .string()
    .min(3)
    .max(120)
    .regex(/\{SEQ:\d+\}/, 'The pattern must contain a {SEQ:n} token'),
  /**
   * `docs/03`: "gapless (row-locked `SELECT ... FOR UPDATE`) for invoices/receipts,
   * non-gapless (sequence) for tokens." A gapless series trades throughput for a
   * statutory guarantee, so it is an explicit choice, never a default.
   */
  gapless: z.boolean(),
  resetPolicy: numberingResetPolicySchema,
  startValue: z.number().int().nonnegative().default(0),
  effectiveFrom: z.string().datetime({ offset: true }).optional(),
});

export const numberingPreviewResponseSchema = z.object({
  key: z.string(),
  pattern: z.string(),
  currentValue: z.number().int(),
  nextNumber: z.string(),
  /** The next few, so an admin can see the shape before committing. */
  sample: z.array(z.string()),
  fy: z.string().nullable(),
});

// ── feature flags ────────────────────────────────────────────────────────────

export const putFeatureFlagRequestSchema = z.object({
  key: z.string().min(3).max(128),
  enabled: z.boolean(),
  branchId: z.string().uuid().nullable().optional(),
  roleKey: z.string().max(64).nullable().optional(),
  userId: z.string().uuid().nullable().optional(),
  rolloutPct: z.number().int().min(0).max(100).optional(),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
  note: z.string().max(500).optional(),
});

// ── devices (EN-007 §3.4.5) ──────────────────────────────────────────────────

export const deviceKindSchema = z.enum(['kiosk', 'tv', 'print_agent', 'workstation', 'mobile', 'analyzer']);

export const pairDeviceRequestSchema = z.object({
  pairingCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{6,10}$/, 'Enter the code shown on the device'),
  name: z.string().trim().min(1).max(120),
  kind: deviceKindSchema,
  branchId: z.string().uuid(),
  locationLabel: z.string().trim().max(160).optional(),
});

// ── audit viewer (EN-024 §6) ─────────────────────────────────────────────────

export const auditSearchQuerySchema = z.object({
  patientId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  entity: z.string().max(128).optional(),
  rowId: z.string().uuid().optional(),
  action: z.string().max(32).optional(),
  businessKey: z.string().max(128).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  breakGlassOnly: z.coerce.boolean().optional(),
  impersonatedOnly: z.coerce.boolean().optional(),
  deniedOnly: z.coerce.boolean().optional(),
  q: z.string().max(200).optional(),
  cursor: z.string().max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const breakGlassAccessRequestSchema = z.object({
  patientId: z.string().uuid(),
  reasonCode: z.enum([
    'emergency_cross_cover',
    'on_call_consult',
    'code_blue',
    'patient_request',
    'second_opinion',
    'quality_review',
    'medico_legal',
    'other',
  ]),
  reasonText: z.string().trim().min(10, 'Describe why you need this record — this is reviewed').max(1000),
});

export const breakGlassReviewRequestSchema = z.object({
  reviewStatus: z.enum(['justified', 'not_justified', 'explained']),
  reviewNote: z.string().trim().min(5).max(1000),
});

// ── impersonation (EN-007 §3.8) ──────────────────────────────────────────────

export const startImpersonationRequestSchema = z.object({
  targetUserId: z.string().uuid(),
  /** A support ticket reference is mandatory — no ticket, no impersonation. */
  ticketRef: z.string().trim().min(3).max(64),
  reason: z.string().trim().min(10).max(1000),
  mode: z.enum(['read', 'write']).default('read'),
});

// ── branch onboarding (EN-041 §3.9) ──────────────────────────────────────────

export const branchKindSchema = z.enum([
  'hospital',
  'branch',
  'satellite',
  'collection_centre',
  'daycare',
  'polyclinic',
  'warehouse',
]);

export const createBranchRequestSchema = z.object({
  code: z.string().trim().min(2).max(16).regex(/^[A-Z0-9-]+$/, 'Upper case letters, digits and hyphen'),
  name: z.string().trim().min(1).max(200),
  shortName: z.string().trim().min(1).max(40),
  kind: branchKindSchema,
  parentBranchId: z.string().uuid().nullable().optional(),
  /** A satellite that depends on a parent branch for lab processing (EN-041 §3.1). */
  servesFromBranchId: z.string().uuid().nullable().optional(),
  address: z.object({
    line1: z.string().trim().min(1).max(200),
    line2: z.string().trim().max(200).optional(),
    city: z.string().trim().min(1).max(120),
    district: z.string().trim().max(120).optional(),
    stateCode: z.string().trim().length(2),
    pincode: z.string().trim().regex(/^\d{6}$/, 'Six-digit PIN code'),
    country: z.string().trim().length(2).default('IN'),
  }),
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z\d]Z[A-Z\d]$/, 'Enter a valid 15-character GSTIN')
    .nullable()
    .optional(),
  timezone: z.string().min(3).max(64).default('Asia/Kolkata'),
  currency: z.string().length(3).default('INR'),
  residencyZone: z.string().min(2).max(8).default('in'),
  bedCount: z.number().int().nonnegative().default(0),
  moduleProfile: z.enum(['full_hospital', 'opd_only', 'collection_centre', 'daycare']),
  colourToken: z.string().min(3).max(32),
});

export const cloneBranchConfigRequestSchema = z.object({
  sourceBranchId: z.string().uuid(),
  sections: z
    .array(
      z.enum([
        'departments',
        'service_catalogue',
        'tariffs',
        'approval_matrices',
        'form_templates',
        'print_templates',
        'branding',
        'notification_routing',
        'queue_config',
        'working_calendar',
        'numbering_patterns',
      ]),
    )
    .min(1),
});

/**
 * `EN-041 §3.9.9`: go-live is gated on a scripted verification that includes an
 * explicit RLS-isolation check. `EN-041 §14 AC-13`: if any mandatory check fails,
 * go-live is blocked and the failing checks are listed with remediation hints.
 */
export const smokeTestCheckSchema = z.object({
  key: z.string(),
  label: z.string(),
  mandatory: z.boolean(),
  status: z.enum(['pending', 'running', 'passed', 'failed', 'skipped']),
  detail: z.string().nullable(),
  remediation: z.string().nullable(),
});

export const smokeTestResultSchema = z.object({
  branchId: z.string().uuid(),
  startedAt: z.string().datetime({ offset: true }),
  finishedAt: z.string().datetime({ offset: true }).nullable(),
  checks: z.array(smokeTestCheckSchema),
  allMandatoryPassed: z.boolean(),
  canGoLive: z.boolean(),
});

export type SmokeTestResult = z.infer<typeof smokeTestResultSchema>;
