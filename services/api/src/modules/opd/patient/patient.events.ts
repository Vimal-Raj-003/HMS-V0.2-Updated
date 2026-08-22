import { assertRegisteredEvent } from '@vims/contracts';
import type { OutboxEvent } from '../../../core/outbox/outbox.service.js';

/**
 * Builds an OP-001 outbox event from the registry rather than from a literal.
 *
 * Same shape and same reasoning as `admin.events.ts`: `OutboxService.publish`
 * takes the type as a plain string, so `patient.merged` mistyped as
 * `patient.merge` would be written happily, relayed happily and consumed by
 * nobody — and for a merge that means every module still pointing at a UHID that
 * no longer exists, with no error anywhere. The helper looks the type up,
 * validates the payload against the registered schema (`docs/09` §4), and takes
 * `aggregate`, `containsPhi` and `retentionDays` from the registry instead of
 * letting each call site invent them.
 *
 * A failure here is a programming error, so it throws.
 */
export function patientEvent(
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
