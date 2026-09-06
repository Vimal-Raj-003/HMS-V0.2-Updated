import { queryFlag } from '@vims/contracts';
import { z } from 'zod';

/**
 * Phase 7A request schemas.
 *
 * ── There is no `bedId` on an admission request ─────────────────────────────
 *
 * `POST /admissions/:id/admit` takes the *requirements* — class, isolation, a
 * ventilator point — and the server picks a bed under a lock. A client naming
 * a bed is a client that read the board a moment ago and is about to lose a
 * race it cannot see. Naming one is still possible (`preferredBedId`), and it
 * is a preference the allocator tries first, not an instruction.
 */

const uuid = z.string().uuid();
const shortText = z.string().trim().min(1).max(200);

export const buildingSchema = z.object({
  code: z.string().trim().min(1).max(20),
  name: shortText,
});
export type BuildingRequest = z.infer<typeof buildingSchema>;

export const wardSchema = z.object({
  buildingId: uuid,
  code: z.string().trim().min(1).max(20),
  name: shortText,
  floor: z.string().trim().min(1).max(20),
  wardType: z.enum(['general', 'icu', 'hdu', 'ot', 'nicu', 'picu', 'labour', 'isolation', 'day_care']),
  /** Minutes to turn a bed around here. An ICU bed is cleaned faster because somebody is waiting. */
  cleaningSlaMinutes: z.number().int().min(5).max(1440).default(60),
  sexPolicy: z.enum(['any', 'male', 'female']).default('any'),
  minAgeYears: z.number().int().min(0).max(120).optional(),
  maxAgeYears: z.number().int().min(0).max(120).optional(),
});
export type WardRequest = z.infer<typeof wardSchema>;

export const bedClassSchema = z.object({
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(80),
  /** Lower is cheaper, so "eligible up to semi-private" is a comparison. */
  tier: z.number().int().min(1).max(20),
  tariffServiceId: uuid.optional(),
});
export type BedClassRequest = z.infer<typeof bedClassSchema>;

export const roomSchema = z.object({
  wardId: uuid,
  classId: uuid,
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().max(80).optional(),
  isShared: z.boolean().default(true),
});
export type RoomRequest = z.infer<typeof roomSchema>;

export const bedSchema = z.object({
  wardId: uuid,
  roomId: uuid,
  classId: uuid,
  code: z.string().trim().min(1).max(20),
  isolationCapable: z.boolean().default(false),
  hasOxygenPoint: z.boolean().default(true),
  hasMonitor: z.boolean().default(false),
  hasVentilatorPoint: z.boolean().default(false),
  hasAttendantBed: z.boolean().default(false),
});
export type BedRequest = z.infer<typeof bedSchema>;

export const admissionRequestSchema = z.object({
  patientId: uuid,
  erVisitId: uuid.optional(),
  opdVisitId: uuid.optional(),
  kind: z.enum([
    'elective',
    'emergency',
    'day_care',
    'observation',
    'er_fast_track',
    'transfer_in',
    'newborn',
  ]),
  attendingDoctorId: uuid.optional(),
  admittingDoctorId: uuid.optional(),
  department: z.string().trim().max(60).optional(),
  provisionalDiagnosis: z.string().trim().max(2000).optional(),
  icd10: z.string().trim().max(20).optional(),
  payerId: uuid.optional(),
  entitledClassId: uuid.optional(),
  packageId: uuid.optional(),
  expectedDischargeAt: z.string().datetime({ offset: true }).optional(),
  notes: z.string().trim().max(2000).optional(),
});
export type AdmissionRequestBody = z.infer<typeof admissionRequestSchema>;

export const admitSchema = z.object({
  /** What the patient needs. The server finds a bed that has it, under a lock. */
  classId: uuid,
  wardId: uuid.optional(),
  needsIsolation: z.boolean().default(false),
  needsVentilatorPoint: z.boolean().default(false),
  needsMonitor: z.boolean().default(false),
  needsAttendantBed: z.boolean().default(false),
  /** A preference, tried first. Not an instruction — the lock decides. */
  preferredBedId: uuid.optional(),
  consentId: uuid.optional(),
  depositTaken: z.number().nonnegative().max(10_000_000).default(0),
  depositApprovalId: uuid.optional(),
  registrationComplete: z.boolean().default(true),
});
export type AdmitRequest = z.infer<typeof admitSchema>;

export const holdSchema = z.object({
  bedId: uuid,
  admissionId: uuid.optional(),
  patientId: uuid.optional(),
  reason: z.enum(['er_disposition', 'elective_booking', 'ot_return', 'icu_return', 'transfer_in', 'other']),
  /** Overrides the default TTL for this reason. */
  minutes: z.number().int().min(5).max(2880).optional(),
  notes: z.string().trim().max(1000).optional(),
});
export type HoldRequest = z.infer<typeof holdSchema>;

/**
 * How long a hold lasts, by why it was taken.
 *
 * From `phase-07` §7A.2. The ER's two hours is the shortest because an ER bed
 * held for a patient who never comes is an ER bed nobody else can have, and the
 * ER is where the queue is.
 */
export const HOLD_TTL_MINUTES: Readonly<Record<string, number>> = {
  er_disposition: 120,
  elective_booking: 360,
  ot_return: 1440,
  icu_return: 1440,
  transfer_in: 360,
  other: 120,
};

export const releaseHoldSchema = z.object({
  reason: z.enum(['admitted', 'expired', 'cancelled']),
  notes: z.string().trim().max(500).optional(),
});
export type ReleaseHoldRequest = z.infer<typeof releaseHoldSchema>;

export const blockSchema = z.object({
  /** `false` unblocks. A blocked bed is one the hospital does not have. */
  blocked: z.boolean(),
  expectedHours: z.number().int().min(1).max(8760).optional(),
  approvalId: uuid.optional(),
});
export type BlockRequest = z.infer<typeof blockSchema>;

export const transferSchema = z.object({
  kind: z
    .enum(['intra_facility', 'inter_branch', 'transfer_out', 'transfer_in', 'leave', 'return'])
    .default('intra_facility'),
  toBedId: uuid.optional(),
  toClassId: uuid.optional(),
  reason: z.string().trim().min(8).max(2000),
  /** SBAR. Named fields rather than free text — "lines and tubes" is the one that gets forgotten. */
  situation: z.string().trim().max(2000).optional(),
  background: z.string().trim().max(2000).optional(),
  assessment: z.string().trim().max(2000).optional(),
  recommendation: z.string().trim().max(2000).optional(),
  linesAndTubes: z.array(z.string().trim().min(1).max(120)).max(30).default([]),
  infusions: z.array(z.string().trim().min(1).max(120)).max(30).default([]),
  pendingResults: z.array(z.string().trim().min(1).max(120)).max(30).default([]),
  allergies: z.array(z.string().trim().min(1).max(120)).max(30).default([]),
  destinationFacility: z.string().trim().max(200).optional(),
  stabilityNote: z.string().trim().max(2000).optional(),
  documentsPack: z.array(z.string().trim().min(1).max(120)).max(30).default([]),
  at: z.string().datetime({ offset: true }).optional(),
});
export type TransferRequest = z.infer<typeof transferSchema>;

export const dischargeSchema = z.object({
  outcome: z.enum(['routine', 'lama', 'absconded', 'transferred_out', 'died']),
  at: z.string().datetime({ offset: true }).optional(),
  notes: z.string().trim().max(2000).optional(),
});
export type DischargeRequest = z.infer<typeof dischargeSchema>;

export const cleaningActionSchema = z.object({
  action: z.enum(['accept', 'start', 'complete', 'inspect', 'fail']),
  checklist: z.record(z.string(), z.unknown()).optional(),
  failReason: z.string().trim().min(4).max(1000).optional(),
});
export type CleaningActionRequest = z.infer<typeof cleaningActionSchema>;

export const boardQuerySchema = z.object({
  wardId: uuid.optional(),
  wardType: z.string().trim().max(24).optional(),
  classId: uuid.optional(),
  status: z.enum(['available', 'occupied', 'reserved', 'cleaning', 'blocked', 'retired']).optional(),
  freeOnly: queryFlag().default(false),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});
export type BoardQuery = z.infer<typeof boardQuerySchema>;

export const admissionQuerySchema = z.object({
  status: z
    .enum([
      'requested',
      'admitted',
      'on_leave',
      'discharge_initiated',
      'discharged',
      'cancelled',
      'closed_other',
    ])
    .optional(),
  wardId: uuid.optional(),
  patientId: uuid.optional(),
  attendingDoctorId: uuid.optional(),
  dueForDischarge: queryFlag().default(false),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type AdmissionQuery = z.infer<typeof admissionQuerySchema>;

export const cleaningQuerySchema = z.object({
  wardId: uuid.optional(),
  openOnly: queryFlag().default(true),
  breachedOnly: queryFlag().default(false),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type CleaningQuery = z.infer<typeof cleaningQuerySchema>;
