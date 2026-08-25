import { describe, expect, it } from 'vitest';
import type { LabCriticalAlertView, LabCriticalCallbackView } from '../api/types';
import {
  EMPTY_CALLBACK_FORM,
  WITHHOLDING_IS_NEVER_AN_OPTION,
  authorisationVerdict,
  callbackProblems,
  canRecordCallback,
  hasDocumentedCommunication,
  minutesToDue,
  toLabCallbackRequest,
  toRadCallbackRequest,
  urgencyOf,
  type CallbackFormState,
} from './critical';

/**
 * OP-004 §5 "Critical value (resolved — not configurable)" and D-10.
 *
 * The rule everybody inverts is asserted first, because inverting it is the
 * failure this whole phase exists to prevent: the paperwork gates
 * **authorisation**, never **display**.
 */

function callback(overrides: Partial<LabCriticalCallbackView> = {}): LabCriticalCallbackView {
  return {
    id: 'cb-1',
    sequence: 1,
    notified_by_name: 'Tech',
    notified_at: '2026-08-23T06:10:00.000Z',
    method: 'phone',
    notified_to_name: null,
    notified_to_role: null,
    read_back_confirmed: false,
    read_back_value: null,
    clinician_unreachable: false,
    escalated_to_level: null,
    escalated_to_role: null,
    latency_seconds: 600,
    ...overrides,
  };
}

function alert(overrides: Partial<LabCriticalAlertView> = {}): LabCriticalAlertView {
  return {
    id: 'alert-1',
    result_id: 'res-1',
    result_version: 1,
    order_id: 'ord-1',
    order_test_id: 'ot-1',
    patient_id: '0192f0e2-0000-7000-8000-0000000000aa',
    analyte_name: 'Potassium',
    flag: 'critical_high',
    value_display: '6.8',
    unit: 'mmol/L',
    detected_at: '2026-08-23T06:00:00.000Z',
    due_by: '2026-08-23T06:30:00.000Z',
    status: 'open',
    escalation_level: 0,
    first_communicated_at: null,
    acknowledged_at: null,
    callbacks: [],
    ...overrides,
  };
}

describe('the never-withhold rule', () => {
  it('states that withholding is not an option, as a constant a change would have to delete', () => {
    expect(WITHHOLDING_IS_NEVER_AN_OPTION).toBe(true);
  });

  it('exposes no function that could hide, delay or suppress an alert', () => {
    // `authorisationVerdict` is the only gate in this module and it gates the
    // *authorise* action. If a `shouldDisplay`/`suppressUntil`/`withhold` ever
    // appears here, this fails and somebody has to justify it in review.
    const exported = Object.keys({
      authorisationVerdict,
      callbackProblems,
      canRecordCallback,
      hasDocumentedCommunication,
      minutesToDue,
      toLabCallbackRequest,
      toRadCallbackRequest,
      urgencyOf,
    });
    expect(exported.some((name) => /withhold|suppress|hide|delay/iu.test(name))).toBe(false);
  });
});

describe('what counts as a documented communication (D-10)', () => {
  it('counts a confirmed read-back', () => {
    expect(
      hasDocumentedCommunication(
        alert({ callbacks: [callback({ read_back_confirmed: true, read_back_value: '6.8 mmol/L' })] }),
      ),
    ).toBe(true);
  });

  it('counts a documented escalation just as much', () => {
    expect(
      hasDocumentedCommunication(
        alert({
          callbacks: [
            callback({ clinician_unreachable: true, escalated_to_level: 2, escalated_to_role: 'HOD' }),
          ],
        }),
      ),
    ).toBe(true);
  });

  /** The gap the rule closes: an attempt that reached nobody and escalated to nobody. */
  it('does not count an attempt with no outcome, even though the API stamped a time', () => {
    expect(
      hasDocumentedCommunication(
        alert({ first_communicated_at: '2026-08-23T06:10:00.000Z', callbacks: [callback()] }),
      ),
    ).toBe(false);
  });
});

describe('the authorisation gate', () => {
  it('permits authorisation when there is no open critical value', () => {
    expect(authorisationVerdict([])).toEqual({ kind: 'permitted' });
  });

  it('blocks authorisation of a critical value nobody has been told about', () => {
    const verdict = authorisationVerdict([alert()]);
    expect(verdict.kind).toBe('blocked');
    if (verdict.kind !== 'blocked') throw new Error('expected a block');
    expect(verdict.message).toContain('Potassium');
    expect(verdict.message).toMatch(/read-back|escalat/iu);
  });

  it('permits authorisation once the communication is documented either way', () => {
    const readBack = alert({
      callbacks: [callback({ read_back_confirmed: true, read_back_value: '6.8' })],
    });
    const escalated = alert({
      id: 'alert-2',
      callbacks: [callback({ clinician_unreachable: true, escalated_to_level: 3, escalated_to_role: 'MS' })],
    });
    expect(authorisationVerdict([readBack, escalated])).toEqual({ kind: 'permitted' });
  });

  it('names every undocumented analyte, not just the first', () => {
    const verdict = authorisationVerdict([alert(), alert({ id: 'a2', analyte_name: 'Troponin I' })]);
    if (verdict.kind !== 'blocked') throw new Error('expected a block');
    expect(verdict.message).toContain('Potassium');
    expect(verdict.message).toContain('Troponin I');
  });
});

describe('building a call-back record', () => {
  const readBackForm: CallbackFormState = {
    ...EMPTY_CALLBACK_FORM,
    notifiedToName: 'Dr Rao',
    notifiedToRole: 'ICU registrar',
    readBackValue: '6.8 mmol/L',
  };

  const escalationForm: CallbackFormState = {
    ...EMPTY_CALLBACK_FORM,
    outcome: 'clinician_unreachable_escalated',
    escalatedToLevel: '2',
    escalatedToRole: 'Medical superintendent',
  };

  it('refuses a read-back with no name — "informed the ward" is not a person', () => {
    expect(callbackProblems({ ...readBackForm, notifiedToName: '' }).join(' ')).toMatch(/not a person/iu);
  });

  it('refuses a read-back with no value read back', () => {
    expect(callbackProblems({ ...readBackForm, readBackValue: '' }).join(' ')).toMatch(/read-back/iu);
  });

  it('refuses an escalation with no destination — that is the bypass D-10 forbids', () => {
    expect(callbackProblems({ ...escalationForm, escalatedToRole: '' }).join(' ')).toMatch(
      /no destination/iu,
    );
  });

  it('makes the escalation arm exactly as easy to complete as the read-back arm', () => {
    // D-10: if escalation were harder, the pressure would fall back onto
    // withholding the report, which is the hazard the decision removes.
    expect(canRecordCallback(readBackForm)).toBe(true);
    expect(canRecordCallback(escalationForm)).toBe(true);
    expect(callbackProblems(readBackForm)).toHaveLength(0);
    expect(callbackProblems(escalationForm)).toHaveLength(0);
  });

  it('builds the laboratory union with exactly one arm', () => {
    const request = toLabCallbackRequest(readBackForm);
    expect(request.outcome).toBe('read_back_confirmed');
    expect(Object.keys(request)).not.toContain('escalatedToLevel');

    const escalated = toLabCallbackRequest(escalationForm);
    expect(escalated.outcome).toBe('clinician_unreachable_escalated');
    expect(Object.keys(escalated)).not.toContain('readBackValue');
  });

  it('never builds the ambiguous middle for imaging, where the wire would allow it', () => {
    const readBack = toRadCallbackRequest(readBackForm);
    expect(readBack.readBackConfirmed).toBe(true);
    expect(readBack.clinicianUnreachable).toBe(false);

    const escalated = toRadCallbackRequest(escalationForm);
    expect(escalated.readBackConfirmed).toBe(false);
    expect(escalated.clinicianUnreachable).toBe(true);
    expect(escalated.escalatedToRole).toBe('Medical superintendent');
  });

  it('throws rather than posting an incomplete record', () => {
    expect(() => toLabCallbackRequest({ ...readBackForm, notifiedToName: '' })).toThrow();
  });
});

describe('the clock', () => {
  const now = new Date('2026-08-23T06:20:00.000Z');

  it('counts the minutes left against the server’s own target', () => {
    expect(minutesToDue(alert(), now)).toBe(10);
    expect(urgencyOf(alert(), now)).toBe('in_time');
  });

  it('calls it breached once the target has passed', () => {
    expect(urgencyOf(alert({ due_by: '2026-08-23T06:10:00.000Z' }), now)).toBe('breached');
  });

  it('says "untimed" rather than inventing a target the hospital did not set', () => {
    expect(minutesToDue(alert({ due_by: null }), now)).toBeNull();
    expect(urgencyOf(alert({ due_by: null }), now)).toBe('untimed');
  });
});
