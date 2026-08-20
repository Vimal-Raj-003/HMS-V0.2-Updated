import { describe, expect, it } from 'vitest';
import { lintTemplateContent, lintVariableValue, type LintableVariable } from './content-lint.js';
import type { TemplateVariableType } from './types.js';

function variable(name: string, type: TemplateVariableType = 'name', maxLength = 30): LintableVariable {
  return { index: 1, name, type, maxLength };
}

function lint(body: string, variables: readonly LintableVariable[] = []): readonly string[] {
  return lintTemplateContent({ body, variables }).map((f) => f.code);
}

describe('templates that must be refused', () => {
  it('refuses a condition named in the static text', () => {
    expect(lint('Your diabetes review is due. Vims Hospital.')).toContain('condition_term');
    expect(lint('Please attend the HIV counselling session.')).toContain('condition_term');
  });

  it('refuses a speciality whose name is the diagnosis', () => {
    expect(lint('Your Oncology appointment is confirmed for {{1}}.')).toContain('sensitive_speciality');
    expect(lint('Your appointment at the IVF centre is confirmed.')).toContain('sensitive_speciality');
  });

  it('refuses medication and dose content', () => {
    expect(lint('Your prescription is ready for collection.')).toContain('medication_term');
    expect(lint('Take 1 tablet twice daily.')).toContain('medication_term');
    expect(lint('Dispensed: 500 mg. Collect at pharmacy.')).toContain('dose_literal');
  });

  it('refuses a qualitative result and a measured value', () => {
    expect(lint('Your sample is reactive. Please call the hospital.')).toContain('result_term');
    expect(lint('Reading: 140/90 mmHg. Vims Hospital.')).toContain('result_literal');
  });

  it('refuses a test name that discloses what is being looked for', () => {
    expect(lint('Your HbA1c report is ready.')).toContain('revealing_test_name');
    expect(lint('Biopsy report available on the portal.')).toContain('revealing_test_name');
  });

  it('refuses an identifier typed into the template body itself', () => {
    // Every patient would receive somebody else's ABHA number.
    expect(lint('Ref 11-2233-4455-6677 for your visit.')).toContain('identifier_literal');
  });

  it('refuses a variable whose *name* promises clinical content', () => {
    expect(lint('Dear {{1}}, {{2}}.', [variable('diagnosis')])).toContain('clinical_variable_name');
    expect(lint('Dear {{1}}, {{2}}.', [variable('testResult')])).toContain('clinical_variable_name');
    expect(lint('Dear {{1}}, {{2}}.', [variable('drug')])).toContain('clinical_variable_name');
    expect(lint('Dear {{1}}, {{2}}.', [variable('department')])).toContain('clinical_variable_name');
  });

  it('refuses a variable declared longer than the TRAI 30-character cap', () => {
    expect(lint('Dear {{1}}.', [variable('patient', 'name', 64)])).toContain('variable_too_long');
  });

  it('lints the DLT-registered content as well as the body', () => {
    // The two can differ; both end up on a patient's phone, so both are linted.
    const findings = lintTemplateContent({
      body: 'Dear {{1}}, your report is ready.',
      registeredContent: 'Dear {#var#}, your biopsy report is ready.',
      variables: [variable('patient')],
    });
    expect(findings.some((f) => f.path === 'registeredContent')).toBe(true);
  });
});

describe('templates that must be allowed', () => {
  it('allows the operational vocabulary a hospital actually sends', () => {
    // A lint that fired on "report" or "appointment" would be switched off
    // within a week, and a lint that is switched off protects nobody.
    const allowed = [
      'Dear {{1}}, your appointment at Vims Hospital is confirmed for {{2}}.',
      'Your lab report is ready. View it at https://reports.example.org/{{1}}',
      'Token {{1}} called at counter {{2}}. Vims Hospital.',
      'Receipt {{1}} for INR {{2}} received. Thank you. Vims Hospital.',
      'Your X-ray report is ready for collection at the front desk.',
      'Dear {{1}}, you were discharged on {{2}}. Follow-up on {{3}}.',
      'Welcome to Vims Hospital. Your UHID card is ready at reception.',
    ];
    for (const body of allowed) {
      expect(lint(body, [variable('patient'), { index: 2, name: 'slot', type: 'datetime', maxLength: 30 }])).toEqual([]);
    }
  });

  it('allows the neutral variable names the seeded catalogue uses', () => {
    const names = ['patient', 'doctor', 'token', 'counter', 'branch', 'amount', 'receiptNo', 'link', 'code', 'date'];
    for (const name of names) {
      expect(lint('Dear {{1}}.', [variable(name)])).toEqual([]);
    }
  });
});

describe('send-time value lint', () => {
  it('catches a clinical value smuggled through a neutral variable', () => {
    // Registration cannot see values, so a `name` variable can still be handed
    // a diagnosis by a caller.
    expect(lintVariableValue('patient', 'Reactive for HIV').length).toBeGreaterThan(0);
    expect(lintVariableValue('branch', 'Oncology block').length).toBeGreaterThan(0);
  });

  it('leaves an ordinary value alone', () => {
    expect(lintVariableValue('patient', 'R Iyer')).toEqual([]);
    expect(lintVariableValue('slot', '21-08-2026 10:30')).toEqual([]);
    expect(lintVariableValue('amount', 'INR 1,450.00')).toEqual([]);
  });

  it('quotes only the matched lexicon word as evidence, never the whole value', () => {
    const findings = lintVariableValue('patient', 'Ramesh Iyer — diabetes review');
    expect(findings[0]?.evidence.toLowerCase()).toBe('diabetes');
    expect(findings[0]?.evidence).not.toContain('Ramesh');
  });
});
