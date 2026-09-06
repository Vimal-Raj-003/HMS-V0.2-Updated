/**
 * TanStack Query cache keys for Phase 7, scoped to the tenant.
 */
export function ipKeys(hospitalId: string) {
  const root = ['vims', hospitalId, 'ip'] as const;

  return {
    root,
    board: (scope: string) => [...root, 'board', scope] as const,
    boardRoot: () => [...root, 'board'] as const,
    census: () => [...root, 'census'] as const,
    admissions: (scope: string) => [...root, 'admissions', scope] as const,
    admissionsRoot: () => [...root, 'admissions'] as const,
    admission: (id: string) => [...root, 'admission', id] as const,
    cleaning: (scope: string) => [...root, 'cleaning', scope] as const,
    cleaningRoot: () => [...root, 'cleaning'] as const,

    // Phase 7B
    ward: (scope: string) => [...root, 'ward', scope] as const,
    wardRoot: () => [...root, 'ward'] as const,
    mar: (scope: string) => [...root, 'mar', scope] as const,
    marRoot: () => [...root, 'mar'] as const,
    escalations: (scope: string) => [...root, 'escalations', scope] as const,
    escalationsRoot: () => [...root, 'escalations'] as const,

    // Phase 7C
    runningBill: (admissionId: string) => [...root, 'bill', admissionId] as const,
    billRoot: () => [...root, 'bill'] as const,
    chargeRuns: () => [...root, 'charge-runs'] as const,
    clearance: (admissionId: string) => [...root, 'clearance', admissionId] as const,

    // Phase 7D
    otBoard: (scope: string) => [...root, 'ot', 'board', scope] as const,
    otBoardRoot: () => [...root, 'ot', 'board'] as const,
    otCase: (id: string) => [...root, 'ot', 'case', id] as const,
    cssdLoads: (scope: string) => [...root, 'cssd', 'loads', scope] as const,
    cssdLoadsRoot: () => [...root, 'cssd', 'loads'] as const,

    // Phase 7E + 7F
    codes: (scope: string) => [...root, 'codes', scope] as const,
    codesRoot: () => [...root, 'codes'] as const,
    code: (id: string) => [...root, 'code', id] as const,
    bloodInventory: (scope: string) => [...root, 'blood', 'inventory', scope] as const,
    bloodInventoryRoot: () => [...root, 'blood', 'inventory'] as const,
  };
}

export type IpKeys = ReturnType<typeof ipKeys>;
