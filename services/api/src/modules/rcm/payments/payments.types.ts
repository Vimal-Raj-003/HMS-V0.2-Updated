/** EN-010 response shapes. Money is a decimal string throughout. */

export interface PayIntentView {
  readonly id: string;
  readonly kind: string;
  readonly refType: string;
  readonly refId: string;
  readonly amount: string;
  readonly currency: string;
  readonly methodHint: string;
  readonly status: string;
  readonly qrImageUrl: string | null;
  readonly linkUrl: string | null;
  readonly expiresAt: string | null;
  readonly createdAt: string;
}

export interface PayPaymentView {
  readonly id: string;
  readonly intentId: string;
  readonly providerPaymentId: string;
  readonly method: string;
  readonly amount: string;
  readonly fee: string;
  readonly status: string;
  readonly capturedAt: string | null;
  readonly rrn: string | null;
  readonly utr: string | null;
}

export interface PayRefundView {
  readonly id: string;
  readonly paymentId: string;
  readonly amount: string;
  readonly reasonCode: string;
  readonly status: string;
  readonly requestedBy: string;
  readonly approvedBy: string | null;
  readonly processedAt: string | null;
}

export interface PayReconExceptionView {
  readonly id: string;
  readonly exceptionType: string;
  readonly amount: string | null;
  readonly refs: Readonly<Record<string, unknown>>;
  readonly status: string;
  readonly notes: string | null;
  readonly createdAt: string;
}

/**
 * What a webhook delivery did.
 *
 * `duplicate` is a success, not an error: it means the replay guard worked.
 * The provider gets a 200 either way, because a non-2xx makes it retry the
 * delivery we have already handled.
 */
export interface WebhookOutcome {
  readonly outcome: 'processed' | 'duplicate' | 'rejected' | 'ignored';
  readonly detail: string;
}
