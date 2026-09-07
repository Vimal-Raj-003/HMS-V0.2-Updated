/** Query keys for OP-033, IP-015 and OP-034. */
export function lifespanKeys(hospitalId: string) {
  const root = ['lifespan', hospitalId] as const;
  return {
    root,
    growth: (scope: string) => [...root, 'growth', scope] as const,
    nicu: (scope: string) => [...root, 'nicu', scope] as const,
    fluids: (id: string) => [...root, 'fluids', id] as const,
    reviews: (scope: string) => [...root, 'reviews', scope] as const,
  };
}

export type LifespanKeys = ReturnType<typeof lifespanKeys>;
