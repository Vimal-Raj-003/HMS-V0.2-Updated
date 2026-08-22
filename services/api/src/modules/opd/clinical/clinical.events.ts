import { assertRegisteredEvent } from '@vims/contracts';
import type { OutboxEvent } from '../../../core/outbox/outbox.service.js';

/**
 * Builds a Phase-2 clinical outbox event from the registry rather than from a
 * literal — same helper, same reasoning, as `patient.events.ts`.
 *
 * `OutboxService.publish` takes the event type as a plain string. A
 * `vitals.critical` mistyped as `vitals.criticial` would be written happily,
 * relayed happily, and consumed by nobody — which for a critical observation
 * means the doctor is never told. The helper looks the type up, validates the
 * payload against its registered schema (`docs/09` §4), and takes `aggregate`,
 * `containsPhi` and `retentionDays` from the registry rather than letting each
 * call site invent them.
 *
 * A failure here is a programming error, so it throws rather than degrading.
 */
export function clinicalEvent(
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
