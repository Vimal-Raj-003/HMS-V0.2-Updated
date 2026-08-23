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
  const definition = assertRegisteredPermission(key, 'route decorator');

  // A `requiresSecondPerson` key on a route is a route that refuses everybody,
  // forever.
  //
  // The policy engine denies such a key unless `secondPersonUserId` is supplied,
  // and `PolicyGuard` calls `evaluate()` without one — a decorator has no way to
  // reach into a request body and find the co-signer. So the route does not
  // become "harder to use": it becomes impossible to use, for every user,
  // including the hospital administrator, and it looks correct in review.
  //
  // Both existing second-person flows (`cash/cosign.service.ts`,
  // `radiology/pacs.controller.ts`) already avoid this by decorating with the
  // lesser precondition key the actor genuinely needs and asserting the real
  // authority inside the service with the co-signer attached. That pattern is
  // fine; the trap is that nothing stopped the *next* module from decorating
  // directly and shipping a dead route. Now something does, at module load,
  // before the process starts.
  if (definition.requiresSecondPerson === true) {
    throw new Error(
      `Permission "${key}" is flagged requiresSecondPerson and cannot be used as a route decorator: ` +
        `PolicyGuard evaluates it without a co-signer, so the route would deny every user unconditionally. ` +
        `Decorate the route with the precondition key the actor holds, and assert "${key}" inside the ` +
        `service with the co-signer attached (see services/api/src/modules/frontoffice/cash/cosign.service.ts).`,
    );
  }

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

export const AUTHENTICATED_ONLY_KEY = 'vims:authenticated-only';

/**
 * Marks a route that requires a **valid session but no specific permission**.
 *
 * There is exactly one legitimate use: session introspection. `/me` cannot
 * require a permission key, because the client calls `/me` precisely to learn
 * which permission keys it holds — requiring one would be circular, and the
 * usual workaround (marking it `@Public()`) is worse, because it would let an
 * unauthenticated caller probe it.
 *
 * The contract a route accepts by using this is narrow and not enforceable by
 * the type system, so it is stated here and must be checked in review: **a route
 * marked this way may only return data about the calling session itself.** It
 * may never accept an identifier that lets the caller ask about somebody else —
 * that is what permission keys are for.
 */
export function AuthenticatedOnly(): CustomDecorator<string> {
  return SetMetadata(AUTHENTICATED_ONLY_KEY, true);
}
