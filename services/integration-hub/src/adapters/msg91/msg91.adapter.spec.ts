import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validateConnectorConfig } from '../../config/validate.js';
import { FakeHttpTransport, HttpTransportError, jsonResponse } from '../../messaging/http/transport.js';
import { WebhookSignatureError, type DeliveryEnvelopePayload } from '../../messaging/types.js';
import { adapterContext, outboundMessage, SMS_PAYLOAD } from '../../testing/adapter-harness.js';
import { MSG91_TEST_WEBHOOK_TOKEN, msg91ConnectorConfig } from '../../testing/messaging-fixtures.js';
import { Msg91Adapter, createMsg91Factory } from './msg91.adapter.js';

async function adapterWith(transport: FakeHttpTransport): Promise<Msg91Adapter> {
  const factory = createMsg91Factory(transport);
  const adapter = new Msg91Adapter(transport);
  await adapter.configure(adapterContext(msg91ConnectorConfig(), factory));
  return adapter;
}

const OK = jsonResponse(200, { type: 'success', message: '3a7f9c1e2b4d5f60' });

describe('MSG91 manifest', () => {
  it('declares no partner idempotency, which forces the connector to retry policy R0', () => {
    // EN-017 §5: "retrying against a partner with no idempotency support is how
    // a patient receives three SMS". The manifest is what makes
    // `validateConnectorConfig` refuse anything else, so the declaration is the
    // enforcement, not a note.
    const factory = createMsg91Factory(new FakeHttpTransport());
    expect(factory.manifest.capabilities.supportsIdempotencyKey).toBe(false);
    expect(factory.manifest.capabilities.requiresInternet).toBe(true);
    expect(factory.manifest.capabilities.operations.map((op) => op.key)).toEqual([
      'sendSms',
      'deliveryReceipt',
    ]);
  });

  it('refuses a configuration with no webhook shared token', () => {
    // MSG91 publishes no HMAC scheme, so the shared token is the whole of the
    // callback authentication. A connector without one is refused at
    // registration rather than left as a public endpoint that can mark a
    // critical alert delivered.
    const factory = createMsg91Factory(new FakeHttpTransport());
    const result = validateConnectorConfig({ ...msg91ConnectorConfig(), options: {} }, factory);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('a connector with no webhook token was accepted');
    expect(result.issues.some((i) => i.message.includes('webhookTokenRef'))).toBe(true);
  });

  it('refuses an auth block that is not an api_key', () => {
    const factory = createMsg91Factory(new FakeHttpTransport());
    const result = validateConnectorConfig(
      {
        ...msg91ConnectorConfig(),
        auth: { type: 'basic', secretRef: 'vault://hms/connectors/msg91/authkey' },
      },
      factory,
    );
    expect(result.ok).toBe(false);
  });

  it('refuses any retry policy other than R0, because MSG91 honours no idempotency key', () => {
    const factory = createMsg91Factory(new FakeHttpTransport());
    const result = validateConnectorConfig(
      {
        ...msg91ConnectorConfig(),
        retry: {
          policy: 'R1',
          maxAttempts: 3,
          baseDelayMs: 1_000,
          backoffFactor: 2,
          maxDelayMs: 60_000,
          jitterMs: 0,
        },
      },
      factory,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('a retrying SMS connector was accepted');
    expect(result.issues.some((i) => i.message.includes('no partner idempotency support'))).toBe(true);
  });

  it('refuses a literal secret in place of a vault reference', () => {
    const factory = createMsg91Factory(new FakeHttpTransport());
    expect(() =>
      adapterContext(
        {
          ...msg91ConnectorConfig(),
          auth: { type: 'api_key', header: 'authkey', secretRef: '435678AbCdEf12345678' },
        },
        factory,
      ),
    ).toThrow(/secret \*reference\*/);
  });
});

describe('MSG91 send', () => {
  it('posts the rendered body with the DLT template id and returns the request id', async () => {
    const transport = new FakeHttpTransport([{ match: '/api/v2/sendsms', response: OK }]);
    const adapter = await adapterWith(transport);

    const result = await adapter.send('sendSms', outboundMessage('sendSms', SMS_PAYLOAD));
    expect(result.status).toBe('sent');
    if (result.status === 'failed') throw new Error(result.message);
    expect(result.partnerRef).toBe('3a7f9c1e2b4d5f60');

    const request = transport.requests[0];
    expect(request?.url).toBe('https://control.msg91.test/api/v2/sendsms');
    expect(request?.headers['authkey']).toBe('test-msg91-authkey');

    const body = JSON.parse(request?.body ?? '{}') as Record<string, unknown>;
    // The DLT template id travels explicitly. We render the body the registry
    // proved equal to the registered content; MSG91 must not re-render it from
    // its own copy, which would be a second, unverified source of truth.
    expect(body['DLT_TE_ID']).toBe('1707169999999900001');
    expect(body['sender']).toBe('VIMHMS');
    expect(body['route']).toBe('4');
    expect(JSON.stringify(body)).toContain('919876543210');
  });

  it('routes a promotional message down the promotional route', async () => {
    const transport = new FakeHttpTransport([{ match: '/api/v2/sendsms', response: OK }]);
    const adapter = await adapterWith(transport);
    await adapter.send(
      'sendSms',
      outboundMessage('sendSms', { ...SMS_PAYLOAD, dltCategory: 'promotional', messageClass: 'promotional' }),
    );
    const body = JSON.parse(transport.requests[0]?.body ?? '{}') as Record<string, unknown>;
    expect(body['route']).toBe('1');
  });

  it('treats MSG91 200-with-error as a failure, which is the whole reason this adapter exists', async () => {
    // A wrong authkey, an unregistered DLT template and a bad header all arrive
    // as HTTP 200. An adapter that trusts the status code reports every one of
    // them as `sent` and the hospital finds out from a patient.
    const transport = new FakeHttpTransport([
      {
        match: '/api/v2/sendsms',
        response: jsonResponse(200, { type: 'error', message: 'Invalid DLT template id' }),
      },
    ]);
    const adapter = await adapterWith(transport);

    const result = await adapter.send('sendSms', outboundMessage('sendSms', SMS_PAYLOAD));
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('unreachable');
    expect(result.errorClass).toBe('validation');
    expect(result.retryable).toBe(false);
  });

  it('classifies a bad authkey reported at 200 as an auth failure', async () => {
    const transport = new FakeHttpTransport([
      {
        match: '/api/v2/sendsms',
        response: jsonResponse(200, { type: 'error', message: 'authkey is invalid' }),
      },
    ]);
    const adapter = await adapterWith(transport);
    const result = await adapter.send('sendSms', outboundMessage('sendSms', SMS_PAYLOAD));
    if (result.status !== 'failed') throw new Error('unreachable');
    expect(result.errorClass).toBe('auth');
  });

  it('fails loudly when a 2xx carries no request id, because the DLR could never be matched', async () => {
    const transport = new FakeHttpTransport([
      { match: '/api/v2/sendsms', response: jsonResponse(200, { type: 'success' }) },
    ]);
    const adapter = await adapterWith(transport);
    const result = await adapter.send('sendSms', outboundMessage('sendSms', SMS_PAYLOAD));
    if (result.status !== 'failed') throw new Error('unreachable');
    expect(result.errorClass).toBe('schema_drift');
  });

  it('maps HTTP statuses onto the hub error classes once, in the shared helper', async () => {
    const cases: readonly [number, string, boolean][] = [
      [401, 'auth', true],
      [429, 'rate_limited', true],
      [400, 'validation', false],
      [503, 'partner_5xx', true],
    ];
    for (const [status, errorClass, retryable] of cases) {
      const transport = new FakeHttpTransport([
        { match: '/api/v2/sendsms', response: jsonResponse(status, {}) },
      ]);
      const adapter = await adapterWith(transport);
      const result = await adapter.send('sendSms', outboundMessage('sendSms', SMS_PAYLOAD));
      if (result.status !== 'failed') throw new Error(`expected ${String(status)} to fail`);
      expect(result.errorClass).toBe(errorClass);
      expect(result.retryable).toBe(retryable);
    }
  });

  it('honours Retry-After rather than inventing a backoff', async () => {
    const transport = new FakeHttpTransport([
      { match: '/api/v2/sendsms', response: { status: 429, headers: { 'retry-after': '30' }, body: '{}' } },
    ]);
    const adapter = await adapterWith(transport);
    const result = await adapter.send('sendSms', outboundMessage('sendSms', SMS_PAYLOAD));
    if (result.status !== 'failed') throw new Error('unreachable');
    expect(result.retryAfterMs).toBe(30_000);
  });

  it('reports a transport timeout as retryable without throwing', async () => {
    const transport = new FakeHttpTransport([
      { match: '/api/v2/sendsms', failWith: new HttpTransportError('timeout', 'timed out') },
    ]);
    const adapter = await adapterWith(transport);
    const result = await adapter.send('sendSms', outboundMessage('sendSms', SMS_PAYLOAD));
    if (result.status !== 'failed') throw new Error('unreachable');
    expect(result.errorClass).toBe('timeout');
    expect(result.retryable).toBe(true);
  });

  it('rejects a payload that is not a canonical SMS payload before touching the network', async () => {
    const transport = new FakeHttpTransport();
    const adapter = await adapterWith(transport);
    const result = await adapter.send(
      'sendSms',
      outboundMessage('sendSms', { channel: 'sms', mobile: '9876543210' }),
    );
    if (result.status !== 'failed') throw new Error('unreachable');
    expect(result.errorClass).toBe('validation');
    expect(transport.requests).toHaveLength(0);
  });

  it('records the call and sends nothing in sandbox mode, and on a replay', async () => {
    const transport = new FakeHttpTransport();
    const factory = createMsg91Factory(transport);
    const adapter = new Msg91Adapter(transport);
    await adapter.configure(adapterContext(msg91ConnectorConfig(), factory, { sandbox: true }));

    const sandboxed = await adapter.send(
      'sendSms',
      outboundMessage('sendSms', SMS_PAYLOAD, { sandbox: true }),
    );
    expect(sandboxed.status).toBe('acknowledged');
    expect(transport.requests).toHaveLength(0);

    // EN-017 §3.6: a replay must not re-notify a patient about last week's visit.
    const replayed = await adapter.send(
      'sendSms',
      outboundMessage('sendSms', SMS_PAYLOAD, { suppressSideEffects: true }),
    );
    expect(replayed.status).toBe('acknowledged');
    expect(transport.requests).toHaveLength(0);
  });
});

describe('MSG91 delivery reports', () => {
  const headers = { 'x-vims-webhook-token': MSG91_TEST_WEBHOOK_TOKEN };

  it('rejects a callback with no shared token — the endpoint is otherwise public', async () => {
    const adapter = await adapterWith(new FakeHttpTransport());
    await expect(
      adapter.receive({
        receivedAt: new Date('2026-08-21T09:00:00.000Z'),
        encoding: 'json',
        body: JSON.stringify({ requestId: '3a7f', report: [{ status: '1' }] }),
        headers: {},
      }),
    ).rejects.toBeInstanceOf(WebhookSignatureError);
  });

  it('rejects a callback with the wrong shared token', async () => {
    const adapter = await adapterWith(new FakeHttpTransport());
    await expect(
      adapter.receive({
        receivedAt: new Date(),
        encoding: 'json',
        body: JSON.stringify({ requestId: '3a7f' }),
        headers: { 'x-vims-webhook-token': 'not-the-token' },
      }),
    ).rejects.toBeInstanceOf(WebhookSignatureError);
  });

  it('normalises MSG91 status codes onto the common delivery model', async () => {
    const adapter = await adapterWith(new FakeHttpTransport());
    const envelope = await adapter.receive({
      receivedAt: new Date('2026-08-21T09:00:00.000Z'),
      encoding: 'json',
      body: JSON.stringify([
        { requestId: 'req-1', report: [{ number: '919876543210', status: '1', desc: 'DELIVERED' }] },
        { requestId: 'req-2', report: [{ number: '919876543211', status: '17', desc: 'BLOCKED' }] },
      ]),
      headers,
    });

    const payload = envelope.payload as DeliveryEnvelopePayload;
    expect(payload.receipts.map((r) => [r.providerMessageId, r.status])).toEqual([
      ['req-1', 'delivered'],
      ['req-2', 'undelivered'],
    ]);
  });

  it('treats an unknown status code as failed rather than ignoring it', async () => {
    // An unknown code from a gateway is a message whose fate is unknown, and
    // `docs/04` §7 does not allow that to be recorded as success.
    const adapter = await adapterWith(new FakeHttpTransport());
    const envelope = await adapter.receive({
      receivedAt: new Date(),
      encoding: 'json',
      body: JSON.stringify({ requestId: 'req-9', report: [{ status: '999' }] }),
      headers,
    });
    const payload = envelope.payload as DeliveryEnvelopePayload;
    expect(payload.receipts[0]?.status).toBe('failed');
  });
});

describe('MSG91 health check', () => {
  it('warns when the account balance has run out, which stops messaging silently', async () => {
    const transport = new FakeHttpTransport([
      { match: '/api/balance.php', response: { status: 200, headers: {}, body: '0' } },
    ]);
    const adapter = await adapterWith(transport);
    const report = await adapter.healthCheck('ping');
    expect(report.status).toBe('warn');
    expect(report.detail).toContain('balance');
  });

  it('fails with an auth class on a 401 so the connector pauses rather than hammering', async () => {
    const transport = new FakeHttpTransport([{ match: '/api/balance.php', response: jsonResponse(401, {}) }]);
    const adapter = await adapterWith(transport);
    const report = await adapter.healthCheck('ping');
    expect(report.status).toBe('fail');
    expect(report.errorClass).toBe('auth');
  });
});

describe('webhook token comparison', () => {
  it('is constant-time and length-safe', async () => {
    // A `===` on a token leaks its prefix through timing. The guard hashes
    // mismatched lengths rather than letting `timingSafeEqual` throw.
    const adapter = await adapterWith(new FakeHttpTransport());
    const long = createHmac('sha256', 'x').update('y').digest('hex');
    await expect(
      adapter.receive({
        receivedAt: new Date(),
        encoding: 'json',
        body: '{}',
        headers: { 'x-vims-webhook-token': long },
      }),
    ).rejects.toBeInstanceOf(WebhookSignatureError);
  });
});
