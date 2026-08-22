import { z } from 'zod';

/**
 * The request shapes for OP-001 §6 appointments, visits and doctor schedules.
 *
 * They live here rather than in `packages/contracts` because this agent does not
 * own that package; when the web app needs them they should be lifted verbatim,
 * which is why every schema is exported on its own and nothing depends on a
 * Nest import.
 *
 * The enum members are the **database** enum labels
 * (`clinical.AppointmentChannel`, `clinical.VisitType`, …) rather than a
 * prettier TypeScript spelling. A second vocabulary that has to be mapped is a
 * place two names can drift apart, and the one that matters is the one the row
 * is stored under.
 */

/** `clinical."AppointmentChannel"`. */
export const APPOINTMENT_CHANNELS = [
  'counter',
  'call_centre',
  'kiosk',
  'online',
  'app',
  'ivr',
  'whatsapp',
  'camp',
  'referral',
  'api',
] as const;

/** `clinical."AppointmentStatus"`. */
export const APPOINTMENT_STATUSES = [
  'waitlisted',
  'booked',
  'confirmed',
  'checked_in',
  'in_progress',
  'completed',
  'cancelled',
  'no_show',
  'rescheduled',
] as const;

/** `clinical."AppointmentCancelReason"`. */
export const APPOINTMENT_CANCEL_REASONS = [
  'patient_request',
  'doctor_unavailable',
  'rescheduled',
  'duplicate',
  'no_payment',
  'clinical',
  'weather_or_force_majeure',
  'other',
] as const;

/** `clinical."VisitType"`. */
export const VISIT_TYPES = [
  'new',
  'follow_up',
  'free_review',
  'referral',
  'tele',
  'emergency_opd',
  'health_checkup',
] as const;

/** `clinical."VisitPayerType"`. */
export const VISIT_PAYER_TYPES = ['self', 'insurance', 'corporate', 'scheme', 'staff', 'charity'] as const;

/** `clinical."VisitStatus"`. */
export const VISIT_STATUSES = [
  'registered',
  'waiting_payment',
  'waiting_vitals',
  'waiting_doctor',
  'in_consult',
  'consult_done',
  'closed',
  'cancelled',
  'no_show',
] as const;

/** `clinical."ScheduleExceptionKind"`. */
export const SCHEDULE_EXCEPTION_KINDS = [
  'leave',
  'holiday',
  'extra_clinic',
  'blocked',
  'reduced',
  'conference',
  'emergency',
] as const;

/**
 * Who asked for the cancellation — `appointment.cancelled`'s registered payload.
 *
 * It is a separate field from the reason code because OP-001 §5's refund rule
 * turns on it: "100 % if cancelled ≥ 24 h, else 0, **always full if the hospital
 * cancels**". A reason code alone cannot answer that question.
 */
export const CANCELLED_BY_PARTIES = ['patient', 'hospital', 'system'] as const;

const uuid = z.string().uuid();
/** Branch-local calendar date, `YYYY-MM-DD`. Never derived from a timestamp cast. */
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a YYYY-MM-DD date');
const localTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Expected an HH:MM time');

// ── slots ────────────────────────────────────────────────────────────────────

export const doctorSlotsQuerySchema = z.object({
  date: localDate,
  consultTypeKey: uuid.optional(),
  /** Full slots are returned too, flagged, so the calendar can grey them out. */
  includeFull: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

// ── appointments ─────────────────────────────────────────────────────────────

export const bookAppointmentSchema = z
  .object({
    slotId: uuid,
    /** Absent only for an unregistered lead, which then needs a name and a number. */
    patientId: uuid.optional(),
    leadName: z.string().min(1).max(200).optional(),
    leadMobile: z.string().min(6).max(20).optional(),
    consultTypeKey: uuid.optional(),
    channel: z.enum(APPOINTMENT_CHANNELS).default('counter'),
    isTele: z.boolean().default(false),
    /**
     * Opt-in, never implicit. A booking that would exceed the slot's capacity is
     * refused unless this is `true` *and* the caller holds
     * `appointment.overbook`; the resulting row is flagged `is_overbooked` with
     * the approver recorded (OP-001 §5).
     */
    overbook: z.boolean().default(false),
    notes: z.string().max(2000).optional(),
  })
  .refine((v) => v.patientId !== undefined || (v.leadName !== undefined && v.leadMobile !== undefined), {
    message: 'An appointment needs either a registered patient or a lead name and mobile (OP-001 §4).',
    path: ['patientId'],
  });

export const listAppointmentsQuerySchema = z.object({
  doctor: uuid.optional(),
  date: localDate.optional(),
  status: z.enum(APPOINTMENT_STATUSES).optional(),
  patientId: uuid.optional(),
  cursor: z.string().max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const rescheduleAppointmentSchema = z.object({
  slotId: uuid,
  note: z.string().max(2000).optional(),
});

export const confirmAppointmentSchema = z.object({
  note: z.string().max(2000).optional(),
});

export const cancelAppointmentSchema = z.object({
  reason: z.enum(APPOINTMENT_CANCEL_REASONS),
  cancelledBy: z.enum(CANCELLED_BY_PARTIES),
  note: z.string().max(2000).optional(),
});

// ── visits ───────────────────────────────────────────────────────────────────

export const checkInSchema = z.object({
  visitType: z.enum(VISIT_TYPES).optional(),
  payerType: z.enum(VISIT_PAYER_TYPES).default('self'),
  sourceChannel: z.enum(APPOINTMENT_CHANNELS).default('counter'),
  /** Explicit queue, else the doctor's own queue is resolved from EN-006 config. */
  queueId: uuid.optional(),
  roomKey: uuid.optional(),
  notes: z.string().max(2000).optional(),
});

export const createVisitSchema = z.object({
  patientId: uuid,
  practitionerKey: uuid,
  departmentKey: uuid.optional(),
  specialityKey: uuid.optional(),
  consultTypeKey: uuid.optional(),
  roomKey: uuid.optional(),
  visitType: z.enum(VISIT_TYPES).default('new'),
  payerType: z.enum(VISIT_PAYER_TYPES).default('self'),
  sourceChannel: z.enum(APPOINTMENT_CHANNELS).default('counter'),
  queueId: uuid.optional(),
  notes: z.string().max(2000).optional(),
});

export const listVisitsQuerySchema = z.object({
  doctor: uuid.optional(),
  date: localDate.optional(),
  status: z.enum(VISIT_STATUSES).optional(),
  patientId: uuid.optional(),
  cursor: z.string().max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const cancelVisitSchema = z.object({
  reason: z.string().min(1).max(2000),
});

export const transferVisitSchema = z.object({
  practitionerKey: uuid,
  departmentKey: uuid.optional(),
  specialityKey: uuid.optional(),
  queueId: uuid.optional(),
  reason: z.string().min(1).max(2000),
});

export const closeVisitSchema = z.object({
  note: z.string().max(2000).optional(),
});

// ── doctor schedules ─────────────────────────────────────────────────────────

export const scheduleSessionSchema = z.object({
  /** ISO-8601 weekday: 1 = Monday … 7 = Sunday (the table's CHECK constraint). */
  weekday: z.number().int().min(1).max(7),
  startTime: localTime,
  endTime: localTime,
  slotMinutes: z.number().int().min(1).max(480).default(15),
  capacityPerSlot: z.number().int().min(1).max(200).default(1),
  overbookAllowance: z.number().int().min(0).max(50).default(0),
  bufferMinutes: z.number().int().min(0).max(120).default(0),
  consultTypeKeys: z.array(uuid).max(20).default([]),
  onlineQuotaPct: z.number().int().min(0).max(100).default(100),
  walkinReserve: z.number().int().min(0).max(200).default(0),
  onlineBookingWindowDays: z.number().int().min(1).max(365).default(30),
  maxWalkins: z.number().int().min(0).max(500).optional(),
  vitalsRequired: z.boolean().default(false),
  teleEnabled: z.boolean().default(false),
  roomKey: uuid.optional(),
  departmentKey: uuid.optional(),
  specialityKey: uuid.optional(),
});

export const putScheduleTemplatesSchema = z.object({
  effectiveFrom: localDate,
  effectiveTo: localDate.optional(),
  sessions: z.array(scheduleSessionSchema).min(1).max(60),
});

export const publishScheduleSchema = z.object({
  /**
   * How far ahead to materialise slots. Defaults to the smallest
   * `online_booking_window_days` of the sessions being published, so the grid
   * never runs further than the window the hospital advertises.
   */
  horizonDays: z.number().int().min(1).max(365).optional(),
});

export const createScheduleExceptionSchema = z.object({
  kind: z.enum(SCHEDULE_EXCEPTION_KINDS),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }),
  isFullDay: z.boolean().default(true),
  reason: z.string().min(1).max(2000),
  replacementPractitionerKey: uuid.optional(),
});

export type DoctorSlotsQuery = z.infer<typeof doctorSlotsQuerySchema>;
export type BookAppointmentRequest = z.infer<typeof bookAppointmentSchema>;
export type ListAppointmentsQuery = z.infer<typeof listAppointmentsQuerySchema>;
export type RescheduleAppointmentRequest = z.infer<typeof rescheduleAppointmentSchema>;
export type ConfirmAppointmentRequest = z.infer<typeof confirmAppointmentSchema>;
export type CancelAppointmentRequest = z.infer<typeof cancelAppointmentSchema>;
export type CheckInRequest = z.infer<typeof checkInSchema>;
export type CreateVisitRequest = z.infer<typeof createVisitSchema>;
export type ListVisitsQuery = z.infer<typeof listVisitsQuerySchema>;
export type CancelVisitRequest = z.infer<typeof cancelVisitSchema>;
export type TransferVisitRequest = z.infer<typeof transferVisitSchema>;
export type CloseVisitRequest = z.infer<typeof closeVisitSchema>;
export type ScheduleSession = z.infer<typeof scheduleSessionSchema>;
export type PutScheduleTemplatesRequest = z.infer<typeof putScheduleTemplatesSchema>;
export type PublishScheduleRequest = z.infer<typeof publishScheduleSchema>;
export type CreateScheduleExceptionRequest = z.infer<typeof createScheduleExceptionSchema>;
