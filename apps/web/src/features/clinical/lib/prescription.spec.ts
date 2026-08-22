import { describe, expect, it } from 'vitest';
import type { DrugSearchResult } from '../api/types';
import {
  describeLine,
  emptyLine,
  isLineReady,
  lineFromDrug,
  lineProblems,
  toLineRequest,
} from './prescription';

function drug(overrides: Partial<DrugSearchResult> = {}): DrugSearchResult {
  return {
    record_key: 'drug-1',
    code: 'PRED5',
    generic_name: 'Prednisolone',
    brand_name: 'Wysolone',
    strength_text: '5 mg',
    form: 'tablet',
    route: 'oral',
    schedule: 'h',
    is_high_alert: false,
    is_lasa: true,
    tall_man_display: 'predniSOLONE',
    in_formulary: true,
    ...overrides,
  };
}

describe('a line from the drug master', () => {
  /**
   * `predniSONE` and `predniSOLONE` are one keystroke apart and are not the same
   * drug. Dropping the master's tall-man rendering at the last step undoes a
   * look-alike/sound-alike control.
   */
  it('keeps the tall-man rendering the master supplies', () => {
    expect(lineFromDrug('l1', drug()).genericName).toBe('predniSOLONE');
  });

  it('falls back to the generic name where the master has no tall-man form', () => {
    expect(lineFromDrug('l1', drug({ tall_man_display: null })).genericName).toBe('Prednisolone');
  });

  it('carries the safety flags onto the line', () => {
    const line = lineFromDrug('l1', drug({ is_high_alert: true }));
    expect(line.isHighAlert).toBe(true);
    expect(line.isLasa).toBe(true);
    expect(line.schedule).toBe('h');
  });
});

describe('what makes a line ready', () => {
  it('needs a drug, or a name somebody can dispense against', () => {
    expect(isLineReady(emptyLine('l1'))).toBe(false);
    expect(isLineReady({ ...emptyLine('l1'), genericName: 'Amoxicillin' })).toBe(true);
    expect(isLineReady(lineFromDrug('l1', drug()))).toBe(true);
  });

  it('refuses a dose that is not a positive number', () => {
    const line = { ...lineFromDrug('l1', drug()), doseQty: 'abc' };
    expect(lineProblems(line)).toContainEqual(expect.stringContaining('greater than zero'));
  });
});

describe('the request', () => {
  it('sends the drug key when one was chosen, and the typed name only when there is none', () => {
    expect(toLineRequest(lineFromDrug('l1', drug()), [])).toMatchObject({ drugKey: 'drug-1' });
    expect(toLineRequest({ ...emptyLine('l1'), genericName: 'Cough syrup' }, [])).toMatchObject({
      genericName: 'Cough syrup',
    });
  });

  it('omits every field left blank rather than sending an empty string', () => {
    const request = toLineRequest(lineFromDrug('l1', drug()), []);
    expect('doseQty' in request).toBe(false);
    expect('frequencyCode' in request).toBe(false);
    expect('instructionsText' in request).toBe(false);
  });

  /**
   * The API keys an override by family, and a per-kilogram line never carries a
   * weight — the server reads it from the encounter, which is what stops a
   * client supplying a convenient one.
   */
  it('attaches the coded overrides by family', () => {
    const request = toLineRequest(lineFromDrug('l1', drug()), [
      { family: 'ddi', reasonCode: 'MONITORING_PLANNED' },
    ]);
    expect(request.overrides).toStrictEqual([{ family: 'ddi', reasonCode: 'MONITORING_PLANNED' }]);
  });

  it('never sends a weight with a per-kilogram line', () => {
    const request = toLineRequest({ ...lineFromDrug('l1', drug()), doseBasis: 'per_kg', doseQty: '10' }, []);
    expect(request.doseBasis).toBe('per_kg');
    expect(Object.keys(request)).not.toContain('weightKg');
  });
});

describe('the one-line summary', () => {
  it('reads as a prescription line, with the per-kilogram basis spelt out', () => {
    const line = {
      ...lineFromDrug('l1', drug()),
      doseQty: '10',
      doseUnit: 'mg',
      doseBasis: 'per_kg' as const,
      frequencyCode: 'TDS',
      durationValue: '5',
    };
    expect(describeLine(line)).toBe('predniSOLONE · 5 mg · 10 mg/kg · TDS · for 5 days');
  });
});
