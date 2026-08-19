import type { ReactNode } from 'react';
import { formatBoardDate, formatClockTime } from '../../lib/format';

/**
 * A visible clock is not decoration on an unattended screen: it is the fastest
 * proof to a person standing in front of the board that the display itself is
 * alive, independently of whether the data behind it is (EN-018 §3.6).
 */
export function BoardClock({ now }: { readonly now: Date | null }): ReactNode {
  return (
    <div className="text-right" aria-live="off">
      <div
        className="font-display text-6xl leading-none font-semibold tabular-nums"
        data-testid="board-clock"
      >
        {now === null ? '--:--:--' : formatClockTime(now)}
      </div>
      <div className="text-tv-body text-fg-muted">{now === null ? ' ' : formatBoardDate(now)}</div>
    </div>
  );
}
