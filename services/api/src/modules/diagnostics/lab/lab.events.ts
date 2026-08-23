import { assertRegisteredEvent } from '@vims/contracts';
import type { OutboxEvent } from '../../../core/outbox/outbox.service.js';

/**
 * Builds an OP-004 / EN-004 / EN-031 outbox event from the registry rather than
 * from a literal — the same helper, and the same reasoning, as
 * `prescribing.events.ts`.
 *
 * It matters here for one event above all the others. `lab.result.critical` is
 * what starts EN-037's escalation ladder; a mistyped type would be written
 * happily, relayed happily and consumed by nobody, and the failure would look
 * exactly like a laboratory that never found the potassium. Validating the
 * payload against the registered schema turns that into a failed request.
 */
export function labEvent(
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
