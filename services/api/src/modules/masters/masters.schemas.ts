import { z } from 'zod';
import { queryFlag } from '@vims/contracts';

/**
 * Request contracts for the EN-027 read half.
 *
 * They live in the module rather than in `packages/contracts` for the reason
 * `queue.schemas.ts` gives: nothing outside the API consumes them yet, and when
 * the masters pickers are written in `apps/web` these move — the browser must
 * validate against the *same* schema object, not a copy (`docs/09` §4).
 */

export const uuidSchema = z.string().uuid();

/**
 * `asOf` — the instant the caller wants the masters as they stood.
 *
 * A full RFC 3339 timestamp with an offset, not a bare date: "the tariff on
 * 1 April" is ambiguous until you say in which timezone, and a hospital that
 * changes prices at midnight local time would otherwise get yesterday's answer
 * for the first five and a half hours of the day.
 */
const asOfSchema = z.string().datetime({ offset: true }).optional();

/** Every masters list shares these three. */
export const masterListQuerySchema = z.object({
  asOf: asOfSchema,
  cursor: z.string().max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

/** Free-text picker search over the master's name. */
const searchSchema = z.string().trim().min(1).max(120).optional();

export const listDepartmentsQuerySchema = masterListQuerySchema.extend({
  branchId: uuidSchema.optional(),
  kind: z.string().max(16).optional(),
  q: searchSchema,
});

export const listSpecialitiesQuerySchema = masterListQuerySchema.extend({
  branchId: uuidSchema.optional(),
  departmentId: uuidSchema.optional(),
  telemedicineOnly: queryFlag().optional(),
  q: searchSchema,
});

export const listConsultTypesQuerySchema = masterListQuerySchema.extend({
  onlineBookableOnly: queryFlag().optional(),
  q: searchSchema,
});

export const listServicesQuerySchema = masterListQuerySchema.extend({
  branchId: uuidSchema.optional(),
  departmentId: uuidSchema.optional(),
  specialityId: uuidSchema.optional(),
  group: z.string().max(64).optional(),
  appointableOnly: queryFlag().optional(),
  q: searchSchema,
});

export const roomKindSchema = z.enum([
  'consult',
  'vitals',
  'procedure',
  'counter',
  'sample_collection',
  'imaging',
  'waiting',
  'teleconsult',
]);

export const listRoomsQuerySchema = masterListQuerySchema.extend({
  branchId: uuidSchema.optional(),
  departmentId: uuidSchema.optional(),
  kind: roomKindSchema.optional(),
  q: searchSchema,
});

export const listDoctorsQuerySchema = masterListQuerySchema.extend({
  branchId: uuidSchema.optional(),
  specialityId: uuidSchema.optional(),
  departmentId: uuidSchema.optional(),
  onlineBookableOnly: queryFlag().optional(),
  teleOnly: queryFlag().optional(),
  q: searchSchema,
});

export const doctorDetailQuerySchema = z.object({ asOf: asOfSchema });

/**
 * The eight small demographic lookups, behind one route.
 *
 * Eight near-identical controllers would be eight places to forget the
 * effective-date predicate. The `kind` is an enum rather than a free string so
 * that a typo is a 400 with the valid list attached, and — more to the point —
 * so that the value can never reach the `FROM` clause as anything but one of
 * eight compile-time constants.
 */
export const referenceKindSchema = z.enum([
  'id-types',
  'relationship-types',
  'occupations',
  'religions',
  'titles',
  'languages',
  'nationalities',
  'referral-sources',
]);

export type ReferenceKind = z.infer<typeof referenceKindSchema>;

export const listReferenceQuerySchema = masterListQuerySchema.extend({
  q: searchSchema,
});

export const listAreasQuerySchema = masterListQuerySchema.extend({
  /**
   * A PIN prefix, 1–6 digits. Prefix rather than equality because the
   * registration form looks up as the receptionist types, and because
   * `idx_mdm_areas_pincode_prefix` is a `varchar_pattern_ops` index built for
   * exactly this shape.
   */
  pin: z
    .string()
    .regex(/^[0-9]{1,6}$/, 'A PIN code is up to six digits.')
    .optional(),
  district: z.string().max(120).optional(),
  q: searchSchema,
});

export const queueKindSchema = z.enum(['doctor', 'department_pool', 'counter_pool', 'stage']);

export const listQueuesQuerySchema = z.object({
  branchId: uuidSchema.optional(),
  kind: queueKindSchema.optional(),
  departmentId: uuidSchema.optional(),
  practitionerId: uuidSchema.optional(),
  includeInactive: queryFlag().optional(),
  cursor: z.string().max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const listCashCountersQuerySchema = z.object({
  branchId: uuidSchema.optional(),
  includeInactive: queryFlag().optional(),
  cursor: z.string().max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type ListDepartmentsQuery = z.infer<typeof listDepartmentsQuerySchema>;
export type ListSpecialitiesQuery = z.infer<typeof listSpecialitiesQuerySchema>;
export type ListConsultTypesQuery = z.infer<typeof listConsultTypesQuerySchema>;
export type ListServicesQuery = z.infer<typeof listServicesQuerySchema>;
export type ListRoomsQuery = z.infer<typeof listRoomsQuerySchema>;
export type ListDoctorsQuery = z.infer<typeof listDoctorsQuerySchema>;
export type DoctorDetailQuery = z.infer<typeof doctorDetailQuerySchema>;
export type ListReferenceQuery = z.infer<typeof listReferenceQuerySchema>;
export type ListAreasQuery = z.infer<typeof listAreasQuerySchema>;
export type ListQueuesQuery = z.infer<typeof listQueuesQuerySchema>;
export type ListCashCountersQuery = z.infer<typeof listCashCountersQuerySchema>;
