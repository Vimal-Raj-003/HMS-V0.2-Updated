import { describe, expect, it } from 'vitest';
import { evaluateWestgard, type WestgardRuleConfig } from './westgard.js';

/**
 * EN-031 §3.2 — the rules that decide whether a run blocks release.
 *
 * The cases below are the ones that would each be a real defect:
 *  * 1-3s must fire and must reject when configured to (exit gate 4);
 *  * 1-2s must fire and must **not** reject, because treating it as a rejection
 *    fails one run in twenty by chance;
 *  * a within-run rule (R-4s) must see the other control levels, because
 *    evaluating it against one level's own history is how it never fires;
 *  * a shift rule must need the full run of points and not almost.
 */

const rule = (ruleCode: string, action: 'warning' | 'reject'): WestgardRuleConfig => ({
  ruleCode,
  action,
  enabled: true,
});

const RULES = [
  rule('r_1_2s', 'warning'),
  rule('r_1_3s', 'reject'),
  rule('r_2_2s', 'reject'),
  rule('r_R_4s', 'reject'),
  rule('r_4_1s', 'reject'),
  rule('r_10x', 'reject'),
];

describe('Westgard evaluation', () => {
  it('lets an in-control point through with nothing fired', () => {
    const outcome = evaluateWestgard({ rules: RULES, series: [0.4, -0.2, 0.9], peers: [0.1] });
    expect(outcome).toEqual({ violated: [], rejected: false, warned: false });
  });

  it('rejects a 1-3s violation — exit gate 4', () => {
    const outcome = evaluateWestgard({ rules: RULES, series: [-3.5, 0.2, 0.1], peers: [0.3] });
    expect(outcome.violated).toContain('r_1_3s');
    expect(outcome.rejected).toBe(true);
  });

  it('warns on 1-2s and does not reject, because 1-2s is never a rejection rule', () => {
    const outcome = evaluateWestgard({ rules: RULES, series: [2.4, 0.1, -0.3], peers: [0.2] });
    expect(outcome.violated).toEqual(['r_1_2s']);
    expect(outcome.rejected).toBe(false);
    expect(outcome.warned).toBe(true);
  });

  it('honours the laboratory’s configuration: an unconfigured rule cannot fire', () => {
    const outcome = evaluateWestgard({ rules: [rule('r_1_2s', 'warning')], series: [-3.5], peers: [] });
    expect(outcome.violated).toEqual(['r_1_2s']);
    expect(outcome.rejected).toBe(false);
  });

  it('ignores a disabled rule', () => {
    const outcome = evaluateWestgard({
      rules: [{ ruleCode: 'r_1_3s', action: 'reject', enabled: false }],
      series: [-3.5],
      peers: [],
    });
    expect(outcome.violated).toEqual([]);
    expect(outcome.rejected).toBe(false);
  });

  it('fires 2-2s across two consecutive runs of one level', () => {
    const outcome = evaluateWestgard({ rules: RULES, series: [2.3, 2.1, 0.4], peers: [] });
    expect(outcome.violated).toContain('r_2_2s');
  });

  it('fires 2-2s across two levels of one run', () => {
    const outcome = evaluateWestgard({ rules: RULES, series: [2.2, 0.1, 0.2], peers: [2.4] });
    expect(outcome.violated).toContain('r_2_2s');
  });

  it('fires R-4s only when the other control levels are in view', () => {
    const withPeer = evaluateWestgard({ rules: RULES, series: [2.1, 0.1], peers: [-2.2] });
    expect(withPeer.violated).toContain('r_R_4s');

    const withoutPeer = evaluateWestgard({ rules: RULES, series: [2.1, -2.2], peers: [] });
    expect(withoutPeer.violated).not.toContain('r_R_4s');
  });

  it('needs all four points for 4-1s, on the same side', () => {
    expect(
      evaluateWestgard({ rules: RULES, series: [1.2, 1.4, 1.1, 1.6, 0.2], peers: [] }).violated,
    ).toContain('r_4_1s');
    expect(
      evaluateWestgard({ rules: RULES, series: [1.2, 1.4, 1.1, -1.6, 0.2], peers: [] }).violated,
    ).not.toContain('r_4_1s');
    expect(evaluateWestgard({ rules: RULES, series: [1.2, 1.4, 1.1], peers: [] }).violated).not.toContain(
      'r_4_1s',
    );
  });

  it('needs ten points on one side of the mean for 10x, of any magnitude', () => {
    const ten = Array.from({ length: 10 }, () => 0.3);
    expect(evaluateWestgard({ rules: RULES, series: ten, peers: [] }).violated).toContain('r_10x');
    expect(
      evaluateWestgard({ rules: RULES, series: [...ten.slice(0, 9), -0.1], peers: [] }).violated,
    ).not.toContain('r_10x');
  });

  it('fires 7T on a monotonic drift and not on a flat run', () => {
    const rules = [rule('r_7T', 'warning')];
    // Newest first, so a rising trend reads as descending here.
    const drift = [3.1, 2.6, 2.0, 1.5, 1.0, 0.5, 0.1];
    expect(evaluateWestgard({ rules, series: drift, peers: [] }).violated).toEqual(['r_7T']);
    const flat = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
    expect(evaluateWestgard({ rules, series: flat, peers: [] }).violated).toEqual([]);
  });

  it('does not fire an unrecognised rule code rather than guessing at it', () => {
    const outcome = evaluateWestgard({
      rules: [rule('r_future_rule', 'reject')],
      series: [-9],
      peers: [],
    });
    expect(outcome.violated).toEqual([]);
  });

  it('has nothing to say about an empty series', () => {
    expect(evaluateWestgard({ rules: RULES, series: [], peers: [1.2] })).toEqual({
      violated: [],
      rejected: false,
      warned: false,
    });
  });
});
