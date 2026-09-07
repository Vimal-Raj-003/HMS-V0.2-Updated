/** Query keys for the eye clinic, tenant-scoped like every other feature's. */
export function ophthaKeys(hospitalId: string) {
  const root = ['ophtha', hospitalId] as const;
  return {
    root,
    visits: (scope: string) => [...root, 'visits', scope] as const,
    visitsRoot: () => [...root, 'visits'] as const,
    visit: (id: string) => [...root, 'visit', id] as const,
    trend: (patientId: string, metric: string) => [...root, 'trend', patientId, metric] as const,
  };
}

export type OphthaKeys = ReturnType<typeof ophthaKeys>;
