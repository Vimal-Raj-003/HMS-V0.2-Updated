import { SECOND_PERSON_PERMISSIONS } from '@vims/contracts';
import { describe, expect, it } from 'vitest';
import { Permission } from './permission.decorator.js';

/**
 * The `@Permission()` decorator refuses two kinds of key at module load.
 *
 * Both failures share a shape worth naming: the route looks correct in review
 * and denies every user in production. An unregistered key cannot be granted to
 * any role, because `core.role_permissions` has a foreign key to the catalogue.
 * A `requiresSecondPerson` key is denied by the policy engine unless a co-signer
 * is supplied, and `PolicyGuard` has nowhere to get one — a decorator cannot
 * reach into a request body.
 *
 * Neither is caught by a type. Both are caught here, and at import time in the
 * real application, which is earlier than any test.
 */
describe('@Permission()', () => {
  it('accepts a registered key that needs no second person', () => {
    expect(() => Permission('patient.record.list')).not.toThrow();
  });

  it('refuses an unregistered key', () => {
    expect(() => Permission('not.a.real.key')).toThrow(/Unregistered permission key/);
  });

  /**
   * Iterated rather than hardcoded: a key added to the catalogue with this flag
   * in a later phase is covered the moment it is added. Phase 4 introduces
   * narcotics, whose keys carry it.
   */
  it.each(SECOND_PERSON_PERMISSIONS)('refuses %s, which would deny every user', (key) => {
    expect(() => Permission(key)).toThrow(/cannot be used as a route decorator/);
  });

  it('names at least one second-person key, so the list above is not vacuously empty', () => {
    expect(SECOND_PERSON_PERMISSIONS.length).toBeGreaterThan(0);
  });
});
