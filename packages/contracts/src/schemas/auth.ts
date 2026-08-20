/**
 * Auth DTOs (EN-007 §6, EN-025 §6).
 *
 * These schemas are the *same objects* the browser validates against and the API
 * validates with — `docs/02 §2`: "one schema validates client & server". A field
 * the server rejects is therefore a field the form could never have submitted,
 * which is what stops the class of bug where client and server disagree about
 * what "valid" means.
 */
import { z } from 'zod';

// ── shared field primitives ──────────────────────────────────────────────────

/** Indian mobile: 10 digits starting 6–9, optionally +91 prefixed. */
export const indianMobileSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, '').replace(/^(\+?91)/, ''))
  .refine((v) => /^[6-9]\d{9}$/.test(v), {
    message: 'Enter a 10-digit Indian mobile number starting with 6, 7, 8 or 9',
  });

export const emailSchema = z.string().trim().toLowerCase().email().max(254);

/**
 * Identifier accepted at `/login`: username, email or employee id.
 * Deliberately loose — `docs/04 §6` forbids account enumeration, so the login
 * endpoint must not reveal *which* identifier shapes exist.
 */
export const loginIdentifierSchema = z.string().trim().min(3).max(254);

/**
 * Password policy is enforced server-side from `core.auth_policies` because a
 * hospital can change it (EN-007 §3.4.1). This schema only rejects what is
 * *never* acceptable, so the client can give instant feedback without hard-coding
 * the tenant's policy.
 */
export const passwordSchema = z
  .string()
  .min(12, 'Use at least 12 characters')
  .max(200)
  .refine((v) => !/^\s|\s$/.test(v), 'Password cannot start or end with a space');

export const totpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app');

export const otpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{4,8}$/, 'Enter the code sent to your mobile');

export const pinSchema = z
  .string()
  .trim()
  .regex(/^\d{4,6}$/, 'Your PIN is 4 to 6 digits');

// ── login ────────────────────────────────────────────────────────────────────

export const loginRequestSchema = z.object({
  identifier: loginIdentifierSchema,
  password: z.string().min(1).max(200),
  /**
   * Set by the browser after device registration. Lets the server apply
   * device-bound session policy and print-workstation mapping (EN-005 §3.2).
   */
  deviceFingerprint: z.string().max(128).optional(),
  /** Remember this device for MFA, if policy allows (EN-007 §3.4.2). */
  rememberDevice: z.boolean().default(false),
});

export type LoginRequest = z.infer<typeof loginRequestSchema>;

/**
 * `docs/05 §Login/UX flow`: identifier → password/OTP/SSO → 2FA → choose branch
 * (if >1) → role home. The response models each of those stops explicitly so the
 * client never has to guess what to render next.
 */
export const loginChallengeSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('mfa_required'),
    challengeToken: z.string(),
    methods: z.array(z.enum(['totp', 'webauthn', 'sms', 'email'])),
    /** True when the role mandates MFA and enrolment has not happened yet. */
    enrolmentRequired: z.boolean(),
    /** Days left in the enrolment grace period, if any. */
    graceDaysRemaining: z.number().int().nonnegative().nullable(),
  }),
  z.object({
    status: z.literal('branch_selection_required'),
    challengeToken: z.string(),
    branches: z.array(
      z.object({
        branchId: z.string().uuid(),
        code: z.string(),
        name: z.string(),
        city: z.string().nullable(),
        /** Per-branch colour token so the shell can band correctly (EN-041 §3.7). */
        colourToken: z.string(),
        roles: z.array(z.string()),
      }),
    ),
  }),
  z.object({
    status: z.literal('password_change_required'),
    challengeToken: z.string(),
    reason: z.enum(['first_login', 'admin_reset', 'expired']),
  }),
  z.object({
    status: z.literal('authenticated'),
    /** Short-lived access token. The refresh token is an httpOnly cookie only. */
    accessToken: z.string(),
    expiresInSeconds: z.number().int().positive(),
    session: z.object({
      sessionId: z.string().uuid(),
      hospitalId: z.string().uuid(),
      branchId: z.string().uuid().nullable(),
      /** Where `/login` should route to (docs/05 §Login/UX flow step 1). */
      homeWorkspace: z.string(),
      /** Multi-role users get a switcher (docs/05 §Login model). */
      availableWorkspaces: z.array(
        z.object({ workspace: z.string(), roleKey: z.string(), roleName: z.string() }),
      ),
    }),
  }),
  z.object({
    status: z.literal('use_sso'),
    /** Force-SSO is on for staff; the client redirects rather than showing an error. */
    providerKey: z.string(),
    providerName: z.string(),
  }),
]);

export type LoginChallenge = z.infer<typeof loginChallengeSchema>;

export const mfaVerifyRequestSchema = z.object({
  challengeToken: z.string().min(1),
  method: z.enum(['totp', 'webauthn', 'sms', 'email', 'recovery_code']),
  code: z.string().min(4).max(64),
  rememberDevice: z.boolean().default(false),
});

export const mfaEnrolRequestSchema = z.object({ method: z.enum(['totp', 'webauthn']) });

export const mfaEnrolResponseSchema = z.object({
  method: z.enum(['totp', 'webauthn']),
  /** `otpauth://` URI for the QR code. Only returned once, never re-readable. */
  provisioningUri: z.string().optional(),
  secretMasked: z.string().optional(),
  /** Shown exactly once; only their hashes are stored (EN-007 §4). */
  recoveryCodes: z.array(z.string()).optional(),
});

export const mfaConfirmRequestSchema = z.object({
  method: z.enum(['totp', 'webauthn']),
  code: z.string().min(4).max(64),
});

export const branchSelectRequestSchema = z.object({
  challengeToken: z.string().min(1),
  branchId: z.string().uuid(),
});

export const passwordChangeRequestSchema = z
  .object({
    currentPassword: z.string().min(1).max(200).optional(),
    challengeToken: z.string().optional(),
    newPassword: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    message: 'The two passwords do not match',
    path: ['confirmPassword'],
  })
  .refine((v) => v.currentPassword !== undefined || v.challengeToken !== undefined, {
    message: 'Either the current password or a challenge token is required',
    path: ['currentPassword'],
  });

export const passwordForgotRequestSchema = z.object({
  identifier: loginIdentifierSchema,
});

export const passwordResetRequestSchema = z
  .object({
    token: z.string().min(16).max(512),
    newPassword: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    message: 'The two passwords do not match',
    path: ['confirmPassword'],
  });

// ── patient OTP login (docs/05 §Login model) ─────────────────────────────────

export const otpRequestSchema = z.object({
  mobile: indianMobileSchema,
  purpose: z.enum(['patient_login', 'family_link', 'verification']).default('patient_login'),
});

export const otpVerifyRequestSchema = z.object({
  mobile: indianMobileSchema,
  code: otpCodeSchema,
});

// ── PIN quick re-auth (EN-007 §3.4.6) ────────────────────────────────────────

export const pinVerifyRequestSchema = z.object({ pin: pinSchema });

export const pinSetRequestSchema = z
  .object({
    pin: pinSchema,
    confirmPin: z.string(),
    /** Re-authentication is required to set a PIN. */
    currentPassword: z.string().min(1).max(200),
  })
  .refine((v) => v.pin === v.confirmPin, { message: 'The two PINs do not match', path: ['confirmPin'] })
  .refine((v) => !/^(\d)\1+$/.test(v.pin), { message: 'Do not use the same digit repeated', path: ['pin'] })
  .refine((v) => !['1234', '12345', '123456', '0000'].includes(v.pin), {
    message: 'That PIN is too easy to guess',
    path: ['pin'],
  });

// ── step-up (EN-025 §3.6) ────────────────────────────────────────────────────

export const stepUpRequestSchema = z.object({
  actionKey: z.string().min(3).max(96),
});

export const stepUpChallengeSchema = z.object({
  satisfied: z.boolean(),
  requiredAcr: z.string(),
  maxAgeSeconds: z.number().int().positive(),
  /** How the user can satisfy it right now, given what they have enrolled. */
  availableMethods: z.array(z.enum(['totp', 'webauthn', 'pin', 'reauth_idp'])),
  challengeToken: z.string().nullable(),
});

export const stepUpVerifyRequestSchema = z.object({
  challengeToken: z.string().min(1),
  method: z.enum(['totp', 'webauthn', 'pin']),
  code: z.string().min(4).max(64),
});

// ── second-person authorisation (docs/05 §SoD, docs/06 §6.9 level 6) ─────────

/**
 * `docs/06 §6.9` friction level 6: "second user authenticates on the same or
 * their own device; the same user can never be both".
 */
export const secondPersonAuthSchema = z.object({
  identifier: loginIdentifierSchema,
  credential: z.string().min(4).max(200),
  credentialKind: z.enum(['password', 'pin', 'totp']),
  /** What the second person is co-signing, so the audit row is meaningful. */
  actionKey: z.string().min(3).max(96),
});

// ── session ──────────────────────────────────────────────────────────────────

export const sessionSummarySchema = z.object({
  sessionId: z.string().uuid(),
  current: z.boolean(),
  deviceLabel: z.string(),
  userAgent: z.string().nullable(),
  /** Coarse only — city/region, never a precise location (docs/04 §4). */
  location: z.string().nullable(),
  method: z.enum(['password', 'sso', 'otp', 'device', 'impersonation', 'break_glass']),
  createdAt: z.string().datetime({ offset: true }),
  lastSeenAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
});

export const meResponseSchema = z.object({
  userId: z.string().uuid(),
  username: z.string(),
  displayName: z.string(),
  email: z.string().nullable(),
  photoUrl: z.string().nullable(),
  hospital: z.object({
    hospitalId: z.string().uuid(),
    name: z.string(),
    timezone: z.string(),
    currency: z.string(),
    locale: z.string(),
    enabledLocales: z.array(z.string()),
    fiscalYearStartMonth: z.number().int().min(1).max(12),
  }),
  branch: z
    .object({
      branchId: z.string().uuid(),
      code: z.string(),
      name: z.string(),
      colourToken: z.string(),
      timezone: z.string(),
    })
    .nullable(),
  grantedBranches: z.array(
    z.object({ branchId: z.string().uuid(), code: z.string(), name: z.string(), colourToken: z.string() }),
  ),
  scope: z.enum(['branch', 'entity', 'group']),
  roles: z.array(
    z.object({
      roleId: z.string().uuid(),
      key: z.string(),
      name: z.string(),
      branchId: z.string().uuid().nullable(),
    }),
  ),
  /** Flat permission set — the left nav is generated from exactly this (docs/06 §4.1). */
  permissions: z.array(z.string()),
  homeWorkspace: z.string(),
  availableWorkspaces: z.array(
    z.object({ workspace: z.string(), roleKey: z.string(), roleName: z.string() }),
  ),
  preferences: z.object({
    locale: z.string(),
    theme: z.enum(['light', 'dark', 'system']),
    density: z.enum(['compact', 'default', 'touch']),
    highContrast: z.boolean(),
    fontScale: z.number(),
  }),
  mfa: z.object({
    enabled: z.boolean(),
    methods: z.array(z.string()),
    mandatory: z.boolean(),
    graceDaysRemaining: z.number().int().nullable(),
  }),
  pinSet: z.boolean(),
  /** Non-null while an impersonation session is active; the banner cannot be hidden. */
  impersonation: z
    .object({ impersonatorName: z.string(), mode: z.enum(['read', 'write']), expiresAt: z.string() })
    .nullable(),
  /** Licence state so the shell can render the degradation banner (EN-040 §8). */
  licence: z.object({
    status: z.string(),
    degradeTier: z.number().int().min(0).max(4),
    expiresAt: z.string().nullable(),
    bannerMessage: z.string().nullable(),
  }),
  /** Read-only mode, e.g. during DB failover (docs/06 §6.7). */
  readOnlyMode: z.object({
    active: z.boolean(),
    since: z.string().nullable(),
    reason: z.string().nullable(),
  }),
});

export type MeResponse = z.infer<typeof meResponseSchema>;
