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
  };
}

export type IpKeys = ReturnType<typeof ipKeys>;
