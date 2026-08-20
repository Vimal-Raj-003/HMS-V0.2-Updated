import { REDACTION_PLACEHOLDER, type SettingDefinition } from '@vims/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  SETTING_SCOPE_PRECEDENCE,
  checkSettingWrite,
  maskIfSecret,
  resolveEffectiveSetting,
  scopeOfRow,
  type SettingRow,
} from './settings.logic.js';

const BRANCH = '018f4b5c-0000-7000-8000-0000000000b1';
const DEPARTMENT = '018f4b5c-0000-7000-8000-0000000000d1';
const USER = '018f4b5c-0000-7000-8000-0000000000e1';

function definition(overrides: Partial<SettingDefinition<unknown>> = {}): SettingDefinition<unknown> {
  return {
    key: 'ui.default_theme',
    module: 'EN-007',
    label: 'Default theme',
    description: 'Light for clinical work, dark for boards.',
    scopes: ['hospital', 'branch', 'user'],
    schema: z.enum(['light', 'dark', 'system']),
    defaultValue: 'light',
    sensitivity: 'normal',
    requiresApproval: false,
    dualControl: false,
    ...overrides,
  };
}

function row(overrides: Partial<SettingRow>): SettingRow {
  return {
    key: 'ui.default_theme',
    branch_id: null,
    department_id: null,
    user_id: null,
    value: 'dark',
    updated_at: new Date('2026-08-20T09:00:00.000Z'),
    updated_by: null,
    ...overrides,
  };
}

const query = { branchId: BRANCH, departmentId: DEPARTMENT, userId: USER };

describe('scope precedence', () => {
  it('is narrowest first — changing this order changes the product', () => {
    expect(SETTING_SCOPE_PRECEDENCE).toEqual(['user', 'department', 'branch', 'hospital']);
  });

  it('classifies a row by its narrowest populated scope column', () => {
    expect(scopeOfRow(row({}))).toBe('hospital');
    expect(scopeOfRow(row({ branch_id: BRANCH }))).toBe('branch');
    expect(scopeOfRow(row({ branch_id: BRANCH, department_id: DEPARTMENT }))).toBe('department');
    expect(scopeOfRow(row({ branch_id: BRANCH, user_id: USER }))).toBe('user');
  });
});

describe('effective value resolution', () => {
  it('falls back to the declared default when nothing is set', () => {
    const effective = resolveEffectiveSetting(definition(), [], query);
    expect(effective.value).toBe('light');
    expect(effective.source).toBe('default');
  });

  it('prefers a user row over branch and hospital rows', () => {
    const effective = resolveEffectiveSetting(
      definition(),
      [
        row({ value: 'system' }),
        row({ branch_id: BRANCH, value: 'dark' }),
        row({ branch_id: BRANCH, user_id: USER, value: 'light' }),
      ],
      query,
    );
    expect(effective.value).toBe('light');
    expect(effective.source).toBe('user');
  });

  it('prefers a branch row over the hospital row', () => {
    const effective = resolveEffectiveSetting(
      definition(),
      [row({ value: 'system' }), row({ branch_id: BRANCH, value: 'dark' })],
      query,
    );
    expect(effective.value).toBe('dark');
    expect(effective.source).toBe('branch');
  });

  it('ignores a row belonging to a different branch', () => {
    const other = '018f4b5c-0000-7000-8000-0000000000b2';
    const effective = resolveEffectiveSetting(
      definition(),
      [row({ value: 'system' }), row({ branch_id: other, value: 'dark' })],
      query,
    );
    expect(effective.value).toBe('system');
    expect(effective.source).toBe('hospital');
  });

  it('ignores rows for another key entirely', () => {
    const effective = resolveEffectiveSetting(
      definition(),
      [row({ key: 'ui.default_density', value: 'dark' })],
      query,
    );
    expect(effective.source).toBe('default');
  });

  it('reports who last changed the winning row, so a surprise is traceable', () => {
    const effective = resolveEffectiveSetting(definition(), [row({ updated_by: USER })], query);
    expect(effective.updatedBy).toBe(USER);
    expect(effective.updatedAt).toBe('2026-08-20T09:00:00.000Z');
  });
});

describe('secret masking', () => {
  const secret = definition({
    key: 'sms.api_key',
    sensitivity: 'secret',
    schema: z.string(),
    defaultValue: '',
  });

  it('never returns the stored value of a secret key', () => {
    expect(maskIfSecret(secret, 'live_key_abc123')).toEqual({ value: REDACTION_PLACEHOLDER, masked: true });
  });

  it('masks the default as well, so a seeded credential cannot leak either', () => {
    const effective = resolveEffectiveSetting(
      secret,
      [row({ key: 'sms.api_key', value: 'live_key_abc123' })],
      query,
    );
    expect(effective.value).toBe(REDACTION_PLACEHOLDER);
    expect(effective.defaultValue).toBe(REDACTION_PLACEHOLDER);
    expect(effective.masked).toBe(true);
    expect(JSON.stringify(effective)).not.toContain('live_key_abc123');
  });

  it('leaves ordinary settings alone', () => {
    expect(maskIfSecret(definition(), 'dark')).toEqual({ value: 'dark', masked: false });
  });
});

describe('write checks', () => {
  it('refuses a key that is not declared anywhere', () => {
    const result = checkSettingWrite({ definition: undefined, scope: 'hospital', value: 1, reason: null });
    expect(result).toMatchObject({ ok: false, code: 'unknown_key' });
  });

  it('refuses a scope the definition does not permit', () => {
    const result = checkSettingWrite({
      definition: definition({ scopes: ['hospital'] }),
      scope: 'user',
      value: 'dark',
      reason: null,
    });
    expect(result).toMatchObject({ ok: false, code: 'scope_not_allowed' });
  });

  it('refuses a value the definition schema rejects', () => {
    const result = checkSettingWrite({
      definition: definition(),
      scope: 'hospital',
      value: 'neon',
      reason: null,
    });
    expect(result).toMatchObject({ ok: false, code: 'invalid_value' });
  });

  it('refuses an approval-gated key rather than applying it without the approval', () => {
    // `session.idle_timeout_min` is approval-gated precisely so one
    // administrator cannot widen it alone. Applying it here would delete that
    // control while appearing to honour it.
    const result = checkSettingWrite({
      definition: definition({ requiresApproval: true }),
      scope: 'hospital',
      value: 'dark',
      reason: 'because',
    });
    expect(result).toMatchObject({ ok: false, code: 'needs_approval' });
  });

  it('refuses a dual-control key on the same grounds', () => {
    const result = checkSettingWrite({
      definition: definition({ dualControl: true }),
      scope: 'hospital',
      value: 'dark',
      reason: 'because',
    });
    expect(result).toMatchObject({ ok: false, code: 'needs_approval' });
  });

  it('requires a reason for a restricted or secret key', () => {
    const result = checkSettingWrite({
      definition: definition({ sensitivity: 'restricted' }),
      scope: 'hospital',
      value: 'dark',
      reason: '   ',
    });
    expect(result).toMatchObject({ ok: false, code: 'reason_required' });
  });

  it('accepts a valid ordinary write and returns the parsed value', () => {
    const result = checkSettingWrite({
      definition: definition(),
      scope: 'hospital',
      value: 'dark',
      reason: null,
    });
    expect(result).toEqual({ ok: true, value: 'dark' });
  });
});
