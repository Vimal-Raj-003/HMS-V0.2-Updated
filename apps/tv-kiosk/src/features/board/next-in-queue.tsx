import type { ReactNode } from 'react';
import { QUEUE_STATE_TEXT_CLASS, type NextToken } from './board-contract';
import type { Freshness } from './staleness';

export interface NextInQueueProps {
  readonly entries: readonly NextToken[];
  readonly freshness: Freshness;
}

/** docs/06 §4.4: at most seven rows, nothing below 28 px, no thin weights. */
export function NextInQueue(props: NextInQueueProps): ReactNode {
  const { entries, freshness } = props;
  const notLive = freshness === 'expired';
  const rows = entries.slice(0, 7);

  return (
    <section
      className="flex h-full flex-col gap-4 rounded-2xl border border-strong bg-layer-1 p-8"
      data-testid="next-in-queue"
      aria-disabled={notLive}
    >
      <h2 className="text-tv-body font-display text-fg-muted font-semibold tracking-[0.08em] uppercase">
        Next
      </h2>
      {rows.length === 0 ? (
        <p className="text-tv-body text-fg-muted">Queue is clear</p>
      ) : (
        <ol className={`flex flex-col gap-3 ${notLive ? 'opacity-40' : ''}`}>
          {rows.map((entry) => (
            <li
              key={entry.id}
              className="flex items-baseline justify-between gap-4 border-b border-default pb-3 last:border-b-0"
              data-testid="next-token-row"
            >
              <span
                className={`font-display text-5xl font-semibold tabular-nums ${QUEUE_STATE_TEXT_CLASS[entry.status]}`}
              >
                {entry.tokenDisplay}
              </span>
              <span className="text-tv-body text-fg-muted">{entry.roomLabel}</span>
              <span className="text-tv-body text-fg-subtle tabular-nums">
                {entry.etaMinutes === null ? '' : `~${String(entry.etaMinutes)} min`}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
