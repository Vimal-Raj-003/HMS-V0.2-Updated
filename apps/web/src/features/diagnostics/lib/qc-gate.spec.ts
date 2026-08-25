import { describe, expect, it } from 'vitest';
import type { LabQcStateView } from '../api/types';
import { WARNING_ONLY_RULES, blocksRelease, describeRule, releaseVerdict } from './qc-gate';

/**
 * EN-031 §5 bullet 1 and §13 — the release gate.
 *
 * Two failure modes are asserted here because both look reasonable in review and
 * both release patient results that should have been held:
 *
 *  1. `state?.permits_release ?? true` — the natural TypeScript shortcut, which
 *     turns "the QC status could not be read" into "release is fine";
 *  2. treating `1-2s` as a rejection, which stops a laboratory constantly and
 *     teaches everybody to click past the stop.
 */

function state(overrides: Partial<LabQcStateView> = {}): LabQcStateView {
  return {
    id: 'qc-1',
    instrument_id: 'inst-1',
    test_key: 'test-1',
    parameter_key: null,
    state: 'in_control',
    permits_release: true,
    last_evaluated_at: '2026-08-23T06:00:00.000Z',
    next_due_at: '2026-08-23T14:00:00.000Z',
    reason: null,
    active_lockout_id: null,
    ...overrides,
  };
}

describe('the QC release gate', () => {
  it('permits release when the control is in range', () => {
    expect(releaseVerdict(state(), false)).toEqual({ kind: 'permitted' });
  });

  it('holds release when the database says the analyte does not permit it', () => {
    const verdict = releaseVerdict(
      state({
        permits_release: false,
        state: 'out_of_control',
        reason: '1-3s on level 2',
        active_lockout_id: 'lock-9',
      }),
      false,
    );
    expect(verdict.kind).toBe('blocked');
    if (verdict.kind !== 'blocked') throw new Error('expected a block');
    // EN-031 AC 2: the block names the reason and the QC reference.
    expect(verdict.message).toContain('1-3s on level 2');
    expect(verdict.qcStateRef).toBe('lock-9');
    expect(verdict.overridable).toBe(true);
  });

  /** EN-031 §13 / AC 17 — the whole point of the module. */
  it('fails closed when the QC status cannot be read at all', () => {
    const verdict = releaseVerdict(state(), true);
    expect(verdict.kind).toBe('blocked');
    if (verdict.kind !== 'blocked') throw new Error('expected a block');
    expect(verdict.message).toMatch(/fail closed/iu);
    // There is no Director override for "we do not know": the lawful exception
    // is for a *known* out-of-control state, not for an unread one.
    expect(verdict.overridable).toBe(false);
  });

  it('fails closed for an analyte that has never been evaluated', () => {
    expect(releaseVerdict(null, false).kind).toBe('blocked');
    expect(releaseVerdict(undefined, false).kind).toBe('blocked');
  });

  it('does not let an unreadable state be rescued by a permitting row', () => {
    // A caller that passes both a good row and `stateUnavailable` is describing
    // stale data. Unavailable wins.
    expect(releaseVerdict(state({ permits_release: true }), true).kind).toBe('blocked');
  });
});

describe('Westgard rules', () => {
  it('treats 1-2s as a warning and never as a rejection', () => {
    expect(WARNING_ONLY_RULES).toEqual(['r_1_2s']);
    expect(blocksRelease({ has_rejection: true, violated_rules: ['r_1_2s'] })).toBe(false);
  });

  it('treats 1-3s as a rejection', () => {
    expect(blocksRelease({ has_rejection: true, violated_rules: ['r_1_3s'] })).toBe(true);
  });

  it('treats a mixed violation containing a real stopper as a rejection', () => {
    expect(blocksRelease({ has_rejection: true, violated_rules: ['r_1_2s', 'r_2_2s'] })).toBe(true);
  });

  it('defers to the database when it says there was no rejection', () => {
    expect(blocksRelease({ has_rejection: false, violated_rules: ['r_1_3s'] })).toBe(false);
  });

  it('spells every rule out, and says so for one it does not know', () => {
    expect(describeRule('r_1_3s')).toMatch(/reject the run/iu);
    expect(describeRule('r_made_up')).toMatch(/QC SOP/iu);
  });
});
