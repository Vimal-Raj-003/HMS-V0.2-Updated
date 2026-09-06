import { PERMISSION_CATALOGUE } from '@vims/contracts';
import { describe, expect, it } from 'vitest';
import { RCM_ROUTES, RCM_SCREENS, rcmScreen, rcmScreensInArea } from './screens';

const KNOWN_KEYS = new Set(PERMISSION_CATALOGUE.map((permission) => permission.key));

describe('the RCM screen catalogue', () => {
  it('gates every screen on a permission key that actually exists', () => {
    for (const screen of RCM_SCREENS) {
      expect(KNOWN_KEYS.has(screen.permission), `${screen.key} → ${screen.permission}`).toBe(true);
    }
  });

  /**
   * Each screen is gated on the key of the list it loads first, so a session that
   * can open the screen sees something on it. Gating the tariff console on
   * `tariff.version.publish` would hide the price list from everyone who only
   * needs to read it — which is nearly everyone who needs it.
   */
  it('gates each screen on the key of the list it loads', () => {
    expect(rcmScreen('rcm-billing').permission).toBe('bill.list');
    expect(rcmScreen('rcm-preauth').permission).toBe('preauth.list');
    expect(rcmScreen('rcm-packages').permission).toBe('pkg.activation.read');
    expect(rcmScreen('rcm-payments').permission).toBe('pay.recon.read');
    expect(rcmScreen('rcm-tariff').permission).toBe('tariff.plan.list');
    expect(rcmScreen('rcm-missing-rates').permission).toBe('tariff.missing.read');
    expect(rcmScreen('rcm-schemes').permission).toBe('scheme.claim.list');
    expect(rcmScreen('rcm-estimates').permission).toBe('est.list');
    expect(rcmScreen('rcm-leakage').permission).toBe('leak.finding.list');
    expect(rcmScreen('rcm-payouts').permission).toBe('payout.statement.list');
  });

  it('explains every denial in plain words', () => {
    for (const screen of RCM_SCREENS) {
      expect(screen.summary.length).toBeGreaterThan(20);
      expect(screen.deniedExplanation.length).toBeGreaterThan(20);
      expect(screen.keywords.length).toBeGreaterThan(0);
    }
  });

  it('uses a distinct key and route per screen', () => {
    expect(new Set(RCM_SCREENS.map((s) => s.key)).size).toBe(RCM_SCREENS.length);
    expect(new Set(RCM_SCREENS.map((s) => s.href)).size).toBe(RCM_SCREENS.length);
  });

  it('licence-gates every revenue-cycle screen', () => {
    for (const screen of RCM_SCREENS) {
      expect(screen.entitlement, screen.key).toBe('module.rcm.enabled');
    }
  });

  it('groups the screens into the console the nav renders', () => {
    expect(rcmScreensInArea('pricing')).toHaveLength(2);
    expect(rcmScreensInArea('billing')).toHaveLength(1);
    expect(rcmScreensInArea('payments')).toHaveLength(1);
    expect(rcmScreensInArea('packages')).toHaveLength(1);
    expect(rcmScreensInArea('insurance')).toHaveLength(1);
    expect(rcmScreensInArea('schemes')).toHaveLength(1);
    expect(rcmScreensInArea('estimates')).toHaveLength(1);
    expect(rcmScreensInArea('leakage')).toHaveLength(1);
    expect(rcmScreensInArea('payouts')).toHaveLength(1);
  });

  it('exports the route list for whoever wires navigation', () => {
    for (const route of [
      '/rcm/billing',
      '/rcm/payments',
      '/rcm/packages',
      '/rcm/tariff',
      '/rcm/missing-rates',
      '/rcm/schemes',
      '/rcm/estimates',
      '/rcm/leakage',
      '/rcm/payouts',
    ]) {
      expect(RCM_ROUTES).toContain(route);
    }
  });

  it('declares no route with a dynamic segment', () => {
    for (const route of RCM_ROUTES) {
      expect(route).not.toMatch(/[[\]]/u);
    }
  });

  it('throws on an unknown screen key rather than rendering an ungated page', () => {
    expect(() => rcmScreen('nope')).toThrow(/Unknown RCM screen/u);
  });

  /** OP-005 §5's maker-checker pair, same reasoning as RC-003's below. */
  it('keeps discount request and approve as two separate registered keys', () => {
    expect(KNOWN_KEYS.has('bill.discount.request')).toBe(true);
    expect(KNOWN_KEYS.has('bill.discount.approve')).toBe(true);
  });

  /**
   * RC-003 §5's approval matrix is "requester ≠ approver, always", and the
   * catalogue carries a `block` segregation rule to enforce it. This asserts the
   * two keys are genuinely distinct entries rather than aliases — a single key
   * behind both buttons would make the rule unenforceable.
   */
  /** RC-002 §5's maker-checker pair. */
  it('keeps preauth submit and decision as two separate registered keys', () => {
    expect(KNOWN_KEYS.has('preauth.submit')).toBe(true);
    expect(KNOWN_KEYS.has('preauth.decision.record')).toBe(true);
  });

  /**
   * RC-007 §5.6's two pairs. The write-off one is the sharper of them: a
   * shortfall written off is revenue the hospital gives up, and the person who
   * worked the claim is exactly the person with a reason to make an awkward
   * deduction disappear quietly.
   */
  it('keeps the two scheme maker-checker pairs as four separate registered keys', () => {
    expect(KNOWN_KEYS.has('scheme.claim.submit')).toBe(true);
    expect(KNOWN_KEYS.has('scheme.claim.decision.record')).toBe(true);
    expect(KNOWN_KEYS.has('scheme.shortfall.appeal')).toBe(true);
    expect(KNOWN_KEYS.has('scheme.shortfall.writeoff.approve')).toBe(true);
  });

  /**
   * RC-008's split. Writing a quote and measuring it against the bill it became
   * are deliberately different keys: a hospital does not learn that its quotes
   * run light from the people writing them.
   */
  it('separates issuing an estimate from measuring one', () => {
    expect(KNOWN_KEYS.has('est.issue')).toBe(true);
    expect(KNOWN_KEYS.has('est.variance.record')).toBe(true);
    expect(KNOWN_KEYS.has('est.variance.read')).toBe(true);
  });

  /**
   * RC-006 §5.7's "never auto-post". Finding a gap, agreeing it is real, and
   * recording that the money came back are three keys, because one button that
   * did all three would be the auto-post the rule forbids.
   */
  it('keeps finding, accepting and recovering as three separate keys', () => {
    expect(KNOWN_KEYS.has('leak.scan.run')).toBe(true);
    expect(KNOWN_KEYS.has('leak.finding.accept')).toBe(true);
    expect(KNOWN_KEYS.has('leak.recovery.record')).toBe(true);
  });

  /**
   * NC-034 §5.7's anti-kickback requirement is that a per-referral payment be
   * *unrepresentable*, which lives in the database. What the catalogue can
   * assert is the other half: computing a payout and releasing it are two keys.
   */
  it('keeps computing a payout separate from releasing it', () => {
    expect(KNOWN_KEYS.has('payout.statement.compute')).toBe(true);
    expect(KNOWN_KEYS.has('payout.statement.approve')).toBe(true);
    expect(KNOWN_KEYS.has('payout.statement.pay')).toBe(true);
  });

  /** Letting a patient leave with money on the table is its own decision. */
  it('separates running the discharge check from overriding it', () => {
    expect(KNOWN_KEYS.has('leak.discharge.check')).toBe(true);
    expect(KNOWN_KEYS.has('leak.discharge.override')).toBe(true);
  });

  /**
   * The refusal log is what an NHA audit asks for, so it is a permission
   * somebody holds rather than a query a developer runs.
   */
  it('registers the cash-refusal log as a readable permission', () => {
    expect(KNOWN_KEYS.has('scheme.cash.attempt.read')).toBe(true);
  });

  it('keeps submit and publish as two separate registered keys', () => {
    expect(KNOWN_KEYS.has('tariff.version.submit')).toBe(true);
    expect(KNOWN_KEYS.has('tariff.version.publish')).toBe(true);
    expect('tariff.version.submit').not.toBe('tariff.version.publish');
  });
});
