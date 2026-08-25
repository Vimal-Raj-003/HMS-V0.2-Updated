/**
 * ASTM E1394 — the record layer: `H` header, `P` patient, `O` order, `R` result,
 * `C` comment, `Q` query, `M` manufacturer, `L` terminator.
 *
 * Like HL7's `MSH-2`, the `H` record *declares its own delimiters* in field 2 —
 * conventionally `\^&` for repeat, component and escape, with the field
 * delimiter being whatever character follows the `H`. Almost every analyzer
 * sends `H|\^&`, and the ones that do not are again the ones a hard-coded
 * parser would quietly mangle. So delimiters are read, never assumed.
 *
 * Field numbering follows the standard: field 1 is the record type, field 2 the
 * delimiter definition, so `record.field(3)` is the third ASTM field. Getting
 * this off by one is how `O-3` (the specimen id) is read as `O-2` (a sequence
 * number) and every result lands in the unmatched queue.
 */

export interface AstmDelimiters {
  readonly field: string;
  readonly repeat: string;
  readonly component: string;
  readonly escape: string;
}

export const DEFAULT_ASTM_DELIMITERS: AstmDelimiters = Object.freeze({
  field: '|',
  repeat: '\\',
  component: '^',
  escape: '&',
});

export type AstmErrorCode = 'not_astm' | 'bad_delimiters' | 'no_header' | 'empty_record';

export class AstmParseError extends Error {
  constructor(
    readonly code: AstmErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AstmParseError';
  }
}

/** Reads the delimiters an `H` record declares. */
export function readAstmDelimiters(header: string): AstmDelimiters {
  if (!header.startsWith('H')) {
    throw new AstmParseError('no_header', 'an ASTM transmission begins with an H record');
  }
  const field = header[1];
  if (field === undefined || /[A-Za-z0-9\r\n]/.test(field)) {
    throw new AstmParseError(
      'bad_delimiters',
      `the H record's field delimiter is ${JSON.stringify(field ?? '')}, which cannot separate fields`,
    );
  }
  const definition = header.slice(2, header.indexOf(field, 2) === -1 ? undefined : header.indexOf(field, 2));
  if (definition.length < 3) {
    throw new AstmParseError(
      'bad_delimiters',
      `the H record must declare repeat, component and escape delimiters (got ${JSON.stringify(definition)})`,
    );
  }
  const repeat = definition[0] ?? '';
  const component = definition[1] ?? '';
  const escape = definition[2] ?? '';
  const all = [field, repeat, component, escape];
  if (new Set(all).size !== all.length) {
    throw new AstmParseError(
      'bad_delimiters',
      `the declared delimiters are not distinct: ${JSON.stringify(all.join(''))}`,
    );
  }
  return { field, repeat, component, escape };
}

export class AstmRecord {
  constructor(
    readonly type: string,
    private readonly values: readonly string[],
    private readonly delimiters: AstmDelimiters,
    private readonly rawText: string,
  ) {}

  raw(): string {
    return this.rawText;
  }

  /** ASTM field `n`, 1-based: `field(1)` is the record type. */
  field(n: number): string {
    return this.values[n - 1] ?? '';
  }

  /** Component `c` of field `n`. The delimiter definition field is never split. */
  component(n: number, c = 1): string {
    if (n === 2 && (this.type === 'H' || this.type === 'h')) return this.field(2);
    const parts = this.field(n).split(this.delimiters.component);
    return (parts[c - 1] ?? '').trim();
  }

  repetitions(n: number): readonly string[] {
    if (n === 2 && this.type === 'H') return [this.field(2)];
    return this.field(n).split(this.delimiters.repeat);
  }
}

/** Parses one record. `H` carries its own delimiters and is parsed specially. */
export function parseAstmRecord(raw: string, delimiters: AstmDelimiters): AstmRecord {
  const text = raw.replace(/[\r\n]+$/, '');
  if (text.length === 0) throw new AstmParseError('empty_record', 'an ASTM record cannot be empty');
  const parts = text.split(delimiters.field);
  const type = (parts[0] ?? '').trim().toUpperCase();
  if (!/^[A-Z]$/.test(type)) {
    throw new AstmParseError('not_astm', `${JSON.stringify(parts[0] ?? '')} is not an ASTM record type`);
  }
  return new AstmRecord(type, parts, delimiters, text);
}

export interface ParsedAstmTransmission {
  readonly delimiters: AstmDelimiters;
  readonly records: readonly AstmRecord[];
}

/**
 * Parses a complete transmission (the records between `ENQ` and `EOT`).
 *
 * The `H` record must come first: it is where the delimiters are declared, and
 * a transmission without one cannot be read at all — which is a reject, not a
 * best-effort guess.
 */
export function parseAstmTransmission(records: readonly string[]): ParsedAstmTransmission {
  const first = records.find((record) => record.trim().length > 0);
  if (first === undefined) throw new AstmParseError('empty_record', 'the transmission carried no records');
  const delimiters = readAstmDelimiters(first.trim());
  return {
    delimiters,
    records: records
      .map((record) => record.replace(/[\r\n]+$/, ''))
      .filter((record) => record.trim().length > 0)
      .map((record) => parseAstmRecord(record, delimiters)),
  };
}

/** Builds one record from already-composed fields. */
export function buildAstmRecord(
  fields: readonly string[],
  delimiters: AstmDelimiters = DEFAULT_ASTM_DELIMITERS,
): string {
  return fields.join(delimiters.field);
}

/**
 * Escapes a data value.
 *
 * A patient name containing `&` — not rare — would otherwise introduce an
 * escape sequence into the middle of a field. E1394 §6.5 gives the four
 * `&X&` forms; nothing else is a legal escape.
 */
export function astmValue(value: string, delimiters: AstmDelimiters = DEFAULT_ASTM_DELIMITERS): string {
  let out = '';
  for (const char of value) {
    switch (char) {
      case delimiters.escape:
        out += `${delimiters.escape}E${delimiters.escape}`;
        break;
      case delimiters.field:
        out += `${delimiters.escape}F${delimiters.escape}`;
        break;
      case delimiters.repeat:
        out += `${delimiters.escape}R${delimiters.escape}`;
        break;
      case delimiters.component:
        out += `${delimiters.escape}S${delimiters.escape}`;
        break;
      case '\r':
      case '\n':
        out += ' ';
        break;
      default:
        out += char;
    }
  }
  return out;
}

/** `YYYYMMDDHHMMSS` — the only timestamp form E1394 defines. */
export function astmTimestamp(at: Date): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return (
    `${pad(at.getUTCFullYear(), 4)}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}` +
    `${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}`
  );
}

export function parseAstmTimestamp(value: string): Date | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(?:(\d{2}))?)?$/.exec(value.trim());
  if (match === null) return undefined;
  const [, year = '', month = '', day = '', hour = '00', minute = '00', second = '00'] = match;
  const at = new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)),
  );
  if (Number.isNaN(at.getTime()) || Number(year) < 1900) return undefined;
  return at;
}
