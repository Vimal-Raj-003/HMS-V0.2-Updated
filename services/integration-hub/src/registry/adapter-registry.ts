/**
 * EN-017 §3.8 — the in-process half of the connector registry.
 *
 * `ihub_connector_packages` is the *catalogue* of signed adapter packages and is
 * deliberately read-only to the application role (`REVOKE INSERT, UPDATE, DELETE
 * … FROM hms_app`) — a compromised service must not be able to install a
 * connector. What the process holds is this: the adapters actually linked into
 * this build, keyed by `id@version`.
 *
 * Version resolution is exact by default. `resolve('vims.null-echo')` without a
 * version returns the highest, which is a convenience for development; a
 * registered connector always stores the fully-qualified `id@version` so that a
 * later deploy adding v2 cannot silently change how an existing hospital's
 * messages are formatted — EN-017 §3.1.6 keeps old versions precisely so the
 * message log stays interpretable.
 */
import type { ConnectorAdapterFactory, ConnectorManifest } from '../adapter/types.js';

export class AdapterRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterRegistryError';
  }
}

interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

function parseVersion(version: string): ParsedVersion {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (match === null) {
    throw new AdapterRegistryError(`adapter version '${version}' is not major.minor.patch`);
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

export class AdapterRegistry {
  private readonly factories = new Map<string, ConnectorAdapterFactory>();

  /** Registration is once-only: silently replacing an adapter is how a hospital gets a different wire format after a deploy. */
  register(factory: ConnectorAdapterFactory): this {
    const { id, version } = factory.manifest;
    parseVersion(version);
    const ref = `${id}@${version}`;
    if (this.factories.has(ref)) {
      throw new AdapterRegistryError(`adapter '${ref}' is already registered`);
    }
    if (factory.manifest.capabilities.operations.length === 0) {
      throw new AdapterRegistryError(`adapter '${ref}' declares no operations, so nothing could ever be dispatched to it`);
    }
    this.factories.set(ref, factory);
    return this;
  }

  has(ref: string): boolean {
    return this.tryResolve(ref) !== undefined;
  }

  /** Throws with the available list, because "adapter not found" alone wastes a support call. */
  resolve(ref: string): ConnectorAdapterFactory {
    const found = this.tryResolve(ref);
    if (found === undefined) {
      const known = [...this.factories.keys()].sort().join(', ') || '(none)';
      throw new AdapterRegistryError(`no adapter registered for '${ref}'. Registered: ${known}`);
    }
    return found;
  }

  tryResolve(ref: string): ConnectorAdapterFactory | undefined {
    if (ref.includes('@')) return this.factories.get(ref);

    const candidates = [...this.factories.values()].filter((f) => f.manifest.id === ref);
    if (candidates.length === 0) return undefined;
    return candidates.reduce((best, candidate) =>
      compareVersions(candidate.manifest.version, best.manifest.version) > 0 ? candidate : best,
    );
  }

  /** The catalogue an IT admin sees before choosing a template (EN-017 §3.1.1). */
  list(): readonly ConnectorManifest[] {
    return [...this.factories.values()]
      .map((f) => f.manifest)
      .sort((a, b) => (a.id === b.id ? compareVersions(a.version, b.version) : a.id.localeCompare(b.id)));
  }

  get size(): number {
    return this.factories.size;
  }
}
