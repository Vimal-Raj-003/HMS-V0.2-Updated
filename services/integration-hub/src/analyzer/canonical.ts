/**
 * The protocol-neutral shapes an analyzer driver produces and consumes.
 *
 * EN-017 §3.3 is the rule being followed: adapters hand back canonical objects,
 * never their own shapes, so N connectors need N mappings rather than N². Here
 * it earns its keep immediately — an HL7 `OBX` and an ASTM `R` record carry the
 * same seven facts in a different order, and everything downstream of this file
 * (mapping, the unmatched queue, the sink) is written once against these types
 * rather than twice against two wire formats.
 *
 * ── What is deliberately *not* resolved here ────────────────────────────────
 *
 * `specimenIdRaw` is the barcode **exactly as it arrived**, and there is no
 * `sampleId` field. `docs/prompts/phase-03` §Constraints: "Never let a result
 * exist without a patient identity check. Unmatched analyzer results go to a
 * queue, never auto-assigned by name similarity." Resolving a barcode to a
 * specimen is a laboratory decision that belongs to OP-004, reached through
 * `LabResultSink`; this service's job is to carry the bytes there without
 * losing them and without guessing.
 *
 * `patientName` is present for one purpose only — the identity cross-check in
 * `EN-004 §3.3.1`, performed by the sink — and it is named so that
 * `redaction/phi-redactor.ts` masks it on the searchable copy without anyone
 * having to remember to.
 */

export type AnalyzerProtocol = 'hl7_v2' | 'astm_e1394';

export type AnalyzerValueType = 'numeric' | 'coded' | 'text';

export type ValueOperator = '<' | '>' | '<=' | '>=' | '~';

/** Demographics as the analyzer believes them. Cross-check material, never a key. */
export interface AnalyzerPatientHint {
  readonly patientIdRaw?: string;
  /** Masked by the redactor on the stored copy; used only for the mismatch check. */
  readonly patientName?: string;
  readonly sex?: string;
  readonly birthDate?: string;
}

export interface AnalyzerObservation {
  readonly sequence: number;
  /** The analyzer's own channel code (`GLU`, `WBC`). Meaningless until mapped. */
  readonly instrumentCode: string;
  readonly instrumentCodeName?: string;
  readonly codeSystem?: string;
  readonly valueType: AnalyzerValueType;
  /** Exactly what was on the wire, before any conversion. */
  readonly valueRaw: string;
  readonly valueNumeric?: number;
  readonly valueOperator?: ValueOperator;
  readonly unit?: string;
  readonly referenceRange?: string;
  /** `H`, `L`, `HH`, `A`, `*` — vendor letters, mapped by `flag_map`. */
  readonly abnormalFlags: readonly string[];
  /** `F` final · `P` preliminary · `C` correction · `X` cannot be obtained. */
  readonly resultStatus?: string;
  readonly observedAt?: Date;
  /** Clot, short sample, vendor error codes. Blocks auto-validation downstream. */
  readonly instrumentFlags: readonly string[];
  readonly dilutionFactor?: number;
  readonly comments: readonly string[];
  /** `true` when the analyzer reported this observation against a control material. */
  readonly isControl: boolean;
}

/**
 * One specimen's worth of results from one message.
 *
 * A single ORU may carry several — one per `OBR` — and each is applied
 * independently, because a message in which specimen A resolves and specimen B
 * does not must apply A and queue B rather than refusing both.
 */
export interface AnalyzerResultBatch {
  readonly protocol: AnalyzerProtocol;
  /** `ORU^R01`, or `ASTM_R` for the record protocol. Stored in `msg_type`. */
  readonly messageType: string;
  /** `MSH-10` / the ASTM header's message control id. Half of the idempotency key. */
  readonly controlId: string;
  readonly sendingApplication?: string;
  /** The barcode as it arrived. Never normalised, never guessed at. */
  readonly specimenIdRaw: string;
  /** Which field it came from (`SPM-2.1`, `OBR-3.1`, `O-3`), for the error queue. */
  readonly specimenIdSource: string;
  readonly orderNumber?: string;
  readonly patient?: AnalyzerPatientHint;
  readonly observations: readonly AnalyzerObservation[];
  readonly observedAt?: Date;
  readonly runId?: string;
  readonly operator?: string;
  /** Set when every observation is a control: the batch is QC, not a patient result. */
  readonly isControl: boolean;
}

export interface AnalyzerOrderTest {
  readonly instrumentCode: string;
  readonly name?: string;
  readonly dilutionFactor?: number;
}

/** An order on its way *to* an analyzer — broadcast, or as a host-query reply. */
export interface AnalyzerOrder {
  readonly specimenId: string;
  readonly accessionNo?: string;
  readonly priority: 'stat' | 'routine';
  readonly collectedAt?: Date;
  readonly specimenTypeCode?: string;
  readonly containerCode?: string;
  readonly tests: readonly AnalyzerOrderTest[];
  /** Only populated when the instrument is configured with `send_demographics`. */
  readonly patient?: AnalyzerPatientHint;
  readonly action: 'new' | 'cancel';
  readonly isRerun: boolean;
}

/** "What tests for this barcode?" — `QBP^Q11` or an ASTM `Q` record. */
export interface AnalyzerHostQuery {
  readonly protocol: AnalyzerProtocol;
  readonly messageType: string;
  readonly controlId: string;
  readonly specimenIdRaw: string;
  /** `true` when the analyzer asked for every pending specimen rather than one. */
  readonly isWildcard: boolean;
}

/** What a driver decided a frame was. A driver never applies anything itself. */
export type AnalyzerInbound =
  | { readonly kind: 'results'; readonly batches: readonly AnalyzerResultBatch[] }
  | { readonly kind: 'host_query'; readonly query: AnalyzerHostQuery }
  | { readonly kind: 'acknowledgement'; readonly controlId: string; readonly ackCode: string }
  | { readonly kind: 'ignored'; readonly messageType: string; readonly controlId: string };
