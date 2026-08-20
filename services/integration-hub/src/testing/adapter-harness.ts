/**
 * A configured `AdapterContext` and a canonical `OutboundMessage`, for suites
 * that exercise an adapter directly rather than through the dispatcher.
 *
 * Shared because four adapter suites need the same thing and a copy in each is
 * four places for the environment, the clock or the secret resolver to drift —
 * and the one that drifts is the one whose adapter then behaves differently in a
 * test than it does under the hub.
 */
import type { AdapterContext, ConnectorAdapterFactory, Clock, OutboundMessage } from '../adapter/types.js';
import type { ConnectorConfigInput } from '../config/connector-config.js';
import { parseConnectorConfig } from '../config/validate.js';
import { silentLogger } from '../logger.js';
import { StaticSecretResolver, TEST_SECRETS } from './messaging-fixtures.js';

/** A clock that does not move unless a test moves it. `docs/09` §2 bans ambient time. */
export class FixedClock implements Clock {
  private t: Date;
  constructor(start: Date = new Date('2026-08-21T08:30:00.000Z')) {
    this.t = start;
  }
  now(): Date {
    return new Date(this.t.getTime());
  }
  advance(ms: number): void {
    this.t = new Date(this.t.getTime() + ms);
  }
}

export function adapterContext(
  config: ConnectorConfigInput,
  factory: ConnectorAdapterFactory,
  options: { readonly sandbox?: boolean; readonly clock?: Clock } = {},
): AdapterContext {
  const parsed = parseConnectorConfig(config, factory);
  return {
    config: parsed,
    connectorId: '00000000-0000-7000-8000-000000000101',
    connectorVersion: 1,
    hospitalId: '00000000-0000-7000-8000-000000000102',
    environment: options.sandbox === true ? 'sandbox' : 'production',
    sandbox: options.sandbox === true,
    logger: silentLogger,
    clock: options.clock ?? new FixedClock(),
    secrets: new StaticSecretResolver(TEST_SECRETS),
  };
}

export function outboundMessage(
  operationKey: string,
  payload: unknown,
  overrides: Partial<OutboundMessage> = {},
): OutboundMessage {
  return {
    messageId: '00000000-0000-7000-8000-0000000000aa',
    correlationId: '00000000-0000-7000-8000-0000000000bb',
    operationKey,
    encoding: 'json',
    payload,
    headers: {},
    attempt: 1,
    timeoutMs: 10_000,
    sandbox: false,
    suppressSideEffects: false,
    ...overrides,
  };
}

/** A canonical, DLT-complete SMS payload — the shape every SMS adapter parses. */
export const SMS_PAYLOAD = Object.freeze({
  channel: 'sms' as const,
  mobile: '+919876543210',
  body: 'Dear R Iyer, your appointment at Vims Hospital is confirmed for 21-08-2026 10:30. Reply STOP to opt out.',
  senderId: 'VIMHMS',
  dltEntityId: '110100001234567890',
  dltTemplateId: '1707169999999900001',
  dltCategory: 'service_implicit' as const,
  templateKey: 'appointment_confirmed',
  locale: 'en-IN' as const,
  messageClass: 'transactional' as const,
  encoding: 'gsm7' as const,
  segments: 1,
  templateVars: { patient: 'R Iyer', slot: '21-08-2026 10:30' },
  varsHash: 'ab'.repeat(16),
});

export const WHATSAPP_PAYLOAD = Object.freeze({
  channel: 'whatsapp' as const,
  mobile: '+919876543210',
  templateName: 'appointment_confirmed',
  languageCode: 'en',
  category: 'UTILITY' as const,
  templateKey: 'appointment_confirmed',
  locale: 'en-IN' as const,
  messageClass: 'transactional' as const,
  templateParameters: ['R Iyer', '21-08-2026 10:30'],
  templateVars: { patient: 'R Iyer', slot: '21-08-2026 10:30' },
  varsHash: 'ab'.repeat(16),
  body: 'Dear R Iyer, your appointment at Vims Hospital is confirmed for 21-08-2026 10:30.',
});
