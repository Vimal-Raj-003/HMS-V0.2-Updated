/** Query keys for OP-013 and OP-014, tenant-scoped like every other feature's. */
export function programmeKeys(hospitalId: string) {
  const root = ['programme', hospitalId] as const;
  return {
    root,
    vials: (scope: string) => [...root, 'vials', scope] as const,
    vialsRoot: () => [...root, 'vials'] as const,
    records: (scope: string) => [...root, 'records', scope] as const,
    planDoses: (scope: string) => [...root, 'plan-doses', scope] as const,
    breaches: () => [...root, 'breaches'] as const,
    aefi: () => [...root, 'aefi'] as const,

    hcEpisodes: (scope: string) => [...root, 'hc-episodes', scope] as const,
    hcEpisodesRoot: () => [...root, 'hc-episodes'] as const,
    hcEpisode: (id: string) => [...root, 'hc-episode', id] as const,
  };
}

export type ProgrammeKeys = ReturnType<typeof programmeKeys>;
