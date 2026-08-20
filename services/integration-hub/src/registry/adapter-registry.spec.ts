import { describe, expect, it } from 'vitest';
import type { ConnectorAdapter, ConnectorAdapterFactory, ConnectorManifest } from '../adapter/types.js';
import { NULL_ECHO_MANIFEST, nullEchoFactory } from '../adapters/null-echo/null-echo.adapter.js';
import { AdapterRegistry, AdapterRegistryError } from './adapter-registry.js';

function factoryWith(overrides: Partial<ConnectorManifest>): ConnectorAdapterFactory {
  const manifest: ConnectorManifest = {
    ...NULL_ECHO_MANIFEST,
    ...overrides,
    capabilities: { ...NULL_ECHO_MANIFEST.capabilities, ...(overrides.capabilities ?? {}) },
  };
  return {
    manifest,
    create(): ConnectorAdapter {
      return nullEchoFactory.create();
    },
  };
}

describe('AdapterRegistry', () => {
  it('resolves an adapter by its fully-qualified id@version', () => {
    const registry = new AdapterRegistry().register(nullEchoFactory);
    expect(registry.resolve('vims.null-echo@0.1.0').manifest.id).toBe('vims.null-echo');
    expect(registry.size).toBe(1);
  });

  it('resolves a bare id to the highest registered version', () => {
    const registry = new AdapterRegistry()
      .register(factoryWith({ version: '0.1.0' }))
      .register(factoryWith({ version: '0.9.3' }))
      .register(factoryWith({ version: '0.10.0' }));

    // String comparison would pick 0.9.3 — the version most likely to be the
    // *older* one, and the bug would only surface at the tenth minor release.
    expect(registry.resolve('vims.null-echo').manifest.version).toBe('0.10.0');
  });

  it('refuses to replace an already-registered id@version', () => {
    const registry = new AdapterRegistry().register(nullEchoFactory);
    // Silent replacement would change the wire format of a live hospital's
    // messages on the next deploy, with nothing in the log to say so.
    expect(() => registry.register(nullEchoFactory)).toThrow(AdapterRegistryError);
  });

  it('refuses an adapter that declares no operations', () => {
    const registry = new AdapterRegistry();
    expect(() =>
      registry.register(
        factoryWith({ capabilities: { ...NULL_ECHO_MANIFEST.capabilities, operations: [] } }),
      ),
    ).toThrow(/declares no operations/);
  });

  it('refuses a version that is not major.minor.patch', () => {
    const registry = new AdapterRegistry();
    expect(() => registry.register(factoryWith({ version: 'v2' }))).toThrow(/major\.minor\.patch/);
  });

  it('names what it does have when a lookup fails', () => {
    const registry = new AdapterRegistry().register(nullEchoFactory);
    expect(() => registry.resolve('acme.hl7@1.0.0')).toThrow(/Registered: vims\.null-echo@0\.1\.0/);
  });

  it('reports an unknown adapter as absent rather than throwing from `has`', () => {
    const registry = new AdapterRegistry().register(nullEchoFactory);
    expect(registry.has('vims.null-echo')).toBe(true);
    expect(registry.has('acme.hl7')).toBe(false);
    expect(registry.tryResolve('acme.hl7')).toBeUndefined();
  });

  it('lists the catalogue in a stable order', () => {
    const registry = new AdapterRegistry()
      .register(factoryWith({ version: '0.2.0' }))
      .register(factoryWith({ id: 'acme.hl7', version: '1.0.0' }))
      .register(factoryWith({ version: '0.1.0' }));

    expect(registry.list().map((m) => `${m.id}@${m.version}`)).toEqual([
      'acme.hl7@1.0.0',
      'vims.null-echo@0.1.0',
      'vims.null-echo@0.2.0',
    ]);
  });
});
