/**
 * Notification contract (EN-037).
 *
 * The three rules that shape every type in this file:
 *   - `EN-037 §5`: "**Every notification is written in-app first.** No notification
 *     exists only on an external channel; the bell is the record of 'you were told'."
 *   - `EN-037 §5`: "**`critical` severity always overrides** quiet hours, DND, focus
 *     mode and user channel preferences; this is non-configurable."
 *   - `EN-037 §5`: "**External-channel content minimisation is mandatory**: SMS /
 *     WhatsApp / push / email previews for clinical types carry location and urgency
 *     only — never values, diagnoses, drug names or test names that reveal a
 *     condition. A template violating this fails publication."
 */
import { z } from 'zod';

export const notificationSeveritySchema = z.enum(['info', 'low', 'normal', 'high', 'critical']);
export type NotificationSeverity = z.infer<typeof notificationSeveritySchema>;

export const notificationCategorySchema = z.enum([
  'clinical_safety',
  'my_patients',
  'orders_results',
  'approvals',
  'roster_hr',
  'inventory',
  'finance',
  'it_system',
  'quality',
  'announcement',
]);
export type NotificationCategory = z.infer<typeof notificationCategorySchema>;

export const notificationChannelSchema = z.enum([
  'inapp',
  'web_push',
  'fcm',
  'apns',
  'sms',
  'whatsapp',
  'email',
  'voice',
  'tv',
]);
export type NotificationChannel = z.infer<typeof notificationChannelSchema>;

/** `EN-037 §5`: categories a user may never switch off, and why. */
export const LOCKED_CATEGORIES: Readonly<Record<string, string>> = Object.freeze({
  clinical_safety: 'patient safety — always on',
});

/**
 * `EN-037 §3.1` severity defaults. `quietHoursOverride` on `critical` is not a
 * default but a constant: the preference UI states plainly that "Critical
 * patient-safety alerts always reach you".
 */
export interface SeverityDefaults {
  readonly channels: readonly NotificationChannel[];
  /** `true` = bypasses quiet hours and DND. */
  readonly quietHoursOverride: boolean;
  /** `'on_duty_only'` means quiet hours are respected only for off-duty staff. */
  readonly quietHoursScope: 'always_respect' | 'on_duty_only' | 'never_respect';
  readonly mustAcknowledge: boolean;
  readonly mayCoalesce: boolean;
  readonly maySnooze: boolean;
  readonly defaultAckWindowSeconds: number | null;
}

export const SEVERITY_DEFAULTS: Readonly<Record<NotificationSeverity, SeverityDefaults>> = Object.freeze({
  critical: {
    channels: ['inapp', 'web_push', 'sms', 'voice', 'tv'],
    quietHoursOverride: true,
    quietHoursScope: 'never_respect',
    mustAcknowledge: true,
    // EN-037 §5: "Deduplication and coalescing may never apply to `critical`."
    mayCoalesce: false,
    maySnooze: false,
    defaultAckWindowSeconds: 600,
  },
  high: {
    channels: ['inapp', 'web_push'],
    quietHoursOverride: false,
    quietHoursScope: 'on_duty_only',
    mustAcknowledge: false,
    mayCoalesce: false,
    maySnooze: true,
    defaultAckWindowSeconds: null,
  },
  normal: {
    channels: ['inapp', 'web_push'],
    quietHoursOverride: false,
    quietHoursScope: 'always_respect',
    mustAcknowledge: false,
    mayCoalesce: true,
    maySnooze: true,
    defaultAckWindowSeconds: null,
  },
  low: {
    channels: ['inapp'],
    quietHoursOverride: false,
    quietHoursScope: 'always_respect',
    mustAcknowledge: false,
    mayCoalesce: true,
    maySnooze: true,
    defaultAckWindowSeconds: null,
  },
  info: {
    channels: ['inapp'],
    quietHoursOverride: false,
    quietHoursScope: 'always_respect',
    mustAcknowledge: false,
    mayCoalesce: true,
    maySnooze: true,
    defaultAckWindowSeconds: null,
  },
});

/** `EN-037 §5`: snooze is bounded at 8 hours and never available for `critical`. */
export const MAX_SNOOZE_SECONDS = 8 * 60 * 60;

/** `EN-037 §3.5`: default non-critical ceiling per recipient per rolling hour. */
export const DEFAULT_FLOOD_CEILING_PER_HOUR = 25;

/**
 * Audience expressions (EN-037 §3.2). Resolved at publish time against roles,
 * care-team relations and the live duty roster.
 */
export const audienceExpressionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('role_in_scope'),
    roleKey: z.string(),
    scope: z.enum(['branch', 'ward', 'department', 'unit', 'hospital']),
    /** Resolved from the notification context, e.g. `patient.ward_id`. */
    scopeRef: z.string().optional(),
  }),
  z.object({
    kind: z.literal('care_relation'),
    relation: z.enum([
      'ordering_doctor',
      'attending_doctor',
      'primary_nurse',
      'consultant_of_record',
      'referring_doctor',
      'nurse_incharge',
    ]),
  }),
  z.object({
    kind: z.literal('oncall'),
    speciality: z.string().optional(),
    roleKey: z.string().optional(),
    unitRef: z.string().optional(),
  }),
  z.object({ kind: z.literal('explicit_users'), userIds: z.array(z.string().uuid()) }),
  z.object({ kind: z.literal('subscribers'), topicKind: z.string(), topicRef: z.string() }),
  z.object({
    kind: z.literal('devices'),
    deviceKind: z.enum(['tv', 'kiosk']),
    deviceRef: z.string().optional(),
  }),
]);

export type AudienceExpression = z.infer<typeof audienceExpressionSchema>;

/** `EN-037 §3.4` escalation ladder rung. */
export const escalationRungSchema = z.object({
  level: z.number().int().min(1).max(6),
  /** Seconds after the previous rung before this one fires. */
  delaySeconds: z.number().int().nonnegative(),
  audience: z.array(audienceExpressionSchema).min(1),
  channels: z.array(notificationChannelSchema).min(1),
  repeatEverySeconds: z.number().int().positive().nullable(),
  maxRepeats: z.number().int().nonnegative(),
});

export type EscalationRung = z.infer<typeof escalationRungSchema>;

/**
 * `EN-037 §3.1`: a notification type is "a registered, versioned definition
 * rather than an ad-hoc call, so the catalogue is governable".
 */
export const notificationTypeDefinitionSchema = z.object({
  key: z.string().min(3).max(96),
  name: z.string().min(1).max(160),
  category: notificationCategorySchema,
  severity: notificationSeveritySchema,
  mustAcknowledge: z.boolean(),
  ackWindowSeconds: z.number().int().positive().nullable(),
  audience: z.array(audienceExpressionSchema).min(1),
  channelsBySeverity: z.record(notificationSeveritySchema, z.array(notificationChannelSchema)).optional(),
  quietHoursOverride: z.boolean(),
  /** Expression over the context that produces the dedupe key. */
  dedupeKeyExpr: z.string().nullable(),
  dedupeWindowSeconds: z.number().int().nonnegative(),
  coalescePolicy: z.enum(['none', 'digest_hourly', 'digest_daily', 'custom']),
  escalationLadderKey: z.string().nullable(),
  /**
   * `minimal` = location and urgency only on external channels. A clinical type
   * whose external template contains a clinical placeholder fails publication.
   */
  externalContentPolicy: z.enum(['minimal', 'standard']),
  payloadFields: z.array(z.string()),
  retentionDays: z.number().int().positive(),
  ownerModule: z.string(),
  status: z.enum(['active', 'deprecated', 'suppressed']),
  version: z.number().int().positive(),
});

export type NotificationTypeDefinition = z.infer<typeof notificationTypeDefinitionSchema>;

/**
 * Placeholder names that may never appear in an external-channel template for a
 * clinical type. `EN-037 §14 AC-9`: a locked phone must show "location and
 * urgency only, with no test name, value, diagnosis or drug name".
 */
export const FORBIDDEN_EXTERNAL_PLACEHOLDERS: readonly string[] = Object.freeze([
  'patientName',
  'patient_name',
  'diagnosis',
  'testName',
  'test_name',
  'resultValue',
  'result_value',
  'value',
  'drugName',
  'drug_name',
  'medication',
  'dose',
  'uhid',
  'abha',
  'aadhaar',
  'allergy',
  'procedure',
]);

/**
 * Validate an external-channel template body against the minimisation rule.
 * Returns the offending placeholders so the publication error can name them.
 */
export function findForbiddenExternalPlaceholders(templateBody: string): readonly string[] {
  const found: string[] = [];
  for (const placeholder of FORBIDDEN_EXTERNAL_PLACEHOLDERS) {
    // Matches {{ name }}, {name}, ${name}
    const re = new RegExp(String.raw`[{$]\{?\s*${placeholder}\s*\}?\}`, 'i');
    if (re.test(templateBody)) {
      found.push(placeholder);
    }
  }
  return found;
}

/** `EN-037 §13` latency budgets, asserted by the k6 smoke and the SLO dashboard. */
export const NOTIFICATION_LATENCY_BUDGET_MS = Object.freeze({
  /** publish → in-app bell visible */
  inAppP95: 1000,
  /** publish → push delivered */
  pushP95: 3000,
  /** publish → SMS queued */
  smsQueuedP95: 2000,
  /** critical publish → first channel delivered */
  criticalFirstChannelP95: 5000,
  /** bell list query */
  bellQueryP95: 150,
});

/**
 * `EN-037 §13`: "escalation timers are durable (persisted `next_fire_at` polled
 * every 5 s, not in-memory `setTimeout`) and survive worker restarts — a missed
 * escalation is a patient-safety failure, not a glitch."
 */
export const ESCALATION_POLL_INTERVAL_MS = 5000;
export const ESCALATION_TIMER_ACCURACY_BUDGET_MS = 30_000;
