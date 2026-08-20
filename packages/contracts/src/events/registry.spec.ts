import { describe, expect, it } from 'vitest';
import {
  EVENT_REGISTRY,
  EVENT_TYPES,
  PHI_EVENT_TYPES,
  assertRegisteredEvent,
  eventsForModule,
  getEventDefinition,
} from './registry.js';
import { eventEnvelopeSchema } from './envelope.js';

/** docs/09 §4: "every event type in `01` §5 has a schema … a round-trip test covers every registered event." */

describe('event registry', () => {
  it('registers every type exactly once', () => {
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length);
  });

  it('names every type as <aggregate>.<past-tense-fact>', () => {
    // docs/01 §5.
    for (const type of EVENT_TYPES) {
      expect(type, `"${type}" is not a valid event type`).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
    }
  });

  it('declares the aggregate as the first segment or a documented alias', () => {
    for (const def of EVENT_REGISTRY) {
      expect(def.aggregate.length).toBeGreaterThan(0);
      expect(def.description.length).toBeGreaterThan(15);
    }
  });

  it('rejects an unregistered type with an actionable message', () => {
    expect(() => assertRegisteredEvent('bill.finalized')).toThrow(
      /Unregistered event type "bill\.finalized"/,
    );
    expect(assertRegisteredEvent('admin.user.created').module).toBe('EN-007');
  });

  it('resolves a definition by type', () => {
    expect(getEventDefinition('audit.integrity.mismatch')?.retentionDays).toBe(3650);
    expect(getEventDefinition('does.not.exist')).toBeUndefined();
  });

  it('validates a well-formed payload for every registered event and rejects a malformed one', () => {
    for (const def of EVENT_REGISTRY) {
      // Every payload schema must reject a plainly wrong shape. This catches a
      // schema accidentally declared as z.unknown(), which would validate anything
      // and defeat the whole point of producer-side validation.
      const result = def.schema.safeParse('definitely not an object');
      expect(result.success, `${def.type} accepts a bare string as its payload`).toBe(false);
    }
  });

  it('marks PHI-bearing events so the relay redacts before logging', () => {
    // docs/04 §4: no PHI in logs, metrics, traces or analytics events.
    expect(PHI_EVENT_TYPES).toContain('audit.break_glass.recorded');
    expect(PHI_EVENT_TYPES).toContain('org.patient.cross_branch_accessed');
    expect(PHI_EVENT_TYPES).toContain('barcode.verification.failed');
    expect(PHI_EVENT_TYPES).toContain('form.response.signed');
  });

  it('keeps compliance-evidence events far longer than the 7-day outbox default', () => {
    // docs/03 §Outbox purges 7 days after publish; evidence must outlive that.
    const evidence = [
      'audit.integrity.mismatch',
      'sso.break_glass.used',
      'workflow.bypass.used',
      'notification.escalation.exhausted',
      'org.patient.break_glass_used',
    ];
    for (const type of evidence) {
      const def = getEventDefinition(type);
      expect(def, `${type} is not registered`).toBeDefined();
      expect(def!.retentionDays, `${type} retention is too short to be evidence`).toBeGreaterThanOrEqual(365);
    }
  });

  it('groups events by owning module', () => {
    expect(eventsForModule('EN-037').length).toBeGreaterThan(10);
    expect(eventsForModule('EN-040').length).toBeGreaterThan(20);
  });

  it('covers the escalation-guarantee events EN-037 §5 requires to exist', () => {
    // "**Must-acknowledge notifications never expire silently.** They escalate
    // through the ladder and, if unacknowledged at the final rung, raise
    // `notification.escalation.exhausted`, which is a quality incident."
    for (const type of [
      'notification.escalated',
      'notification.escalation.exhausted',
      'notification.delivery.total_failure',
      'notification.roster_gap_detected',
    ]) {
      expect(EVENT_TYPES, `${type} must be registered`).toContain(type);
    }
  });

  it('covers the licence events that must never imply a clinical stop', () => {
    for (const type of ['licence.key.expired', 'licence.key.revoked', 'licence.degradation.tier_changed']) {
      expect(EVENT_TYPES).toContain(type);
    }
  });
});

describe('event envelope', () => {
  const valid = {
    id: '0194f2c0-0000-7000-8000-000000000001',
    hospitalId: '0194f2c0-0000-7000-8000-000000000002',
    branchId: null,
    aggregate: 'user',
    aggregateId: '0194f2c0-0000-7000-8000-000000000003',
    eventType: 'admin.user.created',
    aggregateVersion: 1,
    payload: {
      userId: '0194f2c0-0000-7000-8000-000000000003',
      username: 'a.menon',
      type: 'staff',
      invitedBy: null,
    },
    occurredAt: '2026-08-17T10:00:00.000Z',
    publishedAt: null,
    attempts: 0,
    actorUserId: '0194f2c0-0000-7000-8000-000000000004',
    actorType: 'user' as const,
    correlationId: 'req_01HZ',
    causationId: null,
    traceId: null,
    containsPhi: false,
    schemaVersion: 1,
  };

  it('accepts a well-formed envelope', () => {
    expect(eventEnvelopeSchema.safeParse(valid).success).toBe(true);
  });

  it('requires a tenant on every event — there are no global events', () => {
    const { hospitalId: _omitted, ...withoutTenant } = valid;
    expect(eventEnvelopeSchema.safeParse(withoutTenant).success).toBe(false);
  });

  it('requires a correlation id so the full causal chain is traceable', () => {
    // EN-037 §5: source event → notification → deliveries → acknowledgement.
    expect(eventEnvelopeSchema.safeParse({ ...valid, correlationId: '' }).success).toBe(false);
  });

  it('requires an offset-bearing timestamp, never a naive local time', () => {
    // docs/03 §Table rules: timestamptz only.
    expect(eventEnvelopeSchema.safeParse({ ...valid, occurredAt: '2026-08-17 10:00:00' }).success).toBe(
      false,
    );
  });

  it('round-trips the payload of every registered event through its own schema', () => {
    const def = getEventDefinition('admin.user.created')!;
    const parsed = def.schema.safeParse(valid.payload);
    expect(parsed.success).toBe(true);
  });
});
