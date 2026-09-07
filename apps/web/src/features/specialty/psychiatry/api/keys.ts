/** Query keys for OP-032, tenant-scoped like every other feature's. */
export function psychiatryKeys(hospitalId: string) {
  const root = ['psychiatry', hospitalId] as const;
  return {
    root,
    episodes: (scope: string) => [...root, 'episodes', scope] as const,
    episodesRoot: () => [...root, 'episodes'] as const,
    episode: (id: string) => [...root, 'episode', id] as const,
    restraints: (scope: string) => [...root, 'restraints', scope] as const,
    restraintsRoot: () => [...root, 'restraints'] as const,
  };
}

export type PsychiatryKeys = ReturnType<typeof psychiatryKeys>;
