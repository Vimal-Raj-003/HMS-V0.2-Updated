import { describe, expect, it } from 'vitest';
import {
  PERMISSION_CATALOGUE,
  PERMISSION_KEYS,
  SECOND_PERSON_PERMISSIONS,
  SEGREGATION_OF_DUTIES_RULES,
  getPermission,
  isRegisteredPermission,
} from './permissions.js';
import { ROLE_TEMPLATES, getRoleTemplate } from './role-templates.js';
import { EVENT_TYPES, getEventDefinition } from '../events/registry.js';

/**
 * Phase 4 grants — the check that medicine and money can move, and that nothing
 * on the way there is authorised by one pair of hands.
 *
 * Four failure modes are guarded here, and every one of them has already
 * happened somewhere in this repository or is one line away from happening:
 *
 *  1. **A `.read` granted without its `.list`.** The role can only fetch by an
 *     id it has no way to obtain, so its first action of the day is impossible.
 *     `CASHIER_BASE` carries the scar: `receipt.shift.list` was omitted and a
 *     cashier could not find their own open shift. The check below is
 *     mechanical and covers every template, not just the Phase-4 ones.
 *
 *  2. **A `requiresSecondPerson` key used as a route decorator.**
 *     `permission.decorator.ts` throws at module load, because `PolicyGuard`
 *     evaluates without a co-signer and the route would deny everybody. So each
 *     such key must name a *decoratable* precondition, and that precondition
 *     must itself exist and not be second-person.
 *
 *  3. **A safety key a licence tier can gate.** Nothing fails and nothing logs:
 *     a hospital in arrears quietly loses its recall trace. EN-040 §5 makes that
 *     a patient-safety defect, not a billing one.
 *
 *  4. **Maker and checker in one template.** `docs/04 §3` names purchase orders
 *     and narcotics explicitly, and a blocking segregation rule that no test
 *     reads is a comment.
 *
 * The assertions come from §12 of OP-003, NC-005, NC-006, NC-007, NC-008 and
 * NC-021, and from `docs/04 §1` (CDSCO / NDPS) and §7 (medication safety).
 */

const PHASE4_MODULES = ['OP-003', 'NC-005', 'NC-006', 'NC-007', 'NC-008', 'NC-021'] as const;
const phase4 = PERMISSION_CATALOGUE.filter((d) => d.phase === 4);
const held = (role: string): ReadonlySet<string> => new Set(getRoleTemplate(role)?.permissions ?? []);

describe('Phase 4 permission catalogue', () => {
  it('registers the families the Phase 4 specs name', () => {
    const prefixes = [
      'inventory.item.',
      'inventory.store',
      'inventory.stock.',
      'inventory.ledger.',
      'inventory.issue.',
      'inventory.transfer.',
      'inventory.adjustment.',
      'inventory.batch.',
      'inventory.count.',
      'inventory.valuation.',
      'inventory.indent.',
      'inventory.rfq.',
      'inventory.quotation.',
      'inventory.comparative.',
      'inventory.rate_contract.',
      'inventory.po.',
      'inventory.grn.',
      'inventory.invoice.',
      'inventory.purchase.',
      'inventory.consignment.',
      'inventory.consumption.',
      'finance.costcentre.',
      'finance.allocation.',
      'vendor.',
      'pharmacy.',
    ];
    for (const prefix of prefixes) {
      const found = phase4.filter((d) => d.key.startsWith(prefix));
      expect(found.length, `no Phase 4 keys registered for "${prefix}"`).toBeGreaterThan(0);
    }
  });

  it('attributes every Phase 4 key to one of the six owning module specs', () => {
    for (const def of phase4) {
      expect(
        (PHASE4_MODULES as readonly string[]).includes(def.module),
        `${def.key} claims ${def.module}, which is not a Phase 4 module`,
      ).toBe(true);
    }
  });

  /**
   * The `.read`-without-`.list` gap, checked mechanically.
   *
   * Two halves. The first is the catalogue's: a resource that has a `.list` at
   * all. The second is the grant's: no template may hold the `.read` of such a
   * resource without the `.list`, because `.read` needs an id and `.list` is the
   * only thing that produces one.
   *
   * Deliberately run over **every** template and every phase, not just Phase 4 —
   * the bug class is not phase-specific and a regression in Phase 2 would be
   * just as invisible.
   */
  it('never grants a role a `.read` whose sibling `.list` exists but is withheld', () => {
    const registered = new Set(PERMISSION_KEYS);
    const gaps: string[] = [];

    for (const template of ROLE_TEMPLATES) {
      const grants = new Set(template.permissions);
      for (const key of grants) {
        if (!key.endsWith('.read')) continue;
        const list = `${key.slice(0, -'.read'.length)}.list`;
        if (registered.has(list) && !grants.has(list)) {
          gaps.push(`${template.key} holds ${key} but not ${list}`);
        }
      }
    }

    expect(
      gaps,
      'a role that can read by id but cannot list has no way to obtain the id — its first action of the day is impossible',
    ).toEqual([]);
  });

  it('gives every Phase 4 collection resource a `.list`, not only a `.read`', () => {
    // A resource whose rows are addressed by an opaque id needs a way in. The
    // exemptions are the ones where the `.read` *is* the collection view (a
    // report, a dashboard, a working list) — named individually so adding a new
    // document type without its `.list` fails here rather than in production.
    const readIsTheList = new Set([
      'inventory.expiry.read',
      'inventory.coldchain.read',
      'inventory.reorder.read',
      'inventory.analysis.read',
      'inventory.valuation.read',
      'inventory.report.read',
      'inventory.purchase.report.read',
      'inventory.consignment.stock.read',
      'inventory.consignment.report.read',
      'inventory.consumption.variance.read',
      'inventory.consumption.report.read',
      'vendor.item.read',
      'vendor.score.read',
      'vendor.report.read',
      'pharmacy.expiry.read',
      'pharmacy.report.read',
    ]);
    const registered = new Set(PERMISSION_KEYS);
    const missing = phase4
      .filter((d) => d.key.endsWith('.read'))
      .map((d) => d.key)
      .filter((key) => !readIsTheList.has(key))
      .filter((key) => !registered.has(`${key.slice(0, -'.read'.length)}.list`));

    expect(missing, 'these Phase 4 resources can be read by id but never found').toEqual([]);
  });

  /**
   * `services/api/src/core/policy/permission.decorator.ts` throws at module load
   * on a `requiresSecondPerson` key, because `PolicyGuard` calls `evaluate()`
   * without a co-signer and the route would deny every user unconditionally —
   * and look correct in review.
   *
   * So every second-person key has to be reachable another way: a decoratable
   * precondition key the acting user genuinely holds, with the real authority
   * asserted inside the service once the co-signer has authenticated. The
   * description of each key names that precondition; this asserts the named key
   * exists and is itself safe to decorate with.
   */
  it('gives every Phase 4 second-person key a decoratable precondition that exists', () => {
    const secondPerson = phase4.filter((d) => d.requiresSecondPerson === true);
    expect(secondPerson.length, 'Phase 4 must have second-person keys — NDPS demands them').toBeGreaterThan(
      0,
    );

    for (const def of secondPerson) {
      const named = [...def.description.matchAll(/decorate with `([a-z0-9_.]+)`/g)].map((m) => m[1]);
      expect(
        named.length,
        `${def.key} is second-person but its description names no decoratable precondition; ` +
          'a route decorated with it would deny every user (permission.decorator.ts throws on exactly this)',
      ).toBeGreaterThan(0);

      for (const precondition of named) {
        expect(
          isRegisteredPermission(precondition ?? ''),
          `${def.key} names precondition "${precondition ?? ''}", which is not registered`,
        ).toBe(true);
        expect(
          getPermission(precondition ?? '')?.requiresSecondPerson,
          `${def.key} names "${precondition ?? ''}" as its precondition, but that key is itself second-person — ` +
            'a route decorated with it would be just as dead',
        ).not.toBe(true);
      }
    }
  });

  it('puts every NDPS action behind two people, and none of them behind one', () => {
    // docs/04 §1: "NDPS narcotic register with dual authorisation and physical
    // stock reconciliation"; docs/05 §ABAC: requires_second_person (narcotics).
    for (const key of [
      'pharmacy.narcotic.dispense',
      'pharmacy.narcotic.issue',
      'pharmacy.narcotic.custody',
      'pharmacy.narcotic.destroy',
    ]) {
      expect(SECOND_PERSON_PERMISSIONS, `${key} must require a second person`).toContain(key);
      expect(getPermission(key)?.requiresStepUp, `${key} must demand fresh strong auth`).toBe(true);
      expect(getPermission(key)?.risk).toBe('critical');
    }
    // …and the one that is not, deliberately, because a route has to be able to
    // carry it.
    expect(SECOND_PERSON_PERMISSIONS).not.toContain('pharmacy.narcotic.prepare');
  });

  it('demands a reason wherever stock or money leaves without a counterparty', () => {
    // EN-024 §5, NC-006 §5, phase-04 §4.2. A write-off, an expiry decision, a
    // correction and an override are all "stock left and nobody paid for it";
    // the reason is the only thing that distinguishes them from a loss.
    for (const key of [
      'inventory.adjustment.create',
      'inventory.adjustment.approve',
      'inventory.expiry.manage',
      'inventory.batch.quarantine',
      'inventory.batch.release',
      'inventory.count.approve',
      'inventory.valuation.close',
      'inventory.fefo.override',
      'inventory.negative_stock.override',
      'inventory.grn.reverse',
      'inventory.grn.without_po.create',
      'inventory.po.amend',
      'inventory.po.cancel',
      'inventory.po.short_close',
      'inventory.consumption.reverse',
      'pharmacy.stock.adjust',
      'pharmacy.expiry.manage',
      'pharmacy.batch.override',
      'pharmacy.return.create',
      'pharmacy.narcotic.destroy',
      'pharmacy.label.reprint',
    ]) {
      expect(getPermission(key)?.requiresReason, `${key} must capture a reason`).toBe(true);
    }
  });

  it('classifies as PHI everything that names a patient, and writes a READ_PHI row for the reads', () => {
    // docs/04 §4. A dispense names a patient; so does a consignment implant, a
    // patient consumption entry and the H1/NDPS register.
    for (const key of [
      'pharmacy.dispense.read',
      'pharmacy.dispense.list',
      'pharmacy.narcotic.read',
      'pharmacy.narcotic.list',
      'pharmacy.recall.trace',
      'inventory.batch.trace',
      'inventory.consignment.usage.read',
      'inventory.consignment.usage.list',
      'inventory.consumption.read',
      'inventory.consumption.list',
    ]) {
      const def = getPermission(key);
      expect(def?.dataClass, `${key} touches patient data`).toBe('phi');
      expect(def?.phiRead, `${key} must write a READ_PHI audit row`).toBe(true);
    }
  });

  it('keeps the medicine-reaches-the-patient path outside licence gating', () => {
    // EN-040 §5, D-9: clinical safety is never gated. An unpaid invoice must
    // not stop a dispense, a recall trace or a batch quarantine.
    const exempt = new Set(phase4.filter((d) => d.clinicalSafetyExempt).map((d) => d.key));
    for (const key of [
      'pharmacy.queue.read',
      'pharmacy.queue.list',
      'pharmacy.dispense.create',
      'pharmacy.dispense.complete',
      'pharmacy.narcotic.prepare',
      'pharmacy.narcotic.dispense',
      'pharmacy.recall.manage',
      'pharmacy.recall.trace',
      'inventory.batch.quarantine',
      'inventory.batch.trace',
    ]) {
      expect(exempt, `${key} must never be blocked by a licence tier`).toContain(key);
    }
  });

  it('makes every Phase 4 export reasoned, because commercial terms leave with it', () => {
    for (const def of phase4.filter((d) => d.action === 'export')) {
      expect(def.requiresReason, `${def.key} must capture a reason`).toBe(true);
    }
  });
});

describe('Phase 4 role grants', () => {
  it('grants every Phase 4 key to at least one role template', () => {
    const granted = new Set(ROLE_TEMPLATES.flatMap((t) => [...t.permissions]));
    const orphans = phase4.map((d) => d.key).filter((k) => !granted.has(k));
    expect(orphans, 'a key granted to nobody is a route that denies everyone').toEqual([]);
  });

  it('lets the pharmacist dispense, and never price, approve a return or run a recall', () => {
    // OP-003 §12: "Pharmacist OP: queue, dispense*, otc, label, return.create,
    // stock.read, coldchain.log, narcotic.dispense (as first person);
    // In-charge: all incl. approve/expiry/recall/configure/price".
    const op = held('pharmacist_op');
    for (const key of [
      'pharmacy.queue.read',
      'pharmacy.queue.list',
      'pharmacy.dispense.create',
      'pharmacy.dispense.complete',
      'pharmacy.otc.sell',
      'pharmacy.label.print',
      'pharmacy.return.create',
      'pharmacy.stock.read',
      'pharmacy.coldchain.record',
      'pharmacy.narcotic.prepare',
      'pharmacy.narcotic.dispense',
    ]) {
      expect(op, `pharmacist_op needs ${key}`).toContain(key);
    }
    for (const key of [
      'pharmacy.price.update',
      'pharmacy.return.approve',
      'pharmacy.recall.manage',
      'pharmacy.expiry.manage',
      'pharmacy.configure',
      'pharmacy.stock.adjust',
      'pharmacy.discount.apply',
    ]) {
      expect(op, `pharmacist_op must not hold ${key}`).not.toContain(key);
    }
  });

  it('makes both dispensing pharmacists valid co-signers, with MFA', () => {
    // docs/04 §2: TOTP mandatory for "Pharmacy-narcotics". A pharmacist who can
    // be the second signature on a controlled-drug transaction is in that set,
    // and both dispensing templates can be.
    for (const key of ['pharmacist_op', 'pharmacist_ip', 'pharmacy_incharge']) {
      const t = getRoleTemplate(key);
      expect(t?.abacDefaults.requiresSecondPerson, `${key} must carry the second-person condition`).toBe(
        true,
      );
      expect(t?.mfaMandatory, `${key} touches the narcotic register and must require MFA`).toBe(true);
    }
  });

  it('gives the pharmacy in-charge the administration and never the count it approves', () => {
    const inCharge = held('pharmacy_incharge');
    for (const key of [
      'pharmacy.price.update',
      'pharmacy.expiry.manage',
      'pharmacy.recall.manage',
      'pharmacy.recall.trace',
      'pharmacy.return.approve',
      'pharmacy.configure',
      'pharmacy.report.export',
    ]) {
      expect(inCharge, `pharmacy_incharge needs ${key}`).toContain(key);
    }
    // Counts the shelf (via the counter bundle), so must not approve the variance.
    expect(inCharge).toContain('inventory.count.count');
    expect(inCharge, 'NC-006 §5: count and approve are different hands').not.toContain(
      'inventory.count.approve',
    );
    // Buys drugs but never authorises the order.
    expect(inCharge).not.toContain('inventory.po.approve');
    expect(inCharge).not.toContain('inventory.invoice.approve');
  });

  it('lets the store keeper receive and issue, and never release the payment for it', () => {
    const store = held('stores_keeper');
    for (const key of [
      'inventory.grn.create',
      'inventory.grn.qc',
      'inventory.grn.post',
      'inventory.issue.pick',
      'inventory.issue.create',
      'inventory.transfer.dispatch',
      'inventory.transfer.receive',
      'inventory.count.count',
      'inventory.adjustment.create',
      'inventory.batch.quarantine',
      'inventory.fefo.override',
    ]) {
      expect(store, `stores_keeper needs ${key}`).toContain(key);
    }
    for (const key of [
      'inventory.invoice.approve',
      'inventory.adjustment.approve',
      'inventory.count.approve',
      'inventory.po.create',
      'inventory.po.approve',
      'inventory.valuation.close',
    ]) {
      expect(store, `stores_keeper must not hold ${key}`).not.toContain(key);
    }
  });

  it('lets the purchase officer raise the order and never approve one', () => {
    const buyer = held('purchase_officer');
    for (const key of [
      'inventory.rfq.create',
      'inventory.rfq.send',
      'inventory.quotation.enter',
      'inventory.comparative.compare',
      'inventory.po.create',
      'inventory.po.send',
      'inventory.po.amend',
      'inventory.invoice.capture',
      'inventory.invoice.match',
      'vendor.master.manage',
    ]) {
      expect(buyer, `purchase_officer needs ${key}`).toContain(key);
    }
    for (const key of [
      'inventory.po.approve',
      'inventory.invoice.approve',
      'inventory.grn.post',
      'vendor.master.approve',
      'vendor.bank.approve',
      'vendor.action.approve',
    ]) {
      expect(buyer, `docs/04 §3: purchase_officer must not hold ${key}`).not.toContain(key);
    }
  });

  it('lets accounts payable release the money and never say the goods arrived', () => {
    const ap = held('accountant');
    for (const key of [
      'inventory.invoice.approve',
      'inventory.po.approve',
      'vendor.bank.approve',
      'finance.allocation.post',
      'inventory.valuation.close',
      'inventory.consignment.sign',
    ]) {
      expect(ap, `accountant needs ${key}`).toContain(key);
    }
    for (const key of ['inventory.grn.post', 'inventory.po.create', 'vendor.master.manage']) {
      expect(ap, `NC-005 §12 / NC-021 §5: accountant must not hold ${key}`).not.toContain(key);
    }
  });

  it('gives the ward a sub-store and never the store in-charge’s authority', () => {
    const nurse = held('nurse_ward');
    for (const key of [
      'inventory.store_indent.create',
      'inventory.issue.receive',
      'inventory.return.create',
      'inventory.consumption.record',
      'inventory.count.count',
    ]) {
      expect(nurse, `nurse_ward needs ${key}`).toContain(key);
    }
    for (const key of [
      'inventory.adjustment.create',
      'inventory.adjustment.approve',
      'inventory.count.approve',
      'inventory.grn.post',
      'inventory.batch.release',
    ]) {
      expect(nurse, `nurse_ward must not hold ${key}`).not.toContain(key);
    }
  });

  /**
   * Placement, asserted rather than assumed.
   *
   * The first version of this change inserted the sub-store grant by finding the
   * template's `key:` line and then the next `],` — which walks straight past a
   * template whose permissions are written on one line and into the following
   * one. `nurse_ot_scrub`'s stores grant landed on `nurse_supervisor`,
   * `lab_technician`'s on `lab_quality_manager`, and three more on
   * `mrd_officer`. Every test in this file still passed, because none of them
   * named those roles. This one does.
   */
  it('gives the sub-store grant to the units that keep a sub-store, and to nobody else', () => {
    for (const key of [
      'nurse_ward',
      'nurse_icu',
      'nurse_er_triage',
      'nurse_ot_scrub',
      'dialysis_technician',
      'lab_technician',
      'radiology_technician',
      'cssd_technician',
    ]) {
      expect(held(key), `${key} keeps a sub-store and must be able to indent`).toContain(
        'inventory.store_indent.create',
      );
      expect(held(key), `${key} must be able to record what its unit consumed`).toContain(
        'inventory.consumption.record',
      );
    }

    // The three that were hit by accident. An MRD officer does not draw stock
    // from the ward store, a lab quality manager does not consume reagents, and
    // a nursing supervisor supervises consumption without recording it.
    for (const key of ['mrd_officer', 'lab_quality_manager']) {
      const leaked = [...held(key)].filter((k) => getPermission(k)?.phase === 4);
      expect(leaked, `${key} has no Phase 4 role`).toEqual([]);
    }
    expect(held('nurse_supervisor')).toContain('inventory.consumption.supervise');
    expect(held('nurse_supervisor'), 'a supervisor reviews the entry, they do not make it').not.toContain(
      'inventory.consumption.record',
    );
  });

  it('lets the surgeon record the implant and the coordinator do the paperwork', () => {
    expect(held('surgeon')).toContain('inventory.consignment.use');
    expect(held('surgeon')).not.toContain('inventory.consignment.reconcile');
    expect(held('surgeon')).not.toContain('inventory.consignment.sign');
    expect(held('stores_keeper')).toContain('inventory.consignment.use');
    expect(held('stores_keeper'), 'NC-007 §12: scanner ≠ reconciliation signer').not.toContain(
      'inventory.consignment.sign',
    );
  });

  it('lets a prescriber decide a substitution and a resident only watch one', () => {
    for (const key of ['doctor_consultant_opd', 'doctor_ip', 'doctor_emergency', 'surgeon']) {
      expect(held(key), `${key} must be able to answer a substitution request`).toContain(
        'rx.substitution.approve',
      );
      expect(held(key)).toContain('pharmacy.dispense.read');
      expect(held(key)).toContain('pharmacy.dispense.list');
    }
    const resident = held('resident_doctor');
    expect(resident).toContain('pharmacy.dispense.read');
    expect(
      resident,
      'a resident cannot sign the prescription, so they cannot authorise a change to it',
    ).not.toContain('rx.substitution.approve');
  });

  it('keeps the auditor read-only across the whole supply chain', () => {
    const mutating = new Set([
      'create',
      'update',
      'delete',
      'cancel',
      'approve',
      'dispense',
      'issue',
      'sign',
      'override',
      'post',
      'reverse',
      'adjust',
      'use',
      'sell',
      'manage',
      'configure',
    ]);
    for (const key of held('auditor')) {
      const def = getPermission(key);
      if (def === undefined || def.phase !== 4) continue;
      expect(mutating.has(def.action), `auditor must not hold ${key}`).toBe(false);
    }
    // …and it can still see the things an inspection asks for.
    expect(held('auditor')).toContain('inventory.ledger.read');
    expect(held('auditor')).toContain('pharmacy.narcotic.read');
    expect(held('auditor')).toContain('inventory.invoice.list');
  });

  it('gives patients, families and external partners no Phase 4 key at all', () => {
    const p4 = new Set(phase4.map((d) => d.key));
    for (const key of [
      'patient',
      'family_attendant',
      'corporate_hr_client',
      'payer_user',
      'vendor',
      'device',
    ]) {
      const leaked = [...held(key)].filter((k) => p4.has(k));
      expect(leaked, `${key} must hold no Phase 4 key`).toEqual([]);
    }
  });

  it('holds no template on both sides of a blocking Phase 4 separation rule', () => {
    const p4 = new Set(phase4.map((d) => d.key));
    const blocking = SEGREGATION_OF_DUTIES_RULES.filter(
      (r) => r.mode === 'block' && (p4.has(r.permA) || p4.has(r.permB)),
    );
    expect(blocking.length, 'Phase 4 must contribute blocking separation rules').toBeGreaterThan(4);

    for (const rule of blocking) {
      for (const template of ROLE_TEMPLATES) {
        const grants = new Set(template.permissions);
        expect(
          grants.has(rule.permA) && grants.has(rule.permB),
          `role "${template.key}" holds both ${rule.permA} and ${rule.permB}: ${rule.reason}`,
        ).toBe(false);
      }
    }
  });
});

describe('Phase 4 domain events', () => {
  it('registers every event the Phase 4 specs name', () => {
    for (const type of [
      // NC-006
      'inventory.item.created',
      'inventory.stock.moved',
      'inventory.stock.corrected',
      'inventory.stock.low',
      'inventory.reorder.suggested',
      'inventory.issue.completed',
      'inventory.transfer.dispatched',
      'inventory.transfer.received',
      'inventory.transfer.discrepancy',
      'inventory.adjustment.posted',
      'inventory.wastage.recorded',
      'inventory.batch.expiring',
      'inventory.batch.expired',
      'inventory.batch.written_off',
      'inventory.batch.quarantined',
      'inventory.batch.released',
      'inventory.temp.excursion',
      'inventory.count.completed',
      'inventory.valuation.period_closed',
      // NC-005
      'purchase.indent.submitted',
      'purchase.rfq.sent',
      'purchase.quote.received',
      'purchase.comparative.approved',
      'purchase.po.approved',
      'purchase.grn.accepted',
      'purchase.grn.partial',
      'purchase.grn.rejected',
      'purchase.return.dispatched',
      'purchase.invoice.matched',
      'purchase.invoice.disputed',
      'purchase.invoice.approved_for_payment',
      'purchase.emergency.raised',
      // NC-021
      'vendor.created',
      'vendor.approved',
      'vendor.bank.changed',
      'vendor.document.expiring',
      'vendor.document.expired',
      'vendor.action.blacklisted',
      // NC-007
      'consignment.agreement.activated',
      'consignment.stock.received',
      'consignment.usage.recorded',
      'consignment.usage.reversed',
      'consignment.auto_po.created',
      'consignment.reconciliation.signed',
      'consignment.count.discrepancy',
      // NC-008
      'consumption.recorded',
      'consumption.reversed',
      'consumption.autocharge.failed',
      'consumption.variance.alert',
      'consumption.allocation.posted',
      // OP-003
      'pharmacy.rx.received',
      'rx.dispensed',
      'rx.partially_dispensed',
      'pharmacy.substitution.requested',
      'pharmacy.substitution.approved',
      'pharmacy.substitution.rejected',
      'pharmacy.stockout.reported',
      'pharmacy.return.completed',
      'pharmacy.expiry.alert',
      'pharmacy.batch.quarantined',
      'pharmacy.recall.raised',
      'pharmacy.recall.traced',
      'pharmacy.recall.closed',
      'pharmacy.narcotic.transaction',
      'pharmacy.custody.variance',
      'pharmacy.coldchain.excursion',
    ]) {
      expect(EVENT_TYPES, `${type} must be registered`).toContain(type);
    }
  });

  it('marks as PHI every Phase 4 event that names a patient, and only those', () => {
    const shouldBePhi = [
      'pharmacy.rx.received',
      'rx.dispensed',
      'rx.partially_dispensed',
      'pharmacy.substitution.requested',
      'pharmacy.substitution.approved',
      'pharmacy.substitution.rejected',
      'pharmacy.return.completed',
      'pharmacy.narcotic.transaction',
      'pharmacy.intervention.recorded',
      'consignment.usage.recorded',
      'consignment.usage.reversed',
      'consumption.recorded',
      'consumption.reversed',
      'consumption.autocharge.failed',
    ];
    for (const type of shouldBePhi) {
      expect(getEventDefinition(type)?.containsPhi, `${type} names a patient and must be PHI`).toBe(true);
    }

    // And the busiest event in the phase deliberately is not: `inventory.stock.moved`
    // omits `patientId` so that a dispense movement does not drag the whole
    // movement feed into the redaction path. If somebody adds the field, this
    // fails and they have to mark the event instead.
    const moved = getEventDefinition('inventory.stock.moved');
    expect(moved?.containsPhi).toBe(false);
    expect(moved?.schema.safeParse({}).success, 'inventory.stock.moved must still validate a shape').toBe(
      false,
    );
    expect(
      JSON.stringify(Object.keys((moved?.schema as { shape?: object })?.shape ?? {})),
      'inventory.stock.moved must not carry a patient identifier while it is marked non-PHI',
    ).not.toContain('patientId');
  });

  it('carries every Phase 4 money field as a decimal string, never a number', () => {
    // The registry's `money` schema is a regex over strings, so the proof is
    // that the schemas reject a number in the money position.
    const cases: readonly (readonly [string, Record<string, unknown>, string])[] = [
      [
        'purchase.po.approved',
        {
          poId: '0194f2c0-0000-7000-8000-000000000001',
          poNo: 'BLR/PO/2026-27/00001',
          poVersion: 1,
          vendorId: '0194f2c0-0000-7000-8000-000000000002',
          poType: 'standard',
          lineCount: 2,
          netValue: '10000.00',
          taxValue: '1200.00',
          grossValue: '11200.00',
          currency: 'INR',
          budgetLine: null,
          approvedBy: null,
          approvedAt: '2026-08-25T10:00:00.000Z',
        },
        'grossValue',
      ],
      [
        'consignment.usage.recorded',
        {
          usageId: '0194f2c0-0000-7000-8000-000000000001',
          usageNo: 'CSN/U/1',
          agreementId: '0194f2c0-0000-7000-8000-000000000002',
          vendorId: '0194f2c0-0000-7000-8000-000000000003',
          patientId: '0194f2c0-0000-7000-8000-000000000004',
          encounterId: null,
          itemId: '0194f2c0-0000-7000-8000-000000000005',
          batchId: '0194f2c0-0000-7000-8000-000000000006',
          serialNo: 'SN-1',
          udiFull: null,
          qtyBase: '1',
          unitPrice: '45000.00',
          currency: 'INR',
          surgeonUserId: null,
          usedAt: '2026-08-25T10:00:00.000Z',
        },
        'unitPrice',
      ],
    ];

    for (const [type, payload, moneyField] of cases) {
      const def = getEventDefinition(type);
      expect(def, `${type} is not registered`).toBeDefined();
      expect(def?.schema.safeParse(payload).success, `${type} should accept its own shape`).toBe(true);
      expect(
        def?.schema.safeParse({ ...payload, [moneyField]: 11200.0 }).success,
        `${type}.${moneyField} must refuse a number — IEEE-754 loses paise`,
      ).toBe(false);
      expect(
        def?.schema.safeParse({ ...payload, [moneyField]: '11200.005' }).success,
        `${type}.${moneyField} must refuse sub-paise precision`,
      ).toBe(false);
    }
  });

  it('names both authorising pharmacists on a controlled-drug register entry', () => {
    // The database refuses an NDPS row whose second authoriser is absent or is
    // the first. The event has to be able to carry both, or the register the
    // outbox publishes is not the register the inspector reads.
    const def = getEventDefinition('pharmacy.narcotic.transaction');
    const base = {
      entryId: '0194f2c0-0000-7000-8000-000000000001',
      registerType: 'ndps',
      serialNo: 'BLR/NDPS/2026-27/0001',
      storeId: '0194f2c0-0000-7000-8000-000000000002',
      itemId: '0194f2c0-0000-7000-8000-000000000003',
      itemCode: 'MORPH10',
      batchId: null,
      txnType: 'dispense',
      qtyInBase: '0',
      qtyOutBase: '2',
      balanceAfterBase: '18',
      patientId: '0194f2c0-0000-7000-8000-000000000004',
      prescriberRegNo: 'KMC/12345',
      firstAuthUserId: '0194f2c0-0000-7000-8000-000000000005',
      secondAuthUserId: '0194f2c0-0000-7000-8000-000000000006',
      enteredAt: '2026-08-25T10:00:00.000Z',
    };
    expect(def?.schema.safeParse(base).success).toBe(true);
    expect(def?.containsPhi).toBe(true);
    expect(def?.retentionDays).toBeGreaterThanOrEqual(3650);
  });

  it('keeps tax, register and traceability evidence far longer than the outbox default', () => {
    // docs/04 §1: GST records eight years; NDPS registers and implant
    // traceability longer. The seven-day outbox purge would erase all of it.
    for (const type of [
      'purchase.po.approved',
      'purchase.invoice.approved_for_payment',
      'rx.dispensed',
      'consumption.recorded',
    ]) {
      expect(getEventDefinition(type)?.retentionDays, `${type} is tax evidence`).toBeGreaterThanOrEqual(2920);
    }
    for (const type of [
      'pharmacy.narcotic.transaction',
      'pharmacy.custody.variance',
      'pharmacy.recall.raised',
      'consignment.usage.recorded',
      'inventory.stock.corrected',
      'inventory.batch.written_off',
    ]) {
      expect(
        getEventDefinition(type)?.retentionDays,
        `${type} is statutory or safety evidence`,
      ).toBeGreaterThanOrEqual(3650);
    }
  });

  it('separates the runner from the poster on an allocation, in the payload', () => {
    // The role template legitimately holds both keys (docs/05 row 46 is one
    // "Accountant / Finance Manager"), so the enforcement is per run — which is
    // only possible if the event carries both identities separately.
    const def = getEventDefinition('consumption.allocation.posted');
    const shape = Object.keys((def?.schema as { shape?: object })?.shape ?? {});
    expect(shape).toContain('runBy');
    expect(shape).toContain('postedBy');
  });
});
