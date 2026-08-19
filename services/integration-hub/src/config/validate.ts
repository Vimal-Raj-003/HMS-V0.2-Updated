/**
 * Registration-time validation: schema **and** capability.
 *
 * The Zod schema in `connector-config.ts` answers "is this config internally
 * coherent?". It cannot answer "can the chosen adapter actually do this?" —
 * that needs the manifest. Both run here, together, because a config that
 * passes one and fails the other is the same incident either way: a connector
 * that looked configured and did nothing.
 *
 * Every issue is returned, not thrown one at a time, so the wizard in EN-017 §8
 * can highlight every broken field at once rather than making an engineer
 * discover them serially.
 */
import type { z } from 'zod';
import type { ConnectorAdapterFactory } from '../adapter/types.js';
import { connectorConfigSchema, type ConnectorConfig } from './connector-config.js';

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

export type ConfigValidation =
  | { readonly ok: true; readonly config: ConnectorConfig }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

export class ConnectorConfigError extends Error {
  constructor(readonly issues: readonly ValidationIssue[]) {
    super(`connector configuration rejected:\n${issues.map((i) => `  ${i.path}: ${i.message}`).join('\n')}`);
    this.name = 'ConnectorConfigError';
  }
}

function fromZod(error: z.ZodError): readonly ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length === 0 ? '(root)' : issue.path.join('.'),
    message: issue.message,
  }));
}

export function validateConnectorConfig(
  input: unknown,
  factory: ConnectorAdapterFactory,
): ConfigValidation {
  const parsed = connectorConfigSchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: fromZod(parsed.error) };

  const config = parsed.data;
  const caps = factory.manifest.capabilities;
  const issues: ValidationIssue[] = [];

  if (!caps.protocols.includes(config.protocol)) {
    issues.push({
      path: 'protocol',
      message: `adapter '${factory.manifest.id}' speaks ${caps.protocols.join(', ')}, not '${config.protocol}'`,
    });
  }

  // `both` needs the adapter to support `both` (or in *and* out explicitly).
  const directionOk =
    caps.directions.includes(config.direction) ||
    (config.direction === 'both' && caps.directions.includes('in') && caps.directions.includes('out'));
  if (!directionOk) {
    issues.push({
      path: 'direction',
      message: `adapter '${factory.manifest.id}' supports direction ${caps.directions.join('/')}, not '${config.direction}'`,
    });
  }

  const declared = new Map(caps.operations.map((op) => [op.key, op]));
  for (const op of config.operations) {
    const descriptor = declared.get(op.key);
    if (descriptor === undefined) {
      issues.push({
        path: `operations.${op.key}`,
        message: `adapter '${factory.manifest.id}' declares no operation '${op.key}' (declared: ${[...declared.keys()].join(', ')})`,
      });
      continue;
    }
    if (op.direction !== descriptor.direction && descriptor.direction !== 'both') {
      issues.push({
        path: `operations.${op.key}.direction`,
        message: `operation '${op.key}' is '${descriptor.direction}' on this adapter, configured as '${op.direction}'`,
      });
    }
  }

  if (!caps.healthCheckKinds.includes(config.health.kind)) {
    issues.push({
      path: 'health.kind',
      message: `adapter '${factory.manifest.id}' offers health checks ${caps.healthCheckKinds.join('/')}, not '${config.health.kind}'`,
    });
  }

  // `docs/08` §10.3: an echo probe must be genuinely side-effect free. A health
  // check that creates an order every 60 s is discovered by the partner, not by us.
  if (config.health.kind === 'echo' && config.health.operationKey !== undefined) {
    const descriptor = declared.get(config.health.operationKey);
    if (descriptor !== undefined && !descriptor.sideEffectFree) {
      issues.push({
        path: 'health.operationKey',
        message: `operation '${config.health.operationKey}' has side effects and may not be used as an echo health check`,
      });
    }
  }

  // EN-017 §5: retrying against a partner with no idempotency support is how a
  // patient receives three SMS or a payment is captured twice.
  if (!caps.supportsIdempotencyKey && config.retry.policy !== 'R0' && config.retry.maxAttempts > 1) {
    issues.push({
      path: 'retry',
      message: `adapter '${factory.manifest.id}' reports no partner idempotency support, so retries are unsafe: declare retry.policy 'R0' with maxAttempts 1 (EN-017 §5)`,
    });
  }

  if (config.environment === 'sandbox' && !caps.supportsSandbox) {
    issues.push({
      path: 'environment',
      message: `adapter '${factory.manifest.id}' has no sandbox mode, so a 'sandbox' connector would send real traffic`,
    });
  }

  // EN-017 §5: an on-prem deployment must know which connectors die with the WAN.
  if (!config.requiresInternet && caps.requiresInternet) {
    issues.push({
      path: 'requiresInternet',
      message: `adapter '${factory.manifest.id}' requires internet access; a connector claiming otherwise would be reported as available during a WAN outage`,
    });
  }

  for (const message of factory.refineConfig?.(config) ?? []) {
    issues.push({ path: 'options', message });
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, config };
}

/** Throwing form, for call sites where a bad config is a programming error. */
export function parseConnectorConfig(input: unknown, factory: ConnectorAdapterFactory): ConnectorConfig {
  const result = validateConnectorConfig(input, factory);
  if (!result.ok) throw new ConnectorConfigError(result.issues);
  return result.config;
}
