import { z } from 'zod';

/**
 * The queue-token states of EN-006 §4.1. They exist here as a closed union so the
 * board can map each one to a `--q-*` design token; an unknown state from a newer
 * API renders as `waiting` rather than as an unstyled row.
 */
export const QueueTokenStatusSchema = z.enum([
  'waiting',
  'called',
  'recalled',
  'in_service',
  'held',
  'skipped',
  'served',
  'no_show',
]);
export type QueueTokenStatus = z.infer<typeof QueueTokenStatusSchema>;

/**
 * EN-018 §5 privacy: a public-area board carries the token, the room and the
 * clinician — never the patient. There is deliberately no patient field in this
 * schema, so a future API that starts sending one cannot leak it onto a corridor
 * screen by accident.
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
});
export type BoardSnapshot = z.infer<typeof BoardSnapshotSchema>;

/** Design-token class per queue state (docs/06 §3.5). Never a literal colour. */
export const QUEUE_STATE_TEXT_CLASS: Record<QueueTokenStatus, string> = {
  waiting: 'text-q-waiting',
  called: 'text-q-called',
  recalled: 'text-q-called',
  in_service: 'text-q-in-progress',
  held: 'text-q-on-hold',
  skipped: 'text-q-skipped',
  served: 'text-q-completed',
  no_show: 'text-q-no-show',
};

export const QUEUE_STATE_LABEL: Record<QueueTokenStatus, string> = {
  waiting: 'Waiting',
  called: 'Called',
  recalled: 'Called again',
  in_service: 'In consultation',
  held: 'On hold',
  skipped: 'Skipped',
  served: 'Completed',
  no_show: 'No show',
};
