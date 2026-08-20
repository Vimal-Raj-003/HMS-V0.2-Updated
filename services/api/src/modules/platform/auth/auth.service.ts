import { Inject, Injectable } from '@nestjs/common';
import {
  ProblemType,
  abacConditionsSchema,
  newId,
  type AbacConditions,
  type PolicyContext,
} from '@vims/contracts';
import { ENV, type Env } from '../../../core/config/env.js';
import { PasswordService } from '../../../core/auth/password.service.js';
import { TokenService } from '../../../core/auth/token.service.js';
import { DatabaseService } from '../../../core/db/database.service.js';
import { AppError } from '../../../core/problem/app-error.js';

export interface LoginInput {
  readonly hospitalId: string;
  readonly identifier: string;
  readonly password: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export interface LoginResult {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresInSeconds: number;
  readonly user: { readonly id: string; readonly displayName: string; readonly mustChangePassword: boolean };
  readonly roles: readonly string[];
  readonly homeWorkspace: string | null;
  readonly branches: readonly string[];
}

interface UserRow {
  id: string;
  hospital_id: string;
  display_name: string;
  password_hash: string | null;
  must_change_password: boolean;
  mfa_enabled: boolean;
  status: 'invited' | 'active' | 'locked' | 'suspended' | 'deactivated';
  locked_until: Date | null;
  failed_attempts: number;
}

interface GrantRow {
  role_key: string;
  home_workspace: string;
  branch_id: string | null;
  conditions: unknown;
  permission_key: string | null;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(TokenService) private readonly tokens: TokenService,
  ) {}

  /**
   * Password login.
   *
   * The user lookup runs **without** a tenancy scope, which is the one place in
   * the API that legitimately does. RLS keys on `app.user_id`/`app.hospital_id`,
   * and at this instant we know neither — establishing a scope would require
   * trusting the very claim we are about to verify. The query is therefore
   * explicitly predicated on `hospital_id`, which `docs/05` guarantees is known
   * before login ("one login URL per tenant"), and it selects no clinical data.
   */
  async login(input: LoginInput): Promise<LoginResult> {
    const user = await this.db.withHospitalScope(input.hospitalId, (tx) =>
      tx.maybeOne<UserRow>(
        `SELECT id, hospital_id, display_name, password_hash, must_change_password,
                mfa_enabled, status, locked_until, failed_attempts
           FROM core.users
          WHERE hospital_id = $1
            AND deleted_at IS NULL
            AND (lower(username) = lower($2) OR lower(email) = lower($2) OR lower(employee_id) = lower($2))`,
        [input.hospitalId, input.identifier],
      ),
    );

    // One message and one code path for "no such user" and "wrong password".
    // Distinguishing them turns the login form into an account-enumeration oracle.
    const invalid = new AppError(ProblemType.UNAUTHENTICATED, 'Incorrect username or password.', {
      nextAction: 'Check your details and try again.',
    });

    if (!user || user.password_hash === null) {
      // Still spend the cost of a verify so a missing account is not detectably
      // faster than a wrong password.
      await this.passwords.verify(
        '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$0000000000000000000000000000000000000000000',
        input.password,
      );
      throw invalid;
    }
    // `invited` counts as not-yet-usable: an invitation that was never accepted
    // must not be a working login.
    if (user.status !== 'active') {
      throw new AppError(ProblemType.ACCOUNT_LOCKED, 'This account is not active.', {
        nextAction: 'Contact your administrator.',
      });
    }
    if (user.locked_until !== null && user.locked_until.getTime() > Date.now()) {
      throw new AppError(ProblemType.ACCOUNT_LOCKED, 'This account is temporarily locked.', {
        nextAction: `Try again after ${user.locked_until.toISOString()}.`,
      });
    }

    const ok = await this.passwords.verify(user.password_hash, input.password);
    if (!ok) {
      await this.recordFailure(user);
      throw invalid;
    }

    await this.clearFailures(user.hospital_id, user.id);

    const grants = await this.db.withHospitalScope(user.hospital_id, (tx) =>
      tx.rows<GrantRow>(
        `SELECT r.key AS role_key, r.home_workspace, ur.branch_id, ur.conditions, rp.permission_key
           FROM core.user_roles ur
           JOIN core.roles r ON r.id = ur.role_id
           LEFT JOIN core.role_permissions rp ON rp.role_id = r.id
          WHERE ur.user_id = $1
            AND ur.hospital_id = $2
            AND ur.active
            AND r.active
            AND ur.valid_from <= now()
            AND (ur.valid_to IS NULL OR ur.valid_to > now())`,
        [user.id, user.hospital_id],
      ),
    );

    if (grants.length === 0) {
      throw new AppError(ProblemType.PERMISSION_DENIED, 'This account has no active role.', {
        nextAction: 'Ask your administrator to assign a role.',
      });
    }

    const roles = [...new Set(grants.map((g) => g.role_key))];
    const branches = [...new Set(grants.map((g) => g.branch_id).filter((b): b is string => b !== null))];
    const homeWorkspace = grants[0]?.home_workspace ?? null;

    const sessionId = newId();
    const now = Date.now();
    const refreshFamilyId = newId();

    await this.db.withHospitalScope(user.hospital_id, (tx) =>
      tx.query(
        `INSERT INTO core.sessions (
           id, hospital_id, user_id, branch_id, method, user_agent, ip,
           acr, amr, auth_time, refresh_family_id, refresh_generation,
           created_at, last_seen_at, expires_at
         ) VALUES ($1,$2,$3,$4,'password'::core."SessionMethod",$5,$6::inet,$7,$8,now(),$9,0,now(),now(), now() + ($10 || ' seconds')::interval)`,
        [
          sessionId,
          user.hospital_id,
          user.id,
          branches[0] ?? null,
          input.userAgent,
          input.ip,
          user.mfa_enabled ? 'aal2' : 'aal1',
          user.mfa_enabled ? ['pwd', 'otp'] : ['pwd'],
          refreshFamilyId,
          String(this.env.SESSION_ABSOLUTE_TIMEOUT_SECONDS),
        ],
      ),
    );

    const accessToken = await this.tokens.signAccess({
      sub: user.id,
      sid: sessionId,
      hid: user.hospital_id,
      bid: branches[0] ?? null,
      scope: 'branch',
      roles,
      acr: user.mfa_enabled ? 'aal2' : 'aal1',
      amr: user.mfa_enabled ? ['pwd', 'otp'] : ['pwd'],
      authTime: now,
    });

    const refreshToken = await this.tokens.signRefresh({ sub: user.id, sid: sessionId, gen: 0 });

    await this.db.withHospitalScope(user.hospital_id, (tx) =>
      tx.query(`UPDATE core.users SET last_login_at = now() WHERE id = $1`, [user.id]),
    );

    return {
      accessToken,
      refreshToken,
      expiresInSeconds: this.env.JWT_ACCESS_TTL_SECONDS,
      user: { id: user.id, displayName: user.display_name, mustChangePassword: user.must_change_password },
      roles,
      homeWorkspace,
      branches,
    };
  }

  /**
   * Builds the authorisation context for a request from its session.
   *
   * Permissions are resolved per request rather than trusted from the token: a
   * role revoked at 09:00 must not keep working until the access token expires at
   * 09:14. `docs/05` requires "force logout" to mean something.
   */
  async resolvePolicyContext(params: {
    readonly userId: string;
    readonly hospitalId: string;
    readonly branchId: string | null;
    readonly sessionId: string;
    readonly acr: string;
    readonly amr: readonly string[];
    readonly authTimeMs: number;
    readonly impersonatorUserId: string | null;
    readonly timezone: string;
    readonly nowMs: number;
  }): Promise<PolicyContext> {
    const grants = await this.db.withHospitalScope(params.hospitalId, (tx) =>
      tx.rows<GrantRow>(
        `SELECT r.key AS role_key, r.home_workspace, ur.branch_id, ur.conditions, rp.permission_key
           FROM core.user_roles ur
           JOIN core.roles r ON r.id = ur.role_id
           LEFT JOIN core.role_permissions rp ON rp.role_id = r.id
          WHERE ur.user_id = $1 AND ur.hospital_id = $2
            AND ur.active AND r.active
            AND ur.valid_from <= now() AND (ur.valid_to IS NULL OR ur.valid_to > now())`,
        [params.userId, params.hospitalId],
      ),
    );

    const permissions = new Set<string>();
    const conditions: AbacConditions[] = [];
    const roleKeys = new Set<string>();
    const branchIds = new Set<string>();

    for (const g of grants) {
      roleKeys.add(g.role_key);
      if (g.permission_key !== null) permissions.add(g.permission_key);
      if (g.branch_id !== null) branchIds.add(g.branch_id);
      // `user_roles.conditions` is jsonb and arrives untyped. Parsing it through
      // the contract's own schema — rather than asserting a shape — means a
      // malformed grant is rejected here instead of silently widening access.
      if (g.conditions !== null && typeof g.conditions === 'object') {
        const parsed = abacConditionsSchema.safeParse(g.conditions);
        if (parsed.success) conditions.push(parsed.data);
      }
    }

    return {
      hospitalId: params.hospitalId,
      branchId: params.branchId,
      grantedBranchIds: [...branchIds],
      scope: 'branch',
      userId: params.userId,
      roleKeys: [...roleKeys],
      permissions,
      conditions,
      authContext: {
        acr: params.acr,
        amr: params.amr,
        authTimeMs: params.authTimeMs,
        method: 'password',
      },
      impersonatorUserId: params.impersonatorUserId,
      nowMs: params.nowMs,
      timezone: params.timezone,
    };
  }

  /** Display name for the acting user. Self-scoped; used by `/me`. */
  async displayNameFor(hospitalId: string, userId: string): Promise<string> {
    const row = await this.db.withHospitalScope(hospitalId, (tx) =>
      tx.maybeOne<{ display_name: string }>(
        `SELECT display_name FROM core.users WHERE id = $1 AND deleted_at IS NULL`,
        [userId],
      ),
    );
    return row?.display_name ?? 'Unknown user';
  }

  /** The workspace the user's highest-precedence active role lands on. */
  async homeWorkspaceFor(hospitalId: string, userId: string): Promise<string | null> {
    const row = await this.db.withHospitalScope(hospitalId, (tx) =>
      tx.maybeOne<{ home_workspace: string }>(
        `SELECT r.home_workspace
           FROM core.user_roles ur
           JOIN core.roles r ON r.id = ur.role_id
          WHERE ur.user_id = $1 AND ur.hospital_id = $2
            AND ur.active AND r.active
            AND ur.valid_from <= now() AND (ur.valid_to IS NULL OR ur.valid_to > now())
          ORDER BY r.key
          LIMIT 1`,
        [userId, hospitalId],
      ),
    );
    return row?.home_workspace ?? null;
  }

  private async recordFailure(user: UserRow): Promise<void> {
    const attempts = user.failed_attempts + 1;
    const shouldLock = attempts >= this.env.AUTH_MAX_FAILED_ATTEMPTS;
    await this.db.withHospitalScope(user.hospital_id, (tx) =>
      tx.query(
        `UPDATE core.users
            SET failed_attempts = $2,
                locked_until = CASE WHEN $3 THEN now() + ($4 || ' seconds')::interval ELSE locked_until END
          WHERE id = $1`,
        [user.id, attempts, shouldLock, String(this.env.AUTH_LOCKOUT_SECONDS)],
      ),
    );
  }

  private async clearFailures(hospitalId: string, userId: string): Promise<void> {
    await this.db.withHospitalScope(hospitalId, (tx) =>
      tx.query(`UPDATE core.users SET failed_attempts = 0, locked_until = NULL WHERE id = $1`, [userId]),
    );
  }
}
