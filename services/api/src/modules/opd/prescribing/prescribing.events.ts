import { assertRegisteredEvent } from '@vims/contracts';
import type { OutboxEvent } from '../../../core/outbox/outbox.service.js';

/**
 * Builds an OP-002 / EN-029 outbox event from the registry rather than from a
 * literal — same helper, and same reasoning, as `patient.events.ts`.
 *
 * It matters more here than anywhere else so far. `rx.created` is what puts a
 * prescription in front of a pharmacist; `cdss.hardstop.blocked` is the evidence
 * that the floor held. A mistyped event type would be written happily, relayed
 * happily and consumed by nobody — a prescription that never reaches the counter
 * and a safety event that never reaches the governance pack, both silent.
 *
 * The payload is validated against the registered schema, so a missing field is
 * a failed request rather than a consumer crash three services away.
 */
export function prescribingEvent(
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
