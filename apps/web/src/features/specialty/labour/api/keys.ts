/** Query keys for IP-011, tenant-scoped like every other feature's. */
export function labourKeys(hospitalId: string) {
  const root = ['labour', hospitalId] as const;
  return {
    root,
    episodes: (scope: string) => [...root, 'episodes', scope] as const,
    episodesRoot: () => [...root, 'episodes'] as const,
    episode: (id: string) => [...root, 'episode', id] as const,
    newborns: (scope: string) => [...root, 'newborns', scope] as const,
    newbornsRoot: () => [...root, 'newborns'] as const,
    activations: () => [...root, 'pph'] as const,
  };
}

export type LabourKeys = ReturnType<typeof labourKeys>;
