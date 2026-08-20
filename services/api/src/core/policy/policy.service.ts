import { Inject, Injectable } from '@nestjs/common';
import { ProblemType, type PolicyResource } from '@vims/contracts';
import { AuthService } from '../../modules/platform/auth/auth.service.js';
import { getContext } from '../context/request-context.js';
import { AppError } from '../problem/app-error.js';
import { evaluate } from './policy.engine.js';

/**
 * A second policy check, inside a service, for the cases one route decorator
 * cannot express.
 *
 * `@Permission()` declares the *primary* authority a route needs, and the guard
 * enforces it before the handler runs. But some requests do two things at once:
 * `POST /admin/users` creates an account **and** grants it roles, and `docs/05`
 * §Segregation of duties treats those as different authorities on purpose —
 * `admin.role.assign` is `sensitiveGrant`, step-up and reason-required, while
 * `admin.user.create` is none of those. A route decorated only with the weaker
 * key would let a user-administrator mint themselves an approver.
 *
 * So the handler asks again for the second key. It runs the same engine, against
 * the same freshly-resolved context, and produces the same problem types — this
 * is not a parallel authorisation path, it is the same one called twice.
 */
@Injectable()
export class PolicyService {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  async assert(permission: string, resource: Omit<Partial<PolicyResource>, 'type'> = {}): Promise<void> {
    const ctx = getContext();
    if (ctx.userId === null || ctx.hospitalId === null) throw AppError.unauthenticated();

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

    const decision = evaluate({
      permission,
      context: policyContext,
      resource: { type: 'route', hospitalId: ctx.hospitalId, branchId: ctx.branchId, ...resource },
      reason: ctx.reason,
      ip: ctx.ip,
    });

    if (decision.allowed) return;

    // Same rule as the guard: a cross-tenant denial must be indistinguishable
    // from a genuine miss, or the API confirms another hospital's record exists
    // (docs/09 §3.1).
    if (decision.reason === 'tenant_mismatch') throw AppError.notFound('The record');
    throw new AppError(
      decision.reason === 'not_licensed' ? ProblemType.NOT_LICENSED : ProblemType.PERMISSION_DENIED,
      decision.message,
    );
  }
}
