import { assertRegisteredEvent } from '@vims/contracts';
import type { OutboxEvent } from '../../../core/outbox/outbox.service.js';

/**
 * Builds an OP-008 / EN-008 / OP-022 outbox event from the registry rather than
 * from a literal — the same helper, and the same reasoning, as
 * `prescribing.events.ts`.
 *
 * It earns its keep twice over in imaging, because **the two specs that own this
 * domain spell four of its events differently**. `EN-035 §7` writes
 * `rad.order.placed`, `rad.exam.started`, `pacs.study.received` and
 * `rad.report.drafted|finalised`; the modules that own those aggregates write
 * `rad.order.received`, `rad.study.started`, `pacs.study.acquired` and
 * `rad.report.preliminary|final`. The owners' names are the registered ones, and
 * `assertRegisteredEvent` is what makes reaching for the other spelling a boot-
 * time failure instead of an event that is written happily, relayed happily and
 * consumed by nobody — which, for `rad.result.critical`, would be a critical
 * finding that never reaches the escalation ladder.
 *
 * The payload is validated against the registered schema, so a missing field is
 * a failed request rather than a consumer crash three services away.
 */
export function radiologyEvent(
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
