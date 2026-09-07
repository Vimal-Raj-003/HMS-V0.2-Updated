import { assertRegisteredEvent } from '@vims/contracts';
import type { OutboxEvent } from '../../../core/outbox/outbox.service.js';

/**
 * The device consoles' outbox events, checked against the registry before they
 * are written.
 *
 * Same shape and the same reason as `ophthalmology.events.ts`: an event whose
 * payload has drifted from its registered schema is a subscriber that breaks in
 * production rather than in this process.
 */
export function consoleEvent(
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
