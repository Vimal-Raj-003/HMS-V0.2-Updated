import { describe, expect, it } from 'vitest';
import { nullEchoFactory } from '../adapters/null-echo/null-echo.adapter.js';
import { nullEchoConnectorConfig } from '../testing/fixtures.js';
import type { ConnectorConfigInput } from './connector-config.js';
import { validateConnectorConfig } from './validate.js';

/**
 * Every case here is a connector that would have looked configured and then
 * failed in production — usually at 03:00, usually silently. EN-017 §14 is a
 * list of such failures; this suite is that list turned into refusals at
 * registration time.
 */

function check(config: ConnectorConfigInput | Record<string, unknown>): readonly string[] {
  const result = validateConnectorConfig(config, nullEchoFactory);
  return result.ok ? [] : result.issues.map((i) => `${i.path}: ${i.message}`);
}

describe('connector config validation', () => {
  it('accepts the reference configuration', () => {
    const result = validateConnectorConfig(nullEchoConnectorConfig(), nullEchoFactory);
    expect(result.ok).toBe(true);
  });

  it('applies the documented defaults', () => {
    const result = validateConnectorConfig(nullEchoConnectorConfig(), nullEchoFactory);
    if (!result.ok) throw new Error(result.issues.map((i) => i.message).join('; '));
    expect(result.config.tls.verify).toBe(true);
    expect(result.config.retry.policy).toBe('R1');
    expect(result.config.health.intervalSec).toBe(60);
  });

  it('rejects a literal secret where a Vault reference belongs', () => {
    // The failure this prevents: a pasted API key persisted into a JSONB column
    // that the connector list endpoint, every backup and the message log carry.
    const issues = check({
      ...nullEchoConnectorConfig(),
      auth: { type: 'api_key', header: 'X-Api-Key', secretRef: 'sk_live_9f2c4a1b' },
    });
    expect(issues.join('\n')).toMatch(/secret \*reference\*/);
  });

  it('accepts a proper secret reference', () => {
    const issues = check({
      ...nullEchoConnectorConfig(),
      auth: { type: 'api_key', header: 'X-Api-Key', secretRef: 'vault://hms/connectors/echo/api_key' },
    });
    expect(issues).toEqual([]);
  });

  it('rejects an MLLP endpoint with no host and port', () => {
    const issues = check({ ...nullEchoConnectorConfig(), protocol: 'hl7v2_mllp', endpoint: {} });
    expect(issues.join('\n')).toMatch(/endpoint\.host/);
    expect(issues.join('\n')).toMatch(/endpoint\.port/);
  });

  it('rejects a DICOM endpoint with no called-AE title', () => {
    const issues = check({
      ...nullEchoConnectorConfig(),
      protocol: 'dicom',
      endpoint: { host: 'pacs.local', port: 104 },
    });
    expect(issues.join('\n')).toMatch(/endpoint\.aeTitle/);
  });

  it('rejects a cross-border flow with no data-processing agreement', () => {
    const base = nullEchoConnectorConfig();
    const issues = check({
      ...base,
      dpdp: { ...base.dpdp, crossBorder: true },
    });
    expect(issues.join('\n')).toMatch(/data-processing agreement/);
  });

  it('rejects a PHI connector whose stated purpose is not a purpose', () => {
    const base = nullEchoConnectorConfig();
    const issues = check({ ...base, dpdp: { ...base.dpdp, purpose: 'sync' } });
    expect(issues.length).toBeGreaterThan(0);
  });

  it('rejects retries on an operation that declares no idempotency', () => {
    // EN-017 §5. This is the rule that stops a partner capturing a payment
    // three times because the first response was lost on the wire.
    const base = nullEchoConnectorConfig();
    const issues = check({
      ...base,
      operations: [{ key: 'sink', name: 'Sink', direction: 'out', idempotency: 'none' }],
    });
    expect(issues.join('\n')).toMatch(/may not be retried/);
  });

  it('allows a non-idempotent operation when the retry policy is R0', () => {
    const base = nullEchoConnectorConfig();
    const issues = check({
      ...base,
      retry: { policy: 'R0', maxAttempts: 1 },
      operations: [{ key: 'sink', name: 'Sink', direction: 'out', idempotency: 'none' }],
    });
    expect(issues).toEqual([]);
  });

  it('rejects an expect_traffic check with no silence window', () => {
    const base = nullEchoConnectorConfig();
    const issues = check({ ...base, health: { kind: 'expect_traffic' } });
    expect(issues.join('\n')).toMatch(/expectTrafficWindowMin/);
  });

  it('rejects an echo health check that names an operation with side effects', () => {
    const base = nullEchoConnectorConfig();
    const issues = check({
      ...base,
      health: { kind: 'echo', operationKey: 'sink' },
      operations: [{ key: 'sink', name: 'Sink', direction: 'out', idempotency: 'key_header' }],
    });
    expect(issues.join('\n')).toMatch(/side effects/);
  });

  it('rejects duplicate operation keys', () => {
    const base = nullEchoConnectorConfig();
    const issues = check({
      ...base,
      operations: [
        { key: 'echo', name: 'Echo', direction: 'both', idempotency: 'natural_key' },
        { key: 'echo', name: 'Echo again', direction: 'both', idempotency: 'natural_key' },
      ],
    });
    expect(issues.join('\n')).toMatch(/duplicate operation key/);
  });

  it('rejects an unknown field rather than silently ignoring it', () => {
    // A typo'd `timeoutMS` that is quietly dropped becomes a 30-second default
    // nobody chose.
    const issues = check({ ...nullEchoConnectorConfig(), timeoutMS: 1000 });
    expect(issues.length).toBeGreaterThan(0);
  });
});

describe('connector config validation — adapter capabilities', () => {
  it('rejects a protocol the adapter does not speak', () => {
    const issues = check({
      ...nullEchoConnectorConfig(),
      protocol: 'rest',
      endpoint: { url: 'https://partner.example.com/api' },
    });
    expect(issues.join('\n')).toMatch(/speaks null, not 'rest'/);
  });

  it('rejects an operation the adapter does not declare', () => {
    const base = nullEchoConnectorConfig();
    const issues = check({
      ...base,
      operations: [{ key: 'pushADT', name: 'Push ADT', direction: 'out', idempotency: 'key_header' }],
    });
    expect(issues.join('\n')).toMatch(/declares no operation 'pushADT'/);
  });

  it('rejects a health-check kind the adapter cannot perform', () => {
    const issues = check({
      ...nullEchoConnectorConfig(),
      health: { kind: 'expect_traffic', expectTrafficWindowMin: 30 },
    });
    expect(issues.join('\n')).toMatch(/offers health checks ping\/echo/);
  });

  it('reports every problem at once so the wizard can highlight them together', () => {
    const base = nullEchoConnectorConfig();
    const issues = check({
      ...base,
      protocol: 'rest',
      endpoint: {},
      dpdp: { ...base.dpdp, crossBorder: true },
    });
    expect(issues.length).toBeGreaterThanOrEqual(2);
  });
});
