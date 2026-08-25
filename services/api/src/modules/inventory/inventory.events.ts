import { assertRegisteredEvent } from '@vims/contracts';
import type { OutboxEvent } from '../../core/outbox/outbox.service.js';

/**
 * Builds a Phase-4 outbox event from the registry rather than from a literal —
 * the same helper, and the same reasoning, as `lab.events.ts`.
 *
 * It matters most for three events. `inventory.stock.moved` is what every other
 * supply-chain read model is built from; `pharmacy.recall.raised` starts the
 * quarantine-everywhere path; `pharmacy.narcotic.transaction` is statutory
 * evidence kept for ten years. A mistyped type would be written happily,
 * relayed happily and consumed by nobody, and the failure would look exactly
 * like a hospital that never noticed the recall.
 *
 * Validating the payload against the registered schema turns that into a failed
 * request — which is the correct direction, because the event is written in the
 * same transaction as the fact it announces, so a rejected payload rolls the
 * fact back rather than leaving a silent divergence.
 */
export function inventoryEvent(
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
