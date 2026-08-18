/**
 * The settings registry (EN-007 §3.1.2).
 *
 * "**Settings registry**: typed key/value settings (`core.settings`: scope
 * hospital/branch/department/user, key, value jsonb, schema ref, sensitivity)
 * declared by modules in code (`packages/contracts/settings.ts`), rendered in
 * Admin console with validation … changes audited with before/after; some require
 * approval (EN-038) or dual control."
 *
 * Declaring settings in code rather than as free-form rows is what makes the
 * admin console able to validate them, the audit diff able to describe them, and
 * a migration able to know which ones are secrets.
 */
import { z } from 'zod';

export type SettingScope = 'hospital' | 'branch' | 'department' | 'user';

export type SettingSensitivity =
  /** Freely readable and exportable. */
  | 'normal'
  /** Read requires a permission; shown but not exported. */
  | 'restricted'
  /** Encrypted at rest, masked in the UI and in every export (EN-007 §5). */
  | 'secret';

export interface SettingDefinition<T = unknown> {
  readonly key: string;
  readonly module: string;
  readonly label: string;
  readonly description: string;
  /** The narrowest scope at which it may be set; wider scopes inherit downward. */
  readonly scopes: readonly SettingScope[];
  readonly schema: z.ZodType<T>;
  readonly defaultValue: T;
  readonly sensitivity: SettingSensitivity;
  /** Changing it routes through EN-038. */
  readonly requiresApproval: boolean;
  /** Changing it needs two administrators (EN-007 §5). */
  readonly dualControl: boolean;
  /**
   * `docs/09 §10`: "New settings keys are diffed against an allow-list so a
   * future 'make it configurable' PR is caught." A setting marked here would, if
   * it existed, weaken a safety hard-stop — so the safety suite asserts that no
   * setting with this marker is ever added.
   */
  readonly wouldWeakenSafety?: false;
}

function s<T>(def: {
  key: string;
  module: string;
  label: string;
  description: string;
  scopes: readonly SettingScope[];
  schema: z.ZodType<T>;
  defaultValue: T;
  sensitivity?: SettingSensitivity;
  requiresApproval?: boolean;
  dualControl?: boolean;
}): SettingDefinition<T> {
  return {
    key: def.key,
    module: def.module,
    label: def.label,
    description: def.description,
    scopes: def.scopes,
    schema: def.schema,
    defaultValue: def.defaultValue,
    sensitivity: def.sensitivity ?? 'normal',
    requiresApproval: def.requiresApproval ?? false,
    dualControl: def.dualControl ?? false,
    wouldWeakenSafety: false,
  };
}

export const SETTING_DEFINITIONS: readonly SettingDefinition[] = Object.freeze([
  // ── EN-007: session & security policy ──────────────────────────────────────
  s({
    key: 'session.idle_timeout_min',
    module: 'EN-007',
    label: 'Idle timeout (minutes)',
    description:
      'Idle minutes before a session locks. docs/04 §2 sets the default at 15 with a warning at 13; clinical screens then allow PIN quick re-auth.',
    scopes: ['hospital', 'branch'],
    schema: z.number().int().min(5).max(60),
    defaultValue: 15,
    requiresApproval: true,
  }),
  s({
    key: 'session.absolute_lifetime_h',
    module: 'EN-007',
    label: 'Absolute session lifetime (hours)',
    description: 'Hard session expiry regardless of activity. docs/04 §2: 12 hours for staff.',
    scopes: ['hospital'],
    schema: z.number().int().min(1).max(24),
    defaultValue: 12,
    requiresApproval: true,
  }),
  s({
    key: 'session.pin_reauth_window_min',
    module: 'EN-007',
    label: 'PIN re-auth window (minutes)',
    description:
      'How long after idle-out a clinical screen may be unlocked with a PIN instead of a full login (EN-007 §3.4.6). Beyond this, a full login is required.',
    scopes: ['hospital'],
    schema: z.number().int().min(15).max(60),
    defaultValue: 60,
  }),
  s({
    key: 'session.concurrent_limit_default',
    module: 'EN-007',
    label: 'Concurrent sessions per user',
    description: 'EN-007 §3.5: default 3, kiosk 1. Exceeding it revokes the oldest session with a notice.',
    scopes: ['hospital'],
    schema: z.number().int().min(1).max(10),
    defaultValue: 3,
  }),
  s({
    key: 'password.min_length',
    module: 'EN-007',
    label: 'Minimum password length',
    description: 'docs/04 §2 default is 12.',
    scopes: ['hospital'],
    schema: z.number().int().min(12).max(64),
    defaultValue: 12,
    requiresApproval: true,
    dualControl: true,
  }),
  s({
    key: 'password.max_age_days',
    module: 'EN-007',
    label: 'Password maximum age (days)',
    description: 'docs/04 §2: 90-day rotation for privileged roles. 0 disables expiry (SSO users are exempt).',
    scopes: ['hospital'],
    schema: z.number().int().min(0).max(365),
    defaultValue: 90,
    requiresApproval: true,
  }),
  s({
    key: 'password.history_count',
    module: 'EN-007',
    label: 'Password history',
    description: 'How many previous passwords may not be reused. docs/04 §2: last 5.',
    scopes: ['hospital'],
    schema: z.number().int().min(0).max(24),
    defaultValue: 5,
  }),
  s({
    key: 'lockout.max_attempts',
    module: 'EN-007',
    label: 'Failed attempts before lockout',
    description: 'docs/04 §2: 5 attempts.',
    scopes: ['hospital'],
    schema: z.number().int().min(3).max(10),
    defaultValue: 5,
    requiresApproval: true,
  }),
  s({
    key: 'lockout.duration_min',
    module: 'EN-007',
    label: 'Lockout duration (minutes)',
    description: 'docs/04 §2: 15 minutes, progressive on repeat.',
    scopes: ['hospital'],
    schema: z.number().int().min(5).max(120),
    defaultValue: 15,
  }),
  s({
    key: 'otp.length',
    module: 'EN-007',
    label: 'Patient OTP length',
    description: 'EN-007 §3.4.4: 6 digits.',
    scopes: ['hospital'],
    schema: z.number().int().min(4).max(8),
    defaultValue: 6,
  }),
  s({
    key: 'otp.expiry_min',
    module: 'EN-007',
    label: 'Patient OTP expiry (minutes)',
    description: 'EN-007 §3.4.4: 5 minutes.',
    scopes: ['hospital'],
    schema: z.number().int().min(1).max(15),
    defaultValue: 5,
  }),
  s({
    key: 'otp.max_per_hour',
    module: 'EN-007',
    label: 'Patient OTP requests per hour',
    description: 'docs/04 §2: 5 per hour, rate-limited.',
    scopes: ['hospital'],
    schema: z.number().int().min(1).max(20),
    defaultValue: 5,
  }),
  s({
    key: 'mfa.grace_period_days',
    module: 'EN-007',
    label: 'MFA enrolment grace (days)',
    description:
      'EN-007 §5: users in MFA-mandatory roles may log in without enrolment for this many days. Capped at 7.',
    scopes: ['hospital'],
    schema: z.number().int().min(0).max(7),
    defaultValue: 7,
    requiresApproval: true,
  }),
  s({
    key: 'impersonation.max_duration_min',
    module: 'EN-007',
    label: 'Impersonation session limit (minutes)',
    description: 'EN-007 §3.8: auto-terminates at 30 minutes.',
    scopes: ['hospital'],
    schema: z.number().int().min(5).max(60),
    defaultValue: 30,
    dualControl: true,
  }),

  // ── EN-024: audit & privacy ────────────────────────────────────────────────
  s({
    key: 'audit.hot_partition_months',
    module: 'EN-024',
    label: 'Audit hot window (months)',
    description:
      'Months of audit kept in hot Postgres partitions before archival. docs/04 §5 and D-7 fix this at 12; the archive stays queryable within a 4-hour SLA.',
    scopes: ['hospital'],
    schema: z.number().int().min(12).max(96),
    defaultValue: 12,
    requiresApproval: true,
    dualControl: true,
  }),
  s({
    key: 'audit.notify_care_team_on_break_glass',
    module: 'EN-024',
    label: 'Tell the care team about break-glass access',
    description:
      'EN-024 §16 Q3 leaves this to the hospital: notify the care team when someone opens their patient via break-glass, or only the DPO. Default off; the DPO always sees it.',
    scopes: ['hospital'],
    schema: z.boolean(),
    defaultValue: false,
    requiresApproval: true,
  }),
  s({
    key: 'audit.break_glass_review_sla_hours',
    module: 'EN-024',
    label: 'Break-glass review SLA (hours)',
    description: 'How long a break-glass entry may sit unreviewed before it escalates.',
    scopes: ['hospital'],
    schema: z.number().int().min(24).max(336),
    defaultValue: 24,
  }),
  s({
    key: 'audit.vip_immediate_alert',
    module: 'EN-024',
    label: 'Immediate alert on VIP/sensitive record access',
    description:
      'EN-024 §3.2.4: records flagged VIP, staff-as-patient, MLC or restricted alert the DPO immediately rather than in the daily digest. Cannot be turned off.',
    scopes: ['hospital'],
    schema: z.literal(true),
    defaultValue: true,
  }),

  // ── EN-037: notifications ──────────────────────────────────────────────────
  s({
    key: 'notify.flood_ceiling_per_hour',
    module: 'EN-037',
    label: 'Non-critical notifications per user per hour',
    description:
      'EN-037 §3.5: above this ceiling non-critical notifications auto-coalesce into a digest and a flood event is raised. Critical alerts are never affected.',
    scopes: ['hospital'],
    schema: z.number().int().min(5).max(200),
    defaultValue: 25,
  }),
  s({
    key: 'notify.default_quiet_hours_start',
    module: 'EN-037',
    label: 'Default quiet-hours start',
    description: 'Suggested default for new users. `critical` always overrides quiet hours.',
    scopes: ['hospital', 'user'],
    schema: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    defaultValue: '22:00',
  }),
  s({
    key: 'notify.default_quiet_hours_end',
    module: 'EN-037',
    label: 'Default quiet-hours end',
    description: 'Suggested default for new users.',
    scopes: ['hospital', 'user'],
    schema: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    defaultValue: '07:00',
  }),
  s({
    key: 'notify.high_wakes_off_duty',
    module: 'EN-037',
    label: 'High-severity alerts reach off-duty staff',
    description:
      'EN-037 §16 Q7. Default false: off-duty staff are not paged for `high` alerts; those route to the on-duty holder.',
    scopes: ['hospital'],
    schema: z.boolean(),
    defaultValue: false,
    requiresApproval: true,
  }),

  // ── EN-038: approvals ──────────────────────────────────────────────────────
  s({
    key: 'workflow.default_sla_hours',
    module: 'EN-038',
    label: 'Default approval SLA (business hours)',
    description: 'Used when a matrix rule does not name its own SLA.',
    scopes: ['hospital'],
    schema: z.number().int().min(1).max(240),
    defaultValue: 4,
  }),
  s({
    key: 'workflow.reminder_fractions',
    module: 'EN-038',
    label: 'SLA reminder points',
    description: 'EN-038 §3.4.2: reminders at these fractions of the SLA. Default 50 % and 80 %.',
    scopes: ['hospital'],
    schema: z.array(z.number().min(0.1).max(0.95)).min(1).max(4),
    defaultValue: [0.5, 0.8],
  }),
  s({
    key: 'workflow.bypass_ratification_hours',
    module: 'EN-038',
    label: 'Bypass ratification window (hours)',
    description: 'EN-038 §3.8: an emergency bypass must be ratified within this window or it escalates.',
    scopes: ['hospital'],
    schema: z.number().int().min(4).max(72),
    defaultValue: 24,
    requiresApproval: true,
  }),
  s({
    key: 'workflow.require_simulation_for_financial_publish',
    module: 'EN-038',
    label: 'Require a simulation before publishing a financial matrix',
    description: 'EN-038 §3.7: default on. A matrix version cannot be published without an attached simulation run.',
    scopes: ['hospital'],
    schema: z.boolean(),
    defaultValue: true,
    dualControl: true,
  }),

  // ── EN-039: forms & printing ───────────────────────────────────────────────
  s({
    key: 'forms.autosave_interval_sec',
    module: 'EN-039',
    label: 'Form autosave interval (seconds)',
    description: 'docs/06 §6.4: autosave every 5 seconds and on blur. Never lose clinician input.',
    scopes: ['hospital'],
    schema: z.number().int().min(2).max(30),
    defaultValue: 5,
  }),
  s({
    key: 'forms.template_review_months',
    module: 'EN-039',
    label: 'Controlled-document review cycle (months)',
    description: 'EN-039 §3.7: NABH IMS expects at least annual review.',
    scopes: ['hospital'],
    schema: z.number().int().min(1).max(24),
    defaultValue: 12,
  }),
  s({
    key: 'print.reprint_watermark_required',
    module: 'EN-005',
    label: 'Watermark reprints as COPY',
    description:
      'EN-039 §5: a reprint of a financial receipt or clinical report prints COPY unless the user holds tpl.reprint.override.',
    scopes: ['hospital'],
    schema: z.boolean(),
    defaultValue: true,
    requiresApproval: true,
  }),
  s({
    key: 'print.duplex_default_for_a4',
    module: 'EN-005',
    label: 'Duplex by default for internal A4',
    description: 'EN-005 §5: duplex for internal documents, simplex for patient-facing legal documents.',
    scopes: ['hospital', 'branch'],
    schema: z.boolean(),
    defaultValue: true,
  }),
  s({
    key: 'print.job_retry_window_min',
    module: 'EN-005',
    label: 'Print retry window (minutes)',
    description: 'EN-005 §3.3.2: retry every 30 s for this long before failing with an alert.',
    scopes: ['hospital'],
    schema: z.number().int().min(1).max(60),
    defaultValue: 10,
  }),

  // ── EN-013: identification ─────────────────────────────────────────────────
  s({
    key: 'barcode.report_verify_token_days',
    module: 'EN-013',
    label: 'Report-verification QR validity (days)',
    description: 'EN-013 §5: default 90 days for report verification, 24 hours for visitor passes.',
    scopes: ['hospital'],
    schema: z.number().int().min(7).max(365),
    defaultValue: 90,
  }),
  s({
    key: 'barcode.camera_scan_enabled',
    module: 'EN-013',
    label: 'Allow camera scanning in the PWA',
    description: 'EN-013 §5: permitted only over HTTPS and for permitted roles. Images are never stored.',
    scopes: ['hospital', 'branch'],
    schema: z.boolean(),
    defaultValue: true,
  }),

  // ── EN-041: multi-branch ───────────────────────────────────────────────────
  s({
    key: 'org.uhid_group_unique',
    module: 'EN-041',
    label: 'Group-unique UHID',
    description:
      'EN-041 §3.4.1: recommended default — one patient, one UHID across the group, with a branch prefix for readability. The alternative (per-branch UHID with a cross-reference index) is chosen once per deployment and cannot be changed afterwards.',
    scopes: ['hospital'],
    schema: z.boolean(),
    defaultValue: true,
    requiresApproval: true,
    dualControl: true,
  }),
  s({
    key: 'org.cross_branch_clinical_requires_consent',
    module: 'EN-041',
    label: 'Cross-entity clinical access requires consent',
    description:
      'EN-041 §3.4.2: across different legal entities, viewing a record requires a consent artefact. Break-glass is always available for emergencies and is always reviewed.',
    scopes: ['hospital'],
    schema: z.boolean(),
    defaultValue: true,
    requiresApproval: true,
    dualControl: true,
  }),
  s({
    key: 'org.branch_colour_band_enabled',
    module: 'EN-041',
    label: 'Show the branch colour band',
    description:
      'EN-041 §3.7: a persistent colour band identifies the active branch, because "which branch am I in?" errors cause real harm. Default on.',
    scopes: ['hospital'],
    schema: z.boolean(),
    defaultValue: true,
  }),

  // ── EN-017: integrations ───────────────────────────────────────────────────
  s({
    key: 'ihub.default_connector_concurrency',
    module: 'EN-017',
    label: 'Default connector concurrency',
    description: 'EN-017 §13: default 8 per connector so one slow partner cannot starve others.',
    scopes: ['hospital'],
    schema: z.number().int().min(1).max(64),
    defaultValue: 8,
  }),
  s({
    key: 'ihub.payload_retention_days',
    module: 'EN-017',
    label: 'Message payload retention (days)',
    description: 'EN-017 §4: full payloads 30 days; metadata stays searchable for 180 (CERT-In).',
    scopes: ['hospital'],
    schema: z.number().int().min(7).max(180),
    defaultValue: 30,
    requiresApproval: true,
  }),

  // ── EN-032: email ──────────────────────────────────────────────────────────
  s({
    key: 'email.smtp_url',
    module: 'EN-032',
    label: 'SMTP connection URL',
    description: 'Stored encrypted and masked in the UI and in every export (EN-007 §5).',
    scopes: ['hospital'],
    schema: z.string(),
    defaultValue: '',
    sensitivity: 'secret',
    requiresApproval: true,
  }),
  s({
    key: 'email.from_address',
    module: 'EN-032',
    label: 'Default sender address',
    description: 'Must be a verified sender identity.',
    scopes: ['hospital', 'branch'],
    schema: z.string(),
    defaultValue: '',
  }),
  s({
    key: 'email.attach_phi_documents',
    module: 'EN-032',
    label: 'Allow PHI documents as email attachments',
    description:
      'docs/04 §4 treats sending a clinical document by email as a disclosure. Default off; a portal link is preferred.',
    scopes: ['hospital'],
    schema: z.boolean(),
    defaultValue: false,
    requiresApproval: true,
    dualControl: true,
  }),

  // ── UI defaults (docs/06) ──────────────────────────────────────────────────
  s({
    key: 'ui.default_theme',
    module: 'EN-007',
    label: 'Default theme',
    description:
      'docs/06 §2: theme is chosen by *surface* — light for clinical and data entry, dark for dashboards and boards. This is only the initial user preference.',
    scopes: ['hospital', 'user'],
    schema: z.enum(['light', 'dark', 'system']),
    defaultValue: 'light',
  }),
  s({
    key: 'ui.default_density',
    module: 'EN-007',
    label: 'Default table density',
    description: 'docs/06 §6.3: compact 32 px, default 40 px, touch 52 px (auto on coarse pointers).',
    scopes: ['hospital', 'user'],
    schema: z.enum(['compact', 'default', 'touch']),
    defaultValue: 'default',
  }),
  s({
    key: 'ui.high_contrast',
    module: 'EN-007',
    label: 'High-contrast mode',
    description: 'docs/06 §7: forced on for ER and ambulance-bay kiosks; raises all text to ≥ 7:1.',
    scopes: ['hospital', 'branch', 'user'],
    schema: z.boolean(),
    defaultValue: false,
  }),
  s({
    key: 'ui.locale_default',
    module: 'EN-007',
    label: 'Default locale',
    description: 'docs/06 §8: `en-IN` is always the fallback. A hospital enables a subset of the 11 others.',
    scopes: ['hospital', 'branch', 'user'],
    schema: z.enum(['en-IN', 'hi', 'ta', 'te', 'ml', 'kn', 'mr', 'bn', 'gu', 'or', 'pa', 'ar']),
    defaultValue: 'en-IN',
  }),
  s({
    key: 'ui.enabled_locales',
    module: 'EN-007',
    label: 'Enabled locales',
    description: 'Which of the 12 supported locales this hospital offers. `en-IN` cannot be removed.',
    scopes: ['hospital'],
    schema: z.array(z.enum(['en-IN', 'hi', 'ta', 'te', 'ml', 'kn', 'mr', 'bn', 'gu', 'or', 'pa', 'ar'])).min(1),
    defaultValue: ['en-IN', 'hi'],
  }),
]);

const settingsByKey = new Map(SETTING_DEFINITIONS.map((d) => [d.key, d]));

if (settingsByKey.size !== SETTING_DEFINITIONS.length) {
  throw new Error('Duplicate setting keys in SETTING_DEFINITIONS.');
}

export function getSettingDefinition(key: string): SettingDefinition | undefined {
  return settingsByKey.get(key);
}

export function assertRegisteredSetting(key: string): SettingDefinition {
  const def = settingsByKey.get(key);
  if (!def) {
    throw new Error(
      `Unregistered setting "${key}". Declare it in packages/contracts/src/settings/definitions.ts so the ` +
        `admin console can validate it and the audit diff can describe it (EN-007 §3.1.2).`,
    );
  }
  return def;
}

export const SETTING_KEYS: readonly string[] = Object.freeze(SETTING_DEFINITIONS.map((d) => d.key));

/** Keys stored encrypted and masked everywhere (EN-007 §5). */
export const SECRET_SETTING_KEYS: readonly string[] = Object.freeze(
  SETTING_DEFINITIONS.filter((d) => d.sensitivity === 'secret').map((d) => d.key),
);

export const APPROVAL_REQUIRED_SETTING_KEYS: readonly string[] = Object.freeze(
  SETTING_DEFINITIONS.filter((d) => d.requiresApproval).map((d) => d.key),
);

export const DUAL_CONTROL_SETTING_KEYS: readonly string[] = Object.freeze(
  SETTING_DEFINITIONS.filter((d) => d.dualControl).map((d) => d.key),
);
