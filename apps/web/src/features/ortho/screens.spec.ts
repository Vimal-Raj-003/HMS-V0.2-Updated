import { PERMISSION_CATALOGUE } from '@vims/contracts';
import { describe, expect, it } from 'vitest';
import { ORTHO_ROUTES, ORTHO_SCREENS, orthoScreen } from './screens';

const KNOWN_KEYS = new Set(PERMISSION_CATALOGUE.map((permission) => permission.key));

describe('the orthopaedic screen catalogue', () => {
  it('gates every screen on a permission key that actually exists', () => {
    for (const screen of ORTHO_SCREENS) {
      expect(KNOWN_KEYS.has(screen.permission), `${screen.key} → ${screen.permission}`).toBe(true);
    }
  });

  /**
   * Registering a fracture has to be as easy as triaging one. A fracture nobody
   * entered is a fracture the registry never counts and nobody follows up, and
   * the registry is what a trauma centre is audited on.
   */
  it('keeps registering a fracture a low-risk permission', () => {
    const create = PERMISSION_CATALOGUE.find((p) => p.key === 'fracture.record.create');
    expect(create?.risk).toBe('low');
    expect(create?.requiresReason ?? false).toBe(false);
  });

  /**
   * And confirming it is not, because an AO/OTA code is a treatment decision
   * written as a number — it decides whether this is a nail or a plate.
   */
  it('separates registering from confirming the classification', () => {
    const confirm = PERMISSION_CATALOGUE.find((p) => p.key === 'fracture.classification.confirm');
    expect(confirm).toBeDefined();
    expect(confirm?.key).not.toBe('fracture.record.create');
    expect(confirm?.risk).toBe('medium');
  });

  /**
   * Declaring union deliberately does **not** demand a reason on every call.
   * A fracture that healed at fourteen weeks needs no justification, and
   * requiring one teaches people to type "healed" into a reason box — which
   * then means nothing on the declaration that genuinely needs grounds. The
   * six-month non-union rule asks at the point it applies.
   */
  it('does not demand a written reason for every union declaration', () => {
    const declare = PERMISSION_CATALOGUE.find((p) => p.key === 'fracture.union.declare');
    expect(declare?.requiresReason ?? false).toBe(false);
  });

  it('makes the registry export reasoned', () => {
    const exportKey = PERMISSION_CATALOGUE.find((p) => p.key === 'fracture.registry.export');
    expect(exportKey?.requiresReason).toBe(true);
    expect(exportKey?.risk).toBe('high');
  });

  it('explains every denial in plain words', () => {
    for (const screen of ORTHO_SCREENS) {
      expect(screen.summary.length).toBeGreaterThan(20);
      expect(screen.deniedExplanation.length).toBeGreaterThan(20);
      expect(screen.keywords.length).toBeGreaterThan(0);
    }
  });

  it('uses a distinct key and route per screen', () => {
    expect(new Set(ORTHO_SCREENS.map((s) => s.key)).size).toBe(ORTHO_SCREENS.length);
    expect(new Set(ORTHO_SCREENS.map((s) => s.href)).size).toBe(ORTHO_SCREENS.length);
  });

  it('declares no route with a dynamic segment', () => {
    for (const route of ORTHO_ROUTES) {
      expect(route).not.toMatch(/[[\]]/u);
    }
  });

  it('throws on an unknown screen key rather than rendering an ungated page', () => {
    expect(() => orthoScreen('nope')).toThrow(/Unknown ortho screen/u);
  });
});
