/**
 * The domain-event envelope.
 *
 * `docs/03 §Outbox`: `core.outbox_events` = `id, hospital_id, aggregate,
 * aggregate_id, event_type, payload jsonb, occurred_at, published_at, attempts`.
 * `docs/01 §5`: naming is `<aggregate>.<past-tense-fact>`; "Consumers are
 * idempotent (event id dedupe), retryable, and never assume ordering across
 * aggregates."
 * `docs/09 §4`: "every event type in `01` §5 has a schema; producers validate
 * before writing to the outbox, consumers validate on read".
 *
 * The envelope carries `correlationId` because `EN-037 §5` requires the full
 * chain — source event → notification → deliveries → acknowledgement → clinical
 * action — to be traceable in one query, and `causationId` so a consumer can say
 * *which* event made it act.
 */
import { z } from 'zod';

export const eventEnvelopeSchema = z.object({
  /** UUIDv7 — also the consumer's dedupe key. */
  id: z.string().uuid(),
  /** Tenant. Every event is tenant-scoped; there are no global events. */
  hospitalId: z.string().uuid(),
  branchId: z.string().uuid().nullable(),
  /** Aggregate name, e.g. `user`, `patient`, `bill`. */
  aggregate: z.string().min(1).max(64),
  aggregateId: z.string().min(1).max(128),
  /** `<aggregate>.<past-tense-fact>` — must exist in the event registry. */
  eventType: z.string().min(3).max(128),
  /** Monotonic per aggregate, so a consumer can detect a gap it cares about. */
  aggregateVersion: z.number().int().nonnegative().nullable(),
  payload: z.unknown(),
  /** When the fact happened (business time), not when it was published. */
  occurredAt: z.string().datetime({ offset: true }),
  /** Set by the relay when it reaches Redis Streams. Null = not yet published. */
  publishedAt: z.string().datetime({ offset: true }).nullable(),
  attempts: z.number().int().nonnegative(),
  /** Who or what caused it. `null` for scheduler-originated facts. */
  actorUserId: z.string().uuid().nullable(),
  actorType: z.enum(['user', 'service', 'device', 'system', 'patient', 'external_app']),
  /** Ties the whole causal chain together across modules and channels. */
  correlationId: z.string().min(1).max(128),
  /** The event or request that caused this one. */
  causationId: z.string().min(1).max(128).nullable(),
  /** W3C traceparent, so a message can be followed in Tempo end to end. */
  traceId: z.string().max(64).nullable(),
  /**
   * `true` when the payload contains any PHI-classified field. The relay uses
   * this to decide redaction before the event reaches a log, a metric or the SIEM
   * (docs/04 §4: no PHI in logs or analytics events).
   */
  containsPhi: z.boolean(),
  /** Schema version of the payload, so a consumer can handle an older shape. */
  schemaVersion: z.number().int().positive(),
});

export type EventEnvelope<TPayload = unknown> = Omit<z.infer<typeof eventEnvelopeSchema>, 'payload'> & {
  readonly payload: TPayload;
};

/** What a producer supplies; the outbox writer fills in the rest. */
export interface EmitEventInput<TPayload> {
  readonly aggregate: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: TPayload;
  readonly aggregateVersion?: number | null;
  readonly branchId?: string | null;
  readonly causationId?: string | null;
}
