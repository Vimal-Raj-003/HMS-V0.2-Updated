import { queryFlag } from '@vims/contracts';
import { z } from 'zod';

/**
 * Request shapes for RC-006's charge-intent posting.
 *
 * ── There is no `unitPrice` on a post ───────────────────────────────────────
 *
 * The price comes from RC-003, resolved against the tariff in force on the day
 * the act was performed and the payer on the bill. A biller who could type a
 * price here would be a second pricing engine, and the two would disagree the
 * first time a corporate plan changed.
 *
 * ── Nor a `billLineId` ─────────────────────────────────────────────────────
 *
 * It is the id of the line that posting created, written back by the poster.
 * A caller who could supply one could point a charge at somebody else's bill.
 */

const uuid = z.string().uuid();

export const pendingQuerySchema = z.object({
  patientId: uuid.optional(),
  visitId: uuid.optional(),
  admissionId: uuid.optional(),
  sourceModule: z.string().max(32).optional(),
  /** The list a biller works from: raised, and not yet on a bill. */
  unbilledOnly: queryFlag().default(true),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export type PendingQuery = z.infer<typeof pendingQuerySchema>;

export const postChargesSchema = z.object({
  /**
   * Which intents to post. Empty means "every pending intent that belongs on
   * this bill", which is what a biller closing a visit actually wants and what
   * a per-id list would make them assemble by hand.
   */
  intentIds: z.array(uuid).max(500).default([]),
  /**
   * How the line is classified on the bill. The console knows what it did; the
   * bill needs to know which bucket it falls in for the GST summary.
   */
  itemType: z
    .enum(['consult', 'lab', 'rad', 'pharmacy', 'procedure', 'consumable', 'package', 'room', 'other'])
    .default('procedure'),
});
export type PostChargesRequest = z.infer<typeof postChargesSchema>;

export const reverseChargeSchema = z.object({
  /** A billed line is reversed with a reason; the pair is what a credit note is made of. */
  reason: z.string().min(8).max(2000),
});
export type ReverseChargeRequest = z.infer<typeof reverseChargeSchema>;
