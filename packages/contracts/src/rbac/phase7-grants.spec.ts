import { describe, expect, it } from 'vitest';
import { PERMISSION_CATALOGUE, getPermission } from './permissions.js';
import type { PermissionDefinition } from './permissions.js';
import { ROLE_TEMPLATES, getRoleTemplate } from './role-templates.js';

/**
 * Phase 7 grants, held to the same allow-list discipline as Phase 6.
 *
 * The reason that spec exists is that a scripted edit anchoring on
 * `permissions: [` silently skips a role whose array is written on one line,
 * and nothing else catches the resulting mis-anchored grant: types, lint and
 * the seed all pass while an orthopaedic key sits on a dialysis technician.
 */
const PHASE_7_PREFIXES = [
  'bed',
  'admission',
  'transfer',
  'housekeeping',
  'census',
  'nursing',
  'mar',
  'escalation',
  'infection',
  'ipbill',
  'ot',
  'cssd',
  'icu',
  'cart',
  'code',
  'blood',
  'ip',
  'mortuary',
] as const;

/**
 * Throws rather than returning `undefined`.
 *
 * A test that silently skips because a key was renamed is worse than no test:
 * it stays green while the thing it guards stops existing.
 */
function permission(key: string): PermissionDefinition {
  const found = getPermission(key);
  if (found === undefined) throw new Error(`Phase 7 spec names an unregistered permission: ${key}`);
  return found;
}

function keysWithPrefix(prefix: string): readonly string[] {
  return PERMISSION_CATALOGUE.filter((p) => p.key.startsWith(`${prefix}.`)).map((p) => p.key);
}

function holdersOf(key: string): readonly string[] {
  return ROLE_TEMPLATES.filter((role) => role.permissions.includes(key)).map((role) => role.key);
}

describe('Phase 7A permission catalogue', () => {
  it('registers every key the phase declares', () => {
    for (const prefix of PHASE_7_PREFIXES) {
      expect(keysWithPrefix(prefix).length, `${prefix}.* has no keys`).toBeGreaterThan(0);
    }
  });

  /**
   * The bed board is the widest key in the phase on purpose. A board only the
   * bed manager can read is a board everybody phones the bed manager about,
   * which is how a hospital ends up with a whiteboard beside the screen and two
   * answers to one question.
   */
  it('holds the bed board widely and keeps it low-risk', () => {
    const board = permission('bed.board.read');
    expect(board.risk).toBe('low');
    expect(holdersOf('bed.board.read').length).toBeGreaterThanOrEqual(20);
  });

  /**
   * Blocking a bed is not. A blocked bed is a bed the hospital does not have,
   * and beyond twenty-four hours it needs an approval — so the key itself asks
   * why, every time.
   */
  it('makes blocking a bed reasoned', () => {
    const block = permission('bed.block');
    expect(block.risk).toBe('medium');
    expect(block.requiresReason).toBe(true);
  });

  /**
   * There is no pay-first gate anywhere in this system (Parmanand Katara), so
   * admitting on a short deposit must be possible. It is `high` and reasoned
   * because it is a financial decision somebody has to own, not because it is
   * one anybody should be prevented from making at 3 a.m.
   */
  it('lets a short deposit through, and records who decided', () => {
    const waive = permission('admission.deposit.waive');
    expect(waive.requiresReason).toBe(true);
    expect(waive.risk).toBe('high');
    expect(permission('admission.admit').requiresReason ?? false).toBe(false);
  });

  /**
   * The housekeeping override exists — a bed vacated for ten minutes for a
   * portable X-ray needs no terminal clean — and costs a stated reason. Without
   * the override the rule would be worked around by marking a fake clean, which
   * is worse than an audited exception.
   */
  it('allows the cleaning override only with a reason', () => {
    const override = permission('housekeeping.override');
    expect(override.requiresReason).toBe(true);
    expect(holdersOf('housekeeping.override')).toEqual(['nurse_supervisor']);
  });

  /**
   * Every Phase 7 key belongs to a role that was meant to have it. A prefix
   * with no entry here is a new module whose grants nobody has reviewed, and
   * failing loudly is the correct outcome.
   */
  /**
   * Giving a dose is held by every bedside nurse, deliberately.
   *
   * The control on a dose is the scan and the witness, both enforced by the
   * database and neither bypassable by any flag. Making the *permission* scarce
   * would push drug rounds onto one nurse's login — which defeats the witness
   * rule by making one person do everything, and is the failure the hard gates
   * exist to make impossible.
   */
  it('keeps giving a dose a low-risk permission held by every bedside nurse', () => {
    const administer = permission('mar.administer');
    expect(administer.risk).toBe('low');
    expect(administer.requiresReason ?? false).toBe(false);

    for (const nurse of ['nurse_ward', 'nurse_icu', 'nurse_er_triage', 'nurse_ot_scrub']) {
      expect(holdersOf('mar.administer'), nurse).toContain(nurse);
    }
  });

  /**
   * The pharmacist verifies and does not administer; the nurse administers and
   * does not verify. Two people, two keys — that separation is the whole point
   * of the verification standing between the order and the chart.
   */
  it('keeps verifying an order away from the nurses who give it', () => {
    const verifiers = [...holdersOf('mar.order.verify')].sort();
    expect(verifiers).toEqual(['pharmacist_ip', 'pharmacy_incharge']);
    for (const verifier of verifiers) {
      expect(holdersOf('mar.administer'), `${verifier} must not also administer`).not.toContain(verifier);
    }
  });

  /**
   * And prescribing is not administering either. A doctor who can write the
   * order and give it is a doctor with no second pair of eyes on either.
   */
  it('keeps prescribing away from administering', () => {
    for (const prescriber of holdersOf('mar.order.write')) {
      expect(holdersOf('mar.administer'), `${prescriber} must not also administer`).not.toContain(prescriber);
    }
  });

  /**
   * Running the room-charge job is idempotent by construction, so running it
   * twice is harmless and running it never is the actual risk. It is `medium`
   * because it posts money, not because a second run is dangerous.
   */
  it('keeps running the charge job free of a reason requirement', () => {
    const run = permission('ipbill.charge.run');
    expect(run.requiresReason ?? false).toBe(false);
    expect(run.risk).toBe('medium');
  });

  /**
   * Letting a patient leave over an unresolved bill is not. Somebody owns that,
   * and the grounds are what makes it owned.
   */
  it('makes overriding the discharge gate high-risk and reasoned', () => {
    const override = permission('ipbill.clearance.override');
    expect(override.risk).toBe('high');
    expect(override.requiresReason).toBe(true);
  });

  /**
   * There is no key that turns the WHO checklist off, and there must never be
   * one. The three phases are enforced by triggers; a permission that could
   * bypass them would be a permission somebody grants at 2 a.m. to get a case
   * moving, and the whole point of the checklist is that it applies then.
   */
  it('offers no permission that bypasses the surgical checklist', () => {
    const bypasses = PERMISSION_CATALOGUE.filter(
      (permission) =>
        permission.key.startsWith('ot.') && /bypass|skip|waive|force|emergency_mode/u.test(permission.key),
    );
    expect(bypasses).toEqual([]);
  });

  /**
   * Running the time-out is `low` and held by everybody in the room. It is a
   * thing the team does out loud together; a scarce permission would make it a
   * thing one person clicks.
   */
  it('keeps running the time-out a low-risk permission held by the whole team', () => {
    const timeout = permission('ot.checklist.timeout');
    expect(timeout.risk).toBe('low');
    for (const member of ['surgeon', 'anaesthetist', 'nurse_ot_scrub']) {
      expect(holdersOf('ot.checklist.timeout'), member).toContain(member);
    }
  });

  /**
   * Recalling a failed sterilisation load is not. It produces a list of
   * patients, and it is reasoned for the same purpose the implant trace is.
   */
  it('makes the sterilisation recall reasoned', () => {
    const recall = permission('cssd.recall.run');
    expect(recall.requiresReason).toBe(true);
    expect(recall.risk).toBe('high');
  });

  /**
   * Transfusing is `low` and held widely, for the same reason giving a dose is.
   * The control is the two-person bedside check and the two scans, both
   * enforced by the database. A scarce permission would concentrate
   * transfusions on one login — which is how one person ends up doing both
   * halves of a two-person check.
   */
  it('keeps starting a transfusion a low-risk permission held at the bedside', () => {
    const transfuse = permission('blood.transfuse');
    expect(transfuse.risk).toBe('low');
    for (const nurse of ['nurse_ward', 'nurse_icu', 'nurse_er_triage']) {
      expect(holdersOf('blood.transfuse'), nurse).toContain(nurse);
    }
  });

  /**
   * Issuing from the bank is not the same act and not the same people. The bank
   * issues; the ward transfuses; neither does the other's half.
   */
  it('keeps issuing from the bank away from the nurses who transfuse', () => {
    for (const issuer of holdersOf('blood.issue')) {
      expect(holdersOf('blood.transfuse'), `${issuer} must not also transfuse`).not.toContain(issuer);
    }
  });

  /**
   * Anybody may call a code. The person who finds somebody arrested is whoever
   * happened to walk in, and a permission check at that moment is a permission
   * check during a cardiac arrest.
   */
  it('lets anybody at the bedside call a code', () => {
    const call = permission('code.call');
    expect(call.risk).toBe('low');
    expect(call.requiresReason ?? false).toBe(false);
    expect(holdersOf('code.call').length).toBeGreaterThanOrEqual(8);
  });

  it('gives every Phase 7 key only to roles that were meant to have it', () => {
    const ALLOWED: Readonly<Record<string, readonly string[]>> = {
      ip: [
        'hospital_admin',
        'branch_admin',
        'medical_superintendent',
        'hod',
        'doctor_ip',
        'doctor_emergency',
        'surgeon',
        'intensivist',
        'resident_doctor',
        'nurse_ward',
        'nurse_icu',
        'nurse_supervisor',
        'pharmacist_ip',
        'billing_executive',
        'mrd_officer',
      ],
      mortuary: [
        'medical_superintendent',
        'hod',
        'doctor_ip',
        'doctor_emergency',
        'surgeon',
        'intensivist',
        'resident_doctor',
        'pathologist',
        'nurse_ward',
        'nurse_icu',
        'nurse_supervisor',
        'ward_attendant',
        'mrd_officer',
      ],
      bed: [
        'hospital_admin',
        'branch_admin',
        'medical_superintendent',
        'nurse_supervisor',
        'receptionist',
        'doctor_ip',
        'doctor_emergency',
        'doctor_consultant_opd',
        'surgeon',
        'intensivist',
        'resident_doctor',
        'nurse_ward',
        'nurse_icu',
        'nurse_opd',
        'nurse_er_triage',
        'ward_attendant',
        'housekeeping',
        'facility_maintenance',
        'billing_executive',
        'cashier',
        'insurance_desk',
        'mrd_officer',
        'dietician',
        'therapist',
        'infection_control_nurse',
      ],
      admission: [
        'hospital_admin',
        'branch_admin',
        'medical_superintendent',
        'nurse_supervisor',
        'receptionist',
        'doctor_ip',
        'doctor_emergency',
        'doctor_consultant_opd',
        'surgeon',
        'intensivist',
        'resident_doctor',
        'nurse_ward',
        'nurse_icu',
        'nurse_opd',
        'nurse_er_triage',
        'billing_executive',
        'cashier',
        'insurance_desk',
        'mrd_officer',
        'dietician',
        'therapist',
        'infection_control_nurse',
      ],
      transfer: [
        'hospital_admin',
        'branch_admin',
        'medical_superintendent',
        'nurse_supervisor',
        'receptionist',
        'doctor_ip',
        'doctor_emergency',
        'doctor_consultant_opd',
        'surgeon',
        'intensivist',
        'resident_doctor',
        'nurse_ward',
        'nurse_icu',
        'ward_attendant',
        'billing_executive',
        'insurance_desk',
        'mrd_officer',
        'infection_control_nurse',
      ],
      housekeeping: [
        'nurse_supervisor',
        'nurse_ward',
        'nurse_icu',
        'ward_attendant',
        'housekeeping',
        'facility_maintenance',
      ],
      nursing: [
        'nurse_ward',
        'nurse_icu',
        'nurse_ot_scrub',
        'nurse_er_triage',
        'nurse_supervisor',
        'nurse_opd',
        'doctor_ip',
        'intensivist',
        'doctor_emergency',
        'surgeon',
        'doctor_consultant_opd',
        'resident_doctor',
        'anaesthetist',
        'medical_superintendent',
        'infection_control_nurse',
        'pharmacist_ip',
        'pharmacy_incharge',
        'quality_manager',
        'ward_attendant',
        'dietician',
        'therapist',
      ],
      mar: [
        'nurse_ward',
        'nurse_icu',
        'nurse_ot_scrub',
        'nurse_er_triage',
        'nurse_supervisor',
        'nurse_opd',
        'doctor_ip',
        'intensivist',
        'doctor_emergency',
        'surgeon',
        'doctor_consultant_opd',
        'resident_doctor',
        'anaesthetist',
        'medical_superintendent',
        'pharmacist_ip',
        'pharmacy_incharge',
      ],
      escalation: [
        'nurse_ward',
        'nurse_icu',
        'nurse_ot_scrub',
        'nurse_er_triage',
        'nurse_supervisor',
        'nurse_opd',
        'doctor_ip',
        'intensivist',
        'doctor_emergency',
        'surgeon',
        'doctor_consultant_opd',
        'resident_doctor',
        'anaesthetist',
        'medical_superintendent',
      ],
      infection: [
        'nurse_ward',
        'nurse_icu',
        'nurse_ot_scrub',
        'nurse_er_triage',
        'nurse_supervisor',
        'infection_control_nurse',
        'doctor_ip',
        'intensivist',
        'surgeon',
        'medical_superintendent',
        'quality_manager',
      ],
      ipbill: [
        'hospital_admin',
        'branch_admin',
        'medical_superintendent',
        'billing_executive',
        'cashier',
        'insurance_desk',
        'accountant',
        'nurse_supervisor',
        'doctor_ip',
        'mrd_officer',
      ],
      ot: [
        'surgeon',
        'doctor_emergency',
        'anaesthetist',
        'nurse_ot_scrub',
        'nurse_supervisor',
        'intensivist',
        'resident_doctor',
        'cssd_technician',
        'quality_manager',
        'infection_control_nurse',
        'hospital_admin',
        'medical_superintendent',
        'billing_executive',
      ],
      cssd: [
        'surgeon',
        'nurse_ot_scrub',
        'cssd_technician',
        'quality_manager',
        'infection_control_nurse',
        'hospital_admin',
        'medical_superintendent',
      ],
      icu: [
        'anaesthetist',
        'doctor_emergency',
        'doctor_ip',
        'intensivist',
        'medical_superintendent',
        'nurse_er_triage',
        'nurse_icu',
        'nurse_ot_scrub',
        'nurse_supervisor',
        'nurse_ward',
        'quality_manager',
        'resident_doctor',
        'surgeon',
      ],
      cart: [
        'anaesthetist',
        'doctor_emergency',
        'intensivist',
        'nurse_er_triage',
        'nurse_icu',
        'nurse_ot_scrub',
        'nurse_supervisor',
        'nurse_ward',
        'resident_doctor',
      ],
      code: [
        'anaesthetist',
        'doctor_emergency',
        'doctor_ip',
        'intensivist',
        'medical_superintendent',
        'nurse_er_triage',
        'nurse_icu',
        'nurse_ot_scrub',
        'nurse_supervisor',
        'nurse_ward',
        'quality_manager',
        'resident_doctor',
        'surgeon',
      ],
      blood: [
        'anaesthetist',
        'blood_bank_officer',
        'doctor_emergency',
        'doctor_ip',
        'intensivist',
        'lab_technician',
        'medical_superintendent',
        'nurse_er_triage',
        'nurse_icu',
        'nurse_ot_scrub',
        'nurse_ward',
        'quality_manager',
        'resident_doctor',
        'surgeon',
      ],
      census: [
        'hospital_admin',
        'branch_admin',
        'medical_superintendent',
        'nurse_supervisor',
        'receptionist',
        'doctor_ip',
        'doctor_emergency',
        'doctor_consultant_opd',
        'surgeon',
        'intensivist',
        'resident_doctor',
        'nurse_ward',
        'nurse_icu',
        'nurse_opd',
        'nurse_er_triage',
        'billing_executive',
        'insurance_desk',
        'mrd_officer',
        'dietician',
        'therapist',
        'infection_control_nurse',
      ],
    };

    const offenders: string[] = [];
    for (const prefix of PHASE_7_PREFIXES) {
      for (const key of keysWithPrefix(prefix)) {
        const allowed = ALLOWED[prefix];
        expect(allowed, `no reviewed role list for the "${prefix}" prefix`).toBeDefined();
        for (const holder of holdersOf(key)) {
          // super_admin holds everything by construction.
          if (holder === 'super_admin') continue;
          if (!(allowed ?? []).includes(holder)) offenders.push(`${holder} holds ${key}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * The Phase 4 invariant, applied here: a role that can read one admission by
   * id but cannot list them has no way to obtain an id, so its first action of
   * the day is impossible.
   */
  it('never grants admission.read without admission.list', () => {
    const gaps = ROLE_TEMPLATES.filter(
      (role) => role.permissions.includes('admission.read') && !role.permissions.includes('admission.list'),
    ).map((role) => role.key);
    expect(gaps).toEqual([]);
  });

  it('resolves every role named in this spec', () => {
    for (const key of ['nurse_supervisor', 'housekeeping', 'ward_attendant', 'receptionist']) {
      expect(getRoleTemplate(key), key).toBeDefined();
    }
  });
});

/**
 * Phase 7G — the two rules a discharge summary and a body release turn on.
 *
 * Both are enforced in the database; these assert that the *keys* do not offer
 * a way around them. A role holding both `sign` and `cosign` still cannot
 * countersign its own summary — `cosigner_is_a_second_person` refuses that — but
 * a role holding `cosign` and not `sign` would be a consultant who can approve
 * work they are not allowed to produce, which is not a role that exists here.
 */
describe('Phase 7G — discharge and the mortuary', () => {
  it('gives nobody a cosign key without the sign key it countersigns', () => {
    const offenders = ROLE_TEMPLATES.filter(
      (role) =>
        role.permissions.includes('ip.discharge.summary.cosign') &&
        !role.permissions.includes('ip.discharge.summary.sign'),
    ).map((role) => role.key);
    expect(offenders).toEqual([]);
  });

  it('lets a resident sign a summary but never close the loop on it', () => {
    const resident = getRoleTemplate('resident_doctor');
    expect(resident?.permissions).toContain('ip.discharge.summary.sign');
    expect(resident?.permissions).not.toContain('ip.discharge.summary.cosign');
    expect(resident?.permissions).not.toContain('ip.discharge.summary.amend');
  });

  it('keeps the certificate of cause of death out of the resident bundle', () => {
    // Every other clinical output a resident produces is countersigned. An MCCD
    // goes to the Registrar under one name and has no countersignature slot.
    expect(getRoleTemplate('resident_doctor')?.permissions).not.toContain('mortuary.mccd.write');
    expect(holdersOf('mortuary.mccd.write').length).toBeGreaterThan(0);
  });

  it('keeps the body release with the custodian, not with the ward', () => {
    expect([...holdersOf('mortuary.release.manage')].sort()).toEqual([
      'medical_superintendent',
      'mrd_officer',
    ]);
  });

  it('marks the amendment reason mandatory and the release high-risk', () => {
    expect(permission('ip.discharge.summary.amend').requiresReason).toBe(true);
    expect(permission('ip.discharge.dama').requiresReason).toBe(true);
    expect(permission('mortuary.release.manage').risk).toBe('high');
    expect(permission('mortuary.mccd.write').risk).toBe('high');
  });

  it('audits every read of a death file and a discharge as a PHI read', () => {
    expect(permission('mortuary.case.read').phiRead).toBe(true);
    expect(permission('ip.discharge.read').phiRead).toBe(true);
  });
});
