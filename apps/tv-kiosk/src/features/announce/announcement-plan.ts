import {
  isAnnounceable,
  type BoardAudio,
  type BoardSnapshot,
  type NowServing,
} from '../board/board-contract';
import type { Freshness } from '../board/staleness';
import {
  buildAnnouncement,
  destinationOf,
  resolveAnnouncementLocales,
  type Utterance,
} from './announcement-script';

/**
 * EN-018 §5: "Token announcements are suppressed if the token was called more
 * than `announce_ttl` (default 90 s) ago."
 *
 * The scenario this number is for: a board loses its network at 14:02, the
 * queue moves on, the board reconnects at 14:31 and receives a snapshot. Without
 * this rule it would cheerfully call out four tokens that were served half an
 * hour ago, into a waiting room where the people they belong to have gone home.
 * EN-018 §14 AC-4 states it as an acceptance criterion.
 */
export const ANNOUNCE_TTL_MS = 90_000;

export interface PlannedCall {
  /**
   * Identifies *this call of this token*. A recall carries a new `calledAt`, so
   * it announces again; a snapshot repeated every three seconds by the polling
   * transport carries the same one, so it does not.
   */
  readonly key: string;
  readonly tokenDisplay: string;
  readonly destination: string;
  readonly utterances: readonly Utterance[];
  readonly repeatCount: number;
}

export interface AnnouncePlanInput {
  readonly snapshot: BoardSnapshot;
  readonly freshness: Freshness;
  readonly now: Date;
  /** Call keys already spoken (or in progress) on this device. */
  readonly announced: ReadonlySet<string>;
  readonly ttlMs?: number;
  /**
   * Board configuration when the snapshot does not carry any. A device can be
   * commissioned with its language before the API ships `tts_languages`.
   */
  readonly fallbackAudio?: BoardAudio;
}

export function callKey(entry: NowServing): string {
  return `${entry.id}::${entry.status}::${entry.calledAt}`;
}

/**
 * Decides what, if anything, the board should say right now.
 *
 * Pure on purpose. Everything that makes an announcement wrong — stale data, a
 * repeat of a snapshot, a token that was cancelled rather than called, a board
 * that is not allowed to make noise — is a condition on plain values, so it can
 * be stated as a test rather than as a comment about a `useEffect`.
 */
export function planAnnouncements(input: AnnouncePlanInput): readonly PlannedCall[] {
  const audio = input.snapshot.audio ?? input.fallbackAudio;
  if (audio === undefined || !audio.enabled) return [];

  // A board that is not receiving updates must not speak. It is already showing
  // its tokens dimmed and labelled "not live" (EN-018 §3.6); saying them out
  // loud would undo that in the one channel a patient cannot see the caveat in.
  if (input.freshness === 'expired') return [];

  const locales = resolveAnnouncementLocales(audio.locales);
  const ttlMs = input.ttlMs ?? ANNOUNCE_TTL_MS;
  const plan: PlannedCall[] = [];

  for (const entry of input.snapshot.nowServing) {
    if (!isAnnounceable(entry.status)) continue;

    const key = callKey(entry);
    if (input.announced.has(key)) continue;

    const calledAt = Date.parse(entry.calledAt);
    // An unparseable timestamp is not evidence of freshness, so it is treated as
    // stale: the board stays quiet rather than guessing.
    if (!Number.isFinite(calledAt)) continue;
    const age = input.now.getTime() - calledAt;
    if (age > ttlMs) continue;
    // A call timestamped in the future by more than a small clock skew is a
    // misconfigured device, not a call.
    if (age < -ttlMs) continue;

    const destination = destinationOf(entry);
    if (destination.length === 0) continue;

    const utterances = buildAnnouncement({
      tokenDisplay: entry.tokenDisplay,
      destination,
      locales,
    });
    if (utterances.length === 0) continue;

    plan.push({
      key,
      tokenDisplay: entry.tokenDisplay,
      destination,
      utterances,
      repeatCount: audio.repeatCount,
    });
  }

  return plan;
}
