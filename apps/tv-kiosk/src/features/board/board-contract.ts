import { z } from 'zod';

/**
 * The queue-token lifecycle of EN-006 §4.1, in full.
 *
 * Every state the API can send is listed, including the ones a board never
 * *calls* — `cancelled`, `expired`, `transferred`, `no_show`. They are here
 * because the alternative is worse: an unlisted state fails the snapshot schema
 * and the whole board goes blank, and a board that shows nothing is not safer
 * than one that shows a cancelled token, it is just as wrong and harder to
 * diagnose. `.catch('waiting')` covers a state a future phase adds.
 *
 * The lifecycle events behind these — `queue.token.held`, `.resumed`,
 * `.activated`, `.cancelled`, `.no_show`, `.expired` — are registered in
 * `packages/contracts`, and the board's job is to make each one visible without
 * ever announcing one that is not a live call.
 */
export const QueueTokenStatusSchema = z
  .enum([
    /** Issued but not yet callable — usually waiting on payment. */
    'issued',
    'awaiting_payment',
    'waiting',
    'called',
    'recalled',
    'in_service',
    'held',
    'skipped',
    'no_show',
    'served',
    'transferred',
    'cancelled',
    'expired',
  ])
  .catch('waiting');
export type QueueTokenStatus = z.infer<typeof QueueTokenStatusSchema>;

/**
 * The only two states that mean "this patient is being called right now".
 *
 * Announcing anything else is a patient walking to an empty room: a `held`
 * token is paused, an `expired` one was closed by the daily reset, and a
 * `cancelled` one was superseded by a re-issue. EN-006 §5 re-issues a token by
 * cancelling the previous one, so `cancelled` in particular is a state a board
 * will genuinely see and must never call out.
 */
export const ANNOUNCEABLE_STATUSES: readonly QueueTokenStatus[] = ['called', 'recalled'];

export function isAnnounceable(status: QueueTokenStatus): boolean {
  return ANNOUNCEABLE_STATUSES.includes(status);
}

/** States in which the token's journey is over. Never a live call. */
const CLOSED_STATUSES: readonly QueueTokenStatus[] = [
  'served',
  'skipped',
  'no_show',
  'transferred',
  'cancelled',
  'expired',
];

export function isClosed(status: QueueTokenStatus): boolean {
  return CLOSED_STATUSES.includes(status);
}

/**
 * EN-018 §5 privacy: a public-area board carries the token, the room and the
 * clinician — never the patient. There is deliberately no patient field in this
 * schema, and Zod strips unknown keys, so an API that starts sending a name
 * cannot leak it onto a corridor screen: the field is dropped at the boundary
 * rather than merely left unrendered by every component that must remember to.
 */
export const NowServingSchema = z.object({
  id: z.string().min(1),
  tokenDisplay: z.string().min(1),
  status: QueueTokenStatusSchema,
  roomLabel: z.string(),
  counterLabel: z.string(),
  doctorName: z.string(),
  doctorSpeciality: z.string(),
  calledAt: z.string(),
});
export type NowServing = z.infer<typeof NowServingSchema>;

export const NextTokenSchema = z.object({
  id: z.string().min(1),
  tokenDisplay: z.string().min(1),
  status: QueueTokenStatusSchema,
  roomLabel: z.string(),
  etaMinutes: z.number().int().nonnegative().nullable(),
});
export type NextToken = z.infer<typeof NextTokenSchema>;

export const BoardSummarySchema = z.object({
  waiting: z.number().int().nonnegative(),
  averageWaitMinutes: z.number().int().nonnegative().nullable(),
  notice: z.string().nullable(),
});

/**
 * EN-018 §4 `display_boards.audio_enabled` / `tts_languages` / `volume_schedule`,
 * as much of it as a board needs to speak.
 *
 * Optional, and silent when absent. A board that has not been told it may make
 * noise must not make noise — a ward corridor at 02:00 is the case that decides
 * this, not the OPD lobby at 10:00.
 */
export const BoardAudioSchema = z.object({
  enabled: z.boolean(),
  /**
   * Ordered. EN-018 §3.4: "max 2–3 languages per call to keep it short", and the
   * hospital's own order — English first in most of India, the regional language
   * first in some. Locale codes are validated against `@vims/i18n` when the
   * script is built, not here, so an unknown code degrades to English rather
   * than blanking the board.
   */
  locales: z.array(z.string().min(2)).min(1).max(3),
  /** EN-018 §3.4.3: 1 by default, 2 for a large hall. */
  repeatCount: z.number().int().min(1).max(3).default(1),
});
export type BoardAudio = z.infer<typeof BoardAudioSchema>;

export const BoardSnapshotSchema = z.object({
  boardId: z.string().min(1),
  /** Monotonic per board; an out-of-order patch is dropped rather than rendered. */
  version: z.number().int().nonnegative(),
  generatedAt: z.string().min(1),
  hospitalName: z.string(),
  locationLabel: z.string(),
  /** docs/06 §4.4: max 7 rows per list widget at 10-foot reading distance. */
  nowServing: z.array(NowServingSchema).max(4),
  nextTokens: z.array(NextTokenSchema).max(7),
  summary: BoardSummarySchema,
  ticker: z.array(z.string()).max(6),
  audio: BoardAudioSchema.optional(),
});
export type BoardSnapshot = z.infer<typeof BoardSnapshotSchema>;

/** Design-token class per queue state (docs/06 §3.5). Never a literal colour. */
export const QUEUE_STATE_TEXT_CLASS: Record<QueueTokenStatus, string> = {
  issued: 'text-q-waiting',
  awaiting_payment: 'text-q-on-hold',
  waiting: 'text-q-waiting',
  called: 'text-q-called',
  recalled: 'text-q-called',
  in_service: 'text-q-in-progress',
  held: 'text-q-on-hold',
  skipped: 'text-q-skipped',
  served: 'text-q-completed',
  // No `--q-cancelled` or `--q-expired` token exists, and inventing a colour here
  // would be a literal that opts out of the high-contrast map (docs/06 §11).
  // Both are "this token is finished and nobody should act on it", which is
  // exactly what `--q-no-show` already says.
  no_show: 'text-q-no-show',
  transferred: 'text-q-completed',
  cancelled: 'text-q-no-show',
  expired: 'text-q-no-show',
};

export const QUEUE_STATE_LABEL: Record<QueueTokenStatus, string> = {
  issued: 'Issued',
  awaiting_payment: 'Awaiting payment',
  waiting: 'Waiting',
  called: 'Called',
  recalled: 'Called again',
  in_service: 'In consultation',
  held: 'On hold',
  skipped: 'Skipped',
  served: 'Completed',
  no_show: 'No show',
  transferred: 'Transferred',
  cancelled: 'Cancelled',
  expired: 'Closed for today',
};
