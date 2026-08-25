import { Inject, Injectable } from '@nestjs/common';
import { ProblemType } from '@vims/contracts';
import argon2 from 'argon2';
import { DatabaseService } from '../../core/db/database.service.js';
import { getContext } from '../../core/context/request-context.js';
import { PolicyService } from '../../core/policy/policy.service.js';
import { AppError } from '../../core/problem/app-error.js';
import { currentTenantContext } from '../../core/tenancy/tenant-context.js';
import type { CoSignerInput } from './pharmacy.schemas.js';

/**
 * Second-person authorisation for the four NDPS keys — `docs/04 §1` ("NDPS
 * narcotic register with dual authorisation"), `phase-04` exit gate 4
 * ("Narcotic issue requires two users").
 *
 * ── Why this exists at all ──────────────────────────────────────────────────
 *
 * `pharmacy.narcotic.dispense`, `.issue`, `.custody` and `.destroy` are all
 * flagged `requiresSecondPerson` in the permission catalogue. The policy engine
 * honours that flag and denies unless a co-signer is supplied — and
 * `PolicyGuard` calls it with none, because a route decorator has nowhere to
 * carry one. `core/policy/permission.decorator.ts` now throws at module load if
 * one of those keys is used as a decorator, precisely so this cannot be
 * discovered in production.
 *
 * So the routes are decorated with `pharmacy.narcotic.prepare` — the
 * single-signature "open a controlled-drug transaction" authority one pharmacist
 * genuinely holds, and a real precondition: you cannot present a controlled
 * transaction for signature if you may not open one — and the *real* authority
 * is asserted here, through the same engine, with the co-signer attached. This
 * is the shape `frontoffice/cash/cosign.service.ts` established; it is not a
 * parallel authorisation path.
 *
 * ── The three things that must hold ─────────────────────────────────────────
 *
 *  1. the co-signer authenticates with **their own** credential, verified here;
 *  2. they are a different, active user who themselves holds the permission —
 *     a second pair of eyes that is not authorised to approve is not a control;
 *  3. the acting user passes the full policy evaluation for that key with the
 *     co-signer supplied, so step-up, reason and branch scope are all still
 *     checked. `PolicyService.assert` is what does that, and it is the same
 *     engine the guard runs.
 *
 * ── Why the failures are indistinguishable ──────────────────────────────────
 *
 * "No such user", "wrong password" and "not authorised" all return the same
 * problem and the same sentence. A co-sign prompt that told them apart is a
 * staff-directory oracle sitting on a screen operated in front of a queue.
 *
 * ── What is deliberately not here ───────────────────────────────────────────
 *
 * PIN and TOTP co-signing. `docs/06 §6.9` allows either; neither has a verifier
 * in `services/api`, and accepting the field while ignoring the factor would be
 * worse than refusing it.
 */
@Injectable()
export class PharmacyCoSignService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(PolicyService) private readonly policy: PolicyService,
  ) {}

  /** Returns the co-signer's user id once the action is authorised. */
  async authorise(permission: string, coSigner: CoSignerInput): Promise<string> {
    const ctx = getContext();
    if (ctx.userId === null || ctx.hospitalId === null) throw AppError.unauthenticated();

    if (coSigner.credentialKind !== 'password') {
      throw new AppError(
        ProblemType.NOT_IMPLEMENTED,
        `Co-signing by ${coSigner.credentialKind} is not available yet; the second pharmacist must use their password.`,
      );
    }

    const second = await this.db.withTenant(currentTenantContext(), (tx) =>
      tx.maybeOne<{ id: string; password_hash: string | null; status: string }>(
        `SELECT id, password_hash, status::text AS status
           FROM core.users
          WHERE lower(username) = lower($1) AND deleted_at IS NULL`,
        [coSigner.identifier],
      ),
    );

    const refuse: () => never = () => {
      throw new AppError(
        ProblemType.SECOND_PERSON_REQUIRED,
        'The second pharmacist could not be verified. A different, authorised pharmacist must confirm this controlled-drug transaction.',
        { nextAction: 'Ask a second authorised pharmacist to sign in on this screen.' },
      );
    };

    if (second === undefined || second.password_hash === null || second.status !== 'active') refuse();
    if (second.id === ctx.userId) {
      throw new AppError(
        ProblemType.SEGREGATION_OF_DUTIES,
        'The same person cannot be both the dispensing and the authorising pharmacist. Two signatures from one person are one signature.',
      );
    }
    if (!(await verify(second.password_hash, coSigner.credential))) refuse();

    // The co-signer must hold the authority themselves. Read through their own
    // grants rather than assumed from a role name: a role can be renamed, and a
    // permission cannot.
    const holds = await this.db.withTenant(currentTenantContext(), (tx) =>
      tx.maybeOne<{ ok: boolean }>(
        `SELECT true AS ok
           FROM core.user_roles ur
           JOIN core.roles r ON r.id = ur.role_id
           JOIN core.role_permissions rp ON rp.role_id = r.id
          WHERE ur.user_id = $1 AND ur.hospital_id = $2 AND rp.permission_key = $3
            AND ur.active AND r.active
            AND ur.valid_from <= now() AND (ur.valid_to IS NULL OR ur.valid_to > now())
          LIMIT 1`,
        [second.id, ctx.hospitalId, permission],
      ),
    );
    if (holds === undefined) refuse();

    // The acting user's own evaluation, with the co-signer attached. This is
    // where the `requiresSecondPerson` flag is finally satisfied rather than
    // worked around.
    await this.policy.assert(permission, {}, { secondPersonUserId: second.id });

    return second.id;
  }
}

/**
 * Returns `false` rather than throwing on a malformed stored hash: a corrupt row
 * must not become a 500 that confirms the account exists.
 */
async function verify(storedHash: string, plaintext: string): Promise<boolean> {
  try {
    return await argon2.verify(storedHash, plaintext);
  } catch {
    return false;
  }
}
