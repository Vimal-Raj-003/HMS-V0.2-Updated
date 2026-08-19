/**
 * EN-017 §3.8 / `docs/08` §10.1 — the contract every connector implements.
 *
 * The interface is deliberately transport-agnostic, because the connectors that
 * have to satisfy it are not remotely alike: HL7 v2 over MLLP is a framed TCP
 * stream that answers with an ACK segment, ASTM is a serial/TCP record protocol,
 * FHIR R4 and ABDM are HTTPS + JSON, DICOM MWL is a C-FIND association, SMS is a
 * fire-and-forget HTTP POST, and a payment gateway is HTTP out plus a signed
 * webhook in. Three decisions make one interface cover all of them:
 *
 *  1. **The payload is `unknown` plus a declared `encoding`.** An adapter that
 *     speaks HL7 receives the canonical object and renders the pipe-delimited
 *     message itself; the hub never needs a per-protocol payload type, so adding
 *     a protocol adds an adapter and changes nothing here.
 *  2. **Outcomes are a closed union of error *classes*, not vendor codes.** The
 *     retry policy, the circuit breaker and the DLQ all key off `ErrorClass`, so
 *     "is this worth retrying?" is answered once, by the hub, rather than
 *     eleven times, inconsistently, inside eleven adapters.
 *  3. **Inbound is one optional method returning a canonical envelope.** An MLLP
 *     listener, an ASTM serial reader and a signed webhook differ in how bytes
 *     arrive — which is the adapter's problem — but agree that what comes out is
 *     one canonical message with a provider message id to deduplicate on.
 *
 * Naming note: `docs/08` §10.1 sketches these as `connect`/`dispatch`; the
 * lifecycle here is `configure`/`send` because Phase 0 also has to cover
 * adapters that hold no connection at all (a webhook signer, the null/echo
 * reference connector), for which "connect" is a lie. The shape is otherwise
 * that of the document, and the split into lifecycle (`configure`/`close`) and
 * data plane (`send`/`receive`/`healthCheck`) is unchanged.
 *
 * Adapters have **no database access and no module imports** (EN-017 §3.8).
 * Everything they may touch arrives in `AdapterContext`.
 */
import type {
  ConnectorConfig,
  ConnectorDirection,
  ConnectorProtocol,
  HealthCheckKind,
} from '../config/connector-config.js';

export type { ConnectorConfig, ConnectorDirection, ConnectorProtocol, HealthCheckKind };

/**
 * `docs/08` §10.1. The first five are retryable, the rest are not — and that
 * classification is the single most consequential thing an adapter reports,
 * because it decides whether a failure consumes the retry budget or goes
 * straight to a human in the DLQ.
 */
export const ERROR_CLASSES = [
  'network',
  'timeout',
  'auth',
  'rate_limited',
  'partner_5xx',
  'validation',
  'semantic_4xx',
  'mapping_error',
  'schema_drift',
  'not_supported',
  'poison',
  /** Replay of a message whose payload has passed its retention window. */
  'payload_purged',
] as const;

export type ErrorClass = (typeof ERROR_CLASSES)[number];

/**
 * `auth` is retryable exactly once in the sense that a cached OAuth token may
 * have expired between mint and use; EN-017 §3.9 then requires the connector to
 * auto-pause on a *hard* auth failure rather than hammer the partner, which is
 * what the circuit breaker does after `failureThreshold` consecutive rejections.
 */
export const RETRYABLE_ERROR_CLASSES: ReadonlySet<ErrorClass> = new Set<ErrorClass>([
  'network',
  'timeout',
  'auth',
  'rate_limited',
  'partner_5xx',
]);

export function isRetryableErrorClass(errorClass: ErrorClass): boolean {
  return RETRYABLE_ERROR_CLASSES.has(errorClass);
}

/** How the bytes on the wire are shaped. The hub never parses these; adapters do. */
export type PayloadEncoding = 'json' | 'xml' | 'hl7v2' | 'astm' | 'text' | 'binary' | 'dicom' | 'form';

export type CloseReason = 'shutdown' | 'reconfigure' | 'revoked';

/**
 * One callable thing on a partner: `createOrder`, `pushADT`, `C-FIND`,
 * `ORU^R01`. `sideEffectFree` is what makes an operation legal as an `echo`
 * health check — a health probe that books an appointment every 60 seconds is
 * the kind of mistake that only shows up in the partner's invoice.
 */
export interface OperationDescriptor {
  readonly key: string;
  readonly name: string;
  readonly direction: ConnectorDirection;
  /** HTTP verb, HL7 message type (`ORU^R01`), ASTM record type or DICOM service. */
  readonly method?: string;
  readonly path?: string;
  readonly encoding: PayloadEncoding;
  /** EN-017 §5: `none` means retries are forbidden — such failures go to the DLQ. */
  readonly idempotency: 'none' | 'key_header' | 'natural_key';
  readonly timeoutMs: number;
  readonly sideEffectFree: boolean;
}

/**
 * What the connector can do, declared rather than discovered. The registry
 * refuses a configuration the adapter cannot honour (an `in` direction on an
 * outbound-only adapter, a `dicom` protocol on an HTTP adapter, an `echo` health
 * check with no side-effect-free operation) at registration time, which is the
 * only time anyone is watching.
 */
export interface ConnectorCapabilities {
  readonly protocols: readonly ConnectorProtocol[];
  readonly directions: readonly ConnectorDirection[];
  readonly operations: readonly OperationDescriptor[];
  readonly healthCheckKinds: readonly HealthCheckKind[];
  /** Whether the partner honours an `Idempotency-Key`. `false` forces retry policy R0. */
  readonly supportsIdempotencyKey: boolean;
  /** FIFO per partition key, so ADT A01 can be guaranteed to precede A08. */
  readonly supportsPartitionedOrdering: boolean;
  /** EN-017 §3.8: record outbound calls without sending them. */
  readonly supportsSandbox: boolean;
  /** MLLP/ASTM/MQTT/WebSocket hold a long-lived socket; REST does not. */
  readonly supportsStreamingListener: boolean;
  readonly maxPayloadBytes?: number;
  /** EN-017 §5: on-prem must run WAN-down unless the adapter says otherwise. */
  readonly requiresInternet: boolean;
}

export interface ConnectorManifest {
  /** Package key, e.g. `vims.null-echo`. Matches `ihub_connector_packages.package_key`. */
  readonly id: string;
  /** `major.minor.patch`. Resolution is exact unless the reference omits it. */
  readonly version: string;
  readonly name: string;
  readonly publisher: string;
  readonly description: string;
  readonly capabilities: ConnectorCapabilities;
}

/** A message on its way out. Everything the adapter needs; nothing it does not. */
export interface OutboundMessage {
  readonly messageId: string;
  readonly correlationId: string;
  readonly operationKey: string;
  readonly encoding: PayloadEncoding;
  readonly payload: unknown;
  readonly headers: Readonly<Record<string, string>>;
  /** Propagated to the partner where supported; reused verbatim on replay. */
  readonly idempotencyKey?: string;
  /** FIFO key (accession, patient, analyzer) where ordering matters. */
  readonly partitionKey?: string;
  /** 1 for the first try. Adapters may surface it to the partner as a retry hint. */
  readonly attempt: number;
  readonly timeoutMs: number;
  /** EN-017 §3.8 sandbox mode: record the call, do not send it. */
  readonly sandbox: boolean;
  /** EN-017 §3.6: replay must not re-notify patients. */
  readonly suppressSideEffects: boolean;
}

export interface DispatchSuccess {
  readonly status: 'sent' | 'acknowledged';
  readonly partnerRef?: string;
  readonly latencyMs: number;
  readonly httpStatus?: number;
  /** HL7/ASTM acknowledgement code (`AA`, `AE`, `AR`). */
  readonly ackCode?: string;
  readonly response?: unknown;
}

export interface DispatchFailure {
  readonly status: 'failed';
  readonly errorClass: ErrorClass;
  readonly code?: string;
  readonly message?: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly latencyMs: number;
  readonly httpStatus?: number;
  /** Mapping path that failed, for the DLQ fingerprint (EN-017 §3.6). */
  readonly mappingPath?: string;
}

export type DispatchResult = DispatchSuccess | DispatchFailure;

/** Raw bytes as they arrived on a listener, a webhook or a watched folder. */
export interface RawInbound {
  readonly receivedAt: Date;
  readonly encoding: PayloadEncoding;
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string>>;
  /** Filename, socket peer, topic — whatever identifies where it came from. */
  readonly sourceRef?: string;
}

/**
 * EN-017 §3.3: adapters hand back canonical objects, never their own shapes, so
 * N connectors need N mappings rather than N².
 */
export interface CanonicalEnvelope {
  readonly canonicalType: string;
  readonly operationKey: string;
  /** EN-017 §3.5: inbound deduplication key. */
  readonly providerMessageId?: string;
  readonly payload: unknown;
  readonly receivedAt: Date;
}

export interface HealthReport {
  readonly status: 'pass' | 'warn' | 'fail';
  readonly latencyMs: number;
  readonly checkedAt: Date;
  readonly detail?: string;
  readonly errorClass?: ErrorClass;
}

/** Injected clock. `docs/09` §2 forbids ambient time in a test. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = Object.freeze({ now: (): Date => new Date() });

/**
 * EN-017 §5: "credentials are write-only… secrets never appear in message logs,
 * exports or errors". An adapter receives a *resolver*, never a value on its
 * config, so a secret cannot be reached by serialising the config object — which
 * is exactly how secrets end up in error reports.
 */
export interface SecretResolver {
  resolve(secretRef: string): Promise<string>;
}

/** Minimal logger surface. `pino` satisfies it; `console` deliberately does not. */
export interface AdapterLogger {
  debug(obj: Record<string, unknown>, msg?: string): void;
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

/**
 * Everything an adapter is allowed to know. `hospitalId` is present so the
 * adapter can scope a partner-side tenant header — never so it can query
 * anything; there is no database handle here and that omission is the point.
 */
export interface AdapterContext<TConfig extends ConnectorConfig = ConnectorConfig> {
  readonly config: TConfig;
  readonly connectorId: string;
  readonly connectorVersion: number;
  readonly hospitalId: string;
  readonly environment: 'sandbox' | 'production';
  readonly sandbox: boolean;
  readonly logger: AdapterLogger;
  readonly clock: Clock;
  readonly secrets: SecretResolver;
}

/**
 * The connector contract.
 *
 * `configure` is idempotent and may be called again after a config change;
 * `close` must drain rather than drop (EN-017 §3.1.7). `receive` is optional
 * because an outbound-only connector has nothing to implement.
 */
export interface ConnectorAdapter<TConfig extends ConnectorConfig = ConnectorConfig> {
  readonly manifest: ConnectorManifest;
  configure(ctx: AdapterContext<TConfig>): Promise<void>;
  send(operationKey: string, message: OutboundMessage): Promise<DispatchResult>;
  receive?(raw: RawInbound): Promise<CanonicalEnvelope>;
  healthCheck(kind: HealthCheckKind): Promise<HealthReport>;
  close(reason: CloseReason): Promise<void>;
}

/**
 * How the registry gets hold of an adapter.
 *
 * The factory carries the config schema as well as the manifest so that
 * validation and instantiation cannot drift apart: there is exactly one place
 * that knows what a connector of this type needs.
 */
export interface ConnectorAdapterFactory {
  readonly manifest: ConnectorManifest;
  /**
   * Adapter-specific narrowing on top of `connectorConfigSchema`. Runs *after*
   * the base schema, so an adapter only expresses what is peculiar to it.
   */
  readonly refineConfig?: (config: ConnectorConfig) => readonly string[];
  create(): ConnectorAdapter;
}

/** `id@version`, or a bare `id` meaning "the highest registered version". */
export type AdapterRef = string;

export function adapterRef(manifest: ConnectorManifest): AdapterRef {
  return `${manifest.id}@${manifest.version}`;
}
