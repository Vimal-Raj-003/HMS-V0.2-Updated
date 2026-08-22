import { newIdempotencyKey, queryString, request } from './http';
import type {
  AppointmentDetail,
  AppointmentListItem,
  BoardView,
  BookAppointmentRequest,
  CancelAppointmentRequest,
  CheckInRequest,
  CheckInResult,
  CloseShiftRequest,
  CollectPaymentRequest,
  IssueTokenRequest,
  CallNextRequest,
  OpenShiftRequest,
  Page,
  PatientListItem,
  PaymentView,
  PayRefundRequest,
  RefundView,
  ScheduleExceptionRow,
  ShiftListItem,
  ShiftView,
  SlotView,
  TokenView,
  VoidReceiptRequest,
} from './types';

/**
 * Every call the three front-office screens make.
 *
 * `reason` is a **required** parameter on exactly the calls whose permission key
 * is marked `requiresReason` in the catalogue — `appointment.cancel`,
 * `queue.token.manage` (transfer), `receipt.void`,
 * `receipt.shift.variance.approve` — and on `POST /queue/tokens/:id/skip`, whose
 * body carries the reason EN-006 §3.3 insists a skip can never be without. A
 * caller cannot forget it and discover the omission as a 403 in production.
 *
 * Nothing here catches. A refusal is a `ProblemDetails` the screen must render
 * with its `reference`, and swallowing it into `null` is how a cashier ends up
 * with a blank panel and nothing to read out to the helpdesk.
 */

const SCHEDULING = '/api/v1';
const QUEUE = '/api/v1/queue';
const CASH = '/api/v1/cash';

interface Signal {
  readonly signal?: AbortSignal;
}

function withSignal(options: Signal): { signal?: AbortSignal } {
  return options.signal === undefined ? {} : { signal: options.signal };
}

// ── appointments & slots ─────────────────────────────────────────────────────

export async function listSlots(
  doctorKey: string,
  date: string,
  options: Signal = {},
): Promise<{ items: readonly SlotView[] }> {
  // `includeFull=true` because the book must show a full slot greyed out rather
  // than not at all — a clerk who cannot see the 10:00 slot assumes the doctor
  // is not sitting, and books the patient somewhere worse.
  return request<{ items: readonly SlotView[] }>(
    `${SCHEDULING}/doctors/${doctorKey}/slots${queryString({ date, includeFull: 'true' })}`,
    withSignal(options),
  );
}

export async function listScheduleExceptions(
  doctorKey: string,
  options: Signal = {},
): Promise<{ items: readonly ScheduleExceptionRow[] }> {
  return request<{ items: readonly ScheduleExceptionRow[] }>(
    `${SCHEDULING}/doctors/${doctorKey}/schedule-exceptions`,
    withSignal(options),
  );
}

export async function listAppointments(
  filters: { readonly doctor?: string; readonly date?: string; readonly status?: string },
  cursor: string | undefined,
  options: Signal = {},
): Promise<Page<AppointmentListItem>> {
  return request<Page<AppointmentListItem>>(
    `${SCHEDULING}/appointments${queryString({ ...filters, cursor, limit: 100 })}`,
    withSignal(options),
  );
}

export async function bookAppointment(
  body: BookAppointmentRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<AppointmentDetail> {
  return request<AppointmentDetail>(`${SCHEDULING}/appointments`, {
    method: 'POST',
    body,
    idempotencyKey,
  });
}

export async function rescheduleAppointment(id: string, slotId: string): Promise<AppointmentDetail> {
  return request<AppointmentDetail>(`${SCHEDULING}/appointments/${id}/reschedule`, {
    method: 'PATCH',
    body: { slotId },
  });
}

export async function confirmAppointment(id: string): Promise<AppointmentDetail> {
  return request<AppointmentDetail>(`${SCHEDULING}/appointments/${id}/confirm`, {
    method: 'PATCH',
    body: {},
  });
}

/** `appointment.cancel` is `requiresReason`: the header is refused-on-absence, not optional. */
export async function cancelAppointment(
  id: string,
  body: CancelAppointmentRequest,
  reason: string,
): Promise<AppointmentDetail> {
  return request<AppointmentDetail>(`${SCHEDULING}/appointments/${id}/cancel`, {
    method: 'PATCH',
    body,
    reason,
  });
}

export async function checkInAppointment(
  id: string,
  body: CheckInRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<CheckInResult> {
  return request<CheckInResult>(`${SCHEDULING}/appointments/${id}/check-in`, {
    method: 'POST',
    body,
    idempotencyKey,
  });
}

export async function searchPatients(
  params: { readonly q?: string; readonly mobile?: string; readonly uhid?: string },
  options: Signal = {},
): Promise<Page<PatientListItem>> {
  return request<Page<PatientListItem>>(
    `${SCHEDULING}/patients${queryString({ ...params, limit: 10 })}`,
    withSignal(options),
  );
}

// ── queue ────────────────────────────────────────────────────────────────────

export async function listTokens(
  filters: { readonly queueId: string; readonly date?: string },
  options: Signal = {},
): Promise<Page<TokenView>> {
  return request<Page<TokenView>>(
    `${QUEUE}/tokens${queryString({ ...filters, limit: 100 })}`,
    withSignal(options),
  );
}

export async function readBoard(queueId: string, options: Signal = {}): Promise<BoardView> {
  return request<BoardView>(`${QUEUE}/queues/${queueId}/live`, withSignal(options));
}

export async function issueToken(
  body: IssueTokenRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<TokenView> {
  return request<TokenView>(`${QUEUE}/tokens`, { method: 'POST', body, idempotencyKey });
}

export async function callNext(queueId: string, body: CallNextRequest = {}): Promise<TokenView> {
  return request<TokenView>(`${QUEUE}/queues/${queueId}/call-next`, { method: 'POST', body });
}

export async function recallToken(tokenId: string): Promise<TokenView> {
  return request<TokenView>(`${QUEUE}/tokens/${tokenId}/recall`, { method: 'POST', body: {} });
}

/** EN-006 §3.3: a skip is never silent — the reason is in the body and required. */
export async function skipToken(tokenId: string, reason: string): Promise<TokenView> {
  return request<TokenView>(`${QUEUE}/tokens/${tokenId}/skip`, {
    method: 'POST',
    body: { reason },
    reason,
  });
}

export async function completeToken(tokenId: string): Promise<TokenView> {
  return request<TokenView>(`${QUEUE}/tokens/${tokenId}/complete`, { method: 'POST', body: {} });
}

/** `queue.token.manage` is `requiresReason`; the header and the body both carry it. */
export async function transferToken(tokenId: string, toQueueId: string, reason: string): Promise<TokenView> {
  return request<TokenView>(`${QUEUE}/tokens/${tokenId}/transfer`, {
    method: 'POST',
    body: { toQueueId, reason },
    reason,
  });
}

// ── cash ─────────────────────────────────────────────────────────────────────

export async function openShift(body: OpenShiftRequest): Promise<ShiftView> {
  return request<ShiftView>(`${CASH}/shifts/open`, { method: 'POST', body });
}

export async function listShifts(
  filters: { readonly status?: string; readonly counterId?: string; readonly businessDate?: string },
  options: Signal = {},
): Promise<Page<ShiftListItem>> {
  return request<Page<ShiftListItem>>(
    `${CASH}/shifts${queryString({ ...filters, limit: 25 })}`,
    withSignal(options),
  );
}

export async function readShift(shiftId: string, options: Signal = {}): Promise<ShiftView> {
  return request<ShiftView>(`${CASH}/shifts/${shiftId}`, withSignal(options));
}

export async function closePreview(shiftId: string, options: Signal = {}): Promise<ShiftView> {
  return request<ShiftView>(`${CASH}/shifts/${shiftId}/close-preview`, withSignal(options));
}

export async function closeShift(shiftId: string, body: CloseShiftRequest): Promise<ShiftView> {
  return request<ShiftView>(`${CASH}/shifts/${shiftId}/close`, { method: 'POST', body });
}

/** `receipt.shift.variance.approve` is `requiresReason`, and the approver is never the cashier. */
export async function approveVariance(shiftId: string, reason: string): Promise<ShiftView> {
  return request<ShiftView>(`${CASH}/shifts/${shiftId}/variance/approve`, {
    method: 'POST',
    body: {},
    reason,
  });
}

export async function collectPayment(
  body: CollectPaymentRequest,
  idempotencyKey: string,
): Promise<PaymentView> {
  return request<PaymentView>(`${CASH}/payments`, { method: 'POST', body, idempotencyKey });
}

export async function payRefund(refundId: string, body: PayRefundRequest): Promise<RefundView> {
  return request<RefundView>(`${CASH}/refunds/${refundId}/pay`, { method: 'POST', body });
}

export async function voidReceipt(
  receiptId: string,
  body: VoidReceiptRequest,
  reason: string,
): Promise<PaymentView> {
  return request<PaymentView>(`${CASH}/receipts/${receiptId}/void`, { method: 'POST', body, reason });
}
