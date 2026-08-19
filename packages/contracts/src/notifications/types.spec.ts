import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FLOOD_CEILING_PER_HOUR,
  ESCALATION_POLL_INTERVAL_MS,
  ESCALATION_TIMER_ACCURACY_BUDGET_MS,
  FORBIDDEN_EXTERNAL_PLACEHOLDERS,
  LOCKED_CATEGORIES,
  MAX_SNOOZE_SECONDS,
  NOTIFICATION_LATENCY_BUDGET_MS,
  SEVERITY_DEFAULTS,
  audienceExpressionSchema,
  escalationRungSchema,
  findForbiddenExternalPlaceholders,
  notificationCategorySchema,
  notificationChannelSchema,
  notificationSeveritySchema,
  notificationTypeDefinitionSchema,
} from './types.js';
import type { NotificationSeverity } from './types.js';

/**
 * The three EN-037 §5 rules these tests defend:
 *   - every notification exists in-app first;
 *   - `critical` always overrides quiet hours, DND and user preferences, and is
 *     never deduplicated, coalesced or snoozed;
 *   - external-channel previews for clinical types carry location and urgency
 *     only — a template that names a drug, a value or a diagnosis fails publication.
 */

const SEVERITIES = notificationSeveritySchema.options as readonly NotificationSeverity[];

describe('severity defaults', () => {
  it('covers every severity in the enum, and nothing else', () => {
    expect(Object.keys(SEVERITY_DEFAULTS).sort()).toEqual([...SEVERITIES].sort());
  });

  it('always writes in-app first, whatever else a severity does', () => {
    // EN-037 §5: "the bell is the record of 'you were told'."
    for (const severity of SEVERITIES) {
      expect(SEVERITY_DEFAULTS[severity].channels, `${severity} must reach the bell`).toContain('inapp');
    }
  });

  it('lets critical override quiet hours, and lets nothing else do so', () => {
    expect(SEVERITY_DEFAULTS.critical.quietHoursOverride).toBe(true);
    expect(SEVERITY_DEFAULTS.critical.quietHoursScope).toBe('never_respect');
    for (const severity of SEVERITIES.filter((s) => s !== 'critical')) {
      expect(SEVERITY_DEFAULTS[severity].quietHoursOverride, `${severity} must respect quiet hours`).toBe(false);
    }
  });

  it('never coalesces, deduplicates away or snoozes a critical alert', () => {
    // EN-037 §5: "Deduplication and coalescing may never apply to `critical`."
    expect(SEVERITY_DEFAULTS.critical.mayCoalesce).toBe(false);
    expect(SEVERITY_DEFAULTS.critical.maySnooze).toBe(false);
  });

  it('makes a critical alert acknowledgeable within a bounded window', () => {
    // An unacknowledged critical value must escalate on a timer (docs/09 §10),
    // which is impossible without an acknowledgement requirement and a window.
    expect(SEVERITY_DEFAULTS.critical.mustAcknowledge).toBe(true);
    expect(SEVERITY_DEFAULTS.critical.defaultAckWindowSeconds).toBe(600);
  });

  it('reaches a locked phone for critical and stays in-app for the quiet severities', () => {
    expect(SEVERITY_DEFAULTS.critical.channels).toContain('sms');
    expect(SEVERITY_DEFAULTS.critical.channels).toContain('voice');
    expect(SEVERITY_DEFAULTS.info.channels).toEqual(['inapp']);
    expect(SEVERITY_DEFAULTS.low.channels).toEqual(['inapp']);
  });

  it('requires an acknowledgement window exactly when acknowledgement is required', () => {
    for (const severity of SEVERITIES) {
      const spec = SEVERITY_DEFAULTS[severity];
      if (spec.mustAcknowledge) {
        expect(spec.defaultAckWindowSeconds, `${severity} needs an ack window`).toBeGreaterThan(0);
      } else {
        expect(spec.defaultAckWindowSeconds, `${severity} should not have an ack window`).toBeNull();
      }
    }
  });

  it('names clinical safety as a category a user may never switch off', () => {
    // EN-037 §5.
    expect(LOCKED_CATEGORIES['clinical_safety']).toBeTruthy();
    expect(notificationCategorySchema.safeParse('clinical_safety').success).toBe(true);
    for (const key of Object.keys(LOCKED_CATEGORIES)) {
      expect(notificationCategorySchema.safeParse(key).success, `${key} is not a real category`).toBe(true);
    }
  });

  it('bounds snoozing at eight hours', () => {
    expect(MAX_SNOOZE_SECONDS).toBe(8 * 60 * 60);
    expect(DEFAULT_FLOOD_CEILING_PER_HOUR).toBe(25);
  });
});

describe('external-channel content minimisation', () => {
  it('passes a template that carries only location and urgency', () => {
    // EN-037 §14 AC-9: a locked phone shows where to go and how urgent it is.
    expect(findForbiddenExternalPlaceholders('Urgent: attend Ward 4B now. Open the app for details.')).toEqual([]);
    expect(findForbiddenExternalPlaceholders('A result needs your attention in {{ward}}.')).toEqual([]);
  });

  it('catches a clinical placeholder in every templating syntax we support', () => {
    expect(findForbiddenExternalPlaceholders('{{patientName}} needs you')).toEqual(['patientName']);
    expect(findForbiddenExternalPlaceholders('{diagnosis} confirmed')).toEqual(['diagnosis']);
    expect(findForbiddenExternalPlaceholders('Give ${dose} now')).toEqual(['dose']);
    expect(findForbiddenExternalPlaceholders('{{ drug_name }} is ready')).toEqual(['drug_name']);
  });

  it('is case-insensitive, because a template author will write {{PatientName}}', () => {
    expect(findForbiddenExternalPlaceholders('{{PatientName}}')).toEqual(['patientName']);
    expect(findForbiddenExternalPlaceholders('{{UHID}}')).toEqual(['uhid']);
  });

  it('reports every offender so the publication error can name them all', () => {
    const found = findForbiddenExternalPlaceholders('{{patientName}} — {{testName}} = {{resultValue}}');
    expect(found).toContain('patientName');
    expect(found).toContain('testName');
    expect(found).toContain('resultValue');
  });

  it('blocks the identifiers, the values and the drug names the rule enumerates', () => {
    for (const placeholder of FORBIDDEN_EXTERNAL_PLACEHOLDERS) {
      expect(
        findForbiddenExternalPlaceholders(`Text {{${placeholder}}} more text`),
        `${placeholder} is not caught`,
      ).toContain(placeholder);
    }
  });

  it('does not fire on a word that merely contains a forbidden name', () => {
    // "Please attend the valuation meeting" must not be treated as a PHI leak, or
    // authors learn to ignore the check.
    expect(findForbiddenExternalPlaceholders('Please attend the valuation meeting')).toEqual([]);
    expect(findForbiddenExternalPlaceholders('{{valuePlaceholder}}')).toEqual([]);
  });

  it('keeps the forbidden list free of duplicates', () => {
    expect(new Set(FORBIDDEN_EXTERNAL_PLACEHOLDERS).size).toBe(FORBIDDEN_EXTERNAL_PLACEHOLDERS.length);
  });
});

describe('audience expressions', () => {
  it('resolves a role within a named scope', () => {
    expect(
      audienceExpressionSchema.safeParse({ kind: 'role_in_scope', roleKey: 'staff_nurse', scope: 'ward' }).success,
    ).toBe(true);
    expect(
      audienceExpressionSchema.safeParse({ kind: 'role_in_scope', roleKey: 'staff_nurse', scope: 'planet' }).success,
    ).toBe(false);
  });

  it('resolves a care relation from the closed list of clinical relationships', () => {
    expect(audienceExpressionSchema.safeParse({ kind: 'care_relation', relation: 'ordering_doctor' }).success).toBe(
      true,
    );
    // "the doctor who happens to be nearby" is not a care relation.
    expect(audienceExpressionSchema.safeParse({ kind: 'care_relation', relation: 'any_doctor' }).success).toBe(false);
  });

  it('resolves the on-call holder, explicit users, subscribers and devices', () => {
    expect(audienceExpressionSchema.safeParse({ kind: 'oncall', speciality: 'orthopaedics' }).success).toBe(true);
    expect(
      audienceExpressionSchema.safeParse({
        kind: 'explicit_users',
        userIds: ['0194f2c0-0000-7000-8000-000000000001'],
      }).success,
    ).toBe(true);
    expect(
      audienceExpressionSchema.safeParse({ kind: 'subscribers', topicKind: 'patient', topicRef: 'p-1' }).success,
    ).toBe(true);
    expect(audienceExpressionSchema.safeParse({ kind: 'devices', deviceKind: 'tv' }).success).toBe(true);
  });

  it('rejects an unknown audience kind rather than resolving to nobody', () => {
    // An audience that silently resolves to nobody is a notification nobody gets.
    expect(audienceExpressionSchema.safeParse({ kind: 'everyone' }).success).toBe(false);
    expect(audienceExpressionSchema.safeParse({ roleKey: 'staff_nurse' }).success).toBe(false);
  });

  it('rejects a non-uuid user id and an unsupported device kind', () => {
    expect(audienceExpressionSchema.safeParse({ kind: 'explicit_users', userIds: ['a.menon'] }).success).toBe(false);
    expect(audienceExpressionSchema.safeParse({ kind: 'devices', deviceKind: 'printer' }).success).toBe(false);
  });
});

describe('escalation ladder', () => {
  const rung = {
    level: 1,
    delaySeconds: 0,
    audience: [{ kind: 'care_relation', relation: 'ordering_doctor' }],
    channels: ['inapp', 'sms'],
    repeatEverySeconds: 120,
    maxRepeats: 3,
  };

  it('accepts a well-formed rung', () => {
    expect(escalationRungSchema.safeParse(rung).success).toBe(true);
  });

  it('refuses a rung with no audience or no channel', () => {
    // EN-037 §5: a must-acknowledge notification never expires silently, which is
    // impossible if a rung resolves to nobody or delivers nowhere.
    expect(escalationRungSchema.safeParse({ ...rung, audience: [] }).success).toBe(false);
    expect(escalationRungSchema.safeParse({ ...rung, channels: [] }).success).toBe(false);
  });

  it('bounds the ladder at six rungs and starts at one', () => {
    expect(escalationRungSchema.safeParse({ ...rung, level: 6 }).success).toBe(true);
    expect(escalationRungSchema.safeParse({ ...rung, level: 0 }).success).toBe(false);
    expect(escalationRungSchema.safeParse({ ...rung, level: 7 }).success).toBe(false);
  });

  it('allows a rung that never repeats, but never a negative delay', () => {
    expect(escalationRungSchema.safeParse({ ...rung, repeatEverySeconds: null, maxRepeats: 0 }).success).toBe(true);
    expect(escalationRungSchema.safeParse({ ...rung, delaySeconds: -1 }).success).toBe(false);
    expect(escalationRungSchema.safeParse({ ...rung, repeatEverySeconds: 0 }).success).toBe(false);
  });
});

describe('notification type definitions', () => {
  const definition = {
    key: 'lab.result.critical',
    name: 'Critical lab result',
    category: 'clinical_safety',
    severity: 'critical',
    mustAcknowledge: true,
    ackWindowSeconds: 600,
    audience: [{ kind: 'care_relation', relation: 'ordering_doctor' }],
    quietHoursOverride: true,
    dedupeKeyExpr: null,
    dedupeWindowSeconds: 0,
    coalescePolicy: 'none',
    escalationLadderKey: 'critical_result',
    externalContentPolicy: 'minimal',
    payloadFields: ['ward', 'urgency'],
    retentionDays: 3650,
    ownerModule: 'EN-029',
    status: 'active',
    version: 1,
  };

  it('accepts a fully specified, registered type', () => {
    expect(notificationTypeDefinitionSchema.safeParse(definition).success).toBe(true);
  });

  it('requires an owner module and a version, so the catalogue is governable', () => {
    // EN-037 §3.1: "a registered, versioned definition rather than an ad-hoc call".
    const { ownerModule: _o, ...withoutOwner } = definition;
    expect(notificationTypeDefinitionSchema.safeParse(withoutOwner).success).toBe(false);
    expect(notificationTypeDefinitionSchema.safeParse({ ...definition, version: 0 }).success).toBe(false);
  });

  it('rejects an unknown severity, category, channel or lifecycle status', () => {
    expect(notificationTypeDefinitionSchema.safeParse({ ...definition, severity: 'urgent' }).success).toBe(false);
    expect(notificationTypeDefinitionSchema.safeParse({ ...definition, category: 'misc' }).success).toBe(false);
    expect(notificationTypeDefinitionSchema.safeParse({ ...definition, status: 'draft' }).success).toBe(false);
    expect(
      notificationTypeDefinitionSchema.safeParse({
        ...definition,
        channelsBySeverity: { critical: ['pager'] },
      }).success,
    ).toBe(false);
  });

  it('accepts a per-severity channel override only when it covers every severity', () => {
    // `z.record(enum, …)` is exhaustive in Zod 4: the override map must name all
    // five severities. A partial map is rejected rather than merged over the
    // SEVERITY_DEFAULTS, so a type author cannot override `critical` alone.
    const complete = {
      critical: ['inapp', 'sms', 'voice'],
      high: ['inapp', 'web_push'],
      normal: ['inapp'],
      low: ['inapp'],
      info: ['inapp'],
    };
    expect(
      notificationTypeDefinitionSchema.safeParse({ ...definition, channelsBySeverity: complete }).success,
    ).toBe(true);
    expect(
      notificationTypeDefinitionSchema.safeParse({
        ...definition,
        channelsBySeverity: { critical: ['inapp', 'sms', 'voice'] },
      }).success,
    ).toBe(false);
  });

  it('requires a positive retention, because a notification is evidence of being told', () => {
    expect(notificationTypeDefinitionSchema.safeParse({ ...definition, retentionDays: 0 }).success).toBe(false);
  });

  it('offers only the two documented external content policies', () => {
    expect(notificationTypeDefinitionSchema.safeParse({ ...definition, externalContentPolicy: 'full' }).success).toBe(
      false,
    );
    expect(
      notificationTypeDefinitionSchema.safeParse({ ...definition, externalContentPolicy: 'standard' }).success,
    ).toBe(true);
  });

  it('knows every delivery channel the platform can use', () => {
    for (const channel of ['inapp', 'web_push', 'fcm', 'apns', 'sms', 'whatsapp', 'email', 'voice', 'tv']) {
      expect(notificationChannelSchema.safeParse(channel).success, channel).toBe(true);
    }
    expect(notificationChannelSchema.safeParse('pager').success).toBe(false);
  });
});

describe('latency and timer budgets', () => {
  it('holds the bell to a second and the first critical channel to five', () => {
    // EN-037 §13, asserted by the k6 smoke and the SLO dashboard.
    expect(NOTIFICATION_LATENCY_BUDGET_MS.inAppP95).toBe(1000);
    expect(NOTIFICATION_LATENCY_BUDGET_MS.criticalFirstChannelP95).toBe(5000);
    expect(NOTIFICATION_LATENCY_BUDGET_MS.bellQueryP95).toBeLessThan(NOTIFICATION_LATENCY_BUDGET_MS.inAppP95);
    expect(Object.isFrozen(NOTIFICATION_LATENCY_BUDGET_MS)).toBe(true);
  });

  it('polls escalation timers far more often than the accuracy it promises', () => {
    // EN-037 §13: durable `next_fire_at` polled every 5 s, not in-memory setTimeout.
    expect(ESCALATION_POLL_INTERVAL_MS).toBe(5000);
    expect(ESCALATION_POLL_INTERVAL_MS).toBeLessThan(ESCALATION_TIMER_ACCURACY_BUDGET_MS);
  });
});
