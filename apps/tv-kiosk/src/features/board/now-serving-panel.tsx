import type { ReactNode } from 'react';
import { QUEUE_STATE_LABEL, QUEUE_STATE_TEXT_CLASS, type NowServing } from './board-contract';
import type { Freshness } from './staleness';

export interface NowServingPanelProps {
  readonly entries: readonly NowServing[];
  readonly freshness: Freshness;
}

/**
 * docs/06 §3.5 sketch F. One hero token at `--fs-tv-token` (180 px, mono, legible
 * at 8 m) plus any other rooms calling at the same moment.
 *
 * The heading is the safety mechanism. While the feed is live it reads NOW
 * SERVING; the moment the data is too old to act on it becomes LAST CALLED — NOT
 * LIVE and the numerals are dimmed, because a patient walking to Room 3 on the
 * strength of a frozen board is the actual failure this module has to prevent.
 */
export function NowServingPanel(props: NowServingPanelProps): ReactNode {
  const { entries, freshness } = props;
  const notLive = freshness === 'expired';
  const [hero, ...others] = entries;

  return (
    <section
      className="flex h-full flex-col gap-6 rounded-2xl border border-strong bg-layer-1 p-8"
      data-testid="now-serving"
      data-freshness={freshness}
      aria-disabled={notLive}
      aria-live="polite"
    >
      <h2 className="text-tv-body font-display font-semibold tracking-[0.08em] uppercase">
        {notLive ? (
          <span className="text-danger-fg">Last called — not live</span>
        ) : (
          <span className="text-fg-muted">Now serving</span>
        )}
      </h2>

      {hero === undefined ? (
        <p className="text-tv-body text-fg-muted my-auto text-center">No tokens called yet today</p>
      ) : (
        <div className={notLive ? 'opacity-40' : undefined}>
          <div className="flex items-end justify-between gap-8">
            <div>
              <div
                key={hero.tokenDisplay}
                className={`token-flip font-display text-tv-token font-semibold tabular-nums ${QUEUE_STATE_TEXT_CLASS[hero.status]}`}
                data-testid="now-serving-token"
              >
                {hero.tokenDisplay}
              </div>
              <div className="text-tv-body text-fg-subtle">{QUEUE_STATE_LABEL[hero.status]}</div>
            </div>
            <div className="pb-6 text-right">
              <div className="font-display text-display-1 leading-none font-semibold">{hero.roomLabel}</div>
              <div className="text-tv-body text-fg-default mt-2">{hero.doctorName}</div>
              <div className="text-tv-body text-fg-muted">{hero.doctorSpeciality}</div>
              {hero.counterLabel.length > 0 ? (
                <div className="text-tv-body text-fg-muted">{hero.counterLabel}</div>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {others.length > 0 ? (
        <ul className={`mt-auto grid grid-cols-3 gap-4 ${notLive ? 'opacity-40' : ''}`}>
          {others.map((entry) => (
            <li
              key={entry.id}
              className="rounded-xl border border-default bg-layer-2 p-4"
              data-testid="now-serving-secondary"
            >
              <div
                className={`font-display text-5xl font-semibold tabular-nums ${QUEUE_STATE_TEXT_CLASS[entry.status]}`}
              >
                {entry.tokenDisplay}
              </div>
              <div className="text-tv-body text-fg-muted">{entry.roomLabel}</div>
              <div className="text-tv-body text-fg-subtle">{entry.doctorName}</div>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
