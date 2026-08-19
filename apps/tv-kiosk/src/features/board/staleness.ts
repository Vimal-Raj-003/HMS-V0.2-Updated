import type { TransportStatus } from './transport';

/**
 * EN-018 §3.6 and docs/06 §4.4. The central judgement of this app: a board
 * showing yesterday's token as though it were current sends a patient to an empty
 * room, so freshness is a first-class rendered state, not a debug detail.
 *
 *  - `live`     data arrived recently and the transport is healthy.
 *  - `stale`    amber chip, "reconnecting — last updated HH:mm:ss". Content is
 *               still trustworthy enough to act on.
 *  - `expired`  red chip, tokens dimmed and relabelled "last called — not live",
 *               so nobody reads them as a current call.
 */
export type Freshness = 'live' | 'stale' | 'expired';

export interface FreshnessThresholds {
  readonly staleAfterMs: number;
  readonly expiredAfterMs: number;
}

export interface FreshnessInput {
  readonly lastUpdatedAt: Date | null;
  readonly now: Date;
  readonly status: TransportStatus;
  readonly thresholds: FreshnessThresholds;
}

export function ageMs(lastUpdatedAt: Date | null, now: Date): number {
  if (lastUpdatedAt === null) return Number.POSITIVE_INFINITY;
  return Math.max(0, now.getTime() - lastUpdatedAt.getTime());
}

export function freshnessOf(input: FreshnessInput): Freshness {
  // No data at all, or a revoked token, is the worst case — never dress it up.
  if (input.lastUpdatedAt === null) return 'expired';
  if (input.status === 'unauthorized') return 'expired';

  const age = ageMs(input.lastUpdatedAt, input.now);
  if (age >= input.thresholds.expiredAfterMs) return 'expired';
  if (age >= input.thresholds.staleAfterMs) return 'stale';
  // Fresh bytes but a transport that is retrying still means "do not fully
  // trust this": the next call may already have happened without us.
  if (input.status !== 'live') return 'stale';
  return 'live';
}

export interface FreshnessPresentation {
  readonly label: string;
  readonly toneClass: string;
  readonly dotClass: string;
  /** True when the token numerals must be visibly demoted. */
  readonly demoteTokens: boolean;
}

export function presentFreshness(freshness: Freshness, status: TransportStatus): FreshnessPresentation {
  if (freshness === 'live') {
    return {
      label: 'Live',
      toneClass: 'text-success-fg',
      dotClass: 'bg-success-solid',
      demoteTokens: false,
    };
  }
  if (freshness === 'stale') {
    return {
      label: status === 'unauthorized' ? 'Not authorised' : 'Reconnecting',
      toneClass: 'text-warning-fg',
      dotClass: 'bg-warning-solid',
      demoteTokens: false,
    };
  }
  return {
    label: status === 'unauthorized' ? 'Not authorised' : 'Not live',
    toneClass: 'text-danger-fg',
    dotClass: 'bg-danger-solid',
    demoteTokens: true,
  };
}
