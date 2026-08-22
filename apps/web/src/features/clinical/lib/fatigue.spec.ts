import { describe, expect, it } from 'vitest';
import type { AlertFatigueReport } from '../api/types';
import { familyRows, fatigueVerdict, MIN_FIRES_FOR_RATE, overrideRate, reasonRows } from './fatigue';

function report(overrides: Partial<AlertFatigueReport> = {}): AlertFatigueReport {
  return {
    windowDays: 7,
    fires: 100,
    displays: 90,
    blocks: 4,
    overrides: 30,
    acknowledgements: 56,
    overrideRatePct: 30,
    alertsPer1000Orders: 220,
    ordersEvaluated: 455,
    overridesByReason: { PRIOR_TOLERANCE: 18, OTHER: 12 },
    byFamily: [
      { family: 'dose_range', fires: 20, overrides: 2, blocks: 0 },
      { family: 'ddi', fires: 75, overrides: 27, blocks: 0 },
      { family: 'allergy', fires: 5, overrides: 1, blocks: 4 },
    ],
    ...overrides,
  };
}

describe('the override rate', () => {
  it('is a percentage to one decimal place', () => {
    expect(overrideRate(75, 27)).toBe(36);
    expect(overrideRate(30, 1)).toBe(3.3);
  });

  /**
   * A rate over three fires is not evidence, and presenting it as one invites
   * somebody to disable a rule that has barely run. Below the floor the screen
   * shows counts and says so.
   */
  it('refuses to state a rate over too few fires', () => {
    expect(overrideRate(MIN_FIRES_FOR_RATE - 1, 3)).toBeNull();
    expect(overrideRate(0, 0)).toBeNull();
  });
});

describe('the family table', () => {
  it('puts the loudest family first, because that is where fatigue comes from', () => {
    expect(familyRows(report()).map((row) => row.family)).toStrictEqual(['ddi', 'dose_range', 'allergy']);
  });

  it('shows each family’s share of every alert shown', () => {
    expect(familyRows(report())[0]?.shareOfFiresPct).toBe(75);
  });

  it('leaves the rate unstated for a family that has barely fired', () => {
    const allergy = familyRows(report()).find((row) => row.family === 'allergy');
    expect(allergy?.fires).toBe(5);
    expect(allergy?.overrideRatePct).toBeNull();
    expect(allergy?.blocks).toBe(4);
  });

  it('does not divide by zero on an empty window', () => {
    expect(familyRows(report({ fires: 0, byFamily: [] }))).toStrictEqual([]);
  });
});

describe('the reason breakdown', () => {
  it('is ordered by how often each reason was given', () => {
    expect(reasonRows(report()).map((row) => row.code)).toStrictEqual(['PRIOR_TOLERANCE', 'OTHER']);
    expect(reasonRows(report())[0]?.sharePct).toBe(60);
  });

  it('is empty rather than zeroed when nothing was overridden', () => {
    expect(reasonRows(report({ overridesByReason: {} }))).toStrictEqual([]);
  });
});

describe('the plain-words verdict', () => {
  it('calls out a rule set clinicians override by default', () => {
    expect(fatigueVerdict(report({ overrideRatePct: 68 })).tone).toBe('danger');
  });

  it('warns at a quarter', () => {
    expect(fatigueVerdict(report({ overrideRatePct: 30 })).tone).toBe('warning');
  });

  it('is content when most alerts are acted on', () => {
    expect(fatigueVerdict(report({ overrideRatePct: 8 })).tone).toBe('success');
  });

  it('says plainly when nothing fired', () => {
    expect(fatigueVerdict(report({ fires: 0 })).summary).toContain('No alert fired');
  });
});
