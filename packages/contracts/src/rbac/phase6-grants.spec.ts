import { describe, expect, it } from 'vitest';
import { PERMISSION_CATALOGUE, getPermission } from './permissions.js';
import { ROLE_TEMPLATES, getRoleTemplate } from './role-templates.js';
import type { PermissionDefinition } from './permissions.js';
import type { RoleTemplate } from './role-templates.js';

/**
 * The lookups throw rather than returning `undefined`.
 *
 * A test that silently skips because a key was renamed is worse than no test:
 * it stays green while the thing it guards stops existing.
 */
function permission(key: string): PermissionDefinition {
  const found = getPermission(key);
  if (found === undefined) throw new Error(`No such permission: ${key}`);
  return found;
}
function role(key: string): RoleTemplate {
  const found = getRoleTemplate(key);
  if (found === undefined) throw new Error(`No such role template: ${key}`);
  return found;
}

/**
 * Phase 6 grants — who may call the trauma team, and who may touch evidence.
 *
 * Two of these tests exist because the mistake had already been made. When the
 * TR-008 bundles were added, a scripted edit anchored on `permissions: [` and
 * skipped a role whose array is written on one line — so `MLC_SECURITY`, which
 * carries `mlc.evidence.handover`, landed on **kitchen staff**. Nothing failed:
 * lint passed, the types were fine, the seed wrote the rows, and a canteen
 * worker could have signed evidence out to the police.
 *
 * The category check below is the general form of that failure. It does not
 * care how the grant got there.
 */

const CLINICAL_CATEGORIES = new Set(['medical', 'nursing', 'governance', 'records', 'diagnostics']);

/** Keys that a non-clinical role may legitimately hold, and why. */
const NON_CLINICAL_ALLOWANCES: Readonly<Record<string, readonly string[]>> = {
  // Security carries the intimation to the station and captures the
  // constable's signature; witnesses a transfer; witnesses a handover. None of
  // it reads a clinical record.
  security_officer: ['mlc.intimation.dispatch', 'mlc.custody.transfer', 'mlc.evidence.handover'],
  // Templates, station lists and the disclosure policy matrix are configuration.
  hospital_admin: ['mlc.configure'],
};

describe('Phase 6 — trauma and medico-legal grants', () => {
  /**
   * The asymmetry TR-001 is built around. Under-triage — the team not called,
   * or called late — is the failure mode a trauma system is judged on, so
   * calling is the easy action and releasing is the considered one. A catalogue
   * edit that inverted this would manufacture the expensive error in order to
   * prevent the cheap one.
   */
  it('keeps calling the trauma team cheap and standing it down considered', () => {
    const call = permission('trauma.activation.create');
    const release = permission('trauma.activation.standdown');

    expect(call.risk).toBe('low');
    expect(call.requiresReason ?? false).toBe(false);
    expect(release.requiresReason).toBe(true);
  });

  /**
   * Same shape, opposite module. Opening an MLC has to be easy — a case nobody
   * opened because the key was awkward is a case the hospital cannot prove it
   * saw — and everything that closes, releases or discloses is reasoned.
   */
  it('keeps opening an MLC cheap and every disclosure reasoned', () => {
    expect(permission('mlc.case.create').risk).toBe('low');
    expect(permission('mlc.case.create').requiresReason ?? false).toBe(false);

    for (const key of [
      'mlc.case.cancel',
      'mlc.discharge.override',
      'mlc.sensitive.read',
      'mlc.report.export',
      'mlc.request.manage',
      'mlc.evidence.handover',
    ]) {
      expect(permission(key).requiresReason, key).toBe(true);
    }
  });

  /**
   * The four keys that can undo or expose a medico-legal record need two
   * approvers to grant, not just to use.
   */
  it('makes the Medical Superintendent’s medico-legal keys a sensitive grant', () => {
    for (const key of [
      'mlc.case.cancel',
      'mlc.discharge.override',
      'mlc.sensitive.read',
      'mlc.sensitive.write',
    ]) {
      expect(permission(key).sensitiveGrant, key).toBe(true);
    }
  });

  /**
   * The one this file exists for.
   *
   * A PHI-classed medico-legal key on a facilities, kitchen or transport role
   * is a mis-scripted grant, every time. The allowance list above is the whole
   * set of legitimate exceptions and each entry states its reason.
   */
  it('keeps medico-legal PHI keys off non-clinical roles', () => {
    const phiMlcKeys = new Set(
      PERMISSION_CATALOGUE.filter((d) => d.key.startsWith('mlc.') && d.dataClass === 'phi').map((d) => d.key),
    );

    const offenders: string[] = [];
    for (const template of ROLE_TEMPLATES) {
      if (CLINICAL_CATEGORIES.has(template.category)) continue;
      const allowed = new Set(NON_CLINICAL_ALLOWANCES[template.key] ?? []);
      for (const key of template.permissions) {
        if (phiMlcKeys.has(key) && !allowed.has(key)) {
          offenders.push(`${template.key} → ${key}`);
        }
      }
    }

    expect(offenders, 'non-clinical roles holding medico-legal PHI keys').toEqual([]);
  });

  /** Positively: the roles that should hold these, do. */
  it('gives the emergency floor what it needs at 3 a.m.', () => {
    const er = new Set(role('doctor_emergency').permissions);
    for (const key of [
      'triage.record.create',
      'trauma.activation.create',
      'trauma.activation.standdown',
      'mlc.case.create',
      'mlc.injury.write',
      'mlc.report.sign',
      'mlc.death.write',
    ]) {
      expect(er.has(key), `doctor_emergency should hold ${key}`).toBe(true);
    }

    const nurse = new Set(role('nurse_er_triage').permissions);
    for (const key of [
      'triage.record.create',
      'triage.level.override',
      'trauma.activation.create',
      'mlc.case.create',
    ]) {
      expect(nurse.has(key), `nurse_er_triage should hold ${key}`).toBe(true);
    }

    const security = new Set(role('security_officer').permissions);
    expect(security.has('mlc.intimation.dispatch')).toBe(true);
  });

  /**
   * And negatively: the emergency floor cannot cancel a case, override the
   * discharge gate or read a sensitive one. Those are the Medical
   * Superintendent's, and a floor that could self-authorise them is a floor
   * where the override means nothing.
   */
  it('keeps the undo keys away from the people who would use them under pressure', () => {
    const er = new Set(role('doctor_emergency').permissions);
    for (const key of ['mlc.case.cancel', 'mlc.discharge.override']) {
      expect(er.has(key), `doctor_emergency must not hold ${key}`).toBe(false);
    }

    // `mlc.sensitive.read` is the exception, and deliberately so: the emergency
    // physician is usually the designated MLC officer and runs the MoHFW
    // protocol at 3 a.m. when no gynaecologist is on site. Writing an
    // examination they cannot read back would make them re-take a history the
    // survivor has already given once.
    expect(er.has('mlc.sensitive.write')).toBe(true);
    expect(er.has('mlc.sensitive.read')).toBe(true);

    // The rest of the emergency floor holds neither.
    const nurse = new Set(role('nurse_er_triage').permissions);
    expect(nurse.has('mlc.sensitive.read')).toBe(false);
    expect(nurse.has('mlc.sensitive.write')).toBe(false);
    expect(new Set(role('mrd_officer').permissions).has('mlc.sensitive.read')).toBe(false);

    const ms = new Set(role('medical_superintendent').permissions);
    for (const key of ['mlc.case.cancel', 'mlc.discharge.override', 'mlc.sensitive.read']) {
      expect(ms.has(key), `medical_superintendent should hold ${key}`).toBe(true);
    }
  });

  /**
   * A coder is not a witness. MRD reads the register, issues certified copies
   * and answers requisitions; it does not open cases or document injuries.
   */
  it('keeps the records office out of the examination room', () => {
    const mrd = new Set(role('mrd_officer').permissions);
    expect(mrd.has('mlc.report.export')).toBe(true);
    expect(mrd.has('mlc.register.read')).toBe(true);
    expect(mrd.has('mlc.case.create')).toBe(false);
    expect(mrd.has('mlc.injury.write')).toBe(false);
  });
});
