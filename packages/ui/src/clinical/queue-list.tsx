'use client';

import {
  Accessibility,
  CalendarCheck,
  CircleUser,
  Clock,
  PauseCircle,
  PhoneCall,
  Siren,
  SkipForward,
  UserCheck,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cn } from '../lib/cn.js';
import { Button } from '../primitives/button.js';

/**
 * `TokenTile` / `QueueList` — EN-006 queue and EN-018 boards, docs/06 §5.2 #10.
 *
 * "Token (mono, large), patient masked label, visit type, wait time (turns amber > 30 m,
 *  red > 60 m), vitals chips, flags. Actions: call/skip/requeue with confirm on skip.
 *  `Space` = call next from the list."
 *
 * Two safety rules are in the types rather than the docs:
 *   - `QueueTokenState` is a discriminated union where the states that need a
 *     justification **carry one**: `on-hold` and `skipped` require a reason (docs/06
 *     §6.9 level 4 — "confirm + reason"), and `called` requires the room it was called
 *     to, because a token called to nowhere is what makes a patient miss their turn.
 *   - the patient label is a `maskedLabel` by default (docs/06 §1.2.8: "TV/board/kiosk
 *     surfaces default to token or masked labels; full names are an audited
 *     Hospital-Admin override"), so `fullName` is a separate, explicitly-passed prop.
 *
 * Colour never carries the state alone: every tile shows the state word and an icon
 * next to the `--q-*` colour (docs/06 §1.2.3).
 */

export type QueueTokenState =
  | { readonly kind: 'waiting'; readonly position: number }
  /** Called to a specific room. `secondsSinceCall` drives the ≤ 90 s audio rule (§5.2 #11). */
  | { readonly kind: 'called'; readonly room: string; readonly secondsSinceCall: number }
  | { readonly kind: 'in-progress'; readonly room: string }
  | { readonly kind: 'on-hold'; readonly reason: string }
  | { readonly kind: 'skipped'; readonly reason: string }
  | { readonly kind: 'completed' }
  | { readonly kind: 'no-show' };

export type QueuePriority =
  | 'emergency'
  | 'senior-citizen'
  | 'differently-abled'
  | 'appointment'
  | 'walk-in';

export interface QueueEntry {
  readonly tokenId: string;
  /** The printed token, e.g. `C-45`. Rendered in the display face, tabular. */
  readonly token: string;
  readonly state: QueueTokenState;
  readonly priority: QueuePriority;
  /** Privacy-safe label — initials + UHID tail, e.g. `RS ·8471 45/M`. */
  readonly maskedLabel: string;
  /** Only supplied behind an audited Hospital-Admin override (docs/06 §1.2.8). */
  readonly fullName?: string;
  /** Already-localised visit type ("Walk-in", "Appointment 10:30"). */
  readonly visitType: string;
  readonly doctor?: string;
  /** Minutes since check-in. */
  readonly waitedMinutes: number;
  /** Model estimate for the remaining wait, in minutes. */
  readonly estimatedWaitMinutes?: number;
  /** Already-localised chips (vitals done, interpreter needed, …). */
  readonly flags?: readonly string[];
}

export type WaitTone = 'normal' | 'warning' | 'critical';

/** docs/06 §5.2 #10 — "turns amber > 30 m, red > 60 m". */
export function waitTone(minutes: number): WaitTone {
  if (minutes > 60) return 'critical';
  if (minutes > 30) return 'warning';
  return 'normal';
}

const WAIT_CLASS: Readonly<Record<WaitTone, string>> = {
  normal: 'text-fg-muted',
  warning: 'text-warning-fg',
  critical: 'text-danger-fg',
};

const PRIORITY_ICON: Readonly<Record<QueuePriority, LucideIcon>> = {
  emergency: Siren,
  'senior-citizen': CircleUser,
  'differently-abled': Accessibility,
  appointment: CalendarCheck,
  'walk-in': UserCheck,
};

const STATE_CLASS: Readonly<Record<QueueTokenState['kind'], string>> = {
  waiting: 'text-q-waiting border-q-waiting',
  called: 'text-q-called border-q-called',
  'in-progress': 'text-q-in-progress border-q-in-progress',
  'on-hold': 'text-q-on-hold border-q-on-hold',
  skipped: 'text-q-skipped border-q-skipped',
  completed: 'text-q-completed border-q-completed',
  'no-show': 'text-q-no-show border-q-no-show line-through',
};

const STATE_ICON: Readonly<Record<QueueTokenState['kind'], LucideIcon>> = {
  waiting: Clock,
  called: PhoneCall,
  'in-progress': UserCheck,
  'on-hold': PauseCircle,
  skipped: SkipForward,
  completed: UserCheck,
  'no-show': Clock,
};

export interface QueueLabels {
  readonly state: Readonly<Record<QueueTokenState['kind'], string>>;
  readonly priority: Readonly<Record<QueuePriority, string>>;
  readonly positionPrefix: string;
  readonly roomPrefix: string;
  readonly reasonPrefix: string;
  readonly waited: (minutes: number) => string;
  readonly estimated: (minutes: number) => string;
  /** Full accessible sentence for one tile — value + state + wait, docs/06 §7. */
  readonly tokenSummary: (entry: QueueEntry) => string;
}

export interface TokenTileProps {
  readonly entry: QueueEntry;
  readonly labels: QueueLabels;
  /** `list` for the console row, `board` for the enlarged corridor/TV variant. */
  readonly variant?: 'list' | 'board';
  readonly selected?: boolean;
  readonly onSelect?: (entry: QueueEntry) => void;
  readonly tabIndex?: number;
  readonly className?: string;
}

export function TokenTile({
  entry,
  labels,
  variant = 'list',
  selected = false,
  onSelect,
  tabIndex,
  className,
}: TokenTileProps): React.JSX.Element {
  const StateIcon = STATE_ICON[entry.state.kind];
  const PriorityIcon = PRIORITY_ICON[entry.priority];
  const tone = waitTone(entry.waitedMinutes);
  const board = variant === 'board';

  const detail = ((): string | null => {
    switch (entry.state.kind) {
      case 'waiting':
        return `${labels.positionPrefix} ${String(entry.state.position)}`;
      case 'called':
      case 'in-progress':
        return `${labels.roomPrefix} ${entry.state.room}`;
      case 'on-hold':
      case 'skipped':
        return `${labels.reasonPrefix} ${entry.state.reason}`;
      case 'completed':
      case 'no-show':
        return null;
    }
  })();

  const body = (
    <>
      <span
        data-token=""
        className={cn(
          'font-display font-semibold tabular-nums',
          board ? 'text-5xl' : 'text-3xl',
          STATE_CLASS[entry.state.kind],
        )}
      >
        {entry.token}
      </span>
      <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
        <span className="flex flex-wrap items-center gap-1.5">
          <span
            data-queue-state={entry.state.kind}
            className={cn(
              'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-medium',
              STATE_CLASS[entry.state.kind],
              // §3.5 — the "called" token pulses at well under the 3 Hz photosensitivity
              // ceiling, and becomes a static ring under prefers-reduced-motion (§7).
              entry.state.kind === 'called' ? 'motion-safe:animate-pulse motion-reduce:ring-2' : '',
            )}
          >
            <StateIcon aria-hidden="true" className="size-3" />
            {labels.state[entry.state.kind]}
          </span>
          <span className="inline-flex items-center gap-1 rounded-full border border-default px-2 py-0.5 text-2xs text-fg-default">
            <PriorityIcon aria-hidden="true" className="size-3" />
            {labels.priority[entry.priority]}
          </span>
          {(entry.flags ?? []).map((flag) => (
            <span
              key={flag}
              className="rounded-full border border-default px-2 py-0.5 text-2xs text-fg-muted"
            >
              {flag}
            </span>
          ))}
        </span>
        <span className={cn('font-medium text-fg-default', board ? 'text-lg' : 'text-md')}>
          {entry.fullName ?? entry.maskedLabel}
        </span>
        <span className="flex flex-wrap items-center gap-x-3 text-xs text-fg-muted">
          <span>{entry.visitType}</span>
          {entry.doctor === undefined ? null : <span>{entry.doctor}</span>}
          {detail === null ? null : <span>{detail}</span>}
          <span className={WAIT_CLASS[tone]} data-wait-tone={tone}>
            <Clock aria-hidden="true" className="me-1 inline size-3" />
            {labels.waited(entry.waitedMinutes)}
          </span>
          {entry.estimatedWaitMinutes === undefined ? null : (
            <span>{labels.estimated(entry.estimatedWaitMinutes)}</span>
          )}
        </span>
      </span>
    </>
  );

  const shared = cn(
    'flex w-full items-center gap-3 rounded-lg border border-default bg-layer-1 p-3 text-start',
    // §6.3 — 52 px touch row on a coarse pointer; the tile is well past 44 px anyway.
    'min-h-13',
    selected ? 'border-accent-border bg-accent-surface' : '',
    className,
  );

  if (onSelect === undefined) {
    return (
      <div data-slot="token-tile" data-token-id={entry.tokenId} className={shared}>
        {body}
      </div>
    );
  }

  return (
    <button
      type="button"
      data-slot="token-tile"
      data-token-id={entry.tokenId}
      aria-label={labels.tokenSummary(entry)}
      aria-current={selected ? 'true' : undefined}
      tabIndex={tabIndex}
      onClick={() => {
        onSelect(entry);
      }}
      className={cn(
        shared,
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
      )}
    >
      {body}
    </button>
  );
}

export interface QueueListLabels extends QueueLabels {
  readonly listLabel: string;
  readonly callNext: string;
  readonly callSelected: string;
  readonly recall: string;
  readonly hold: string;
  readonly skip: string;
  readonly transfer: string;
  readonly nothingWaiting: string;
  readonly counts: (waiting: number, called: number) => string;
}

export interface QueueListProps {
  readonly entries: readonly QueueEntry[];
  readonly labels: QueueListLabels;
  /** `Space` anywhere in the list calls the first waiting token (docs/06 §5.2 #10). */
  readonly onCallNext?: () => void;
  readonly onCall?: (entry: QueueEntry) => void;
  readonly onRecall?: (entry: QueueEntry) => void;
  /** Named `…Requested` because holding needs a reason: the caller opens the dialog. */
  readonly onHoldRequested?: (entry: QueueEntry) => void;
  /** Skip is destructive to the patient's turn — always confirm + reason (§6.9). */
  readonly onSkipRequested?: (entry: QueueEntry) => void;
  readonly onTransferRequested?: (entry: QueueEntry) => void;
  readonly onOpen?: (entry: QueueEntry) => void;
  /** Rendered when there is nothing in the queue; must be specific (§5.2 #36). */
  readonly emptyState?: React.ReactNode;
  readonly className?: string;
}

export function QueueList({
  entries,
  labels,
  onCallNext,
  onCall,
  onRecall,
  onHoldRequested,
  onSkipRequested,
  onTransferRequested,
  onOpen,
  emptyState,
  className,
}: QueueListProps): React.JSX.Element {
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLUListElement | null>(null);

  useEffect(() => {
    if (activeIndex > entries.length - 1) setActiveIndex(entries.length === 0 ? 0 : entries.length - 1);
  }, [entries.length, activeIndex]);

  const selected = entries[activeIndex];
  const waiting = entries.filter((entry) => entry.state.kind === 'waiting').length;
  const called = entries.filter((entry) => entry.state.kind === 'called').length;

  const focusRow = (index: number): void => {
    setActiveIndex(index);
    const node = listRef.current?.querySelectorAll<HTMLButtonElement>('[data-slot="token-tile"]')[index];
    node?.focus();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLUListElement>): void => {
    if (entries.length === 0) return;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusRow(Math.min(activeIndex + 1, entries.length - 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusRow(Math.max(activeIndex - 1, 0));
        break;
      case 'Home':
        event.preventDefault();
        focusRow(0);
        break;
      case 'End':
        event.preventDefault();
        focusRow(entries.length - 1);
        break;
      case ' ':
        // §5.2 #10 — Space is "call next", not "activate the focused tile", so the
        // button's own Space activation is suppressed here.
        event.preventDefault();
        onCallNext?.();
        break;
      case 'Enter':
        if (selected !== undefined && onOpen !== undefined) {
          event.preventDefault();
          onOpen(selected);
        }
        break;
      default:
        break;
    }
  };

  return (
    <section data-slot="queue-list" className={cn('flex flex-col gap-2', className)}>
      <div className="flex flex-wrap items-center gap-2">
        {/* §1.1.1 — announced where it is shown, not duplicated into a hidden region. */}
        <span className="text-sm text-fg-muted" data-queue-counts="" aria-live="polite">
          {labels.counts(waiting, called)}
        </span>
        <div className="ms-auto flex flex-wrap items-center gap-2">
          {onCallNext === undefined ? null : (
            <Button variant="primary" size="sm" onClick={onCallNext}>
              <PhoneCall aria-hidden="true" />
              {labels.callNext}
            </Button>
          )}
          {onCall === undefined ? null : (
            <Button
              variant="secondary"
              size="sm"
              disabled={selected === undefined}
              onClick={() => {
                if (selected !== undefined) onCall(selected);
              }}
            >
              {labels.callSelected}
            </Button>
          )}
          {onRecall === undefined ? null : (
            <Button
              variant="secondary"
              size="sm"
              disabled={selected === undefined}
              onClick={() => {
                if (selected !== undefined) onRecall(selected);
              }}
            >
              {labels.recall}
            </Button>
          )}
          {onHoldRequested === undefined ? null : (
            <Button
              variant="secondary"
              size="sm"
              disabled={selected === undefined}
              onClick={() => {
                if (selected !== undefined) onHoldRequested(selected);
              }}
            >
              <PauseCircle aria-hidden="true" />
              {labels.hold}
            </Button>
          )}
          {onSkipRequested === undefined ? null : (
            <Button
              variant="danger"
              size="sm"
              disabled={selected === undefined}
              onClick={() => {
                if (selected !== undefined) onSkipRequested(selected);
              }}
            >
              <SkipForward aria-hidden="true" />
              {labels.skip}
            </Button>
          )}
          {onTransferRequested === undefined ? null : (
            <Button
              variant="secondary"
              size="sm"
              disabled={selected === undefined}
              onClick={() => {
                if (selected !== undefined) onTransferRequested(selected);
              }}
            >
              {labels.transfer}
            </Button>
          )}
        </div>
      </div>

      {entries.length === 0 ? (
        (emptyState ?? <p className="text-md text-fg-muted">{labels.nothingWaiting}</p>)
      ) : (
        <ul
          ref={listRef}
          aria-label={labels.listLabel}
          // §6.1 — "roving tabindex in grids and lists (one tab stop per grid)".
          onKeyDown={handleKeyDown}
          className="flex flex-col gap-2"
        >
          {entries.map((entry, index) => (
            <li key={entry.tokenId}>
              <TokenTile
                entry={entry}
                labels={labels}
                selected={index === activeIndex}
                tabIndex={index === activeIndex ? 0 : -1}
                onSelect={() => {
                  setActiveIndex(index);
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
