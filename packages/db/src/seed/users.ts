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
  /** 1-based. Seat 1 keeps the bare `<role>@<hospital>` username. */
  readonly seat: number;
  readonly personName: string;
}

/**
 * How many people a hospital actually has doing each job.
 *
 * One account per role was enough to prove a permission and useless for
 * anything else: a ward with one nurse cannot hand over, two nurses cannot
 * countersign each other, and a rule that says "a second person witnesses this"
 * cannot be exercised at all. Every role that works a rota or takes part in a
 * two-person check gets three; the desks that are genuinely one person get one.
 *
 * `super_admin` stays at one on purpose. It is the SaaS operator's account, not
 * a hospital job, and more of them is more ways in rather than more capacity.
 */
const SEATS: Readonly<Record<string, number>> = {
  // The wards and clinics — rotas, handovers, and the two-person checks that
  // need two people who are not the same person.
  nurse_ward: 3,
  nurse_opd: 3,
  nurse_icu: 3,
  nurse_er_triage: 2,
  nurse_ot_scrub: 2,
  doctor_consultant_opd: 3,
  doctor_ip: 3,
  doctor_emergency: 2,
  surgeon: 2,
  anaesthetist: 2,
  resident_doctor: 2,

  // The desks and the back office.
  receptionist: 3,
  cashier: 3,
  billing_executive: 2,
  hospital_admin: 2,
  branch_admin: 2,

  // Diagnostics and pharmacy — a maker and a checker are two people.
  lab_technician: 3,
  phlebotomist: 2,
  radiology_technician: 2,
  pharmacist_op: 3,
  pharmacist_ip: 3,

  // Facilities and the floor.
  housekeeping: 3,
  ward_attendant: 2,
  security_officer: 2,

  // The portal side.
  patient: 3,
  family_attendant: 2,
};

/**
 * Names, so a login list reads like a hospital rather than a fixture.
 *
 * Deliberately ordinary Indian names in the hospital's own region, and
 * deliberately not the names of any real staff — `docs/09` §11 is explicit that
 * a seed never carries real data.
 */
const SEAT_NAMES: readonly (readonly [string, string])[] = [
  ['Anita', 'Rao'],
  ['Suresh', 'Kulkarni'],
  ['Fatima', 'Sheikh'],
  ['Rajesh', 'Naik'],
  ['Divya', 'Menon'],
];

function seatName(roleKey: string, seat: number): readonly [string, string] {
  // Offset by the role so two roles do not both start at "Anita Rao".
  const base = seedIndexOf(roleKey);
  const picked = SEAT_NAMES[(base + seat - 1) % SEAT_NAMES.length];
  // The modulo cannot leave the array, but saying so with `!` asks the reader
  // to verify that; a fallback says it without asking.
  return picked ?? ['Demo', 'Staff'];
}

export function demoUsers(tenancy: SeededTenancy): readonly SeededUser[] {
  const users: SeededUser[] = [];
  for (const hospital of tenancy.hospitals) {
    for (const template of ROLE_TEMPLATES) {
      const seats = SEATS[template.key] ?? 1;
      for (let seat = 1; seat <= seats; seat += 1) {
        // Seat 1 keeps the bare username. Every spec in the repository signs in
        // as `<role>@<hospital>`, and renaming it to `<role>.1@` would break
        // all of them to no purpose.
        const suffix = seat === 1 ? '' : `.${String(seat)}`;
        const [given, family] = seatName(template.key, seat);
        users.push({
          // Seat 1 keeps its original id as well as its username. Giving it a
          // new one would try to insert a second row with a username the first
          // already holds, and `users_group_username_key` refuses that — the
          // seed is meant to be re-runnable, not to fight itself.
          id:
            seat === 1
              ? seedId('user', hospital.code, template.key)
              : seedId('user', hospital.code, template.key, String(seat)),
          hospital,
          roleKey: template.key,
          username: `${template.key}${suffix}@${hospital.code.toLowerCase()}`,
          seat,
          personName: `${given} ${family}`,
        });
      }
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
    // The person's name leads, because a handover list that reads
    // "Nurse — Ward (VIMS-BLR)" three times is a list nobody can use.
    const displayName = `${user.personName} — ${template.name} (${hospital.code})`;

    users.push({
      id: user.id,
      hospital_id: hospital.id,
      group_id: tenancy.groupId,
      username: user.username,
      email: `${template.key}.${String(user.seat)}.${hospital.code.toLowerCase()}@demo.vims.local`,
      // Synthetic, in the reserved 999-prefixed test range so it can never
      // reach a real handset (docs/09 §11: never real data).
      mobile: `+9199900${String(10_000 + seedIndexOf(template.key) * 8 + user.seat).slice(-5)}`,
      name: {
        family: user.personName.split(' ')[1] ?? 'Demo',
        given: user.personName.split(' ')[0] ?? template.name,
      },
      display_name: displayName.slice(0, 200),
      employee_id: `EMP-${hospital.code}-${String(template.docsRow).padStart(3, '0')}-${String(user.seat)}`,
      type:
        template.category === 'external' ? 'external' : template.category === 'device' ? 'device' : 'staff',
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
              registrationNo: `KMC/DEMO/${String(template.docsRow).padStart(4, '0')}${String(user.seat)}`,
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
      id:
        user.seat === 1
          ? seedId('user-role', hospital.code, template.key)
          : seedId('user-role', hospital.code, template.key, String(user.seat)),
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
        id:
          user.seat === 1
            ? seedId('branch-access', hospital.code, template.key, b.code)
            : seedId('branch-access', hospital.code, template.key, b.code, String(user.seat)),
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

  await ctx.write(
    { table: 'core.users', conflict: ['id'], immutable: ['password_hash', 'password_changed_at'] },
    users,
  );
  await ctx.write({ table: 'core.user_roles', conflict: ['id'] }, assignments);
  await ctx.write({ table: 'core.org_user_branch_access', conflict: ['id'] }, access);
}

function seedIndexOf(roleKey: string): number {
  return ROLE_TEMPLATES.findIndex((t) => t.key === roleKey) + 1;
}
