/**
 * `@vims/db` public surface.
 *
 * Kept deliberately small. The Prisma client factory and Kysely query builder
 * arrive with `services/api` (Phase 0, step 3) — exporting them before they
 * exist would leave the manifest pointing at absent files, which is what this
 * barrel replaces.
 */
export {
  TENANT_GUC,
  TenantContextError,
  applyTenantContext,
  clearTenantContext,
  tenantContextSettings,
} from './tenancy.js';
export type { SqlExecutor, TenantContext, TenantGucName, TenantScope } from './tenancy.js';
