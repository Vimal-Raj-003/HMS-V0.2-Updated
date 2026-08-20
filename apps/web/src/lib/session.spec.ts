import { describe, expect, it } from 'vitest';
import { cookiesMaySkipSecure } from './session';

/**
 * The `Secure` attribute is the one thing standing between a session cookie and
 * a clear-text network, so the predicate that decides it gets a test of its own.
 * The rule is narrow on purpose: `Secure` may be withheld only for plain HTTP to
 * a loopback host, and must survive everything else.
 */
describe('cookiesMaySkipSecure', () => {
  it('withholds Secure only for plain HTTP on loopback', () => {
    for (const url of [
      'http://localhost:3400/api/auth/login',
      'http://127.0.0.1:3000/api/auth/login',
      'http://[::1]:3000/api/auth/login',
      'http://web.localhost/api/auth/login',
    ]) {
      expect(cookiesMaySkipSecure(new Request(url, { method: 'POST' })), url).toBe(true);
    }
  });

  it('keeps Secure for every routable host and for HTTPS loopback', () => {
    for (const url of [
      'https://hms.example.com/api/auth/login',
      'https://localhost:3400/api/auth/login',
      // A production build that has lost its TLS termination must fail loudly —
      // the browser refuses a Secure cookie over HTTP — rather than quietly
      // serving sessions in clear text.
      'http://hms.example.com/api/auth/login',
      'http://10.0.0.5/api/auth/login',
      // Not loopback: a hostname that merely ends in the word, or contains it.
      'http://notlocalhost/api/auth/login',
      'http://localhost.evil.example/api/auth/login',
    ]) {
      expect(cookiesMaySkipSecure(new Request(url, { method: 'POST' })), url).toBe(false);
    }
  });
});
