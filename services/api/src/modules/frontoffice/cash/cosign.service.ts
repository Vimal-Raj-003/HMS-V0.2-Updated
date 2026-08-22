import { Inject, Injectable } from '@nestjs/common';
import { ProblemType, type PolicyResource } from '@vims/contracts';
import { PasswordService } from '../../../core/auth/password.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService } from '../../../core/db/database.service.js';
import { evaluate } from '../../../core/policy/policy.engine.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import { AuthService } from '../../platform/auth/auth.service.js';
import type { CoSignerInput } from './cash.schemas.js';

/**
 * Second-person authorisation for the two money-out actions (NC-001 §5,
 * docs/05 §Segregation of duties, docs/06 §6.9 friction level 6).
 *
 * `receipt.void` and `receipt.refund.pay` are flagged `requiresSecondPerson` in
 * the permission catalogue. The policy engine honours that flag — and denies
 * unless `secondPersonUserId` is supplied — but the global `PolicyGuard` calls
 * `evaluate()` with no co-signer, because a route decorator has no way to carry
 * one. **A route decorated with either key is therefore refused for everybody,
 * always.**
 *
 * So these two routes are decorated with `receipt.collect` — the counter-operation
 * key every actor in the flow holds, and a genuine precondition: you cannot pay
 * money out of a drawer you are not operating — and the *real* authority is
 * asserted here, through the same engine, with the co-signer attached. This is
 * the same shape `UsersService.create` uses when it asserts `admin.role.assign`
 * beyond its route key; it is not a parallel authorisation path.
 *
 * Three things must hold before the money moves:
 *
 *  1. the co-signer authenticates (their own credential, verified here);
 *  2. the co-signer is a **different, active** user who themselves holds the
 *     permission — a second pair of eyes that is not authorised to approve is
 *     not a control;
 *  3. the acting user passes the full policy evaluation for the permission with
 *     that co-signer supplied, so the reason requirement, the ABAC amount limit
 *     and the branch scope are all still checked.
 *
 * What is deliberately **not** here: PIN and TOTP co-signing. `docs/06 §6.9`
 * allows either, but neither has a verifier in `services/api` yet, and accepting
 * the field while ignoring the factor would be worse than refusing it.
 */
@Injectable()
export class CoSignService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  /** Returns the co-signer's user id once the action is authorised. */
  async authorise(
    permission: string,
    coSigner: CoSignerInput,
    resource: Omit<Partial<PolicyResource>, 'type'> = {},
  ): Promise<string> {
    const ctx = getContext();
    if (ctx.userId === null || ctx.hospitalId === null) throw AppError.unauthenticated();

    if (coSigner.credentialKind !== 'password') {
      throw new AppError(
        ProblemType.NOT_IMPLEMENTED,
        `Co-signing by ${coSigner.credentialKind} is not available yet; the second person must use their password.`,
      );
    }

    const second = await this.db.withTenant(currentTenantContext(), (tx) =>
      tx.maybeOne<{ id: string; username: string; password_hash: string | null; status: string }>(
        `SELECT id, username, password_hash, status::text AS status
           FROM core.users
          WHERE lower(username) = lower($1) AND deleted_at IS NULL`,
        [coSigner.identifier],
      ),
    );

    // Every failure below returns the same problem and the same wording. A
    // co-sign prompt that distinguishes "no such user" from "wrong password"
    // from "not authorised" is a staff-directory oracle sitting on a screen that
    // is, by design, operated in front of a queue of patients.
    // The explicit `() => never` annotation is what lets TypeScript narrow after
    // a call: without it the compiler does not know the call cannot return.
    const refuse: () => never = () => {
      throw new AppError(
        ProblemType.SECOND_PERSON_REQUIRED,
        'The second person could not be verified. A different, authorised user must confirm this action.',
        { nextAction: 'Ask a supervisor who holds this authority to sign in on this screen.' },
      );
    };

    if (second === undefined || second.password_hash === null || second.status !== 'active') refuse();
    if (second.id === ctx.userId) {
      throw new AppError(
        ProblemType.SEGREGATION_OF_DUTIES,
        'The same person cannot be both the actor and the second authoriser.',
      );
    }
    if (!(await this.passwords.verify(second.password_hash, coSigner.credential))) refuse();

    const secondContext = await this.auth.resolvePolicyContext({
      userId: second.id,
      hospitalId: ctx.hospitalId,
      branchId: ctx.branchId,
      sessionId: '',
      acr: 'aal1',
      amr: ['pwd'],
      authTimeMs: Date.now(),
      impersonatorUserId: null,
      timezone: 'Asia/Kolkata',
      nowMs: Date.now(),
    });
    if (!secondContext.permissions.has(permission)) refuse();

    const actorContext = await this.auth.resolvePolicyContext({
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
      context: actorContext,
      resource: { type: 'route', hospitalId: ctx.hospitalId, branchId: ctx.branchId, ...resource },
      reason: ctx.reason,
      secondPersonUserId: second.id,
      ip: ctx.ip,
    });

    if (!decision.allowed) {
      // Same rule as the guard: a cross-tenant denial is a 404, never a 403
      // (docs/09 §3.1).
      if (decision.reason === 'tenant_mismatch') throw AppError.notFound('The record');
      if (decision.reason === 'reason_required') {
        throw new AppError(ProblemType.VALIDATION_FAILED, decision.message, {
          nextAction: 'Send the action again with an `x-reason` header explaining it.',
        });
      }
      throw new AppError(ProblemType.PERMISSION_DENIED, decision.message, {
        nextAction: `This action needs the "${permission}" authority, which is held by a supervisor.`,
      });
    }

    return second.id;
  }
}
