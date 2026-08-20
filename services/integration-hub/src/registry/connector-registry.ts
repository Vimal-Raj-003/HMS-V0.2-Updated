/**
 * EN-017 §3.1 — the connector registry, backed by `integration.ihub_connectors`
 * and `integration.ihub_operations`.
 *
 * Everything here runs inside `IntegrationDatabase.withTenant`, so RLS decides
 * what is visible: a connector registered for hospital A is not filtered out of
 * hospital B's list by a `WHERE` clause, it is invisible to the query. That
 * distinction is the whole point of `docs/09` §3.1 — a `WHERE hospital_id = $1`
 * that someone forgets is a breach; a policy that someone forgets is an empty
 * result.
 *
 * **Registration is versioned, never mutated.** EN-017 §3.1.6: any change to
 * endpoint, auth or mapping creates a new connector version and the old one
 * stays, because `ihub_messages.connector_version` is how a message logged six
 * weeks ago is still interpretable. `register()` on an existing key therefore
 * inserts version n+1 and retires n, rather than issuing an UPDATE.
 *
 * ### One deviation from EN-017 §4, recorded here rather than in a comment nobody reads
 * The spec's `ihub_connectors` has columns for `endpoint`, `auth_type`,
 * `credentials_ref` and `tls`, but none for (a) adapter-specific options or
 * (b) the *non-secret* parameters of an auth scheme (`header`, `tokenUrl`,
 * `issuer`, `algorithm`, `username`). Both are stored inside the `endpoint`
 * JSONB document, under `auth` and `adapterOptions`, with the endpoint's own
 * fields left at the top level so the queries the spec implies
 * (`endpoint->>'url'`) still work, and with `auth.type` and the primary secret
 * reference projected into `auth_type` / `credentials_ref`. Nothing secret is
 * stored: `secretRefSchema` guarantees every credential is a `vault://`
 * reference. A dedicated `options jsonb` column is worth an ADR when the schema
 * next moves.
 */
import type { TransactionClient } from '../db/database.js';
import type { IntegrationDatabase, TenantContext } from '../db/database.js';
import type {
  AdapterContext,
  AdapterLogger,
  Clock,
  ConnectorAdapter,
  SecretResolver,
} from '../adapter/types.js';
import type {
  ConnectorCategory,
  ConnectorConfig,
  ConnectorDirection,
  ConnectorProtocol,
} from '../config/connector-config.js';
import { ConnectorConfigError, validateConnectorConfig } from '../config/validate.js';
import type { AdapterRegistry } from './adapter-registry.js';

export type ConnectorStatus = 'draft' | 'ready' | 'active' | 'paused' | 'failing' | 'retired';

export class ConnectorNotFoundError extends Error {
  constructor(key: string) {
    super(`no connector '${key}' in this tenant`);
    this.name = 'ConnectorNotFoundError';
  }
}

export class ConnectorLifecycleError extends Error {
  constructor(
    message: string,
    readonly unmet: readonly string[] = [],
  ) {
    super(unmet.length === 0 ? message : `${message}: ${unmet.join('; ')}`);
    this.name = 'ConnectorLifecycleError';
  }
}

export interface OperationRecord {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly direction: ConnectorDirection;
  readonly timeoutMs: number;
  readonly idempotency: 'none' | 'key_header' | 'natural_key';
  readonly active: boolean;
}

export interface ConnectorRecord {
  readonly id: string;
  readonly hospitalId: string;
  readonly branchId: string | null;
  readonly key: string;
  readonly name: string;
  readonly category: ConnectorCategory;
  readonly adapter: string;
  readonly protocol: ConnectorProtocol;
  readonly direction: ConnectorDirection;
  readonly environment: 'sandbox' | 'production';
  readonly status: ConnectorStatus;
  readonly version: number;
  readonly ownerUserId: string | null;
  readonly containsPhi: boolean;
  readonly crossBorder: boolean;
  readonly config: ConnectorConfig;
  readonly operations: readonly OperationRecord[];
}

export interface RegisterConnectorInput {
  readonly config: unknown;
  readonly branchId?: string | null;
  readonly ownerUserId?: string | null;
  readonly vendorContact?: Readonly<Record<string, unknown>>;
  readonly sla?: Readonly<Record<string, unknown>>;
}

export interface ConnectorRegistryDeps {
  readonly db: IntegrationDatabase;
  readonly adapters: AdapterRegistry;
  readonly newId: () => string;
  readonly clock: Clock;
  readonly logger: AdapterLogger;
  readonly secrets: SecretResolver;
}

interface ConnectorRow {
  id: string;
  hospital_id: string;
  branch_id: string | null;
  key: string;
  name: string;
  category: string;
  adapter: string;
  protocol: string;
  direction: ConnectorDirection;
  environment: string;
  endpoint: Record<string, unknown>;
  auth_type: string;
  credentials_ref: string | null;
  tls: Record<string, unknown>;
  status: ConnectorStatus;
  version: number;
  owner_user_id: string | null;
  dpdp: Record<string, unknown>;
  contains_phi: boolean;
  cross_border: boolean;
  requires_internet: boolean;
  retain_payload_days: number;
  retry_policy: Record<string, unknown> | null;
  circuit_policy: Record<string, unknown> | null;
  rate_limit: Record<string, unknown> | null;
  health_kind: string | null;
  health_config: Record<string, unknown> | null;
}

interface OperationRow {
  id: string;
  key: string;
  name: string;
  method: string | null;
  path: string | null;
  timeout_ms: number;
  idempotency: 'none' | 'key_header' | 'natural_key';
  partition_key_expr: string | null;
  active: boolean;
  retry_policy: Record<string, unknown>;
  circuit_policy: Record<string, unknown>;
  rate_limit: Record<string, unknown>;
}

/** The one secret reference that belongs in `credentials_ref`, per auth scheme. */
function primarySecretRef(auth: ConnectorConfig['auth']): string | null {
  switch (auth.type) {
    case 'none':
      return null;
    case 'api_key':
    case 'basic':
    case 'oauth2_cc':
    case 'hmac':
      return auth.secretRef;
    case 'jwt_bearer':
      return auth.keyRef;
    case 'mtls':
      return auth.clientCertRef;
    case 'sftp_key':
      return auth.keyRef;
    default:
      return null;
  }
}

export class ConnectorRegistry {
  /** Configured adapter instances, keyed by `connectorId:version`. */
  private readonly instances = new Map<string, ConnectorAdapter>();

  constructor(private readonly deps: ConnectorRegistryDeps) {}

  /**
   * Validates, then writes connector + operations + health check in one
   * transaction. The connector lands as `draft` — EN-017 §3.1 does not let a
   * connector reach `active` merely by existing.
   */
  async register(ctx: TenantContext, input: RegisterConnectorInput): Promise<ConnectorRecord> {
    const preview = this.peekConfigShape(input.config);
    const factory = this.deps.adapters.resolve(preview.adapter);
    const validation = validateConnectorConfig(input.config, factory);
    if (!validation.ok) throw new ConnectorConfigError(validation.issues);
    const config = validation.config;

    // Pin the resolved version: a later deploy adding v2 must not silently
    // change how this hospital's messages are formatted (EN-017 §3.1.6).
    const adapterRef = `${factory.manifest.id}@${factory.manifest.version}`;
    const now = this.deps.clock.now();

    return this.deps.db.withTenant(ctx, async (tx) => {
      const previous = await tx.maybeOne<{ version: number }>(
        `SELECT max(version) AS version FROM integration.ihub_connectors WHERE key = $1`,
        [config.key],
      );
      const version = (previous?.version ?? 0) + 1;

      if (version > 1) {
        await tx.query(
          `UPDATE integration.ihub_connectors
              SET status = 'retired'::integration."IhubConnectorStatus", updated_at = $2
            WHERE key = $1 AND status <> 'retired'::integration."IhubConnectorStatus"`,
          [config.key, now],
        );
      }

      const connectorId = this.deps.newId();
      const endpointDocument = {
        ...config.endpoint,
        auth: config.auth,
        adapterOptions: config.options,
      };

      await tx.query(
        `INSERT INTO integration.ihub_connectors
           (id, hospital_id, branch_id, key, name, category, adapter, protocol,
            direction, environment, endpoint, auth_type, credentials_ref, tls, egress,
            status, version, owner_user_id, vendor_contact, dpdp, contains_phi,
            cross_border, sla, requires_internet, retain_payload_days,
            created_at, created_by, updated_at, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                 $9::integration."IhubDirection", $10, $11::jsonb, $12, $13, $14::jsonb, '{}'::jsonb,
                 'draft'::integration."IhubConnectorStatus", $15, $16, $17::jsonb, $18::jsonb, $19,
                 $20, $21::jsonb, $22, $23,
                 $24, $16, $24, $16)`,
        [
          connectorId,
          ctx.hospitalId,
          input.branchId ?? null,
          config.key,
          config.name,
          config.category,
          adapterRef,
          config.protocol,
          config.direction,
          config.environment,
          JSON.stringify(endpointDocument),
          config.auth.type,
          primarySecretRef(config.auth),
          JSON.stringify(config.tls),
          version,
          input.ownerUserId ?? null,
          JSON.stringify(input.vendorContact ?? {}),
          JSON.stringify(config.dpdp),
          config.dpdp.containsPhi,
          config.dpdp.crossBorder,
          JSON.stringify(input.sla ?? {}),
          config.requiresInternet,
          config.retainPayloadDays,
          now,
        ],
      );

      for (const op of config.operations) {
        await tx.query(
          `INSERT INTO integration.ihub_operations
             (id, hospital_id, connector_id, key, name, method, path, timeout_ms,
              idempotency, partition_key_expr, retry_policy, circuit_policy, rate_limit,
              active, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13::jsonb, $14, $15, $15)`,
          [
            this.deps.newId(),
            ctx.hospitalId,
            connectorId,
            op.key,
            op.name,
            op.method ?? null,
            op.path ?? null,
            op.timeoutMs,
            op.idempotency,
            op.partitionKeyExpr ?? null,
            JSON.stringify(config.retry),
            JSON.stringify(config.circuit),
            JSON.stringify(config.rateLimit),
            op.active,
            now,
          ],
        );
      }

      // EN-017 §5: a connector cannot go active without a health check, so it is
      // created with the connector rather than left to a later screen.
      await tx.query(
        `INSERT INTO integration.ihub_health_checks
           (id, hospital_id, connector_id, kind, config, consecutive_failures, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, 0, $6, $6)
         ON CONFLICT (connector_id, kind) DO UPDATE SET config = EXCLUDED.config, updated_at = EXCLUDED.updated_at`,
        [
          this.deps.newId(),
          ctx.hospitalId,
          connectorId,
          config.health.kind,
          JSON.stringify(config.health),
          now,
        ],
      );

      const record = await this.readById(tx, connectorId);
      if (record === undefined) {
        // Only reachable if RLS rejected the row we just inserted, which means
        // the tenancy context and the hospital_id disagree — a bug worth naming.
        throw new ConnectorLifecycleError(
          `connector '${config.key}' was inserted but is not readable in this tenant scope`,
        );
      }
      this.deps.logger.info(
        { connectorKey: record.key, connectorVersion: record.version, adapter: adapterRef },
        'connector registered',
      );
      return record;
    });
  }

  /** EN-017 §3.1.5 — the gate between "configured" and "carrying traffic". */
  async activate(
    ctx: TenantContext,
    key: string,
    options: { readonly approvedBy?: string } = {},
  ): Promise<ConnectorRecord> {
    return this.deps.db.withTenant(ctx, async (tx) => {
      const record = await this.readByKey(tx, key);
      if (record === undefined) throw new ConnectorNotFoundError(key);

      const unmet: string[] = [];
      if (record.ownerUserId === null) unmet.push('no owner assigned');
      if (record.config.auth.type !== 'none' && primarySecretRef(record.config.auth) === null) {
        unmet.push('credentials reference missing');
      }
      const health = await tx.maybeOne<{ kind: string }>(
        `SELECT kind FROM integration.ihub_health_checks WHERE connector_id = $1 LIMIT 1`,
        [record.id],
      );
      if (health === undefined) unmet.push('no health check defined');
      if (record.containsPhi && options.approvedBy === undefined) {
        unmet.push('a PHI-carrying connector needs Hospital Admin approval (EN-017 §3.1.5)');
      }
      if (record.crossBorder && options.approvedBy === undefined) {
        unmet.push('a cross-border flow needs explicit approval before activation (EN-017 §5)');
      }
      if (unmet.length > 0) {
        throw new ConnectorLifecycleError(`connector '${key}' cannot be activated`, unmet);
      }

      await this.setStatus(tx, record.id, 'active', this.deps.clock.now());
      return { ...record, status: 'active' };
    });
  }

  /**
   * Enable/disable per hospital. `false` pauses rather than retires: EN-017
   * §3.1.7 keeps a paused connector's queue drainable, and a retired one is not
   * coming back.
   */
  async setEnabled(ctx: TenantContext, key: string, enabled: boolean): Promise<ConnectorRecord> {
    return this.deps.db.withTenant(ctx, async (tx) => {
      const record = await this.readByKey(tx, key);
      if (record === undefined) throw new ConnectorNotFoundError(key);
      if (record.status === 'retired') {
        throw new ConnectorLifecycleError(`connector '${key}' is retired and cannot be re-enabled`);
      }
      if (enabled && record.status === 'draft') {
        throw new ConnectorLifecycleError(
          `connector '${key}' is still a draft — activate it so the EN-017 §5 pre-conditions are checked`,
        );
      }
      const status: ConnectorStatus = enabled ? 'active' : 'paused';
      await this.setStatus(tx, record.id, status, this.deps.clock.now());
      return { ...record, status };
    });
  }

  async get(ctx: TenantContext, key: string): Promise<ConnectorRecord | undefined> {
    return this.deps.db.withTenant(ctx, (tx) => this.readByKey(tx, key));
  }

  async list(
    ctx: TenantContext,
    filter: { readonly status?: ConnectorStatus; readonly category?: ConnectorCategory } = {},
  ): Promise<readonly ConnectorRecord[]> {
    return this.deps.db.withTenant(ctx, async (tx) => {
      const rows = await tx.rows<{ id: string }>(
        `SELECT c.id
           FROM integration.ihub_connectors c
          WHERE c.deleted_at IS NULL
            AND ($1::text IS NULL OR c.status = $1::integration."IhubConnectorStatus")
            AND ($2::text IS NULL OR c.category = $2)
          ORDER BY c.key, c.version DESC`,
        [filter.status ?? null, filter.category ?? null],
      );
      const records: ConnectorRecord[] = [];
      for (const row of rows) {
        const record = await this.readById(tx, row.id);
        if (record !== undefined) records.push(record);
      }
      return records;
    });
  }

  /**
   * Returns the connector *and* a configured adapter instance.
   *
   * Instances are cached per `connectorId:version` because `configure()` is
   * where a real adapter opens its MLLP socket or its HTTP agent; creating one
   * per message would open a connection per message.
   */
  async resolveAdapter(
    ctx: TenantContext,
    key: string,
  ): Promise<{ readonly record: ConnectorRecord; readonly adapter: ConnectorAdapter }> {
    const record = await this.get(ctx, key);
    if (record === undefined) throw new ConnectorNotFoundError(key);
    return { record, adapter: await this.instantiate(record) };
  }

  async instantiate(record: ConnectorRecord): Promise<ConnectorAdapter> {
    const cacheKey = `${record.id}:${record.version}`;
    const cached = this.instances.get(cacheKey);
    if (cached !== undefined) return cached;

    const factory = this.deps.adapters.resolve(record.adapter);
    const adapter = factory.create();
    const context: AdapterContext = {
      config: record.config,
      connectorId: record.id,
      connectorVersion: record.version,
      hospitalId: record.hospitalId,
      environment: record.environment,
      sandbox: record.environment === 'sandbox',
      logger: this.deps.logger,
      clock: this.deps.clock,
      secrets: this.deps.secrets,
    };
    await adapter.configure(context);
    this.instances.set(cacheKey, adapter);
    return adapter;
  }

  /** EN-017 §3.1.7: graceful drain on shutdown or reconfiguration. */
  async closeAll(reason: 'shutdown' | 'reconfigure' | 'revoked' = 'shutdown'): Promise<void> {
    for (const adapter of this.instances.values()) {
      await adapter.close(reason);
    }
    this.instances.clear();
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async setStatus(
    tx: TransactionClient,
    connectorId: string,
    status: ConnectorStatus,
    at: Date,
  ): Promise<void> {
    await tx.query(
      `UPDATE integration.ihub_connectors
          SET status = $2::integration."IhubConnectorStatus", updated_at = $3
        WHERE id = $1`,
      [connectorId, status, at],
    );
  }

  private async readByKey(tx: TransactionClient, key: string): Promise<ConnectorRecord | undefined> {
    const row = await tx.maybeOne<{ id: string }>(
      `SELECT id FROM integration.ihub_connectors
        WHERE key = $1 AND deleted_at IS NULL
          AND status <> 'retired'::integration."IhubConnectorStatus"
        ORDER BY version DESC LIMIT 1`,
      [key],
    );
    if (row === undefined) return undefined;
    return this.readById(tx, row.id);
  }

  private async readById(tx: TransactionClient, id: string): Promise<ConnectorRecord | undefined> {
    const row = await tx.maybeOne<ConnectorRow>(
      `SELECT c.id, c.hospital_id, c.branch_id, c.key, c.name, c.category, c.adapter,
              c.protocol, c.direction, c.environment, c.endpoint, c.auth_type,
              c.credentials_ref, c.tls, c.status, c.version, c.owner_user_id, c.dpdp,
              c.contains_phi, c.cross_border, c.requires_internet, c.retain_payload_days,
              o.retry_policy, o.circuit_policy, o.rate_limit,
              h.kind AS health_kind, h.config AS health_config
         FROM integration.ihub_connectors c
         LEFT JOIN LATERAL (
           SELECT retry_policy, circuit_policy, rate_limit
             FROM integration.ihub_operations
            WHERE connector_id = c.id
            ORDER BY key LIMIT 1
         ) o ON true
         LEFT JOIN LATERAL (
           SELECT kind, config FROM integration.ihub_health_checks
            WHERE connector_id = c.id ORDER BY kind LIMIT 1
         ) h ON true
        WHERE c.id = $1 AND c.deleted_at IS NULL`,
      [id],
    );
    if (row === undefined) return undefined;

    const operations = await tx.rows<OperationRow>(
      `SELECT id, key, name, method, path, timeout_ms, idempotency,
              partition_key_expr, active, retry_policy, circuit_policy, rate_limit
         FROM integration.ihub_operations
        WHERE connector_id = $1 AND deleted_at IS NULL
        ORDER BY key`,
      [id],
    );

    const factory = this.deps.adapters.tryResolve(row.adapter);
    if (factory === undefined) {
      throw new ConnectorLifecycleError(
        `connector '${row.key}' v${row.version} references adapter '${row.adapter}', which this build does not contain`,
      );
    }

    // EN-017 §4 gives `ihub_operations` no `direction` column, and it is right
    // not to: an operation's direction is a property of the *adapter*, not of
    // one hospital's configuration of it, and storing it twice would let the
    // copies disagree. Validation already refuses a config that contradicts the
    // manifest, so the manifest is the authority on read.
    const declared = new Map(factory.manifest.capabilities.operations.map((op) => [op.key, op.direction]));
    const directionOf = (key: string): ConnectorDirection => declared.get(key) ?? row.direction;

    const { auth, adapterOptions, ...endpoint } = row.endpoint as {
      auth?: unknown;
      adapterOptions?: unknown;
    } & Record<string, unknown>;

    const rebuilt = {
      key: row.key,
      name: row.name,
      category: row.category,
      protocol: row.protocol,
      direction: row.direction,
      environment: row.environment,
      adapter: row.adapter,
      endpoint,
      auth,
      tls: row.tls,
      retry: row.retry_policy ?? undefined,
      circuit: row.circuit_policy ?? undefined,
      rateLimit: row.rate_limit ?? undefined,
      health: row.health_config ?? { kind: row.health_kind ?? 'ping' },
      dpdp: row.dpdp,
      requiresInternet: row.requires_internet,
      retainPayloadDays: row.retain_payload_days,
      operations: operations.map((op) => ({
        key: op.key,
        name: op.name,
        direction: directionOf(op.key),
        method: op.method ?? undefined,
        path: op.path ?? undefined,
        timeoutMs: op.timeout_ms,
        idempotency: op.idempotency,
        partitionKeyExpr: op.partition_key_expr ?? undefined,
        active: op.active,
      })),
      options: adapterOptions ?? {},
    };

    // Re-validating on read is not paranoia: the row may have been written by an
    // older build, and a config the current adapter cannot honour must surface
    // here rather than at 03:00 inside `send()`.
    const validation = validateConnectorConfig(rebuilt, factory);
    if (!validation.ok) throw new ConnectorConfigError(validation.issues);

    return {
      id: row.id,
      hospitalId: row.hospital_id,
      branchId: row.branch_id,
      key: row.key,
      name: row.name,
      category: validation.config.category,
      adapter: row.adapter,
      protocol: validation.config.protocol,
      direction: row.direction,
      environment: validation.config.environment,
      status: row.status,
      version: row.version,
      ownerUserId: row.owner_user_id,
      containsPhi: row.contains_phi,
      crossBorder: row.cross_border,
      config: validation.config,
      operations: operations.map((op) => ({
        id: op.id,
        key: op.key,
        name: op.name,
        direction: directionOf(op.key),
        timeoutMs: op.timeout_ms,
        idempotency: op.idempotency,
        active: op.active,
      })),
    };
  }

  /** Just enough of the config to find the adapter, before full validation. */
  private peekConfigShape(config: unknown): { readonly adapter: string } {
    if (typeof config !== 'object' || config === null || !('adapter' in config)) {
      throw new ConnectorConfigError([
        { path: 'adapter', message: 'a connector config must name its adapter as `id@version`' },
      ]);
    }
    const adapter: unknown = config.adapter;
    if (typeof adapter !== 'string' || adapter.length === 0) {
      throw new ConnectorConfigError([{ path: 'adapter', message: 'adapter must be a non-empty string' }]);
    }
    return { adapter };
  }
}
