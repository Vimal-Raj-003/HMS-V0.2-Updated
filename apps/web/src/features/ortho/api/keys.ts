/**
 * TanStack Query cache keys for TR-002 and OP-009, scoped to the tenant.
 */
export function orthoKeys(hospitalId: string) {
  const root = ['vims', hospitalId, 'ortho'] as const;

  return {
    root,
    registry: (scope: string) => [...root, 'registry', scope] as const,
    registryRoot: () => [...root, 'registry'] as const,
    fracture: (id: string) => [...root, 'fracture', id] as const,
    episode: (id: string) => [...root, 'episode', id] as const,

    // TR-003. The trace is deliberately *not* a cached query key: it is an
    // audited action that writes a row every time it runs, so caching it would
    // mean the audit log and the screen disagree about how often it was asked.
    catalogue: (scope: string) => [...root, 'implants', 'catalogue', scope] as const,
    stock: (scope: string) => [...root, 'implants', 'stock', scope] as const,
    patientImplants: (patientId: string) => [...root, 'implants', 'patient', patientId] as const,
    recalls: () => [...root, 'implants', 'recalls'] as const,
    recall: (id: string) => [...root, 'implants', 'recall', id] as const,

    // TR-005
    casts: (scope: string) => [...root, 'casts', scope] as const,
    castsRoot: () => [...root, 'casts'] as const,
    cast: (id: string) => [...root, 'cast', id] as const,
  };
}

export type OrthoKeys = ReturnType<typeof orthoKeys>;
