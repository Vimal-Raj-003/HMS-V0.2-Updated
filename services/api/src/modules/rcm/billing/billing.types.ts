/** OP-005 response shapes. Money is a decimal string in every field. */

export interface BillSummaryView {
  readonly id: string;
  readonly billNo: string;
  readonly patientId: string;
  readonly patientName: string;
  readonly uhid: string;
  readonly visitId: string | null;
  readonly billType: string;
  readonly status: string;
  readonly payerType: string;
  readonly currency: string;
  readonly grossAmount: string;
  readonly discountAmount: string;
  readonly taxableAmount: string;
  readonly cgst: string;
  readonly sgst: string;
  readonly igst: string;
  readonly roundOff: string;
  readonly netAmount: string;
  readonly paidAmount: string;
  readonly balanceAmount: string;
  readonly createdAt: string;
  readonly finalizedAt: string | null;
}

export interface BillItemView {
  readonly id: string;
  readonly itemType: string;
  readonly description: string;
  readonly hsnSac: string | null;
  readonly qty: string;
  readonly unitPrice: string;
  readonly gross: string;
  readonly discountAmount: string;
  readonly taxableValue: string;
  readonly gstRate: string;
  readonly cgst: string;
  readonly sgst: string;
  readonly igst: string;
  readonly isExempt: boolean;
  readonly net: string;
  readonly status: string;
  /** `missing` means the line is held: no rate resolved, and nothing billed. */
  readonly priceStatus: string;
  readonly sourceModule: string;
  readonly sourceRefId: string;
  readonly tariffVersionId: string | null;
  readonly performedAt: string | null;
}

export interface InvoiceView {
  readonly id: string;
  readonly invoiceNo: string;
  readonly seriesKey: string;
  readonly docType: string;
  readonly isB2b: boolean;
  readonly recipientGstin: string | null;
  readonly einvoiceStatus: string;
  readonly status: string;
  readonly issuedAt: string;
  readonly originalInvoiceId: string | null;
}

export interface DiscountRequestView {
  readonly id: string;
  readonly billItemId: string | null;
  readonly requestedBy: string;
  readonly pct: string | null;
  readonly amount: string | null;
  readonly reasonCode: string;
  readonly justification: string | null;
  readonly approvedBy: string | null;
  readonly decidedAt: string | null;
  readonly status: string;
}

export interface BillDetailView extends BillSummaryView {
  readonly items: readonly BillItemView[];
  readonly invoices: readonly InvoiceView[];
  readonly discountRequests: readonly DiscountRequestView[];
}

export interface BillingExceptionView {
  readonly id: string;
  readonly exceptionType: string;
  readonly refId: string | null;
  readonly amount: string | null;
  readonly detail: string | null;
  readonly detectedAt: string;
  readonly status: string;
}
