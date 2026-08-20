import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { claimsFor, IDS, signAccessToken, TEST_ISSUER, TEST_SECRET } from '../__tests__/harness.js';
import { createAccessTokenVerifier, readHandshakeToken, TokenVerificationError } from './access-token.js';

const verifier = createAccessTokenVerifier({ secret: TEST_SECRET, issuer: TEST_ISSUER });

describe('access-token verification (same contract as services/api)', () => {
  it('accepts a token signed with the API access secret and issuer', async () => {
    const token = await signAccessToken(claimsFor());
    const claims = await verifier.verify(token);
    expect(claims.sub).toBe(IDS.userAlice);
    expect(claims.hid).toBe(IDS.hospitalA);
    expect(claims.bid).toBe(IDS.branchA1);
    expect(claims.scope).toBe('branch');
    expect(claims.roles).toEqual(['nurse_ward']);
  });

  it('rejects an expired token', async () => {
    const token = await signAccessToken(claimsFor(), { expiresInSeconds: -60 });
    await expect(verifier.verify(token)).rejects.toBeInstanceOf(TokenVerificationError);
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await signAccessToken(claimsFor(), {
      secret: 'a-completely-different-secret-32-chars',
    });
    await expect(verifier.verify(token)).rejects.toBeInstanceOf(TokenVerificationError);
  });

  it('rejects a token from another issuer', async () => {
    const token = await signAccessToken(claimsFor(), { issuer: 'someone-else' });
    await expect(verifier.verify(token)).rejects.toBeInstanceOf(TokenVerificationError);
  });

  it('rejects `alg: none` — the algorithm list is pinned', async () => {
    // Hand-rolled, because no library will sign an unsecured JWT for you.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({ ...claimsFor(), iss: TEST_ISSUER, exp: Math.floor(Date.now() / 1000) + 900 }),
    ).toString('base64url');
    await expect(verifier.verify(`${header}.${body}.`)).rejects.toBeInstanceOf(TokenVerificationError);
  });

  it('rejects a token signed with a different HMAC algorithm', async () => {
    const token = await new SignJWT({ ...claimsFor() })
      .setProtectedHeader({ alg: 'HS512', typ: 'JWT' })
      .setIssuer(TEST_ISSUER)
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(TEST_SECRET));
    await expect(verifier.verify(token)).rejects.toBeInstanceOf(TokenVerificationError);
  });

  it('rejects garbage and an empty token with a stable reason', async () => {
    await expect(verifier.verify('')).rejects.toMatchObject({ reason: 'missing' });
    await expect(verifier.verify('not.a.jwt')).rejects.toMatchObject({ reason: 'invalid' });
  });

  it('rejects a well-signed token that is missing the tenant claim', async () => {
    const token = await new SignJWT({ sid: IDS.sessionAlice })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(TEST_ISSUER)
      .setSubject(IDS.userAlice)
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(TEST_SECRET));
    await expect(verifier.verify(token)).rejects.toMatchObject({ reason: 'malformed' });
  });

  it('narrows an unrecognised scope to the narrowest one, not the widest', async () => {
    const token = await signAccessToken({ ...claimsFor(), scope: 'superuser' as 'branch' });
    expect((await verifier.verify(token)).scope).toBe('branch');
  });
});

describe('handshake token extraction', () => {
  it('reads auth.token', () => {
    expect(readHandshakeToken({ auth: { token: 'abc' } })).toBe('abc');
  });

  it('reads a bearer Authorization header for device clients', () => {
    expect(readHandshakeToken({ headers: { authorization: 'Bearer abc' } })).toBe('abc');
    expect(readHandshakeToken({ headers: { authorization: 'bearer abc' } })).toBe('abc');
  });

  it('ignores a token in the query string — credentials never travel in a URL', () => {
    expect(readHandshakeToken({ auth: {}, headers: { referer: '/?token=abc' } })).toBe('');
  });
});
