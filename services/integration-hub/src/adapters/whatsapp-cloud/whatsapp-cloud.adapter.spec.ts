import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validateConnectorConfig } from '../../config/validate.js';
import { FakeHttpTransport, jsonResponse } from '../../messaging/http/transport.js';
import { WebhookSignatureError, type DeliveryEnvelopePayload } from '../../messaging/types.js';
import { adapterContext, outboundMessage, WHATSAPP_PAYLOAD } from '../../testing/adapter-harness.js';
import { META_TEST_APP_SECRET, whatsAppConnectorConfig } from '../../testing/messaging-fixtures.js';
import { WhatsAppCloudAdapter, createWhatsAppCloudFactory } from './whatsapp-cloud.adapter.js';

async function adapterWith(transport: FakeHttpTransport): Promise<WhatsAppCloudAdapter> {
  const factory = createWhatsAppCloudFactory(transport);
  const adapter = new WhatsAppCloudAdapter(transport);
  await adapter.configure(adapterContext(whatsAppConnectorConfig(), factory));
  return adapter;
}

const ACCEPTED = jsonResponse(200, {
  messaging_product: 'whatsapp',
  contacts: [{ input: '919876543210', wa_id: '919876543210' }],
  messages: [{ id: 'wamid.HBgMOTE5ODc2NTQzMjEwFQIAERgS' }],
});

function signMeta(rawBody: string): string {
  return `sha256=${createHmac('sha256', META_TEST_APP_SECRET).update(rawBody, 'utf8').digest('hex')}`;
}

function statusWebhook(id: string, status: string, errorCode?: number): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '1122334455',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              statuses: [
                {
                  id,
                  status,
                  timestamp: '1787000000',
                  recipient_id: '919876543210',
                  ...(errorCode === undefined ? {} : { errors: [{ code: errorCode, title: 'Message undeliverable' }] }),
                  pricing: { category: 'utility' },
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

describe('WhatsApp Cloud configuration', () => {
  it('refuses a connector that does not declare the cross-border transfer to Meta', () => {
    // EN-017 §5 / DPDP §16: the transfer basis is recorded, not discovered.
    const factory = createWhatsAppCloudFactory(new FakeHttpTransport());
    const config = whatsAppConnectorConfig();
    const result = validateConnectorConfig(
      { ...config, dpdp: { ...config.dpdp, crossBorder: false, dpaRef: undefined } },
      factory,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('a cross-border connector was accepted without a declaration');
    expect(result.issues.some((i) => i.message.includes('outside India'))).toBe(true);
  });

  it('refuses a literal app secret in place of a vault reference', () => {
    const factory = createWhatsAppCloudFactory(new FakeHttpTransport());
    const config = whatsAppConnectorConfig();
    const result = validateConnectorConfig(
      { ...config, options: { ...config.options, appSecretRef: 'EAAG9ZClive-app-secret' } },
      factory,
    );
    expect(result.ok).toBe(false);
  });
});

describe('WhatsApp Cloud send', () => {
  it('posts a template message with positional parameters and returns the wamid', async () => {
    const transport = new FakeHttpTransport([{ match: '/messages', response: ACCEPTED }]);
    const adapter = await adapterWith(transport);

    const result = await adapter.send('sendTemplate', outboundMessage('sendTemplate', WHATSAPP_PAYLOAD));
    expect(result.status).toBe('sent');
    if (result.status === 'failed') throw new Error(result.message);
    expect(result.partnerRef).toBe('wamid.HBgMOTE5ODc2NTQzMjEwFQIAERgS');

    const request = transport.requests[0];
    expect(request?.url).toBe('https://graph.facebook.test/v20.0/9988776655/messages');
    expect(request?.headers['authorization']).toBe('Bearer test-meta-access-token');

    const body = JSON.parse(request?.body ?? '{}') as {
      type?: string;
      template?: { name?: string; language?: { code?: string }; components?: unknown[] };
    };
    // Business-initiated messages must be templates: Meta accepts nothing else
    // outside the 24-hour window, and every message this hub sends is
    // business-initiated by definition.
    expect(body.type).toBe('template');
    expect(body.template?.name).toBe('appointment_confirmed');
    expect(body.template?.language?.code).toBe('en');
    expect(JSON.stringify(body.template?.components)).toContain('R Iyer');
  });

  it('omits the components block when the template takes no parameters', async () => {
    const transport = new FakeHttpTransport([{ match: '/messages', response: ACCEPTED }]);
    const adapter = await adapterWith(transport);
    await adapter.send(
      'sendTemplate',
      outboundMessage('sendTemplate', { ...WHATSAPP_PAYLOAD, templateParameters: [], templateVars: {} }),
    );
    const body = JSON.parse(transport.requests[0]?.body ?? '{}') as { template?: Record<string, unknown> };
    expect(body.template && 'components' in body.template).toBe(false);
  });

  it('classifies 131026 "undeliverable" as a non-retryable failure — the SMS fallback trigger', async () => {
    // Treated as a generic 4xx this dead-letters and the patient is never told.
    const transport = new FakeHttpTransport([
      {
        match: '/messages',
        response: jsonResponse(400, {
          error: { message: 'Message undeliverable', code: 131026, error_subcode: 0, type: 'OAuthException' },
        }),
      },
    ]);
    const adapter = await adapterWith(transport);

    const result = await adapter.send('sendTemplate', outboundMessage('sendTemplate', WHATSAPP_PAYLOAD));
    if (result.status !== 'failed') throw new Error('unreachable');
    expect(result.errorClass).toBe('semantic_4xx');
    expect(result.code).toBe('META_131026');
    // Not retryable: retrying will not put the number on WhatsApp. Falling back
    // to SMS will.
    expect(result.retryable).toBe(false);
  });

  it('classifies an expired access token as retryable auth, not as a payload defect', async () => {
    const transport = new FakeHttpTransport([
      { match: '/messages', response: jsonResponse(401, { error: { message: 'Session expired', code: 190 } }) },
    ]);
    const adapter = await adapterWith(transport);
    const result = await adapter.send('sendTemplate', outboundMessage('sendTemplate', WHATSAPP_PAYLOAD));
    if (result.status !== 'failed') throw new Error('unreachable');
    expect(result.errorClass).toBe('auth');
    expect(result.retryable).toBe(true);
  });

  it('classifies a paused template so its traffic can move to SMS', async () => {
    const transport = new FakeHttpTransport([
      { match: '/messages', response: jsonResponse(400, { error: { message: 'Template paused', code: 132015 } }) },
    ]);
    const adapter = await adapterWith(transport);
    const result = await adapter.send('sendTemplate', outboundMessage('sendTemplate', WHATSAPP_PAYLOAD));
    if (result.status !== 'failed') throw new Error('unreachable');
    expect(result.errorClass).toBe('semantic_4xx');
    expect(result.retryable).toBe(false);
  });

  it('classifies a Meta rate limit as retryable', async () => {
    const transport = new FakeHttpTransport([
      { match: '/messages', response: jsonResponse(429, { error: { message: 'Rate limit hit', code: 130429 } }) },
    ]);
    const adapter = await adapterWith(transport);
    const result = await adapter.send('sendTemplate', outboundMessage('sendTemplate', WHATSAPP_PAYLOAD));
    if (result.status !== 'failed') throw new Error('unreachable');
    expect(result.errorClass).toBe('rate_limited');
    expect(result.retryable).toBe(true);
  });

  it('rejects an SMS payload sent to the WhatsApp connector before touching the network', async () => {
    const transport = new FakeHttpTransport();
    const adapter = await adapterWith(transport);
    const result = await adapter.send('sendTemplate', outboundMessage('sendTemplate', { channel: 'sms' }));
    if (result.status !== 'failed') throw new Error('unreachable');
    expect(result.errorClass).toBe('validation');
    expect(transport.requests).toHaveLength(0);
  });
});

describe('WhatsApp Cloud webhooks', () => {
  it('verifies X-Hub-Signature-256 over the raw body', async () => {
    const adapter = await adapterWith(new FakeHttpTransport());
    const body = statusWebhook('wamid.HBgMOTE5ODc2NTQzMjEwFQIAERgS', 'delivered');

    const envelope = await adapter.receive({
      receivedAt: new Date('2026-08-21T09:00:00.000Z'),
      encoding: 'json',
      body,
      headers: { 'x-hub-signature-256': signMeta(body) },
    });

    const payload = envelope.payload as DeliveryEnvelopePayload;
    expect(payload.receipts[0]?.status).toBe('delivered');
    expect(payload.receipts[0]?.conversationCategory).toBe('UTILITY');
    // Meta's timestamps are epoch seconds, not milliseconds.
    expect(payload.receipts[0]?.at.toISOString()).toBe('2026-08-17T20:53:20.000Z');
  });

  it('rejects an unsigned webhook', async () => {
    const adapter = await adapterWith(new FakeHttpTransport());
    const body = statusWebhook('wamid.x', 'delivered');
    await expect(
      adapter.receive({ receivedAt: new Date(), encoding: 'json', body, headers: {} }),
    ).rejects.toBeInstanceOf(WebhookSignatureError);
  });

  it('rejects a body that was altered after signing', async () => {
    const adapter = await adapterWith(new FakeHttpTransport());
    const signature = signMeta(statusWebhook('wamid.x', 'delivered'));
    await expect(
      adapter.receive({
        receivedAt: new Date(),
        encoding: 'json',
        body: statusWebhook('wamid.x', 'read'),
        headers: { 'x-hub-signature-256': signature },
      }),
    ).rejects.toBeInstanceOf(WebhookSignatureError);
  });

  it('carries the Meta error code through on a failed status', async () => {
    const adapter = await adapterWith(new FakeHttpTransport());
    const body = statusWebhook('wamid.x', 'failed', 131026);
    const envelope = await adapter.receive({
      receivedAt: new Date(),
      encoding: 'json',
      body,
      headers: { 'x-hub-signature-256': signMeta(body) },
    });
    const payload = envelope.payload as DeliveryEnvelopePayload;
    expect(payload.receipts[0]?.status).toBe('failed');
    expect(payload.receipts[0]?.errorCode).toBe('META_131026');
  });

  it('normalises an inbound STOP reply into the canonical inbound shape', async () => {
    const adapter = await adapterWith(new FakeHttpTransport());
    const body = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    id: 'wamid.in1',
                    from: '919876543210',
                    timestamp: '1787000000',
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

    const envelope = await adapter.receive({
      receivedAt: new Date(),
      encoding: 'json',
      body,
      headers: { 'x-hub-signature-256': signMeta(body) },
    });
    const payload = envelope.payload as DeliveryEnvelopePayload;
    expect(payload.inbound[0]?.text).toBe('STOP');
    // The `+` is restored, because the opt-out ledger is keyed on E.164.
    expect(payload.inbound[0]?.from).toBe('+919876543210');
  });
});

describe('WhatsApp Cloud health check', () => {
  it('warns below a GREEN quality rating, which is what silently throttles a hospital', async () => {
    const transport = new FakeHttpTransport([
      { match: 'quality_rating', response: jsonResponse(200, { quality_rating: 'YELLOW', verified_name: 'Vims' }) },
    ]);
    const adapter = await adapterWith(transport);
    const report = await adapter.healthCheck('ping');
    expect(report.status).toBe('warn');
    expect(report.detail).toContain('YELLOW');
  });

  it('passes on GREEN', async () => {
    const transport = new FakeHttpTransport([
      { match: 'quality_rating', response: jsonResponse(200, { quality_rating: 'GREEN' }) },
    ]);
    const adapter = await adapterWith(transport);
    expect((await adapter.healthCheck('ping')).status).toBe('pass');
  });
});
