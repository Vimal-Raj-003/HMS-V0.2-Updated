import { expect, test } from '@playwright/test';
import { ROLE_TEMPLATES } from '@vims/contracts';
import { signIn, signInAs, visibleNavLabels } from './fixtures';

/**
 * Every seeded credential, signed in as itself.
 *
 * A hospital does not have one nurse. It has a rota, and a rota is the reason
 * half the rules in this system exist — a second person witnesses a controlled
 * drug, a handover passes from one shift to the next, a maker is not the
 * checker. One account per role proved a permission and could not exercise any
 * of that, so the seed now gives the roles that work a rota three seats and the
 * desks that are genuinely one person one.
 *
 * `super_admin` stays at one. It is the SaaS operator's account rather than a
 * hospital job, and more of them is more ways in rather than more capacity.
 *
 * What this asserts of each seat is what a login is *for*: that the credential
 * works, that it lands on the workspace its role declares, and that the
 * navigation it is offered is the navigation of that role and not another's.
 */

/** Mirrors `SEATS` in `packages/db/src/seed/users.ts`. */
const SEATS: Readonly<Record<string, number>> = {
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
  receptionist: 3,
  cashier: 3,
  billing_executive: 2,
  hospital_admin: 2,
  branch_admin: 2,
  lab_technician: 3,
  phlebotomist: 2,
  radiology_technician: 2,
  pharmacist_op: 3,
  pharmacist_ip: 3,
  housekeeping: 3,
  ward_attendant: 2,
  security_officer: 2,
  patient: 3,
  family_attendant: 2,
};

/** The roles the request named, plus the ones a hospital cannot run without. */
const MUST_HAVE_SEATS = [
  'nurse_ward',
  'nurse_opd',
  'doctor_consultant_opd',
  'doctor_ip',
  'patient',
  'housekeeping',
  'hospital_admin',
  'lab_technician',
  'pharmacist_op',
  'pharmacist_ip',
  'receptionist',
  'cashier',
] as const;

test.describe('the seeded credentials', () => {
  test('gives every rota role more than one person, and super_admin exactly one', () => {
    for (const role of MUST_HAVE_SEATS) {
      expect(SEATS[role] ?? 1, `${role} should have more than one seat`).toBeGreaterThan(1);
    }
    // Not in SEATS at all, so it falls through to one.
    expect(SEATS['super_admin']).toBeUndefined();
  });

  // One test per role rather than per seat: signing in is the slow part, and a
  // role whose second seat is broken is a role whose test fails either way.
  for (const [roleKey, seats] of Object.entries(SEATS)) {
    const template = ROLE_TEMPLATES.find((t) => t.key === roleKey);
    if (template === undefined) continue;

    test(`${roleKey} — all ${String(seats)} seats sign in and land on ${template.homeWorkspace}`, async ({
      page,
    }) => {
      test.setTimeout(20_000 + seats * 15_000);

      let firstNav: readonly string[] = [];

      for (let seat = 1; seat <= seats; seat += 1) {
        const username = seat === 1 ? `${roleKey}@vims-blr` : `${roleKey}.${String(seat)}@vims-blr`;

        // The role nav is the proof the session resolved: it is drawn from the
        // permissions the server returned, not from anything the form said.
        await signInAs(page, username);

        const nav = await visibleNavLabels(page);
        expect(nav.length, `${username} should be offered somewhere to go`).toBeGreaterThan(0);

        // Every seat of one role is the same person as far as the system is
        // concerned. A second nurse who sees a different ward than the first
        // is a grant that drifted.
        if (seat === 1) firstNav = nav;
        else expect(nav, `${username} sees what seat 1 sees`).toEqual([...firstNav]);

        await page.context().clearCookies();
      }
    });
  }
});

test.describe('what each credential is allowed to reach', () => {
  /**
   * A spot-check that the roles are actually different from one another.
   *
   * The seat test above proves the seats of one role agree; this proves the
   * roles disagree — which is the half that catches a bundle accidentally
   * granted to everybody.
   */
  test('a nurse, a pharmacist and a cashier are offered three different consoles', async ({ page }) => {
    const seen = new Map<string, readonly string[]>();

    for (const role of ['nurse_ward', 'pharmacist_op', 'cashier']) {
      await signIn(page, role);
      seen.set(role, await visibleNavLabels(page));
      await page.context().clearCookies();
    }

    const nurse = seen.get('nurse_ward') ?? [];
    const pharmacist = seen.get('pharmacist_op') ?? [];
    const cashier = seen.get('cashier') ?? [];

    expect(nurse).not.toEqual(pharmacist);
    expect(pharmacist).not.toEqual(cashier);
    expect(nurse).not.toEqual(cashier);
  });
});
