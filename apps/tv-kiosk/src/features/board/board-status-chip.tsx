import type { ReactNode } from 'react';
import { formatAge, formatClockTime } from '../../lib/format';
import { ageMs, presentFreshness, type Freshness } from './staleness';
import type { BoardTransportKind, TransportStatus } from './transport';

export interface BoardStatusChipProps {
  readonly freshness: Freshness;
  readonly status: TransportStatus;
  readonly lastUpdatedAt: Date | null;
  readonly now: Date | null;
  readonly transportKind: BoardTransportKind;
}

/**
 * docs/06 §4.4: staleness chip, bottom-right, amber then red. It always states an
 * absolute time, because "a while ago" is useless to someone deciding whether to
 * walk to the consultation room.
 */
export function BoardStatusChip(props: BoardStatusChipProps): ReactNode {
  const { freshness, status, lastUpdatedAt, now, transportKind } = props;
  const tone = presentFreshness(freshness, status);
  const stamp = lastUpdatedAt === null ? 'never' : formatClockTime(lastUpdatedAt);
  const age = now === null ? null : formatAge(ageMs(lastUpdatedAt, now));

  return (
    <div
      className="flex items-center gap-3 rounded-full border border-strong bg-layer-2 px-5 py-3"
      data-testid="board-status-chip"
      data-freshness={freshness}
      data-transport={transportKind}
      role="status"
      aria-live="polite"
    >
      <span className={`inline-block size-3 rounded-full ${tone.dotClass}`} aria-hidden="true" />
      <span className={`text-tv-body font-semibold ${tone.toneClass}`}>{tone.label}</span>
      <span className="text-tv-body text-fg-muted">
        Last updated {stamp}
        {age === null || lastUpdatedAt === null ? '' : ` (${age} ago)`}
      </span>
      <span className="text-tv-body text-fg-subtle uppercase">
        {transportKind === 'socket' ? 'realtime' : 'polling'}
      </span>
    </div>
  );
}
