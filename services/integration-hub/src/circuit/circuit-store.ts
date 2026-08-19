/**
 * The durable copy of the breaker, in `integration.ihub_circuit_state`.
 *
 * EN-017 §5 puts the live, shared state in Redis. This row exists anyway, and
 * the schema comment says why: "so a full restart does not hammer a dead
 * partner". Losing Redis and coming back with every circuit closed would send
 * the whole queued backlog at an endpoint that is still down — which is the
 * exact failure the breaker exists to prevent, arriving at the worst moment.
 *
 * `halfOpenProbes` is intentionally not persisted. It is concurrency control
 * for the probe, valid only within a live process, and a stale "1" read from
 * the table after a crash would block the probe forever.
 */
import type { TransactionClient } from '../db/database.js';
import type { CircuitConfig } from '../config/connector-config.js';
import { initialCircuit, type CircuitSnapshot, type CircuitState } from './circuit-breaker.js';

interface CircuitRow {
  id: string;
  state: CircuitState;
  consecutive_failures: number;
  error_rate: string;
  opened_at: Date | null;
  next_probe_at: Date | null;
  last_transition_reason: string | null;
}

export interface CircuitKey {
  readonly hospitalId: string;
  readonly connectorId: string;
  /**
   * Never null in practice. The unique index is `(connector_id, operation_id)`
   * and Postgres treats NULLs as distinct, so a null here would create a new row
   * on every upsert and the breaker would never trip.
   */
  readonly operationId: string;
}

export class CircuitStore {
  constructor(private readonly newId: () => string) {}

  async load(tx: TransactionClient, key: CircuitKey): Promise<CircuitSnapshot> {
    const row = await tx.maybeOne<CircuitRow>(
      `SELECT id, state, consecutive_failures, error_rate, opened_at, next_probe_at, last_transition_reason
         FROM integration.ihub_circuit_state
        WHERE connector_id = $1 AND operation_id = $2`,
      [key.connectorId, key.operationId],
    );
    if (row === undefined) return initialCircuit();
    return {
      state: row.state,
      consecutiveFailures: row.consecutive_failures,
      errorRate: Number(row.error_rate),
      openedAt: row.opened_at,
      nextProbeAt: row.next_probe_at,
      lastTransitionReason: row.last_transition_reason,
      halfOpenProbes: 0,
    };
  }

  async save(
    tx: TransactionClient,
    key: CircuitKey,
    snapshot: CircuitSnapshot,
    now: Date,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO integration.ihub_circuit_state
         (id, hospital_id, connector_id, operation_id, state, consecutive_failures,
          error_rate, opened_at, next_probe_at, last_transition_reason, updated_at)
       VALUES ($1, $2, $3, $4, $5::integration."IhubCircuitStateKind", $6, $7, $8, $9, $10, $11)
       ON CONFLICT (connector_id, operation_id) DO UPDATE SET
         state                  = EXCLUDED.state,
         consecutive_failures   = EXCLUDED.consecutive_failures,
         error_rate             = EXCLUDED.error_rate,
         opened_at              = EXCLUDED.opened_at,
         next_probe_at          = EXCLUDED.next_probe_at,
         last_transition_reason = EXCLUDED.last_transition_reason,
         updated_at             = EXCLUDED.updated_at`,
      [
        this.newId(),
        key.hospitalId,
        key.connectorId,
        key.operationId,
        snapshot.state,
        snapshot.consecutiveFailures,
        snapshot.errorRate.toFixed(4),
        snapshot.openedAt,
        snapshot.nextProbeAt,
        snapshot.lastTransitionReason,
        now,
      ],
    );
  }

  /** Everything a connector's operations currently look like, for the dashboard. */
  async listForConnector(
    tx: TransactionClient,
    connectorId: string,
  ): Promise<readonly (CircuitSnapshot & { readonly operationId: string })[]> {
    const rows = await tx.rows<CircuitRow & { operation_id: string }>(
      `SELECT id, operation_id, state, consecutive_failures, error_rate,
              opened_at, next_probe_at, last_transition_reason
         FROM integration.ihub_circuit_state
        WHERE connector_id = $1
        ORDER BY operation_id`,
      [connectorId],
    );
    return rows.map((row) => ({
      operationId: row.operation_id,
      state: row.state,
      consecutiveFailures: row.consecutive_failures,
      errorRate: Number(row.error_rate),
      openedAt: row.opened_at,
      nextProbeAt: row.next_probe_at,
      lastTransitionReason: row.last_transition_reason,
      halfOpenProbes: 0,
    }));
  }
}

export type { CircuitConfig };
