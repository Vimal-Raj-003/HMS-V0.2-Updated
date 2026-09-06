import { lateralitySchema, queryFlag } from '@vims/contracts';
import { z } from 'zod';

/**
 * Phase 8 framework request schemas (OP-025 §0).
 *
 * ── There is no field that reviews a result on somebody's behalf ────────────
 *
 * `attach` takes what arrived; `review` takes nothing at all, because a review
 * is the identity of the caller and the moment they called. A `reviewedBy` in
 * the request body would let the technician who uploaded the scan record the
 * doctor as having seen it, which is the exact failure the two-key split
 * exists to prevent.
 */

const uuid = z.string().uuid();

export const consoleTabSchema = z
  .object({
    key: z.string().trim().min(1).max(40),
    label: z.string().trim().min(1).max(60),
    component: z.string().trim().min(1).max(80).optional(),
    formTemplateKey: z.string().trim().min(1).max(80).optional(),
    roles: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
  })
  .refine((t) => (t.component === undefined) !== (t.formTemplateKey === undefined), {
    message: 'A tab names one component or one form template — neither is a blank panel, both is a fight.',
  });

export const registerConsoleSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[A-Z][A-Z0-9_]{1,23}$/u, 'A console code is the prefix on its permissions, events and prints.'),
  name: z.string().trim().min(1).max(120),
  moduleKey: z
    .string()
    .trim()
    .regex(/^module\.[a-z0-9_.]+$/u, 'A console names the licence key that gates it.'),
  departmentIds: z.array(uuid).max(50).default([]),
  tabs: z.array(consoleTabSchema).min(1).max(20),
  worklistConfig: z.record(z.string(), z.unknown()).optional(),
  billingLinks: z.record(z.string(), z.unknown()).optional(),
  sortOrder: z.number().int().min(0).max(999).default(0),
});
export type RegisterConsoleRequest = z.infer<typeof registerConsoleSchema>;

export const updateConsoleSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  departmentIds: z.array(uuid).max(50).optional(),
  tabs: z.array(consoleTabSchema).min(1).max(20).optional(),
  worklistConfig: z.record(z.string(), z.unknown()).optional(),
  billingLinks: z.record(z.string(), z.unknown()).optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(999).optional(),
});
export type UpdateConsoleRequest = z.infer<typeof updateConsoleSchema>;

export const deviceTypeSchema = z.object({
  consoleCode: z.string().trim().min(1).max(24),
  code: z
    .string()
    .trim()
    .regex(/^[A-Z][A-Z0-9_]{1,39}$/u, 'A device result type code is uppercase, like OCT_MACULA.'),
  name: z.string().trim().min(1).max(160),
  transport: z.enum(['dicom', 'file', 'structured', 'manual']),
  mimeTypes: z.array(z.string().trim().min(3).max(120)).max(20).default([]),
  parserKey: z.string().trim().min(1).max(60).optional(),
  reportTemplateKey: z.string().trim().min(1).max(60).optional(),
  billingServiceCode: z.string().trim().min(1).max(40).optional(),
  reviewDueHours: z.number().int().min(1).max(168).default(4),
  /** Whether the order must name an eye, an ear or a limb. */
  sideRequired: z.boolean().default(false),
});
export type DeviceTypeRequest = z.infer<typeof deviceTypeSchema>;

export const orderDeviceResultSchema = z.object({
  patientId: uuid,
  encounterId: uuid,
  visitId: uuid.optional(),
  deviceResultTypeCode: z.string().trim().min(1).max(40),
  side: lateralitySchema.default('not_applicable'),
  /** What the console is billing this action as, if anything. */
  serviceKey: uuid.optional(),
  note: z.string().trim().max(2000).optional(),
});
export type OrderDeviceResultRequest = z.infer<typeof orderDeviceResultSchema>;

export const performSchema = z.object({
  performedAt: z.string().datetime({ offset: true }).optional(),
});
export type PerformRequest = z.infer<typeof performSchema>;

export const attachSchema = z
  .object({
    resultFileId: uuid.optional(),
    pacsStudyUid: z.string().trim().min(3).max(80).optional(),
    /** What the EN-042 parser pulled out: the fields a report can query. */
    parsed: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((b) => b.resultFileId !== undefined || b.pacsStudyUid !== undefined || b.parsed !== undefined, {
    message: 'An attached result carries a file, a study or a parsed payload.',
  });
export type AttachRequest = z.infer<typeof attachSchema>;

export const cancelOrderSchema = z.object({
  reason: z.string().trim().min(4).max(2000),
});
export type CancelOrderRequest = z.infer<typeof cancelOrderSchema>;

/**
 * Moving a patient to the next service point.
 *
 * One call, because closing the old leg and opening the new one is one fact.
 * Two calls would let a network drop leave a patient in neither queue, which on
 * a busy refraction lane means somebody sitting unnoticed for an hour.
 */
export const moveStageSchema = z.object({
  encounterId: uuid,
  patientId: uuid,
  consoleCode: z.string().trim().min(1).max(24),
  stageKey: z.string().trim().min(1).max(40),
  queueDefinitionId: uuid.optional(),
  note: z.string().trim().max(1000).optional(),
});
export type MoveStageRequest = z.infer<typeof moveStageSchema>;

export const worklistQuerySchema = z.object({
  consoleCode: z.string().trim().min(1).max(24),
  stageKey: z.string().trim().min(1).max(40).optional(),
  /** Only the patients still somewhere in the console's lanes. */
  openOnly: queryFlag().default(true),
  limit: z.coerce.number().int().min(1).max(200).default(60),
});
export type WorklistQuery = z.infer<typeof worklistQuerySchema>;

export const consoleQuerySchema = z.object({
  activeOnly: queryFlag().default(true),
  departmentId: uuid.optional(),
});
export type ConsoleQuery = z.infer<typeof consoleQuerySchema>;

export const deviceOrderQuerySchema = z.object({
  encounterId: uuid.optional(),
  consoleCode: z.string().trim().min(1).max(24).optional(),
  /** The doctor's rail: attached, nobody has looked. */
  unreviewedOnly: queryFlag().default(false),
  limit: z.coerce.number().int().min(1).max(200).default(60),
});
export type DeviceOrderQuery = z.infer<typeof deviceOrderQuerySchema>;
