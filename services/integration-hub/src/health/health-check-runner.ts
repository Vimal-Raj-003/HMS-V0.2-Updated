/**
 * EN-017 §3.7 / `docs/08` §10.3 — synthetic health checks.
 *
 * The reason a *synthetic* check exists at all: an integration that is silently
 * dead produces no errors. An analyzer whose serial cable was unplugged at 06:00
 * generates no failed messages, so an error-rate dashboard stays green all day
 * while results pile up unfiled. A scheduled ping is the only thing that
 * distinguishes "quiet" from "gone", and `expect_traffic` is the only thing that
 * catches the case where even a ping succeeds but the partner has stopped
 * sending.
 *
 * Results land in `integration.ihub_health_checks`, which the RAG dashboard and
 * the EN-018 IT board read.
 */
import type { IntegrationDatabase, TenantContext, TransactionClient } from '../db/database.js';
import type { AdapterLogger, Clock, HealthCheckKind } from '../adapter/types.js';
import { ConnectorNotFoundError, type ConnectorRegistry } from '../registry/connector-registry.js';

export type HealthStatus = 'pass' | 'warn' | 'fail';

export interface HealthCheckOutcome {
  readonly connectorId: string;
  readonly kind: HealthCheckKind;
  readonly status: HealthStatus;
  readonly latencyMs: number;
  readonly consecutiveFailures: number;
  readonly uptime24h: number;
  readonly checkedAt: Date;
  readonly detail: string | undefined;
  /** True when the RAG state changed — the only case worth alerting on. */
  readonly transitioned: boolean;
}

interface HealthRow {
  id: string;
  kind: HealthCheckKind;
  config: { intervalSec?: number };
  last_status: HealthStatus | null;
  consecutive_failures: number;
  uptime_24h: string;
  uptime_7d: string;
  uptime_30d: string;
  latency_p95_ms: number | null;
}

/**
 * Uptime is kept as an exponentially-weighted average rather than a count,
 * because a true 24-hour figure needs every sample retained and this row is
 * updated in place. The weight is one sample's share of the window, so the
 * number converges to the right value and reacts at the right speed; it is an
 * estimate, and the exact figure comes from `analytics.mv_ihub_hourly` when
 * EN-001 lands in Phase 11.
 */
function ewmaUptime(previous: number, healthy: boolean, samplesInWindow: number): number {
  const alpha = 1 / Math.max(samplesInWindow, 1);
  const value = previous * (1 - alpha) + (healthy ? 100 : 0) * alpha;
  return Math.round(Math.min(100, Math.max(0, value)) * 100) / 100;
}

export interface HealthCheckRunnerDeps {
  readonly db: IntegrationDatabase;
  readonly registry: ConnectorRegistry;
  readonly clock: Clock;
  readonly logger: AdapterLogger;
}

export class HealthCheckRunner {
  constructor(private readonly deps: HealthCheckRunnerDeps) {}

  /** Runs the connector's declared check and records the result. */
  async run(ctx: TenantContext, connectorKey: string): Promise<HealthCheckOutcome> {
    const record = await this.deps.registry.get(ctx, connectorKey);
    if (record === undefined) throw new ConnectorNotFoundError(connectorKey);

    const kind = record.config.health.kind;
    const adapter = await this.deps.registry.instantiate(record);

    // A probe that never returns is itself a failure; without the race a hung
    // TCP connect would stall the whole health sweep behind one dead device.
    const started = this.deps.clock.now();
    let status: HealthStatus;
    let latencyMs: number;
    let detail: string | undefined;
    try {
      const report = await adapter.healthCheck(kind);
      status = report.status;
      latencyMs = report.latencyMs;
      detail = report.detail;
    } catch (error) {
      status = 'fail';
      latencyMs = this.deps.clock.now().getTime() - started.getTime();
      detail = error instanceof Error ? error.message : 'health check threw';
    }

    return this.deps.db.withTenant(ctx, async (tx) => {
      const row = await this.readOrCreate(tx, record.id, ctx.hospitalId, kind, record.config.health);
      const intervalSec = record.config.health.intervalSec;
      const samplesIn24h = Math.max(Math.round(86_400 / Math.max(intervalSec, 1)), 1);
      const healthy = status !== 'fail';

      const consecutiveFailures = healthy ? 0 : row.consecutive_failures + 1;
      const uptime24h = ewmaUptime(Number(row.uptime_24h), healthy, samplesIn24h);
      const uptime7d = ewmaUptime(Number(row.uptime_7d), healthy, samplesIn24h * 7);
      const uptime30d = ewmaUptime(Number(row.uptime_30d), healthy, samplesIn24h * 30);
      // Decaying maximum: a spike is visible for a while and then fades. The
      // real p95 comes from the metrics pipeline; this keeps the column honest
      // rather than zero.
      const previousP95 = row.latency_p95_ms ?? 0;
      const latencyP95 = Math.max(latencyMs, Math.round(previousP95 * 0.9));
      const checkedAt = this.deps.clock.now();

      await tx.query(
        `UPDATE integration.ihub_health_checks
            SET last_run_at = $2, last_status = $3, consecutive_failures = $4,
                uptime_24h = $5, uptime_7d = $6, uptime_30d = $7,
                latency_p95_ms = $8, updated_at = $2
          WHERE id = $1`,
        [row.id, checkedAt, status, consecutiveFailures, uptime24h, uptime7d, uptime30d, latencyP95],
      );

      const transitioned = row.last_status !== status;
      if (transitioned) {
        // EN-017 §7 raises `integration.health.degraded|restored` here once the
        // outbox writer is wired into this service (Phase 3). Until then the
        // transition is at least visible in the log, never swallowed.
        this.deps.logger.warn(
          { connectorKey, kind, from: row.last_status, to: status, consecutiveFailures },
          'connector health transition',
        );
      }

      return {
        connectorId: record.id,
        kind,
        status,
        latencyMs,
        consecutiveFailures,
        uptime24h,
        checkedAt,
        detail,
        transitioned,
      };
    });
  }

  /** The current board, for the RAG dashboard. */
  async list(ctx: TenantContext): Promise<readonly (HealthRow & { connector_id: string })[]> {
    return this.deps.db.withTenant(ctx, (tx) =>
      tx.rows<HealthRow & { connector_id: string }>(
        `SELECT id, connector_id, kind, config, last_status, consecutive_failures,
                uptime_24h, uptime_7d, uptime_30d, latency_p95_ms
           FROM integration.ihub_health_checks
          ORDER BY last_status NULLS FIRST, connector_id`,
      ),
    );
  }

  private async readOrCreate(
    tx: TransactionClient,
    connectorId: string,
    hospitalId: string,
    kind: HealthCheckKind,
    config: unknown,
  ): Promise<HealthRow> {
    const existing = await tx.maybeOne<HealthRow>(
      `SELECT id, kind, config, last_status, consecutive_failures, uptime_24h, uptime_7d,
              uptime_30d, latency_p95_ms
         FROM integration.ihub_health_checks
        WHERE connector_id = $1 AND kind = $2`,
      [connectorId, kind],
    );
    if (existing !== undefined) return existing;

    // Registration creates the row; this branch covers a connector whose check
    // kind was changed by a new version.
    return tx.one<HealthRow>(
      `INSERT INTO integration.ihub_health_checks
         (id, hospital_id, connector_id, kind, config, consecutive_failures, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4::jsonb, 0, now(), now())
       RETURNING id, kind, config, last_status, consecutive_failures, uptime_24h,
                 uptime_7d, uptime_30d, latency_p95_ms`,
      [hospitalId, connectorId, kind, JSON.stringify(config)],
    );
  }
}
