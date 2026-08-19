import { SetMetadata, type CustomDecorator } from '@nestjs/common';
import { assertRegisteredPermission } from '@vims/contracts';

export const PERMISSION_KEY = 'vims:permission';
export const PUBLIC_KEY = 'vims:public';

/**
 * Declares the permission a route requires.
 *
 * The key is validated against the catalogue **at module load**, not at request
 * time. A typo therefore stops the process at boot rather than producing a route
 * that denies everyone in production at 2 a.m. — `phase-00 §0.3` requires "CI
 * fails on any route without a permission key", and this is the other half of
 * that: no route may invent one either.
 */
export function Permission(key: string): CustomDecorator<string> {
  assertRegisteredPermission(key, 'route decorator');
  return SetMetadata(PERMISSION_KEY, key);
}

/**
 * Marks a route as reachable without authentication.
 *
 * Deliberately explicit and deliberately rare: login, health and the OpenAPI
 * document. Everything else is authenticated by default, because a route that
 * is public by omission is the failure mode this codebase must not have.
 */
export function Public(): CustomDecorator<string> {
  return SetMetadata(PUBLIC_KEY, true);
}
