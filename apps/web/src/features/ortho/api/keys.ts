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
  };
}

export type OrthoKeys = ReturnType<typeof orthoKeys>;
