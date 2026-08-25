/**
 * ASTM E1394 to the canonical shapes, and back.
 *
 * The record layer is positional, so every field number here is a claim about
 * the standard and is written next to the code that reads it. The two that
 * cause the most field incidents:
 *
 *  * **`O-3` is the specimen id and `O-4` is the analyzer's own id for the same
 *    tube.** Reading `O-4` gives a number that looks like a barcode, matches
 *    nothing, and sends every result to the unmatched queue.
 *  * **`R-3` is a *composite* universal test id**, conventionally `^^^CODE`,
 *    but Erba writes `^^^^CODE` and some Mindray firmware writes the bare code
 *    in component 1. So the reader tries components 4, 5, 3 and 1 in that order
 *    and stops at the first non-empty one, rather than insisting on a layout
 *    the analyzer in front of it may not use.
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
import {
  DEFAULT_ASTM_DELIMITERS,
  astmTimestamp,
  astmValue,
  buildAstmRecord,
  parseAstmTimestamp,
  parseAstmTransmission,
  type AstmDelimiters,
  type AstmRecord,
} from './records.js';

const ASTM_ABNORMAL_FLAGS = new Set(['L', 'H', 'LL', 'HH', '<', '>', 'N', 'A', 'AA', 'U', 'D', 'B', 'W']);

/** Components of `R-3`/`O-5` to try, in order. */
const TEST_CODE_COMPONENTS: readonly number[] = [4, 5, 3, 1];

export interface AstmReaderOptions {
  readonly controlSpecimenPattern?: string;
}

function testCode(record: AstmRecord, field: number): { readonly code: string; readonly name: string } {
  for (const component of TEST_CODE_COMPONENTS) {
    const code = record.component(field, component).trim();
    if (code.length > 0) {
      return { code, name: record.component(field, component + 1).trim() };
    }
  }
  return { code: '', name: '' };
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

function parseValue(raw: string): {
  readonly valueType: AnalyzerValueType;
  readonly valueNumeric?: number;
  readonly valueOperator?: ValueOperator;
} {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { valueType: 'text' };
  const match = /^(<=|>=|<|>|~)?\s*([+-]?\d+(?:\.\d+)?(?:[Ee][+-]?\d+)?)$/.exec(trimmed);
  if (match !== null) {
    const numeric = Number(match[2]);
    if (Number.isFinite(numeric)) {
      const operator = match[1] === undefined ? undefined : toOperator(match[1]);
      return {
        valueType: 'numeric',
        valueNumeric: numeric,
        ...(operator === undefined ? {} : { valueOperator: operator }),
      };
    }
  }
  return { valueType: 'text' };
}

function readPatient(record: AstmRecord | undefined): AnalyzerPatientHint | undefined {
  if (record === undefined) return undefined;
  const patientIdRaw = record.field(3).trim() || record.field(4).trim();
  const patientName = [record.component(6, 2), record.component(6, 1)]
    .filter((part) => part.length > 0)
    .join(' ');
  const birthDate = record.field(8).trim();
  const sex = record.field(9).trim();
  const hint: AnalyzerPatientHint = {
    ...(patientIdRaw.length === 0 ? {} : { patientIdRaw }),
    ...(patientName.length === 0 ? {} : { patientName }),
    ...(birthDate.length === 0 ? {} : { birthDate }),
    ...(sex.length === 0 ? {} : { sex }),
  };
  return Object.keys(hint).length === 0 ? undefined : hint;
}

function splitFlags(raw: string): readonly string[] {
  return raw
    .split(/[\s,^\\|]+/)
    .map((flag) => flag.trim())
    .filter((flag) => flag.length > 0);
}

/**
 * Reads a complete transmission into one batch per `O` record.
 *
 * `controlId` comes from `H-13` (the header's message control id) where the
 * analyzer sets it, and falls back to the caller's frame digest otherwise,
 * because half of ASTM analyzers leave it empty and an idempotency key that is
 * empty for every message is not an idempotency key.
 */
export function readAstmResults(
  records: readonly string[],
  fallbackControlId: string,
  options: AstmReaderOptions = {},
): readonly AnalyzerResultBatch[] {
  const transmission = parseAstmTransmission(records);
  const header = transmission.records.find((record) => record.type === 'H');
  // `H-3` is the message control id. `H-13` is the version number, and reading
  // it instead gives every transmission the control id "1".
  const controlIdRaw = header?.field(3).trim() ?? '';
  const controlId = controlIdRaw.length > 0 ? controlIdRaw : fallbackControlId;
  const sendingApplication = header?.component(5, 1) ?? '';
  const controlPattern =
    options.controlSpecimenPattern === undefined ? undefined : new RegExp(options.controlSpecimenPattern);

  const batches: AnalyzerResultBatch[] = [];
  let patient: AnalyzerPatientHint | undefined;
  let batch: AnalyzerResultBatch | undefined;
  let observations: AnalyzerObservation[] = [];
  let operator: string | undefined;

  const commit = (): void => {
    if (batch === undefined) return;
    batches.push({
      ...batch,
      observations,
      ...(operator === undefined ? {} : { operator }),
    });
    batch = undefined;
    observations = [];
    operator = undefined;
  };

  for (const record of transmission.records) {
    switch (record.type) {
      case 'P':
        commit();
        patient = readPatient(record);
        break;

      case 'O': {
        commit();
        const specimenIdRaw = record.field(3).trim();
        const actionCode = record.field(12).trim().toUpperCase();
        const isControl =
          actionCode === 'Q' ||
          (controlPattern !== undefined && specimenIdRaw.length > 0 && controlPattern.test(specimenIdRaw));
        const observedAt = parseAstmTimestamp(record.field(8)) ?? parseAstmTimestamp(record.field(7));
        const orderNumber = record.field(4).trim();
        batch = {
          protocol: 'astm_e1394',
          messageType: 'ASTM_R',
          controlId,
          ...(sendingApplication.length === 0 ? {} : { sendingApplication }),
          specimenIdRaw,
          specimenIdSource: 'O-3',
          ...(orderNumber.length === 0 ? {} : { orderNumber }),
          ...(patient === undefined ? {} : { patient }),
          observations: [],
          ...(observedAt === undefined ? {} : { observedAt }),
          isControl,
        };
        break;
      }

      case 'R': {
        if (batch === undefined) break;
        const { code, name } = testCode(record, 3);
        const raw = record.field(4);
        const parsed = parseValue(raw);
        const flags = splitFlags(record.field(7));
        const resultStatus = record.field(9).trim().toUpperCase();
        const observedAt = parseAstmTimestamp(record.field(13)) ?? parseAstmTimestamp(record.field(12));
        const unit = record.field(5).trim();
        const referenceRange = record.field(6).trim();
        const instrumentFlags = flags.filter((flag) => !ASTM_ABNORMAL_FLAGS.has(flag.toUpperCase()));
        if (resultStatus === 'X') instrumentFlags.push('cannot_obtain');

        const recordOperator = record.field(11).trim();
        if (recordOperator.length > 0 && operator === undefined) operator = recordOperator;

        observations.push({
          sequence: observations.length + 1,
          instrumentCode: code,
          ...(name.length === 0 ? {} : { instrumentCodeName: name }),
          valueType: parsed.valueType,
          valueRaw: raw,
          ...(parsed.valueNumeric === undefined ? {} : { valueNumeric: parsed.valueNumeric }),
          ...(parsed.valueOperator === undefined ? {} : { valueOperator: parsed.valueOperator }),
          ...(unit.length === 0 ? {} : { unit }),
          ...(referenceRange.length === 0 ? {} : { referenceRange }),
          abnormalFlags: flags.filter((flag) => ASTM_ABNORMAL_FLAGS.has(flag.toUpperCase())),
          ...(resultStatus.length === 0 ? {} : { resultStatus }),
          ...(observedAt === undefined ? {} : { observedAt }),
          instrumentFlags,
          comments: [],
          isControl: batch.isControl,
        });
        break;
      }

      case 'C': {
        const text = record.field(4).trim();
        const last = observations[observations.length - 1];
        if (text.length > 0 && last !== undefined) {
          observations[observations.length - 1] = { ...last, comments: [...last.comments, text] };
        }
        break;
      }

      case 'L':
        commit();
        break;

      default:
        break;
    }
  }
  commit();

  return batches;
}

/** A `Q` record: "what tests for this barcode?". */
export function readAstmQuery(records: readonly string[]): AnalyzerHostQuery | undefined {
  const transmission = parseAstmTransmission(records);
  const query = transmission.records.find((record) => record.type === 'Q');
  if (query === undefined) return undefined;
  const header = transmission.records.find((record) => record.type === 'H');
  const controlId = header?.field(3).trim() ?? '';

  // `Q-3` is `patientId^specimenId^...`; analyzers that identify by barcode put
  // it in component 2, and the ones that do not fill component 1 instead.
  const specimenIdRaw = (query.component(3, 2) || query.component(3, 1) || '').trim();
  const isWildcard = specimenIdRaw.length === 0 || specimenIdRaw.toUpperCase() === 'ALL';

  return {
    protocol: 'astm_e1394',
    messageType: 'ASTM_Q',
    controlId,
    specimenIdRaw: isWildcard ? '' : specimenIdRaw,
    isWildcard,
  };
}

export interface AstmIdentity {
  readonly sendingApplication: string;
  readonly receivingApplication: string;
}

/**
 * `H-1` and `H-2` share the first joined element (the record type carries the
 * field delimiter that separates it from the delimiter definition), so element
 * `i` is field `i + 2` from there on: `H-3` control id, `H-5` sender, `H-10`
 * receiver, `H-12` processing id, `H-13` version, `H-14` timestamp.
 */
function headerRecord(identity: AstmIdentity, controlId: string, now: Date, d: AstmDelimiters): string {
  return [
    `H${d.field}${d.repeat}${d.component}${d.escape}`,
    astmValue(controlId, d),
    '',
    astmValue(identity.sendingApplication, d),
    '',
    '',
    '',
    '',
    astmValue(identity.receivingApplication, d),
    '',
    'P',
    '1',
    astmTimestamp(now),
  ].join(d.field);
}

/**
 * Builds the `H`/`P`/`O`/`L` records that answer a host query or broadcast an
 * order. One `O` record per specimen; the tests repeat inside `O-5` with the
 * repeat delimiter, which is what analyzers expect and what keeps a
 * twenty-test panel to one record.
 */
export function buildAstmOrders(input: {
  readonly identity: AstmIdentity;
  readonly orders: readonly AnalyzerOrder[];
  readonly controlId: string;
  readonly now: Date;
  readonly delimiters?: AstmDelimiters;
}): readonly string[] {
  const d = input.delimiters ?? DEFAULT_ASTM_DELIMITERS;
  const records: string[] = [headerRecord(input.identity, input.controlId, input.now, d)];

  input.orders.forEach((order, index) => {
    const sequence = String(index + 1);
    records.push(
      buildAstmRecord(
        [
          'P',
          sequence,
          astmValue(order.patient?.patientIdRaw ?? '', d),
          '',
          '',
          astmValue(order.patient?.patientName ?? '', d),
          '',
          astmValue(order.patient?.birthDate ?? '', d),
          astmValue(order.patient?.sex ?? '', d),
        ],
        d,
      ),
    );

    const tests = order.tests
      .map((test) => `${d.component.repeat(3)}${astmValue(test.instrumentCode, d)}`)
      .join(d.repeat);

    records.push(
      buildAstmRecord(
        [
          'O',
          sequence,
          astmValue(order.specimenId, d),
          astmValue(order.accessionNo ?? order.specimenId, d),
          tests,
          order.priority === 'stat' ? 'S' : 'R',
          astmTimestamp(input.now),
          order.collectedAt === undefined ? '' : astmTimestamp(order.collectedAt),
          '',
          '',
          '',
          order.action === 'cancel' ? 'C' : order.isRerun ? 'Q' : 'N',
          '',
          '',
          '',
          astmValue(order.specimenTypeCode ?? '', d),
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          'O',
        ],
        d,
      ),
    );
  });

  records.push(buildAstmRecord(['L', '1', 'N'], d));
  return records;
}
