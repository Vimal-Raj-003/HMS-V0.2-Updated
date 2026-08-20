import type { AuditFilters, UserFilters } from './types';

/**
 * TanStack Query cache keys, scoped to the tenant (`CLAUDE.md` §2).
 *
 * The `hospitalId` prefix is not decoration. A group administrator switches
 * hospitals inside one browser tab; without the prefix, hospital B's users list
 * would be served from hospital A's cache entry and the screen would show the
 * wrong tenant's staff with no request made and nothing to notice. Prefixing
 * every key makes the switch a cache miss, which is the correct behaviour.
 */
export function adminKeys(hospitalId: string) {
  const root = ['vims', hospitalId, 'admin'] as const;
  return {
    root,
    users: (filters: UserFilters) => [...root, 'users', filters] as const,
    user: (id: string) => [...root, 'user', id] as const,
    roles: () => [...root, 'roles'] as const,
    role: (id: string) => [...root, 'role', id] as const,
    permissions: () => [...root, 'permissions'] as const,
    branches: () => [...root, 'branches'] as const,
    branch: (id: string) => [...root, 'branch', id] as const,
    settings: (module: string | null, q: string) => [...root, 'settings', module, q] as const,
    flags: () => [...root, 'flags'] as const,
    licence: () => [...root, 'licence'] as const,
    audit: (filters: AuditFilters) => [...root, 'audit', filters] as const,
  };
}

export type AdminKeys = ReturnType<typeof adminKeys>;
