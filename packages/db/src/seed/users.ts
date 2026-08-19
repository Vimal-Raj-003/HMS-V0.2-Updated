import { hash as argon2Hash, argon2id } from 'argon2';
import { ROLE_TEMPLATES } from '@vims/contracts';
import type { SeedContext } from './context.js';
import { SEED_EPOCH, seedId } from './ids.js';
import { jsonb, type SeedRow } from './upsert.js';
import { mainBranchOf, type SeededHospital, type SeededTenancy } from './tenancy.js';

/**
 * One user per role, in each of the two demo hospitals (`phase-00 §0.2`:
 * "one user per role with a known dev password").
 *
 * Both hospitals get the full set rather than only the first, because the
 * mandatory Phase-0 tests are the permission matrix ("every route × every role")
 * *and* tenant isolation ("a user of hospital A cannot read hospital B"). The
 * second needs a same-role counterpart on the other side of the boundary,
 * otherwise a passing test only proves hospital B was empty.
 *
 * The dev password is printed by `run.ts` and is deliberately obvious. It is
 * only ever installed by a seed, and `docs/04 §2` password policy applies to
 * real accounts created through the API.
 */
export const DEV_PASSWORD = 'VimsDev#2026';

/**
 * `docs/04 §2`: "Argon2id (memory ≥ 64 MB, t=3)". These are the parameters the
 * auth service will use; the seed uses the same ones so a seeded account is
 * indistinguishable from a real one to the verifier.
 */
const ARGON2_OPTIONS = {
  type: argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
} as const;

export interface SeededUser {
  readonly id: string;
  readonly hospital: SeededHospital;
  readonly roleKey: string;
  readonly username: string;
}

export function demoUsers(tenancy: SeededTenancy): readonly SeededUser[] {
  const users: SeededUser[] = [];
  for (const hospital of tenancy.hospitals) {
    for (const template of ROLE_TEMPLATES) {
      const username = `${template.key}@${hospital.code.toLowerCase()}`;
      users.push({
        id: seedId('user', hospital.code, template.key),
        hospital,
        roleKey: template.key,
        username,
      });
    }
  }
  return users;
}

export async function seedUsers(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  // Hashed once per run, not once per user. Argon2id at 64 MB costs ~100 ms;
  // 128 of them would add 13 s to every seed for no security benefit, since
  // every account shares the same known development password anyway. The hash
  // is also listed as `immutable` below, so a re-run never rewrites it — which
  // is what keeps the seed byte-stable despite Argon2's random salt.
  const passwordHash = await argon2Hash(DEV_PASSWORD, ARGON2_OPTIONS);

  const users: SeedRow[] = [];
  const assignments: SeedRow[] = [];
  const access: SeedRow[] = [];

  for (const user of demoUsers(tenancy)) {
    const template = ROLE_TEMPLATES.find((t) => t.key === user.roleKey);
    if (template === undefined) continue;
    const hospital = user.hospital;
    const main = mainBranchOf(hospital);
    const roleId = seedId('role-template', template.key);
    const displayName = `${template.name} (${hospital.code})`;

    users.push({
      id: user.id,
      hospital_id: hospital.id,
      group_id: tenancy.groupId,
      username: user.username,
      email: `${template.key}.${hospital.code.toLowerCase()}@demo.vims.local`,
      // Synthetic, in the reserved 999-prefixed test range so it can never
      // reach a real handset (docs/09 §11: never real data).
      mobile: `+9199900${String(10_000 + seedIndexOf(template.key)).slice(-5)}`,
      name: { family: 'Demo', given: template.name },
      display_name: displayName.slice(0, 200),
      employee_id: `EMP-${hospital.code}-${String(template.docsRow).padStart(3, '0')}`,
      type: template.category === 'external' ? 'external' : template.category === 'device' ? 'device' : 'staff',
      status: 'active',
      password_hash: passwordHash,
      password_changed_at: SEED_EPOCH,
      must_change_password: false,
      // docs/04 §2 makes TOTP mandatory for admin/finance/pharmacy-narcotics/
      // blood bank/MRD-export/privacy roles. The seed records the requirement;
      // enrolment happens at first login, so no secret is seeded.
      mfa_enabled: false,
      mfa_methods: jsonb([]),
      mfa_secret_encrypted: null,
      recovery_codes_hash: [],
      pin_hash: null,
      sso_subject: null,
      professional:
        template.category === 'medical'
          ? {
              registrationNo: `KMC/DEMO/${String(template.docsRow).padStart(4, '0')}`,
              council: 'Karnataka Medical Council',
              speciality: template.name,
            }
          : {},
      preferences: { locale: 'en-IN', theme: 'system' },
      photo_file_id: null,
      last_login_at: null,
      failed_attempts: 0,
      locked_until: null,
      deleted_at: null,
      deactivated_at: null,
      deactivation_reason: null,
      created_at: SEED_EPOCH,
      created_by: null,
      updated_at: SEED_EPOCH,
      updated_by: null,
      version: 0,
    });

    assignments.push({
      id: seedId('user-role', hospital.code, template.key),
      hospital_id: hospital.id,
      user_id: user.id,
      role_id: roleId,
      branch_id: main.id,
      scope: jsonb({}),
      conditions: jsonb(template.abacDefaults),
      valid_from: SEED_EPOCH,
      valid_to: null,
      granted_by: null,
      approval_id: null,
      active: true,
      source: 'manual',
      created_at: SEED_EPOCH,
      updated_at: SEED_EPOCH,
      version: 0,
    });

    for (const b of hospital.branches) {
      access.push({
        id: seedId('branch-access', hospital.code, template.key, b.code),
        hospital_id: hospital.id,
        user_id: user.id,
        branch_id: b.id,
        roles: [template.key],
        scope: 'branch',
        is_primary: b.isMain,
        // A fixed instant matters here: `org_user_branch_access` carries a
        // btree_gist exclusion constraint on overlapping ranges per
        // (user, branch), so a moving `from_at` would make a re-run collide
        // with its own previous grant.
        from_at: SEED_EPOCH,
        to_at: null,
        granted_by: null,
        reason: 'Seeded demo access.',
        created_at: SEED_EPOCH,
        updated_at: SEED_EPOCH,
        version: 0,
      });
    }
  }

  await ctx.write({ table: 'core.users', conflict: ['id'], immutable: ['password_hash', 'password_changed_at'] }, users);
  await ctx.write({ table: 'core.user_roles', conflict: ['id'] }, assignments);
  await ctx.write({ table: 'core.org_user_branch_access', conflict: ['id'] }, access);
}

function seedIndexOf(roleKey: string): number {
  return ROLE_TEMPLATES.findIndex((t) => t.key === roleKey) + 1;
}
