import { Inject, Injectable } from '@nestjs/common';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { ENV, type Env } from '../config/env.js';

/**
 * Access and refresh tokens.
 *
 * Access tokens are 15 minutes (`CLAUDE.md` §2) and carry only what the guards
 * need. Refresh tokens are long-lived, rotate on every use, and are signed with
 * a **different** secret: if the access secret leaks from a log or a client
 * bundle, it must not also mint refresh tokens.
 *
 * Nothing identifying a patient ever goes in a token. A JWT is not encrypted —
 * anyone holding it can read the payload — and `docs/04` §7 keeps identifiers out
 * of anything that travels in a header.
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

export interface RefreshTokenClaims {
  readonly sub: string;
  readonly sid: string;
  /** Rotation counter — a replayed older generation signals theft (EN-025). */
  readonly gen: number;
}

@Injectable()
export class TokenService {
  private readonly accessSecret: Uint8Array;
  private readonly refreshSecret: Uint8Array;

  constructor(@Inject(ENV) private readonly env: Env) {
    this.accessSecret = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
    this.refreshSecret = new TextEncoder().encode(env.JWT_REFRESH_SECRET);
  }

  async signAccess(claims: AccessTokenClaims): Promise<string> {
    return new SignJWT({ ...claims })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(this.env.JWT_ISSUER)
      .setSubject(claims.sub)
      .setIssuedAt()
      .setExpirationTime(`${this.env.JWT_ACCESS_TTL_SECONDS}s`)
      .sign(this.accessSecret);
  }

  async signRefresh(claims: RefreshTokenClaims): Promise<string> {
    return new SignJWT({ ...claims })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(this.env.JWT_ISSUER)
      .setSubject(claims.sub)
      .setIssuedAt()
      .setExpirationTime(`${this.env.JWT_REFRESH_TTL_SECONDS}s`)
      .sign(this.refreshSecret);
  }

  /**
   * `algorithms` is pinned explicitly. Without it a verifier can be talked into
   * accepting `alg: none` or an asymmetric key confusion — the classic JWT
   * vulnerability, and one that silently turns authentication off.
   */
  async verifyAccess(token: string): Promise<AccessTokenClaims> {
    const { payload } = await jwtVerify(token, this.accessSecret, {
      issuer: this.env.JWT_ISSUER,
      algorithms: ['HS256'],
    });
    return TokenService.asAccessClaims(payload);
  }

  async verifyRefresh(token: string): Promise<RefreshTokenClaims> {
    const { payload } = await jwtVerify(token, this.refreshSecret, {
      issuer: this.env.JWT_ISSUER,
      algorithms: ['HS256'],
    });
    const sub = typeof payload['sub'] === 'string' ? payload['sub'] : '';
    const sid = typeof payload['sid'] === 'string' ? payload['sid'] : '';
    const gen = typeof payload['gen'] === 'number' ? payload['gen'] : -1;
    if (!sub || !sid || gen < 0) throw new Error('Malformed refresh token');
    return { sub, sid, gen };
  }

  private static asAccessClaims(payload: JWTPayload): AccessTokenClaims {
    const str = (k: string): string => {
      const value = payload[k];
      return typeof value === 'string' ? value : '';
    };
    const sub = str('sub');
    const sid = str('sid');
    const hid = str('hid');
    if (!sub || !sid || !hid) throw new Error('Malformed access token');

    const bidRaw = payload['bid'];
    const scopeRaw = payload['scope'];
    const rolesRaw = payload['roles'];
    const amrRaw = payload['amr'];
    const impRaw = payload['imp'];

    // Narrowed explicitly: an inline ternary widens back to `string`, and an
    // unknown scope must fall back to the *narrowest* one, never the widest.
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
}
