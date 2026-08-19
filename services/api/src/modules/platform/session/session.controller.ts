import { Controller, Get, Inject, Injectable } from '@nestjs/common';
import { getContext } from '../../../core/context/request-context.js';
import { AuthenticatedOnly } from '../../../core/policy/permission.decorator.js';
import { AuthService } from '../auth/auth.service.js';
import { AppError } from '../../../core/problem/app-error.js';

export interface SessionSummary {
  readonly user: { readonly id: string; readonly displayName: string };
  readonly hospitalId: string;
  readonly branchId: string | null;
  readonly branches: readonly string[];
  readonly roles: readonly string[];
  /** Every permission key the session currently holds. */
  readonly permissions: readonly string[];
  readonly homeWorkspace: string | null;
}

/**
 * Session introspection.
 *
 * The front end needs this to build the navigation, because `docs/06` §4.1 is
 * categorical: an item the user cannot use is **never rendered**. Greying it out
 * teaches staff to hunt for a workaround, and in a hospital the workaround is
 * usually somebody else's password.
 *
 * Permissions are resolved from the database on every call rather than read out
 * of the token. A role revoked at 09:00 must stop working at 09:00, not when the
 * 15-minute access token happens to expire — `docs/05` requires "force logout"
 * to mean something.
 */
@Injectable()
export class SessionService {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  async summary(): Promise<SessionSummary> {
    const ctx = getContext();
    if (ctx.userId === null || ctx.hospitalId === null) throw AppError.unauthenticated();

    const policy = await this.auth.resolvePolicyContext({
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

    const displayName = await this.auth.displayNameFor(ctx.hospitalId, ctx.userId);

    return {
      user: { id: ctx.userId, displayName },
      hospitalId: ctx.hospitalId,
      branchId: ctx.branchId,
      branches: policy.grantedBranchIds,
      roles: policy.roleKeys,
      // Sorted so the response is stable and diffable in a snapshot test.
      permissions: [...policy.permissions].sort(),
      homeWorkspace: await this.auth.homeWorkspaceFor(ctx.hospitalId, ctx.userId),
    };
  }
}

@Controller('me')
export class SessionController {
  constructor(@Inject(SessionService) private readonly session: SessionService) {}

  /**
   * Returns only the calling session — it accepts no identifier, so it cannot be
   * used to ask about another user. That constraint is what makes
   * `@AuthenticatedOnly()` safe here.
   */
  @AuthenticatedOnly()
  @Get()
  async me(): Promise<SessionSummary> {
    return this.session.summary();
  }
}
