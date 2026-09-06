import { PERMISSION_CATALOGUE } from '@vims/contracts';
import { describe, expect, it } from 'vitest';
import { ER_ROUTES, ER_SCREENS, erScreen } from './screens';

const KNOWN_KEYS = new Set(PERMISSION_CATALOGUE.map((permission) => permission.key));

describe('the emergency screen catalogue', () => {
  it('gates every screen on a permission key that actually exists', () => {
    for (const screen of ER_SCREENS) {
      expect(KNOWN_KEYS.has(screen.permission), `${screen.key} → ${screen.permission}`).toBe(true);
    }
  });

  /**
   * The board is gated on reading the board, not on registering an arrival.
   * Gating it on `er.quickreg` would hide the department's status display from
   * anybody who is not allowed to book patients in.
   */
  it('gates the board on the list it loads', () => {
    expect(erScreen('er-board').permission).toBe('er.board.read');
  });

  /**
   * `phase-06`'s central constraint: registration is never a precondition for
   * care. `er.quickreg` is therefore deliberately `low` risk — a permission
   * model that made it hard to reach would be one that killed somebody.
   */
  it('keeps quick registration a low-risk permission', () => {
    const quickReg = PERMISSION_CATALOGUE.find((permission) => permission.key === 'er.quickreg');
    expect(quickReg).toBeDefined();
    expect(quickReg?.risk).toBe('low');
  });

  /**
   * Reconciling a tag into a UHID moves a clinical record onto a real person.
   * It is the one identity operation in the module that carries a reason.
   */
  it('makes merging an identity a reasoned, high-risk act', () => {
    const merge = PERMISSION_CATALOGUE.find((permission) => permission.key === 'er.identity.merge');
    expect(merge?.risk).toBe('high');
    expect(merge?.requiresReason).toBe(true);
  });

  /**
   * TR-001's central asymmetry, asserted rather than described.
   *
   * Under-triage — the team not called, or called late — is the failure mode
   * every trauma system is judged on. So calling the team is a `low`-risk key
   * held by every nurse on the floor, and *releasing* them is the one that
   * carries a reason. A catalogue that ever inverted this would produce the
   * failure the module exists to prevent.
   */
  it('makes calling the trauma team easy and standing it down considered', () => {
    const call = PERMISSION_CATALOGUE.find((p) => p.key === 'trauma.activation.create');
    const release = PERMISSION_CATALOGUE.find((p) => p.key === 'trauma.activation.standdown');

    expect(call?.risk).toBe('low');
    expect(call?.requiresReason ?? false).toBe(false);
    expect(release?.requiresReason).toBe(true);
  });

  /**
   * The nurse in front of the patient is the person who knows the algorithm is
   * wrong about them. An override that needed a supervisor would become a level
   * nobody corrected, so it stays reachable — and stays reasoned.
   */
  it('keeps the triage override reachable but always reasoned', () => {
    const override = PERMISSION_CATALOGUE.find((p) => p.key === 'triage.level.override');
    expect(override?.risk).toBe('medium');
    expect(override?.requiresReason).toBe(true);
  });

  /**
   * ISS and TRISS go into a registry and into mortality review. "Was the score
   * changed after the death?" has to be answerable either way, so an amendment
   * is a separate, higher key that states its reason.
   */
  it('separates signing a score from amending a signed one', () => {
    const lock = PERMISSION_CATALOGUE.find((p) => p.key === 'trauma.score.lock');
    const amend = PERMISSION_CATALOGUE.find((p) => p.key === 'trauma.score.amend');

    expect(lock?.key).not.toBe(amend?.key);
    expect(amend?.risk).toBe('high');
    expect(amend?.requiresReason).toBe(true);
  });

  it('gates each Phase 6 screen on the list it loads', () => {
    expect(erScreen('trauma-board').permission).toBe('trauma.activation.list');
    expect(erScreen('trauma-registry').permission).toBe('trauma.score.read');
  });

  /**
   * TR-008's disclosure model, asserted rather than described.
   *
   * A restricted case is invisible without a second key, and that key is
   * reason-required and two-approver to grant. The register screen is gated on
   * the ordinary register key so the desk can work; the restriction lives on
   * the rows, which is where the disclosure would happen.
   */
  it('gates the medico-legal register on the register key, not the sensitive one', () => {
    expect(erScreen('mlc-register').permission).toBe('mlc.register.read');
    expect(erScreen('mlc-case').permission).toBe('mlc.case.read');

    const sensitive = PERMISSION_CATALOGUE.find((p) => p.key === 'mlc.sensitive.read');
    expect(sensitive?.risk).toBe('critical');
    expect(sensitive?.requiresReason).toBe(true);
    expect(sensitive?.sensitiveGrant).toBe(true);
  });

  /**
   * Opening an MLC has to be as easy as registering an arrival, and for the
   * same reason: a case nobody opened because the key was awkward is a case the
   * hospital cannot later prove it saw.
   */
  it('keeps opening a medico-legal case a low-risk permission', () => {
    const open = PERMISSION_CATALOGUE.find((p) => p.key === 'mlc.case.create');
    expect(open?.risk).toBe('low');
    expect(open?.requiresReason ?? false).toBe(false);
  });

  /**
   * The dispatch console and the patient record are separate screens on
   * separate keys, and that separation is the module's shape: a call-centre
   * agent sends an ambulance and never sees what comes back in it.
   */
  it('keeps the ambulance console off the clinical key', () => {
    expect(erScreen('ambulance-dispatch').permission).toBe('fleet.trip.read');
    expect(erScreen('prehospital-trip').permission).toBe('prehospital.pcr.read');

    const dispatch = PERMISSION_CATALOGUE.find((p) => p.key === 'fleet.trip.read');
    const record = PERMISSION_CATALOGUE.find((p) => p.key === 'prehospital.pcr.read');
    expect(dispatch?.dataClass).toBe('operational');
    expect(record?.dataClass).toBe('phi');
  });

  it('explains every denial in plain words', () => {
    for (const screen of ER_SCREENS) {
      expect(screen.summary.length).toBeGreaterThan(20);
      expect(screen.deniedExplanation.length).toBeGreaterThan(20);
      expect(screen.keywords.length).toBeGreaterThan(0);
    }
  });

  it('uses a distinct key and route per screen', () => {
    expect(new Set(ER_SCREENS.map((s) => s.key)).size).toBe(ER_SCREENS.length);
    expect(new Set(ER_SCREENS.map((s) => s.href)).size).toBe(ER_SCREENS.length);
  });

  it('declares no route with a dynamic segment', () => {
    for (const route of ER_ROUTES) {
      expect(route).not.toMatch(/[[\]]/u);
    }
  });

  it('throws on an unknown screen key rather than rendering an ungated page', () => {
    expect(() => erScreen('nope')).toThrow(/Unknown ER screen/u);
  });
});
