import { z } from 'zod';

/**
 * Request contracts for EN-006 §6.
 *
 * They live in the module rather than in `packages/contracts` because nothing
 * outside the API consumes them yet — the queue console is Phase 1's web work
 * and will import them from `packages/contracts` when it is written. The same
 * schema object must then be the one the browser validates against (`docs/09
 * §4`), so these move rather than being copied.
 */

export const tokenClassSchema = z.enum([
  'regular',
  'appointment',
  'priority_emergency',
  'priority_senior',
  'priority_pregnant',
  'priority_disabled',
  'priority_infant',
  'priority_staff',
  'priority_vip',
]);

export const tokenSourceSchema = z.enum([
  'desk',
  'kiosk',
  'app',
  'portal',
  'call_centre',
  'er',
  'ward',
  'auto_forward',
]);

export const tokenStatusSchema = z.enum([
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
]);

export const uuidSchema = z.string().uuid();

export const issueTokenRequestSchema = z.object({
  queueId: uuidSchema,
  patientId: uuidSchema.optional(),
  visitId: uuidSchema.optional(),
  appointmentId: uuidSchema.optional(),
  journeyId: uuidSchema.optional(),
  class: tokenClassSchema.optional(),
  source: tokenSourceSchema.optional(),
  /** Mandatory when a desk overrides the class upward (EN-006 §3.5). */
  priorityReason: z.string().min(3).max(200).optional(),
  appointmentDueAt: z.string().datetime({ offset: true }).optional(),
});

export const listTokensQuerySchema = z.object({
  cursor: z.string().max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  queueId: uuidSchema.optional(),
  patientId: uuidSchema.optional(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
    .optional(),
  status: tokenStatusSchema.optional(),
});

export const callNextRequestSchema = z.object({
  counterId: uuidSchema.optional(),
  roomKey: uuidSchema.optional(),
});

export const skipTokenRequestSchema = z.object({
  /** EN-006 §3.3: a skip is never silent. */
  reason: z.string().min(3).max(300),
});

export const transferTokenRequestSchema = z.object({
  toQueueId: uuidSchema,
  reason: z.string().min(3).max(300),
});

export type IssueTokenRequest = z.infer<typeof issueTokenRequestSchema>;
export type ListTokensQuery = z.infer<typeof listTokensQuerySchema>;
export type CallNextRequest = z.infer<typeof callNextRequestSchema>;
export type SkipTokenRequest = z.infer<typeof skipTokenRequestSchema>;
export type TransferTokenRequest = z.infer<typeof transferTokenRequestSchema>;
