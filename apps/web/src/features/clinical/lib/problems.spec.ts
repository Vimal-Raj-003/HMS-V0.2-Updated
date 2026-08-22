import { describe, expect, it } from 'vitest';
import { ApiProblem } from '@/lib/api';
import {
  blockedAlertIds,
  fieldMessages,
  isBusinessRule,
  isHardStop,
  isSecondPersonRequired,
  isVersionConflict,
  problemKind,
  weightRequired,
} from './problems';

function problem(type: string, extra: Record<string, unknown> = {}): ApiProblem {
  return new ApiProblem(
    {
      type: `https://errors.vimshms.com/${type}`,
      title: 'Stopped for patient safety',
      status: 422,
      reference: 'trace-abc123',
      ...extra,
    },
    422,
  );
}

describe('reading the refusal', () => {
  it('matches on the type’s last segment, not on the host', () => {
    expect(problemKind(problem('clinical-hard-stop'))).toBe('clinical-hard-stop');
    expect(problemKind(new Error('boom'))).toBeNull();
  });

  it('recognises each refusal the clinical screens must reshape themselves for', () => {
    expect(isHardStop(problem('clinical-hard-stop'))).toBe(true);
    expect(isBusinessRule(problem('business-rule-violated'))).toBe(true);
    expect(isVersionConflict(problem('optimistic-lock-conflict'))).toBe(true);
    expect(isSecondPersonRequired(problem('second-person-required'))).toBe(true);
  });

  it('does not mistake one refusal for another', () => {
    expect(isHardStop(problem('business-rule-violated'))).toBe(false);
    expect(isVersionConflict(problem('clinical-hard-stop'))).toBe(false);
  });

  it('treats a network failure as none of them', () => {
    expect(isHardStop(new TypeError('Failed to fetch'))).toBe(false);
    expect(isVersionConflict(undefined)).toBe(false);
  });
});

describe('the missing-weight refusal', () => {
  const refusal = problem('clinical-hard-stop', {
    detail:
      'Amoxicillin is dosed per kilogram and this patient has no recorded weight. Record the weight before prescribing.',
    nextAction: 'Weigh the patient, or record a stated weight on the encounter.',
    clinicalImpact: 'A per-kilogram dose computed from a guessed weight is a dosing error.',
  });

  /**
   * Exit gate 3's second half: "missing weight blocks paediatric dosing" — and
   * the screen must read as an instruction, never as a raw refusal.
   */
  it('turns the refusal into an instruction', () => {
    const required = weightRequired(refusal);
    expect(required?.instruction).toContain('Weigh the patient');
    expect(required?.clinicalImpact).toContain('dosing error');
    expect(required?.reference).toBe('trace-abc123');
  });

  it('is not claimed for an unrelated hard stop', () => {
    expect(weightRequired(problem('clinical-hard-stop', { detail: 'Documented anaphylaxis' }))).toBeNull();
  });

  it('is not claimed for a non-refusal', () => {
    expect(weightRequired(new Error('boom'))).toBeNull();
  });

  it('still instructs when the API supplied no nextAction', () => {
    const bare = problem('clinical-hard-stop', { detail: 'This drug is dosed per kilogram; no weight.' });
    expect(weightRequired(bare)?.instruction).toContain('Record a weight');
  });
});

describe('the alerts a hard stop names', () => {
  it('surfaces the ids a consultant countersigns against', () => {
    const refusal = problem('clinical-hard-stop', {
      errors: [
        { path: 'items/0', code: 'alert-1', message: 'Documented anaphylaxis' },
        { path: 'items/1', code: 'alert-2', message: 'Contraindicated interaction' },
      ],
    });
    expect(blockedAlertIds(refusal)).toStrictEqual(['alert-1', 'alert-2']);
  });

  it('returns nothing rather than throwing when there are no field errors', () => {
    expect(blockedAlertIds(problem('clinical-hard-stop'))).toStrictEqual([]);
    expect(blockedAlertIds(new Error('boom'))).toStrictEqual([]);
  });

  it('maps each field message to its path so it can sit against its input', () => {
    const refusal = problem('business-rule-violated', {
      errors: [{ path: 'items/0/overrides', code: 'ddi', message: 'Choose a coded override reason.' }],
    });
    expect(fieldMessages(refusal).get('items/0/overrides')).toBe('Choose a coded override reason.');
  });
});
