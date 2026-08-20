import { describe, expect, it } from 'vitest';
import type { DeliveryEnvelopePayload } from '../../messaging/types.js';
import { adapterContext, outboundMessage, SMS_PAYLOAD } from '../../testing/adapter-harness.js';
import { dryRunSmsConnectorConfig } from '../../testing/messaging-fixtures.js';
import { DRY_RUN_SMS_MANIFEST, DryRunSmsAdapter, dryRunSmsFactory } from './dry-run-sms.adapter.js';

async function adapter(config = dryRunSmsConnectorConfig()): Promise<DryRunSmsAdapter> {
  const instance = new DryRunSmsAdapter();
  await instance.configure(adapterContext(config, dryRunSmsFactory));
  return instance;
}

describe('dry-run SMS manifest', () => {
  it('declares no transport, so a DPDP data-flow register does not claim one', () => {
    expect(DRY_RUN_SMS_MANIFEST.capabilities.protocols).toEqual(['null']);
    expect(DRY_RUN_SMS_MANIFEST.capabilities.requiresInternet).toBe(false);
    // Nothing leaves the process, so the send genuinely is side-effect free —
    // which is what makes an `echo` health check legal here and not on MSG91.
    expect(DRY_RUN_SMS_MANIFEST.capabilities.operations[0]?.sideEffectFree).toBe(true);
  });
});

describe('dry-run SMS send', () => {
  it('accepts a DLT-complete payload, records it and sends nothing', async () => {
    const instance = await adapter();
    const result = await instance.send('sendSms', outboundMessage('sendSms', SMS_PAYLOAD));

    expect(result.status).toBe('acknowledged');
    if (result.status === 'failed') throw new Error(result.message);
    expect(result.partnerRef).toBe('dryrun:00000000-0000-7000-8000-0000000000aa');

    const recorded = instance.outbox[0];
    expect(recorded?.dltTemplateId).toBe('1707169999999900001');
    expect(recorded?.senderId).toBe('VIMHMS');
    expect(recorded?.body).toContain('R Iyer');
  });

  it('does NOT bypass the DLT gate: a payload with no DLT ids is refused', async () => {
    // The value of a dry run is that it proves the pipeline including the gate.
    // A hospital mid-DLT-registration sees exactly which templates are blocked,
    // which is the list it takes to the portal.
    const instance = await adapter();
    const { dltTemplateId: _omitted, ...withoutDlt } = SMS_PAYLOAD;
    const result = await instance.send('sendSms', outboundMessage('sendSms', withoutDlt));

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('unreachable');
    expect(result.errorClass).toBe('validation');
    expect(result.message).toContain('dltTemplateId');
    expect(instance.outbox).toHaveLength(0);
  });

  it('refuses an unnormalised recipient, exactly as a real gateway would', async () => {
    const instance = await adapter();
    const result = await instance.send('sendSms', outboundMessage('sendSms', { ...SMS_PAYLOAD, mobile: '9876543210' }));
    if (result.status !== 'failed') throw new Error('unreachable');
    expect(result.message).toContain('E.164');
  });

  it('serves programmed failures so a drill can be rehearsed against it', async () => {
    const instance = await adapter(
      dryRunSmsConnectorConfig({ failures: [{ errorClass: 'partner_5xx', code: 'GATEWAY_DOWN', times: 2 }] }),
    );

    expect((await instance.send('sendSms', outboundMessage('sendSms', SMS_PAYLOAD))).status).toBe('failed');
    expect((await instance.send('sendSms', outboundMessage('sendSms', SMS_PAYLOAD))).status).toBe('failed');
    expect((await instance.send('sendSms', outboundMessage('sendSms', SMS_PAYLOAD))).status).toBe('acknowledged');
  });

  it('bounds the outbox, because rendered bodies are PHI-bearing by construction', async () => {
    const instance = await adapter({
      ...dryRunSmsConnectorConfig(),
      options: { outboxLimit: 2 },
    });
    for (let i = 0; i < 5; i += 1) {
      await instance.send('sendSms', outboundMessage('sendSms', SMS_PAYLOAD, { messageId: `m${String(i)}` }));
    }
    expect(instance.outbox).toHaveLength(2);
    expect(instance.outbox.map((r) => r.messageId)).toEqual(['m3', 'm4']);
  });

  it('clears the outbox on close so bodies do not outlive the connector', async () => {
    const instance = await adapter();
    await instance.send('sendSms', outboundMessage('sendSms', SMS_PAYLOAD));
    expect(instance.outbox).toHaveLength(1);
    await instance.close('shutdown');
    expect(instance.outbox).toHaveLength(0);
  });

  it('refuses an unknown operation', async () => {
    const instance = await adapter();
    const result = await instance.send('sendTemplate', outboundMessage('sendTemplate', SMS_PAYLOAD));
    if (result.status !== 'failed') throw new Error('unreachable');
    expect(result.errorClass).toBe('not_supported');
  });
});

describe('dry-run SMS simulated delivery', () => {
  it('produces the same canonical receipt a real gateway would', async () => {
    const instance = await adapter();
    const envelope = await instance.receive({
      receivedAt: new Date('2026-08-21T09:00:00.000Z'),
      encoding: 'json',
      body: { providerMessageId: 'dryrun:m1' },
      headers: {},
    });

    const payload = envelope.payload as DeliveryEnvelopePayload;
    expect(payload.receipts[0]?.providerMessageId).toBe('dryrun:m1');
    expect(payload.receipts[0]?.status).toBe('delivered');
  });

  it('honours the configured simulated status, so a fallback path can be driven', async () => {
    const instance = await adapter(dryRunSmsConnectorConfig({ simulatedDeliveryStatus: 'undelivered' }));
    const envelope = await instance.receive({
      receivedAt: new Date(),
      encoding: 'json',
      body: { providerMessageId: 'dryrun:m1' },
      headers: {},
    });
    const payload = envelope.payload as DeliveryEnvelopePayload;
    expect(payload.receipts[0]?.status).toBe('undelivered');
  });

  it('rejects a malformed simulated callback rather than inventing a receipt', async () => {
    const instance = await adapter();
    await expect(
      instance.receive({ receivedAt: new Date(), encoding: 'json', body: { nope: true }, headers: {} }),
    ).rejects.toThrow(/providerMessageId/);
  });
});
