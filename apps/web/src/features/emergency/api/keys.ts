/**
 * TanStack Query cache keys for OP-006, scoped to the tenant.
 *
 * The board is refetched on an interval rather than cached long: a stale ER
 * board is worse than a blank one, because it looks authoritative.
 */
export function erKeys(hospitalId: string) {
  const root = ['vims', hospitalId, 'er'] as const;

  return {
    root,
    board: (status: string) => [...root, 'board', status] as const,
    boardRoot: () => [...root, 'board'] as const,
    visit: (id: string) => [...root, 'visit', id] as const,

    // ── TR-001 ───────────────────────────────────────────────────────────────
    traumaBoard: (scope: string) => [...root, 'trauma', 'board', scope] as const,
    traumaBoardRoot: () => [...root, 'trauma', 'board'] as const,
    triageHistory: (visitId: string) => [...root, 'trauma', 'triage', visitId] as const,
    survey: (visitId: string) => [...root, 'trauma', 'survey', visitId] as const,
    injuries: (visitId: string) => [...root, 'trauma', 'injuries', visitId] as const,
    scores: (visitId: string) => [...root, 'trauma', 'scores', visitId] as const,
    mci: () => [...root, 'trauma', 'mci'] as const,

    // ── TR-008 ───────────────────────────────────────────────────────────────
    mlcRegister: (scope: string) => [...root, 'mlc', 'register', scope] as const,
    mlcRegisterRoot: () => [...root, 'mlc', 'register'] as const,
    mlcCase: (id: string) => [...root, 'mlc', 'case', id] as const,
    mlcWorklist: (kind: string) => [...root, 'mlc', 'worklist', kind] as const,
    mlcGate: (erVisitId: string) => [...root, 'mlc', 'gate', erVisitId] as const,

    // ── NC-013 + TR-009 ──────────────────────────────────────────────────────
    dispatchBoard: (scope: string) => [...root, 'fleet', 'board', scope] as const,
    dispatchBoardRoot: () => [...root, 'fleet', 'board'] as const,
    fleetTrip: (id: string) => [...root, 'fleet', 'trip', id] as const,

    // TR-007
    polytraumaBoards: (scope: string) => [...root, 'polytrauma', 'boards', scope] as const,
    polytraumaBoardsRoot: () => [...root, 'polytrauma', 'boards'] as const,
    polytraumaBoard: (id: string) => [...root, 'polytrauma', 'board', id] as const,
    inbound: () => [...root, 'prehospital', 'inbound'] as const,
  };
}

export type ErKeys = ReturnType<typeof erKeys>;
