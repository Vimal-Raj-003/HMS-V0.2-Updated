/**
 * The seeded credential rota, shared by the specs that care about it.
 *
 * It lives here rather than inside `credentials.spec.ts` because Playwright
 * forbids one test file importing another, and two specs genuinely need the
 * same list: `credentials.spec.ts` signs in as every role in it, and
 * `login.spec.ts` must therefore pick its lockout victim from outside it.
 *
 * That second dependency is the point. The lockout test used to name its
 * account in a comment, the rota grew to include that account, and the suite
 * began failing on whichever viewport project ran second — passing alone,
 * failing in a full run. Sharing the list makes the constraint checkable
 * instead of remembered.
 */
/** Mirrors `SEATS` in `packages/db/src/seed/users.ts`. */
export const SEATS: Readonly<Record<string, number>> = {
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
