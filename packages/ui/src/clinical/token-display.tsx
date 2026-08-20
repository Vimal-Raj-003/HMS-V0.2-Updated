'use client';

import { CircleAlert, Wifi, WifiOff } from 'lucide-react';
import { cn } from '../lib/cn.js';

/**
 * `TokenDisplay` — docs/06 §5.2 #11 and §9.F, the corridor/TV "NOW SERVING" widget.
 *
 * "TV widget: `--fs-tv-token`, flip transition ≤ 400 ms, room + doctor, holds enlarged
 *  for the full TTS duration; **suppresses audio for calls older than 90 s**."
 *
 * The 90 s rule is a real safety behaviour, not decoration: a board that reconnects
 * after an outage must not re-announce a queue of stale calls into a full waiting room.
 * `shouldAnnounce` is exported so the TTS scheduler in `apps/tv-kiosk` and this widget
 * can never disagree about it.
 *
 * Privacy (§1.2.8): this component takes a `maskedLabel`, never a name. There is no
 * prop for a full name — a corridor board is a public surface.
 */

/** §5.2 #11 — audio is suppressed once a call is older than 90 seconds. */
export const ANNOUNCEMENT_MAX_AGE_SECONDS = 90;

export function shouldAnnounce(secondsSinceCall: number): boolean {
  return secondsSinceCall >= 0 && secondsSinceCall <= ANNOUNCEMENT_MAX_AGE_SECONDS;
}

export interface NowServing {
  readonly token: string;
  readonly room: string;
  readonly doctor?: string;
  readonly department?: string;
  readonly secondsSinceCall: number;
  /** Optional masked label; boards default to showing no patient label at all. */
  readonly maskedLabel?: string;
}

export type BoardFreshness =
  | { readonly kind: 'live' }
  /** Socket lost; data is still shown but dated (§4.4 staleness chip). */
  | { readonly kind: 'stale'; readonly lastUpdated: string }
  /** Past `stale_threshold` — the token data is dimmed and marked (§4.4). */
  | { readonly kind: 'expired'; readonly lastUpdated: string };

export interface TokenDisplayLabels {
  readonly region: string;
  readonly nowServing: string;
  readonly next: string;
  readonly roomPrefix: string;
  readonly waiting: (count: number) => string;
  readonly averageWait: (minutes: number) => string;
  readonly idle: string;
  readonly live: string;
  readonly stale: (lastUpdated: string) => string;
  readonly expired: (lastUpdated: string) => string;
  /** Announced text for the current call, already assembled per §8 TTS templates. */
  readonly announcement: (token: string, room: string) => string;
}

export interface TokenDisplayProps {
  readonly nowServing: NowServing | null;
  /** §4.4 — a list widget shows at most 7 rows at 1080p. */
  readonly next: readonly { readonly token: string; readonly room: string }[];
  readonly labels: TokenDisplayLabels;
  readonly waitingCount: number;
  readonly averageWaitMinutes?: number;
  readonly freshness: BoardFreshness;
  readonly className?: string;
}

const MAX_NEXT_ROWS = 7;

export function TokenDisplay({
  nowServing,
  next,
  labels,
  waitingCount,
  averageWaitMinutes,
  freshness,
  className,
}: TokenDisplayProps): React.JSX.Element {
  const expired = freshness.kind === 'expired';
  const announce = nowServing !== null && shouldAnnounce(nowServing.secondsSinceCall) && !expired;

  return (
    <section
      data-slot="token-display"
      data-freshness={freshness.kind}
      data-announce={announce ? 'true' : 'false'}
      role="region"
      aria-label={labels.region}
      className={cn('flex w-full flex-col gap-6 bg-canvas p-6 text-fg-default', className)}
    >
      <div className="flex flex-wrap items-stretch gap-6">
        <div
          className={cn(
            'flex min-w-0 flex-[3] flex-col items-center justify-center gap-2 rounded-2xl',
            'border border-default bg-layer-2 p-6',
            // §4.4 — dimmed token data once the board is past its stale threshold.
            expired ? 'opacity-60' : '',
          )}
        >
          <span className="text-tv-body font-display uppercase tracking-[0.08em] text-fg-muted">
            {labels.nowServing}
          </span>
          {nowServing === null ? (
            <span className="text-tv-body text-fg-muted">{labels.idle}</span>
          ) : (
            <>
              <span
                data-now-serving-token=""
                key={nowServing.token}
                className={cn(
                  'font-display font-semibold tabular-nums text-tv-token leading-none',
                  // §4.4 — the flip is a cross-fade at or under --dur-tv (400 ms), and
                  // `motion-safe` drops it entirely under prefers-reduced-motion (§7).
                  'motion-safe:animate-in motion-safe:fade-in motion-safe:duration-tv',
                )}
              >
                {nowServing.token}
              </span>
              <span className="text-tv-body">
                {labels.roomPrefix} {nowServing.room}
              </span>
              {nowServing.doctor === undefined ? null : (
                <span className="text-tv-body text-fg-muted">
                  {nowServing.doctor}
                  {nowServing.department === undefined ? '' : ` · ${nowServing.department}`}
                </span>
              )}
              {nowServing.maskedLabel === undefined ? null : (
                <span className="text-tv-body text-fg-muted">{nowServing.maskedLabel}</span>
              )}
            </>
          )}
        </div>

        <ul
          aria-label={labels.next}
          className="flex min-w-64 flex-1 flex-col gap-2 rounded-2xl border border-default bg-layer-2 p-4"
        >
          <li className="text-tv-body font-display uppercase tracking-[0.08em] text-fg-muted">
            {labels.next}
          </li>
          {next.slice(0, MAX_NEXT_ROWS).map((item) => (
            <li key={item.token} className="flex items-baseline justify-between gap-4 text-tv-body">
              <span className="font-display font-semibold tabular-nums">{item.token}</span>
              <span className="text-fg-muted">
                {labels.roomPrefix} {item.room}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-wrap items-center gap-6 text-tv-body text-fg-muted">
        <span>{labels.waiting(waitingCount)}</span>
        {averageWaitMinutes === undefined ? null : <span>{labels.averageWait(averageWaitMinutes)}</span>}
        <span
          data-staleness={freshness.kind}
          className={cn(
            'ms-auto inline-flex items-center gap-2 rounded-full border px-3 py-1',
            freshness.kind === 'live'
              ? 'border-success-border text-success-fg'
              : freshness.kind === 'stale'
                ? 'border-warning-border text-warning-fg'
                : 'border-danger-border text-danger-fg',
          )}
        >
          {freshness.kind === 'live' ? (
            <Wifi aria-hidden="true" className="size-5" />
          ) : freshness.kind === 'stale' ? (
            <WifiOff aria-hidden="true" className="size-5" />
          ) : (
            <CircleAlert aria-hidden="true" className="size-5" />
          )}
          {freshness.kind === 'live'
            ? labels.live
            : freshness.kind === 'stale'
              ? labels.stale(freshness.lastUpdated)
              : labels.expired(freshness.lastUpdated)}
        </span>
      </div>

      {/*
        §7 "Hearing": every TTS announcement is simultaneously visual. The live region
        carries exactly the sentence the speaker says, and goes quiet the moment the
        call ages past 90 s so a reconnecting board does not shout old tokens.
      */}
      <span aria-live="polite" className="sr-only">
        {announce && nowServing !== null ? labels.announcement(nowServing.token, nowServing.room) : ''}
      </span>
    </section>
  );
}
