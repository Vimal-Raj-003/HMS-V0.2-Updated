import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validateConnectorConfig } from '../../config/validate.js';
import { FakeHttpTransport, jsonResponse } from '../../messaging/http/transport.js';
import { WebhookSignatureError, type DeliveryEnvelopePayload } from '../../messaging/types.js';
import { adapterContext, outboundMessage, SMS_PAYLOAD } from '../../testing/adapter-harness.js';
import {
  TWILIO_STATUS_CALLBACK_URL,
  TWILIO_TEST_AUTH_TOKEN,
  twilioConnectorConfig,
} from '../../testing/messaging-fixtures.js';
import { TwilioAdapter, createTwilioFactory, parseFormBody } from './twilio.adapter.js';

async function adapterWith(transport: FakeHttpTransport): Promise<TwilioAdapter> {
  const factory = createTwilioFactory(transport);
  const adapter = new TwilioAdapter(transport);
  await adapter.configure(adapterContext(twilioConnectorConfig(), factory));
  return adapter;
}

const CREATED = jsonResponse(201, { sid: 'SM0123456789abcdef0123456789abcdef', status: 'queued' });

/** Twilio signs URL + sorted params. Building it here proves the adapter agrees. */
function signTwilio(url: string, params: Readonly<Record<string, string>>): string {
  const payload = Object.keys(params)
    .sort()
    .reduce((acc, key) => `${acc}${key}${params[key] ?? ''}`, url);
  return createHmac('sha1', TWILIO_TEST_AUTH_TOKEN).update(payload, 'utf8').digest('base64');
}

describe('Twilio configuration', () => {
  it('needs either a messaging service or a from-number', () => {
    const factory = createTwilioFactory(new FakeHttpTransport());
    const config = twilioConnectorConfig();
    const result = validateConnectorConfig(
      { ...config, options: { accountSid: 'AC0123456789abcdef0123456789abcdef', statusCallbackUrl: TWILIO_STATUS_CALLBACK_URL } },
      factory,
    );
    expect(result.ok).toBe(false);
  });

  it('refuses a secret whose Account SID belongs to another account', async () => {
    const factory = createTwilioFactory(new FakeHttpTransport());
    const adapter = new TwilioAdapter(new FakeHttpTransport());
    const ctx = adapterContext(
      { ...twilioConnectorConfig(), options: { ...twilioConnectorConfig().options, accountSid: 'AC00000000000000000000000000000000' } },
      factory,
    );
    await expect(adapter.configure(ctx)).rejects.toThrow(/another account/);
  });

  it('declares no partner idempotency, so the connector must be R0', () => {
    const factory = createTwilioFactory(new FakeHttpTransport());
    expect(factory.manifest.capabilities.supportsIdempotencyKey).toBe(false);
  });
});

describe('Twilio send', () => {
  it('posts a form with the DLT parameters and returns the message SID', async () => {
    const transport = new FakeHttpTransport([{ match: '/Messages.json', response: CREATED }]);
    const adapter = await adapterWith(transport);

    const result = await adapter.send('sendSms', outboundMessage('sendSms', SMS_PAYLOAD));
    expect(result.status).toBe('sent');
    if (result.status === 'failed') throw new Error(result.message);
    expect(result.partnerRef).toBe('SM0123456789abcdef0123456789abcdef');

    const request = transport.requests[0];
    expect(request?.url).toContain('/2010-04-01/Accounts/AC0123456789abcdef0123456789abcdef/Messages.json');
    expect(request?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(request?.headers['authorization']).toMatch(/^Basic /);

    const form = parseFormBody(request?.body ?? '');
    expect(form['To']).toBe('+919876543210');
    expect(form['From']).toBe('+15005550006');
    expect(form['dlt_template_id']).toBe('1707169999999900001');
    expect(form['dlt_entity_id']).toBe('110100001234567890');
    // The callback URL travels with the message, and it is the same string the
    // signature is later verified against.
    expect(form['StatusCallback']).toBe(TWILIO_STATUS_CALLBACK_URL);
  });

  it('classifies a Twilio 4xx by its own error code', async () => {
    const transport = new FakeHttpTransport([
      { match: '/Messages.json', response: jsonResponse(400, { code: 21610, message: 'Unsubscribed recipient' }) },
    ]);
    const adapter = await adapterWith(transport);
    const result = await adapter.send('sendSms', outboundMessage('sendSms', SMS_PAYLOAD));
    if (result.status !== 'failed') throw new Error('unreachable');
    expect(result.errorClass).toBe('validation');
    expect(result.code).toBe('TWILIO_21610');
    expect(result.retryable).toBe(false);
  });

  it('fails loudly when a 2xx carries no SID', async () => {
    const transport = new FakeHttpTransport([{ match: '/Messages.json', response: jsonResponse(201, { status: 'queued' }) }]);
    const adapter = await adapterWith(transport);
    const result = await adapter.send('sendSms', outboundMessage('sendSms', SMS_PAYLOAD));
    if (result.status !== 'failed') throw new Error('unreachable');
    expect(result.errorClass).toBe('schema_drift');
  });

  it('sends nothing in sandbox mode', async () => {
    const transport = new FakeHttpTransport();
    const factory = createTwilioFactory(transport);
    const adapter = new TwilioAdapter(transport);
    await adapter.configure(adapterContext(twilioConnectorConfig(), factory, { sandbox: true }));
    const result = await adapter.send('sendSms', outboundMessage('sendSms', SMS_PAYLOAD, { sandbox: true }));
    expect(result.status).toBe('acknowledged');
    expect(transport.requests).toHaveLength(0);
  });
});

describe('Twilio status callbacks', () => {
  const params = {
    MessageSid: 'SM0123456789abcdef0123456789abcdef',
    MessageStatus: 'delivered',
    AccountSid: 'AC0123456789abcdef0123456789abcdef',
  };
  const rawBody = new URLSearchParams(params).toString();

  it('accepts a correctly signed callback and normalises the status', async () => {
    const adapter = await adapterWith(new FakeHttpTransport());
    const envelope = await adapter.receive({
      receivedAt: new Date('2026-08-21T09:00:00.000Z'),
      encoding: 'form',
      body: rawBody,
      headers: { 'x-twilio-signature': signTwilio(TWILIO_STATUS_CALLBACK_URL, params) },
    });

    const payload = envelope.payload as DeliveryEnvelopePayload;
    expect(payload.receipts[0]?.status).toBe('delivered');
    expect(payload.receipts[0]?.providerMessageId).toBe('SM0123456789abcdef0123456789abcdef');
  });

  it('rejects an unsigned callback — the endpoint mutates message state', async () => {
    const adapter = await adapterWith(new FakeHttpTransport());
    await expect(
      adapter.receive({ receivedAt: new Date(), encoding: 'form', body: rawBody, headers: {} }),
    ).rejects.toBeInstanceOf(WebhookSignatureError);
  });

  it('rejects a callback whose body was tampered with after signing', async () => {
    // Marking a critical alert delivered stops the escalation ladder, which is
    // worse than the message never arriving.
    const adapter = await adapterWith(new FakeHttpTransport());
    const signature = signTwilio(TWILIO_STATUS_CALLBACK_URL, params);
    const tampered = new URLSearchParams({ ...params, MessageStatus: 'failed' }).toString();

    await expect(
      adapter.receive({
        receivedAt: new Date(),
        encoding: 'form',
        body: tampered,
        headers: { 'x-twilio-signature': signature },
      }),
    ).rejects.toBeInstanceOf(WebhookSignatureError);
  });

  it('rejects a signature computed over a different URL', async () => {
    const adapter = await adapterWith(new FakeHttpTransport());
    await expect(
      adapter.receive({
        receivedAt: new Date(),
        encoding: 'form',
        body: rawBody,
        headers: { 'x-twilio-signature': signTwilio('https://attacker.example/webhook', params) },
      }),
    ).rejects.toBeInstanceOf(WebhookSignatureError);
  });

  it('maps the Twilio vocabulary onto the common model', async () => {
    const adapter = await adapterWith(new FakeHttpTransport());
    const cases: readonly [string, string][] = [
      ['queued', 'queued'],
      ['sending', 'sent'],
      ['sent', 'sent'],
      ['delivered', 'delivered'],
      ['read', 'read'],
      ['undelivered', 'undelivered'],
      ['failed', 'failed'],
      ['canceled', 'expired'],
    ];
    for (const [twilio, expected] of cases) {
      const p = { ...params, MessageStatus: twilio };
      const envelope = await adapter.receive({
        receivedAt: new Date(),
        encoding: 'form',
        body: new URLSearchParams(p).toString(),
        headers: { 'x-twilio-signature': signTwilio(TWILIO_STATUS_CALLBACK_URL, p) },
      });
      const payload = envelope.payload as DeliveryEnvelopePayload;
      expect(payload.receipts[0]?.status).toBe(expected);
    }
  });
});
