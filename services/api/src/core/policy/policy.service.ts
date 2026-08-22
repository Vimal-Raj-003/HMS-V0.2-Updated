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
 *
 * **Second-person actions can only be asserted here.** A key marked
 * `requiresSecondPerson` — paying a refund, voiding a receipt, prescribing a
 * Schedule X drug, clearing a CDSS hard stop — is denied by the engine unless it
 * is handed a co-signer who is a *different* user. A route decorator has nobody
 * to hand it, because the co-signer is established by the request body, so a
 * route carrying such a key denies every caller including the one entitled to
 * act. Two modules hit that and each worked around it locally; `options.onBehalf`
 * is the shared way through, and it is deliberately a separate argument rather
 * than part of `resource`, so a caller cannot supply one by accident.
 */
export interface AssertOptions {
  /**
   * The co-signer for a `requiresSecondPerson` key. Must be a different, active
   * user who holds the same key themselves — the caller establishes that (by
   * authenticating them) before asking; this only carries the identity.
   */
  readonly secondPersonUserId?: string;
}

@Injectable()
export class PolicyService {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  async assert(
    permission: string,
    resource: Omit<Partial<PolicyResource>, 'type'> = {},
    options: AssertOptions = {},
  ): Promise<void> {
    const ctx = getContext();
    if (ctx.userId === null || ctx.hospitalId === null) throw AppError.unauthenticated();

    // The engine refuses a co-signer identical to the actor, but catching it
    // here names the problem: "you cannot countersign your own action" is
    // actionable, where a bare permission denial sends somebody looking at
    // their roles.
    if (options.secondPersonUserId !== undefined && options.secondPersonUserId === ctx.userId) {
      throw new AppError(
        ProblemType.PERMISSION_DENIED,
        'A second, different authorised user must confirm this action — you cannot countersign your own.',
      );
    }

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
      ...(options.secondPersonUserId === undefined ? {} : { secondPersonUserId: options.secondPersonUserId }),
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
