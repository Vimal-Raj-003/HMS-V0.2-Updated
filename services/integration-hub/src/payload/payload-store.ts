/**
 * EN-017 §4 — where the *unredacted* payload lives.
 *
 * `ihub_messages.payload_redacted` is the searchable copy; `payload_ref` points
 * at the full one. Two things force that split rather than a single column:
 *
 *  * `docs/04` §2 — the full payload is PHI, so it must be encrypted at rest and
 *    reading it must be gated by `ihub.payload.read` and audited as a PHI read.
 *    A JSONB column is none of those things.
 *  * EN-017 §4 retention — payloads are purged at 30 days while metadata stays
 *    searchable for 180 (CERT-In). Two lifetimes need two stores.
 *
 * **Replay depends on this.** The DLQ can only re-send what it can still read,
 * and it cannot re-send a redacted copy — that would deliver `«phone:9876»` to a
 * partner. So a replay after the payload retention window has passed must fail
 * loudly with `payload_purged`, which is exactly the empty state EN-017 §8
 * specifies ("Payload purged after 30-day retention — metadata retained").
 *
 * Phase 0 ships the in-memory implementation only. S3/MinIO with SSE-KMS arrives
 * with the object-storage work in Phase 3; the interface is here now so the DLQ
 * and the dispatcher are written against the real contract rather than being
 * retrofitted later.
 */

export interface StoredPayload {
  readonly encoding: string;
  readonly body: unknown;
  readonly storedAt: Date;
}

export interface PayloadStore {
  /** Returns the opaque reference written to `ihub_messages.payload_ref`. */
  put(key: string, payload: StoredPayload): Promise<string>;
  /** `undefined` means purged or never stored — never "empty payload". */
  get(ref: string): Promise<StoredPayload | undefined>;
  /** Retention: EN-017 §4, default 30 days. */
  delete(ref: string): Promise<void>;
}

/**
 * Process-local, unencrypted, and lost on restart.
 *
 * Deliberately not presented as production-capable: a hospital deployment that
 * ran on this would silently lose every replayable payload on a rolling deploy.
 * `services/integration-hub` has no live connectors in Phase 0, so nothing real
 * depends on it yet, and the tests need a store they can reason about.
 */
export class InMemoryPayloadStore implements PayloadStore {
  private readonly items = new Map<string, StoredPayload>();

  put(key: string, payload: StoredPayload): Promise<string> {
    const ref = `memory://ihub/${key}`;
    this.items.set(ref, payload);
    return Promise.resolve(ref);
  }

  get(ref: string): Promise<StoredPayload | undefined> {
    return Promise.resolve(this.items.get(ref));
  }

  delete(ref: string): Promise<void> {
    this.items.delete(ref);
    return Promise.resolve();
  }

  /** Test affordance: simulate the 30-day retention job having run. */
  purgeAll(): void {
    this.items.clear();
  }

  get size(): number {
    return this.items.size;
  }
}
