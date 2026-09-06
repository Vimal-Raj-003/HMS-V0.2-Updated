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
const PHASE_8_PREFIXES = ['console', 'device'] as const;

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
      ],
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
