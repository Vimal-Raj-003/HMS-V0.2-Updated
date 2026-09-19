/**
 * The wire shapes of the front-office API, as the browser receives them.
 *
 * They are declared here rather than imported from `packages/contracts` because
 * Phase 1's request/response contracts still live inside `services/api`'s
 * modules (`opd/scheduling/dto/scheduling.dto.ts`, `frontoffice/queue/queue.schemas.ts`,
 * `frontoffice/cash/cash.schemas.ts`), and those files say so themselves: "they
 * live here … when the web app needs them they should be lifted verbatim". This
 * task may not touch `packages/*`, so the shapes are mirrored — **verbatim**,
 * including the `snake_case` column names the API returns unchanged — and the
 * duplication is deliberate and temporary. Lifting them into
 * `packages/contracts` and deleting this file is the follow-up.
 *
 * Two conventions the API keeps and this file therefore keeps:
 *
 *  - **Timestamps arrive as ISO-8601 strings.** The service types say `Date`,
 *    but JSON has no date type, so what a `fetch` yields is a string. Typing
 *    them as `Date` here would compile and then produce `undefined` at every
 *    `.getTime()`.
 *  - **Money arrives as a decimal string**, never a JSON number
 *    (`cash.schemas.ts`: "₹1,234.55 round-tripped through IEEE-754 can arrive as
 *    1234.5499999999999"). Every one of them is parsed into `Money` before any
 *    arithmetic happens.
 */

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

// ── scheduling (OP-001 §6) ───────────────────────────────────────────────────

/** `clinical."SlotStatus"`. */
export type SlotStatus = 'open' | 'filling' | 'full' | 'blocked' | 'cancelled';

export interface SlotView {
  readonly id: string;
  /** `YYYY-MM-DD`, branch-local. */
  readonly slot_date: string;
  /** ISO-8601 instant. */
  readonly slot_start: string;
  readonly slot_end: string;
  readonly capacity: number;
  readonly overbook_allowance: number;
  readonly booked_count: number;
  readonly online_quota: number;
  readonly online_booked_count: number;
  readonly walkin_reserve: number;
  readonly status: SlotStatus;
  readonly tele_enabled: boolean;
  readonly room_key: string | null;
  readonly speciality_key: string | null;
  readonly consult_type_keys: readonly string[] | null;
  readonly available: number;
  readonly available_with_overbook: number;
}

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
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

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
export type AppointmentCancelReason = (typeof APPOINTMENT_CANCEL_REASONS)[number];

export const CANCELLED_BY_PARTIES = ['patient', 'hospital', 'system'] as const;
export type CancelledByParty = (typeof CANCELLED_BY_PARTIES)[number];

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
export type AppointmentChannel = (typeof APPOINTMENT_CHANNELS)[number];

export interface AppointmentListItem {
  readonly id: string;
  readonly appointment_no: string;
  readonly patient_id: string | null;
  readonly lead_name: string | null;
  readonly practitioner_key: string | null;
  readonly speciality_key: string | null;
  readonly consult_type_key: string | null;
  readonly slot_id: string | null;
  readonly slot_start: string;
  readonly slot_end: string;
  readonly slot_date: string;
  readonly channel: string;
  readonly status: AppointmentStatus;
  readonly is_tele: boolean;
  readonly is_overbooked: boolean;
  readonly visit_id: string | null;
  readonly checked_in_at: string | null;
  readonly confirmed_at: string | null;
  readonly cancelled_at: string | null;
}

export interface AppointmentDetail extends AppointmentListItem {
  readonly lead_mobile: string | null;
  readonly department_key: string | null;
  readonly cancel_reason: string | null;
  readonly cancel_note: string | null;
  readonly rescheduled_from_id: string | null;
  readonly rescheduled_to_id: string | null;
  readonly notes: string | null;
  readonly version: number;
}

export interface CheckInResult {
  readonly appointment: AppointmentDetail;
  readonly visitId: string;
  readonly visitNo: string;
  readonly tokenDisplay: string;
  readonly queueId: string;
}

export interface ScheduleExceptionRow {
  readonly id: string;
  readonly practitioner_key: string | null;
  readonly kind: string;
  readonly starts_at: string;
  readonly ends_at: string;
  readonly is_full_day: boolean;
  readonly reason: string;
  readonly replacement_practitioner_key: string | null;
  readonly affected_appointments: number;
  readonly created_at: string;
}

export interface BookAppointmentRequest {
  readonly slotId: string;
  readonly patientId?: string;
  readonly leadName?: string;
  readonly leadMobile?: string;
  readonly channel?: AppointmentChannel;
  readonly isTele?: boolean;
  readonly overbook?: boolean;
  readonly notes?: string;
}

export interface CancelAppointmentRequest {
  readonly reason: AppointmentCancelReason;
  readonly cancelledBy: CancelledByParty;
  readonly note?: string;
}

// ── visits (OP-001 §6) ───────────────────────────────────────────────────────

export const VISIT_TYPES = [
  'new',
  'follow_up',
  'free_review',
  'referral',
  'tele',
  'emergency_opd',
  'health_checkup',
] as const;
export type VisitType = (typeof VISIT_TYPES)[number];

export const VISIT_PAYER_TYPES = ['self', 'insurance', 'corporate', 'scheme', 'staff', 'charity'] as const;
export type VisitPayerType = (typeof VISIT_PAYER_TYPES)[number];

export interface CheckInRequest {
  readonly visitType?: VisitType;
  readonly payerType?: VisitPayerType;
  readonly sourceChannel?: AppointmentChannel;
  readonly queueId?: string;
  readonly notes?: string;
}

// ── queue (EN-006 §6) ────────────────────────────────────────────────────────

export const TOKEN_CLASSES = [
  'regular',
  'appointment',
  'priority_emergency',
  'priority_senior',
  'priority_pregnant',
  'priority_disabled',
  'priority_infant',
  'priority_staff',
  'priority_vip',
] as const;
export type TokenClass = (typeof TOKEN_CLASSES)[number];

export const TOKEN_SOURCES = [
  'desk',
  'kiosk',
  'app',
  'portal',
  'call_centre',
  'er',
  'ward',
  'auto_forward',
] as const;
export type TokenSource = (typeof TOKEN_SOURCES)[number];

export const TOKEN_STATUSES = [
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
] as const;
export type TokenStatus = (typeof TOKEN_STATUSES)[number];

export interface TokenView {
  readonly id: string;
  readonly queue_id: string;
  readonly branch_id: string;
  readonly series_date: string;
  readonly token_no: number;
  readonly token_display: string;
  readonly patient_id: string | null;
  readonly visit_id: string | null;
  readonly appointment_id: string | null;
  readonly counter_id: string | null;
  readonly room_key: string | null;
  readonly source: TokenSource;
  readonly class: TokenClass;
  readonly priority_rank: number;
  readonly status: TokenStatus;
  readonly est_wait_sec_at_issue: number | null;
  readonly actual_wait_sec: number | null;
  readonly skip_count: number;
  readonly recall_count: number;
  readonly issued_at: string;
  readonly called_at: string | null;
  readonly service_end_at: string | null;
}

export interface BoardEntry {
  readonly tokenDisplay: string;
  readonly status: string;
  readonly counterId: string | null;
  readonly roomKey: string | null;
  readonly isPriority: boolean;
}

export interface BoardView {
  readonly queueId: string;
  readonly queueCode: string;
  readonly queueName: string;
  readonly seriesDate: string;
  readonly nowServing: readonly BoardEntry[];
  readonly next: readonly BoardEntry[];
  readonly waiting: number;
  readonly served: number;
  readonly noShow: number;
  readonly avgWaitSeconds: number;
  readonly doctorStatus: string | null;
}

export interface IssueTokenRequest {
  readonly queueId: string;
  readonly patientId?: string;
  readonly visitId?: string;
  readonly appointmentId?: string;
  readonly class?: TokenClass;
  readonly source?: TokenSource;
  readonly priorityReason?: string;
}

export interface CallNextRequest {
  readonly counterId?: string;
  readonly roomKey?: string;
}

// ── cash (NC-001 §6) ─────────────────────────────────────────────────────────

export const PAYMENT_MODES = [
  'cash',
  'card',
  'upi',
  'netbanking',
  'wallet',
  'cheque',
  'dd',
  'gateway_link',
  'advance_adjust',
  'patient_wallet',
  'credit',
  'staff_credit',
  'emi',
  'forex',
] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

export interface ModeTotal {
  readonly mode: string;
  readonly collections: string;
  readonly refunds: string;
  readonly advances: string;
  readonly voids: string;
  readonly count: number;
  readonly pending_confirmation_amount: string;
}

export type ShiftStatus = 'open' | 'closing' | 'closed' | 'force_closed';

export interface ShiftView {
  readonly id: string;
  readonly counterId: string;
  readonly branchId: string;
  readonly cashierUserId: string;
  readonly businessDate: string;
  readonly status: ShiftStatus;
  readonly currency: string;
  readonly openingFloat: string;
  readonly expectedCash: string;
  readonly countedCash: string | null;
  readonly variance: string | null;
  readonly varianceReason: string | null;
  readonly varianceApprovedBy: string | null;
  readonly receiptsCount: number;
  readonly voidsCount: number;
  readonly refundsCount: number;
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly totals: readonly ModeTotal[];
  readonly pendingConfirmations: number;
  readonly blockedBy: 'variance_approval' | 'pending_confirmations' | null;
}

export interface ShiftListItem {
  readonly id: string;
  readonly counter_id: string;
  readonly cashier_user_id: string;
  readonly business_date: string;
  readonly status: ShiftStatus;
  readonly opening_float: string;
  readonly counted_cash: string | null;
  readonly variance: string | null;
  readonly opened_at: string;
  readonly closed_at: string | null;
}

export interface PaymentLineView {
  readonly mode: string;
  readonly amount: string;
  readonly status: string;
  readonly reference: string | null;
}

export interface PaymentView {
  readonly id: string;
  readonly receiptNo: string;
  readonly seriesKey: string;
  readonly kind: string;
  readonly amount: string;
  readonly currency: string;
  readonly status: string;
  readonly shiftId: string;
  readonly counterId: string;
  readonly patientId: string | null;
  readonly advanceId: string | null;
  readonly paidAt: string;
  readonly lines: readonly PaymentLineView[];
}

export interface RefundView {
  readonly id: string;
  readonly refundNo: string;
  readonly amount: string;
  readonly currency: string;
  readonly mode: string;
  readonly status: string;
  readonly shiftId: string | null;
  readonly processedAt: string | null;
}

/** A denomination line as NC-001 §6 takes it: face value and count, both exact. */
export interface DenominationLineRequest {
  /** Decimal string face value — `"2000.00"`, never `2000`. */
  readonly denomination: string;
  readonly count: number;
}

export interface OpenShiftRequest {
  readonly counterId: string;
  readonly denominations: readonly DenominationLineRequest[];
  readonly floatSource?: 'main_cash' | 'previous_shift' | 'none';
}

export interface PaymentLineRequest {
  readonly mode: PaymentMode;
  readonly amount: string;
  readonly tendered?: string;
  readonly reference?: string;
  readonly pending?: boolean;
}

export interface CollectPaymentRequest {
  readonly shiftId: string;
  readonly patientId?: string;
  readonly kind?: 'payment' | 'advance';
  readonly purpose: string;
  readonly amount: string;
  readonly payerName?: string;
  readonly payerRefId?: string;
  readonly payerType?: 'patient' | 'corporate' | 'other';
  readonly remarks?: string;
  readonly lines: readonly PaymentLineRequest[];
}

export interface CloseShiftRequest {
  readonly denominations: readonly DenominationLineRequest[];
  readonly varianceReason?: string;
  readonly handoverTo?: 'main_cash' | 'next_shift';
  readonly handoverBagNo?: string;
}

/**
 * The second person, as `docs/06` §6.9 friction level 6 requires it.
 *
 * `receipt.void` and `receipt.refund.pay` are both `requiresSecondPerson` in the
 * permission catalogue, which means the acting user's own session can never
 * satisfy them however many keys it holds.
 */
export interface CoSignerInput {
  readonly identifier: string;
  readonly credential: string;
  readonly credentialKind?: 'password' | 'pin' | 'totp';
}

export interface PayRefundRequest {
  readonly shiftId: string;
  readonly coSigner: CoSignerInput;
  readonly identityMethod?: 'otp' | 'photo_id' | 'in_person';
}

export interface VoidReceiptRequest {
  readonly reason: string;
  readonly coSigner: CoSignerInput;
}

// ── patients (OP-001 §6) — used by the book and the payer picker ─────────────

export interface PatientListItem {
  readonly id: string;
  readonly uhid: string;
  readonly full_name: string;
  readonly gender: string;
  readonly age_years: number | null;
  readonly mobile: string;
  readonly status: string;
  readonly last_visit_at: string | null;
}

// ── PE-009 · enquiries from the public assistant ────────────────────────────

/**
 * One enquiry left by the landing page's assistant.
 *
 * Not an appointment, and the type is deliberately shaped so it cannot be
 * mistaken for one: there is no patient id, no slot booked and no encounter.
 * The caller is a member of the public whose phone number nobody has verified,
 * which is exactly why front office telephones before booking anything.
 */
export interface AppointmentRequestRow {
  readonly id: string;
  readonly channel: string;
  readonly requesterName: string;
  readonly requesterPhone: string;
  readonly requesterEmail: string | null;
  readonly specialityKey: string | null;
  /** Resolved by the API, because `/specialities` needs `mdm.read` and a clerk has not got it. */
  readonly specialityName: string | null;
  readonly practitionerKey: string | null;
  readonly practitionerName: string | null;
  readonly slotId: string | null;
  readonly preferredDate: string | null;
  readonly preferredPeriod: string | null;
  readonly reason: string | null;
  readonly status: string;
  readonly appointmentId: string | null;
  readonly handledAt: string | null;
  readonly declineReason: string | null;
  readonly createdAt: string;
}

export type AppointmentRequestStatus = 'new' | 'contacted' | 'booked' | 'declined' | 'expired';

export interface UpdateAppointmentRequest {
  readonly status: 'contacted' | 'declined' | 'expired';
  readonly declineReason?: string;
}
