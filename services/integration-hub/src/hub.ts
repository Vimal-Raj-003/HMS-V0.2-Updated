/**
 * The hub: one object that wires the registry, the message log, the circuit
 * breakers, the DLQ and the health checks together.
 *
 * EN-017's premise is that a module never opens its own socket, holds its own
 * credentials or writes its own retry loop. That is only true if there is a
 * single, obvious thing to call — so this is it. `services/api` will hold one
 * instance; `services/worker` will hold another for the sweeper and the health
 * cron.
 */
import type { Pool } from 'pg';
import { newId as defaultNewId } from '@vims/contracts';
import type { AdapterLogger, Clock, SecretResolver } from './adapter/types.js';
import { systemClock } from './adapter/types.js';
import { IntegrationDatabase, type TenantContext } from './db/database.js';
import { AdapterRegistry } from './registry/adapter-registry.js';
import { ConnectorRegistry } from './registry/connector-registry.js';
import { Dispatcher } from './dispatch/dispatcher.js';
import { DeadLetterQueue } from './dlq/dead-letter-queue.js';
import { MessageLog } from './messages/message-log.js';
import { CircuitStore } from './circuit/circuit-store.js';
import { HealthCheckRunner } from './health/health-check-runner.js';
import { InMemoryPayloadStore, type PayloadStore } from './payload/payload-store.js';
import { nullEchoFactory } from './adapters/null-echo/null-echo.adapter.js';
import { silentLogger } from './logger.js';
import { TemplateCatalogue, InMemoryTemplateStore, type TemplateStore } from './messaging/template-catalogue.js';
import {
  DltTemplateRegistry,
  InMemoryDltRegistrationStore,
  type DltRegistrationStore,
} from './messaging/dlt-registry.js';
import { ConsentLedger, InMemoryConsentStore, type ConsentStore } from './messaging/consent-ledger.js';
import { CostLedger, InMemoryCostStore, type CostStore } from './messaging/cost-ledger.js';
import { InMemoryMessageDirectory, type MessageDirectory } from './messaging/directory.js';
import {
  InMemoryMessagingSettingsStore,
  MessagingService,
  type MessagingSettingsStore,
} from './messaging/messaging-service.js';

/**
 * Phase 0 has no secret store wired. Failing loudly is the correct behaviour:
 * silently resolving to an empty string would let a connector be activated with
 * credentials that do not exist and fail at the partner instead of here.
 */
export const unavailableSecretResolver: SecretResolver = Object.freeze({
  resolve(secretRef: string): Promise<string> {
    return Promise.reject(
      new Error(
        `cannot resolve '${secretRef}': no secret store is configured in Phase 0. Vault/SSM arrives with EN-007 §secrets.`,
      ),
    );
  },
});

export interface IntegrationHubOptions {
  readonly pool: Pool;
  readonly logger?: AdapterLogger;
  readonly clock?: Clock;
  readonly newId?: () => string;
  readonly payloads?: PayloadStore;
  readonly secrets?: SecretResolver;
  /**
   * Adapters this instance may use. Defaults to the null/echo reference
   * connector alone — Phase 0 ships no live connector, and defaulting to
   * "everything linked" would be how one arrives by accident.
   */
  readonly adapters?: AdapterRegistry;
  /**
   * EN-009 stores. Each defaults to the in-memory implementation for the same
   * reason `PayloadStore` does: `msg_templates`, `msg_optins` and `msg_costs_daily`
   * live in the `engage` schema, which is a Phase-10 schema that does not exist
   * yet. The contracts are here now so the send path is written against the real
   * shape rather than retrofitted, and a durable implementation is a constructor
   * argument away.
   */
  readonly messaging?: {
    readonly templates?: TemplateStore;
    readonly dlt?: DltRegistrationStore;
    readonly consent?: ConsentStore;
    readonly costs?: CostStore;
    readonly directory?: MessageDirectory;
    readonly settings?: MessagingSettingsStore;
  };
}

export class IntegrationHub {
  readonly db: IntegrationDatabase;
  readonly adapters: AdapterRegistry;
  readonly connectors: ConnectorRegistry;
  readonly dispatcher: Dispatcher;
  readonly messages: MessageLog;
  readonly dlq: DeadLetterQueue;
  readonly circuits: CircuitStore;
  readonly health: HealthCheckRunner;
  readonly payloads: PayloadStore;

  /** EN-009: the send pipeline and the registries it refuses on. */
  readonly templates: TemplateCatalogue;
  readonly dlt: DltTemplateRegistry;
  readonly consent: ConsentLedger;
  readonly costs: CostLedger;
  readonly messageDirectory: MessageDirectory;
  readonly messaging: MessagingService;

  constructor(options: IntegrationHubOptions) {
    const logger = options.logger ?? silentLogger;
    const clock = options.clock ?? systemClock;
    const newId = options.newId ?? defaultNewId;

    this.db = new IntegrationDatabase(options.pool);
    this.adapters = options.adapters ?? new AdapterRegistry().register(nullEchoFactory);
    this.payloads = options.payloads ?? new InMemoryPayloadStore();
    this.messages = new MessageLog();
    this.dlq = new DeadLetterQueue(newId);
    this.circuits = new CircuitStore(newId);

    this.connectors = new ConnectorRegistry({
      db: this.db,
      adapters: this.adapters,
      newId,
      clock,
      logger,
      secrets: options.secrets ?? unavailableSecretResolver,
    });

    this.dispatcher = new Dispatcher({
      db: this.db,
      registry: this.connectors,
      payloads: this.payloads,
      clock,
      newId,
      logger,
      messageLog: this.messages,
      dlq: this.dlq,
      circuits: this.circuits,
    });

    this.health = new HealthCheckRunner({
      db: this.db,
      registry: this.connectors,
      clock,
      logger,
    });

    this.templates = new TemplateCatalogue(options.messaging?.templates ?? new InMemoryTemplateStore());
    this.dlt = new DltTemplateRegistry({
      store: options.messaging?.dlt ?? new InMemoryDltRegistrationStore(),
      clock,
    });
    this.consent = new ConsentLedger(options.messaging?.consent ?? new InMemoryConsentStore());
    this.costs = new CostLedger(options.messaging?.costs ?? new InMemoryCostStore());
    this.messageDirectory = options.messaging?.directory ?? new InMemoryMessageDirectory();

    this.messaging = new MessagingService({
      db: this.db,
      registry: this.connectors,
      dispatcher: this.dispatcher,
      templates: this.templates,
      dlt: this.dlt,
      consent: this.consent,
      costs: this.costs,
      directory: this.messageDirectory,
      settings: options.messaging?.settings ?? new InMemoryMessagingSettingsStore(),
      payloads: this.payloads,
      clock,
      newId,
      logger,
      messageLog: this.messages,
      dlq: this.dlq,
    });
  }

  /** The morning triage list, EN-017 §3.6. */
  async openDeadLetters(ctx: TenantContext, limit = 50): Promise<ReturnType<DeadLetterQueue['list']>> {
    return this.db.withTenant(ctx, (tx) => this.dlq.list(tx, { status: 'open', limit }));
  }

  /** EN-017 §3.1.7 — drain adapters before the process exits. */
  async shutdown(): Promise<void> {
    await this.connectors.closeAll('shutdown');
  }
}
