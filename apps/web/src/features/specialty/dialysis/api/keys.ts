/** Query keys for OP-012 and IP-022, tenant-scoped like every other feature's. */
export function dialysisKeys(hospitalId: string) {
  const root = ['dialysis', hospitalId] as const;
  return {
    root,
    board: () => [...root, 'board'] as const,
    machines: () => [...root, 'machines'] as const,
    sessions: (scope: string) => [...root, 'sessions', scope] as const,
    sessionsRoot: () => [...root, 'sessions'] as const,
    session: (id: string) => [...root, 'session', id] as const,
    programs: (scope: string) => [...root, 'programs', scope] as const,
    dialysers: (scope: string) => [...root, 'dialysers', scope] as const,
    dialysersRoot: () => [...root, 'dialysers'] as const,
  };
}

export type DialysisKeys = ReturnType<typeof dialysisKeys>;
