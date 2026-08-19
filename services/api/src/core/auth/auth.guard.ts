import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { getContext } from '../context/request-context.js';
import { PUBLIC_KEY } from '../policy/permission.decorator.js';
import { AppError } from '../problem/app-error.js';
import { TokenService } from './token.service.js';

/**
 * Step 2 of `docs/01` §3 — and the default.
 *
 * Every route is authenticated unless it carries `@Public()`. Making
 * authentication opt-*out* rather than opt-in means a new controller written in a
 * hurry is closed, not open; the reverse arrangement fails silently and is only
 * discovered by someone who should not have seen the data.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
  ) {}

  async canActivate(execution: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      execution.getHandler(),
      execution.getClass(),
    ]);
    if (isPublic === true) return true;

    const request = execution.switchToHttp().getRequest<FastifyRequest>();
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw AppError.unauthenticated();
    }

    const claims = await this.tokens.verifyAccess(header.slice('Bearer '.length)).catch(() => {
      // The reason a token failed (expired, wrong signature, malformed) is useful
      // to an attacker and useless to a user; it is logged, never returned.
      throw AppError.unauthenticated('Your session has ended. Please sign in again.');
    });

    const ctx = getContext();
    ctx.userId = claims.sub;
    ctx.sessionId = claims.sid;
    ctx.hospitalId = claims.hid;
    ctx.branchId = claims.bid;
    ctx.scope = claims.scope === 'entity' ? 'hospital' : claims.scope;
    ctx.roleKeys = claims.roles;
    ctx.impersonatorUserId = claims.imp ?? null;

    return true;
  }
}
