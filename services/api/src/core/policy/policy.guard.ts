import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ProblemType } from '@vims/contracts';
import type { FastifyRequest } from 'fastify';
import { AuthService } from '../../modules/platform/auth/auth.service.js';
import { getContext } from '../context/request-context.js';
import { AppError } from '../problem/app-error.js';
import { evaluate } from './policy.engine.js';
import { AUTHENTICATED_ONLY_KEY, PERMISSION_KEY, PUBLIC_KEY } from './permission.decorator.js';

/**
 * Step 6 — RBAC + ABAC, deny by default.
 *
 * A non-public route with no `@Permission()` is treated as a **programming
 * error**, not as an open route. `phase-00 §0.3` requires CI to fail on any route
 * without a permission key; this is the runtime half, so the omission cannot
 * survive to production even if the CI check is skipped.
 */
@Injectable()
export class PolicyGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  async canActivate(execution: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      execution.getHandler(),
      execution.getClass(),
    ]);
    if (isPublic === true) return true;

    const ctxEarly = getContext();

    // Session introspection: authenticated, but no permission key — see the
    // reasoning on `AuthenticatedOnly`. Auth and tenant guards have already run,
    // so reaching here means the session is verified.
    const authenticatedOnly = this.reflector.getAllAndOverride<boolean>(AUTHENTICATED_ONLY_KEY, [
      execution.getHandler(),
      execution.getClass(),
    ]);
    if (authenticatedOnly === true) {
      if (ctxEarly.userId === null || ctxEarly.hospitalId === null) throw AppError.unauthenticated();
      const self = await this.auth.resolvePolicyContext({
        userId: ctxEarly.userId,
        hospitalId: ctxEarly.hospitalId,
        branchId: ctxEarly.branchId,
        sessionId: ctxEarly.sessionId ?? '',
        acr: 'aal1',
        amr: ['pwd'],
        authTimeMs: Date.now(),
        impersonatorUserId: ctxEarly.impersonatorUserId,
        timezone: 'Asia/Kolkata',
        nowMs: Date.now(),
      });
      ctxEarly.grantedBranchIds = self.grantedBranchIds;
      return true;
    }

    const permission = this.reflector.getAllAndOverride<string>(PERMISSION_KEY, [
      execution.getHandler(),
      execution.getClass(),
    ]);
    if (typeof permission !== 'string' || permission.length === 0) {
      throw new AppError(
        ProblemType.INTERNAL_ERROR,
        'This route is not configured with a permission and has been refused.',
      );
    }

    const ctx = getContext();
    if (ctx.userId === null || ctx.hospitalId === null) throw AppError.unauthenticated();

    const request = execution.switchToHttp().getRequest<FastifyRequest>();
    const policyContext = await this.auth.resolvePolicyContext({
      userId: ctx.userId,
      hospitalId: ctx.hospitalId,
      branchId: ctx.branchId,
      sessionId: ctx.sessionId ?? '',
      acr: 'aal1',
      amr: ['pwd'],
      authTimeMs: Date.now(),
      impersonatorUserId: ctx.impersonatorUserId,
      timezone: 'Asia/Kolkata',
      nowMs: Date.now(),
    });

    const reasonHeader = request.headers['x-reason'];
    const reason = typeof reasonHeader === 'string' ? reasonHeader : null;
    ctx.reason = reason;

    const decision = evaluate({
      permission,
      context: policyContext,
      resource: { type: 'route', hospitalId: ctx.hospitalId, branchId: ctx.branchId },
      reason,
      ip: ctx.ip,
    });

    if (!decision.allowed) {
      // A cross-tenant denial must be indistinguishable from a genuine miss, or
      // the API confirms that another hospital's record exists (docs/09 §3.1).
      if (decision.reason === 'tenant_mismatch') throw AppError.notFound('The record');
      throw new AppError(
        decision.reason === 'not_licensed' ? ProblemType.NOT_LICENSED : ProblemType.PERMISSION_DENIED,
        decision.message,
      );
    }

    ctx.grantedBranchIds = policyContext.grantedBranchIds;
    return true;
  }
}
