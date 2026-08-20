import { describe, expect, it, vi } from 'vitest';
import {
  assignRole,
  deactivateUser,
  putFlag,
  putSetting,
  resetUserPassword,
  revokeRole,
  searchAudit,
  updateRolePermissions,
} from './client';

/**
 * Every call whose permission key is marked `requiresReason` in the catalogue
 * must carry the reason, or the policy engine refuses it with 403 before the
 * handler runs. That is easy to break silently — the screen looks right and the
 * failure only appears at the moment somebody is deactivating a leaver — so it is
 * asserted here rather than left to an integration test.
 */

const apiFetch = vi.hoisted(() => vi.fn().mockResolvedValue({}));
vi.mock('@/lib/api', () => ({ apiFetch }));

function lastRequest(): { path: string; init: { method?: string; body?: unknown; reason?: string } } {
  const calls = apiFetch.mock.calls as [string, { method?: string; body?: unknown; reason?: string }][];
  const call = calls[calls.length - 1];
  if (call === undefined) throw new Error('apiFetch was never called');
  return { path: call[0], init: call[1] };
}

describe('reason-required calls', () => {
  it('deactivating a user sends the reason twice: once for the guard, once for the register', async () => {
    await deactivateUser('u1', 'Left the hospital on 18-08-2026');
    const { path, init } = lastRequest();
    expect(path).toBe('/api/v1/admin/users/u1/deactivate');
    expect(init.method).toBe('POST');
    expect(init.reason).toBe('Left the hospital on 18-08-2026');
    expect(init.body).toEqual({ reason: 'Left the hospital on 18-08-2026' });
  });

  it('resetting a password carries a reason and always forces a change at next sign-in', async () => {
    await resetUserPassword('u1', 'a-temporary-password', 'Locked out at the counter');
    const { init } = lastRequest();
    expect(init.reason).toBe('Locked out at the counter');
    expect(init.body).toEqual({ newPassword: 'a-temporary-password', mustChangePassword: true });
  });

  it('assigning a role sends the justification as the reason', async () => {
    await assignRole('u1', { roleId: 'r1', branchId: null, justification: 'Covering the day shift' });
    const { init } = lastRequest();
    expect(init.reason).toBe('Covering the day shift');
  });

  it('revoking a role sends the reason on a DELETE, which carries no body', async () => {
    await revokeRole('u1', 'ur1', 'Moved to day care');
    const { path, init } = lastRequest();
    expect(path).toBe('/api/v1/admin/users/u1/roles/ur1');
    expect(init.method).toBe('DELETE');
    expect(init.reason).toBe('Moved to day care');
    expect(init.body).toBeUndefined();
  });

  it('editing a role sends the reason and the version it was read at, for optimistic locking', async () => {
    await updateRolePermissions({ id: 'r1', version: 3, permissions: ['a.b.c'], reason: 'Restructure' });
    const { path, init } = lastRequest();
    expect(path).toBe('/api/v1/admin/roles/r1');
    expect(init.method).toBe('PATCH');
    expect(init.reason).toBe('Restructure');
    expect(init.body).toEqual({ version: 3, permissions: ['a.b.c'], reason: 'Restructure' });
  });

  it('changing a setting and a flag both carry a reason', async () => {
    await putSetting({
      key: 'session.idle_timeout_min',
      scope: 'hospital',
      scopeId: null,
      value: 10,
      reason: 'NABH finding',
    });
    expect(lastRequest().init.reason).toBe('NABH finding');

    await putFlag({ key: 'module.queue.enabled', enabled: true, note: 'Pilot on OPD block A' });
    const flag = lastRequest();
    expect(flag.path).toBe('/api/v1/admin/flags/module.queue.enabled');
    expect(flag.init.reason).toBe('Pilot on OPD block A');
  });
});

describe('query building', () => {
  it('drops empty filters instead of sending blank parameters the API would reject', async () => {
    await searchAudit({ entity: 'core.roles', q: '', userId: undefined }, undefined);
    expect(lastRequest().path).toBe('/api/v1/admin/audit?entity=core.roles&limit=50');
  });

  it('appends the cursor for the next page', async () => {
    await searchAudit({}, 'cursor-1');
    expect(lastRequest().path).toBe('/api/v1/admin/audit?cursor=cursor-1&limit=50');
  });

  it('escapes a flag key so a dotted key cannot become a path segment', async () => {
    await putFlag({ key: 'module.opd.enabled', enabled: false, note: 'Turned off for the migration' });
    expect(lastRequest().path).toBe('/api/v1/admin/flags/module.opd.enabled');
  });
});
