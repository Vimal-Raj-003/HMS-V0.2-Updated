/**
 * Test support for EN-009: connector configurations that pass
 * `validateConnectorConfig`, a template that passes the DLT registry, and the
 * negative variants that must not.
 *
 * Shared for the same reason `fixtures.ts` is shared: a fixture copied into four
 * suites drifts, and the copy that drifts is always the one asserting the
 * security property. The *negative* fixtures matter as much as the positive
 * ones — `clinicalSmsTemplate()` exists so that "a template carrying a diagnosis
 * is refused at registration" is asserted against one canonical example rather
 * than four slightly different ones, one of which accidentally does not trip the
 * lint.
 */
import type { ConnectorConfigInput } from '../config/connector-config.js';
import type { SecretResolver } from '../adapter/types.js';
import { DRY_RUN_SMS_ADAPTER_REF } from '../adapters/dry-run-sms/dry-run-sms.adapter.js';
import { MSG91_ADAPTER_REF } from '../adapters/msg91/msg91.adapter.js';
import { TWILIO_ADAPTER_REF } from '../adapters/twilio/twilio.adapter.js';
import { WHATSAPP_ADAPTER_REF } from '../adapters/whatsapp-cloud/whatsapp-cloud.adapter.js';
import type { DltEntityConfig, DltRegistrationInput } from '../messaging/dlt-registry.js';
import type { TemplateVersion } from '../messaging/template-catalogue.js';
import type { LocaleCode } from '../messaging/types.js';

/**
 * A secret store for tests. Real deployments get Vault; the point here is that
 * the *reference* is what travels through the config, and only this resolver
 * ever sees a value — which is exactly the production arrangement.
 */
export class StaticSecretResolver implements SecretResolver {
  constructor(private readonly values: Readonly<Record<string, string>>) {}

  resolve(secretRef: string): Promise<string> {
    const value = this.values[secretRef];
    if (value === undefined) {
      return Promise.reject(new Error(`no test secret registered for '${secretRef}'`));
    }
    return Promise.resolve(value);
  }
}

export const TEST_SECRETS = Object.freeze({
  'vault://hms/connectors/msg91/authkey': 'test-msg91-authkey',
  'vault://hms/connectors/msg91/webhook_token': 'test-msg91-webhook-token',
  'vault://hms/connectors/twilio/credentials': 'AC0123456789abcdef0123456789abcdef:test-twilio-auth-token',
  'vault://hms/connectors/whatsapp/access_token': 'test-meta-access-token',
  'vault://hms/connectors/whatsapp/app_secret': 'test-meta-app-secret',
});

export const TWILIO_TEST_ACCOUNT_SID = 'AC0123456789abcdef0123456789abcdef';
export const TWILIO_TEST_AUTH_TOKEN = 'test-twilio-auth-token';
export const META_TEST_APP_SECRET = 'test-meta-app-secret';
export const MSG91_TEST_WEBHOOK_TOKEN = 'test-msg91-webhook-token';
export const TWILIO_STATUS_CALLBACK_URL = 'https://hms.example.org/api/v1/messaging/webhooks/twilio';

/**
 * Every messaging connector is R0 with a single attempt, and that is not a test
 * shortcut: no SMS or WhatsApp provider honours an idempotency key, so
 * `validateConnectorConfig` refuses any other retry policy. EN-017 §5 — a retry
 * is how a patient receives the same message three times.
 */
const NO_RETRY = {
  policy: 'R0',
  maxAttempts: 1,
  baseDelayMs: 1_000,
  backoffFactor: 2,
  maxDelayMs: 60_000,
  jitterMs: 0,
} as const;

export function dryRunSmsConnectorConfig(
  options: {
    readonly key?: string;
    readonly failures?: readonly {
      readonly errorClass: string;
      readonly code?: string;
      readonly times?: number | 'always';
    }[];
    readonly simulatedDeliveryStatus?: string;
  } = {},
): ConnectorConfigInput {
  return {
    key: options.key ?? 'sms-dry-run',
    name: 'SMS (dry run)',
    category: 'messaging',
    protocol: 'null',
    direction: 'both',
    environment: 'production',
    adapter: DRY_RUN_SMS_ADAPTER_REF,
    endpoint: {},
    auth: { type: 'none' },
    tls: { verify: true },
    retry: NO_RETRY,
    circuit: { failureThreshold: 3, errorRatePct: 50, coolDownSec: 60, halfOpenMaxProbes: 1 },
    rateLimit: { concurrency: 4 },
    health: { kind: 'ping', intervalSec: 60 },
    dpdp: {
      containsPhi: true,
      purpose:
        'Deliver appointment, token and billing notifications to patients by SMS during DLT onboarding.',
      dataCategories: ['contact', 'appointment'],
      crossBorder: false,
    },
    requiresInternet: false,
    retainPayloadDays: 30,
    operations: [
      {
        key: 'sendSms',
        name: 'Send SMS (dry run)',
        direction: 'out',
        idempotency: 'natural_key',
        timeoutMs: 5_000,
      },
      {
        key: 'deliveryReceipt',
        name: 'Delivery receipt',
        direction: 'in',
        idempotency: 'natural_key',
        timeoutMs: 5_000,
      },
    ],
    options: {
      ...(options.simulatedDeliveryStatus === undefined
        ? {}
        : { simulatedDeliveryStatus: options.simulatedDeliveryStatus }),
      ...(options.failures === undefined ? {} : { failures: options.failures }),
    },
  };
}

export function msg91ConnectorConfig(options: { readonly key?: string } = {}): ConnectorConfigInput {
  return {
    key: options.key ?? 'sms-msg91',
    name: 'MSG91 (SMS)',
    category: 'messaging',
    protocol: 'rest',
    direction: 'both',
    environment: 'production',
    adapter: MSG91_ADAPTER_REF,
    endpoint: { url: 'https://control.msg91.test' },
    auth: { type: 'api_key', header: 'authkey', secretRef: 'vault://hms/connectors/msg91/authkey' },
    tls: { verify: true },
    retry: NO_RETRY,
    circuit: { failureThreshold: 3, errorRatePct: 50, coolDownSec: 60, halfOpenMaxProbes: 1 },
    rateLimit: { concurrency: 8 },
    health: { kind: 'ping', intervalSec: 60 },
    dpdp: {
      containsPhi: true,
      purpose: 'Deliver appointment, token, report-ready and billing notifications to patients by SMS.',
      dataCategories: ['contact', 'appointment'],
      crossBorder: false,
    },
    requiresInternet: true,
    retainPayloadDays: 30,
    operations: [
      {
        key: 'sendSms',
        name: 'Send SMS',
        direction: 'out',
        method: 'POST',
        idempotency: 'natural_key',
        timeoutMs: 10_000,
      },
      {
        key: 'deliveryReceipt',
        name: 'Delivery report',
        direction: 'in',
        method: 'POST',
        idempotency: 'natural_key',
        timeoutMs: 5_000,
      },
    ],
    options: { webhookTokenRef: 'vault://hms/connectors/msg91/webhook_token' },
  };
}

export function twilioConnectorConfig(options: { readonly key?: string } = {}): ConnectorConfigInput {
  return {
    key: options.key ?? 'sms-twilio',
    name: 'Twilio (SMS)',
    category: 'messaging',
    protocol: 'rest',
    direction: 'both',
    environment: 'production',
    adapter: TWILIO_ADAPTER_REF,
    endpoint: { url: 'https://api.twilio.test' },
    auth: { type: 'basic', secretRef: 'vault://hms/connectors/twilio/credentials' },
    tls: { verify: true },
    retry: NO_RETRY,
    circuit: { failureThreshold: 3, errorRatePct: 50, coolDownSec: 60, halfOpenMaxProbes: 1 },
    rateLimit: { concurrency: 8 },
    health: { kind: 'ping', intervalSec: 60 },
    dpdp: {
      containsPhi: true,
      purpose:
        'Deliver appointment and billing notifications to patients by SMS through the secondary gateway.',
      dataCategories: ['contact', 'appointment'],
      crossBorder: false,
    },
    requiresInternet: true,
    retainPayloadDays: 30,
    operations: [
      {
        key: 'sendSms',
        name: 'Send SMS',
        direction: 'out',
        method: 'POST',
        idempotency: 'natural_key',
        timeoutMs: 10_000,
      },
      {
        key: 'deliveryReceipt',
        name: 'Status callback',
        direction: 'in',
        method: 'POST',
        idempotency: 'natural_key',
        timeoutMs: 5_000,
      },
    ],
    options: {
      accountSid: TWILIO_TEST_ACCOUNT_SID,
      fromNumber: '+15005550006',
      statusCallbackUrl: TWILIO_STATUS_CALLBACK_URL,
    },
  };
}

export function whatsAppConnectorConfig(options: { readonly key?: string } = {}): ConnectorConfigInput {
  return {
    key: options.key ?? 'wa-cloud',
    name: 'WhatsApp Cloud API',
    category: 'messaging',
    protocol: 'rest',
    direction: 'both',
    environment: 'production',
    adapter: WHATSAPP_ADAPTER_REF,
    endpoint: { url: 'https://graph.facebook.test' },
    auth: {
      type: 'api_key',
      header: 'Authorization',
      secretRef: 'vault://hms/connectors/whatsapp/access_token',
    },
    tls: { verify: true },
    retry: NO_RETRY,
    circuit: { failureThreshold: 3, errorRatePct: 50, coolDownSec: 60, halfOpenMaxProbes: 1 },
    rateLimit: { concurrency: 8 },
    health: { kind: 'ping', intervalSec: 60 },
    dpdp: {
      // Meta processes the message outside India, which is precisely the fact
      // EN-017 §5 and DPDP §16 require to be recorded rather than discovered.
      containsPhi: true,
      purpose:
        'Deliver appointment, token and billing notifications to patients over WhatsApp template messages.',
      dataCategories: ['contact', 'appointment'],
      crossBorder: true,
      dpaRef: 'DPA/META/2026-04',
      legalBasis: 'contract',
    },
    requiresInternet: true,
    retainPayloadDays: 30,
    operations: [
      {
        key: 'sendTemplate',
        name: 'Send template',
        direction: 'out',
        method: 'POST',
        idempotency: 'natural_key',
        timeoutMs: 10_000,
      },
      {
        key: 'deliveryReceipt',
        name: 'Status webhook',
        direction: 'in',
        method: 'POST',
        idempotency: 'natural_key',
        timeoutMs: 5_000,
      },
    ],
    options: {
      wabaId: '1122334455',
      phoneNumberId: '9988776655',
      graphVersion: 'v20.0',
      appSecretRef: 'vault://hms/connectors/whatsapp/app_secret',
    },
  };
}

// ── DLT and templates ────────────────────────────────────────────────────────

export function dltEntity(hospitalId: string): DltEntityConfig {
  return {
    hospitalId,
    entityId: '110100001234567890',
    senderIds: [
      { headerId: 'VIMHMS', categories: ['transactional', 'service_implicit', 'service_explicit'] },
      { headerId: 'VIMOFR', categories: ['promotional'] },
    ],
    urlWhitelist: ['hms.example.org', 'reports.example.org'],
  };
}

/** The canonical good template: an appointment confirmation with a name and a time. */
export function appointmentTemplate(
  hospitalId: string,
  locale: LocaleCode = 'en-IN',
  body = 'Dear {{1}}, your appointment at Vims Hospital is confirmed for {{2}}. Reply STOP to opt out.',
): TemplateVersion {
  return {
    hospitalId,
    key: 'appointment_confirmed',
    locale,
    channel: 'sms',
    messageClass: 'transactional',
    version: 1,
    body,
    variables: [
      { index: 1, name: 'patient', type: 'name', maxLength: 30, sample: 'R Iyer' },
      { index: 2, name: 'slot', type: 'datetime', maxLength: 30, sample: '21-08-2026 10:30' },
    ],
    ttlSeconds: 3600,
    ownerModule: 'OP-001',
  };
}

export function appointmentDltRegistration(
  hospitalId: string,
  locale: LocaleCode = 'en-IN',
  overrides: Partial<DltRegistrationInput> = {},
): DltRegistrationInput {
  const template = appointmentTemplate(hospitalId, locale);
  return {
    hospitalId,
    templateKey: template.key,
    locale,
    messageClass: 'transactional',
    dltCategory: 'service_implicit',
    dltTemplateId: '1707169999999900001',
    headerId: 'VIMHMS',
    registeredContent:
      'Dear {#var#}, your appointment at Vims Hospital is confirmed for {#var#}. Reply STOP to opt out.',
    body: template.body,
    variables: template.variables,
    ...overrides,
  };
}

/** The WhatsApp variant of the same template, approved by Meta. */
export function appointmentWhatsAppTemplate(
  hospitalId: string,
  locale: LocaleCode = 'en-IN',
): TemplateVersion {
  return {
    ...appointmentTemplate(hospitalId, locale),
    channel: 'whatsapp',
    whatsapp: {
      templateName: 'appointment_confirmed',
      languageCode: locale === 'en-IN' ? 'en' : locale,
      category: 'UTILITY',
      status: 'approved',
    },
  };
}

/**
 * The template that must never be registrable: it interpolates a diagnosis and
 * a result value into an SMS. `docs/prompts/phase-01`, EN-009 §5, EN-037 §135.
 */
export function clinicalSmsTemplate(hospitalId: string): DltRegistrationInput {
  return {
    hospitalId,
    templateKey: 'lab_result_value',
    locale: 'en-IN',
    messageClass: 'transactional',
    dltCategory: 'service_implicit',
    dltTemplateId: '1707169999999900099',
    headerId: 'VIMHMS',
    registeredContent: 'Dear {#var#}, your HbA1c is {#var#}. Diagnosis: {#var#}. Vims Hospital.',
    body: 'Dear {{1}}, your HbA1c is {{2}}. Diagnosis: {{3}}. Vims Hospital.',
    variables: [
      { index: 1, name: 'patient', type: 'name', maxLength: 30, sample: 'R Iyer' },
      { index: 2, name: 'result', type: 'number', maxLength: 10, sample: '7.8' },
      { index: 3, name: 'diagnosis', type: 'name', maxLength: 30, sample: 'Type 2 diabetes' },
    ],
  };
}
