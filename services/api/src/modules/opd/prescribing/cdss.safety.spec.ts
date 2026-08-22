import { describe, expect, it } from 'vitest';
import {
  FLOOR_KEY,
  NEVER_DEGRADING_FAMILIES,
  NO_TUNING,
  applyTuning,
  evaluate,
  evaluateSafetyFloor,
  hardStops,
  type CdssAlert,
  type CdssTuning,
} from './cdss.engine.js';
import { CEFTRIAXONE, PARACETAMOL, allergy, drug, knowledge, line, patient } from './cdss.fixtures.js';

/**
 * The clinical-safety suite — `docs/09` §15 stage 9, which runs on **every** PR.
 *
 * These assertions are deliberately duplicated from `cdss.engine.spec.ts`. That
 * is the point of the suite: it runs in its own config, cannot be filtered out
 * by `--changed`, and a failure here is the only red thing on the page. The
 * properties are the ones `docs/04` §7 says no configuration may remove.
 *
 * Nothing here touches a database. The database's half of the same guarantee —
 * the floor table with no `active` column, the revoked grants, the trigger on
 * the tuning table — is proven in `packages/testing/verify-phase2` and in this
 * module's integration suite, against a real PostgreSQL.
 */

const ALLERGIC = {
  patient: patient({ allergies: [allergy()] }),
  lines: [line()],
  knowledge: knowledge(),
};

describe('the allergy hard stop cannot be configured away (phase-02 exit gate 2)', () => {
  it('fires with no tuning at all', () => {
    expect(hardStops(evaluateSafetyFloor(ALLERGIC)).map((a) => a.floorKey)).toContain(FLOOR_KEY.allergy);
  });

  it('has no configuration parameter to receive', () => {
    // The guarantee is structural, exactly as it is in the schema: the way to
    // prove no flag can disable it is to leave no flag to write.
    expect(evaluateSafetyFloor.length).toBe(1);
  });

  it('fires under every tuning a tenant could author, including an emergency window', () => {
    const hostile: CdssTuning[] = [
      { familyInterruption: { allergy: 'passive' }, disabledFamilies: [], emergencyModeOpen: false },
      { familyInterruption: { allergy: 'shadow' }, disabledFamilies: [], emergencyModeOpen: true },
      { familyInterruption: {}, disabledFamilies: ['allergy'], emergencyModeOpen: true },
      {
        familyInterruption: { allergy: 'shadow', ddi: 'shadow', dose_range: 'shadow' },
        disabledFamilies: ['allergy', 'ddi', 'dose_range', 'pregnancy', 'paediatric_weight'],
        emergencyModeOpen: true,
      },
    ];

    for (const tuning of hostile) {
      const alerts = evaluate({ ...ALLERGIC, vendor: { interactions: [] } }, tuning);
      const stop = hardStops(alerts).find((a) => a.floorKey === FLOOR_KEY.allergy);
      expect(stop, `tuning ${JSON.stringify(tuning)} suppressed the allergy hard stop`).toBeDefined();
      expect(stop?.interruption).toBe('hard_stop');
    }
  });

  it('throws rather than degrade if a floor alert is ever routed through tuning', () => {
    const stop = evaluateSafetyFloor(ALLERGIC)[0] as CdssAlert;
    expect(() => applyTuning(stop, NO_TUNING)).toThrow();
  });
});

describe('the floor does not degrade when the knowledge base is gone (D-9)', () => {
  const noKnowledgeBase = { interactions: [], doseBands: [] };

  it('still hard-stops a documented allergy', () => {
    const alerts = evaluateSafetyFloor({
      patient: patient({ allergies: [allergy()] }),
      lines: [line()],
      knowledge: { crossMap: knowledge().crossMap, ...noKnowledgeBase },
    });
    expect(hardStops(alerts).map((a) => a.floorKey)).toContain(FLOOR_KEY.allergy);
  });

  it('still catches a cross-reactive class', () => {
    const alerts = evaluateSafetyFloor({
      patient: patient({ allergies: [allergy()] }),
      lines: [line({ drug: CEFTRIAXONE })],
      knowledge: { crossMap: knowledge().crossMap, ...noKnowledgeBase },
    });
    expect(hardStops(alerts).map((a) => a.floorKey)).toContain(FLOOR_KEY.allergy);
  });

  it('still blocks a weight-dosed paediatric line with no weight', () => {
    const alerts = evaluateSafetyFloor({
      patient: patient({ ageYears: 3, weightKg: null }),
      lines: [line({ drug: PARACETAMOL, doseBasis: 'per_kg', doseQty: 15 })],
      knowledge: { crossMap: [], ...noKnowledgeBase },
    });
    expect(hardStops(alerts).map((a) => a.floorKey)).toContain(FLOOR_KEY.paediatricWeight);
  });

  it('still blocks pregnancy category X', () => {
    const alerts = evaluateSafetyFloor({
      patient: patient({ pregnancyConfirmed: true }),
      lines: [line({ drug: drug({ pregnancyCategory: 'x' }) })],
      knowledge: { crossMap: [], ...noKnowledgeBase },
    });
    expect(hardStops(alerts).map((a) => a.floorKey)).toContain(FLOOR_KEY.pregnancyX);
  });

  it('names exactly the families the database CHECK forbids from degrading', () => {
    // `prescriptions_degraded_excludes_floor` refuses an Rx that claims any of
    // these degraded. A list that drifted from it would turn a degraded sign
    // into a constraint violation at the worst possible moment.
    expect([...NEVER_DEGRADING_FAMILIES].sort()).toEqual([
      'allergy',
      'paediatric_weight',
      'pregnancy',
      'schedule_guardrail',
    ]);
  });
});
