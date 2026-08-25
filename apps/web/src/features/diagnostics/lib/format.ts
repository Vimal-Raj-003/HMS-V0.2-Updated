/**
 * Formatting for the diagnostics screens.
 *
 * `docs/06` §10 forbids "2 hours ago" as a record's *only* timestamp: a
 * laboratory register, a dose record and a critical-value call-back are legal
 * documents, and a relative time in one of them is not a fact anybody can testify
 * to. So the absolute form is always available and the relative form is only ever
 * an addition to it.
 *
 * `en-IN` and the hospital's own zone are the eventual answer. This build has no
 * locale plumbing in `apps/web` yet — see the note in `screens.ts` — so the
 * format is fixed to `en-IN` rather than to whatever the operating system of a
 * shared ward tablet happens to be set to.
 */

const ABSOLUTE = new Intl.DateTimeFormat('en-IN', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const TIME_ONLY = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });

export function formatInstant(iso: string | null): string {
  if (iso === null || iso === '') return '—';
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return '—';
  return ABSOLUTE.format(new Date(parsed));
}

export function formatTime(iso: string | null): string {
  if (iso === null || iso === '') return '—';
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return '—';
  return TIME_ONLY.format(new Date(parsed));
}

/**
 * OP-004 §3.8 and §11 — the turnaround clock, as a traffic light.
 *
 * Amber at 80 % of the target, red on breach. The *target* is the server's
 * `tat_due_at`; nothing here invents one, because OP-004 §5 bullet 8 makes the
 * clock's start depend on the priority (STAT from order, routine from receipt)
 * and a client that guessed would show a different deadline from the one the SLA
 * report measures.
 *
 * `startedAt` is the clock start where the caller knows it. Without it the
 * amber band cannot be computed — 80 % of an unknown duration is unknown — so
 * the verdict degrades to "due at HH:MM" rather than inventing a colour.
 */
export type TatState = 'breached' | 'due_soon' | 'in_time' | 'untimed';

export interface TatVerdict {
  readonly state: TatState;
  readonly minutesRemaining: number | null;
  readonly label: string;
  readonly toneClass: string;
}

export function tatVerdict(dueAt: string | null, startedAt: string | null, now: Date): TatVerdict {
  if (dueAt === null || dueAt === '') {
    return { state: 'untimed', minutesRemaining: null, label: 'No target set', toneClass: 'text-fg-subtle' };
  }
  const due = Date.parse(dueAt);
  if (Number.isNaN(due)) {
    return { state: 'untimed', minutesRemaining: null, label: 'No target set', toneClass: 'text-fg-subtle' };
  }

  const minutes = Math.round((due - now.getTime()) / 60_000);
  if (minutes < 0) {
    return {
      state: 'breached',
      minutesRemaining: minutes,
      label: `Overdue by ${describeMinutes(-minutes)}`,
      toneClass: 'text-danger-fg',
    };
  }

  const start = startedAt === null ? Number.NaN : Date.parse(startedAt);
  if (Number.isFinite(start)) {
    const total = due - start;
    const elapsed = now.getTime() - start;
    if (total > 0 && elapsed / total >= 0.8) {
      return {
        state: 'due_soon',
        minutesRemaining: minutes,
        label: `Due in ${describeMinutes(minutes)} — past 80 % of target`,
        toneClass: 'text-warning-fg',
      };
    }
  }

  return {
    state: 'in_time',
    minutesRemaining: minutes,
    label: `Due in ${describeMinutes(minutes)}`,
    toneClass: 'text-fg-muted',
  };
}

export function describeMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
  const days = Math.floor(hours / 24);
  return `${days} d ${hours % 24} h`;
}

/**
 * A coded enum as a human phrase.
 *
 * `docs/06` §1.1 heuristic 2: never a database word in the UI. A status chip
 * reading `awaiting_release` is a column name wearing a badge.
 */
export function humanise(code: string | null): string {
  if (code === null || code === '') return '—';
  const words = code.replace(/[_-]+/gu, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Priority in the order a worklist sorts by: the loudest first. */
export const PRIORITY_RANK: Readonly<Record<string, number>> = {
  portable_stat: 0,
  stat: 1,
  urgent: 2,
  routine: 3,
};

export function priorityTone(priority: string): string {
  if (priority === 'stat' || priority === 'portable_stat') return 'text-danger-fg';
  if (priority === 'urgent') return 'text-warning-fg';
  return 'text-fg-muted';
}
