import { describe, expect, it } from 'vitest';
import type { AdapterContext, OutboundMessage } from '../../adapter/types.js';
import { systemClock } from '../../adapter/types.js';
import { parseConnectorConfig } from '../../config/validate.js';
import { silentLogger } from '../../logger.js';
import { nullEchoConnectorConfig } from '../../testing/fixtures.js';
import { NULL_ECHO_MANIFEST, NullEchoAdapter, nullEchoFactory } from './null-echo.adapter.js';

function contextFor(config: ReturnType<typeof nullEchoConnectorConfig>): AdapterContext {
  return {
    config: parseConnectorConfig(config, nullEchoFactory),
    connectorId: '00000000-0000-7000-8000-000000000001',
    connectorVersion: 1,
    hospitalId: '00000000-0000-7000-8000-000000000002',
    environment: 'production',
    sandbox: false,
    logger: silentLogger,
    clock: systemClock,
    secrets: { resolve: () => Promise.reject(new Error('no secret store')) },
  };
}

const MESSAGE: OutboundMessage = {
  messageId: 'm1',
  correlationId: 'c1',
  operationKey: 'echo',
  encoding: 'json',
  payload: { hello: 'world' },
  headers: {},
  attempt: 1,
  timeoutMs: 5_000,
  sandbox: false,
  suppressSideEffects: false,
};

describe('null/echo reference adapter', () => {
  it('declares capabilities that describe a connector with no transport', () => {
    // The declaration is what the registry validates a configuration against,
    // so an inaccurate manifest is how a connector gets configured for something
    // it cannot do.
    expect(NULL_ECHO_MANIFEST.capabilities.protocols).toEqual(['null']);
    expect(NULL_ECHO_MANIFEST.capabilities.requiresInternet).toBe(false);
    expect(NULL_ECHO_MANIFEST.capabilities.supportsSandbox).toBe(true);
    expect(NULL_ECHO_MANIFEST.capabilities.supportsStreamingListener).toBe(false);
    expect(NULL_ECHO_MANIFEST.capabilities.operations.map((op) => op.key)).toEqual(['echo', 'sink']);
  });

  it('echoes the payload back and acknowledges', async () => {
    const adapter = new NullEchoAdapter();
    await adapter.configure(contextFor(nullEchoConnectorConfig()));

    const result = await adapter.send('echo', MESSAGE);
    expect(result.status).toBe('acknowledged');
    if (result.status === 'failed') throw new Error('unreachable');
    expect(result.ackCode).toBe('AA');
    expect(result.response).toEqual({ hello: 'world' });
  });

  it('serves exactly the programmed number of failures, then succeeds', async () => {
    const adapter = new NullEchoAdapter();
    await adapter.configure(
      contextFor(
        nullEchoConnectorConfig({
          failures: [{ operationKey: 'echo', errorClass: 'network', times: 2 }],
        }),
      ),
    );

    const first = await adapter.send('echo', MESSAGE);
    const second = await adapter.send('echo', MESSAGE);
    const third = await adapter.send('echo', MESSAGE);

    expect(first.status).toBe('failed');
    expect(second.status).toBe('failed');
    expect(third.status).toBe('acknowledged');
  });

  it('classifies a programmed failure as retryable exactly when its class is', async () => {
    const adapter = new NullEchoAdapter();
    await adapter.configure(
      contextFor(
        nullEchoConnectorConfig({
          failures: [{ operationKey: 'echo', errorClass: 'semantic_4xx', times: 'always' }],
        }),
      ),
    );
    const result = await adapter.send('echo', MESSAGE);
    if (result.status !== 'failed') throw new Error('expected a failure');
    // A 422 is the partner saying "this will never work". Retrying it burns the
    // budget and delays the human who has to fix the mapping.
    expect(result.retryable).toBe(false);
  });

  it('rejects an operation it does not declare rather than pretending to send', async () => {
    const adapter = new NullEchoAdapter();
    await adapter.configure(contextFor(nullEchoConnectorConfig()));
    const result = await adapter.send('pushADT', MESSAGE);
    if (result.status !== 'failed') throw new Error('expected a failure');
    expect(result.errorClass).toBe('not_supported');
    expect(result.retryable).toBe(false);
  });

  it('returns a canonical envelope from an inbound message', async () => {
    const adapter = new NullEchoAdapter();
    await adapter.configure(contextFor(nullEchoConnectorConfig()));
    const envelope = await adapter.receive({
      receivedAt: new Date('2026-08-19T10:00:00Z'),
      encoding: 'json',
      body: { ping: 1 },
      headers: {},
      sourceRef: 'vendor-msg-7',
    });
    expect(envelope.canonicalType).toBe('Echo');
    expect(envelope.providerMessageId).toBe('vendor-msg-7');
  });

  it('reports its health without touching a network', async () => {
    const adapter = new NullEchoAdapter();
    await adapter.configure(contextFor(nullEchoConnectorConfig({ healthStatus: 'fail' })));
    const report = await adapter.healthCheck('ping');
    expect(report.status).toBe('fail');
    expect(report.errorClass).toBe('network');
  });

  it('refuses to send after close, rather than silently doing nothing', async () => {
    const adapter = new NullEchoAdapter();
    await adapter.configure(contextFor(nullEchoConnectorConfig()));
    await adapter.close('shutdown');
    const result = await adapter.send('echo', MESSAGE);
    expect(result.status).toBe('failed');
  });

  it('throws if used before it is configured', async () => {
    const adapter = new NullEchoAdapter();
    await expect(adapter.send('echo', MESSAGE)).rejects.toThrow(/before configure/);
  });
});
