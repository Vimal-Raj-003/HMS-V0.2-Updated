import { describe, expect, it } from 'vitest';
import type { AlertView, EvaluationView, OverrideInput } from '../api/types';
import {
  classify,
  degradedNotice,
  familyLabel,
  isBlocking,
  mayRenderSubmit,
  submissionGate,
  unansweredFamilies,
} from './cdss';

/**
 * The interruption ladder.
 *
 * These are the tests that fail if the hard stop is ever softened. In
 * particular, `mayRenderSubmit` returning `true` for a blocked gate would let a
 * screen draw a submit control over an unresolved hard stop, and that is the one
 * defect this whole feature is built to prevent.
 */

function alert(overrides: Partial<AlertView> = {}): AlertView {
  return {
    alertEventId: 'alert-1',
    firedAt: '2026-08-22T09:00:00.000Z',
    lineNo: 1,
    family: 'allergy',
    severity: 'contraindicated',
    interruption: 'hard_stop',
    safetyFloorKey: 'allergy_documented_anaphylaxis',
    title: 'Documented anaphylaxis to this ingredient',
    detail: 'The patient has a recorded anaphylactic reaction to penicillin.',
    suggestedAction: 'Choose a drug from another class.',
    subjectCode: 'PEN',
    overrideReasonCode: null,
    cleared: false,
    ...overrides,
  };
}

function evaluation(overrides: Partial<EvaluationView> = {}): EvaluationView {
  return {
    alerts: [],
    blocking: [],
    needsCodedReason: [],
    degraded: false,
    degradedFamilies: [],
    snapshotDigest: 'digest',
    latencyMs: 12,
    ruleLatencyMs: 8,
    ...overrides,
  };
}

describe('classifying alerts', () => {
  it('never shows a shadow-mode alert to a clinician', () => {
    const classified = classify([alert({ interruption: 'shadow' })]);
    expect(classified.hardStops).toHaveLength(0);
    expect(classified.softStops).toHaveLength(0);
    expect(classified.passive).toHaveLength(0);
  });

  it('treats a countersigned hard stop as history rather than as a block', () => {
    const classified = classify([alert({ cleared: true })]);
    expect(classified.hardStops).toHaveLength(0);
    expect(classified.passive).toHaveLength(1);
    expect(isBlocking(alert({ cleared: true }))).toBe(false);
  });

  it('keeps an uncleared hard stop blocking', () => {
    expect(classify([alert()]).hardStops).toHaveLength(1);
    expect(isBlocking(alert())).toBe(true);
  });

  it('separates soft stops from passive notices', () => {
    const classified = classify([
      alert({ alertEventId: 'a', interruption: 'soft_stop', family: 'ddi' }),
      alert({ alertEventId: 'b', interruption: 'passive', family: 'geriatric' }),
    ]);
    expect(classified.softStops.map((entry) => entry.family)).toStrictEqual(['ddi']);
    expect(classified.passive.map((entry) => entry.family)).toStrictEqual(['geriatric']);
  });
});

describe('the submission gate', () => {
  it('blocks while any hard stop is uncleared', () => {
    const gate = submissionGate(evaluation({ blocking: [alert()] }), []);
    expect(gate.kind).toBe('blocked');
  });

  /**
   * The load-bearing assertion of the feature. A screen asks `mayRenderSubmit`
   * before drawing anything that submits; if this ever returns `true` for a
   * blocked gate, a "prescribe anyway" affordance becomes possible.
   */
  it('permits no submit control at all while blocked', () => {
    const gate = submissionGate(evaluation({ blocking: [alert()] }), []);
    expect(mayRenderSubmit(gate)).toBe(false);
  });

  it('stays blocked no matter how many coded reasons are supplied', () => {
    const overrides: readonly OverrideInput[] = [
      { family: 'allergy', reasonCode: 'BENEFIT_OUTWEIGHS' },
      { family: 'ddi', reasonCode: 'PRIOR_TOLERANCE' },
    ];
    const gate = submissionGate(evaluation({ blocking: [alert()] }), overrides);
    expect(gate.kind).toBe('blocked');
    expect(mayRenderSubmit(gate)).toBe(false);
  });

  it('asks for a coded reason on a soft stop, by family', () => {
    const soft = alert({ interruption: 'soft_stop', family: 'ddi' });
    const gate = submissionGate(evaluation({ needsCodedReason: [soft] }), []);
    expect(gate).toStrictEqual({ kind: 'needs-coded-reason', families: ['ddi'] });
    expect(mayRenderSubmit(gate)).toBe(true);
  });

  it('clears once every family carries a code', () => {
    const soft = alert({ interruption: 'soft_stop', family: 'ddi' });
    const gate = submissionGate(evaluation({ needsCodedReason: [soft] }), [
      { family: 'ddi', reasonCode: 'MONITORING_PLANNED' },
    ]);
    expect(gate.kind).toBe('clear');
  });

  it('does not accept an empty code as an answer', () => {
    const soft = alert({ interruption: 'soft_stop', family: 'ddi' });
    const gate = submissionGate(evaluation({ needsCodedReason: [soft] }), [
      { family: 'ddi', reasonCode: '   ' },
    ]);
    expect(gate.kind).toBe('needs-coded-reason');
  });

  it('is clear before anything has been evaluated', () => {
    expect(submissionGate(null, []).kind).toBe('clear');
  });
});

describe('unanswered families', () => {
  it('lists each family once however many alerts it raised', () => {
    const alerts = [
      alert({ alertEventId: 'a', family: 'ddi', interruption: 'soft_stop' }),
      alert({ alertEventId: 'b', family: 'ddi', interruption: 'soft_stop' }),
      alert({ alertEventId: 'c', family: 'dose_range', interruption: 'soft_stop' }),
    ];
    expect(unansweredFamilies(alerts, [])).toStrictEqual(['ddi', 'dose_range']);
  });
});

describe('degradation', () => {
  it('says so, and names what did not run', () => {
    const notice = degradedNotice(evaluation({ degraded: true, degradedFamilies: ['ddi'] }));
    expect(notice).toContain('ddi');
  });

  it('says nothing when nothing degraded', () => {
    expect(degradedNotice(evaluation())).toBeNull();
    expect(degradedNotice(null)).toBeNull();
  });
});

describe('family labels', () => {
  it('never shows a raw enum to a clinician', () => {
    expect(familyLabel('dose_range')).toBe('Dose range');
    expect(familyLabel('paediatric_weight')).toBe('Paediatric weight');
  });

  it('falls back to the code rather than to an empty chip', () => {
    expect(familyLabel('something_new')).toBe('something_new');
  });
});
