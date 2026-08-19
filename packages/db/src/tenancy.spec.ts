import { describe, expect, it } from 'vitest';
import {
  TENANT_GUC,
  TenantContextError,
  applyTenantContext,
  clearTenantContext,
  tenantContextSettings,
  type SqlExecutor,
  type TenantContext,
} from './tenancy.js';

const HOSP_A = '11111111-1111-7111-8111-111111111111';
const HOSP_B = '22222222-2222-7222-8222-222222222222';
const USER = '33333333-3333-7333-8333-333333333333';
const BRANCH = '44444444-4444-7444-8444-444444444444';

function recorder(): SqlExecutor & { calls: Array<{ sql: string; values: readonly unknown[] }> } {
  const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  return {
    calls,
    query(sql: string, values: readonly unknown[] = []) {
      calls.push({ sql, values });
      return Promise.resolve(undefined);
    },
  };
}

const branchScoped: TenantContext = { hospitalId: HOSP_A, userId: USER, scope: 'branch' };

describe('tenantContextSettings', () => {
  it('emits hospital, user and scope for an ordinary session', () => {
    expect(tenantContextSettings(branchScoped)).toEqual([
      [TENANT_GUC.hospitalId, HOSP_A],
      [TENANT_GUC.userId, USER],
      [TENANT_GUC.scope, 'branch'],
    ]);
  });

  it('includes branch ids only when some are given', () => {
    const withBranch = tenantContextSettings({ ...branchScoped, branchIds: [BRANCH] });
    expect(withBranch).toContainEqual([TENANT_GUC.branchIds, `{${BRANCH}}`]);

    const withoutBranch = tenantContextSettings({ ...branchScoped, branchIds: [] });
    expect(withoutBranch.map(([name]) => name)).not.toContain(TENANT_GUC.branchIds);
  });

  it('widens the hospital set only for group scope', () => {
    const settings = tenantContextSettings({
      hospitalId: HOSP_A,
      userId: USER,
      scope: 'group',
      hospitalIds: [HOSP_A, HOSP_B],
    });
    expect(settings).toContainEqual([TENANT_GUC.hospitalIds, `{${HOSP_A},${HOSP_B}}`]);
  });

  // The three guards below all exist to stop a *silent* widening or narrowing —
  // the failure mode where the session simply sees the wrong set and nothing errors.
  it('rejects a group session with no hospitals listed', () => {
    expect(() =>
      tenantContextSettings({ hospitalId: HOSP_A, userId: USER, scope: 'group', hospitalIds: [] }),
    ).toThrow(TenantContextError);
  });

  it('rejects a group session whose own hospital is not in its list', () => {
    expect(() =>
      tenantContextSettings({
        hospitalId: HOSP_A,
        userId: USER,
        scope: 'group',
        hospitalIds: [HOSP_B],
      }),
    ).toThrow(/must be one of hospitalIds/);
  });

  it('rejects hospitalIds passed with a non-group scope, which would not widen anything', () => {
    expect(() => tenantContextSettings({ ...branchScoped, hospitalIds: [HOSP_A, HOSP_B] })).toThrow(
      /only meaningful for group scope/,
    );
  });

  it.each([
    ['hospitalId', { hospitalId: "'; DROP TABLE core.patients; --", userId: USER, scope: 'branch' }],
    ['userId', { hospitalId: HOSP_A, userId: 'not-a-uuid', scope: 'branch' }],
  ] as const)('refuses to build a scope from a non-UUID %s', (_field, ctx) => {
    expect(() => tenantContextSettings(ctx as TenantContext)).toThrow(TenantContextError);
  });

  it('refuses a non-UUID inside a branch id array', () => {
    expect(() => tenantContextSettings({ ...branchScoped, branchIds: [BRANCH, 'oops'] })).toThrow(
      /branchIds\[1\]/,
    );
  });
});

describe('applyTenantContext', () => {
  it('uses parameterised set_config so no identifier is ever concatenated into SQL', async () => {
    const exec = recorder();
    await applyTenantContext(exec, branchScoped);

    expect(exec.calls).toHaveLength(3);
    for (const call of exec.calls) {
      expect(call.sql).toBe('SELECT set_config($1, $2, true)');
      expect(call.values).toHaveLength(2);
    }
    expect(exec.calls.map((c) => c.values[0])).toEqual([
      TENANT_GUC.hospitalId,
      TENANT_GUC.userId,
      TENANT_GUC.scope,
    ]);
  });

  it('always sets is_local = true, so a scope cannot survive into the next pooled request', async () => {
    const exec = recorder();
    await applyTenantContext(exec, branchScoped);
    for (const call of exec.calls) {
      expect(call.sql).toContain(', true)');
      expect(call.sql).not.toMatch(/SET\s+(SESSION\s+)?app\./i);
    }
  });

  it('never issues a statement when the context is invalid', async () => {
    const exec = recorder();
    await expect(
      applyTenantContext(exec, { hospitalId: 'bad', userId: USER, scope: 'branch' }),
    ).rejects.toThrow(TenantContextError);
    expect(exec.calls).toHaveLength(0);
  });
});

describe('clearTenantContext', () => {
  it('blanks every GUC the policies read', async () => {
    const exec = recorder();
    await clearTenantContext(exec);
    expect(exec.calls.map((c) => c.values[0]).sort()).toEqual(Object.values(TENANT_GUC).sort());
    expect(exec.calls.every((c) => c.values[1] === '')).toBe(true);
  });
});
