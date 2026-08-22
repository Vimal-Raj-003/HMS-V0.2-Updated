import { assertRegisteredEvent } from '@vims/contracts';
import type { OutboxEvent } from '../../../core/outbox/outbox.service.js';

/**
 * Builds an outbox event for OP-001/EN-006 from the registry, never from a
 * literal.
 *
 * `OutboxService.publish` takes the event type as a plain string, so
 * `appointment.canceled` (one `l`) would be written happily, relayed happily and
 * consumed by nobody — an appointment cancelled with no refund raised and no
 * error anywhere. `docs/09` §4 requires every event to round-trip through its
 * registered schema, so this looks the type up, **validates the payload against
 * that schema** and copies `aggregate`, `containsPhi` and `retentionDays` from
 * the registry rather than letting each call site invent them.
 *
 * A failure is a programming error, not a user error, so it throws: it surfaces
 * in the test that exercises the route rather than as a malformed row in
 * production.
 */
export function schedulingEvent(
  type: string,
  aggregateId: string,
  payload: Readonly<Record<string, unknown>>,
): OutboxEvent {
  const definition = assertRegisteredEvent(type);

  const parsed = definition.schema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(
      `Event "${type}" payload does not match its registered schema (docs/09 §4): ` +
        parsed.error.issues
          .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
          .join('; '),
    );
  }

  return {
    eventType: definition.type,
    aggregate: definition.aggregate,
    aggregateId,
    payload,
    schemaVersion: definition.schemaVersion,
    containsPhi: definition.containsPhi,
    retentionDays: definition.retentionDays,
  };
}
