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
 * Phase 2 grants — the check that the consultation loop can actually be walked.
 *
 * Two failure modes this file exists to catch, both of which look like something
 * else when they happen:
 *
 *  1. A key registered and granted to nobody. `assertRegisteredPermission` runs
 *     at module import, so the route loads fine; it then denies every user, and
 *     the bug report reads "the whole prescribing screen is empty".
 *  2. A safety key that a licence tier can switch off. Nothing fails, nothing
 *     logs, and a hospital in arrears quietly loses its allergy hard stop
 *     (EN-040 §5, D-9). That is a patient-safety defect, not a billing one.
 *
 * The assertions come from the §12 Permissions sections of OP-002, OP-007,
 * EN-029, NC-003 and OP-019, and the separation-of-duties rules in docs/05.
 */

const held = (role: string): ReadonlySet<string> => new Set(getRoleTemplate(role)?.permissions ?? []);

describe('Phase 2 permission catalogue', () => {
  it('registers the families the Phase 2 specs name', () => {
    const prefixes = [
      'opd.',
      'terminology.',
      'rx.',
      'order.',
      'vitals.',
      'integration.vitals.',
      'cdss.',
      'mrd.',
      'mobile.',
      'auth.device.',
    ];
    for (const prefix of prefixes) {
      const found = PERMISSION_CATALOGUE.filter((d) => d.key.startsWith(prefix) && d.phase === 2);
      expect(found.length, `no Phase 2 keys registered for "${prefix}"`).toBeGreaterThan(0);
    }
  });

  it('covers every endpoint OP-002 §12 names', () => {
    for (const key of [
      'opd.queue.read',
      'opd.queue.manage',
      'opd.encounter.create',
      'opd.encounter.read',
      'opd.encounter.update',
      'opd.encounter.sign',
      'opd.encounter.amend',
      'opd.diagnosis.update',
      'opd.allergy.update',
      'opd.inbox.read',
      'opd.result.acknowledge',
      'opd.template.manage',
      'opd.template.publish',
      'opd.certificate.create',
      'opd.preferences.manage',
      'opd.department.view',
      'opd.audit.read',
      'terminology.read',
      'rx.drug.search',
      'rx.create',
      'rx.sign',
      'rx.amend',
      'rx.cancel',
      'rx.print',
      'rx.cosign',
      'rx.schedule_x.prescribe',
      'order.create',
      'order.list',
      'order.cancel',
      'order.admission.request',
    ]) {
      expect(isRegisteredPermission(key), `${key} is named by OP-002 §12 but not registered`).toBe(true);
    }
  });

  /**
   * EN-040 §5 / D-9. A hospital with an unpaid invoice still gets its allergy
   * hard stop. Every key on the path from "the engine may run" through "the
   * clinician can see the alert" to "the clinician can clear it" is exempt,
   * because a path that is exempt in the middle and gated at the ends is not a
   * path.
   */
  it('keeps the whole CDSS and allergy path outside licence gating', () => {
    for (const key of [
      'cdss.evaluate',
      'cdss.alert.read',
      'cdss.alert.respond',
      'cdss.emergency.declare',
      'opd.allergy.update',
      'opd.result.acknowledge',
      'vitals.alert.acknowledge',
      'vitals.escalate.er',
    ]) {
      expect(getPermission(key)?.clinicalSafetyExempt, `${key} must never be licence-gateable`).toBe(true);
    }
  });

  it('marks the dangerous Phase 2 keys as dangerous', () => {
    // Narcotics. docs/05 §ABAC names `requires_second_person` for exactly this
    // class of action, and EN-029 §5 makes the NDPS cap a hard stop that may
    // only be countersigned.
    const scheduleX = getPermission('rx.schedule_x.prescribe');
    expect(scheduleX?.requiresReason).toBe(true);
    expect(scheduleX?.requiresStepUp).toBe(true);
    expect(scheduleX?.requiresSecondPerson).toBe(true);
    expect(scheduleX?.sensitiveGrant).toBe(true);
    expect(scheduleX?.risk).toBe('critical');

    // Destruction is the one action in the system with no undo.
    const destroy = getPermission('mrd.destruction.approve');
    expect(destroy?.requiresSecondPerson).toBe(true);
    expect(destroy?.sensitiveGrant).toBe(true);
    expect(destroy?.requiresStepUp).toBe(true);
    expect(destroy?.requiresReason).toBe(true);

    // Releasing a legal hold is what makes a medico-legal record destructible.
    expect(getPermission('mrd.legal_hold.release')?.requiresStepUp).toBe(true);
    expect(getPermission('mrd.legal_hold.release')?.sensitiveGrant).toBe(true);
    expect(getPermission('mrd.legal_hold.set')?.sensitiveGrant).toBe(true);

    // Rule authoring and publishing change what fires for every clinician in the
    // tenant; publishing is the only path that can raise a rule to hard-stop.
    expect(getPermission('cdss.rule.manage')?.sensitiveGrant).toBe(true);
    expect(getPermission('cdss.rule.publish')?.sensitiveGrant).toBe(true);
    expect(getPermission('cdss.rule.publish')?.requiresStepUp).toBe(true);
    expect(getPermission('cdss.kb.manage')?.sensitiveGrant).toBe(true);

    // A record export leaves the building.
    expect(getPermission('mrd.record.export')?.requiresReason).toBe(true);
    expect(getPermission('mrd.record.export')?.requiresStepUp).toBe(true);
    expect(getPermission('mrd.record.export')?.phiRead).toBe(true);
  });

  it('demands a reason wherever the version history would otherwise be unreadable', () => {
    for (const key of [
      'opd.encounter.amend',
      'rx.amend',
      'rx.cancel',
      'order.cancel',
      'vitals.record.correct',
      'mrd.record.reopen',
      'mrd.deficiency.waive',
      'cdss.alert.respond',
      'cdss.emergency.declare',
    ]) {
      expect(getPermission(key)?.requiresReason, `${key} must capture a reason`).toBe(true);
    }
  });

  it('classifies everything that touches clinical content as PHI', () => {
    // docs/05 §Model: data classes drive masking, export gating and audit.
    const clinical = PERMISSION_CATALOGUE.filter(
      (d) =>
        d.phase === 2 &&
        (d.key.startsWith('opd.encounter') ||
          d.key.startsWith('opd.diagnosis') ||
          d.key.startsWith('opd.allergy') ||
          d.key.startsWith('rx.create') ||
          d.key.startsWith('rx.sign') ||
          d.key.startsWith('vitals.record') ||
          d.key.startsWith('cdss.alert') ||
          d.key.startsWith('cdss.snapshot') ||
          d.key.startsWith('mrd.record')),
    );
    expect(clinical.length).toBeGreaterThan(10);
    for (const def of clinical) {
      expect(def.dataClass, `${def.key} touches clinical content and must be PHI-classed`).toBe('phi');
    }
  });

  it('writes a READ_PHI audit row for every Phase 2 key that opens a chart', () => {
    for (const key of [
      'opd.encounter.read',
      'opd.queue.read',
      'opd.inbox.read',
      'opd.department.view',
      'vitals.record.read',
      'cdss.alert.read',
      'cdss.snapshot.read',
      'mrd.record.read',
      'mrd.search',
      'mrd.record.export',
    ]) {
      expect(getPermission(key)?.phiRead, `${key} must be audited as a PHI read`).toBe(true);
    }
  });
});

describe('Phase 2 role grants', () => {
  it('grants every Phase 2 key to at least one role', () => {
    const granted = new Set(ROLE_TEMPLATES.flatMap((t) => t.permissions));
    const orphans = PERMISSION_CATALOGUE.filter((d) => d.phase === 2 && !granted.has(d.key)).map(
      (d) => d.key,
    );
    expect(orphans, 'Phase 2 keys held by no role template').toEqual([]);
  });

  it('lets a consultant walk the whole consultation loop', () => {
    const d = held('doctor_consultant_opd');
    for (const key of [
      'opd.queue.read',
      'opd.encounter.create',
      'opd.encounter.sign',
      'opd.encounter.amend',
      'opd.diagnosis.update',
      'opd.allergy.update',
      'terminology.read',
      'rx.drug.search',
      'rx.create',
      'rx.sign',
      'rx.print',
      'order.create',
      'order.admission.request',
      'cdss.evaluate',
      'cdss.alert.read',
      'cdss.alert.respond',
      'opd.result.acknowledge',
      'mobile.sync',
      'mobile.offline_rx',
    ]) {
      expect(d.has(key), `a consultant should hold ${key}`).toBe(true);
    }
  });

  /**
   * docs/05 row 14 and OP-002 §12: a resident's clinical output is something a
   * consultant puts their name to. The resident may draft everything and sign
   * nothing, and `resident_can_sign` is a department override on top of the
   * template, not the template default.
   */
  it('lets a resident draft everything and sign nothing', () => {
    const r = held('resident_doctor');
    expect(r.has('opd.encounter.create')).toBe(true);
    expect(r.has('rx.create')).toBe(true);
    expect(r.has('order.create')).toBe(true);
    expect(r.has('cdss.evaluate')).toBe(true);

    for (const key of [
      'opd.encounter.sign',
      'rx.sign',
      'rx.cosign',
      'rx.schedule_x.prescribe',
      'mobile.offline_rx',
      'order.cancel',
    ]) {
      expect(r.has(key), `a resident must NOT hold ${key}`).toBe(false);
    }
  });

  /**
   * OP-007 §12. The nurse owns the vitals room outright and can send a
   * deteriorating patient to the ER on her own authority — but the prescribing
   * keys are not hers. She prints an Rx; she never writes or signs one.
   */
  it('lets a vitals nurse record and escalate, and never prescribe', () => {
    const n = held('nurse_opd');
    for (const key of [
      'vitals.queue.read',
      'vitals.queue.manage',
      'vitals.record.create',
      'vitals.record.correct',
      'vitals.escalate.er',
      'opd.allergy.update',
      'cdss.alert.read',
      'rx.print',
    ]) {
      expect(n.has(key), `a vitals nurse should hold ${key}`).toBe(true);
    }
    for (const key of ['rx.create', 'rx.sign', 'rx.cosign', 'opd.encounter.sign', 'order.create']) {
      expect(n.has(key), `a vitals nurse must NOT hold ${key}`).toBe(false);
    }
  });

  it('gives the doctor the alert loop and the nurse the recording, not the other way round', () => {
    expect(held('doctor_consultant_opd').has('vitals.alert.acknowledge')).toBe(true);
    expect(held('doctor_consultant_opd').has('vitals.recheck.request')).toBe(true);
    // A doctor does not chart the observation set; the vitals room does.
    expect(held('doctor_consultant_opd').has('vitals.record.create')).toBe(false);
    expect(held('nurse_opd').has('vitals.record.read')).toBe(true);
  });

  /** OP-007 §12 defaults: "Receptionist: queue.read". Nothing else. */
  it('gives the front desk the vitals queue and no clinical content', () => {
    const r = held('receptionist');
    expect(r.has('vitals.queue.read')).toBe(true);
    for (const key of ['vitals.record.create', 'vitals.record.read', 'opd.encounter.read', 'rx.create']) {
      expect(r.has(key), `the front desk must NOT hold ${key}`).toBe(false);
    }
  });

  it('withholds narcotics prescribing from everyone but the consultant grades', () => {
    const holders = ROLE_TEMPLATES.filter((t) => t.permissions.includes('rx.schedule_x.prescribe')).map(
      (t) => t.key,
    );
    expect(holders.sort()).toEqual(
      [
        'anaesthetist',
        'doctor_consultant_opd',
        'doctor_emergency',
        'doctor_ip',
        'hod',
        'intensivist',
        'surgeon',
      ].sort(),
    );
  });

  it('gives break-glass-free roles no Phase 2 override reach', () => {
    // The catalogue deliberately registers no Phase 2 key with the `override`
    // action: the equivalents (a CDSS override, an emergency mode) are reason-
    // and countersign-bound instead, and residents may hold neither.
    const phase2Overrides = PERMISSION_CATALOGUE.filter((d) => d.phase === 2 && d.action === 'override');
    expect(phase2Overrides).toEqual([]);
  });

  it('gives the MRD desk the coding queue but not its own QA', () => {
    const m = held('mrd_officer');
    for (const key of [
      'mrd.record.list',
      'mrd.record.close',
      'mrd.coding.code',
      'mrd.deficiency.resolve',
      'mrd.scan.operate',
      'mrd.search',
      'mrd.retention.manage',
    ]) {
      expect(m.has(key), `MRD should hold ${key}`).toBe(true);
    }
    // docs/05 §Segregation of duties: creator ≠ checker.
    expect(m.has('mrd.coding.qa'), 'a coder must not pass their own coding QA').toBe(false);
    // NC-003 §12: two distinct approvers, and the proposer is not one of them.
    expect(m.has('mrd.destruction.approve'), 'the proposer of a destruction run must not approve it').toBe(
      false,
    );
    // Setting a hold protects a record; releasing one exposes it. Only the
    // Medical Superintendent may go in the dangerous direction.
    expect(m.has('mrd.legal_hold.set')).toBe(true);
    expect(m.has('mrd.legal_hold.release')).toBe(false);
  });

  it('puts coding QA and destruction approval in hands that do neither job', () => {
    const q = held('quality_manager');
    expect(q.has('mrd.coding.qa')).toBe(true);
    expect(q.has('mrd.coding.code')).toBe(false);

    const ms = held('medical_superintendent');
    const dpo = held('privacy_officer');
    expect(ms.has('mrd.destruction.approve')).toBe(true);
    expect(dpo.has('mrd.destruction.approve')).toBe(true);
    for (const role of [ms, dpo]) {
      expect(role.has('mrd.retention.manage'), 'an approver must not also propose the run').toBe(false);
    }
  });

  it('separates who writes a CDSS rule from who publishes it', () => {
    // EN-029 §5: the interruption ladder is policy, not code. The clinical
    // informaticist (here, Pharmacy In-charge for formulary rules) authors and
    // tests; only the Medical Superintendent — or IT on-call, for the emergency
    // disable in EN-029 §3.5 — can push it live.
    const author = held('pharmacy_incharge');
    expect(author.has('cdss.rule.manage')).toBe(true);
    expect(author.has('cdss.rule.test')).toBe(true);
    expect(author.has('cdss.rule.publish'), 'an author must not publish their own rule').toBe(false);

    const ms = held('medical_superintendent');
    expect(ms.has('cdss.rule.publish')).toBe(true);
    expect(ms.has('cdss.rule.manage'), 'a publisher must not author the rule they approve').toBe(false);
    expect(held('it_admin').has('cdss.rule.publish')).toBe(true);
    expect(held('it_admin').has('cdss.rule.manage')).toBe(false);
  });

  it('holds no template on both sides of a blocking Phase 2 separation rule', () => {
    const phase2Rules = SEGREGATION_OF_DUTIES_RULES.filter(
      (r) => r.mode === 'block' && getPermission(r.permA)?.phase === 2,
    );
    expect(phase2Rules.length).toBeGreaterThanOrEqual(3);
    for (const rule of phase2Rules) {
      const both = ROLE_TEMPLATES.filter(
        (t) => t.permissions.includes(rule.permA) && t.permissions.includes(rule.permB),
      ).map((t) => t.key);
      expect(both, `${rule.permA} + ${rule.permB} held by the same template: ${rule.reason}`).toEqual([]);
    }
  });

  it('gives the Medical Superintendent governance without a clinical seat at the keyboard', () => {
    const ms = held('medical_superintendent');
    for (const key of [
      'cdss.governance.read',
      'cdss.governance.manage',
      'cdss.alert.replay',
      'cdss.emergency.declare',
      'opd.audit.read',
      'opd.department.view',
      'mrd.deficiency.waive',
    ]) {
      expect(ms.has(key), `the Medical Superintendent should hold ${key}`).toBe(true);
    }
    // Governance reads the record; it does not write prescriptions in it.
    for (const key of ['rx.create', 'rx.sign', 'rx.schedule_x.prescribe', 'mrd.coding.code']) {
      expect(ms.has(key), `the Medical Superintendent must NOT hold ${key}`).toBe(false);
    }
  });

  it('gives the device token the vitals feed and nothing a person would need', () => {
    const dev = held('device');
    expect(dev.has('integration.vitals.ingest')).toBe(true);
    const phase2 = new Set(PERMISSION_CATALOGUE.filter((d) => d.phase === 2).map((d) => d.key));
    const devicePhase2 = [...dev].filter((k) => phase2.has(k));
    expect(devicePhase2).toEqual(['integration.vitals.ingest']);
  });

  it('gives patients and external partners no Phase 2 clinical key at all', () => {
    const phase2 = new Set(PERMISSION_CATALOGUE.filter((d) => d.phase === 2).map((d) => d.key));
    for (const key of ['patient', 'family_attendant', 'corporate_hr_client', 'payer_user', 'vendor']) {
      const leaked = [...held(key)].filter((k) => phase2.has(k));
      expect(leaked, `${key} must hold no Phase 2 clinical key`).toEqual([]);
    }
  });
});

/**
 * Phase 2 domain events — the other half of the contract.
 *
 * `OutboxWriter.emit()` refuses an unregistered type, so a missing entry here is
 * not a warning: the emit throws inside the transaction that created the
 * prescription, and the prescription rolls back with it.
 */
describe('Phase 2 domain events', () => {
  const PHASE_2_EVENTS = [
    'visit.consult.started',
    'visit.consult.completed',
    'encounter.break_glass',
    'diagnosis.recorded',
    'allergy.recorded',
    'result.acknowledged',
    'rx.created',
    'rx.amended',
    'rx.cancelled',
    'rx.cosigned',
    'rx.held',
    'order.placed',
    'order.lab.created',
    'order.rad.created',
    'order.procedure.created',
    'order.referral.created',
    'order.admission.requested',
    'order.cancelled',
    'charge.intent.created',
    'charge.intent.reversed',
    'vitals.recorded',
    'vitals.abnormal',
    'vitals.critical',
    'vitals.alert.acknowledged',
    'vitals.recheck.requested',
    'vitals.escalated.er',
    'cdss.alert.fired',
    'cdss.alert.acknowledged',
    'cdss.alert.overridden',
    'cdss.hardstop.blocked',
    'cdss.hardstop.countersigned',
    'cdss.emergency.declared',
    'cdss.rule.published',
    'cdss.rule.disabled',
    'cdss.rule.rolled_back',
    'cdss.rule.storm_detected',
    'cdss.rule.governance_reviewed',
    'cdss.kb.release_activated',
    'mrd.record.opened',
    'mrd.record.closed',
    'mrd.record.reopened',
    'mrd.deficiency.raised',
    'mrd.deficiency.resolved',
    'mrd.coding.completed',
    'mrd.coding.query.raised',
    'mrd.coding.query.answered',
    'mrd.document.scanned',
    'mrd.legal_hold.set',
    'mrd.legal_hold.released',
    'mrd.destruction.approved',
    'mobile.sync.conflict',
  ] as const;

  it('registers every event the Phase 2 specs name', () => {
    for (const type of PHASE_2_EVENTS) {
      expect(EVENT_TYPES, `${type} must be registered before any producer can emit it`).toContain(type);
    }
  });

  it('keeps clinical and medico-legal facts for the statutory seven years', () => {
    for (const type of [
      'visit.consult.completed',
      'diagnosis.recorded',
      'allergy.recorded',
      'rx.created',
      'order.placed',
      'charge.intent.created',
      'cdss.alert.fired',
      'cdss.hardstop.blocked',
      'encounter.break_glass',
      'mrd.record.closed',
      'mrd.destruction.approved',
    ]) {
      expect(getEventDefinition(type)?.retentionDays, `${type} is evidence and must outlive the outbox`).toBe(
        2555,
      );
    }
  });

  /**
   * `vitals.recorded` fires several times per patient per day and exists only to
   * invalidate a cache. The observation itself is in `clinical.vitals` for ten
   * years. The abnormal and critical variants are the opposite: they are the
   * proof that a clinician was told, so they keep the full retention.
   */
  it('keeps high-volume workflow chatter short and safety evidence long', () => {
    const recorded = getEventDefinition('vitals.recorded')!;
    const critical = getEventDefinition('vitals.critical')!;
    expect(recorded.retentionDays).toBeLessThan(critical.retentionDays);
    expect(critical.retentionDays).toBe(2555);
    expect(getEventDefinition('vitals.abnormal')!.retentionDays).toBe(2555);
    expect(getEventDefinition('mobile.sync.conflict')!.retentionDays).toBeLessThanOrEqual(90);
  });

  it('marks the PHI-bearing Phase 2 events honestly, and the rule-admin ones honestly too', () => {
    for (const type of [
      'visit.consult.completed',
      'allergy.recorded',
      'rx.created',
      'vitals.critical',
      'cdss.alert.fired',
      'mrd.record.opened',
      'charge.intent.created',
    ]) {
      expect(getEventDefinition(type)?.containsPhi, `${type} carries patient data`).toBe(true);
    }
    // A rule is a tenant-level configuration object. Marking it PHI would make
    // the relay redact fields that carry no patient data and hide the change log
    // from the people who need to read it.
    for (const type of [
      'cdss.rule.published',
      'cdss.rule.disabled',
      'cdss.rule.storm_detected',
      'cdss.kb.release_activated',
      'mrd.destruction.approved',
    ]) {
      expect(getEventDefinition(type)?.containsPhi, `${type} carries no patient data`).toBe(false);
    }
  });

  /**
   * Phase 5 turns `charge.intent.created` into a bill line. If the payload does
   * not carry the line, OP-005 has to read back through the clinical schema for
   * every charge — and a money field that arrived as a JSON number would already
   * have been through IEEE-754.
   */
  it('carries a complete bill line on charge.intent.created, with money as a decimal string', () => {
    const def = getEventDefinition('charge.intent.created')!;
    const line = {
      chargeIntentId: '0194f2c0-0000-7000-8000-000000000001',
      patientId: '0194f2c0-0000-7000-8000-000000000002',
      visitId: null,
      encounterId: '0194f2c0-0000-7000-8000-000000000003',
      admissionId: null,
      sourceModule: 'OP-002',
      sourceTable: 'clinical.order_items',
      sourceId: '0194f2c0-0000-7000-8000-000000000004',
      serviceKey: '0194f2c0-0000-7000-8000-000000000005',
      description: 'CT Brain plain',
      qty: '1',
      unitPrice: '2500.00',
      amount: '2500.00',
      currency: 'INR',
      createdAt: '2026-08-22T10:00:00.000Z',
    };
    expect(def.schema.safeParse(line).success).toBe(true);

    // A float here is a paisa of drift per line, every line, silently.
    expect(def.schema.safeParse({ ...line, amount: 2500.0 }).success).toBe(false);
    expect(def.schema.safeParse({ ...line, qty: 1 }).success).toBe(false);
    // And a line with no service, description or amount is not a bill line.
    const { description: _d, ...withoutDescription } = line;
    expect(def.schema.safeParse(withoutDescription).success).toBe(false);
  });

  it('carries the reproducibility keys on every CDSS alert', () => {
    // EN-029 §5: same snapshot digest + same rule version ⇒ identical output.
    // `cdss.alert.replay` is worthless without both travelling on the event.
    const def = getEventDefinition('cdss.alert.fired')!;
    const base = {
      alertEventId: '0194f2c0-0000-7000-8000-000000000001',
      firedAt: '2026-08-22T10:00:00.000Z',
      patientId: '0194f2c0-0000-7000-8000-000000000002',
      encounterId: null,
      ruleId: '0194f2c0-0000-7000-8000-000000000003',
      ruleVersionId: '0194f2c0-0000-7000-8000-000000000004',
      safetyFloorKey: null,
      family: 'allergy',
      severity: 'contraindicated',
      interruption: 'hard_stop',
      trigger: 'rx_sign',
      prescriptionItemId: null,
      orderItemId: null,
      snapshotDigest: 'a3f1',
      latencyMs: 42,
      degraded: false,
    };
    expect(def.schema.safeParse(base).success).toBe(true);
    const { snapshotDigest: _s, ...withoutDigest } = base;
    expect(def.schema.safeParse(withoutDigest).success).toBe(false);
  });
});
