import { assertRegisteredPermission, PERMISSION_CATALOGUE } from '@vims/contracts';
import { describe, expect, it } from 'vitest';
import { DISPLAY_BOARD_SCOPE } from '../features/pairing/pairing-contract';

/**
 * The scope a paired display holds must be a key that exists.
 *
 * `PermissionRegistryService` verifies the catalogue against the database at
 * boot and the policy guard refuses any key it does not know, so a device token
 * minted with an invented scope is not a lenient failure — it is a board that
 * pairs successfully and then 403s on every snapshot, at 08:30, in a lobby.
 *
 * The catalogue is imported here and nowhere in `src/features`, which is the
 * point: the assertion is paid for at build time and the board's bundle stays
 * free of two thousand permission records.
 */
describe('the display device scope', () => {
  it('is a key the permission catalogue actually registers', () => {
    expect(() => {
      assertRegisteredPermission(DISPLAY_BOARD_SCOPE, 'display device token');
    }).not.toThrow();
  });

  it('is read-only, because a screen in a corridor may never write anything', () => {
    const entry = PERMISSION_CATALOGUE.find((p) => p.key === DISPLAY_BOARD_SCOPE);
    expect(entry).toBeDefined();
    expect(entry?.action).toBe('read');
  });

  it('carries no PHI read authority (EN-018 §5)', () => {
    const entry = PERMISSION_CATALOGUE.find((p) => p.key === DISPLAY_BOARD_SCOPE);
    expect(entry?.phiRead ?? false).toBe(false);
  });
});
