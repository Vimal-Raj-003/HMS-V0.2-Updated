/**
 * `@vims/contracts` — the single source of truth shared by `apps/web`,
 * `services/api`, `services/worker`, `services/realtime` and (Phase 13)
 * `apps/mobile`.
 *
 * `docs/09 §4`: "The Zod schemas are the single source of truth shared by the web
 * app, the API, the workers and the mobile app." Nothing in this package may
 * import from a service or an app — the dependency arrow points one way only, and
 * an ESLint boundary rule enforces it.
 */

// primitives
export * from './primitives/index.js';

// authorisation
export * from './rbac/permissions.js';
export * from './rbac/abac.js';
export * from './rbac/role-templates.js';

// events
export * from './events/index.js';

// platform contracts
export * from './audit/types.js';
export * from './notifications/types.js';
export * from './settings/definitions.js';
export * from './licensing/entitlements.js';

// request/response schemas
export * from './schemas/index.js';
