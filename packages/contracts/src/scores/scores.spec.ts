import { describe, expect, it } from 'vitest';
import { scoreEsi } from './esi.js';
import { scoreGcs } from './gcs.js';
import { scoreIss, scoreMgap, scoreRts, scoreTriss, shockIndex, TRISS_MTOS } from './trauma.js';

/**
 * Worked examples from the literature, and the properties that must hold for
 * every input.
 *
 * `phase-06`: "Scores are code, not opinion … with property-based tests and
 * worked examples from the literature." A score that only agrees with itself is
 * a score nobody outside this repository can check.
 */

describe('Glasgow Coma Scale', () => {
  it('adds the three components', () => {
    // E4 V5 M6 — awake, orientated, obeying.
    expect(scoreGcs({ eye: 4, verbal: 5, motor: 6 }).total).toBe(15);
    // E1 V1 M1 — the floor. Not zero: there is no GCS of 0 or 1 or 2.
    expect(scoreGcs({ eye: 1, verbal: 1, motor: 1 }).total).toBe(3);
  });

  it('bands severity the way the trauma literature does', () => {
    expect(scoreGcs({ eye: 1, verbal: 2, motor: 5 }).severity).toBe('severe'); // 8
    expect(scoreGcs({ eye: 3, verbal: 3, motor: 3 }).severity).toBe('moderate'); // 9
    expect(scoreGcs({ eye: 4, verbal: 4, motor: 5 }).severity).toBe('mild'); // 13
  });

  /**
   * The intubated case is the one that gets fudged in practice, in both
   * directions. Scoring the verbal component 1 makes a patient look worse than
   * they are; scoring it 5 makes them look better. `T` says the observation was
   * not available.
   */
  it('reports an intubated patient as nT and refuses to invent a verbal score', () => {
    const result = scoreGcs({ eye: 3, motor: 5, intubated: true });
    expect(result.total).toBe(8);
    expect(result.display).toBe('8T');
    expect(result.verbal).toBeNull();
    expect(result.severity).toBe('not_assessable');
  });

  it('uses the paediatric verbal ladder under five', () => {
    expect(scoreGcs({ eye: 4, verbal: 5, motor: 6, ageYears: 2 }).paediatricScale).toBe(true);
    expect(scoreGcs({ eye: 4, verbal: 5, motor: 6, ageYears: 7 }).paediatricScale).toBe(false);
  });

  it('refuses a component outside its range rather than clamping it', () => {
    expect(() => scoreGcs({ eye: 5, verbal: 5, motor: 6 })).toThrow(/eye opening/u);
    expect(() => scoreGcs({ eye: 4, verbal: 5, motor: 7 })).toThrow(/motor response/u);
    expect(() => scoreGcs({ eye: 4, verbal: 0, motor: 6 })).toThrow(/verbal response/u);
  });

  it('always produces a total between 3 and 15 for any valid input', () => {
    for (let eye = 1; eye <= 4; eye += 1) {
      for (let verbal = 1; verbal <= 5; verbal += 1) {
        for (let motor = 1; motor <= 6; motor += 1) {
          const total = scoreGcs({ eye, verbal, motor }).total;
          expect(total).toBeGreaterThanOrEqual(3);
          expect(total).toBeLessThanOrEqual(15);
        }
      }
    }
  });
});

describe('Revised Trauma Score', () => {
  /** A physiologically normal patient scores the maximum, 7.8408. */
  it('gives a normal patient the ceiling', () => {
    const result = scoreRts({ gcs: 15, systolicBp: 120, respiratoryRate: 16 });
    expect(result.gcsCoded).toBe(4);
    expect(result.sbpCoded).toBe(4);
    expect(result.rrCoded).toBe(4);
    expect(result.rts).toBeCloseTo(7.8408, 4);
  });

  it('gives a patient with no signs of life zero', () => {
    expect(scoreRts({ gcs: 3, systolicBp: 0, respiratoryRate: 0 }).rts).toBe(0);
  });

  /**
   * Champion's worked example: GCS 12, SBP 80, RR 32.
   * Coded 3, 3, 3 → 3 × (0.9368 + 0.7326 + 0.2908) = 5.8806.
   */
  it('matches the published worked example', () => {
    const result = scoreRts({ gcs: 12, systolicBp: 80, respiratoryRate: 32 });
    expect([result.gcsCoded, result.sbpCoded, result.rrCoded]).toEqual([3, 3, 3]);
    expect(result.rts).toBeCloseTo(5.8806, 4);
  });

  /**
   * A rate above 29 codes 3 while 6–9 codes 2. Tachypnoea is compensation;
   * bradypnoea is failure, and the score says so.
   */
  it('scores bradypnoea worse than tachypnoea', () => {
    expect(scoreRts({ gcs: 15, systolicBp: 120, respiratoryRate: 35 }).rrCoded).toBe(3);
    expect(scoreRts({ gcs: 15, systolicBp: 120, respiratoryRate: 8 }).rrCoded).toBe(2);
  });

  it('never leaves the 0 – 7.8408 range', () => {
    for (const gcs of [3, 4, 6, 9, 13, 15]) {
      for (const sbp of [0, 1, 50, 76, 90, 200]) {
        for (const rr of [0, 1, 6, 10, 29, 40]) {
          const { rts } = scoreRts({ gcs, systolicBp: sbp, respiratoryRate: rr });
          expect(rts).toBeGreaterThanOrEqual(0);
          expect(rts).toBeLessThanOrEqual(7.8408);
        }
      }
    }
  });
});

describe('Injury Severity Score', () => {
  /**
   * Baker's original worked example: AIS 4 head, 3 chest, 3 extremity,
   * 1 external. The three highest in *different* regions are 4, 3, 3.
   * 16 + 9 + 9 = 34.
   */
  it('matches the published worked example', () => {
    const result = scoreIss([
      { region: 'head_neck', severity: 4 },
      { region: 'chest', severity: 3 },
      { region: 'extremity', severity: 3 },
      { region: 'external', severity: 1 },
    ]);
    expect(result.iss).toBe(34);
    expect(result.band).toBe('profound');
  });

  /**
   * The difference Osler wrote NISS to fix: three severe chest injuries.
   * ISS counts only the worst one (25); NISS counts all three (75).
   */
  it('separates ISS from NISS when the injuries share a region', () => {
    const result = scoreIss([
      { region: 'chest', severity: 5 },
      { region: 'chest', severity: 5 },
      { region: 'chest', severity: 5 },
    ]);
    expect(result.iss).toBe(25);
    expect(result.niss).toBe(75);
  });

  it('treats any AIS 6 as 75 outright', () => {
    const result = scoreIss([
      { region: 'head_neck', severity: 6 },
      { region: 'extremity', severity: 1 },
    ]);
    expect(result.iss).toBe(75);
    expect(result.niss).toBe(75);
    expect(result.unsurvivable).toBe(true);
  });

  it('uses at most three regions even when six are injured', () => {
    const result = scoreIss([
      { region: 'head_neck', severity: 3 },
      { region: 'face', severity: 3 },
      { region: 'chest', severity: 3 },
      { region: 'abdomen', severity: 3 },
      { region: 'extremity', severity: 3 },
      { region: 'external', severity: 3 },
    ]);
    expect(result.iss).toBe(27); // 9 + 9 + 9, not 54
    expect(result.issRegions).toHaveLength(3);
  });

  it('scores nothing as nothing', () => {
    expect(scoreIss([]).iss).toBe(0);
  });

  it('refuses an AIS outside 1–6', () => {
    expect(() => scoreIss([{ region: 'chest', severity: 7 }])).toThrow(/between 1 and 6/u);
    expect(() => scoreIss([{ region: 'chest', severity: 0 }])).toThrow(/between 1 and 6/u);
  });

  it('always keeps NISS at or above ISS, and both within 1–75', () => {
    const severities = [1, 2, 3, 4, 5];
    const regions = ['head_neck', 'chest', 'extremity'] as const;
    for (const a of severities) {
      for (const b of severities) {
        for (const region of regions) {
          const result = scoreIss([
            { region: 'head_neck', severity: a },
            { region, severity: b },
          ]);
          expect(result.niss).toBeGreaterThanOrEqual(result.iss);
          expect(result.iss).toBeLessThanOrEqual(75);
          expect(result.niss).toBeLessThanOrEqual(75);
        }
      }
    }
  });
});

describe('shock index', () => {
  it('flags the compensating patient whose pressure has not dropped yet', () => {
    // HR 110, SBP 110 — both individually unremarkable, index 1.0.
    const result = shockIndex(110, 110);
    expect(result.value).toBe(1);
    expect(result.elevated).toBe(true);
  });

  it('leaves a normal patient alone', () => {
    expect(shockIndex(70, 120).elevated).toBe(false);
  });

  it('refuses a pressure of zero rather than returning Infinity', () => {
    expect(() => shockIndex(120, 0)).toThrow(/above zero/u);
  });
});

describe('MGAP and GAP', () => {
  /** A well young blunt-trauma patient: 15 + 4 + 5 + 5 = 29, the ceiling. */
  it('gives a well young blunt patient the maximum', () => {
    const result = scoreMgap({ gcs: 15, systolicBp: 130, ageYears: 30, blunt: true });
    expect(result.mgap).toBe(29);
    expect(result.gap).toBe(25);
    expect(result.mgapRisk).toBe('low');
  });

  /** An elderly penetrating patient, shocked and unconscious: 3 + 0 + 0 + 0. */
  it('gives the worst case the floor', () => {
    const result = scoreMgap({ gcs: 3, systolicBp: 50, ageYears: 78, blunt: false });
    expect(result.mgap).toBe(3);
    expect(result.mgapRisk).toBe('high');
  });
});

describe('TRISS', () => {
  /**
   * A physiologically normal young blunt-trauma patient with a moderate injury
   * should come out near-certain to survive.
   *
   * b = -1.247 + 0.9544·7.8408 + (-0.0768·9) + (-1.9052·0) = 5.5451
   * Ps = 1/(1+e^-5.5451) ≈ 0.9961
   */
  it('matches a hand-computed blunt case', () => {
    const result = scoreTriss({ rts: 7.8408, iss: 9, ageYears: 30, mechanism: 'blunt' });
    expect(result.b).toBeCloseTo(5.5451, 3);
    expect(result.probabilityOfSurvival).toBeCloseTo(0.9961, 3);
    expect(result.ageIndex).toBe(0);
    expect(result.coefficientSet).toBe('MTOS blunt');
  });

  /**
   * The same physiology and injury in a 60-year-old. The age term is a step of
   * -1.9052 at 55, so the prediction drops materially for one extra year of age
   * — a known crudeness of the model, and one the score should not hide.
   */
  it('applies the age step at 55', () => {
    const younger = scoreTriss({ rts: 7.8408, iss: 25, ageYears: 54, mechanism: 'blunt' });
    const older = scoreTriss({ rts: 7.8408, iss: 25, ageYears: 55, mechanism: 'blunt' });
    expect(younger.ageIndex).toBe(0);
    expect(older.ageIndex).toBe(1);
    expect(older.probabilityOfSurvival).toBeLessThan(younger.probabilityOfSurvival);
  });

  it('uses a different coefficient set for penetrating trauma', () => {
    const blunt = scoreTriss({ rts: 6, iss: 25, ageYears: 30, mechanism: 'blunt' });
    const penetrating = scoreTriss({ rts: 6, iss: 25, ageYears: 30, mechanism: 'penetrating' });
    expect(blunt.probabilityOfSurvival).not.toBe(penetrating.probabilityOfSurvival);
    expect(penetrating.coefficientSet).toBe('MTOS penetrating');
  });

  it("accepts a hospital's own validated coefficients", () => {
    const local = { label: 'VIMS 2026', b0: -1, bRts: 1, bIss: -0.1, bAge: -1.5 };
    const result = scoreTriss({
      rts: 7.8408,
      iss: 9,
      ageYears: 30,
      mechanism: 'blunt',
      coefficients: local,
    });
    expect(result.coefficientSet).toBe('VIMS 2026');
    expect(result.b).toBeCloseTo(-1 + 7.8408 - 0.9, 3);
  });

  it('always returns a probability between 0 and 1', () => {
    for (const rts of [0, 2, 4, 6, 7.8408]) {
      for (const iss of [1, 9, 25, 50, 75]) {
        for (const age of [5, 30, 54, 55, 90]) {
          for (const mechanism of ['blunt', 'penetrating'] as const) {
            const { probabilityOfSurvival } = scoreTriss({ rts, iss, ageYears: age, mechanism });
            expect(probabilityOfSurvival).toBeGreaterThanOrEqual(0);
            expect(probabilityOfSurvival).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });

  it('is monotonic: a worse injury never predicts better survival', () => {
    let previous = 1;
    for (const iss of [1, 9, 16, 25, 41, 75]) {
      const { probabilityOfSurvival } = scoreTriss({ rts: 6, iss, ageYears: 40, mechanism: 'blunt' });
      expect(probabilityOfSurvival).toBeLessThanOrEqual(previous);
      previous = probabilityOfSurvival;
    }
  });

  it('publishes the MTOS sets so a hospital can see what it is being compared against', () => {
    expect(TRISS_MTOS.blunt.bAge).toBe(-1.9052);
    expect(TRISS_MTOS.penetrating.bAge).toBe(-2.6676);
  });
});

describe('Emergency Severity Index', () => {
  it('returns level 1 at decision point A, before counting anything', () => {
    const result = scoreEsi({
      needsLifeSavingIntervention: true,
      highRisk: false,
      // Deliberately zero: a dying patient is not triaged by how much work they
      // will be, and the algorithm must never reach decision C.
      resourceCount: 0,
      ageYears: 40,
    });
    expect(result.level).toBe(1);
    expect(result.decisionPoint).toBe('A');
    expect(result.targetMinutes).toBe(0);
  });

  it('returns level 2 at decision point B for a high-risk presentation', () => {
    const result = scoreEsi({
      needsLifeSavingIntervention: false,
      highRisk: true,
      resourceCount: 0,
      ageYears: 40,
    });
    expect(result.level).toBe(2);
    expect(result.decisionPoint).toBe('B');
  });

  it('counts resources for everyone else', () => {
    const base = { needsLifeSavingIntervention: false, highRisk: false, ageYears: 40 };
    expect(scoreEsi({ ...base, resourceCount: 0 }).level).toBe(5);
    expect(scoreEsi({ ...base, resourceCount: 1 }).level).toBe(4);
    expect(scoreEsi({ ...base, resourceCount: 2 }).level).toBe(3);
    expect(scoreEsi({ ...base, resourceCount: 6 }).level).toBe(3);
  });

  it('upgrades a level 3 to a level 2 on danger-zone vitals', () => {
    const result = scoreEsi({
      needsLifeSavingIntervention: false,
      highRisk: false,
      resourceCount: 3,
      ageYears: 40,
      vitals: { heartRate: 128, respiratoryRate: 18 },
    });
    expect(result.level).toBe(2);
    expect(result.decisionPoint).toBe('D');
    expect(result.dangerZoneVitals[0]).toContain('heart rate 128');
  });

  /**
   * The paediatric case, and the reason the bands exist. A heart rate of 150 is
   * a resuscitation in an adult and unremarkable in a three-month-old.
   */
  it('does not flag an infant for a heart rate that would alarm in an adult', () => {
    const infant = scoreEsi({
      needsLifeSavingIntervention: false,
      highRisk: false,
      resourceCount: 3,
      ageYears: 0.2,
      vitals: { heartRate: 150, respiratoryRate: 40 },
    });
    expect(infant.level).toBe(3);

    const adult = scoreEsi({
      needsLifeSavingIntervention: false,
      highRisk: false,
      resourceCount: 3,
      ageYears: 40,
      vitals: { heartRate: 150, respiratoryRate: 40 },
    });
    expect(adult.level).toBe(2);
  });

  it('treats 90–92% saturation as a reason not to wait', () => {
    const result = scoreEsi({
      needsLifeSavingIntervention: false,
      highRisk: false,
      resourceCount: 2,
      ageYears: 60,
      vitals: { spo2: 91 },
    });
    expect(result.level).toBe(2);
    expect(result.dangerZoneVitals[0]).toContain('91%');
  });

  it('never returns a level outside 1–5, and the target always matches', () => {
    for (const lifeSaving of [true, false]) {
      for (const highRisk of [true, false]) {
        for (const resources of [0, 1, 2, 5]) {
          for (const age of [0.1, 2, 10, 40, 80]) {
            const result = scoreEsi({
              needsLifeSavingIntervention: lifeSaving,
              highRisk,
              resourceCount: resources,
              ageYears: age,
              vitals: { heartRate: 88, respiratoryRate: 18, spo2: 98 },
            });
            expect(result.level).toBeGreaterThanOrEqual(1);
            expect(result.level).toBeLessThanOrEqual(5);
            expect(result.targetMinutes).toBe({ 1: 0, 2: 10, 3: 30, 4: 60, 5: 120 }[result.level]);
          }
        }
      }
    }
  });
});
