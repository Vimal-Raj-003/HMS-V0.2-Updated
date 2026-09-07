/** Query keys for OP-016, tenant-scoped like every other feature's. */
export function painKeys(hospitalId: string) {
  const root = ['pain', hospitalId] as const;
  return {
    root,
    thresholds: () => [...root, 'thresholds'] as const,
    episodes: (scope: string) => [...root, 'episodes', scope] as const,
    episodesRoot: () => [...root, 'episodes'] as const,
    episode: (id: string) => [...root, 'episode', id] as const,
    opioids: (scope: string) => [...root, 'opioids', scope] as const,
    opioidsRoot: () => [...root, 'opioids'] as const,
  };
}

export type PainKeys = ReturnType<typeof painKeys>;
