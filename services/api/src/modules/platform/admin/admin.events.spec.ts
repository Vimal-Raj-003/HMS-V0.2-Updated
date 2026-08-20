import { getEventDefinition } from '@vims/contracts';
import { describe, expect, it } from 'vitest';
import { adminEvent } from './admin.events.js';

const USER_ID = '018f4b5c-0000-7000-8000-00000000001a';
const ROLE_ID = '018f4b5c-0000-7000-8000-00000000002a';
const USER_ROLE_ID = '018f4b5c-0000-7000-8000-00000000003a';

describe('adminEvent', () => {
  it('refuses an unregistered type instead of writing an event nobody consumes', () => {
    expect(() => adminEvent('admin.user.deactived', USER_ID, {})).toThrow(/Unregistered event type/);
  });

  it('refuses a payload that does not satisfy the registered schema', () => {
    // `admin.user.deactivated` requires `reason` and `sessionsRevoked`.
    expect(() =>
      adminEvent('admin.user.deactivated', USER_ID, { userId: USER_ID, username: 'alpha' }),
    ).toThrow(/does not match its registered schema/);
  });

  it('copies aggregate, PHI flag and retention from the registry, never from the call site', () => {
    const event = adminEvent('admin.user.deactivated', USER_ID, {
      userId: USER_ID,
      username: 'alpha',
      reason: 'Left the organisation',
      sessionsRevoked: 2,
    });
    const definition = getEventDefinition('admin.user.deactivated');

    expect(event.aggregate).toBe(definition?.aggregate);
    expect(event.containsPhi).toBe(definition?.containsPhi);
    expect(event.retentionDays).toBe(definition?.retentionDays);
    expect(event.aggregateId).toBe(USER_ID);
  });

  it('keeps compliance-evidence events well beyond the 7-day outbox purge', () => {
    const event = adminEvent('admin.role.assigned', USER_ROLE_ID, {
      userRoleId: USER_ROLE_ID,
      userId: USER_ID,
      roleId: ROLE_ID,
      branchId: null,
      validFrom: '2026-08-20T10:00:00.000Z',
      validTo: null,
      approvalId: null,
    });
    // A role grant is the evidence an access review is run against; docs/03's
    // 7-day default would destroy it long before the quarterly campaign.
    expect(event.retentionDays).toBeGreaterThan(365);
  });

  it('accepts every admin event this module publishes', () => {
    const built = [
      adminEvent('admin.user.created', USER_ID, {
        userId: USER_ID,
        username: 'alpha',
        type: 'staff',
        invitedBy: null,
      }),
      adminEvent('admin.user.updated', USER_ID, {
        userId: USER_ID,
        username: 'alpha',
        changedFields: ['mobile'],
      }),
      adminEvent('admin.user.password_reset', USER_ID, {
        userId: USER_ID,
        username: 'alpha',
        initiatedBy: 'admin',
      }),
      adminEvent('admin.role.revoked', USER_ROLE_ID, {
        userRoleId: USER_ROLE_ID,
        userId: USER_ID,
        roleId: ROLE_ID,
        reason: 'Transferred',
      }),
      adminEvent('admin.role.created', ROLE_ID, {
        roleId: ROLE_ID,
        key: 'ward_clerk',
        clonedFromTemplate: null,
      }),
      adminEvent('admin.role.updated', ROLE_ID, {
        roleId: ROLE_ID,
        key: 'ward_clerk',
        version: 2,
        added: ['admin.user.read'],
        removed: [],
      }),
      adminEvent('admin.settings.changed', USER_ID, {
        key: 'ui.default_theme',
        scope: 'hospital',
        scopeId: null,
        sensitive: false,
      }),
      adminEvent('admin.flag.changed', USER_ID, {
        key: 'module.email.enabled',
        enabled: true,
        scope: 'hospital',
      }),
    ];

    expect(built.map((e) => e.eventType)).toHaveLength(8);
    expect(built.every((e) => e.aggregate.length > 0)).toBe(true);
  });
});
