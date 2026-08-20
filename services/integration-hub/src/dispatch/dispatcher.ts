/**
 * EN-017 §3.2 — the outbound message flow.
 *
 * Everything the hub promises about delivery happens here: idempotency, the
 * circuit-breaker gate, the message-log write with PHI redaction, the retry
 * budget with deterministic backoff, and the DLQ as the only terminal state for
 * a failure that cannot be retried.
 *
 * ### Why three transactions rather than one
 * The obvious implementation opens a transaction, calls the partner and commits
 * the result. That holds a Postgres connection — and a snapshot — open for the
 * whole 30-second timeout of a partner that is not answering, which is how a
 * single dead endpoint exhausts the pool and takes the OPD screen down with it.
 * So: one transaction to claim the message, no transaction at all around the
 * network call, one transaction to record what happened. The message row is
 * committed as `in_flight` before the call, which is also what makes a worker
 * crash recoverable — the row exists, its status says a call was in progress,
 * and the sweeper can reconcile it. The opposite ordering loses the message.
 *
 * ### Why the backoff jitter is not random
 * Jitter matters: without it, every message that failed in the same second
 * retries in the same second, and the partner is hit by the same thundering herd
 * that knocked it over. But `Math.random` is banned (`docs/09` §2) because a
 * suite that uses it fails irreproducibly. The jitter here is an FNV-1a hash of
 * the message id — uniformly spread across messages, identical on every replay
 * of the same message, and needing no seed.
 */
import type { IntegrationDatabase, TenantContext, TransactionClient } from '../db/database.js';
import type {
  AdapterLogger,
  Clock,
  ConnectorAdapter,
  DispatchResult,
  ErrorClass,
  OutboundMessage,
} from '../adapter/types.js';
import { isRetryableErrorClass } from '../adapter/types.js';
import type { RetryConfig } from '../config/connector-config.js';
import { canAttempt, onFailure, onSuccess } from '../circuit/circuit-breaker.js';
import { CircuitStore } from '../circuit/circuit-store.js';
import { DeadLetterQueue } from '../dlq/dead-letter-queue.js';
import { MessageLog, type MessageHandle, type MessageRow } from '../messages/message-log.js';
import type { PayloadStore } from '../payload/payload-store.js';
import {
  ConnectorLifecycleError,
  ConnectorNotFoundError,
  type ConnectorRecord,
  type ConnectorRegistry,
  type OperationRecord,
} from '../registry/connector-registry.js';

export interface DispatchInput {
  readonly connectorKey: string;
  readonly operationKey: string;
  readonly payload: unknown;
  readonly correlationId?: string;
  readonly refType?: string | null;
  readonly refId?: string | null;
  readonly idempotencyKey?: string | null;
  readonly partitionKey?: string | null;
  readonly priority?: number;
  readonly branchId?: string | null;
  readonly headers?: Readonly<Record<string, string>>;
  readonly suppressSideEffects?: boolean;
  readonly parentMessageId?: string | null;
}

export type DispatchOutcome =
  | {
      readonly status: 'sent' | 'acknowledged';
      readonly messageId: string;
      readonly attempts: number;
      readonly latencyMs: number;
      /**
       * The partner's own id for this message, straight from
       * `DispatchSuccess.partnerRef`.
       *
       * It is surfaced here rather than read back from `response_redacted`
       * because that column holds the *redacted* copy: an SMS request id or a
       * `wamid` is not PHI, but it is an opaque string that the value scanner is
       * entitled to rewrite if it happens to contain a digit run shaped like a
       * phone number. A rewritten provider id is an unmatchable delivery
       * webhook, which is a silent failure — the one outcome `docs/04` §7 does
       * not allow.
       */
      readonly partnerRef?: string;
    }
  | { readonly status: 'duplicate'; readonly messageId: string }
  | { readonly status: 'blocked'; readonly messageId: string; readonly reason: string }
  | {
      readonly status: 'failed';
      readonly messageId: string;
      readonly attempts: number;
      readonly errorClass: ErrorClass;
      readonly nextAttemptAt: Date;
    }
  | {
      readonly status: 'dead_lettered';
      readonly messageId: string;
      readonly attempts: number;
      readonly errorClass: ErrorClass;
      readonly dlqItemId: string;
    };

export interface ReplayOptions {
  /** EN-017 §3.6 — patients are not re-notified unless someone ticks the box. */
  readonly suppressSideEffects?: boolean;
  /** Replay reuses the original idempotency key unless the operator forces a new one. */
  readonly forceNewIdempotencyKey?: boolean;
}

export interface DispatcherDeps {
  readonly db: IntegrationDatabase;
  readonly registry: ConnectorRegistry;
  readonly payloads: PayloadStore;
  readonly clock: Clock;
  readonly newId: () => string;
  readonly logger: AdapterLogger;
  readonly messageLog?: MessageLog;
  readonly dlq?: DeadLetterQueue;
  readonly circuits?: CircuitStore;
}

/** FNV-1a. Small, fast, and identical on every platform and Node version. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function backoffMs(retry: RetryConfig, attempt: number, messageId: string): number {
  const exponential = retry.baseDelayMs * Math.pow(retry.backoffFactor, Math.max(attempt - 1, 0));
  const capped = Math.min(exponential, retry.maxDelayMs);
  const jitter = retry.jitterMs === 0 ? 0 : fnv1a(`${messageId}:${attempt}`) % retry.jitterMs;
  return Math.round(capped + jitter);
}

export class Dispatcher {
  private readonly messages: MessageLog;
  private readonly dlq: DeadLetterQueue;
  private readonly circuits: CircuitStore;

  constructor(private readonly deps: DispatcherDeps) {
    this.messages = deps.messageLog ?? new MessageLog();
    this.dlq = deps.dlq ?? new DeadLetterQueue(deps.newId);
    this.circuits = deps.circuits ?? new CircuitStore(deps.newId);
  }

  async dispatch(ctx: TenantContext, input: DispatchInput): Promise<DispatchOutcome> {
    const record = await this.deps.registry.get(ctx, input.connectorKey);
    if (record === undefined) throw new ConnectorNotFoundError(input.connectorKey);

    const operation = record.operations.find((op) => op.key === input.operationKey);
    if (operation === undefined || !operation.active) {
      throw new ConnectorLifecycleError(
        `connector '${record.key}' has no active operation '${input.operationKey}'`,
      );
    }

    const now = this.deps.clock.now();
    const messageId = this.deps.newId();
    const correlationId = input.correlationId ?? messageId;
    const idempotencyKey = input.idempotencyKey ?? this.deriveIdempotencyKey(record, operation, input);

    // The full payload goes to the encrypted store; only the reference reaches
    // the log table. EN-017 §5, and the only way replay can ever work.
    const payloadRef = await this.deps.payloads.put(messageId, {
      encoding: 'json',
      body: input.payload,
      storedAt: now,
    });

    const claimTransaction = async (): Promise<
      | { readonly kind: 'duplicate'; readonly messageId: string }
      | { readonly kind: 'blocked'; readonly handle: MessageHandle; readonly reason: string }
      | { readonly kind: 'attempt'; readonly handle: MessageHandle }
    > =>
      this.deps.db.withTenant(ctx, async (tx) => {
        if (idempotencyKey !== null) {
          const existing = await this.messages.findByIdempotencyKey(tx, record.id, idempotencyKey);
          if (existing !== undefined) {
            return { kind: 'duplicate' as const, messageId: existing.id };
          }
        }

        // A paused connector parks its traffic rather than losing it: the message
        // is logged as `blocked` and drains when someone resumes the connector.
        if (record.status !== 'active') {
          const handle = await this.record(tx, ctx, record, operation, {
            input,
            messageId,
            correlationId,
            idempotencyKey,
            payloadRef,
            status: 'blocked',
            attempts: 0,
            now,
          });
          return { kind: 'blocked' as const, handle, reason: `connector status is '${record.status}'` };
        }

        const key = { hospitalId: ctx.hospitalId, connectorId: record.id, operationId: operation.id };
        const snapshot = await this.circuits.load(tx, key);
        const decision = canAttempt(snapshot, record.config.circuit, now);
        await this.circuits.save(tx, key, decision.snapshot, now);

        if (!decision.allowed) {
          const handle = await this.record(tx, ctx, record, operation, {
            input,
            messageId,
            correlationId,
            idempotencyKey,
            payloadRef,
            status: 'blocked',
            attempts: 0,
            now,
          });
          return { kind: 'blocked' as const, handle, reason: decision.reason };
        }

        const handle = await this.record(tx, ctx, record, operation, {
          input,
          messageId,
          correlationId,
          idempotencyKey,
          payloadRef,
          status: 'in_flight',
          attempts: 1,
          now,
        });
        return { kind: 'attempt' as const, handle };
      });

    let claim: Awaited<ReturnType<typeof claimTransaction>>;
    try {
      claim = await claimTransaction();
    } catch (error) {
      if (!this.isIdempotencyConflict(error) || idempotencyKey === null) throw error;
      const existing = await this.deps.db.withTenant(ctx, (tx) =>
        this.messages.findByIdempotencyKey(tx, record.id, idempotencyKey),
      );
      if (existing === undefined) throw error;
      claim = { kind: 'duplicate', messageId: existing.id };
    }

    if (claim.kind === 'duplicate') {
      this.deps.logger.debug(
        { connectorKey: record.key, operationKey: operation.key },
        'idempotent dispatch: returning the original message',
      );
      return { status: 'duplicate', messageId: claim.messageId };
    }
    if (claim.kind === 'blocked') {
      return { status: 'blocked', messageId: claim.handle.id, reason: claim.reason };
    }

    const adapter = await this.deps.registry.instantiate(record);
    const result = await this.callAdapter(adapter, record, operation, {
      messageId: claim.handle.id,
      correlationId,
      payload: input.payload,
      idempotencyKey,
      partitionKey: input.partitionKey ?? null,
      attempt: 1,
      headers: input.headers ?? {},
      suppressSideEffects: input.suppressSideEffects ?? false,
    });

    return this.settle(ctx, record, operation, claim.handle, result, 1);
  }

  /**
   * Re-attempt a message that is already in the log — the retry sweeper's entry
   * point and what "Retry now" in the DLQ triage screen calls.
   */
  async retry(ctx: TenantContext, messageId: string): Promise<DispatchOutcome> {
    const loaded = await this.deps.db.withTenant(ctx, (tx) => this.messages.get(tx, messageId));
    if (loaded === undefined) throw new Error(`no message ${messageId} in this tenant`);
    return this.reattempt(ctx, loaded);
  }

  /**
   * EN-017 §3.6 replay. The original row is marked `replayed` and a **new**
   * message is dispatched with the same idempotency key and the original as its
   * parent, because `ihub_messages` is append-only and rewriting history would
   * destroy the audit trail the DLQ exists to produce.
   */
  async replayDlqItem(
    ctx: TenantContext,
    dlqItemId: string,
    options: ReplayOptions = {},
  ): Promise<DispatchOutcome> {
    const loaded = await this.deps.db.withTenant(ctx, async (tx) => {
      const item = await this.dlq.get(tx, dlqItemId);
      if (item === undefined) throw new Error(`no DLQ item ${dlqItemId} in this tenant`);
      if (item.sampleMessageId === null) {
        throw new Error(`DLQ item ${dlqItemId} has no sample message to replay`);
      }
      const message = await this.messages.get(tx, item.sampleMessageId);
      if (message === undefined) {
        throw new Error(`DLQ item ${dlqItemId} references message ${item.sampleMessageId}, which is gone`);
      }
      return { item, message };
    });

    const outcome = await this.reattempt(ctx, loaded.message, {
      asReplay: true,
      suppressSideEffects: options.suppressSideEffects ?? true,
      forceNewIdempotencyKey: options.forceNewIdempotencyKey ?? false,
    });

    if (outcome.status === 'sent' || outcome.status === 'acknowledged') {
      await this.deps.db.withTenant(ctx, (tx) =>
        this.dlq.setStatus(
          tx,
          loaded.item.id,
          'resolved',
          this.deps.clock.now(),
          `replayed as message ${outcome.messageId}`,
        ),
      );
    }
    return outcome;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async reattempt(
    ctx: TenantContext,
    previous: MessageRow,
    replay?: {
      readonly asReplay: true;
      readonly suppressSideEffects: boolean;
      readonly forceNewIdempotencyKey: boolean;
    },
  ): Promise<DispatchOutcome> {
    const record = await this.findConnectorById(ctx, previous.connector_id);
    const operation = record.operations.find((op) => op.id === previous.operation_id);
    if (operation === undefined) {
      throw new ConnectorLifecycleError(
        `message ${previous.id} references an operation that no longer exists on '${record.key}'`,
      );
    }

    // The redacted copy is unusable as a payload — sending `«phone:9876»` to a
    // partner is worse than not sending at all — so a replay is only possible
    // while the full payload is still within its retention window (EN-017 §4).
    const stored =
      previous.payload_ref === null ? undefined : await this.deps.payloads.get(previous.payload_ref);
    if (stored === undefined) {
      const now = this.deps.clock.now();
      const handle: MessageHandle = { id: previous.id, createdAt: previous.created_at_text };
      await this.deps.db.withTenant(ctx, (tx) =>
        this.messages.fail(tx, handle, {
          status: 'dead_lettered',
          latencyMs: 0,
          errorClass: 'payload_purged',
          errorText: 'the full payload is past its retention window and cannot be replayed',
          completedAt: now,
        }),
      );
      const dlqItem = await this.deps.db.withTenant(ctx, (tx) =>
        this.dlq.record(tx, {
          hospitalId: ctx.hospitalId,
          connectorId: record.id,
          operationId: operation.id,
          messageId: previous.id,
          errorClass: 'payload_purged',
          at: now,
        }),
      );
      return {
        status: 'dead_lettered',
        messageId: previous.id,
        attempts: previous.attempts,
        errorClass: 'payload_purged',
        dlqItemId: dlqItem.id,
      };
    }

    const now = this.deps.clock.now();
    const isReplay = replay !== undefined;
    const messageId = isReplay ? this.deps.newId() : previous.id;
    // A replay reuses the original idempotency key (EN-017 §3.6), and the
    // partitioned unique index is `(connector_id, idempotency_key, created_at)`
    // — so the new row must land strictly after its parent. That is also what
    // the ordering *means*: a replay happens after the thing it replays.
    const parentCreatedAt = new Date(previous.created_at_text);
    const createdAt =
      isReplay && now.getTime() <= parentCreatedAt.getTime() ? new Date(parentCreatedAt.getTime() + 1) : now;
    const idempotencyKey =
      isReplay && replay.forceNewIdempotencyKey
        ? `${previous.idempotency_key ?? previous.id}:replay:${messageId}`
        : previous.idempotency_key;

    const handle = await this.deps.db.withTenant(ctx, async (tx) => {
      const key = { hospitalId: ctx.hospitalId, connectorId: record.id, operationId: operation.id };
      const snapshot = await this.circuits.load(tx, key);
      const decision = canAttempt(snapshot, record.config.circuit, now);
      await this.circuits.save(tx, key, decision.snapshot, now);
      if (!decision.allowed) return { blocked: decision.reason } as const;

      if (isReplay) {
        // Mark first: `findByIdempotencyKey` skips `replayed`, so the new row
        // may legitimately carry the original key.
        await this.messages.markReplayed(tx, { id: previous.id, createdAt: previous.created_at_text }, now);
        const created = await this.messages.record(tx, {
          id: messageId,
          hospitalId: ctx.hospitalId,
          connectorId: record.id,
          connectorVersion: record.version,
          operationId: operation.id,
          direction: 'out',
          correlationId: previous.correlation_id,
          parentMessageId: previous.id,
          idempotencyKey,
          partitionKey: previous.partition_key,
          status: 'in_flight',
          attempts: 1,
          payload: stored.body,
          payloadRef: previous.payload_ref,
          createdAt,
        });
        return { handle: created, attempts: 1 } as const;
      }

      const existing: MessageHandle = { id: previous.id, createdAt: previous.created_at_text };
      await this.messages.markInFlight(tx, existing, now);
      return { handle: existing, attempts: previous.attempts + 1 } as const;
    });

    if ('blocked' in handle) {
      return { status: 'blocked', messageId: previous.id, reason: handle.blocked };
    }

    const adapter = await this.deps.registry.instantiate(record);
    const result = await this.callAdapter(adapter, record, operation, {
      messageId: handle.handle.id,
      correlationId: previous.correlation_id,
      payload: stored.body,
      idempotencyKey,
      partitionKey: previous.partition_key,
      attempt: handle.attempts,
      headers: {},
      suppressSideEffects: replay?.suppressSideEffects ?? false,
    });

    return this.settle(ctx, record, operation, handle.handle, result, handle.attempts);
  }

  private async callAdapter(
    adapter: ConnectorAdapter,
    record: ConnectorRecord,
    operation: OperationRecord,
    message: {
      readonly messageId: string;
      readonly correlationId: string;
      readonly payload: unknown;
      readonly idempotencyKey: string | null;
      readonly partitionKey: string | null;
      readonly attempt: number;
      readonly headers: Readonly<Record<string, string>>;
      readonly suppressSideEffects: boolean;
    },
  ): Promise<DispatchResult> {
    const outbound: OutboundMessage = {
      messageId: message.messageId,
      correlationId: message.correlationId,
      operationKey: operation.key,
      encoding: 'json',
      payload: message.payload,
      headers: message.headers,
      ...(message.idempotencyKey === null ? {} : { idempotencyKey: message.idempotencyKey }),
      ...(message.partitionKey === null ? {} : { partitionKey: message.partitionKey }),
      attempt: message.attempt,
      timeoutMs: operation.timeoutMs,
      sandbox: record.environment === 'sandbox',
      suppressSideEffects: message.suppressSideEffects,
    };

    try {
      return await adapter.send(operation.key, outbound);
    } catch (error) {
      // `docs/04` §7: never swallow an exception in an integration path. An
      // adapter that throws is a defect in the adapter, and it becomes a
      // non-retryable poison classification so it reaches a human rather than
      // looping.
      this.deps.logger.error(
        { connectorKey: record.key, operationKey: operation.key, messageId: message.messageId },
        'adapter threw instead of returning a DispatchResult',
      );
      return {
        status: 'failed',
        errorClass: 'poison',
        message: error instanceof Error ? error.message : 'adapter threw a non-Error',
        retryable: false,
        latencyMs: 0,
      };
    }
  }

  /**
   * `23505` on `uq_ihub_messages_idempotency` means another worker claimed the
   * same key in the same instant. That is precisely the condition idempotency
   * exists to handle, so it resolves to the same answer a sequential duplicate
   * would get — not to a 500.
   */
  private isIdempotencyConflict(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === '23505'
    );
  }

  private async settle(
    ctx: TenantContext,
    record: ConnectorRecord,
    operation: OperationRecord,
    handle: MessageHandle,
    result: DispatchResult,
    attempts: number,
  ): Promise<DispatchOutcome> {
    const now = this.deps.clock.now();
    const key = { hospitalId: ctx.hospitalId, connectorId: record.id, operationId: operation.id };

    if (result.status !== 'failed') {
      await this.deps.db.withTenant(ctx, async (tx) => {
        await this.messages.complete(tx, handle, {
          status: result.status,
          latencyMs: result.latencyMs,
          httpStatus: result.httpStatus,
          ackCode: result.ackCode,
          response: result.response,
          completedAt: now,
        });
        const snapshot = await this.circuits.load(tx, key);
        await this.circuits.save(tx, key, onSuccess(snapshot), now);
      });
      return {
        status: result.status,
        messageId: handle.id,
        attempts,
        latencyMs: result.latencyMs,
        ...(result.partnerRef === undefined ? {} : { partnerRef: result.partnerRef }),
      };
    }

    const retry = record.config.retry;
    const retryable =
      result.retryable &&
      isRetryableErrorClass(result.errorClass) &&
      retry.policy !== 'R0' &&
      attempts < retry.maxAttempts;

    return this.deps.db.withTenant(ctx, async (tx) => {
      const snapshot = await this.circuits.load(tx, key);
      await this.circuits.save(
        tx,
        key,
        onFailure(snapshot, record.config.circuit, now, result.errorClass),
        now,
      );

      if (retryable) {
        const delay = result.retryAfterMs ?? backoffMs(retry, attempts, handle.id);
        const nextAttemptAt = new Date(now.getTime() + delay);
        await this.messages.fail(tx, handle, {
          status: 'failed',
          latencyMs: result.latencyMs,
          errorClass: result.errorClass,
          errorCode: result.code,
          errorText: result.message,
          httpStatus: result.httpStatus,
          nextAttemptAt,
          completedAt: null,
        });
        return {
          status: 'failed' as const,
          messageId: handle.id,
          attempts,
          errorClass: result.errorClass,
          nextAttemptAt,
        };
      }

      await this.messages.fail(tx, handle, {
        status: 'dead_lettered',
        latencyMs: result.latencyMs,
        errorClass: result.errorClass,
        errorCode: result.code,
        errorText: result.message,
        httpStatus: result.httpStatus,
        completedAt: now,
      });
      const item = await this.dlq.record(tx, {
        hospitalId: ctx.hospitalId,
        connectorId: record.id,
        operationId: operation.id,
        messageId: handle.id,
        errorClass: result.errorClass,
        errorCode: result.code,
        mappingPath: result.mappingPath,
        at: now,
      });
      return {
        status: 'dead_lettered' as const,
        messageId: handle.id,
        attempts,
        errorClass: result.errorClass,
        dlqItemId: item.id,
      };
    });
  }

  private async record(
    tx: TransactionClient,
    ctx: TenantContext,
    record: ConnectorRecord,
    operation: OperationRecord,
    args: {
      readonly input: DispatchInput;
      readonly messageId: string;
      readonly correlationId: string;
      readonly idempotencyKey: string | null;
      readonly payloadRef: string;
      readonly status: 'in_flight' | 'blocked';
      readonly attempts: number;
      readonly now: Date;
    },
  ): Promise<MessageHandle> {
    return this.messages.record(tx, {
      id: args.messageId,
      hospitalId: ctx.hospitalId,
      branchId: args.input.branchId ?? null,
      connectorId: record.id,
      connectorVersion: record.version,
      operationId: operation.id,
      direction: 'out',
      correlationId: args.correlationId,
      parentMessageId: args.input.parentMessageId ?? null,
      refType: args.input.refType ?? null,
      refId: args.input.refId ?? null,
      idempotencyKey: args.idempotencyKey,
      partitionKey: args.input.partitionKey ?? null,
      priority: args.input.priority ?? 5,
      status: args.status,
      attempts: args.attempts,
      payload: args.input.payload,
      payloadRef: args.payloadRef,
      createdAt: args.now,
    });
  }

  /**
   * EN-017 §5: "every outbound message carries a key derived from
   * `(connector, operation, refType, refId, version)` unless the caller supplies
   * one." With no `refId` there is nothing stable to derive from, and inventing
   * one would make two genuinely different messages collide — so the key is
   * omitted and the operation runs at-least-once, which is why an operation with
   * `idempotency: 'none'` is not allowed to retry.
   */
  private deriveIdempotencyKey(
    record: ConnectorRecord,
    operation: OperationRecord,
    input: DispatchInput,
  ): string | null {
    if (operation.idempotency === 'none') return null;
    if (input.refType === undefined || input.refType === null) return null;
    if (input.refId === undefined || input.refId === null) return null;
    return `${record.key}:${operation.key}:${input.refType}:${input.refId}:v${record.version}`;
  }

  private async findConnectorById(ctx: TenantContext, connectorId: string): Promise<ConnectorRecord> {
    const all = await this.deps.registry.list(ctx);
    const found = all.find((c) => c.id === connectorId);
    if (found === undefined) {
      throw new ConnectorNotFoundError(`(id ${connectorId})`);
    }
    return found;
  }
}
