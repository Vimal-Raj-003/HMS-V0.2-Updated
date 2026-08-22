import { describe, expect, it } from 'vitest';
import { ApiProblem } from '@/lib/api';
import {
  acknowledgedIds,
  canOverrideDuplicates,
  isDuplicateHardStop,
  isUsableReason,
  parseDuplicateCandidates,
} from './duplicates';

/**
 * The duplicate hard stop, read out of the problem document.
 *
 * These tests are written against the **exact** string `patient.service.ts`
 * composes, because that string is the interface. If the server's format changes,
 * the parse degrades to `raw` and `canOverrideDuplicates` returns false — which
 * closes the override rather than opening it, and that is what the last two tests
 * are for.
 */

function hardStop(messages: readonly string[]): ApiProblem {
  return new ApiProblem(
    {
      type: 'https://errors.vimshms.com/clinical-hard-stop',
      title: 'This action was refused',
      status: 422,
      detail: 'This looks like a patient who is already registered.',
      reference: 'trace-1',
      clinicalImpact: 'A second record means allergies are recorded against a patient nobody is looking at.',
      errors: messages.map((message, index) => ({
        path: `overrideDuplicate/acknowledgedPatientIds/${String(index)}`,
        code: 'duplicate_suspected',
        message,
      })),
    },
    422,
  );
}

const ONE =
  '0021-45871 — SHARMA, Ramesh, male, 45 (id 018f4b2c-6d3e-7a11-9f22-0c1d2e3f4a5b, score 0.90, mobile+dob, name+gender+dob)';

describe('recognising the hard stop', () => {
  it('accepts a clinical hard stop that carries duplicate candidates', () => {
    expect(isDuplicateHardStop(hardStop([ONE]))).toBe(true);
  });

  it('rejects a clinical hard stop that is about something else', () => {
    const other = new ApiProblem(
      {
        type: 'https://errors.vimshms.com/clinical-hard-stop',
        title: 'Refused',
        status: 422,
        reference: 'trace-2',
        errors: [{ path: 'allergy', code: 'allergy_match', message: 'Penicillin' }],
      },
      422,
    );
    expect(isDuplicateHardStop(other)).toBe(false);
  });

  it('rejects a validation failure that happens to mention duplicates', () => {
    const validation = new ApiProblem(
      {
        type: 'https://errors.vimshms.com/validation-failed',
        title: 'Invalid',
        status: 400,
        reference: 'trace-3',
        errors: [{ path: 'mobile', code: 'duplicate_suspected', message: 'x' }],
      },
      400,
    );
    expect(isDuplicateHardStop(validation)).toBe(false);
  });

  it('rejects anything that is not a problem at all', () => {
    expect(isDuplicateHardStop(new Error('network'))).toBe(false);
    expect(isDuplicateHardStop(null)).toBe(false);
  });
});

describe('parsing a candidate', () => {
  it('reads the uhid, the descriptor, the id, the score and the rules', () => {
    const [candidate] = parseDuplicateCandidates(hardStop([ONE]));
    expect(candidate).toBeDefined();
    expect(candidate?.uhid).toBe('0021-45871');
    expect(candidate?.descriptor).toBe('SHARMA, Ramesh, male, 45');
    expect(candidate?.patientId).toBe('018f4b2c-6d3e-7a11-9f22-0c1d2e3f4a5b');
    expect(candidate?.score).toBeCloseTo(0.9);
    expect(candidate?.rules).toEqual(['mobile+dob', 'name+gender+dob']);
  });

  it('keeps a name containing a comma in one piece', () => {
    const [candidate] = parseDuplicateCandidates(hardStop([ONE]));
    // "SHARMA, Ramesh" must not become two people, which is what splitting the
    // message on commas would do.
    expect(candidate?.descriptor).toContain('SHARMA, Ramesh');
  });

  it('handles a candidate whose age is unknown, which the server omits entirely', () => {
    const [candidate] = parseDuplicateCandidates(
      hardStop([
        '0021-1 — SINGH, Baby of Meena, unknown (id 018f4b2c-6d3e-7a11-9f22-000000000001, score 0.86, mobile+dob)',
      ]),
    );
    expect(candidate?.descriptor).toBe('SINGH, Baby of Meena, unknown');
    expect(candidate?.score).toBeCloseTo(0.86);
  });

  it('handles a candidate that matched no named rule', () => {
    const [candidate] = parseDuplicateCandidates(
      hardStop(['0021-2 — RAO, A, female, 30 (id 018f4b2c-6d3e-7a11-9f22-000000000002, score 1.00, )']),
    );
    expect(candidate?.rules).toEqual([]);
    expect(candidate?.score).toBeCloseTo(1);
  });

  it('ignores field errors that are not duplicate candidates', () => {
    const mixed = new ApiProblem(
      {
        type: 'https://errors.vimshms.com/clinical-hard-stop',
        title: 'Refused',
        status: 422,
        reference: 'trace-4',
        errors: [
          { path: 'x', code: 'something_else', message: 'ignore me' },
          { path: 'y', code: 'duplicate_suspected', message: ONE },
        ],
      },
      422,
    );
    expect(parseDuplicateCandidates(mixed)).toHaveLength(1);
  });
});

describe('whether an override may even be offered', () => {
  it('allows it when every candidate could be identified', () => {
    const candidates = parseDuplicateCandidates(hardStop([ONE]));
    expect(canOverrideDuplicates(candidates)).toBe(true);
    expect(acknowledgedIds(candidates)).toEqual(['018f4b2c-6d3e-7a11-9f22-0c1d2e3f4a5b']);
  });

  it('refuses it when a candidate could not be parsed, rather than sending a partial acknowledgement', () => {
    // The server refuses an override that does not cover every blocking
    // candidate, so offering the button here would teach the desk to press it
    // twice and get the same refusal both times.
    const candidates = parseDuplicateCandidates(hardStop([ONE, 'something the desk cannot act on']));
    expect(candidates).toHaveLength(2);
    expect(candidates[1]?.raw).toBe('something the desk cannot act on');
    expect(canOverrideDuplicates(candidates)).toBe(false);
  });

  it('refuses it when there are no candidates at all', () => {
    expect(canOverrideDuplicates([])).toBe(false);
  });
});

describe('the reason the override needs', () => {
  it('matches the server’s eight-character floor', () => {
    expect(isUsableReason('short')).toBe(false);
    expect(isUsableReason('        ')).toBe(false);
    expect(isUsableReason('Different mother, checked the passport')).toBe(true);
  });
});
