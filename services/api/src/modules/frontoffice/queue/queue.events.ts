import { assertRegisteredEvent } from '@vims/contracts';
import type { OutboxEvent } from '../../../core/outbox/outbox.service.js';

/**
 * Builds an EN-006 outbox event from the registry, validating the payload.
 *
 * Same reasoning as `admin.events.ts`: `OutboxService.publish` takes the event
 * type as a plain string, so `queue.token.calld` would be written happily,
 * relayed happily and consumed by nobody — the TV board would simply never
 * announce that token and nothing would error. `docs/09 §4` requires every event
 * to round-trip through its registered schema, so the type is looked up, the
 * payload is checked against it, and `aggregate`/`containsPhi`/`retentionDays`
 * come from the registry rather than from each call site.
 *
 * A failure here is a programming error and throws, which surfaces it in the
 * test that exercises the route rather than as a silently malformed row.
 */
export function queueEvent(
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
