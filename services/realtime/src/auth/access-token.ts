import { jwtVerify, type JWTPayload } from 'jose';

/**
 * Access-token verification — the *same* token `services/api` issues.
 *
 * This file is intentionally a mirror of `services/api/src/core/auth/
 * token.service.ts`'s `verifyAccess`/`asAccessClaims`, not a reinterpretation:
 *
 *  - same HS256 secret (`JWT_ACCESS_SECRET`) and issuer (`JWT_ISSUER`);
 *  - `algorithms` pinned to `['HS256']`, for the reason the API states — an
 *    unpinned verifier can be talked into `alg: none` or into key confusion,
 *    which silently turns authentication off rather than failing loudly;
 *  - the same claim narrowing, including the rule that an unrecognised `scope`
 *    falls back to the **narrowest** scope (`branch`) and never the widest.
 *
 * The gateway never mints a token. It has no refresh secret and no signing key,
 * so a compromise here cannot issue credentials — only fail to reject them,
 * which is what the pinned algorithm list and the tests exist to prevent.
 */
export interface AccessTokenClaims {
  readonly sub: string;
  readonly sid: string;
  readonly hid: string;
  readonly bid: string | null;
  readonly scope: 'branch' | 'entity' | 'group';
  readonly roles: readonly string[];
  readonly acr: string;
  readonly amr: readonly string[];
  readonly authTime: number;
  readonly imp?: string;
}

export class TokenVerificationError extends Error {
  constructor(
    /** A stable, non-leaking reason suitable for a log line and a client ack. */
    readonly reason: 'missing' | 'malformed' | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'TokenVerificationError';
  }
}

export interface AccessTokenVerifier {
  verify(token: string): Promise<AccessTokenClaims>;
}

export function createAccessTokenVerifier(opts: {
  readonly secret: string;
  readonly issuer: string;
}): AccessTokenVerifier {
  const key = new TextEncoder().encode(opts.secret);
  return {
    async verify(token: string): Promise<AccessTokenClaims> {
      if (typeof token !== 'string' || token.length === 0) {
        throw new TokenVerificationError('missing', 'No access token presented');
      }
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, key, {
          issuer: opts.issuer,
          algorithms: ['HS256'],
        }));
      } catch (error) {
        // The underlying reason (expired / bad signature / wrong issuer) is
        // deliberately not echoed to the client: it is an oracle. It is logged.
        throw new TokenVerificationError(
          'invalid',
          error instanceof Error ? error.message : 'Token verification failed',
        );
      }
      return asAccessClaims(payload);
    },
  };
}

function asAccessClaims(payload: JWTPayload): AccessTokenClaims {
  const str = (k: string): string => {
    const value = payload[k];
    return typeof value === 'string' ? value : '';
  };
  const sub = str('sub');
  const sid = str('sid');
  const hid = str('hid');
  if (!sub || !sid || !hid) {
    throw new TokenVerificationError('malformed', 'Malformed access token');
  }

  const bidRaw = payload['bid'];
  const scopeRaw = payload['scope'];
  const rolesRaw = payload['roles'];
  const amrRaw = payload['amr'];
  const impRaw = payload['imp'];

  const scope: AccessTokenClaims['scope'] =
    scopeRaw === 'group' ? 'group' : scopeRaw === 'entity' ? 'entity' : 'branch';

  const base = {
    sub,
    sid,
    hid,
    bid: typeof bidRaw === 'string' ? bidRaw : null,
    scope,
    roles: Array.isArray(rolesRaw) ? rolesRaw.filter((r): r is string => typeof r === 'string') : [],
    acr: str('acr') || 'aal1',
    amr: Array.isArray(amrRaw) ? amrRaw.filter((r): r is string => typeof r === 'string') : [],
    authTime: typeof payload['authTime'] === 'number' ? payload['authTime'] : 0,
  };
  return typeof impRaw === 'string' ? { ...base, imp: impRaw } : base;
}

/**
 * Where a token may come from on a Socket.IO handshake.
 *
 * `auth.token` is the supported path (Socket.IO sends it in the CONNECT packet,
 * not in a URL). The `Authorization` header is accepted for non-browser clients
 * such as the TV/kiosk device agent. A token in the **query string** is
 * deliberately *not* accepted: `docs/04` §7 keeps credentials out of URLs
 * because URLs reach access logs and referrers.
 */
export interface HandshakeLike {
  readonly auth?: Record<string, unknown> | undefined;
  readonly headers?: Record<string, unknown> | undefined;
}

export function readHandshakeToken(handshake: HandshakeLike): string {
  const fromAuth = handshake.auth?.['token'];
  if (typeof fromAuth === 'string' && fromAuth.length > 0) return fromAuth;

  const header = handshake.headers?.['authorization'];
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    return header.slice('bearer '.length).trim();
  }
  return '';
}
