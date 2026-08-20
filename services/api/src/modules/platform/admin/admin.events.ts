import { assertRegisteredEvent } from '@vims/contracts';
import type { OutboxEvent } from '../../../core/outbox/outbox.service.js';

/**
 * Builds an outbox event from the registry rather than from a literal.
 *
 * `OutboxService.publish` takes an event type as a plain string, which means a
 * typo (`admin.user.deactived`) would be written happily, relayed happily, and
 * consumed by nobody — a user deactivated with no session revocation downstream
 * and no error anywhere. `docs/09` §4 requires every event to round-trip through
 * its registered schema, so this helper looks the type up, **validates the
 * payload against that schema**, and copies `aggregate`, `containsPhi` and
 * `retentionDays` from the registry instead of letting each call site invent
 * them.
 *
 * A failure here is a programming error, not a user error: it throws rather than
 * returning a Result, so it surfaces in the test that exercises the route rather
 * than as a quietly malformed row in production.
 */
export function adminEvent(
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
