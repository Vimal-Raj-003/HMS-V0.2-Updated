/** Query keys for OP-031 and IP-023, tenant-scoped like every other feature's. */
export function oncologyKeys(hospitalId: string) {
  const root = ['oncology', hospitalId] as const;
  return {
    root,
    cases: (scope: string) => [...root, 'cases', scope] as const,
    casesRoot: () => [...root, 'cases'] as const,
    cycles: (scope: string) => [...root, 'cycles', scope] as const,
    cyclesRoot: () => [...root, 'cycles'] as const,
    cycle: (id: string) => [...root, 'cycle', id] as const,
  };
}

export type OncologyKeys = ReturnType<typeof oncologyKeys>;
