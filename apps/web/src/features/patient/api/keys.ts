import type { PatientSearchCriteria } from './client';

/**
 * TanStack Query cache keys for the front office, scoped to the tenant
 * (`CLAUDE.md` §2), exactly as `features/admin/api/keys.ts` is.
 *
 * The `hospitalId` prefix is not decoration. A group administrator switches
 * hospitals inside one browser tab; without the prefix, hospital B's MPI search
 * would be served from hospital A's cache entry and the desk would register a
 * visit against the wrong tenant's patient with no request made and nothing to
 * notice.
 *
 * The **search key deliberately carries the criteria object**, which contains a
 * mobile number or a name. That is a key in an in-memory cache, not a URL: it is
 * never serialised into the address bar, never into history and never into a
 * server log. `docs/06` §6.5's "no PHI in the URL" is honoured by the routes in
 * `app/(workspace)/patients`, which take an opaque patient id and nothing else.
 */
export function patientKeys(hospitalId: string) {
  const root = ['vims', hospitalId, 'patient'] as const;
  return {
    root,
    search: (criteria: PatientSearchCriteria) => [...root, 'search', criteria] as const,
    recent: () => [...root, 'recent'] as const,
    detail: (id: string) => [...root, 'detail', id] as const,
    history: (id: string) => [...root, 'history', id] as const,
    visits: (id: string) => [...root, 'visits', id] as const,
    dedupe: (status: string, minScore: number) => [...root, 'dedupe', status, minScore] as const,
  };
}

export type PatientKeys = ReturnType<typeof patientKeys>;
