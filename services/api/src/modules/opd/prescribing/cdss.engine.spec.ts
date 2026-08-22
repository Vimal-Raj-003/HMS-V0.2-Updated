import { describe, expect, it } from 'vitest';
import {
  FLOOR_KEY,
  NO_TUNING,
  applyTuning,
  atcContains,
  evaluate,
  evaluateSafetyFloor,
  hardStops,
  populationChain,
  softStops,
  type CdssAlert,
  type CdssTuning,
} from './cdss.engine.js';
import {
  CEFTRIAXONE,
  MORPHINE,
  PARACETAMOL,
  VENDOR_PAIRS,
  allergy,
  drug,
  knowledge,
  line,
  patient,
} from './cdss.fixtures.js';

/**
 * The rules, tested where they are pure.
 *
 * These are the assertions that must fail the moment a check is deleted. Every
 * one of them was confirmed to fail with the corresponding rule removed before
 * being committed — a green suite over an engine with no safety checks is the
 * worst outcome available here, and it is easy to produce by accident.
 */

const floorOf = (alerts: readonly CdssAlert[]): readonly (string | null)[] =>
  hardStops(alerts).map((a) => a.floorKey);

describe('ATC containment', () => {
  it('treats a class code as containing its members, and nothing shorter', () => {
    expect(atcContains('J01C', 'J01CA04')).toBe(true);
    expect(atcContains('J01CA04', 'J01CA04')).toBe(true);
    expect(atcContains('J01CA04', 'J01C')).toBe(false);
    // Two characters is a chapter, not a code: it would match hundreds of
    // unrelated molecules and turn every allergy into a hard stop.
    expect(atcContains('J0', 'J01CA04')).toBe(false);
    expect(atcContains(null, 'J01CA04')).toBe(false);
  });
});

describe('allergy — the floor (docs/04 §7, exit gate 2)', () => {
  it('hard-stops a drug the patient has a documented anaphylactic allergy to', () => {
    const alerts = evaluateSafetyFloor({
      patient: patient({ allergies: [allergy()] }),
      lines: [line()],
      knowledge: knowledge(),
    });
    expect(floorOf(alerts)).toContain(FLOOR_KEY.allergy);
  });

  it('matches an uncoded allergy by the text the desk typed', () => {
    const alerts = evaluateSafetyFloor({
      patient: patient({
        allergies: [allergy({ substanceCode: null, substanceText: 'amoxicillin' })],
      }),
      lines: [line()],
      knowledge: knowledge(),
    });
    expect(floorOf(alerts)).toContain(FLOOR_KEY.allergy);
  });

  it('matches a class-level allergy against a member of the class', () => {
    const alerts = evaluateSafetyFloor({
      patient: patient({ allergies: [allergy({ substanceCode: 'J01C', substanceText: 'Penicillins' })] }),
      lines: [line()],
      knowledge: knowledge(),
    });
    expect(floorOf(alerts)).toContain(FLOOR_KEY.allergy);
  });

  it('catches a cephalosporin through the penicillin cross-sensitivity map', () => {
    const alerts = evaluateSafetyFloor({
      patient: patient({ allergies: [allergy()] }),
      lines: [line({ drug: CEFTRIAXONE })],
      knowledge: knowledge(),
    });
    const stop = hardStops(alerts)[0];
    expect(stop?.floorKey).toBe(FLOOR_KEY.allergy);
    expect(stop?.evidence['match']).toBe('cross_class');
    expect(stop?.evidence['crossClass']).toBe('cephalosporin');
  });

  it('does not fire on an unrelated drug', () => {
    const alerts = evaluateSafetyFloor({
      patient: patient({ allergies: [allergy()] }),
      lines: [line({ drug: PARACETAMOL, doseBasis: 'flat', doseQty: 500 })],
      knowledge: knowledge(),
    });
    expect(hardStops(alerts)).toHaveLength(0);
  });

  it('treats a low-criticality intolerance as a soft stop, not the floor', () => {
    const alerts = evaluateSafetyFloor({
      patient: patient({
        allergies: [allergy({ criticality: 'low', severity: 'moderate', reactions: ['rash'] })],
      }),
      lines: [line()],
      knowledge: knowledge(),
    });
    expect(hardStops(alerts)).toHaveLength(0);
    expect(softStops(alerts)).toHaveLength(1);
  });

  it('still fires with an empty knowledge base — D-9', () => {
    // Every vendor-dependent input removed: no interaction pairs, no dose bands.
    // The allergy check reads the patient's own record and the shipped cross map,
    // so it cannot be taken away by a licence lapsing or a service being down.
    const alerts = evaluateSafetyFloor({
      patient: patient({ allergies: [allergy()] }),
      lines: [line()],
      knowledge: { crossMap: knowledge().crossMap, interactions: [], doseBands: [] },
    });
    expect(floorOf(alerts)).toContain(FLOOR_KEY.allergy);
  });
});

describe('the floor takes no configuration (exit gate 2)', () => {
  it('accepts exactly one argument, and it carries clinical facts only', () => {
    // The structural half of the guarantee: there is no options parameter to
    // pass, so there is no value that makes the floor return fewer alerts.
    expect(evaluateSafetyFloor.length).toBe(1);
  });

  it('fires the allergy hard stop under every combination of tuning', () => {
    const interruptions = ['passive', 'soft_stop', 'shadow', 'hard_stop'] as const;
    const families = [
      'allergy',
      'ddi',
      'dose_range',
      'pregnancy',
      'schedule_guardrail',
      'paediatric_weight',
    ] as const;

    for (const interruption of interruptions) {
      for (const family of families) {
        for (const emergency of [false, true]) {
          const hostile = {
            // Deliberately hostile: a tenant trying to configure the floor away
            // from every angle the type system will let it reach.
            familyInterruption: Object.fromEntries(families.map((f) => [f, interruption])),
            disabledFamilies: [...families],
            emergencyModeOpen: emergency,
            [family]: false,
          } as unknown as CdssTuning;

          const alerts = evaluate(
            {
              patient: patient({ allergies: [allergy()] }),
              lines: [line()],
              knowledge: knowledge(),
              vendor: { interactions: [] },
            },
            hostile,
          );
          const stop = hardStops(alerts).find((a) => a.floorKey === FLOOR_KEY.allergy);
          expect(
            stop,
            `tuning ${interruption}/${family}/${String(emergency)} suppressed the allergy floor`,
          ).toBeDefined();
          expect(stop?.interruption).toBe('hard_stop');
        }
      }
    }
  });

  it('refuses to let a floor alert reach the tuning stage at all', () => {
    const [stop] = evaluateSafetyFloor({
      patient: patient({ allergies: [allergy()] }),
      lines: [line()],
      knowledge: knowledge(),
    });
    expect(stop).toBeDefined();
    expect(() => applyTuning(stop as CdssAlert, NO_TUNING)).toThrow(/safety-floor alert/);
  });
});

describe('paediatric weight (exit gate 3)', () => {
  it('blocks a per-kg line when the encounter carries no weight', () => {
    const alerts = evaluateSafetyFloor({
      patient: patient({ ageYears: 4, weightKg: null }),
      lines: [line({ drug: PARACETAMOL, doseBasis: 'per_kg', doseQty: 15 })],
      knowledge: knowledge(),
    });
    expect(floorOf(alerts)).toContain(FLOOR_KEY.paediatricWeight);
  });

  it('blocks a weight-dosed drug for a child even when the line is written flat', () => {
    const alerts = evaluateSafetyFloor({
      patient: patient({ ageYears: 4, weightKg: null }),
      lines: [line({ drug: PARACETAMOL, doseBasis: 'flat', doseQty: 250 })],
      knowledge: knowledge(),
    });
    expect(floorOf(alerts)).toContain(FLOOR_KEY.paediatricWeight);
  });

  it('does not block once the weight is recorded', () => {
    const alerts = evaluateSafetyFloor({
      patient: patient({ ageYears: 4, weightKg: 16 }),
      lines: [line({ drug: PARACETAMOL, doseBasis: 'per_kg', doseQty: 15 })],
      knowledge: knowledge(),
    });
    expect(hardStops(alerts)).toHaveLength(0);
  });

  it('does not block an adult on a weight-dosed drug with no weight', () => {
    const alerts = evaluateSafetyFloor({
      patient: patient({ ageYears: 40, weightKg: null }),
      lines: [line({ drug: PARACETAMOL, doseBasis: 'flat', doseQty: 500 })],
      knowledge: knowledge(),
    });
    expect(hardStops(alerts)).toHaveLength(0);
  });
});

describe('dose ceiling (exit gate 3)', () => {
  it('catches a 10x paediatric overdose', () => {
    // 150 mg/kg/dose TDS = 450 mg/kg/day against a 75 mg/kg/day ceiling.
    const alerts = evaluateSafetyFloor({
      patient: patient({ ageYears: 4, weightKg: 16 }),
      lines: [line({ drug: PARACETAMOL, doseBasis: 'per_kg', doseQty: 150, timesPerDay: 3 })],
      knowledge: knowledge(),
    });
    const stop = hardStops(alerts).find((a) => a.floorKey === FLOOR_KEY.doseCeiling);
    expect(stop).toBeDefined();
    expect(stop?.evidence['observedDaily']).toBe(450);
    expect(stop?.evidence['absoluteCeiling']).toBe(75);
  });

  it('leaves a correct paediatric dose alone', () => {
    const alerts = evaluate(
      {
        patient: patient({ ageYears: 4, weightKg: 16 }),
        lines: [line({ drug: PARACETAMOL, doseBasis: 'per_kg', doseQty: 15, timesPerDay: 3 })],
        knowledge: knowledge(),
        vendor: { interactions: [] },
      },
      NO_TUNING,
    );
    expect(hardStops(alerts)).toHaveLength(0);
    expect(softStops(alerts)).toHaveLength(0);
  });

  it('soft-stops an over-band dose that is still under twice the ceiling', () => {
    // 25 mg/kg/dose BD = 50 mg/kg/day: over the 15 mg/kg per-dose band, under
    // the 60 mg/kg/day maximum and far under twice the 75 mg/kg/day ceiling.
    const alerts = evaluate(
      {
        patient: patient({ ageYears: 4, weightKg: 16 }),
        lines: [line({ drug: PARACETAMOL, doseBasis: 'per_kg', doseQty: 25, timesPerDay: 2 })],
        knowledge: knowledge(),
        vendor: { interactions: [] },
      },
      NO_TUNING,
    );
    expect(hardStops(alerts)).toHaveLength(0);
    expect(softStops(alerts).map((a) => a.family)).toContain('dose_range');
  });

  it('catches an adult 10x overdose too', () => {
    const alerts = evaluateSafetyFloor({
      patient: patient(),
      lines: [line({ drug: PARACETAMOL, doseQty: 5000, timesPerDay: 4 })],
      knowledge: knowledge(),
    });
    expect(floorOf(alerts)).toContain(FLOOR_KEY.doseCeiling);
  });
});

describe('interactions', () => {
  it('hard-stops a contraindicated pair inside one prescription', () => {
    const nitrate = drug({ genericName: 'Glyceryl trinitrate', atcCode: 'C01DA02', molecules: ['GTN'] });
    const sildenafil = drug({ genericName: 'Sildenafil', atcCode: 'G04BE03', molecules: ['Sildenafil'] });
    const alerts = evaluateSafetyFloor({
      patient: patient(),
      lines: [line({ lineNo: 1, drug: nitrate }), line({ lineNo: 2, drug: sildenafil })],
      knowledge: knowledge(),
    });
    expect(floorOf(alerts)).toContain(FLOOR_KEY.interaction);
  });

  it('hard-stops against a drug on the active medication list, not only within the Rx', () => {
    const sildenafil = drug({ genericName: 'Sildenafil', atcCode: 'G04BE03', molecules: ['Sildenafil'] });
    const alerts = evaluateSafetyFloor({
      patient: patient({
        activeMedications: [{ display: 'Glyceryl trinitrate', atcCode: 'C01DA02', source: 'rx' }],
      }),
      lines: [line({ drug: sildenafil })],
      knowledge: knowledge(),
    });
    expect(floorOf(alerts)).toContain(FLOOR_KEY.interaction);
  });

  it('soft-stops a major pair, and that one is tunable', () => {
    const warfarin = drug({ genericName: 'Warfarin', atcCode: 'B01AA03', molecules: ['Warfarin'] });
    const input = {
      patient: patient({
        activeMedications: [{ display: 'Co-trimoxazole', atcCode: 'J01EE01', source: 'rx' }],
      }),
      lines: [line({ drug: warfarin })],
      knowledge: knowledge(),
      vendor: { interactions: VENDOR_PAIRS },
    };

    expect(softStops(evaluate(input, NO_TUNING)).map((a) => a.family)).toContain('ddi');

    const tuned = evaluate(input, {
      familyInterruption: { ddi: 'passive' },
      disabledFamilies: [],
      emergencyModeOpen: false,
    });
    expect(softStops(tuned)).toHaveLength(0);
    expect(tuned.some((a) => a.family === 'ddi' && a.interruption === 'passive')).toBe(true);
  });

  it('renders a drug-disease condition as a soft stop when the condition holds', () => {
    const metformin = drug({ genericName: 'Metformin', atcCode: 'A10BA02', molecules: ['Metformin'] });
    const withCkd = evaluate(
      {
        patient: patient({ egfr: 22 }),
        lines: [line({ drug: metformin })],
        knowledge: knowledge(),
        vendor: { interactions: VENDOR_PAIRS },
      },
      NO_TUNING,
    );
    expect(softStops(withCkd).map((a) => a.family)).toContain('drug_disease');

    const withNormalRenal = evaluate(
      {
        patient: patient({ egfr: 90 }),
        lines: [line({ drug: metformin })],
        knowledge: knowledge(),
        vendor: { interactions: VENDOR_PAIRS },
      },
      NO_TUNING,
    );
    expect(softStops(withNormalRenal).map((a) => a.family)).not.toContain('drug_disease');
  });
});

describe('pregnancy', () => {
  it('hard-stops a category X drug in a confirmed pregnancy', () => {
    const alerts = evaluateSafetyFloor({
      patient: patient({ pregnancyConfirmed: true }),
      lines: [line({ drug: drug({ pregnancyCategory: 'x' }) })],
      knowledge: knowledge(),
    });
    expect(floorOf(alerts)).toContain(FLOOR_KEY.pregnancyX);
  });

  it('does not fire when the pregnancy is not confirmed', () => {
    const alerts = evaluateSafetyFloor({
      patient: patient({ pregnancyConfirmed: false }),
      lines: [line({ drug: drug({ pregnancyCategory: 'x' }) })],
      knowledge: knowledge(),
    });
    expect(hardStops(alerts)).toHaveLength(0);
  });
});

describe('controlled drugs', () => {
  it('blocks an NDPS drug whose statutory cap is not configured', () => {
    const alerts = evaluateSafetyFloor({
      patient: patient(),
      lines: [line({ drug: MORPHINE, doseQty: 5, durationDays: 3 })],
      knowledge: knowledge(),
    });
    const stop = hardStops(alerts).find((a) => a.evidence['reason'] === 'cap_not_configured');
    expect(stop?.floorKey).toBe(FLOOR_KEY.ndpsCap);
  });

  it('blocks a controlled drug when the prescriber has no registration number', () => {
    const alerts = evaluateSafetyFloor({
      patient: patient({ prescriberRegistrationNo: null }),
      lines: [line({ drug: MORPHINE })],
      knowledge: knowledge(),
    });
    expect(hardStops(alerts).some((a) => a.evidence['reason'] === 'missing_registration')).toBe(true);
  });

  it('blocks a course longer than the configured statutory cap', () => {
    const bands = [
      {
        drugKey: 'N02AA01',
        drugKeyKind: 'atc',
        route: null,
        population: 'adult' as const,
        basis: 'flat' as const,
        minDose: null,
        maxDose: null,
        unit: 'mg/dose',
        maxDaily: null,
        absoluteCeiling: null,
        maxCourseDays: 7,
      },
    ];
    const over = evaluateSafetyFloor({
      patient: patient(),
      lines: [line({ drug: MORPHINE, durationDays: 30 })],
      knowledge: knowledge({ doseBands: bands }),
    });
    expect(over.some((a) => a.evidence['capDays'] === 7)).toBe(true);

    const within = evaluateSafetyFloor({
      patient: patient(),
      lines: [line({ drug: MORPHINE, durationDays: 5 })],
      knowledge: knowledge({ doseBands: bands }),
    });
    expect(hardStops(within)).toHaveLength(0);
  });
});

describe('tunable families', () => {
  it('flags duplicate therapy within a prescription', () => {
    const alerts = evaluate(
      {
        patient: patient(),
        lines: [line({ lineNo: 1 }), line({ lineNo: 2 })],
        knowledge: knowledge(),
        vendor: { interactions: [] },
      },
      NO_TUNING,
    );
    expect(softStops(alerts).map((a) => a.family)).toContain('duplicate_therapy');
  });

  it('renders soft stops passive inside an emergency window, and never the floor', () => {
    const emergency: CdssTuning = {
      familyInterruption: {},
      disabledFamilies: [],
      emergencyModeOpen: true,
    };
    const alerts = evaluate(
      {
        patient: patient({ allergies: [allergy()] }),
        lines: [line({ lineNo: 1 }), line({ lineNo: 2 })],
        knowledge: knowledge(),
        vendor: { interactions: [] },
      },
      emergency,
    );
    expect(softStops(alerts).filter((a) => a.family === 'duplicate_therapy')).toHaveLength(0);
    expect(hardStops(alerts).map((a) => a.floorKey)).toContain(FLOOR_KEY.allergy);
  });

  it('notes a patient whose allergy status was never asked', () => {
    const alerts = evaluate(
      {
        patient: patient({ allergyStatement: 'not_recorded' }),
        lines: [line()],
        knowledge: knowledge(),
        vendor: { interactions: [] },
      },
      NO_TUNING,
    );
    expect(alerts.some((a) => a.subjectCode === 'allergy_statement')).toBe(true);
  });
});

describe('population bands', () => {
  it('walks from the most specific band outwards', () => {
    expect(populationChain(0.01)).toEqual(['neonate', 'infant', 'child']);
    expect(populationChain(6)).toEqual(['child']);
    expect(populationChain(15)).toEqual(['adolescent', 'child']);
    expect(populationChain(40)).toEqual(['adult']);
    expect(populationChain(80)).toEqual(['geriatric', 'adult']);
  });
});
