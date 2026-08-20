import { createHmac } from 'node:crypto';
import { newId } from '@vims/contracts';
import type { TenantContext } from '@vims/db/tenancy';
import { createTenantFixture, startTestPostgres, type TenantFixture, type TestPostgres } from '@vims/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Clock } from './adapter/types.js';
import { createMsg91Factory } from './adapters/msg91/msg91.adapter.js';
import { createTwilioFactory } from './adapters/twilio/twilio.adapter.js';
import { createWhatsAppCloudFactory } from './adapters/whatsapp-cloud/whatsapp-cloud.adapter.js';
import { dryRunSmsFactory } from './adapters/dry-run-sms/dry-run-sms.adapter.js';
import { nullEchoFactory } from './adapters/null-echo/null-echo.adapter.js';
import { IntegrationHub } from './hub.js';
import { silentLogger } from './logger.js';
import { InMemoryPayloadStore } from './payload/payload-store.js';
import { AdapterRegistry } from './registry/adapter-registry.js';
import { FakeHttpTransport, jsonResponse } from './messaging/http/transport.js';
import { WHATSAPP_CONVERSATION_WINDOW_MS } from './messaging/cost-ledger.js';
import {
  META_TEST_APP_SECRET,
  StaticSecretResolver,
  TEST_SECRETS,
  appointmentDltRegistration,
  appointmentTemplate,
  appointmentWhatsAppTemplate,
  clinicalSmsTemplate,
  dltEntity,
  dryRunSmsConnectorConfig,
  msg91ConnectorConfig,
  twilioConnectorConfig,
  whatsAppConnectorConfig,
} from './testing/messaging-fixtures.js';

/**
 * EN-009 end to end, against the real database.
 *
 * The properties here cannot be asserted against a mock, and a suite that mocked
 * them would go green while production leaked:
 *
 *  * a policy refusal is a **row** in `integration.ihub_messages`, not a return
 *    value that a caller may ignore;
 *  * the redacted copy of a sent message genuinely does not contain the mobile
 *    number, the patient's name or the rendered body — asserted by reading as the
 *    **schema owner**, which is not subject to RLS, so the absence cannot be an
 *    artefact of a policy hiding the row;
 *  * a delivery webhook moves the status of a row that another transaction
 *    wrote;
 *  * a WhatsApp failure produces a second, linked row on the SMS connector.
 *
 * Nothing here touches a network: every HTTP adapter is built on one
 * `FakeHttpTransport`, exactly as the null/echo connector is built on no
 * transport at all.
 */

class TestClock implements Clock {
  private t: Date;
  constructor(start: Date) {
    this.t = start;
  }
  now(): Date {
    return new Date(this.t.getTime());
  }
  set(at: Date): void {
    this.t = new Date(at.getTime());
  }
  advance(ms: number): void {
    this.t = new Date(this.t.getTime() + ms);
  }
}

const PATIENT_MOBILE_RAW = '+91 98765 43210';
const PATIENT_MOBILE_E164 = '+919876543210';
const PATIENT_NAME = 'R Iyer';
/** 14:00 IST — well inside the promotional window, so it is never the reason. */
const MIDDAY = new Date('2026-08-21T08:30:00.000Z');

let pg: TestPostgres;
let tenants: TenantFixture;
let hub: IntegrationHub;
let payloads: InMemoryPayloadStore;
let clock: TestClock;
let transport: FakeHttpTransport;
let ctxA: TenantContext;

const WA_SEND = '/v20.0/9988776655/messages';

function signMeta(rawBody: string): string {
  return `sha256=${createHmac('sha256', META_TEST_APP_SECRET).update(rawBody, 'utf8').digest('hex')}`;
}

beforeAll(async () => {
  pg = await startTestPostgres();
  tenants = await createTenantFixture(pg);
  clock = new TestClock(MIDDAY);
  payloads = new InMemoryPayloadStore();
  transport = new FakeHttpTransport();

  const adapters = new AdapterRegistry()
    .register(nullEchoFactory)
    .register(dryRunSmsFactory)
    .register(createMsg91Factory(transport))
    .register(createTwilioFactory(transport))
    .register(createWhatsAppCloudFactory(transport));

  hub = new IntegrationHub({
    pool: pg.pool('app'),
    clock,
    logger: silentLogger,
    newId,
    payloads,
    adapters,
    secrets: new StaticSecretResolver(TEST_SECRETS),
  });

  ctxA = { hospitalId: tenants.hospitalA, userId: newId(), scope: 'branch', branchIds: [tenants.branchA] };

  await hub.messaging.configureHospital({
    hospitalId: tenants.hospitalA,
    timeZone: 'Asia/Kolkata',
    defaultCountryCode: '91',
    dedupeWindowSeconds: 600,
    whatsAppToSmsFallback: true,
    // A webhook-driven fallback has no caller to name a connector, so the
    // hospital configures one rather than the code guessing.
    fallbackSmsConnectorKey: 'sms-webhook-fallback',
  });
  await hub.dlt.configureEntity(dltEntity(tenants.hospitalA));
  await hub.costs.setRateCard({
    hospitalId: tenants.hospitalA,
    currency: 'INR',
    homeCountryCode: '91',
    sms: { perSegment: 18, dltCharge: 3 },
    whatsapp: {
      perConversation: { UTILITY: 115, AUTHENTICATION: 130, MARKETING: 880 },
      conversationWindowMs: WHATSAPP_CONVERSATION_WINDOW_MS,
    },
  });

  await hub.templates.register(appointmentTemplate(tenants.hospitalA, 'en-IN'));
  await hub.templates.register(appointmentWhatsAppTemplate(tenants.hospitalA, 'en-IN'));
  const registered = await hub.dlt.register(appointmentDltRegistration(tenants.hospitalA, 'en-IN'));
  if (!registered.ok) throw new Error(registered.issues.map((i) => i.message).join('; '));
}, 300_000);

afterAll(async () => {
  await hub?.shutdown();
  await pg?.stop();
});

async function liveConnector(
  config: Parameters<typeof hub.connectors.register>[1]['config'],
): Promise<string> {
  const owner = newId();
  const record = await hub.connectors.register(ctxA, { config, ownerUserId: owner });
  await hub.connectors.activate(ctxA, record.key, { approvedBy: owner });
  return record.key;
}

/** Read as the schema owner, which is *not* subject to RLS. */
async function messageRow(id: string): Promise<
  | {
      status: string;
      ack_code: string | null;
      error_class: string | null;
      payload: string;
      response: string | null;
      contains_phi: boolean;
      parent_message_id: string | null;
    }
  | undefined
> {
  const result = await pg.pool('migrator').query<{
    status: string;
    ack_code: string | null;
    error_class: string | null;
    payload: string;
    response: string | null;
    contains_phi: boolean;
    parent_message_id: string | null;
  }>(
    `SELECT status::text AS status, ack_code, error_class,
            payload_redacted::text AS payload, response_redacted::text AS response,
            contains_phi, parent_message_id
       FROM integration.ihub_messages WHERE id = $1`,
    [id],
  );
  return result.rows[0];
}

describe('the send pipeline, end to end', () => {
  it('sends an SMS through the dry-run connector, prices it and records the DLT ids', async () => {
    const key = await liveConnector(dryRunSmsConnectorConfig({ key: 'sms-happy' }));

    const outcome = await hub.messaging.send(ctxA, {
      templateKey: 'appointment_confirmed',
      to: PATIENT_MOBILE_RAW,
      values: { patient: PATIENT_NAME, slot: '21-08-2026 10:30' },
      module: 'OP-001',
      smsConnectorKey: key,
      channelPolicy: 'sms_only',
      refType: 'appointment',
      refId: newId(),
      at: MIDDAY,
    });

    expect(outcome.status).toBe('sent');
    if (outcome.status !== 'sent') throw new Error(JSON.stringify(outcome));
    expect(outcome.channel).toBe('sms');
    expect(outcome.locale).toBe('en-IN');
    // 18 paise/segment + 3 paise DLT.
    expect(outcome.cost.amount).toBe(21);
    expect(outcome.providerMessageId).toBe(`dryrun:${outcome.messageId}`);

    const row = await messageRow(outcome.messageId);
    expect(row?.status).toBe('acknowledged');

    const costs = await hub.costs.totals(tenants.hospitalA, { groupBy: 'module' });
    expect((costs.get('OP-001')?.amount ?? 0) >= 21).toBe(true);
  });

  it('falls back to the en-IN template when the patient language has no variant', async () => {
    const key = await liveConnector(dryRunSmsConnectorConfig({ key: 'sms-locale' }));

    const outcome = await hub.messaging.send(ctxA, {
      templateKey: 'appointment_confirmed',
      to: PATIENT_MOBILE_RAW,
      values: { patient: PATIENT_NAME, slot: '22-08-2026 11:00' },
      module: 'OP-001',
      smsConnectorKey: key,
      channelPolicy: 'sms_only',
      locale: 'ta',
      refType: 'appointment',
      refId: newId(),
      at: MIDDAY,
    });

    expect(outcome.status).toBe('sent');
    if (outcome.status !== 'sent') throw new Error(JSON.stringify(outcome));
    expect(outcome.fellBackToDefaultLocale).toBe(true);
    expect(outcome.locale).toBe('en-IN');
  });

  it('refuses an unregistered template and records the refusal rather than sending', async () => {
    const key = await liveConnector(dryRunSmsConnectorConfig({ key: 'sms-unregistered' }));
    await hub.templates.register({
      ...appointmentTemplate(tenants.hospitalA, 'en-IN'),
      key: 'never_registered',
    });

    const outcome = await hub.messaging.send(ctxA, {
      templateKey: 'never_registered',
      to: PATIENT_MOBILE_RAW,
      values: { patient: PATIENT_NAME, slot: '21-08-2026 10:30' },
      module: 'OP-001',
      smsConnectorKey: key,
      channelPolicy: 'sms_only',
      at: MIDDAY,
    });

    expect(outcome.status).toBe('refused');
    if (outcome.status !== 'refused') throw new Error(JSON.stringify(outcome));
    expect(outcome.reason).toBe('template_unregistered');
    expect(outcome.messageId).not.toBeNull();

    const row = await messageRow(outcome.messageId ?? '');
    expect(row?.status).toBe('blocked');
    expect(row?.payload).toContain('template_unregistered');
  });

  it('refuses a template edited after registration, so nothing is sent into the void', async () => {
    const key = await liveConnector(dryRunSmsConnectorConfig({ key: 'sms-drift' }));
    // A typo fix six weeks later silently unregisters the template with DLT.
    await hub.templates.register(
      appointmentTemplate(
        tenants.hospitalA,
        'en-IN',
        'Dear {{1}}, your appointment at Vims Hospital is confirmed for {{2}}! Reply STOP to opt out.',
      ),
    );

    const outcome = await hub.messaging.send(ctxA, {
      templateKey: 'appointment_confirmed',
      to: PATIENT_MOBILE_RAW,
      values: { patient: PATIENT_NAME, slot: '21-08-2026 10:30' },
      module: 'OP-001',
      smsConnectorKey: key,
      channelPolicy: 'sms_only',
      at: MIDDAY,
    });

    expect(outcome.status).toBe('refused');
    if (outcome.status !== 'refused') throw new Error(JSON.stringify(outcome));
    expect(outcome.reason).toBe('template_drift');

    const row = await messageRow(outcome.messageId ?? '');
    expect(row?.status).toBe('blocked');

    // Restore the registered body for the rest of the suite.
    await hub.templates.register(appointmentTemplate(tenants.hospitalA, 'en-IN'));
  });

  it('refuses a clinical template at REGISTRATION, so no send ever reaches the gate', async () => {
    const result = await hub.dlt.register(clinicalSmsTemplate(tenants.hospitalA));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('a clinical template was registered');
    expect(result.issues.some((i) => i.code === 'clinical_content')).toBe(true);
    expect(await hub.dlt.lookup(tenants.hospitalA, 'lab_result_value', 'en-IN')).toBeUndefined();
  });
});

describe('DND and opt-out', () => {
  it('refuses a send to an opted-out number AND records it in both ledgers', async () => {
    const key = await liveConnector(dryRunSmsConnectorConfig({ key: 'sms-optout' }));
    const optedOut = '+919812345678';

    await hub.consent.optOut({
      hospitalId: tenants.hospitalA,
      phoneE164: optedOut,
      channel: 'sms',
      consentClass: 'transactional',
      source: 'front_desk',
      at: MIDDAY,
    });

    const outcome = await hub.messaging.send(ctxA, {
      templateKey: 'appointment_confirmed',
      to: optedOut,
      values: { patient: PATIENT_NAME, slot: '21-08-2026 10:30' },
      module: 'OP-001',
      smsConnectorKey: key,
      channelPolicy: 'sms_only',
      refType: 'appointment',
      refId: newId(),
      at: MIDDAY,
    });

    // Refused …
    expect(outcome.status).toBe('refused');
    if (outcome.status !== 'refused') throw new Error(JSON.stringify(outcome));
    expect(outcome.reason).toBe('opted_out');

    // … and recorded, not silently dropped: a row exists in the message log so
    // the sending module can see its notification never left (`docs/04` §7).
    const row = await messageRow(outcome.messageId ?? '');
    expect(row?.status).toBe('blocked');
    expect(row?.payload).toContain('opted_out');
    // The refusal reason carries the mask, never the number.
    expect(row?.payload).toContain('«phone:5678»');
    expect(row?.payload).not.toContain('9812345678');

    // … and in the consent ledger, which is what a Privacy Officer answers a
    // complaint from.
    const decisions = await hub.consent.decisionsFor(tenants.hospitalA, optedOut);
    expect(decisions.some((d) => !d.allowed && d.reason === 'opted_out')).toBe(true);
    expect(decisions.some((d) => d.messageId === outcome.messageId)).toBe(true);
  });

  it('drops a promotional message to a DND number while the same number still gets its appointment', async () => {
    const key = await liveConnector(dryRunSmsConnectorConfig({ key: 'sms-dnd' }));
    const dndNumber = '+919811111111';

    // A promotional template, fully consented, on the promotional header.
    await hub.templates.register({
      ...appointmentTemplate(tenants.hospitalA, 'en-IN'),
      key: 'camp_invite',
      messageClass: 'promotional',
      body: 'Dear {{1}}, join our free health camp on {{2}}. Reply STOP to opt out.',
    });
    const promo = await hub.dlt.register({
      ...appointmentDltRegistration(tenants.hospitalA, 'en-IN'),
      templateKey: 'camp_invite',
      messageClass: 'promotional',
      dltCategory: 'promotional',
      headerId: 'VIMOFR',
      dltTemplateId: '1707169999999900002',
      body: 'Dear {{1}}, join our free health camp on {{2}}. Reply STOP to opt out.',
      registeredContent: 'Dear {#var#}, join our free health camp on {#var#}. Reply STOP to opt out.',
    });
    if (!promo.ok) throw new Error(promo.issues.map((i) => i.message).join('; '));

    await hub.consent.recordConsent({
      hospitalId: tenants.hospitalA,
      phoneE164: dndNumber,
      channel: 'sms',
      consentClass: 'promotional',
      status: 'opted_in',
      source: 'campaign_form',
      at: MIDDAY,
    });
    await hub.consent.recordDnd({ phoneE164: dndNumber, preference: 'promotional', scrubbedAt: MIDDAY });

    const dropped = await hub.messaging.send(ctxA, {
      templateKey: 'camp_invite',
      to: dndNumber,
      values: { patient: PATIENT_NAME, slot: '30-08-2026' },
      module: 'NC-026',
      smsConnectorKey: key,
      channelPolicy: 'sms_only',
      at: MIDDAY,
    });
    expect(dropped.status).toBe('refused');
    if (dropped.status !== 'refused') throw new Error(JSON.stringify(dropped));
    expect(dropped.reason).toBe('dnd_registered');

    // The classification is what decides: the same number, the same instant, a
    // transactional template — and it goes.
    const sent = await hub.messaging.send(ctxA, {
      templateKey: 'appointment_confirmed',
      to: dndNumber,
      values: { patient: PATIENT_NAME, slot: '21-08-2026 10:30' },
      module: 'OP-001',
      smsConnectorKey: key,
      channelPolicy: 'sms_only',
      refType: 'appointment',
      refId: newId(),
      at: MIDDAY,
    });
    expect(sent.status).toBe('sent');
  });

  it('drops a promotional message outside the 9AM-9PM window', async () => {
    const key = await liveConnector(dryRunSmsConnectorConfig({ key: 'sms-window' }));
    const number = '+919822222222';
    await hub.consent.recordConsent({
      hospitalId: tenants.hospitalA,
      phoneE164: number,
      channel: 'sms',
      consentClass: 'promotional',
      status: 'opted_in',
      source: 'campaign_form',
      at: MIDDAY,
    });

    const outcome = await hub.messaging.send(ctxA, {
      templateKey: 'camp_invite',
      to: number,
      values: { patient: PATIENT_NAME, slot: '30-08-2026' },
      module: 'NC-026',
      smsConnectorKey: key,
      channelPolicy: 'sms_only',
      // 21:30 IST.
      at: new Date('2026-08-21T16:00:00.000Z'),
    });

    expect(outcome.status).toBe('refused');
    if (outcome.status !== 'refused') throw new Error(JSON.stringify(outcome));
    expect(outcome.reason).toBe('outside_promotional_window');
    expect((await messageRow(outcome.messageId ?? ''))?.status).toBe('blocked');
  });
});

describe('no PHI in the message log', () => {
  it('stores nothing that identifies the patient — asserted as the schema owner, so RLS cannot mask a failure', async () => {
    const key = await liveConnector(dryRunSmsConnectorConfig({ key: 'sms-phi' }));

    const outcome = await hub.messaging.send(ctxA, {
      templateKey: 'appointment_confirmed',
      to: PATIENT_MOBILE_RAW,
      values: { patient: 'Ramesh Kumar Iyer', slot: '21-08-2026 10:30' },
      module: 'OP-001',
      smsConnectorKey: key,
      channelPolicy: 'sms_only',
      refType: 'appointment',
      refId: newId(),
      at: MIDDAY,
    });
    expect(outcome.status).toBe('sent');
    if (outcome.status !== 'sent') throw new Error(JSON.stringify(outcome));

    const row = await messageRow(outcome.messageId);
    expect(row).toBeDefined();
    const haystack = `${row?.payload ?? ''}\n${row?.response ?? ''}`;

    // The assertions that matter are the absences.
    expect(haystack).not.toContain('9876543210');
    expect(haystack).not.toContain('98765 43210');
    expect(haystack).not.toContain(PATIENT_MOBILE_E164);
    expect(haystack).not.toContain('Ramesh');
    expect(haystack).not.toContain('Iyer');
    // The rendered body carries the name by design — the template approval says
    // so — which is exactly why it may not live in the searchable copy.
    expect(haystack).not.toContain('your appointment at Vims Hospital is confirmed');

    // …and the typed tokens took their place.
    expect(haystack).toContain('«phone:3210»');
    expect(haystack).toContain('«text');
    expect(row?.contains_phi).toBe(true);

    // The full body is retrievable only through the payload store, which is
    // where the encryption and the `ihub.payload.read` gate live.
    expect(payloads.size).toBeGreaterThan(0);
  });

  it('keeps the operational metadata a support engineer needs at 03:00', async () => {
    const key = await liveConnector(dryRunSmsConnectorConfig({ key: 'sms-metadata' }));
    const outcome = await hub.messaging.send(ctxA, {
      templateKey: 'appointment_confirmed',
      to: PATIENT_MOBILE_RAW,
      values: { patient: PATIENT_NAME, slot: '21-08-2026 10:30' },
      module: 'OP-001',
      smsConnectorKey: key,
      channelPolicy: 'sms_only',
      refType: 'appointment',
      refId: newId(),
      at: MIDDAY,
    });
    if (outcome.status !== 'sent') throw new Error(JSON.stringify(outcome));

    const row = await messageRow(outcome.messageId);
    // Redaction that removed the template key and the DLT id would make the log
    // useless, and a useless log gets replaced with a plain one.
    expect(row?.payload).toContain('appointment_confirmed');
    expect(row?.payload).toContain('1707169999999900001');
    expect(row?.payload).toContain('VIMHMS');
  });
});

describe('delivery webhooks', () => {
  it('moves a message to delivered when the provider callback arrives', async () => {
    const key = await liveConnector(dryRunSmsConnectorConfig({ key: 'sms-webhook' }));

    const outcome = await hub.messaging.send(ctxA, {
      templateKey: 'appointment_confirmed',
      to: PATIENT_MOBILE_RAW,
      values: { patient: PATIENT_NAME, slot: '21-08-2026 10:30' },
      module: 'OP-001',
      smsConnectorKey: key,
      channelPolicy: 'sms_only',
      refType: 'appointment',
      refId: newId(),
      at: MIDDAY,
    });
    if (outcome.status !== 'sent') throw new Error(JSON.stringify(outcome));
    expect((await messageRow(outcome.messageId))?.ack_code).toBe('AA');

    const applied = await hub.messaging.handleDeliveryWebhook(ctxA, key, {
      receivedAt: new Date(MIDDAY.getTime() + 5_000),
      encoding: 'json',
      body: { providerMessageId: outcome.providerMessageId ?? '', status: 'delivered' },
      headers: {},
    });
    expect(applied.applied).toBe(1);

    const row = await messageRow(outcome.messageId);
    expect(row?.status).toBe('acknowledged');
    expect(row?.ack_code).toBe('delivered');
    expect(await hub.messaging.deliveryStatusOf(outcome.messageId)).toBe('delivered');
  });

  it('ignores an out-of-order callback rather than un-delivering a read message', async () => {
    const key = await liveConnector(dryRunSmsConnectorConfig({ key: 'sms-ooo' }));
    const outcome = await hub.messaging.send(ctxA, {
      templateKey: 'appointment_confirmed',
      to: PATIENT_MOBILE_RAW,
      values: { patient: PATIENT_NAME, slot: '21-08-2026 10:30' },
      module: 'OP-001',
      smsConnectorKey: key,
      channelPolicy: 'sms_only',
      refType: 'appointment',
      refId: newId(),
      at: MIDDAY,
    });
    if (outcome.status !== 'sent') throw new Error(JSON.stringify(outcome));

    const providerMessageId = outcome.providerMessageId ?? '';
    const raw = { receivedAt: MIDDAY, encoding: 'json' as const, headers: {} };

    await hub.messaging.handleDeliveryWebhook(ctxA, key, {
      ...raw,
      body: { providerMessageId, status: 'delivered' },
    });
    const late = await hub.messaging.handleDeliveryWebhook(ctxA, key, {
      ...raw,
      body: { providerMessageId, status: 'sent' },
    });

    expect(late.applied).toBe(0);
    expect(late.ignored).toBe(1);
    expect((await messageRow(outcome.messageId))?.ack_code).toBe('delivered');
  });

  it('does not invent a message for a callback it never sent', async () => {
    const key = await liveConnector(dryRunSmsConnectorConfig({ key: 'sms-unknown-dlr' }));
    const result = await hub.messaging.handleDeliveryWebhook(ctxA, key, {
      receivedAt: MIDDAY,
      encoding: 'json',
      body: { providerMessageId: 'dryrun:not-ours', status: 'delivered' },
      headers: {},
    });
    expect(result.applied).toBe(0);
    expect(result.ignored).toBe(1);
  });
});

describe('WhatsApp to SMS fallback', () => {
  it('sends the SMS variant when WhatsApp rejects the recipient, and links the two messages', async () => {
    const smsKey = await liveConnector(dryRunSmsConnectorConfig({ key: 'sms-for-fallback' }));
    const waKey = await liveConnector(whatsAppConnectorConfig({ key: 'wa-fallback' }));

    // 131026 "Message undeliverable" — the number is not on WhatsApp.
    transport.reset();
    transport.on({
      match: WA_SEND,
      response: jsonResponse(400, { error: { message: 'Message undeliverable', code: 131026 } }),
    });

    const outcome = await hub.messaging.send(ctxA, {
      templateKey: 'appointment_confirmed',
      to: PATIENT_MOBILE_RAW,
      values: { patient: PATIENT_NAME, slot: '23-08-2026 09:00' },
      module: 'OP-001',
      smsConnectorKey: smsKey,
      whatsAppConnectorKey: waKey,
      channelPolicy: 'wa_then_sms',
      refType: 'appointment',
      refId: newId(),
      at: MIDDAY,
    });

    expect(outcome.status).toBe('sent');
    if (outcome.status !== 'sent') throw new Error(JSON.stringify(outcome));
    // It arrived, on the other channel.
    expect(outcome.channel).toBe('sms');
    expect(outcome.fallbackOfMessageId).toBeDefined();

    // EN-009 §14.3: "both messages link via `fallback_of_id`".
    const smsRow = await messageRow(outcome.messageId);
    expect(smsRow?.parent_message_id).toBe(outcome.fallbackOfMessageId);

    const waRow = await messageRow(outcome.fallbackOfMessageId ?? '');
    expect(waRow?.status).toBe('dead_lettered');
    expect(waRow?.error_class).toBe('semantic_4xx');

    // The fallback's cost is tracked separately (EN-009 §3.3.2).
    const fallbackCosts = await hub.costs.totals(tenants.hospitalA, { groupBy: 'channel', isFallback: true });
    expect((fallbackCosts.get('sms')?.messages ?? 0) >= 1).toBe(true);
  });

  it('sends WhatsApp when it works, prices the conversation, and charges nothing for the second message', async () => {
    const smsKey = await liveConnector(dryRunSmsConnectorConfig({ key: 'sms-for-wa-ok' }));
    const waKey = await liveConnector(whatsAppConnectorConfig({ key: 'wa-ok' }));
    const number = '+919833333333';

    transport.reset();
    transport.on({
      match: WA_SEND,
      response: jsonResponse(200, { messages: [{ id: 'wamid.first' }] }),
      times: 1,
    });
    transport.on({ match: WA_SEND, response: jsonResponse(200, { messages: [{ id: 'wamid.second' }] }) });

    const first = await hub.messaging.send(ctxA, {
      templateKey: 'appointment_confirmed',
      to: number,
      values: { patient: PATIENT_NAME, slot: '24-08-2026 09:00' },
      module: 'OP-001',
      smsConnectorKey: smsKey,
      whatsAppConnectorKey: waKey,
      refType: 'appointment',
      refId: newId(),
      at: MIDDAY,
    });
    expect(first.status).toBe('sent');
    if (first.status !== 'sent') throw new Error(JSON.stringify(first));
    expect(first.channel).toBe('whatsapp');
    expect(first.providerMessageId).toBe('wamid.first');
    expect(first.cost.amount).toBe(115);

    const second = await hub.messaging.send(ctxA, {
      templateKey: 'appointment_confirmed',
      to: number,
      values: { patient: PATIENT_NAME, slot: '25-08-2026 09:00' },
      module: 'OP-001',
      smsConnectorKey: smsKey,
      whatsAppConnectorKey: waKey,
      refType: 'appointment',
      refId: newId(),
      at: new Date(MIDDAY.getTime() + 60_000),
    });
    if (second.status !== 'sent') throw new Error(JSON.stringify(second));
    // Inside the 24-hour conversation window: Meta bills nothing more.
    expect(second.cost.amount).toBe(0);
    expect(second.cost.freeInsideConversation).toBe(true);
  });

  it('falls back to SMS when a signed WhatsApp webhook reports the message undelivered', async () => {
    const smsKey = await liveConnector(dryRunSmsConnectorConfig({ key: 'sms-webhook-fallback' }));
    const waKey = await liveConnector(whatsAppConnectorConfig({ key: 'wa-webhook-fallback' }));
    const number = '+919844444444';

    transport.reset();
    transport.on({ match: WA_SEND, response: jsonResponse(200, { messages: [{ id: 'wamid.async' }] }) });

    const sent = await hub.messaging.send(ctxA, {
      templateKey: 'appointment_confirmed',
      to: number,
      values: { patient: PATIENT_NAME, slot: '26-08-2026 09:00' },
      module: 'OP-001',
      smsConnectorKey: smsKey,
      whatsAppConnectorKey: waKey,
      refType: 'appointment',
      refId: newId(),
      at: MIDDAY,
    });
    if (sent.status !== 'sent') throw new Error(JSON.stringify(sent));
    expect(sent.channel).toBe('whatsapp');

    const body = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                statuses: [
                  {
                    id: 'wamid.async',
                    status: 'failed',
                    timestamp: String(Math.floor(MIDDAY.getTime() / 1000) + 60),
                    errors: [{ code: 131026, title: 'Message undeliverable' }],
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    const result = await hub.messaging.handleDeliveryWebhook(ctxA, waKey, {
      receivedAt: new Date(MIDDAY.getTime() + 60_000),
      encoding: 'json',
      body,
      headers: { 'x-hub-signature-256': signMeta(body) },
    });

    expect(result.applied).toBe(1);
    expect(result.fallbacksTriggered).toBe(1);

    const waRow = await messageRow(sent.messageId);
    expect(waRow?.status).toBe('failed');
    expect(waRow?.error_class).toBe('partner_5xx');
  });

  it('rejects an unsigned WhatsApp webhook rather than trusting it', async () => {
    const waKey = await liveConnector(whatsAppConnectorConfig({ key: 'wa-unsigned' }));
    await expect(
      hub.messaging.handleDeliveryWebhook(ctxA, waKey, {
        receivedAt: MIDDAY,
        encoding: 'json',
        body: '{"entry":[]}',
        headers: {},
      }),
    ).rejects.toThrow(/signature rejected/);
  });

  it('records a STOP reply as a marketing opt-out that subsequent campaigns honour', async () => {
    const waKey = await liveConnector(whatsAppConnectorConfig({ key: 'wa-stop' }));
    const smsKey = await liveConnector(dryRunSmsConnectorConfig({ key: 'sms-after-stop' }));
    const number = '+919855555555';

    await hub.consent.recordConsent({
      hospitalId: tenants.hospitalA,
      phoneE164: number,
      channel: 'sms',
      consentClass: 'promotional',
      status: 'opted_in',
      source: 'campaign_form',
      at: MIDDAY,
    });

    const body = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    id: 'wamid.stop',
                    from: number.replace('+', ''),
                    timestamp: String(Math.floor(MIDDAY.getTime() / 1000)),
                    type: 'text',
                    text: { body: 'STOP' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    const result = await hub.messaging.handleDeliveryWebhook(ctxA, waKey, {
      receivedAt: MIDDAY,
      encoding: 'json',
      body,
      headers: { 'x-hub-signature-256': signMeta(body) },
    });
    expect(result.optOuts).toBe(1);

    const outcome = await hub.messaging.send(ctxA, {
      templateKey: 'camp_invite',
      to: number,
      values: { patient: PATIENT_NAME, slot: '30-08-2026' },
      module: 'NC-026',
      smsConnectorKey: smsKey,
      channelPolicy: 'sms_only',
      at: MIDDAY,
    });
    expect(outcome.status).toBe('refused');
    if (outcome.status !== 'refused') throw new Error(JSON.stringify(outcome));
    expect(outcome.reason).toBe('opted_out');
  });
});

describe('gateway connectors against the real registry', () => {
  it('registers MSG91 and Twilio, and refuses to send from a connector that is still a draft', async () => {
    const msg91 = await hub.connectors.register(ctxA, {
      config: msg91ConnectorConfig({ key: 'msg91-draft' }),
      ownerUserId: newId(),
    });
    expect(msg91.status).toBe('draft');
    expect(msg91.adapter).toBe('vims.msg91@0.1.0');

    const twilio = await hub.connectors.register(ctxA, {
      config: twilioConnectorConfig({ key: 'twilio-draft' }),
      ownerUserId: newId(),
    });
    expect(twilio.status).toBe('draft');

    // A draft connector parks its traffic rather than losing it.
    const outcome = await hub.messaging.send(ctxA, {
      templateKey: 'appointment_confirmed',
      to: PATIENT_MOBILE_RAW,
      values: { patient: PATIENT_NAME, slot: '21-08-2026 10:30' },
      module: 'OP-001',
      smsConnectorKey: 'msg91-draft',
      channelPolicy: 'sms_only',
      refType: 'appointment',
      refId: newId(),
      at: MIDDAY,
    });
    expect(outcome.status).toBe('failed');
  });

  it('sends through MSG91 with the DLT template id, against a fake transport', async () => {
    const key = await liveConnector(msg91ConnectorConfig({ key: 'msg91-live' }));
    transport.reset();
    transport.on({
      match: '/api/v2/sendsms',
      response: jsonResponse(200, { type: 'success', message: 'req-int-1' }),
    });

    const outcome = await hub.messaging.send(ctxA, {
      templateKey: 'appointment_confirmed',
      to: PATIENT_MOBILE_RAW,
      values: { patient: PATIENT_NAME, slot: '27-08-2026 10:30' },
      module: 'OP-001',
      smsConnectorKey: key,
      channelPolicy: 'sms_only',
      refType: 'appointment',
      refId: newId(),
      at: MIDDAY,
    });

    expect(outcome.status).toBe('sent');
    if (outcome.status !== 'sent') throw new Error(JSON.stringify(outcome));
    expect(outcome.providerMessageId).toBe('req-int-1');

    const request = transport.requests.find((r) => r.url.includes('/api/v2/sendsms'));
    const body = JSON.parse(request?.body ?? '{}') as Record<string, unknown>;
    expect(body['DLT_TE_ID']).toBe('1707169999999900001');
  });
});

describe('tenant isolation', () => {
  it('hides one hospital messaging rows from another', async () => {
    const key = await liveConnector(dryRunSmsConnectorConfig({ key: 'sms-isolation' }));
    const sent = await hub.messaging.send(ctxA, {
      templateKey: 'appointment_confirmed',
      to: PATIENT_MOBILE_RAW,
      values: { patient: PATIENT_NAME, slot: '28-08-2026 10:30' },
      module: 'OP-001',
      smsConnectorKey: key,
      channelPolicy: 'sms_only',
      refType: 'appointment',
      refId: newId(),
      at: MIDDAY,
    });
    if (sent.status !== 'sent') throw new Error(JSON.stringify(sent));

    const ctxB: TenantContext = {
      hospitalId: tenants.hospitalB,
      userId: newId(),
      scope: 'branch',
      branchIds: [tenants.branchB],
    };
    // No `WHERE hospital_id`: if RLS were not doing the work, this would find it.
    const fromB = await hub.db.withTenant(ctxB, (tx) => hub.messages.get(tx, sent.messageId));
    expect(fromB).toBeUndefined();

    const fromA = await hub.db.withTenant(ctxA, (tx) => hub.messages.get(tx, sent.messageId));
    expect(fromA?.id).toBe(sent.messageId);
  });
});
