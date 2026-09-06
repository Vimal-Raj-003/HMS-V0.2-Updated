/** TanStack Query keys, tenant-scoped like every other feature's. */
export function specialtyKeys(hospitalId: string) {
  const root = ['specialty', hospitalId] as const;
  return {
    root,
    consoles: (scope: string) => [...root, 'consoles', scope] as const,
    consolesRoot: () => [...root, 'consoles'] as const,
    console: (code: string) => [...root, 'console', code] as const,
    worklist: (scope: string) => [...root, 'worklist', scope] as const,
    worklistRoot: () => [...root, 'worklist'] as const,
    orders: (scope: string) => [...root, 'orders', scope] as const,
    ordersRoot: () => [...root, 'orders'] as const,
    stages: (encounterId: string) => [...root, 'stages', encounterId] as const,
  };
}

export type SpecialtyKeys = ReturnType<typeof specialtyKeys>;
