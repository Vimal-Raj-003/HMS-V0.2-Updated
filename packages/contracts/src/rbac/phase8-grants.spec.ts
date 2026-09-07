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
const PHASE_8_PREFIXES = [
  'console',
  'device',
  'ophtha',
  'procedure',
  'opdnursing',
  'cardio',
  'pulmo',
  'ent',
  'dental',
  'derm',
  'therapy',
  'wound',
  'nutrition',
  'slp',
  'pain',
] as const;

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
        'cardiopulmonary_technician',
        'audiologist',
        'dental_hygienist',
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
        'cardiopulmonary_technician',
        'audiologist',
        'dental_hygienist',
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
        'cardiopulmonary_technician',
        'dental_hygienist',
      ],
      opdnursing: ['nurse_opd', 'nurse_ward', 'nurse_er_triage', 'nurse_supervisor'],
      // The five device-heavy consoles. Every one of them is held by the same
      // general clinical roles — the *console* is narrowed by the licence and
      // the department, not by minting a role per specialty — plus the one
      // sub-role whose scope genuinely differs.
      cardio: [
        'medical_superintendent',
        'hod',
        'doctor_consultant_opd',
        'surgeon',
        'resident_doctor',
        'cardiopulmonary_technician',
      ],
      pulmo: [
        'medical_superintendent',
        'hod',
        'doctor_consultant_opd',
        'surgeon',
        'resident_doctor',
        'cardiopulmonary_technician',
      ],
      ent: [
        'medical_superintendent',
        'hod',
        'doctor_consultant_opd',
        'surgeon',
        'resident_doctor',
        'audiologist',
      ],
      dental: [
        'medical_superintendent',
        'hod',
        'doctor_consultant_opd',
        'surgeon',
        'resident_doctor',
        'dental_hygienist',
      ],
      derm: [
        'medical_superintendent',
        'hod',
        'doctor_consultant_opd',
        'surgeon',
        'resident_doctor',
        // The phototherapy cabin is an OPD treatment room.
        'nurse_opd',
      ],
      // The therapy spine is held by therapists of every discipline, plus the
      // doctors who refer into it and the desk that owns the authorisation.
      therapy: [
        'medical_superintendent',
        'hod',
        'doctor_consultant_opd',
        'surgeon',
        'resident_doctor',
        'therapist',
        'dietician',
        'insurance_desk',
      ],
      wound: [
        'medical_superintendent',
        'hod',
        'doctor_consultant_opd',
        'surgeon',
        'resident_doctor',
        'therapist',
        'nurse_opd',
        'nurse_ward',
        'nurse_icu',
        'nurse_supervisor',
      ],
      nutrition: [
        'medical_superintendent',
        'hod',
        'doctor_consultant_opd',
        'surgeon',
        'resident_doctor',
        'dietician',
      ],
      // Writing a swallow order and acknowledging one are held by different
      // people on purpose; the allow-list is the union, and the tests below
      // check the split itself.
      // The pain clinic. Prescribing and countersigning ship unassigned, so the
      // allow-list here covers only the ordinary clinic keys.
      pain: ['medical_superintendent', 'hod', 'doctor_consultant_opd', 'surgeon', 'resident_doctor'],
      slp: [
        'medical_superintendent',
        'hod',
        'doctor_consultant_opd',
        'surgeon',
        'resident_doctor',
        'therapist',
        'dietician',
        'nurse_opd',
        'nurse_ward',
        'nurse_icu',
        'kitchen_staff',
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

  it('never lets the technician who recorded a critical ECG acknowledge it', () => {
    // An acknowledgement is a handover to somebody who can act. A technician
    // closing the loop on their own tracing means the loop reads as closed and
    // nobody was told — which is exactly the failure the flag exists to catch.
    const tech = getRoleTemplate('cardiopulmonary_technician');
    expect(tech?.permissions).toContain('cardio.ecg.record');
    expect(tech?.permissions).not.toContain('cardio.ecg.acknowledge_critical');
    expect(tech?.permissions).not.toContain('cardio.ecg.interpret');
    expect(permission('cardio.ecg.acknowledge_critical').clinicalSafetyExempt).toBe(true);
  });

  it('never lets the technician who ran a spirometry interpret it', () => {
    const tech = getRoleTemplate('cardiopulmonary_technician');
    expect(tech?.permissions).toContain('pulmo.pft.perform');
    expect(tech?.permissions).not.toContain('pulmo.pft.interpret');
    expect(tech?.permissions).not.toContain('pulmo.sleep.sign');
    expect(tech?.permissions).not.toContain('pulmo.pap.prescribe');
  });

  it('lets the audiologist sign, because the audiogram is their profession', () => {
    // The one console where the person at the machine signs. Not a concession:
    // producing and interpreting the audiogram is the registered scope.
    const audiologist = getRoleTemplate('audiologist');
    expect(audiologist?.permissions).toContain('ent.audiology.perform');
    expect(audiologist?.permissions).toContain('ent.audiology.sign');
    expect(audiologist?.permissions).toContain('ent.hearing_aid.dispense');
    // And they do not sign the surgeon's examination.
    expect(audiologist?.permissions).not.toContain('ent.exam.sign');
  });

  it('lets the hygienist chart but never price or present a plan', () => {
    // A treatment plan is a quotation the patient will consent to and pay for.
    const hygienist = getRoleTemplate('dental_hygienist');
    expect(hygienist?.permissions).toContain('dental.chart.record');
    expect(hygienist?.permissions).toContain('dental.perio.record');
    expect(hygienist?.permissions).not.toContain('dental.plan.create');
    expect(hygienist?.permissions).not.toContain('dental.plan.present');
    expect(hygienist?.permissions).not.toContain('dental.plan.supersede');
  });

  it('gives the three documented ways past a database rule a holder and a reason', () => {
    // Each of these is the sanctioned route around a constraint that stays in
    // the database. The point of naming them is that the exception has an owner
    // and an audit row, rather than the rule having a hole.
    for (const key of ['dental.plan.supersede', 'derm.phototherapy.raise_ceiling']) {
      const def = permission(key);
      expect(def.risk, `${key} should be high risk`).toBe('high');
      expect(def.requiresReason, `${key} should demand a reason`).toBe(true);
      expect(def.action, `${key} should read as an override`).toBe('override');
    }
  });

  it('ships both documented overrides unassigned, for the admin to grant', () => {
    // The same stance as OP-025's delegated spectacle signature: a key that
    // exists to get past a database rule is not handed out with a job title. A
    // hospital decides who moves a phototherapy ceiling and who re-prices a
    // plan a patient already signed, and the grant is the decision.
    for (const key of ['derm.phototherapy.raise_ceiling', 'dental.plan.supersede']) {
      const holders = holdersOf(key).filter((h) => h !== 'super_admin');
      expect(holders, `${key} should ship unassigned`).toEqual([]);
    }

    // And in particular they are nowhere near the room that would use them.
    expect(holdersOf('derm.phototherapy.raise_ceiling')).not.toContain('nurse_opd');
    expect(holdersOf('dental.plan.supersede')).not.toContain('dental_hygienist');
    // The ordinary acts they gate the exception to are held normally.
    expect(getRoleTemplate('nurse_opd')?.permissions).toContain('derm.phototherapy.deliver');
    expect(getRoleTemplate('hod')?.permissions).toContain('dental.plan.present');
  });

  it('offers no key for typing a derived number', () => {
    // The QTc, the FEV1/FVC ratio, the four-frequency average, the PASI and the
    // dental chart are all computed. If any of them could be typed there would
    // be a permission for it — the absence is the proof.
    const forbidden = PERMISSION_CATALOGUE.filter((p) =>
      /(qtc|ratio|pta_avg|pasi|chart)\.(set|write|type|edit)/.test(p.key),
    );
    expect(forbidden).toEqual([]);
    // And the dental chart has a read key and a *log* write key, never a chart
    // write key.
    expect(PERMISSION_CATALOGUE.map((p) => p.key)).toContain('dental.chart.read');
    expect(PERMISSION_CATALOGUE.map((p) => p.key)).not.toContain('dental.chart.write');
    expect(permission('dental.chart.record').resource).toBe('dental_tooth_event');
  });

  it('never lets the person who writes a swallow order acknowledge it', () => {
    // The whole safety rule. A therapist assesses at eleven and writes level 4
    // fluids; the tray arriving at twelve was plated at ten. The order is not
    // in force until the kitchen and the ward say they have read it — and a
    // therapist acknowledging on their behalf is the failure, done tidily.
    const therapist = getRoleTemplate('therapist');
    expect(therapist?.permissions).toContain('slp.swallow_order.write');
    expect(therapist?.permissions).not.toContain('slp.swallow_order.acknowledge');

    const acknowledgers = holdersOf('slp.swallow_order.acknowledge').filter((h) => h !== 'super_admin');
    // The two places a tray is decided: the kitchen that plates it and the ward
    // that hands it over.
    expect(acknowledgers).toContain('kitchen_staff');
    expect(acknowledgers).toContain('nurse_ward');
    expect(acknowledgers).not.toContain('therapist');
    for (const who of acknowledgers) {
      expect(
        getRoleTemplate(who)?.permissions.includes('slp.swallow_order.write'),
        `${who} should not both write and acknowledge a swallow order`,
      ).toBe(false);
    }
  });

  it('lets everyone who might offer a patient a drink read the swallow order', () => {
    // A nurse who cannot see what a patient may safely swallow is a nurse who
    // will offer them a glass of water.
    for (const who of ['nurse_ward', 'nurse_icu', 'nurse_opd', 'dietician', 'kitchen_staff']) {
      expect(
        getRoleTemplate(who)?.permissions.includes('slp.swallow_order.read'),
        `${who} should be able to read the swallow order`,
      ).toBe(true);
    }
    // And the acknowledgement is never licence-gated: a ward that cannot
    // acknowledge because of a billing dispute is a ward on the old order.
    expect(permission('slp.swallow_order.acknowledge').clinicalSafetyExempt).toBe(true);
  });

  it('keeps the dietician out of the texture decision and the therapist out of the diet plan', () => {
    // A diet plan that contradicts the swallow finding is the aspiration.
    const dietician = getRoleTemplate('dietician');
    expect(dietician?.permissions).toContain('nutrition.plan.write');
    expect(dietician?.permissions).toContain('slp.swallow_order.read');
    expect(dietician?.permissions).not.toContain('slp.swallow_order.write');

    const therapist = getRoleTemplate('therapist');
    expect(therapist?.permissions).not.toContain('nutrition.plan.write');
  });

  it('puts extending a therapy authorisation with the desk that owns it', () => {
    // The eleventh session of a package of ten is either fraud or unpaid work.
    // The therapist asks; the desk that talks to the payer decides.
    const holders = holdersOf('therapy.authorisation.extend').filter((h) => h !== 'super_admin');
    expect(holders).toContain('insurance_desk');
    expect(holders).not.toContain('therapist');
    const def = permission('therapy.authorisation.extend');
    expect(def.risk).toBe('high');
    expect(def.requiresReason).toBe(true);
  });

  it('ships closing an open wound unassigned, like the other database overrides', () => {
    const holders = holdersOf('wound.status.override').filter((h) => h !== 'super_admin');
    expect(holders).toEqual([]);
    expect(permission('wound.status.override').requiresReason).toBe(true);
    // While recording a measurement is held right across the bedside.
    for (const who of ['nurse_ward', 'nurse_icu', 'nurse_opd', 'therapist']) {
      expect(getRoleTemplate(who)?.permissions.includes('wound.record'), who).toBe(true);
    }
  });

  it('offers no key for typing a wound area or a diet plan total', () => {
    // Both are summed in the database. If either could be typed there would be
    // a permission for it.
    const keys = PERMISSION_CATALOGUE.map((p) => p.key);
    expect(keys).not.toContain('wound.area.set');
    expect(keys).not.toContain('nutrition.totals.set');
    expect(keys).toContain('wound.record');
    expect(keys).toContain('nutrition.plan.write');
  });

  it('never lets one person prescribe an opioid and countersign it', () => {
    // Above the review threshold the prescription needs a second prescriber,
    // and a "reviewed by" carrying the prescriber's own name is the audit
    // finding rather than the control — so the two keys are never on one
    // template, and both ship unassigned for the hospital to place.
    const prescribers = holdersOf('pain.opioid.prescribe').filter((h) => h !== 'super_admin');
    const reviewers = holdersOf('pain.opioid.second_review').filter((h) => h !== 'super_admin');
    expect(prescribers).toEqual([]);
    expect(reviewers).toEqual([]);
    for (const role of ROLE_TEMPLATES) {
      const both =
        role.permissions.includes('pain.opioid.prescribe') &&
        role.permissions.includes('pain.opioid.second_review');
      expect(both, `${role.key} should not hold both halves of the opioid control`).toBe(false);
    }

    const prescribe = permission('pain.opioid.prescribe');
    expect(prescribe.risk).toBe('high');
    expect(prescribe.requiresStepUp).toBe(true);
    // The review key is *not* `requiresSecondPerson`: that flag means an act
    // needing a co-signer attached, and `PolicyGuard` would deny every user on
    // a route carrying it. This key is the second person's own act. What makes
    // it two people is the split above plus a database CHECK on the reviewer.
    const review = permission('pain.opioid.second_review');
    expect(review.risk).toBe('high');
    expect(review.requiresSecondPerson).toBeUndefined();
    expect(review.requiresReason).toBe(true);
  });

  it('offers no key at all for exceeding the annual steroid ceiling', () => {
    // Every other console in the phase has a documented way past its rule,
    // because every other rule has a legitimate exception. This one does not:
    // the ceiling sits at the permissive end of the published range, the harm
    // is cumulative and silent, and a clinic that needs to exceed it needs a
    // different treatment rather than a different permission.
    const keys = PERMISSION_CATALOGUE.map((p) => p.key);
    expect(keys.filter((k) => k.startsWith('pain.') && k.includes('steroid'))).toEqual([]);
    expect(keys).not.toContain('pain.intervention.override');
    // While recording the injection itself is an ordinary clinical key.
    expect(permission('pain.intervention.perform').risk).toBe('medium');
  });

  it('makes revoking a treatment agreement reasoned, because it stops every future opioid', () => {
    const revoke = permission('pain.agreement.revoke');
    expect(revoke.risk).toBe('high');
    expect(revoke.requiresReason).toBe(true);
    // Signing one is ordinary; ending one is not.
    expect(permission('pain.agreement.sign').risk).toBe('medium');
    expect(holdersOf('pain.agreement.sign')).toContain('doctor_consultant_opd');
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
