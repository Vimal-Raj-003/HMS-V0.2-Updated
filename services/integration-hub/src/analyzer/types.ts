/**
 * The analyzer interface's own vocabulary: the instrument as this service sees
 * it, the mapped observation it produces, and the one port through which a
 * result reaches the laboratory.
 *
 * ── Why `LabResultSink` is a port and not a database call ───────────────────
 *
 * The hub owns `integration.lab_*`. It does **not** own `lab.lab_samples`,
 * `lab.lab_orders` or `lab.lab_results`: `CLAUDE.md` §3 — "nothing calls another
 * module's tables directly" — and `EN-004 §4` puts the interface tables in
 * `integration` precisely because a raw frame is a transport concern while a
 * measured value is a laboratory record. Resolving a barcode to a specimen also
 * carries the identity check that `docs/prompts/phase-03` §Constraints makes
 * non-negotiable, and that check belongs to OP-004, which knows what a rejected
 * specimen is and what a finalised result is.
 *
 * So the last hop is an interface. `services/api` implements it over
 * `LabSamplesService`/`LabResultsService`; the integration suite implements it
 * with a recording fake; nothing else changes between the two.
 *
 * ── Why the outcome union is shaped like this ───────────────────────────────
 *
 * Every member answers "what happens to the buffered message now?", and the
 * answer is different in a way no boolean could carry:
 *
 *  * `applied` / `duplicate` — done, the message is complete.
 *  * `unmatched_sample`, `unmapped_code`, `patient_mismatch`,
 *    `rejected_sample`, `result_after_final` — a human has to decide. The
 *    message is retained, an error-queue row is opened, and **the analyzer's
 *    queue keeps moving**, because one unknown barcode must not stop a
 *    haematology line for the rest of the shift.
 *  * `unavailable` — the laboratory could not be reached at all. The message
 *    stays buffered, in order, and nothing after it is attempted. This is the
 *    branch exit gate 7 exercises.
 */
import type { AnalyzerObservation, AnalyzerProtocol, AnalyzerResultBatch } from './canonical.js';

export type LabIfProtocol = 'hl7_v2' | 'astm_e1394' | 'lis2_a2' | 'poct1_a' | 'csv' | 'proprietary';

export type LabIfTransport = 'tcp_server' | 'tcp_client' | 'serial' | 'file_watch' | 'http';

export type LabInstrumentStatus =
  | 'draft'
  | 'verification'
  | 'live'
  | 'maintenance'
  | 'out_of_service'
  | 'requalification_pending'
  | 'retired';

export type LabIfDirection = 'inbound' | 'outbound';

export type LabIfMessageStatus =
  'received' | 'parsed' | 'matched' | 'applied' | 'acked' | 'nak' | 'error' | 'replayed' | 'buffered';

export type LabIfErrorType =
  | 'unmatched_sample'
  | 'unmapped_code'
  | 'patient_mismatch'
  | 'parse_error'
  | 'duplicate'
  | 'nak'
  | 'qc_unassigned'
  | 'rejected_sample'
  | 'instrument_not_live'
  | 'result_after_final';

/** Driver-specific knobs, from `integration.lab_instruments.connection`. */
export interface AnalyzerConnection {
  readonly host?: string;
  readonly port?: number;
  /** How this LIS names itself to the analyzer (`MSH-3`/`MSH-4`, ASTM `H-5`). */
  readonly sendingApplication: string;
  readonly sendingFacility: string;
  readonly receivingApplication: string;
  readonly receivingFacility: string;
  readonly hl7Version: string;
  /** Ordered candidate fields for the specimen id, e.g. `['SPM-2.1','OBR-3.1']`. */
  readonly specimenIdFields?: readonly string[];
  /** Barcodes matching this are control material, routed to QC rather than a patient. */
  readonly controlSpecimenPattern?: string;
  readonly maxFrameBytes?: number;
}

export interface AnalyzerInstrument {
  readonly id: string;
  readonly hospitalId: string;
  readonly branchId: string;
  readonly code: string;
  readonly name: string;
  readonly driverKey: string;
  readonly protocol: LabIfProtocol;
  readonly transport: LabIfTransport;
  readonly connection: AnalyzerConnection;
  readonly hostQueryMode: boolean;
  readonly sendDemographics: boolean;
  readonly status: LabInstrumentStatus;
  readonly rawRetentionDays: number;
  readonly isBuffering: boolean;
}

/** One row of `integration.lab_instrument_test_maps`. */
export interface InstrumentTestMap {
  readonly id: string;
  readonly instrumentId: string;
  readonly instrumentCode: string;
  readonly instrumentSampleTypeCode: string | null;
  readonly testKey: string;
  readonly parameterKey: string | null;
  readonly loincCode: string | null;
  readonly unitFactor: number | null;
  readonly unitOffset: number | null;
  readonly targetUnit: string | null;
  readonly precision: number | null;
  readonly resultType: string;
  readonly flagMap: Readonly<Record<string, string>> | null;
  readonly isActive: boolean;
}

/** An observation whose analyzer code has been resolved to a laboratory test. */
export interface MappedObservation {
  readonly observation: AnalyzerObservation;
  readonly testKey: string;
  readonly parameterKey: string | null;
  readonly loincCode: string | null;
  /** After `unit_factor`/`unit_offset` and `precision`. `undefined` for non-numeric. */
  readonly valueNumeric?: number;
  readonly unit: string | null;
  /** `flag_map` applied: `H` becomes `high`, and an unmapped letter stays as it came. */
  readonly flags: readonly string[];
}

/** An observation whose code this instrument has no mapping for. Never applied. */
export interface UnmappedObservation {
  readonly observation: AnalyzerObservation;
  readonly reason: 'unmapped_code' | 'inactive_map';
}

/**
 * One specimen's results, mapped and ready for the laboratory.
 *
 * `raw` is not here on purpose: the sink applies values, and the bytes stay in
 * `integration.lab_if_messages` where `EN-004 §5`'s 90-day encrypted retention
 * and the `integration.lab.raw.read` gate apply to them.
 */
export interface LabResultDelivery {
  readonly hospitalId: string;
  readonly branchId: string;
  readonly instrumentId: string;
  readonly instrumentCode: string;
  readonly protocol: AnalyzerProtocol;
  /** `integration.lab_if_messages.id` — the join back to the bytes. */
  readonly messageId: string;
  readonly receivedAt: Date;
  readonly batch: AnalyzerResultBatch;
  readonly observations: readonly MappedObservation[];
  readonly unmapped: readonly UnmappedObservation[];
}

export type LabResultOutcome =
  | { readonly status: 'applied'; readonly sampleId: string; readonly resultCount: number }
  | { readonly status: 'duplicate'; readonly sampleId: string }
  | { readonly status: 'unmatched_sample'; readonly suggestion?: SampleSuggestion }
  | { readonly status: 'rejected_sample'; readonly sampleId: string; readonly reason: string }
  | { readonly status: 'patient_mismatch'; readonly sampleId: string; readonly detail: string }
  | { readonly status: 'result_after_final'; readonly sampleId: string }
  | { readonly status: 'instrument_not_live' }
  /** Transient. The message stays buffered and the queue stops here. */
  | { readonly status: 'unavailable'; readonly reason: string };

/**
 * A candidate the laboratory *may* offer an operator.
 *
 * It is carried, stored and displayed. It is never applied: the CHECK
 * constraint `lab_if_error_queue_assignment_is_human` makes
 * `resolved_sample_id` unsettable without a `resolved_by`, so this is a
 * suggestion in the database as well as in the code.
 */
export interface SampleSuggestion {
  readonly sampleId: string;
  readonly basis: string;
}

/** QC material results, routed away from patients (`EN-004 §3.3.4`). */
export type LabControlOutcome =
  | { readonly status: 'applied'; readonly runCount: number }
  | { readonly status: 'unassigned'; readonly reason: string }
  | { readonly status: 'unavailable'; readonly reason: string };

/**
 * The laboratory, as this service is allowed to see it.
 *
 * Implemented by `services/api` (see the note at the top of this file). Every
 * method must be **idempotent on `messageId`**: the store-and-forward loop is
 * at-least-once by construction, and a sink that applied the same message twice
 * would put a second result on a patient's report.
 */
export interface LabResultSink {
  deliver(delivery: LabResultDelivery): Promise<LabResultOutcome>;
  /** Optional: an instrument with no QC configuration simply never calls it. */
  deliverControl?(delivery: LabResultDelivery): Promise<LabControlOutcome>;
}

/** What the ingress decided about one inbound frame. Drives the acknowledgement. */
export type IngressDecision =
  | {
      readonly kind: 'stored';
      readonly messageId: string;
      readonly receivedAt: string;
      readonly messageType: string;
      readonly controlId: string;
    }
  | { readonly kind: 'duplicate'; readonly messageId: string; readonly controlId: string }
  | {
      readonly kind: 'rejected';
      readonly errorCode: string;
      readonly detail: string;
      readonly controlId: string;
    };
