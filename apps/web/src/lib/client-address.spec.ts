import { describe, expect, it } from 'vitest';
import { clientAddressConfig, resolveClientAddress } from './client-address';

const h = (init: Record<string, string>): Headers => new Headers(init);

/**
 * The bypass these tests exist for.
 *
 * `X-Forwarded-For` is a list each proxy appends to, so its left-most entry is
 * whatever the caller sent. Keying a rate limiter on it lets one caller mint a
 * fresh bucket per request, which is not a weakened limiter — it is no limiter,
 * in front of a metered language model reachable without a session.
 */
describe('when the deployment has said nothing', () => {
  it('trusts nothing, however convincing the headers look', () => {
    const config = clientAddressConfig({});
    expect(resolveClientAddress(h({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }), config)).toBeNull();
    expect(resolveClientAddress(h({ 'x-real-ip': '203.0.113.9' }), config)).toBeNull();
  });
});

describe('with a header the edge overwrites', () => {
  const config = clientAddressConfig({ ASSISTANT_CLIENT_IP_HEADER: 'CF-Connecting-IP' });

  it('reads it, case-insensitively', () => {
    expect(resolveClientAddress(h({ 'cf-connecting-ip': '203.0.113.9' }), config)).toBe('203.0.113.9');
  });

  it('ignores X-Forwarded-For entirely, so spoofing it changes nothing', () => {
    const spoofed = h({
      'cf-connecting-ip': '203.0.113.9',
      'x-forwarded-for': '198.51.100.1, 198.51.100.2',
    });
    expect(resolveClientAddress(spoofed, config)).toBe('203.0.113.9');
  });

  it('returns null when the edge did not set it', () => {
    expect(resolveClientAddress(h({ 'x-forwarded-for': '203.0.113.9' }), config)).toBeNull();
  });
});

describe('with a counted number of appending proxies', () => {
  const oneHop = clientAddressConfig({ ASSISTANT_TRUSTED_PROXY_HOPS: '1' });

  it('takes what the trusted proxy wrote, not what the caller sent', () => {
    // The attacker sends `X-Forwarded-For: 1.1.1.1`; the edge appends the
    // address it actually saw. The real caller is the right-most entry.
    expect(resolveClientAddress(h({ 'x-forwarded-for': '1.1.1.1, 203.0.113.9' }), oneHop)).toBe(
      '203.0.113.9',
    );
  });

  it('gives the same answer however much the caller prepends', () => {
    const forged = Array.from({ length: 20 }, (_, i) => `1.1.1.${String(i)}`).join(', ');
    expect(resolveClientAddress(h({ 'x-forwarded-for': `${forged}, 203.0.113.9` }), oneHop)).toBe(
      '203.0.113.9',
    );
  });

  it('counts from the right when there are two hops', () => {
    const twoHops = clientAddressConfig({ ASSISTANT_TRUSTED_PROXY_HOPS: '2' });
    // caller-supplied, then the real client as seen by the outer proxy, then
    // the outer proxy as seen by the inner one.
    expect(resolveClientAddress(h({ 'x-forwarded-for': '1.1.1.1, 203.0.113.9, 10.0.0.1' }), twoHops)).toBe(
      '203.0.113.9',
    );
  });

  it('accepts a chain of exactly one entry, which is the ordinary case', () => {
    // The caller sent no `X-Forwarded-For` at all, so the edge wrote the whole
    // header and its single entry is the address the edge saw. This is what
    // most real requests look like, and treating it as suspicious would send
    // every honest visitor into the shared bucket.
    expect(resolveClientAddress(h({ 'x-forwarded-for': '203.0.113.9' }), oneHop)).toBe('203.0.113.9');
  });

  it('refuses a chain shorter than the hops it was told to expect', () => {
    // No header, or an empty one: the request did not arrive by the path the
    // deployment described. Nothing here is worth trusting.
    expect(resolveClientAddress(h({}), oneHop)).toBeNull();
    expect(resolveClientAddress(h({ 'x-forwarded-for': '  ,  ' }), oneHop)).toBeNull();
    const twoHops = clientAddressConfig({ ASSISTANT_TRUSTED_PROXY_HOPS: '2' });
    expect(resolveClientAddress(h({ 'x-forwarded-for': '203.0.113.9' }), twoHops)).toBeNull();
  });

  it('ignores a malformed hop count rather than trusting one hop', () => {
    const config = clientAddressConfig({ ASSISTANT_TRUSTED_PROXY_HOPS: 'two' });
    expect(resolveClientAddress(h({ 'x-forwarded-for': '1.1.1.1, 203.0.113.9' }), config)).toBeNull();
  });
});
