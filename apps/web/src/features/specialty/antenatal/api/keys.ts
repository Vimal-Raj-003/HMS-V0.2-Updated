/** Query keys for OP-040, tenant-scoped like every other feature's. */
export function antenatalKeys(hospitalId: string) {
  const root = ['antenatal', hospitalId] as const;
  return {
    root,
    pregnancies: (scope: string) => [...root, 'pregnancies', scope] as const,
    pregnanciesRoot: () => [...root, 'pregnancies'] as const,
    pregnancy: (id: string) => [...root, 'pregnancy', id] as const,
    schedule: (scope: string) => [...root, 'schedule', scope] as const,
    scheduleRoot: () => [...root, 'schedule'] as const,
  };
}

export type AntenatalKeys = ReturnType<typeof antenatalKeys>;
