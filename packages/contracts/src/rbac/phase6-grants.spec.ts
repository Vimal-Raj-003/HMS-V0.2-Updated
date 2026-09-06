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
   * The pre-alert asymmetry, which is TR-001's argument applied to the road.
   *
   * A crew member who cannot warn the ER is a resus bay nobody prepared, so
   * raising one is `low` and unreasoned. Turning an inbound ambulance away is
   * the considered act.
   */
  it('keeps raising a pre-alert cheap and diverting one considered', () => {
    expect(permission('prehospital.prealert.raise').risk).toBe('low');
    expect(permission('prehospital.prealert.raise').requiresReason ?? false).toBe(false);
    expect(permission('prehospital.prealert.divert').requiresReason).toBe(true);
    expect(permission('fleet.trip.divert').requiresReason).toBe(true);
  });

  /**
   * Overriding a failed vehicle check sends an ambulance out with a known gap —
   * a missing defibrillator, an empty oxygen cylinder. Somebody owns that.
   */
  it('makes a checklist override name a person and a reason', () => {
    expect(permission('fleet.checklist.override').requiresReason).toBe(true);
    expect(permission('fleet.checklist.record').requiresReason ?? false).toBe(false);
  });

  /**
   * The crew writes the clinical record; the dispatcher does not. Keeping
   * `prehospital.*` off the dispatch bundle is what stops a fleet console
   * drifting into a chart.
   */
  it('separates the dispatch desk from the patient record', () => {
    const dispatcher = new Set(role('call_centre_agent').permissions);
    expect(dispatcher.has('fleet.trip.dispatch')).toBe(true);
    for (const key of ['prehospital.pcr.read', 'prehospital.pcr.write']) {
      expect(dispatcher.has(key), `call_centre_agent must not hold ${key}`).toBe(false);
    }

    const crew = new Set(role('ambulance_crew').permissions);
    expect(crew.has('prehospital.pcr.write')).toBe(true);
    expect(crew.has('prehospital.prealert.raise')).toBe(true);
    expect(crew.has('fleet.trip.dispatch')).toBe(false);
  });

  /**
   * The general form of the mis-anchored-grant failure, for every Phase 6 key.
   *
   * It has now happened twice. A scripted edit anchors on `permissions: [` and
   * silently skips any role whose array is written on one line, landing the
   * block on the *next* role instead — `MLC_SECURITY` on kitchen staff, and
   * orthopaedic keys on a dialysis technician. Nothing else catches it: the
   * types are fine, lint is fine, the seed writes the rows.
   *
   * So: every Phase 6 permission is declared here against the set of roles
   * allowed to hold it. A grant that lands anywhere else fails the build, and
   * adding a legitimate one means editing this list — which is the point.
   */
  it('gives every Phase 6 key only to roles that were meant to have it', () => {
    const ALLOWED: Readonly<Record<string, readonly string[]>> = {
      // OP-006. Held widely on purpose — `er.quickreg` is the key that gets an
      // unconscious patient a tag and a bay in thirty seconds.
      er: ['doctor_emergency', 'nurse_er_triage', 'receptionist'],
      triage: ['doctor_emergency', 'nurse_er_triage'],
      trauma: [
        'doctor_emergency',
        'nurse_er_triage',
        'surgeon',
        'anaesthetist',
        'intensivist',
        'resident_doctor',
        'mrd_officer',
        'quality_manager',
      ],
      mci: [
        'doctor_emergency',
        'medical_superintendent',
        'hospital_admin',
        'nurse_er_triage',
        'quality_manager',
      ],
      mlc: [
        'doctor_emergency',
        'nurse_er_triage',
        'surgeon',
        'doctor_ip',
        'intensivist',
        'doctor_consultant_opd',
        'mrd_officer',
        'security_officer',
        'medical_superintendent',
        'quality_manager',
        'hospital_admin',
      ],
      fleet: [
        'hospital_admin',
        'medical_superintendent',
        'call_centre_agent',
        'ambulance_crew',
        'receptionist',
        'nurse_ward',
        'nurse_icu',
        'doctor_ip',
        'biomedical_engineer',
        'quality_manager',
      ],
      prehospital: ['ambulance_crew', 'doctor_emergency', 'nurse_er_triage'],
      fracture: [
        'surgeon',
        'doctor_consultant_opd',
        'doctor_emergency',
        'doctor_ip',
        'resident_doctor',
        'radiologist',
        'nurse_opd',
        'therapist',
        'mrd_officer',
        'quality_manager',
      ],
      ortho: ['surgeon', 'doctor_consultant_opd', 'nurse_opd', 'therapist'],
    };

    const phase6 = new Set(PERMISSION_CATALOGUE.filter((p) => p.phase === 6).map((p) => p.key));
    const misplaced: string[] = [];

    for (const template of ROLE_TEMPLATES) {
      for (const key of template.permissions) {
        if (!phase6.has(key)) continue;
        const prefix = key.split('.')[0] ?? '';
        const allowed = ALLOWED[prefix];
        // A prefix with no entry is a new module whose grants nobody has
        // reviewed. Failing here is the correct, noisy outcome.
        if (allowed === undefined || !allowed.includes(template.key)) {
          misplaced.push(`${template.key} → ${key}`);
        }
      }
    }

    expect([...new Set(misplaced)].sort(), 'Phase 6 keys on roles not in the allow-list').toEqual([]);
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
