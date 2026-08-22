/**
 * TanStack Query cache keys, scoped to the tenant (`CLAUDE.md` §2).
 *
 * The `hospitalId` prefix is the same non-negotiable as in the admin console: a
 * group administrator switches hospitals inside one browser tab, and without the
 * prefix hospital B's queue would be served from hospital A's cache entry — the
 * wrong tenant's patients on a counter screen, with no request made and nothing
 * to notice. Prefixing makes the switch a cache miss, which is correct.
 *
 * The queue keys additionally carry the **date**. A queue resets daily (EN-006
 * §3.7), so yesterday's token list must never be served for today; making the
 * date part of the key is what turns the reset into a cache miss rather than a
 * stale board.
 */
export function frontOfficeKeys(hospitalId: string) {
  const root = ['vims', hospitalId, 'frontoffice'] as const;
  return {
    root,
    slots: (doctorKey: string, date: string) => [...root, 'slots', doctorKey, date] as const,
    exceptions: (doctorKey: string) => [...root, 'schedule-exceptions', doctorKey] as const,
    appointments: (doctorKey: string, date: string) => [...root, 'appointments', doctorKey, date] as const,
    book: () => [...root, 'slots'] as const,
    bookAppointments: () => [...root, 'appointments'] as const,

    queueTokens: (queueId: string, date: string) => [...root, 'queue', 'tokens', queueId, date] as const,
    queueBoard: (queueId: string) => [...root, 'queue', 'board', queueId] as const,
    queue: () => [...root, 'queue'] as const,

    shifts: (status: string) => [...root, 'cash', 'shifts', status] as const,
    shift: (shiftId: string) => [...root, 'cash', 'shift', shiftId] as const,
    closePreview: (shiftId: string) => [...root, 'cash', 'close-preview', shiftId] as const,
    cash: () => [...root, 'cash'] as const,
  };
}

export type FrontOfficeKeys = ReturnType<typeof frontOfficeKeys>;
