import { PERMISSION_CATALOGUE } from '@vims/contracts';
import { describe, expect, it } from 'vitest';
import { PATIENT_RECORD_SCREEN, PATIENT_SCREENS, patientScreen } from './screens';

/**
 * The front-office screen catalogue.
 *
 * Its one job is to stop a screen being gated on a permission key that does not
 * exist, which hides it from *everyone* and looks like a permissions bug rather
 * than a typo. `PERMISSION_CATALOGUE` is the same list the API asserts its own
 * decorators against at boot, so the two cannot drift.
 *
 * The navigation is deliberately **not** asserted here, unlike
 * `features/admin/screens.spec.ts`: wiring `lib/nav.ts` belongs to another change,
 * and this list is the hand-off it will read.
 */

const KNOWN_KEYS = new Set(PERMISSION_CATALOGUE.map((permission) => permission.key));

describe('the front-office screen catalogue', () => {
  it('gates every screen on a permission key that actually exists', () => {
    for (const screen of PATIENT_SCREENS) {
      expect(KNOWN_KEYS.has(screen.permission), `${screen.key} → ${screen.permission}`).toBe(true);
    }
    expect(KNOWN_KEYS.has(PATIENT_RECORD_SCREEN.permission)).toBe(true);
  });

  it('gates the registration desk on the key its *first* request needs, not the one its form needs', () => {
    // The screen searches before it registers, and a call-centre agent may search
    // without being able to create. Gating on `patient.record.create` would hide
    // the search from the people whose whole job it is.
    const registration = patientScreen('registration');
    expect(registration.permission).toBe('patient.record.list');
  });

  it('gates the merge tool on reviewing rather than executing', () => {
    expect(patientScreen('merge').permission).toBe('patient.merge.review');
  });

  it('gives every screen a summary and a plain-words explanation for the denied state', () => {
    for (const screen of PATIENT_SCREENS) {
      expect(screen.summary.length).toBeGreaterThan(20);
      expect(screen.deniedExplanation.length).toBeGreaterThan(20);
      expect(screen.keywords.length).toBeGreaterThan(0);
    }
    expect(PATIENT_RECORD_SCREEN.deniedExplanation.length).toBeGreaterThan(20);
  });

  it('uses a distinct key and route per screen', () => {
    expect(new Set(PATIENT_SCREENS.map((s) => s.key)).size).toBe(PATIENT_SCREENS.length);
    expect(new Set(PATIENT_SCREENS.map((s) => s.href)).size).toBe(PATIENT_SCREENS.length);
  });

  it('keeps PHI out of every route it advertises', () => {
    for (const screen of PATIENT_SCREENS) {
      expect(String(screen.href)).not.toContain('?');
    }
  });

  it('refuses to look up a screen that does not exist rather than rendering an ungated page', () => {
    expect(() => patientScreen('not-a-screen')).toThrow(/Unknown patient screen/);
  });
});
