import { describe, expect, it } from 'vitest';
import {
  PERMISSION_CATALOGUE,
  SEGREGATION_OF_DUTIES_RULES,
  getPermission,
  isRegisteredPermission,
} from './permissions.js';
import { ROLE_TEMPLATES, getRoleTemplate } from './role-templates.js';
import { EVENT_TYPES, getEventDefinition } from '../events/registry.js';

/**
 * Phase 3 grants — the check that a specimen can become a signed report, and
 * that nothing on the way there can be switched off by an unpaid invoice.
 *
 * The two failure modes are the same two Phase 2 guards against, and both look
 * like something else when they happen:
 *
 *  1. A key registered and granted to nobody. `assertRegisteredPermission` runs
 *     at import, so the route loads and then denies every user; the bug report
 *     reads "the phlebotomy worklist is empty".
 *  2. A safety key a licence tier can gate. Nothing fails and nothing logs — a
 *     hospital in arrears quietly loses its critical-value alert. EN-040 §5 and
 *     D-10 make that a patient-safety defect, not a billing one.
 *
 * The assertions come from the §12 Permissions and §7 Domain Events sections of
 * OP-004, EN-004, EN-031, OP-008, EN-008 and OP-022, and from the separations in
 * docs/05 §Segregation of duties.
 */

const held = (role: string): ReadonlySet<string> => new Set(getRoleTemplate(role)?.permissions ?? []);

describe('Phase 3 permission catalogue', () => {
  it('registers the families the Phase 3 specs name', () => {
    const prefixes = [
      'lab.order.',
      'lab.sample.',
      'lab.result.',
      'lab.critical.',
      'lab.report.',
      'lab.qc.',
      'lab.autoval.',
      'lab.instrument.',
      'lab.interface.',
      'integration.lab.',
      'labq.',
      'rad.order.',
      'rad.study.',
      'rad.report.',
      'rad.critical.',
      'rad.dose.',
      'rad.image.',
      'rad.mwl.',
      'rad.pacs.',
      'rad.telerad.',
      'rad.peer_review.',
      'integration.rad.',
      'invest.',
    ];
    for (const prefix of prefixes) {
      const found = PERMISSION_CATALOGUE.filter((d) => d.key.startsWith(prefix) && d.phase === 3);
      expect(found.length, `no Phase 3 keys registered for "${prefix}"`).toBeGreaterThan(0);
    }
  });

  it('covers every key OP-004 §12 and EN-004 §12 name', () => {
    for (const key of [
      'lab.order.create',
      'lab.order.list',
      'lab.order.read',
      'lab.order.addon',
      'lab.order.cancel',
      'lab.sample.label',
      'lab.sample.collect',
      'lab.sample.reject',
      'lab.sample.receive',
      'lab.sample.custody',
      'lab.sample.update',
      'lab.result.enter',
      'lab.result.verify',
      'lab.result.validate',
      'lab.result.amend',
      'lab.result.read',
      'lab.result.sensitive.read',
      'lab.critical.notify',
      'lab.critical.read',
      'lab.report.generate',
      'lab.report.print',
      'lab.report.deliver',
      'lab.report.export',
      'lab.report.read',
      'lab.outsource.manage',
      'lab.master.configure',
      'lab.instrument.manage',
      'lab.instrument.downtime.record',
      'lab.interface.errors.resolve',
      'lab.autoval.configure',
      'lab.autoval.approve',
      'lab.autoval.sign',
      'lab.qc.configure',
      'lab.qc.record',
      'lab.qc.read',
      'lab.qc.unlock',
      'integration.lab.configure',
      'integration.lab.read',
      'integration.lab.raw.read',
      'integration.lab.replay',
      'integration.lab.send',
      'integration.lab.ingest',
    ]) {
      expect(isRegisteredPermission(key), `${key} is named by a Phase 3 lab spec but not registered`).toBe(
        true,
      );
    }
  });

  it('covers every key EN-031 §12 names', () => {
    for (const key of [
      'labq.qc.read',
      'labq.qc.enter',
      'labq.qc.manage',
      'labq.qc.approve',
      'labq.qc.void',
      'labq.qc.action',
      'labq.qc.release_override',
      'labq.eqa.manage',
      'labq.validation.manage',
      'labq.validation.approve',
      'labq.equipment.manage',
      'labq.environment.manage',
      'labq.competency.manage',
      'labq.checklist.manage',
      'labq.accreditation.manage',
      'labq.indicator.review',
      'labq.nc.manage',
      'labq.review.sign',
      'labq.auditpack.generate',
      'labq.assessor.grant',
      'labq.report.read',
    ]) {
      expect(isRegisteredPermission(key), `${key} is named by EN-031 §12 but not registered`).toBe(true);
    }
  });

  it('covers every key OP-008 §12, EN-008 §12 and OP-022 §12 name', () => {
    for (const key of [
      'rad.order.create',
      'rad.order.read',
      'rad.order.list',
      'rad.order.update',
      'rad.order.cancel',
      'rad.schedule.manage',
      'rad.mwl.manage',
      'rad.mwl.read',
      'rad.study.read',
      'rad.study.complete',
      'rad.study.reconcile',
      'rad.dose.record',
      'rad.dose.read',
      'rad.report.create',
      'rad.report.preliminary',
      'rad.report.sign',
      'rad.report.amend',
      'rad.report.deliver',
      'rad.report.print',
      'rad.report.read',
      'rad.critical.notify',
      'rad.critical.read',
      'rad.image.view',
      'rad.image.annotate',
      'rad.image.upload',
      'rad.image.share',
      'rad.image.export',
      'rad.peer_review.create',
      'rad.peer_review.read',
      'rad.pnpdt.manage',
      'rad.telerad.manage',
      'rad.telerad.read',
      'rad.configure',
      'rad.pacs.configure',
      'rad.pacs.read',
      'rad.pacs.retention',
      'rad.ai.read',
      'rad.mlc.read',
      'integration.rad.mpps',
      'integration.rad.study',
      'invest.worklist.read',
      'invest.schedule.manage',
      'invest.study.manage',
      'invest.media.create',
      'invest.media.read',
      'invest.media.manage',
      'invest.media.annotate',
      'invest.media.export',
      'invest.report.create',
      'invest.report.update',
      'invest.report.read',
      'invest.report.sign',
      'invest.report.cosign',
      'invest.report.amend',
      'invest.report.critical',
      'invest.report.deliver',
      'invest.configure',
    ]) {
      expect(
        isRegisteredPermission(key),
        `${key} is named by a Phase 3 imaging spec but not registered`,
      ).toBe(true);
    }
  });

  /**
   * EN-040 §5 and §14 AC-20, and D-10.
   *
   * "Clinical safety is never gated … critical-value alerts and escalation."
   * A hospital with an unpaid invoice still gets its critical potassium and its
   * critical head CT. Raising the alert and reading it are both on the path, so
   * both are exempt — an alert nobody can open is not an alert.
   */
  it('keeps every critical-value path outside licence gating', () => {
    for (const key of [
      'lab.critical.notify',
      'lab.critical.read',
      'rad.critical.notify',
      'rad.critical.read',
      'invest.report.critical',
    ]) {
      expect(getPermission(key)?.clinicalSafetyExempt, `${key} must never be licence-gateable`).toBe(true);
    }
    // And the acknowledgement half of the loop, registered in Phase 2, is still exempt.
    expect(getPermission('opd.result.acknowledge')?.clinicalSafetyExempt).toBe(true);
  });

  it('marks the dangerous Phase 3 keys as dangerous', () => {
    // OP-004 §5: HIV, serology, genetic and molecular results. The strongest
    // confidentiality flags the catalogue offers, because the harm from a leak
    // here is not "an inconvenience" — it is employment, insurance and family.
    const sensitive = getPermission('lab.result.sensitive.read');
    expect(sensitive?.sensitiveGrant).toBe(true);
    expect(sensitive?.requiresReason).toBe(true);
    expect(sensitive?.requiresStepUp).toBe(true);
    expect(sensitive?.phiRead).toBe(true);
    expect(sensitive?.risk).toBe('critical');

    // EN-031 §5: the only lawful route past the QC release gate. Lab Director
    // only, reasoned, audited and reported monthly.
    const override = getPermission('labq.qc.release_override');
    expect(override?.sensitiveGrant).toBe(true);
    expect(override?.requiresReason).toBe(true);
    expect(override?.requiresStepUp).toBe(true);
    expect(override?.risk).toBe('critical');

    // PC-PNDT is criminal law. The recording clinician is personally liable.
    const pnpdt = getPermission('rad.pnpdt.manage');
    expect(pnpdt?.sensitiveGrant).toBe(true);
    expect(pnpdt?.requiresReason).toBe(true);
    expect(pnpdt?.requiresStepUp).toBe(true);
    expect(pnpdt?.risk).toBe('critical');

    // Purged pixels do not come back. EN-008 §5 requires two approvals.
    const retention = getPermission('rad.pacs.retention');
    expect(retention?.requiresSecondPerson).toBe(true);
    expect(retention?.sensitiveGrant).toBe(true);
    expect(retention?.requiresReason).toBe(true);

    // Signing an auto-validation rule set releases results with no human in the
    // loop for as long as it stays live.
    expect(getPermission('lab.autoval.sign')?.sensitiveGrant).toBe(true);
    expect(getPermission('lab.autoval.sign')?.requiresStepUp).toBe(true);

    // A time-boxed outsider account inside the quality system.
    expect(getPermission('labq.assessor.grant')?.sensitiveGrant).toBe(true);
    expect(getPermission('labq.assessor.grant')?.requiresReason).toBe(true);

    // Images and reports leaving the building.
    for (const key of ['rad.image.export', 'lab.report.export', 'invest.media.export']) {
      expect(getPermission(key)?.requiresReason, `${key} must capture a reason`).toBe(true);
      expect(getPermission(key)?.phiRead, `${key} must be audited as a PHI read`).toBe(true);
    }
  });

  /**
   * `rad.image.view` and `rad.telerad.read` carry a scope the catalogue has no
   * field for: care-team-only with break-glass, and assigned-studies-only. The
   * description is where an administrator reading the permission tree learns
   * that, so the description has to say it.
   */
  it('says in the description where ABAC, not the key, does the scoping', () => {
    const view = getPermission('rad.image.view')!;
    expect(view.description).toMatch(/ABAC/);
    expect(view.description).toMatch(/care-team|break-glass/i);
    expect(view.phiRead).toBe(true);

    const telerad = getPermission('rad.telerad.read')!;
    expect(telerad.description).toMatch(/ABAC/);
    expect(telerad.description).toMatch(/assigned/i);

    const study = getPermission('rad.study.read')!;
    expect(study.description).toMatch(/ABAC/);
  });

  it('demands a reason wherever the record would otherwise be unreadable afterwards', () => {
    for (const key of [
      'lab.order.cancel',
      'lab.sample.reject',
      'lab.sample.custody',
      'lab.result.amend',
      'lab.master.configure',
      'lab.qc.unlock',
      'labq.qc.void',
      'labq.qc.action',
      'rad.order.cancel',
      'rad.report.amend',
      'rad.study.reconcile',
      'rad.image.share',
      'rad.mlc.read',
      'invest.media.manage',
      'invest.report.amend',
      'lab.interface.errors.resolve',
      'integration.lab.replay',
    ]) {
      expect(getPermission(key)?.requiresReason, `${key} must capture a reason`).toBe(true);
    }
  });

  it('classifies everything that touches a patient result as PHI', () => {
    const clinical = PERMISSION_CATALOGUE.filter(
      (d) =>
        d.phase === 3 &&
        (d.key.startsWith('lab.result') ||
          d.key.startsWith('lab.sample') ||
          d.key.startsWith('lab.critical') ||
          d.key.startsWith('lab.report') ||
          d.key.startsWith('rad.report') ||
          d.key.startsWith('rad.critical') ||
          d.key.startsWith('rad.image') ||
          d.key.startsWith('rad.dose') ||
          d.key.startsWith('invest.report') ||
          d.key.startsWith('invest.media')),
    );
    expect(clinical.length).toBeGreaterThan(25);
    for (const def of clinical) {
      expect(def.dataClass, `${def.key} touches a patient result and must be PHI-classed`).toBe('phi');
    }

    // The quality system is not a patient record. A control material is not a
    // person, and classifying `labq.*` as PHI would mask the very fields an
    // assessor is entitled to read.
    const quality = PERMISSION_CATALOGUE.filter(
      (d) => d.phase === 3 && d.key.startsWith('labq.') && d.key !== 'labq.qc.release_override',
    );
    expect(quality.length).toBeGreaterThan(15);
    for (const def of quality) {
      expect(def.dataClass, `${def.key} carries no patient data`).not.toBe('phi');
    }
  });

  it('writes a READ_PHI audit row for every Phase 3 key that opens a result or an image', () => {
    for (const key of [
      'lab.order.list',
      'lab.order.read',
      'lab.result.read',
      'lab.result.sensitive.read',
      'lab.critical.read',
      'lab.report.read',
      'lab.report.print',
      'rad.study.read',
      'rad.image.view',
      'rad.report.read',
      'rad.critical.read',
      'rad.dose.read',
      'rad.mlc.read',
      'rad.telerad.read',
      'invest.report.read',
      'invest.media.read',
      'integration.lab.raw.read',
    ]) {
      expect(getPermission(key)?.phiRead, `${key} must be audited as a PHI read`).toBe(true);
    }
  });
});

describe('Phase 3 role grants', () => {
  it('grants every Phase 3 key to at least one role', () => {
    const granted = new Set(ROLE_TEMPLATES.flatMap((t) => t.permissions));
    const orphans = PERMISSION_CATALOGUE.filter((d) => d.phase === 3 && !granted.has(d.key)).map(
      (d) => d.key,
    );
    expect(orphans, 'Phase 3 keys held by no role template').toEqual([]);
  });

  /** OP-004 §12: "Phlebotomist: sample.*". The pre-analytical loop and nothing else. */
  it('lets the phlebotomist take the sample and never see the answer', () => {
    const p = held('phlebotomist');
    for (const key of [
      'lab.sample.label',
      'lab.sample.collect',
      'lab.sample.reject',
      'lab.sample.receive',
      'lab.sample.custody',
      'lab.order.list',
    ]) {
      expect(p.has(key), `a phlebotomist should hold ${key}`).toBe(true);
    }
    for (const key of ['lab.result.enter', 'lab.result.read', 'lab.result.verify', 'lab.result.validate']) {
      expect(p.has(key), `a phlebotomist must NOT hold ${key}`).toBe(false);
    }
  });

  /**
   * docs/05 row 33 ("result entry, no validation") and OP-004 §5 two-level
   * release. The bench enters and technically verifies; authorisation is the
   * pathologist's signature, and the QC decisions that would let a bad run
   * through are not the bench's to make.
   */
  it('lets the bench enter and verify, and never authorise', () => {
    const t = held('lab_technician');
    for (const key of [
      'lab.result.enter',
      'lab.result.verify',
      'lab.qc.record',
      'lab.qc.read',
      'labq.qc.enter',
      'labq.qc.action',
      'lab.interface.errors.resolve',
      'lab.instrument.downtime.record',
    ]) {
      expect(t.has(key), `a lab technician should hold ${key}`).toBe(true);
    }
    for (const key of [
      'lab.result.validate',
      'lab.result.amend',
      'lab.result.sensitive.read',
      'lab.critical.notify',
      'labq.qc.approve',
      'labq.qc.release_override',
      'lab.qc.configure',
      'lab.qc.unlock',
      'lab.autoval.sign',
      'lab.autoval.configure',
    ]) {
      expect(t.has(key), `a lab technician must NOT hold ${key}`).toBe(false);
    }
  });

  it('gives the pathologist authorisation, the critical loop and the Director-only decisions', () => {
    const path = held('pathologist');
    for (const key of [
      'lab.result.validate',
      'lab.result.amend',
      'lab.result.sensitive.read',
      'lab.critical.notify',
      'lab.critical.read',
      'lab.report.generate',
      'lab.qc.unlock',
      'lab.autoval.sign',
      'labq.qc.approve',
      'labq.qc.release_override',
      'labq.validation.approve',
      'labq.review.sign',
    ]) {
      expect(path.has(key), `a pathologist should hold ${key}`).toBe(true);
    }
    // docs/05: enterer ≠ validator. The authoriser does not also key in numbers.
    for (const key of ['lab.result.enter', 'lab.result.verify', 'labq.qc.enter']) {
      expect(path.has(key), `a pathologist must NOT hold ${key}`).toBe(false);
    }
  });

  /**
   * The separation the task of running QC creates: EN-031 §5 lets exactly one
   * person authorise release past an out-of-control analyte, and it is not the
   * person who ran the control.
   */
  it('never lets the same template run QC and authorise release past its own failure', () => {
    const both = ROLE_TEMPLATES.filter(
      (t) => t.permissions.includes('labq.qc.enter') && t.permissions.includes('labq.qc.release_override'),
    ).map((t) => t.key);
    expect(both, 'a QC operator must not authorise release past their own run').toEqual([]);

    // And the override is a Director grant, held by exactly one template.
    const holders = ROLE_TEMPLATES.filter((t) => t.permissions.includes('labq.qc.release_override')).map(
      (t) => t.key,
    );
    expect(holders).toEqual(['pathologist']);
  });

  it('gives the Lab Quality Manager the rules and never the bench or the signature', () => {
    const q = held('lab_quality_manager');
    for (const key of [
      'labq.qc.manage',
      'labq.qc.void',
      'labq.eqa.manage',
      'labq.validation.manage',
      'labq.equipment.manage',
      'labq.environment.manage',
      'labq.checklist.manage',
      'labq.accreditation.manage',
      'labq.nc.manage',
      'labq.auditpack.generate',
      'lab.qc.configure',
      'lab.autoval.configure',
      'lab.autoval.approve',
    ]) {
      expect(q.has(key), `the Lab Quality Manager should hold ${key}`).toBe(true);
    }
    // EN-004 §5: "rule set edits require QM approval + pathologist sign".
    expect(q.has('lab.autoval.sign'), 'an author must not sign their own rule set live').toBe(false);
    // EN-031 §12 gives `labq.qc.enter` to the technician, not the manager.
    expect(q.has('labq.qc.enter')).toBe(false);
    expect(q.has('labq.qc.release_override')).toBe(false);
    expect(q.has('lab.result.validate')).toBe(false);
  });

  /**
   * OP-008 §5: reports are signed only by a registered radiologist. The
   * technologist who chose the exposure is not an independent reader of it.
   */
  it('never lets a technologist sign a radiology report', () => {
    const tech = held('radiology_technician');
    for (const key of [
      'rad.study.complete',
      'rad.study.reconcile',
      'rad.dose.record',
      'rad.mwl.manage',
      'rad.image.upload',
      'rad.order.update',
    ]) {
      expect(tech.has(key), `a radiographer should hold ${key}`).toBe(true);
    }
    for (const key of [
      'rad.report.sign',
      'rad.report.create',
      'rad.report.preliminary',
      'rad.report.amend',
      'rad.critical.notify',
      'rad.pnpdt.manage',
      'rad.peer_review.create',
    ]) {
      expect(tech.has(key), `a radiographer must NOT hold ${key}`).toBe(false);
    }

    const both = ROLE_TEMPLATES.filter(
      (t) => t.permissions.includes('rad.study.complete') && t.permissions.includes('rad.report.sign'),
    ).map((t) => t.key);
    expect(both, 'the person who made the exposure must not sign the read').toEqual([]);
  });

  it('gives the radiologist the reading room, including the statutory Form F register', () => {
    const r = held('radiologist');
    for (const key of [
      'rad.image.view',
      'rad.image.annotate',
      'rad.report.create',
      'rad.report.preliminary',
      'rad.report.sign',
      'rad.report.amend',
      'rad.critical.notify',
      'rad.critical.read',
      'rad.peer_review.create',
      'rad.pnpdt.manage',
      'rad.dose.read',
      'rad.mlc.read',
      'rad.ai.read',
    ]) {
      expect(r.has(key), `a radiologist should hold ${key}`).toBe(true);
    }
    // The reading room does not run the scanner.
    expect(r.has('rad.study.complete')).toBe(false);
    expect(r.has('rad.dose.record')).toBe(false);
  });

  /**
   * docs/05 row 14 and OP-008 §12 ("Resident: report.create/preliminary, no
   * sign") and OP-022 §12 ("no sign where cosign_required"). A resident drafts
   * everything and finalises nothing — a co-signature the author can supply is
   * not a co-signature.
   */
  it('lets a resident draft a report and never finalise one', () => {
    const r = held('resident_doctor');
    for (const key of [
      'lab.result.read',
      'rad.report.create',
      'rad.report.preliminary',
      'invest.report.create',
      'invest.report.update',
      'lab.order.create',
      'rad.order.create',
    ]) {
      expect(r.has(key), `a resident should hold ${key}`).toBe(true);
    }
    for (const key of [
      'rad.report.sign',
      'rad.report.amend',
      'invest.report.sign',
      'invest.report.cosign',
      'invest.report.amend',
      'lab.result.validate',
      'lab.result.sensitive.read',
      'lab.critical.notify',
      'rad.critical.notify',
      'rad.pnpdt.manage',
      'lab.order.cancel',
      'rad.order.cancel',
    ]) {
      expect(r.has(key), `a resident must NOT hold ${key}`).toBe(false);
    }
  });

  it('lets a consultant order diagnostics, read what comes back and co-sign', () => {
    const d = held('doctor_consultant_opd');
    for (const key of [
      'lab.order.create',
      'lab.order.addon',
      'lab.order.cancel',
      'lab.result.read',
      'lab.critical.read',
      'rad.order.create',
      'rad.image.view',
      'rad.report.read',
      'rad.critical.read',
      'invest.report.sign',
      'invest.report.cosign',
      'invest.report.critical',
    ]) {
      expect(d.has(key), `a consultant should hold ${key}`).toBe(true);
    }
    // Ordering a test is not running the laboratory.
    for (const key of [
      'lab.result.enter',
      'lab.result.validate',
      'lab.sample.collect',
      'lab.qc.record',
      'rad.report.sign',
      'rad.study.complete',
    ]) {
      expect(d.has(key), `a consultant must NOT hold ${key}`).toBe(false);
    }
  });

  /** OP-004 §12: "Front office: order.create (walk-in), report.print/deliver". No results. */
  it('gives the front desk walk-in orders and report handover, and no result at all', () => {
    const r = held('receptionist');
    for (const key of [
      'lab.order.create',
      'lab.report.print',
      'lab.report.deliver',
      'rad.order.create',
      'rad.schedule.manage',
      'invest.schedule.manage',
    ]) {
      expect(r.has(key), `the front desk should hold ${key}`).toBe(true);
    }
    for (const key of [
      'lab.result.read',
      'lab.result.sensitive.read',
      'rad.image.view',
      'rad.report.read',
      'invest.report.read',
    ]) {
      expect(r.has(key), `the front desk must NOT hold ${key}`).toBe(false);
    }
  });

  /**
   * OP-004 §12 names the Pathologist for `lab.result.sensitive.read`, and only
   * the Pathologist. A treating clinician gets it as a deliberate, named grant
   * on top of the template — which is what "restricted" has to mean if it is to
   * mean anything.
   */
  it('keeps confidential results behind a single named template', () => {
    const holders = ROLE_TEMPLATES.filter((t) => t.permissions.includes('lab.result.sensitive.read')).map(
      (t) => t.key,
    );
    expect(holders).toEqual(['pathologist']);
  });

  it('keeps the Form F register with the signing radiologist alone', () => {
    const holders = ROLE_TEMPLATES.filter((t) => t.permissions.includes('rad.pnpdt.manage')).map(
      (t) => t.key,
    );
    expect(holders).toEqual(['radiologist']);
  });

  /** EN-008 §5: a purge needs two approvals, so two distinct templates hold the key. */
  it('puts image retention in two pairs of hands', () => {
    const holders = ROLE_TEMPLATES.filter((t) => t.permissions.includes('rad.pacs.retention')).map(
      (t) => t.key,
    );
    expect(holders.sort()).toEqual(['hospital_admin', 'it_admin']);
  });

  it('gives the device token the analyzer and modality feeds and nothing a person would need', () => {
    const dev = held('device');
    const phase3 = new Set(PERMISSION_CATALOGUE.filter((d) => d.phase === 3).map((d) => d.key));
    const devicePhase3 = [...dev].filter((k) => phase3.has(k)).sort();
    expect(devicePhase3).toEqual([
      'integration.lab.ingest',
      'integration.lab.send',
      'integration.rad.mpps',
      'integration.rad.study',
    ]);
  });

  it('gives patients and non-clinical partners no Phase 3 key at all', () => {
    const phase3 = new Set(PERMISSION_CATALOGUE.filter((d) => d.phase === 3).map((d) => d.key));
    // The referring doctor is the one external role Phase 3 touches — OP-008 §12
    // gives them image.view and report.read for their own patients. PE-001
    // brings the patient's own-report scope in Phase 10.
    for (const key of ['patient', 'family_attendant', 'corporate_hr_client', 'payer_user', 'vendor']) {
      const leaked = [...held(key)].filter((k) => phase3.has(k));
      expect(leaked, `${key} must hold no Phase 3 key`).toEqual([]);
    }

    const referrer = [...held('referring_doctor')].filter((k) => phase3.has(k)).sort();
    expect(referrer).toEqual([
      'invest.report.read',
      'lab.report.read',
      'rad.image.view',
      'rad.report.read',
      'rad.study.read',
    ]);
  });

  it('keeps the auditor read-only across the whole of diagnostics', () => {
    const auditor = getRoleTemplate('auditor')!;
    const phase3 = auditor.permissions.filter((k) => getPermission(k)!.phase === 3);
    expect(phase3.length).toBeGreaterThan(5);
    for (const key of phase3) {
      expect(['read', 'list'], `auditor must not hold ${key}`).toContain(getPermission(key)!.action);
    }
  });

  it('holds no template on both sides of a blocking Phase 3 separation rule', () => {
    const phase3Rules = SEGREGATION_OF_DUTIES_RULES.filter(
      (r) => r.mode === 'block' && getPermission(r.permA)?.phase === 3,
    );
    expect(phase3Rules.length).toBeGreaterThanOrEqual(5);
    for (const rule of phase3Rules) {
      const both = ROLE_TEMPLATES.filter(
        (t) => t.permissions.includes(rule.permA) && t.permissions.includes(rule.permB),
      ).map((t) => t.key);
      expect(both, `${rule.permA} + ${rule.permB} held by the same template: ${rule.reason}`).toEqual([]);
    }
  });
});

/**
 * Phase 3 domain events.
 *
 * `OutboxWriter.emit()` refuses an unregistered type, and the emit happens in
 * the same transaction as the result it describes — so a missing entry here does
 * not degrade to a warning, it rolls the result back.
 */
describe('Phase 3 domain events', () => {
  const PHASE_3_EVENTS = [
    // OP-004
    'lab.order.created',
    'lab.order.cancelled',
    'lab.order.addon',
    'lab.sample.collected',
    'lab.sample.dispatched',
    'lab.sample.received',
    'lab.sample.rejected',
    'lab.sample.accessioned',
    'lab.result.entered',
    'lab.result.verified',
    'lab.result.final',
    'lab.result.amended',
    'lab.result.critical',
    'lab.critical.acknowledged',
    'lab.report.generated',
    'lab.report.delivered',
    'lab.report.handed_over',
    'lab.qc.violation',
    'lab.qc.released',
    'lab.tat.breached',
    'lab.outsource.dispatched',
    'lab.outsource.received',
    'lab.notifiable.detected',
    // EN-004
    'lab_if.instrument.created',
    'lab_if.instrument.updated',
    'lab_if.instrument.connected',
    'lab_if.instrument.disconnected',
    'lab_if.instrument.error',
    'lab_if.instrument.maintenance',
    'lab_if.order.sent',
    'lab_if.order.acked',
    'lab_if.order.nak',
    'lab_if.order.failed',
    'lab.result.instrument_received',
    'lab_if.result.unmatched',
    'lab_if.result.unmapped',
    'lab_if.result.patient_mismatch',
    'lab_if.autoval.verified',
    'lab_if.autoval.final',
    'lab_if.autoval.exception',
    'lab_if.qc.result_recorded',
    'lab_if.qc.violation',
    'lab_if.qc.lockout',
    'lab_if.qc.unlock',
    'lab_if.downtime.started',
    'lab_if.downtime.ended',
    // EN-031
    'labq.qc.recorded',
    'labq.qc.out_of_control',
    'labq.qc.corrective_action_recorded',
    'labq.qc.released_with_authorisation',
    'labq.qc.missed_schedule',
    'labq.eqa.cycle_due',
    'labq.eqa.submitted',
    'labq.eqa.unsatisfactory',
    'labq.validation.approved',
    'labq.calibration.due',
    'labq.calibration.overdue',
    'labq.instrument.requalification_required',
    'labq.environment.excursion',
    'labq.competency.expiring',
    'labq.competency.expired',
    'labq.nonconformity.raised',
    'labq.nonconformity.closed',
    'labq.auditpack.generated',
    // OP-008
    'rad.order.received',
    'rad.order.scheduled',
    'rad.order.arrived',
    'rad.order.cancelled',
    'rad.mwl.published',
    'rad.mwl.removed',
    'rad.study.started',
    'rad.study.available',
    'rad.study.completed',
    'rad.study.unmatched',
    'rad.report.preliminary',
    'rad.report.final',
    'rad.report.amended',
    'rad.result.critical',
    'rad.critical.acknowledged',
    'rad.followup.recommended',
    'rad.dose.recorded',
    'rad.dose.threshold_exceeded',
    'rad.drl.exceeded',
    'rad.contrast.reaction',
    'rad.tat.breached',
    'rad.room.blocked',
    'rad.repeat.logged',
    // EN-008
    'pacs.modality.registered',
    'pacs.modality.offline',
    'pacs.modality.online',
    'pacs.server.degraded',
    'pacs.server.failover',
    'pacs.mwl.created',
    'pacs.mwl.updated',
    'pacs.mwl.removed',
    'pacs.study.in_progress',
    'pacs.study.acquired',
    'pacs.study.incomplete',
    'pacs.study.images_available',
    'pacs.study.reported_object_stored',
    'pacs.study.archived',
    'pacs.study.restored',
    'pacs.study.purged',
    'pacs.study.unmatched',
    'pacs.study.reconciled',
    'pacs.study.rejected',
    'pacs.study.merged',
    'pacs.study.viewed',
    'pacs.study.downloaded',
    'pacs.study.exported',
    'pacs.study.shared',
    'pacs.share_link.created',
    'pacs.share_link.opened',
    'pacs.share_link.expired',
    'pacs.share_link.revoked',
    'pacs.media.issued',
    'pacs.telerad.assigned',
    'pacs.telerad.pushed',
    'pacs.telerad.report_received',
    'pacs.telerad.sla_breached',
    'pacs.dose.recorded',
    'pacs.dose.threshold_exceeded',
    'pacs.ai.result_received',
    'pacs.ai.critical_flag',
    'pacs.replication.lagging',
    'pacs.replication.restored',
    // OP-022
    'investigation.scheduled',
    'investigation.checked_in',
    'investigation.started',
    'investigation.done',
    'investigation.media.added',
    'investigation.media.detached',
    'investigation.report.draft',
    'investigation.report.cosign.requested',
    'investigation.report.cosign.approved',
    'investigation.report.final',
    'investigation.report.amended',
    'investigation.critical.flagged',
    'investigation.critical.acknowledged',
    'investigation.tat.breached',
    'investigation.equipment.down',
  ] as const;

  it('registers every event the Phase 3 specs name', () => {
    for (const type of PHASE_3_EVENTS) {
      expect(EVENT_TYPES, `${type} must be registered before any producer can emit it`).toContain(type);
    }
  });

  it('keeps clinical, medico-legal and accreditation facts for the statutory seven years', () => {
    for (const type of [
      'lab.result.final',
      'lab.result.critical',
      'lab.critical.acknowledged',
      'lab.sample.collected',
      'lab.report.generated',
      'lab.notifiable.detected',
      'rad.report.final',
      'rad.result.critical',
      'rad.critical.acknowledged',
      'rad.dose.recorded',
      'rad.repeat.logged',
      'rad.contrast.reaction',
      'pacs.study.viewed',
      'pacs.study.purged',
      'pacs.media.issued',
      'investigation.report.final',
      'investigation.critical.flagged',
      'labq.qc.out_of_control',
      'labq.qc.released_with_authorisation',
      'labq.eqa.unsatisfactory',
      'labq.competency.expired',
      'labq.auditpack.generated',
    ]) {
      expect(getEventDefinition(type)?.retentionDays, `${type} is evidence and must outlive the outbox`).toBe(
        2555,
      );
    }
  });

  /**
   * The task's split, stated as an assertion: accreditation evidence is
   * long-lived, interface chatter is not. A link that flapped at 02:00 last
   * March is worth nothing to anybody; the QC decision made because of it is
   * worth everything to an assessor.
   */
  it('keeps interface chatter short and accreditation evidence long', () => {
    for (const type of [
      'lab_if.instrument.connected',
      'lab_if.instrument.disconnected',
      'lab_if.instrument.error',
      'lab_if.order.sent',
      'lab_if.order.acked',
      'lab_if.order.nak',
      'lab_if.order.failed',
      'pacs.modality.offline',
      'pacs.replication.lagging',
      'pacs.mwl.created',
    ]) {
      expect(getEventDefinition(type)!.retentionDays, `${type} is chatter`).toBeLessThanOrEqual(90);
    }

    const chatter = getEventDefinition('lab_if.instrument.disconnected')!.retentionDays;
    for (const type of [
      'labq.qc.recorded',
      'labq.validation.approved',
      'labq.nonconformity.closed',
      'lab_if.autoval.final',
      'lab_if.qc.lockout',
    ]) {
      expect(
        getEventDefinition(type)!.retentionDays,
        `${type} is accreditation evidence, not chatter`,
      ).toBeGreaterThan(chatter);
    }

    // Indicators sit in between: long enough for a year-on-year comparison,
    // nowhere near long enough to be evidence.
    for (const type of ['lab.tat.breached', 'rad.tat.breached', 'investigation.tat.breached']) {
      const days = getEventDefinition(type)!.retentionDays;
      expect(days).toBeGreaterThanOrEqual(365);
      expect(days).toBeLessThan(2555);
    }
  });

  it('marks the PHI-bearing Phase 3 events honestly, and the machine-only ones honestly too', () => {
    for (const type of [
      'lab.order.created',
      'lab.sample.rejected',
      'lab.result.final',
      'lab.result.critical',
      'rad.study.completed',
      'rad.report.final',
      'rad.dose.recorded',
      'pacs.study.viewed',
      'pacs.mwl.created',
      'lab_if.result.patient_mismatch',
      'investigation.report.final',
    ]) {
      expect(getEventDefinition(type)?.containsPhi, `${type} carries patient data`).toBe(true);
    }

    // A control material, an analyzer link and a storage tier are not people.
    // Marking these PHI would make the relay redact fields that carry no patient
    // data and hide the machine log from the engineers who need to read it.
    for (const type of [
      'labq.qc.recorded',
      'labq.qc.out_of_control',
      'labq.eqa.submitted',
      'labq.environment.excursion',
      'lab_if.instrument.disconnected',
      'lab_if.qc.lockout',
      'lab.qc.violation',
      'pacs.modality.offline',
      'pacs.replication.lagging',
      'rad.room.blocked',
    ]) {
      expect(getEventDefinition(type)?.containsPhi, `${type} carries no patient data`).toBe(false);
    }
  });

  /**
   * D-10 in payload form. Release is never withheld, and authorisation needs
   * either a confirmed read-back or a documented escalation — so the closing
   * event has to be able to say which of the two happened. A boolean would
   * collapse "we reached the doctor" and "we could not, and escalated" into the
   * same fact, and the NABL exception KPI is built on the difference.
   */
  it('lets the critical-value loop close either way, and says which', () => {
    const def = getEventDefinition('lab.critical.acknowledged')!;
    const base = {
      alertId: '0194f2c0-0000-7000-8000-000000000001',
      resultId: '0194f2c0-0000-7000-8000-000000000002',
      patientId: '0194f2c0-0000-7000-8000-000000000003',
      outcome: 'read_back_confirmed',
      calledByUserId: '0194f2c0-0000-7000-8000-000000000004',
      informedPersonName: 'Dr A Menon',
      escalationTier: null,
      minutesFromDetection: 12,
      acknowledgedAt: '2026-08-22T10:00:00.000Z',
    };
    expect(def.schema.safeParse(base).success).toBe(true);
    expect(
      def.schema.safeParse({ ...base, outcome: 'clinician_unreachable_escalated', escalationTier: 2 })
        .success,
    ).toBe(true);
    // A close with no named human is not documented communication.
    const { informedPersonName: _n, ...withoutName } = base;
    expect(def.schema.safeParse(withoutName).success).toBe(false);
    expect(def.schema.safeParse({ ...base, outcome: 'assumed_delivered' }).success).toBe(false);
  });

  /**
   * `lab.outsource.dispatched` is the one Phase 3 event that carries money.
   * `lab_outsource_dispatches.partner_cost` is `numeric(14,2)`; a JSON number
   * would go through IEEE-754 on the way to the cost centre and be wrong by a
   * paisa on every manifest.
   */
  it('carries the referral-lab cost as a decimal string, never a number', () => {
    const def = getEventDefinition('lab.outsource.dispatched')!;
    const base = {
      dispatchId: '0194f2c0-0000-7000-8000-000000000001',
      referralLabId: '0194f2c0-0000-7000-8000-000000000002',
      manifestNo: 'OSD/2026/00041',
      sampleCount: 3,
      testCount: 7,
      partnerCost: '4820.50',
      currency: 'INR',
      dispatchedBy: '0194f2c0-0000-7000-8000-000000000003',
      dispatchedAt: '2026-08-22T10:00:00.000Z',
    };
    expect(def.schema.safeParse(base).success).toBe(true);
    expect(def.schema.safeParse({ ...base, partnerCost: null }).success).toBe(true);
    expect(def.schema.safeParse({ ...base, partnerCost: 4820.5 }).success).toBe(false);
    expect(def.schema.safeParse({ ...base, partnerCost: '4820.505' }).success).toBe(false);
  });

  /**
   * EN-008 §5: "never silently attach to the wrong patient". The reconciliation
   * event has to name the person who decided and the reason they gave, or the
   * decision is unattributable a year later when it turns out to be wrong.
   */
  it('names a human and a reason on every study reconciliation', () => {
    const def = getEventDefinition('pacs.study.reconciled')!;
    const base = {
      studyId: '0194f2c0-0000-7000-8000-000000000001',
      correctionId: '0194f2c0-0000-7000-8000-000000000002',
      patientId: '0194f2c0-0000-7000-8000-000000000003',
      accessionNo: 'RAD/2026/000912',
      reconciledBy: '0194f2c0-0000-7000-8000-000000000004',
      reason: 'Accession typed manually at the console; matched against the MWL entry.',
      at: '2026-08-22T10:00:00.000Z',
    };
    expect(def.schema.safeParse(base).success).toBe(true);
    const { reconciledBy: _r, ...withoutPerson } = base;
    expect(def.schema.safeParse(withoutPerson).success).toBe(false);
  });

  /** EN-008 §5: a purge needs two approvals, and the payload has to prove it. */
  it('will not describe a purge that only one person approved', () => {
    const def = getEventDefinition('pacs.study.purged')!;
    const base = {
      studyId: '0194f2c0-0000-7000-8000-000000000001',
      accessionNo: 'RAD/2019/000018',
      policyId: '0194f2c0-0000-7000-8000-000000000002',
      purgeRunId: '0194f2c0-0000-7000-8000-000000000003',
      approvedBy: ['0194f2c0-0000-7000-8000-000000000004', '0194f2c0-0000-7000-8000-000000000005'],
      at: '2026-08-22T10:00:00.000Z',
    };
    expect(def.schema.safeParse(base).success).toBe(true);
    expect(
      def.schema.safeParse({ ...base, approvedBy: ['0194f2c0-0000-7000-8000-000000000004'] }).success,
    ).toBe(false);
  });
});
