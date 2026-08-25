/**
 * The HL7 v2 semantic layer: `ORU^R01` in, `OML^O21` / `ORM^O01` / `RSP^K11` out.
 *
 * ── Why the specimen identifier is looked for in several places ─────────────
 *
 * `EN-004 §3.3.1` matches on "sample id (barcode = accession+container)", and
 * every vendor puts it somewhere different: HL7 2.5 says `SPM-2`, Roche and
 * Abbott populate `OBR-3` (filler order number), older Sysmex firmware only
 * fills `OBR-2` (placer). A driver therefore carries an ordered list of fields
 * to try, defaulting to all four, and records **which one answered** — because
 * when a barcode fails to match, "it came from OBR-2 and your analyzer is
 * configured for SPM-2" is the difference between a five-minute fix and an
 * afternoon with a packet capture.
 *
 * ── Why one message can produce several batches ─────────────────────────────
 *
 * A haematology line sends one ORU containing four `OBR` groups for four tubes.
 * If specimen 3 has not been accessioned yet, specimens 1, 2 and 4 must still
 * reach the patient and 3 must reach the unmatched queue. Refusing the whole
 * message because one barcode is unknown would be the loss this interface
 * exists to prevent, so each `OBR` group becomes its own batch.
 */
import type {
  AnalyzerHostQuery,
  AnalyzerObservation,
  AnalyzerOrder,
  AnalyzerPatientHint,
  AnalyzerResultBatch,
  AnalyzerValueType,
  ValueOperator,
} from '../analyzer/canonical.js';
import { DEFAULT_HL7_DELIMITERS, type Hl7Delimiters } from './delimiters.js';
import {
  buildHl7,
  hl7Field,
  hl7Timestamp,
  parseHl7Timestamp,
  type Hl7Message,
  type Hl7Segment,
} from './message.js';

/** `HL70078`. Anything outside this set is a vendor code, not an abnormal flag. */
const HL7_ABNORMAL_FLAGS = new Set([
  'L',
  'H',
  'LL',
  'HH',
  '<',
  '>',
  'N',
  'A',
  'AA',
  'U',
  'D',
  'B',
  'W',
  'S',
  'R',
  'I',
  'MS',
  'VS',
]);

export const DEFAULT_SPECIMEN_ID_FIELDS: readonly string[] = Object.freeze([
  'SPM-2.1',
  'SPM-2.2',
  'OBR-3.1',
  'OBR-2.1',
]);

export interface OruReaderOptions {
  /** Ordered candidate fields for the specimen identifier. */
  readonly specimenIdFields?: readonly string[];
  /**
   * Barcodes matching this are control material, not patients (`EN-004 §3.3.4`).
   * A *source string*, not a `RegExp`, because it arrives from
   * `lab_instruments.connection` as JSON.
   */
  readonly controlSpecimenPattern?: string;
}

function toOperator(raw: string): ValueOperator | undefined {
  switch (raw) {
    case '<':
    case '>':
    case '<=':
    case '>=':
    case '~':
      return raw;
    default:
      return undefined;
  }
}

interface ParsedValue {
  readonly valueType: AnalyzerValueType;
  readonly valueNumeric?: number;
  readonly valueOperator?: ValueOperator;
}

/**
 * `NM` is a plain number, `SN` is `comparator^num1^separator^num2`, and `ST`
 * routinely carries `<0.5` because a technologist typed it that way. All three
 * have to yield a comparator and a number or the value lands in the text column
 * and no reference range ever applies to it again.
 */
function parseValue(hl7Type: string, raw: string, delimiters: Hl7Delimiters): ParsedValue {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { valueType: 'text' };

  if (hl7Type === 'SN') {
    const parts = trimmed.split(delimiters.component);
    const operator = toOperator((parts[0] ?? '').trim());
    const numeric = Number((parts[1] ?? '').trim());
    if (Number.isFinite(numeric)) {
      return {
        valueType: 'numeric',
        valueNumeric: numeric,
        ...(operator === undefined ? {} : { valueOperator: operator }),
      };
    }
    return { valueType: 'text' };
  }

  const match = /^(<=|>=|<|>|~)?\s*([+-]?\d+(?:\.\d+)?(?:[Ee][+-]?\d+)?)$/.exec(trimmed);
  if (match !== null) {
    const operator = match[1] === undefined ? undefined : toOperator(match[1]);
    const numeric = Number(match[2]);
    if (Number.isFinite(numeric)) {
      return {
        valueType: 'numeric',
        valueNumeric: numeric,
        ...(operator === undefined ? {} : { valueOperator: operator }),
      };
    }
  }

  if (hl7Type === 'CE' || hl7Type === 'CWE' || hl7Type === 'ID' || hl7Type === 'IS') {
    return { valueType: 'coded' };
  }
  return { valueType: 'text' };
}

function readPatient(pid: Hl7Segment | undefined): AnalyzerPatientHint | undefined {
  if (pid === undefined) return undefined;
  const patientIdRaw = pid.component(3, 1);
  const patientName = [pid.component(5, 2), pid.component(5, 1)].filter((p) => p.length > 0).join(' ');
  const birthDate = pid.component(7, 1);
  const sex = pid.component(8, 1);
  const hint: AnalyzerPatientHint = {
    ...(patientIdRaw.length === 0 ? {} : { patientIdRaw }),
    ...(patientName.length === 0 ? {} : { patientName }),
    ...(birthDate.length === 0 ? {} : { birthDate }),
    ...(sex.length === 0 ? {} : { sex }),
  };
  return Object.keys(hint).length === 0 ? undefined : hint;
}

interface ObrGroup {
  readonly obr: Hl7Segment;
  readonly segments: readonly Hl7Segment[];
}

function groupByObr(message: Hl7Message): readonly ObrGroup[] {
  const groups: { obr: Hl7Segment; segments: Hl7Segment[] }[] = [];
  let current: { obr: Hl7Segment; segments: Hl7Segment[] } | undefined;
  for (const segment of message.segments) {
    if (segment.name === 'OBR') {
      current = { obr: segment, segments: [] };
      groups.push(current);
      continue;
    }
    current?.segments.push(segment);
  }
  return groups;
}

function resolveSpecimenId(
  fields: readonly string[],
  lookup: ReadonlyMap<string, Hl7Segment>,
): { readonly value: string; readonly source: string } {
  for (const path of fields) {
    const match = /^([A-Z][A-Z0-9]{2})-(\d+)(?:\.(\d+))?$/.exec(path);
    if (match === null) continue;
    const segment = lookup.get(match[1] ?? '');
    if (segment === undefined) continue;
    const value =
      match[3] === undefined
        ? segment.field(Number(match[2])).trim()
        : segment.component(Number(match[2]), Number(match[3])).trim();
    if (value.length > 0) return { value, source: path };
  }
  return { value: '', source: 'none' };
}

function readObservations(
  group: ObrGroup,
  delimiters: Hl7Delimiters,
  isControlSpecimen: boolean,
): readonly AnalyzerObservation[] {
  const observations: AnalyzerObservation[] = [];
  let comments: string[] = [];

  const flush = (): void => {
    const last = observations[observations.length - 1];
    if (last !== undefined && comments.length > 0) {
      observations[observations.length - 1] = { ...last, comments: [...last.comments, ...comments] };
    }
    comments = [];
  };

  for (const segment of group.segments) {
    if (segment.name === 'NTE') {
      const text = segment.text(3).trim();
      if (text.length > 0) comments.push(text);
      continue;
    }
    if (segment.name !== 'OBX') continue;
    flush();

    const hl7Type = segment.component(2, 1).toUpperCase();
    const valueRaw = segment.field(5);
    const parsed = parseValue(hl7Type, segment.text(5), delimiters);
    const flags = segment
      .repetitions(8)
      .map((flag) => flag.split(delimiters.component)[0] ?? '')
      .map((flag) => flag.trim())
      .filter((flag) => flag.length > 0);
    const resultStatus = segment.component(11, 1).toUpperCase();
    const observedAt = parseHl7Timestamp(segment.component(14, 1));
    const unit = segment.component(6, 1);
    const referenceRange = segment.component(7, 1);
    const codeSystem = segment.component(3, 3);
    const instrumentCodeName = segment.component(3, 2);

    // `X` — "cannot be obtained" — is the analyzer telling us it failed. It is
    // an instrument condition, not an abnormal result, and `EN-004 §3.3.5`
    // requires the technologist to be prompted for a rerun rather than shown a
    // value that does not exist.
    const instrumentFlags = flags.filter((flag) => !HL7_ABNORMAL_FLAGS.has(flag.toUpperCase()));
    if (resultStatus === 'X') instrumentFlags.push('cannot_obtain');

    observations.push({
      sequence: observations.length + 1,
      instrumentCode: segment.component(3, 1),
      ...(instrumentCodeName.length === 0 ? {} : { instrumentCodeName }),
      ...(codeSystem.length === 0 ? {} : { codeSystem }),
      valueType: parsed.valueType,
      valueRaw,
      ...(parsed.valueNumeric === undefined ? {} : { valueNumeric: parsed.valueNumeric }),
      ...(parsed.valueOperator === undefined ? {} : { valueOperator: parsed.valueOperator }),
      ...(unit.length === 0 ? {} : { unit }),
      ...(referenceRange.length === 0 ? {} : { referenceRange }),
      abnormalFlags: flags.filter((flag) => HL7_ABNORMAL_FLAGS.has(flag.toUpperCase())),
      ...(resultStatus.length === 0 ? {} : { resultStatus }),
      ...(observedAt === undefined ? {} : { observedAt }),
      instrumentFlags,
      comments: [],
      isControl: isControlSpecimen,
    });
  }
  flush();
  return observations;
}

/** `ORU^R01` → one batch per `OBR` group. */
export function readOru(message: Hl7Message, options: OruReaderOptions = {}): readonly AnalyzerResultBatch[] {
  const delimiters = message.delimiters;
  const fields = options.specimenIdFields ?? DEFAULT_SPECIMEN_ID_FIELDS;
  const controlPattern =
    options.controlSpecimenPattern === undefined ? undefined : new RegExp(options.controlSpecimenPattern);

  const patient = readPatient(message.segment('PID'));
  const messageSpm = message.all('SPM');
  const groups = groupByObr(message);
  const controlId = message.controlId();
  const sendingApplication = message.sendingApplication();

  return groups.map((group) => {
    const groupSpm = group.segments.find((segment) => segment.name === 'SPM');
    const spm = groupSpm ?? (messageSpm.length === 1 ? messageSpm[0] : undefined);

    const lookup = new Map<string, Hl7Segment>([['OBR', group.obr]]);
    if (spm !== undefined) lookup.set('SPM', spm);

    const specimen = resolveSpecimenId(fields, lookup);
    const isControl =
      group.obr.component(11, 1).toUpperCase() === 'Q' ||
      (controlPattern !== undefined && specimen.value.length > 0 && controlPattern.test(specimen.value));

    const observations = readObservations(group, delimiters, isControl);
    const observedAt =
      parseHl7Timestamp(group.obr.component(7, 1)) ??
      observations.find((observation) => observation.observedAt !== undefined)?.observedAt;
    const orderNumber = group.obr.component(2, 1);
    const runId = group.obr.component(3, 1);
    const operator = group.obr.component(34, 1);

    return {
      protocol: 'hl7_v2' as const,
      messageType: message.messageType(),
      controlId,
      ...(sendingApplication.length === 0 ? {} : { sendingApplication }),
      specimenIdRaw: specimen.value,
      specimenIdSource: specimen.source,
      ...(orderNumber.length === 0 ? {} : { orderNumber }),
      ...(patient === undefined ? {} : { patient }),
      observations,
      ...(observedAt === undefined ? {} : { observedAt }),
      ...(runId.length === 0 ? {} : { runId }),
      ...(operator.length === 0 ? {} : { operator }),
      isControl,
    };
  });
}

/** `QBP^Q11` (and the `QRY^Q02` legacy form) → "what tests for this barcode?". */
export function readHostQuery(message: Hl7Message): AnalyzerHostQuery {
  const qpd = message.segment('QPD');
  const qrd = message.segment('QRD');
  const specimenIdRaw =
    qpd?.component(3, 1) ??
    // QRY^Q02 puts the subject in QRD-8.
    qrd?.component(8, 1) ??
    '';
  return {
    protocol: 'hl7_v2',
    messageType: message.messageType(),
    controlId: message.controlId(),
    specimenIdRaw: specimenIdRaw.trim(),
    isWildcard: specimenIdRaw.trim().length === 0 || specimenIdRaw.trim() === 'ALL',
  };
}

export interface OutboundIdentity {
  readonly sendingApplication: string;
  readonly sendingFacility: string;
  readonly receivingApplication: string;
  readonly receivingFacility: string;
  readonly version?: string;
  readonly processingId?: string;
}

function mshSegment(
  identity: OutboundIdentity,
  messageType: string,
  controlId: string,
  now: Date,
  d: Hl7Delimiters,
): string[] {
  return [
    'MSH',
    `${d.component}${d.repetition}${d.escape}${d.subcomponent}`,
    hl7Field(identity.sendingApplication, d),
    hl7Field(identity.sendingFacility, d),
    hl7Field(identity.receivingApplication, d),
    hl7Field(identity.receivingFacility, d),
    hl7Timestamp(now),
    '',
    messageType,
    hl7Field(controlId, d),
    identity.processingId ?? 'P',
    identity.version ?? '2.5.1',
  ];
}

function pidSegment(patient: AnalyzerPatientHint, d: Hl7Delimiters): string[] {
  return [
    'PID',
    '1',
    '',
    hl7Field(patient.patientIdRaw ?? '', d),
    '',
    hl7Field(patient.patientName ?? '', d),
    '',
    hl7Field(patient.birthDate ?? '', d),
    hl7Field(patient.sex ?? '', d),
  ];
}

function orderSegments(order: AnalyzerOrder, d: Hl7Delimiters, startSequence = 1): string[][] {
  const priority = order.priority === 'stat' ? 'S' : 'R';
  const control = order.action === 'cancel' ? 'CA' : 'NW';
  const segments: string[][] = [];

  order.tests.forEach((test, index) => {
    const sequence = String(startSequence + index);
    segments.push([
      'ORC',
      control,
      hl7Field(order.specimenId, d),
      hl7Field(order.accessionNo ?? order.specimenId, d),
    ]);
    segments.push([
      'OBR',
      sequence,
      hl7Field(order.specimenId, d),
      hl7Field(order.accessionNo ?? order.specimenId, d),
      `${hl7Field(test.instrumentCode, d)}${d.component}${hl7Field(test.name ?? test.instrumentCode, d)}`,
      priority,
      '',
      order.collectedAt === undefined ? '' : hl7Timestamp(order.collectedAt),
      '',
      '',
      order.isRerun ? 'R' : '',
    ]);
  });

  segments.push([
    'SPM',
    '1',
    hl7Field(order.specimenId, d),
    '',
    hl7Field(order.specimenTypeCode ?? '', d),
    '',
    '',
    '',
    '',
    '',
    '',
    hl7Field(order.containerCode ?? '', d),
  ]);

  return segments;
}

/** `OML^O21` — the modern order message (`EN-004 §3.2.1`). */
export function buildOml(input: {
  readonly identity: OutboundIdentity;
  readonly order: AnalyzerOrder;
  readonly controlId: string;
  readonly now: Date;
  readonly delimiters?: Hl7Delimiters;
}): string {
  const d = input.delimiters ?? DEFAULT_HL7_DELIMITERS;
  const segments: string[][] = [
    mshSegment(input.identity, `OML${d.component}O21${d.component}OML_O21`, input.controlId, input.now, d),
  ];
  if (input.order.patient !== undefined) segments.push(pidSegment(input.order.patient, d));
  segments.push(...orderSegments(input.order, d));
  return buildHl7(segments, d);
}

/** `ORM^O01` — the legacy order message some analyzers still require. */
export function buildOrm(input: {
  readonly identity: OutboundIdentity;
  readonly order: AnalyzerOrder;
  readonly controlId: string;
  readonly now: Date;
  readonly delimiters?: Hl7Delimiters;
}): string {
  const d = input.delimiters ?? DEFAULT_HL7_DELIMITERS;
  const segments: string[][] = [
    mshSegment(input.identity, `ORM${d.component}O01`, input.controlId, input.now, d),
  ];
  if (input.order.patient !== undefined) segments.push(pidSegment(input.order.patient, d));
  segments.push(...orderSegments(input.order, d));
  return buildHl7(segments, d);
}

/**
 * `RSP^K11` — the host-query reply.
 *
 * `EN-004 §14.2` gives it a hard two-second budget because the analyzer times
 * out and aspirates without the order, so the reply is built from the worklist
 * cache and touches nothing else.
 */
export function buildRspK11(input: {
  readonly identity: OutboundIdentity;
  readonly query: AnalyzerHostQuery;
  readonly orders: readonly AnalyzerOrder[];
  readonly controlId: string;
  readonly queryTag: string;
  readonly now: Date;
  readonly delimiters?: Hl7Delimiters;
}): string {
  const d = input.delimiters ?? DEFAULT_HL7_DELIMITERS;
  const found = input.orders.length > 0;
  const segments: string[][] = [
    mshSegment(input.identity, `RSP${d.component}K11${d.component}RSP_K11`, input.controlId, input.now, d),
    ['MSA', 'AA', hl7Field(input.query.controlId, d)],
    [
      'QAK',
      hl7Field(input.queryTag, d),
      found ? 'OK' : 'NF',
      `WOS${d.component}Work Order Specimen${d.component}HL70471`,
      String(input.orders.length),
    ],
    [
      'QPD',
      `WOS${d.component}Work Order Specimen${d.component}HL70471`,
      hl7Field(input.queryTag, d),
      hl7Field(input.query.specimenIdRaw, d),
    ],
  ];

  let sequence = 1;
  for (const order of input.orders) {
    if (order.patient !== undefined) segments.push(pidSegment(order.patient, d));
    const group = orderSegments(order, d, sequence);
    sequence += order.tests.length;
    segments.push(...group);
  }

  return buildHl7(segments, d);
}
