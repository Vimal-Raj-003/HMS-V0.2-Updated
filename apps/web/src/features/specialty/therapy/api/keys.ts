/** Query keys for the four therapy consoles, tenant-scoped like every other feature's. */
export function therapyKeys(hospitalId: string) {
  const root = ['therapy', hospitalId] as const;
  return {
    root,
    episodes: (scope: string) => [...root, 'episodes', scope] as const,
    episodesRoot: () => [...root, 'episodes'] as const,
    episode: (id: string) => [...root, 'episode', id] as const,

    wounds: (scope: string) => [...root, 'wounds', scope] as const,
    woundsRoot: () => [...root, 'wounds'] as const,
    wound: (id: string) => [...root, 'wound', id] as const,

    dietPlans: (scope: string) => [...root, 'diet-plans', scope] as const,
    dietPlansRoot: () => [...root, 'diet-plans'] as const,
    nutritionAssessments: (scope: string) => [...root, 'nutrition-assessments', scope] as const,

    swallowOrders: (scope: string) => [...root, 'swallow-orders', scope] as const,
    swallowOrdersRoot: () => [...root, 'swallow-orders'] as const,
  };
}

export type TherapyKeys = ReturnType<typeof therapyKeys>;
