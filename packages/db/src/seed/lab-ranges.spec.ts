import { describe, expect, it } from 'vitest';
import { LAB_CODED_RANGES, LAB_RANGES, WESTGARD_RULES } from './diagnostics.js';

/**
 * The seeded laboratory reference intervals, checked against ordinary clinical
 * values.
 *
 * This file exists because of `src/seed/vitals-ranges.spec.ts`, and it exists
 * *before* the same defect can happen rather than after. `OP-007 §5.1`
 * tabulates the **amber** and **red** bands for vital signs; those numbers were
 * copied straight into the columns that bound the **normal** band, and six
 * parameters inverted — a temperature of 37.0 °C read amber while 38.5 °C read
 * normal, and `spo2` carried no critical bound at all, so "SpO2 < 92 % critical"
 * could not fire for any patient at any saturation.
 *
 * A schema CHECK cannot catch that class of error: every one of those rows
 * satisfied `low_critical <= low_abnormal <= high_abnormal <= high_critical`,
 * and every row in `LAB_RANGES` satisfies the equivalent
 * `lab_result_versions_ref_order`. Only a test that knows what a healthy adult's
 * potassium looks like can.
 *
 * The stakes are higher here than for vitals. A potassium of 7.1 that is flagged
 * `high` rather than `critical_high` does not merely show the wrong colour: the
 * whole of the migration's §C.6 — the alert the database raises for itself, the
 * escalation ladder, the read-back requirement on authorisation — is keyed off
 * `is_critical`, and none of it runs. The alert nobody sees is the one that was
 * never raised.
 */

type Band = 'normal' | 'abnormal' | 'critical';

interface Bounds {
  readonly low: number | null;
  readonly high: number | null;
  readonly criticalLow: number | null;
  readonly criticalHigh: number | null;
}

const ADULT_MIN_DAYS = 6570;

function bounds(test: string, sex = 'any'): Bounds {
  const row = LAB_RANGES.find((r) => r[0] === test && r[1] === ADULT_MIN_DAYS && r[3] === sex);
  if (row === undefined) throw new Error(`no adult range seeded for "${test}" (sex=${sex})`);
  return { low: row[4], high: row[5], criticalLow: row[6], criticalHigh: row[7] };
}

/**
 * The same reading the service applies, and the same one the schema's ordering
 * CHECK assumes: outside the panic bounds is critical, outside the normal
 * interval is abnormal, otherwise normal.
 */
function classify(value: number, b: Bounds): Band {
  if (b.criticalLow !== null && value < b.criticalLow) return 'critical';
  if (b.criticalHigh !== null && value > b.criticalHigh) return 'critical';
  if (b.low !== null && value < b.low) return 'abnormal';
  if (b.high !== null && value > b.high) return 'abnormal';
  return 'normal';
}

describe('seeded adult laboratory reference intervals', () => {
  /** A healthy adult must read green on every analyte that has an interval. */
  const HEALTHY: ReadonlyArray<readonly [string, number, string]> = [
    ['K', 4.2, 'any'],
    ['NA', 140, 'any'],
    ['CREA', 0.9, 'male'],
    ['CREA', 0.8, 'female'],
    ['GLUF', 88, 'any'],
    ['HB', 15.0, 'male'],
    ['HB', 13.4, 'female'],
    ['PLT', 250, 'any'],
    ['INR', 1.0, 'any'],
    ['TSH', 2.1, 'any'],
  ];

  it.each(HEALTHY)('reads an ordinary %s of %s (%s) as normal', (test, value, sex) => {
    expect(classify(value, bounds(test, sex))).toBe('normal');
  });

  /**
   * Each of these is a value a clinician would telephone about. If any reads
   * merely `abnormal`, the critical-value loop never fires for it: no alert row
   * is raised by the database, no escalation ladder starts, and authorisation
   * proceeds without a read-back — which is exactly the safety property
   * `docs/DECISIONS.md D-10` and the Phase-3 exit gate 2 are about.
   */
  const CRITICAL: ReadonlyArray<readonly [string, number, string]> = [
    ['K', 7.1, 'any'], // the exit-gate potassium
    ['K', 2.1, 'any'],
    ['NA', 112, 'any'],
    ['NA', 168, 'any'],
    ['CREA', 6.4, 'male'],
    ['GLUF', 38, 'any'],
    ['GLUF', 520, 'any'],
    ['HB', 5.8, 'male'],
    ['HB', 6.2, 'female'],
    ['PLT', 11, 'any'],
    ['PLT', 1400, 'any'],
    ['INR', 7.2, 'any'],
  ];

  it.each(CRITICAL)('reads a panic %s of %s (%s) as critical', (test, value, sex) => {
    expect(classify(value, bounds(test, sex))).toBe('critical');
  });

  /** Values that are abnormal but not panic must be amber — neither green nor red. */
  const ABNORMAL: ReadonlyArray<readonly [string, number, string]> = [
    ['K', 5.6, 'any'],
    ['K', 3.1, 'any'],
    ['NA', 132, 'any'],
    ['CREA', 2.4, 'male'],
    ['GLUF', 118, 'any'],
    ['HB', 10.5, 'male'],
    ['PLT', 96, 'any'],
    ['INR', 2.6, 'any'],
    ['TSH', 8.4, 'any'],
  ];

  it.each(ABNORMAL)('reads an abnormal %s of %s (%s) as abnormal', (test, value, sex) => {
    expect(classify(value, bounds(test, sex))).toBe('abnormal');
  });

  /**
   * Every analyte on the published critical-value list must actually carry a
   * panic bound. This is the assertion that failed on `spo2` in Phase 2, where
   * both critical bounds were null and no saturation could ever be red.
   */
  it.each([
    ['K', 'any'],
    ['NA', 'any'],
    ['CREA', 'male'],
    ['CREA', 'female'],
    ['GLUF', 'any'],
    ['HB', 'male'],
    ['HB', 'female'],
    ['PLT', 'any'],
    ['INR', 'any'],
  ] as const)('gives %s (%s) at least one panic bound', (test, sex) => {
    const b = bounds(test, sex);
    expect(
      b.criticalLow !== null || b.criticalHigh !== null,
      `${test} can never raise a critical-value alert`,
    ).toBe(true);
  });

  /**
   * The ordering the schema's `lab_result_versions_ref_order` CHECK enforces,
   * asserted here too so a bad row fails before it reaches a database — and,
   * more usefully, so the failure names the analyte.
   */
  it.each(LAB_RANGES.map((r) => [r[0], r[3], r] as const))(
    'orders the bands of %s (%s)',
    (_test, _sex, row) => {
      const [, , , , low, high, criticalLow, criticalHigh] = row;
      if (low !== null && high !== null) expect(low).toBeLessThan(high);
      if (criticalLow !== null && low !== null) expect(criticalLow).toBeLessThanOrEqual(low);
      if (criticalHigh !== null && high !== null) expect(criticalHigh).toBeGreaterThanOrEqual(high);
    },
  );

  /** An age band must be a band, and the adult band must start at adulthood. */
  it.each(LAB_RANGES.map((r) => [r[0], r[1], r[2]] as const))(
    'gives %s a well-formed age band (%s–%s days)',
    (_test, ageMin, ageMax) => {
      expect(ageMax).toBeGreaterThan(ageMin);
      expect(ageMin).toBeGreaterThanOrEqual(0);
    },
  );

  /**
   * A coded analyte's critical values must not be its normal answer. Seeding
   * "Non-reactive" as the critical coded value for an HIV screen would fire the
   * counselling workflow on every negative result and silence it on every
   * positive one — the coded twin of the vitals inversion.
   */
  it.each(LAB_CODED_RANGES.map((r) => [r[0], r] as const))(
    'does not mark %s normal answer as critical',
    (_test, row) => {
      const [, textNormal, criticalCoded] = row;
      expect(criticalCoded.length).toBeGreaterThan(0);
      expect(criticalCoded).not.toContain(textNormal);
    },
  );
});

describe('seeded Westgard rule set', () => {
  /**
   * `EN-031 §5`: "**`1-2s` is a warning, never a rejection** (using it as a
   * rejection rule is a classic false-rejection error)". The schema refuses the
   * other configuration outright — `labq_westgard_config_1_2s_is_warning` — but
   * a seed that tried to write it would fail at apply time with a constraint
   * name rather than an explanation, so it is asserted here as well.
   */
  it('never configures 1-2s as a rejection rule', () => {
    const rule = WESTGARD_RULES.find((r) => r[0] === 'r_1_2s');
    expect(rule, '1-2s must be configured, as a warning').toBeDefined();
    expect(rule?.[3]).toBe('warning');
  });

  /**
   * And the rules that must reject actually do. A rule set in which everything
   * is a warning passes the constraint above and controls nothing — the
   * mirror-image defect, and the one a "make the tests pass" edit would produce.
   */
  it.each(['r_1_3s', 'r_2_2s', 'r_R_4s'] as const)('configures %s as a rejection rule', (code) => {
    const rule = WESTGARD_RULES.find((r) => r[0] === code);
    expect(rule, `${code} must be configured`).toBeDefined();
    expect(rule?.[3]).toBe('reject');
  });

  it('has at least one rejection rule, or QC controls nothing', () => {
    expect(WESTGARD_RULES.filter((r) => r[3] === 'reject').length).toBeGreaterThan(0);
  });
});
