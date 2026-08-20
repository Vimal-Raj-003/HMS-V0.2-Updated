import { describe, expect, it } from 'vitest';
import { PERMISSION_CATALOGUE, getPermission } from './permissions.js';
import { ROLE_TEMPLATES, getRoleTemplate } from './role-templates.js';

/**
 * Phase 1 grants — the check that the front desk can actually do its job.
 *
 * A permission that exists in the catalogue but is held by nobody is invisible:
 * the route denies every user, and the symptom ("registration is broken for
 * everyone") looks nothing like the cause. These assertions come straight from
 * the §12 Permissions sections of OP-001, EN-006 and NC-001.
 */
describe('Phase 1 permission catalogue', () => {
  it('registers the families the Phase 1 specs name', () => {
    const prefixes = [
      'patient.',
      'appointment.',
      'visit.',
      'schedule.',
      'queue.',
      'receipt.',
      'messaging.',
      'abdm.',
      'consent.',
    ];
    for (const prefix of prefixes) {
      const found = PERMISSION_CATALOGUE.filter((d) => d.key.startsWith(prefix));
      expect(found.length, `no keys registered for "${prefix}"`).toBeGreaterThan(0);
    }
  });

  it('marks the dangerous Phase 1 keys as dangerous', () => {
    // A merge rewrites a patient's identity across every module, and the
    // duplicate override deliberately defeats the check that prevents it.
    expect(getPermission('patient.merge.execute')?.requiresStepUp).toBe(true);
    expect(getPermission('patient.merge.execute')?.sensitiveGrant).toBe(true);
    expect(getPermission('patient.record.create_override')?.requiresReason).toBe(true);
    // Money leaving the building needs a second pair of eyes.
    expect(getPermission('receipt.refund.pay')?.requiresSecondPerson).toBe(true);
    expect(getPermission('receipt.void')?.requiresSecondPerson).toBe(true);
  });

  it('keeps the queue and alert paths outside licence gating', () => {
    // EN-040 §5: clinical safety is never gated. A hospital that has not paid an
    // invoice must still be able to issue a token and show an allergy banner.
    expect(getPermission('queue.token.issue')?.clinicalSafetyExempt).toBe(true);
    expect(getPermission('queue.board.read')?.clinicalSafetyExempt).toBe(true);
    expect(getPermission('patient.alert.manage')?.clinicalSafetyExempt).toBe(true);
    expect(getPermission('consent.emergency_override')?.clinicalSafetyExempt).toBe(true);
  });
});

describe('Phase 1 role grants', () => {
  const held = (role: string): ReadonlySet<string> => new Set(getRoleTemplate(role)?.permissions ?? []);

  it('lets a receptionist register, book, check in and issue a token', () => {
    const r = held('receptionist');
    for (const key of [
      'patient.record.create',
      'patient.record.list',
      'appointment.create',
      'visit.create',
      'queue.token.issue',
      'abdm.abha.link',
      'consent.capture',
    ]) {
      expect(r.has(key), `receptionist should hold ${key}`).toBe(true);
    }
  });

  /**
   * OP-001 §12 keeps these away from the front desk deliberately. A receptionist
   * who can merge records or override the duplicate check can quietly destroy a
   * patient's history, and the point of the duplicate score is that somebody is
   * named for defeating it.
   */
  it('withholds merge, export and duplicate-override from the front desk', () => {
    const r = held('receptionist');
    for (const key of ['patient.merge.execute', 'patient.record.export', 'patient.record.create_override']) {
      expect(r.has(key), `receptionist must NOT hold ${key}`).toBe(false);
    }
  });

  it('gives merge to MRD, and only to MRD', () => {
    expect(held('mrd_officer').has('patient.merge.execute')).toBe(true);
    const others = ROLE_TEMPLATES.filter(
      (t) => t.key !== 'mrd_officer' && t.permissions.includes('patient.merge.execute'),
    ).map((t) => t.key);
    expect(others, 'merge should not be granted outside MRD by default').toEqual([]);
  });

  it('lets a cashier run a shift but not pay a refund', () => {
    const c = held('cashier');
    expect(c.has('receipt.shift.open')).toBe(true);
    expect(c.has('receipt.collect')).toBe(true);
    expect(c.has('receipt.shift.close')).toBe(true);
    // NC-001 §12 puts the payout behind its own key with an amount limit.
    expect(c.has('receipt.refund.pay')).toBe(false);
    // And a cashier may not approve their own variance.
    expect(c.has('receipt.shift.variance.approve')).toBe(false);
  });

  it('separates who declares a variance from who approves it', () => {
    // Segregation of duties (docs/05): creator may never be approver.
    expect(held('cashier').has('receipt.shift.close')).toBe(true);
    expect(held('accountant').has('receipt.shift.variance.approve')).toBe(true);
    expect(held('accountant').has('receipt.collect')).toBe(false);
  });

  it('lets a doctor configure their own schedule but not publish it', () => {
    expect(held('doctor_consultant_opd').has('schedule.configure')).toBe(true);
    expect(held('doctor_consultant_opd').has('schedule.publish')).toBe(false);
    expect(held('branch_admin').has('schedule.publish')).toBe(true);
  });

  it('gives the auditor reads and nothing that mutates', () => {
    // `audit.integrity.run` verifies the hash chain and reports findings. It
    // changes nothing, and an auditor who cannot run the verification cannot do
    // the job the role exists for — so it is a read in everything but its verb.
    const NON_MUTATING_EXCEPTIONS = new Set(['audit.integrity.run']);
    const auditor = getRoleTemplate('auditor');
    const mutating = (auditor?.permissions ?? []).filter((key) => {
      if (NON_MUTATING_EXCEPTIONS.has(key)) return false;
      const def = getPermission(key);
      return def !== undefined && !['read', 'list', 'export', 'print'].includes(def.action);
    });
    expect(mutating, 'the auditor must hold no mutating permission').toEqual([]);
  });

  it('gives the DPO the consent ledger, the opt-out ledger and the DSAR path', () => {
    const dpo = held('privacy_officer');
    expect(dpo.has('consent.ledger.read')).toBe(true);
    expect(dpo.has('consent.dsar.manage')).toBe(true);
    expect(dpo.has('messaging.optin.manage')).toBe(true);
  });

  it('grants every Phase 1 key to at least one role', () => {
    const granted = new Set(ROLE_TEMPLATES.flatMap((t) => t.permissions));
    const orphans = PERMISSION_CATALOGUE.filter((d) => d.phase === 1 && !granted.has(d.key)).map(
      (d) => d.key,
    );
    // An ungranted key is a route nobody can reach — invisible until somebody
    // reports that a whole screen is empty for every user.
    expect(orphans, 'Phase 1 keys held by no role template').toEqual([]);
  });
});
