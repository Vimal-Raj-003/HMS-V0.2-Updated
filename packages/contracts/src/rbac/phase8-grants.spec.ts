import { describe, expect, it } from 'vitest';
import { CONSOLE_COMPONENT_CATALOGUE, validateConsoleTabs } from '../specialty/console-components.js';
import { PERMISSION_CATALOGUE, getPermission } from './permissions.js';
import type { PermissionDefinition } from './permissions.js';
import { ROLE_TEMPLATES, getRoleTemplate } from './role-templates.js';

/**
 * Phase 8's framework grants, held to the Phase 6 and 7 allow-list discipline.
 *
 * The one that matters is the technician/clinician split on the device path. If
 * the person who runs the scanner can also mark the result reviewed, "reviewed"
 * quietly comes to mean "uploaded" — and the rail of unseen results, which is
 * the entire reason the state exists, is empty forever.
 */
const PHASE_8_PREFIXES = ['console', 'device', 'ophtha', 'procedure', 'opdnursing'] as const;

function permission(key: string): PermissionDefinition {
  const found = getPermission(key);
  if (found === undefined) throw new Error(`Phase 8 spec names an unregistered permission: ${key}`);
  return found;
}

function keysWithPrefix(prefix: string): readonly string[] {
  return PERMISSION_CATALOGUE.filter((p) => p.key.startsWith(`${prefix}.`)).map((p) => p.key);
}

function holdersOf(key: string): readonly string[] {
  return ROLE_TEMPLATES.filter((role) => role.permissions.includes(key)).map((role) => role.key);
}

describe('Phase 8 framework permission catalogue', () => {
  it('registers every key the framework declares', () => {
    for (const prefix of PHASE_8_PREFIXES) {
      expect(keysWithPrefix(prefix).length, `${prefix}.* has no keys`).toBeGreaterThan(0);
    }
  });

  it('puts every framework key on exactly one reviewed list of roles', () => {
    const ALLOWED: Readonly<Record<string, readonly string[]>> = {
      console: [
        'hospital_admin',
        'branch_admin',
        'it_admin',
        'medical_superintendent',
        'hod',
        'doctor_consultant_opd',
        'doctor_ip',
        'doctor_emergency',
        'surgeon',
        'anaesthetist',
        'intensivist',
        'radiologist',
        'pathologist',
        'resident_doctor',
        'nurse_opd',
        'nurse_ward',
        'nurse_icu',
        'nurse_er_triage',
        'radiology_technician',
        'lab_technician',
        'dialysis_technician',
        'therapist',
        'counsellor',
        'dietician',
        'receptionist',
        'optometrist',
      ],
      device: [
        'medical_superintendent',
        'hod',
        'doctor_consultant_opd',
        'doctor_ip',
        'doctor_emergency',
        'surgeon',
        'anaesthetist',
        'intensivist',
        'radiologist',
        'pathologist',
        'resident_doctor',
        'nurse_opd',
        'nurse_ward',
        'nurse_icu',
        'nurse_er_triage',
        'radiology_technician',
        'lab_technician',
        'dialysis_technician',
        'therapist',
        'dietician',
        'optometrist',
      ],
      ophtha: [
        'medical_superintendent',
        'hod',
        'doctor_consultant_opd',
        'surgeon',
        'resident_doctor',
        'nurse_opd',
        'optometrist',
      ],
      procedure: [
        'branch_admin',
        'hod',
        'doctor_consultant_opd',
        'doctor_ip',
        'doctor_emergency',
        'surgeon',
        'anaesthetist',
        'resident_doctor',
        'nurse_opd',
        'nurse_ward',
        'nurse_er_triage',
        'nurse_ot_scrub',
        'nurse_supervisor',
        'optometrist',
      ],
      opdnursing: ['nurse_opd', 'nurse_ward', 'nurse_er_triage', 'nurse_supervisor'],
    };

    const offenders: string[] = [];
    for (const prefix of PHASE_8_PREFIXES) {
      for (const key of keysWithPrefix(prefix)) {
        const allowed = ALLOWED[prefix];
        expect(allowed, `no reviewed role list for the "${prefix}" prefix`).toBeDefined();
        for (const holder of holdersOf(key)) {
          if (holder === 'super_admin') continue;
          if (!(allowed ?? []).includes(holder)) offenders.push(`${holder} holds ${key}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('never lets the person who attaches a result also mark it reviewed', () => {
    const offenders = ROLE_TEMPLATES.filter(
      (role) =>
        role.key !== 'super_admin' &&
        role.permissions.includes('device.result.attach') &&
        role.permissions.includes('device.result.review'),
    ).map((role) => role.key);
    expect(
      offenders,
      'a role holding both makes "reviewed" mean "uploaded", and the rail of unseen results is empty forever',
    ).toEqual([]);
  });

  it('gives nobody the worklist without the registry read that names its columns', () => {
    const gaps = ROLE_TEMPLATES.filter(
      (role) =>
        role.permissions.includes('console.worklist.read') &&
        !role.permissions.includes('console.registry.read'),
    ).map((role) => role.key);
    expect(gaps).toEqual([]);
  });

  it('keeps composing a console with administration, and off the clinical floor', () => {
    expect([...holdersOf('console.registry.configure')].sort()).toEqual([
      'branch_admin',
      'hospital_admin',
      'it_admin',
      'medical_superintendent',
    ]);
    expect(permission('console.registry.configure').requiresReason).toBe(true);
    expect(permission('console.registry.configure').risk).toBe('high');
  });

  it('audits reading a worklist as a PHI read, and cancelling an order with a reason', () => {
    expect(permission('console.worklist.read').phiRead).toBe(true);
    expect(permission('device.result.cancel').requiresReason).toBe(true);
  });

  it('resolves every role named in this spec', () => {
    for (const key of ['radiology_technician', 'counsellor', 'it_admin', 'dietician']) {
      expect(getRoleTemplate(key), key).toBeDefined();
    }
  });
});

describe('the console component catalogue', () => {
  it('ships the generic tabs a console may never hide', () => {
    // OP-025 §0.1: history, prescription, orders, timeline and notes stay
    // reachable. A console that hides the rest of the chart is how a specialist
    // misses the allergy.
    for (const key of [
      'generic.history',
      'generic.prescription',
      'generic.orders',
      'generic.timeline',
      'generic.notes',
      'generic.investigations',
    ]) {
      expect(
        CONSOLE_COMPONENT_CATALOGUE.some((c) => c.key === key),
        key,
      ).toBe(true);
    }
  });

  it('refuses a tab naming a component this build does not ship', () => {
    const problems = validateConsoleTabs([
      { key: 'a', label: 'History', component: 'generic.history' },
      { key: 'b', label: 'Ghost', component: 'nobody.wrote.this' },
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('does not ship');
  });

  it('refuses a tab naming both a component and a form, and one naming neither', () => {
    expect(
      validateConsoleTabs([
        { key: 'a', label: 'Both', component: 'generic.notes', formTemplateKey: 'generic.notes' },
      ])[0],
    ).toContain('both');
    expect(validateConsoleTabs([{ key: 'a', label: 'Blank' }])[0]).toContain('neither');
  });

  it('refuses a console with no tabs at all', () => {
    expect(validateConsoleTabs([])).toHaveLength(1);
  });

  it('accepts a console composed only of what exists', () => {
    expect(
      validateConsoleTabs([
        { key: 'history', label: 'History', component: 'generic.history' },
        { key: 'investigations', label: 'Investigations', component: 'generic.investigations' },
      ]),
    ).toEqual([]);
  });
});

/**
 * OP-025 — the first console on the framework.
 *
 * The rules worth a test are the two the console draws differently from the
 * framework: who signs, and who signs a prescription that leaves the building.
 */
describe('OP-025 — the eye clinic', () => {
  it('lets an optometrist record everything and sign nothing', () => {
    const optometrist = getRoleTemplate('optometrist');
    expect(optometrist?.permissions).toContain('ophtha.optometry.record');
    expect(optometrist?.permissions).not.toContain('ophtha.exam.sign');
    // Delegation is a decision the hospital makes deliberately, by granting the
    // key — not a default that arrives with the role.
    expect(optometrist?.permissions).not.toContain('ophtha.spectacle_rx.sign_delegated');
    expect(optometrist?.permissions).not.toContain('ophtha.spectacle_rx.sign');
  });

  it('lets a resident examine and plan but not sign', () => {
    const resident = getRoleTemplate('resident_doctor');
    expect(resident?.permissions).toContain('ophtha.exam.record');
    expect(resident?.permissions).toContain('ophtha.surgery.plan');
    expect(resident?.permissions).not.toContain('ophtha.exam.sign');
    expect(resident?.permissions).not.toContain('ophtha.spectacle_rx.sign');
  });

  it('ships the delegated-signature key unassigned, for the admin to grant', () => {
    // A key nobody holds by default and everybody can be given is how a
    // one-line local regulation becomes a configuration rather than a fork.
    expect(permission('ophtha.spectacle_rx.sign_delegated').risk).toBe('medium');
    expect(holdersOf('ophtha.spectacle_rx.sign_delegated')).toEqual([]);
  });

  it('keeps the ophthalmology console off the framework device keys it does not need', () => {
    // An OCT is ordered with `device.result.order`, not with an ophthalmology
    // key: `phase-08` says no console gets its own upload code, and no console
    // gets its own upload permissions either.
    expect(keysWithPrefix('ophtha').some((k) => k.includes('investigation'))).toBe(false);
  });
});

/**
 * OP-010 and OP-039 — the procedure spine every other console calls into.
 */
describe('OP-010 — the procedure floor', () => {
  it('holds the time-out key as widely as the floor itself', () => {
    // It takes two people in the room, and it does not matter who they are. A
    // scarce key means waiting for a particular person to walk past, and a
    // ritual people wait for is a ritual people skip.
    expect(holdersOf('procedure.timeout.confirm').length).toBeGreaterThanOrEqual(10);
    expect(permission('procedure.timeout.confirm').risk).toBe('low');
  });

  it('makes overriding a checklist reasoned rather than rare', () => {
    // Overriding is a normal act on an urgent case, done by the person about to
    // do the procedure. The control is that it is signed, not that it is scarce.
    expect(permission('procedure.checklist.override').requiresReason).toBe(true);
    expect(permission('procedure.checklist.override').risk).toBe('medium');
    expect(holdersOf('procedure.checklist.override').length).toBeGreaterThanOrEqual(5);
  });

  it('offers no key at all for proceeding without consent', () => {
    // There is no such act, so there is no such key. A permission that could be
    // granted is a permission somebody eventually grants.
    const consentBypasses = PERMISSION_CATALOGUE.filter(
      (p) => p.key.includes('consent') && (p.action === 'override' || p.action === 'bypass'),
    ).map((p) => p.key);
    expect(consentBypasses.filter((k) => k.startsWith('procedure.'))).toEqual([]);
  });

  it('lets a resident perform and not sign', () => {
    const resident = getRoleTemplate('resident_doctor');
    expect(resident?.permissions).toContain('procedure.perform');
    expect(resident?.permissions).not.toContain('procedure.sign');
    expect(resident?.permissions).not.toContain('procedure.checklist.override');
  });

  it('gives the OPD nursing floor the second-person key and the giving key alike', () => {
    // Unlike the device path, both halves belong to nursing: the second person
    // on a high-alert drug is the nurse at the next chair, and the database —
    // not the key — is what stops it being the same person twice.
    const nurse = getRoleTemplate('nurse_opd');
    expect(nurse?.permissions).toContain('opdnursing.administer');
    expect(nurse?.permissions).toContain('opdnursing.administer.verify');
  });
});
