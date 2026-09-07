import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CLINICAL_SAFETY_EXEMPT_PERMISSIONS,
  PERMISSION_CATALOGUE,
  PERMISSION_KEYS,
  SECOND_PERSON_PERMISSIONS,
  SEGREGATION_OF_DUTIES_RULES,
  SENSITIVE_GRANT_PERMISSIONS,
  assertRegisteredPermission,
  getPermission,
  isRegisteredPermission,
  permissionsForModule,
} from './permissions.js';
import {
  MFA_MANDATORY_ROLE_KEYS,
  ROLE_TEMPLATES,
  SENSITIVE_ROLE_KEYS,
  getRoleTemplate,
} from './role-templates.js';

describe('permission catalogue', () => {
  it('registers every key exactly once', () => {
    expect(new Set(PERMISSION_KEYS).size).toBe(PERMISSION_KEYS.length);
  });

  it('names every key as <module>.<resource>.<action> in lower snake segments', () => {
    // docs/05 §Permission catalogue conventions.
    for (const key of PERMISSION_KEYS) {
      expect(key, `"${key}" is not a valid permission key shape`).toMatch(
        /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$/,
      );
    }
  });

  it('gives every key a description a hospital administrator could act on', () => {
    for (const def of PERMISSION_CATALOGUE) {
      expect(def.description.length, `${def.key} has no usable description`).toBeGreaterThan(20);
      expect(def.description.endsWith('.'), `${def.key} description should be a sentence`).toBe(true);
    }
  });

  /**
   * Reads the index rather than a hand-maintained copy of it.
   *
   * The previous version of this test asserted against a literal list of the
   * sixteen Phase-0 modules, which meant it could only ever pass for Phase 0 and
   * would have to be edited every phase — and an assertion you edit to make it
   * pass is not an assertion. Parsing `docs/12-module-index.md` makes the test
   * mean what its name says: a permission may not claim a module that the index
   * does not define.
   */
  it('attributes every key to a module ID that exists in docs/12', () => {
    const index = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../../../docs/12-module-index.md'),
      'utf8',
    );
    const knownModules = new Set(index.match(/\b(?:OP|IP|TR|NC|EN|RC|PE|AI)-\d{3}\b/g) ?? []);
    expect(knownModules.size, 'docs/12 should define the full module catalogue').toBeGreaterThan(150);

    for (const def of PERMISSION_CATALOGUE) {
      expect(knownModules.has(def.module), `${def.key} claims unknown module ${def.module}`).toBe(true);
    }
  });

  /**
   * A key's phase is the phase that introduces it (`CLAUDE.md` §6). Keys may not
   * drift backwards into an earlier phase, because a Phase-0 role template
   * granting a Phase-1 key would give somebody authority over a module that does
   * not exist yet.
   */
  it('places each key in a build phase that exists, and never moves one backwards', () => {
    const phase0Modules = new Set([
      'EN-005',
      'EN-007',
      'EN-013',
      'EN-017',
      'EN-022',
      'EN-023',
      'EN-024',
      'EN-025',
      'EN-026',
      'EN-027',
      'EN-032',
      'EN-037',
      'EN-038',
      'EN-039',
      'EN-040',
      'EN-041',
    ]);
    for (const def of PERMISSION_CATALOGUE) {
      expect(def.phase, `${def.key} has an out-of-range phase`).toBeGreaterThanOrEqual(0);
      expect(def.phase, `${def.key} has an out-of-range phase`).toBeLessThanOrEqual(13);
      if (phase0Modules.has(def.module)) {
        expect(def.phase, `${def.key} belongs to a Phase-0 module and must stay at phase 0`).toBe(0);
      } else {
        expect(def.phase, `${def.key} is not a Phase-0 module and must not claim phase 0`).toBeGreaterThan(0);
      }
    }
  });

  it('resolves a registered key and rejects an unregistered one', () => {
    expect(isRegisteredPermission('admin.user.read')).toBe(true);
    expect(isRegisteredPermission('opd.consult.sign')).toBe(false);
    expect(getPermission('admin.user.read')?.module).toBe('EN-007');
    expect(getPermission('nope.nope.nope')).toBeUndefined();
  });

  it('fails loudly, naming the caller, when a module uses an unregistered key', () => {
    // EN-007 §3.3.1: "modules cannot use unregistered keys (lint + runtime check)".
    // The key here is deliberately one no spec will ever declare. The earlier
    // version used `lab.result.validate`, which Phase 3 then registered — an
    // assertion that a real key is unregistered is an assertion with a fuse in it.
    expect(() => assertRegisteredPermission('lab.result.telekinesis', 'LabController.validate')).toThrow(
      /Unregistered permission key "lab\.result\.telekinesis" used by LabController\.validate/,
    );
  });

  it('groups keys by module for the admin console permission tree', () => {
    const en024 = permissionsForModule('EN-024');
    expect(en024.length).toBeGreaterThan(5);
    expect(en024.every((d) => d.module === 'EN-024')).toBe(true);
  });

  it('defines no permission that could update or delete an audit entry', () => {
    // EN-024 §12: "**No role can update or delete audit entries** — the
    // permission does not exist." This test is the enforcement of that sentence.
    const forbidden = PERMISSION_CATALOGUE.filter(
      (d) =>
        (d.resource === 'audit_log' || d.resource === 'audit') &&
        (d.action === 'update' || d.action === 'delete'),
    );
    expect(forbidden).toEqual([]);
  });

  it('marks the clinical-safety-exempt set, which no licence tier may gate', () => {
    // EN-040 §5 + §14 AC-20.
    expect(CLINICAL_SAFETY_EXEMPT_PERMISSIONS.length).toBeGreaterThan(10);
    // Patient identification and verification must be in it: docs/04 §7 makes
    // two-identifier checking non-negotiable.
    expect(CLINICAL_SAFETY_EXEMPT_PERMISSIONS).toContain('barcode.verify.mar');
    expect(CLINICAL_SAFETY_EXEMPT_PERMISSIONS).toContain('barcode.verify.blood');
    expect(CLINICAL_SAFETY_EXEMPT_PERMISSIONS).toContain('barcode.scan');
    // The hospital's right to its own data (EN-040 §5).
    expect(CLINICAL_SAFETY_EXEMPT_PERMISSIONS).toContain('org.patient.break_glass');
  });

  it('requires a second person for exactly the actions the specs name', () => {
    // docs/05 §ABAC: "requires_second_person (blood issue, narcotics)".
    expect(SECOND_PERSON_PERMISSIONS).toContain('barcode.verify.blood');
    expect(SECOND_PERSON_PERMISSIONS).toContain('barcode.verify.override');
  });

  it('marks role grants that need dual approval', () => {
    // EN-007 §5.
    expect(SENSITIVE_GRANT_PERMISSIONS).toContain('admin.role.assign');
    expect(SENSITIVE_GRANT_PERMISSIONS).toContain('admin.impersonate');
    expect(SENSITIVE_GRANT_PERMISSIONS).toContain('admin.security.configure');
  });

  it('makes every break-glass and override permission demand a reason', () => {
    // EN-024 §5 lists these as reason-mandatory.
    const needReason = PERMISSION_CATALOGUE.filter(
      (d) => d.action === 'override' || d.key.includes('break_glass') || d.action === 'export',
    );
    for (const def of needReason) {
      expect(def.requiresReason, `${def.key} must require a reason (EN-024 §5)`).toBe(true);
    }
  });

  it('references only registered keys in the segregation-of-duties rules', () => {
    for (const rule of SEGREGATION_OF_DUTIES_RULES) {
      expect(isRegisteredPermission(rule.permA), `SoD rule references unknown ${rule.permA}`).toBe(true);
      expect(isRegisteredPermission(rule.permB), `SoD rule references unknown ${rule.permB}`).toBe(true);
      expect(rule.permA).not.toBe(rule.permB);
      expect(rule.reason.length).toBeGreaterThan(20);
    }
  });
});

describe('system role templates', () => {
  it('defines exactly the 68 templates docs/05 enumerates', () => {
    expect(ROLE_TEMPLATES).toHaveLength(68);
  });

  it('covers docs/05 rows 1 to 68 with no gaps and no duplicates', () => {
    const rows = ROLE_TEMPLATES.map((t) => t.docsRow).sort((a, b) => a - b);
    expect(rows).toEqual(Array.from({ length: 68 }, (_, i) => i + 1));
  });

  it('gives every template a unique key and a home workspace', () => {
    expect(new Set(ROLE_TEMPLATES.map((t) => t.key)).size).toBe(68);
    for (const t of ROLE_TEMPLATES) {
      expect(t.homeWorkspace, `${t.key} has no home workspace`).toBeTruthy();
      expect(t.name.length).toBeGreaterThan(2);
      expect(t.description.length).toBeGreaterThan(20);
    }
  });

  it('references only registered permission keys', () => {
    for (const t of ROLE_TEMPLATES) {
      for (const key of t.permissions) {
        expect(isRegisteredPermission(key), `role "${t.key}" references unregistered "${key}"`).toBe(true);
      }
    }
  });

  it('mandates MFA for exactly the roles docs/04 §2 and EN-007 §3.4.2 name', () => {
    // "Admin, Finance, Pharmacy-narcotics, Blood bank, MRD-export, Privacy Officer",
    // plus EN-007's Billing, Insurance and IT.
    const required = [
      'hospital_admin',
      'branch_admin',
      'super_admin',
      'accountant',
      'pharmacy_incharge',
      'blood_bank_officer',
      'mrd_officer',
      'privacy_officer',
      'billing_executive',
      'insurance_desk',
      'it_admin',
      'auditor',
    ];
    for (const key of required) {
      expect(MFA_MANDATORY_ROLE_KEYS, `${key} must require MFA`).toContain(key);
    }
  });

  it('never grants a resident an override or break-glass permission', () => {
    // docs/06 §5.2 #16: the allergy hard-stop "disables for roles without
    // `override` (residents)". A resident who could override it would make that
    // sentence false.
    const resident = getRoleTemplate('resident_doctor');
    expect(resident).toBeDefined();
    expect(resident!.requiresCoSign).toBe(true);
    for (const key of resident!.permissions) {
      const def = getPermission(key)!;
      expect(def.action, `resident must not hold override permission ${key}`).not.toBe('override');
      expect(key).not.toContain('break_glass');
    }
  });

  it('gives clinicians break-glass, because emergency care is never blocked by a consent gate', () => {
    // EN-024 §3.2.2 / EN-041 §3.4.2: access is granted immediately, then reviewed.
    for (const key of ['doctor_consultant_opd', 'doctor_ip', 'doctor_emergency', 'medical_superintendent']) {
      const t = getRoleTemplate(key)!;
      expect(t.permissions, `${key} needs break-glass`).toContain('org.patient.break_glass');
    }
  });

  it('gives no external or device role a break-glass or override permission', () => {
    for (const t of ROLE_TEMPLATES.filter((r) => r.category === 'external' || r.category === 'device')) {
      for (const key of t.permissions) {
        expect(key, `${t.key} must not hold ${key}`).not.toContain('break_glass');
        expect(getPermission(key)!.action, `${t.key} must not hold ${key}`).not.toBe('override');
      }
    }
  });

  it('masks patient identifiers for roles with no clinical need to see them', () => {
    // docs/04 §4: "patient identifiers masked by default in non-care roles".
    for (const key of ['housekeeping', 'kitchen_staff', 'ward_attendant']) {
      const t = getRoleTemplate(key)!;
      expect(t.abacDefaults.dataClassMasks, `${key} should mask identifiers`).toBeDefined();
      expect(t.abacDefaults.dataClassMasks).toContain('diagnosis');
    }
  });

  it('caps the billing executive at the discount ceiling docs/05 uses as its worked example', () => {
    // docs/05 §Model: "amount_limit (discount ≤ 10 %)".
    const billing = getRoleTemplate('billing_executive')!;
    expect(billing.abacDefaults.amountLimit?.maxPercent).toBe('10');
    expect(billing.abacDefaults.amountLimit?.combine).toBe('whichever_is_lower');
  });

  /**
   * Two-person verification for blood and narcotics lives on the permission,
   * not on the person.
   *
   * This used to assert a role-level `requiresSecondPerson`, which sounds like
   * "these people are co-signers" and means "these people may do nothing
   * alone" — including reading. What the requirement actually needs is that
   * these roles hold keys that demand a second signature, and that they carry
   * mandatory MFA under docs/04 §2.
   */
  it('holds the blood bank and pharmacy narcotics roles to two-person keys and MFA', () => {
    for (const key of ['blood_bank_officer', 'pharmacy_incharge']) {
      const template = getRoleTemplate(key)!;
      expect(template.abacDefaults.requiresSecondPerson).toBe(undefined);
      expect(template.mfaMandatory, `${key} must require MFA`).toBe(true);
      expect(
        template.permissions.some((permission) => SECOND_PERSON_PERMISSIONS.includes(permission)),
        `${key} must hold a key that demands a second signature`,
      ).toBe(true);
    }
  });

  it('flags the roles whose grant needs two approvers', () => {
    for (const key of [
      'super_admin',
      'hospital_admin',
      'privacy_officer',
      'it_admin',
      'blood_bank_officer',
    ]) {
      expect(SENSITIVE_ROLE_KEYS, `${key} grant must be sensitive`).toContain(key);
    }
  });

  it('gives the auditor read-only reach — no create, update or delete anywhere', () => {
    // docs/05 row 58: "read-only, exports audited".
    const auditor = getRoleTemplate('auditor')!;
    const mutating = new Set([
      'create',
      'update',
      'delete',
      'cancel',
      'dispense',
      'issue',
      'sign',
      'override',
    ]);
    for (const key of auditor.permissions) {
      expect(mutating.has(getPermission(key)!.action), `auditor must not hold ${key}`).toBe(false);
    }
  });

  it('gives the lab technician no result-validation reach', () => {
    // docs/05 row 33: "result entry (no validation)". The key does not exist yet
    // (Phase 3), so the assertion is that nothing validation-shaped is granted.
    const tech = getRoleTemplate('lab_technician')!;
    expect(tech.permissions.some((k) => k.includes('validate'))).toBe(false);
  });

  /**
   * No role template may carry `requiresSecondPerson` as an ABAC default.
   *
   * It reads like "this person is a valid co-signer" and means the opposite:
   * `evaluateConditions` treats it as "this actor must supply a co-signer for
   * every request", and `PolicyGuard` never supplies one. A role carrying it
   * therefore gets 403 on everything — reads included. It sat on the two
   * pharmacists, the pharmacy in-charge and the blood bank officer, which made
   * the entire Phase 4 pharmacy module uncallable by pharmacists while every
   * test stayed green, because no test drove a route as one of them.
   *
   * Two-person verification is a property of an action. `requiresSecondPerson`
   * on the *permission* expresses it, and `Permission()` already refuses to let
   * such a key become a route decorator for the same underlying reason.
   */
  it('never puts requiresSecondPerson on a role, only on a permission', () => {
    const offenders = ROLE_TEMPLATES.filter((role) => role.abacDefaults?.requiresSecondPerson === true).map(
      (role) => role.key,
    );

    expect(
      offenders,
      'a role-level requiresSecondPerson denies every request that role makes, reads included',
    ).toEqual([]);
  });
});
