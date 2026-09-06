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
  };
}

export type ErKeys = ReturnType<typeof erKeys>;
