import type { CSSProperties, ReactNode } from 'react';
import type { BoardSnapshot } from './board-contract';
import { BoardClock } from './board-clock';
import { BoardStatusChip } from './board-status-chip';
import { NextInQueue } from './next-in-queue';
import { NowServingPanel } from './now-serving-panel';
import type { Freshness } from './staleness';
import type { BoardTransportKind, TransportStatus } from './transport';
import { burnInShift, burnInTransform } from '../../lib/burn-in';

export interface TokenBoardProps {
  readonly snapshot: BoardSnapshot;
  readonly freshness: Freshness;
  readonly status: TransportStatus;
  readonly lastUpdatedAt: Date | null;
  readonly now: Date | null;
  readonly transportKind: BoardTransportKind;
  /**
   * The current announcement, rendered between the not-live banner and the
   * grid. Passed in rather than rendered here because the announcement is
   * device state (what this screen's speaker is saying) and the board is
   * snapshot state (what the queue is doing) — keeping the two apart is what
   * lets the whole board be rendered in a test with no speech engine.
   */
  readonly announcement?: ReactNode;
}

/**
 * The 1080p OPD token board of docs/06 §3.5 sketch F: identity strip, hero token,
 * next list, summary, ticker, staleness chip. Everything is sized from the `tv-*`
 * type tokens, so a 4K board scales by swapping the token map rather than by
 * adding content (docs/06 §4.4).
 */
export function TokenBoard(props: TokenBoardProps): ReactNode {
  const { snapshot, freshness, status, lastUpdatedAt, now, transportKind, announcement } = props;
  const shift = burnInShift(now ?? new Date(0));
  const safeAreaStyle: CSSProperties = { transform: burnInTransform(shift) };
  const notLive = freshness === 'expired';

  return (
    <main
      className="bg-canvas text-fg-default h-dvh w-dvw overflow-hidden"
      data-testid="token-board"
      data-board-id={snapshot.boardId}
    >
      <div className="board-safe-area flex h-full flex-col gap-6 p-6" style={safeAreaStyle}>
        <header className="flex items-start justify-between gap-6">
          <div>
            <h1 className="font-display text-5xl font-semibold tracking-[-0.01em]">
              {snapshot.hospitalName}
            </h1>
            <p className="text-tv-body text-fg-muted">{snapshot.locationLabel}</p>
          </div>
          <BoardClock now={now} />
        </header>

        {notLive ? (
          <p
            className="border-danger-border bg-danger-surface text-danger-fg text-tv-body rounded-xl border px-6 py-4 font-semibold"
            role="alert"
            data-testid="not-live-banner"
          >
            This board is not receiving updates. Please check with the reception desk before acting on the
            tokens below.
          </p>
        ) : null}

        {announcement}

        <div className="grid min-h-0 flex-1 grid-cols-3 gap-6">
          <div className="col-span-2 min-h-0">
            <NowServingPanel entries={snapshot.nowServing} freshness={freshness} />
          </div>
          <div className="min-h-0">
            <NextInQueue entries={snapshot.nextTokens} freshness={freshness} />
          </div>
        </div>

        <footer className="flex items-center justify-between gap-6">
          <dl className="text-tv-body flex items-center gap-8">
            <div className="flex items-baseline gap-3">
              <dt className="text-fg-muted">Waiting</dt>
              <dd className="font-display text-fg-default text-4xl font-semibold tabular-nums">
                {snapshot.summary.waiting}
              </dd>
            </div>
            {snapshot.summary.averageWaitMinutes === null ? null : (
              <div className="flex items-baseline gap-3">
                <dt className="text-fg-muted">Average wait</dt>
                <dd className="font-display text-fg-default text-4xl font-semibold tabular-nums">
                  {snapshot.summary.averageWaitMinutes} min
                </dd>
              </div>
            )}
            {snapshot.summary.notice === null ? null : (
              <div className="flex items-baseline gap-3">
                <dt className="text-fg-muted">Notice</dt>
                <dd className="text-warning-fg">{snapshot.summary.notice}</dd>
              </div>
            )}
          </dl>
          <BoardStatusChip
            freshness={freshness}
            status={status}
            lastUpdatedAt={lastUpdatedAt}
            now={now}
            transportKind={transportKind}
          />
        </footer>

        {snapshot.ticker.length > 0 ? (
          <div className="overflow-hidden rounded-xl border border-default bg-layer-2 px-6 py-3">
            <p className="board-ticker text-tv-body text-fg-muted whitespace-nowrap">
              {snapshot.ticker.join('   •   ')}
            </p>
          </div>
        ) : null}
      </div>
    </main>
  );
}
