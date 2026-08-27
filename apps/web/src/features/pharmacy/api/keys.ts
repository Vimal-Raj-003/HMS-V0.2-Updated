/**
 * TanStack Query cache keys for the pharmacy screens, scoped to the tenant
 * (`CLAUDE.md` §2), exactly as `features/diagnostics/api/keys.ts` is.
 *
 * The `hospitalId` prefix is not decoration. A group pharmacist switches
 * hospitals inside one browser tab; without the prefix hospital B's Rx queue
 * would be served from hospital A's cache entry, and a queue from the wrong
 * tenant is a bag of medicine handed to the wrong person.
 *
 * **The cursor is part of the key.** That is not cosmetic either: TanStack
 * refetches on a key change, so a cursor held only in a closure changes the
 * request the query *would* make without ever making it — the operator presses
 * "Load the next page" and the same page comes back.
 *
 * Nothing here is keyed by anything that reaches the address bar. The keys carry
 * opaque ids and coded filters; the routes under `app/(workspace)/pharmacy` take
 * no parameters at all, so `docs/06` §6.5's "no PHI in the URL" holds by
 * construction rather than by review.
 */
export function pharmacyKeys(hospitalId: string) {
  const root = ['vims', hospitalId, 'pharmacy'] as const;

  return {
    root,

    queue: (storeId: string, status: string, cursor: string) =>
      [...root, 'queue', storeId, status, cursor] as const,
    queueRoot: () => [...root, 'queue'] as const,
    queueEntry: (id: string) => [...root, 'queue', 'entry', id] as const,

    dispense: (id: string) => [...root, 'dispense', id] as const,
    dispenses: (storeId: string, status: string, cursor: string) =>
      [...root, 'dispenses', storeId, status, cursor] as const,
    dispensesRoot: () => [...root, 'dispenses'] as const,

    stock: (storeId: string, term: string) => [...root, 'stock', storeId, term] as const,
    stockRoot: () => [...root, 'stock'] as const,

    expiry: (storeId: string, days: number) => [...root, 'expiry', storeId, String(days)] as const,
    expiryRoot: () => [...root, 'expiry'] as const,

    recalls: (status: string, cursor: string) => [...root, 'recalls', status, cursor] as const,
    recallsRoot: () => [...root, 'recalls'] as const,
    recall: (id: string) => [...root, 'recalls', 'one', id] as const,

    register: (storeId: string, registerType: string, cursor: string) =>
      [...root, 'register', storeId, registerType, cursor] as const,
    registerRoot: () => [...root, 'register'] as const,

    dayCloses: (storeId: string, cursor: string) => [...root, 'day-close', storeId, cursor] as const,
    dayClosesRoot: () => [...root, 'day-close'] as const,

    saleReturn: (id: string) => [...root, 'return', id] as const,
    returnsRoot: () => [...root, 'return'] as const,
  };
}

export type PharmacyKeys = ReturnType<typeof pharmacyKeys>;
