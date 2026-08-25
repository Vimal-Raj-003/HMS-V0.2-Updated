/**
 * The HL7 v2 message model: segments → fields → repetitions → components →
 * subcomponents, with every separator taken from `MSH-1`/`MSH-2`.
 *
 * Two decisions worth stating.
 *
 * **Field numbering is uniform.** `MSH` is the awkward segment: `MSH-1` *is* the
 * field separator, so splitting the segment on that separator yields a list
 * whose offsets differ from every other segment by one. Callers that remember
 * this write `PID-3` and `MSH-9` correctly; callers that forget read `MSH-10`
 * and get `MSH-9`, which is how an ACK ends up echoing the message type as the
 * control id. So the model normalises at parse time — `field(n)` means `X-n` on
 * every segment, MSH included — and the two delimiter fields are marked literal
 * so nothing tries to split `^~\&` on `^`.
 *
 * **Nothing here is lossy.** `raw()` returns the segment exactly as it arrived.
 * `EN-004 §5` retains raw frames for 90 days precisely so a disputed result can
 * be traced to bytes, and a parser that can only give back its own
 * reconstruction is no use for that.
 */
import {
  DEFAULT_HL7_DELIMITERS,
  HL7_SEGMENT_TERMINATOR,
  Hl7ParseError,
  escapeHl7,
  readDelimiters,
  unescapeHl7,
  type Hl7Delimiters,
} from './delimiters.js';

export class Hl7Segment {
  /**
   * @param values `values[n - 1]` is field `n`, MSH included.
   * @param literalFields How many leading fields are delimiter declarations and
   *   must never be split (2 for MSH, 0 everywhere else).
   */
  constructor(
    readonly name: string,
    private readonly values: readonly string[],
    private readonly delimiters: Hl7Delimiters,
    private readonly literalFields: number,
    private readonly rawText: string,
  ) {}

  get fieldCount(): number {
    return this.values.length;
  }

  raw(): string {
    return this.rawText;
  }

  /** Field `n`, exactly as it arrived: repetitions and components still joined. */
  field(n: number): string {
    if (n < 1) return '';
    return this.values[n - 1] ?? '';
  }

  /** Every repetition of field `n`. A field with no repetition separator yields one. */
  repetitions(n: number): readonly string[] {
    const value = this.field(n);
    if (n <= this.literalFields || value.length === 0) return [value];
    return value.split(this.delimiters.repetition);
  }

  /**
   * `X-n.c.s`, unescaped. Repetition defaults to the first, which is what every
   * caller in this interface wants: `OBX-3.1` is the test code, and an analyzer
   * that repeats it is describing alternative codings of the same test.
   */
  component(n: number, component = 1, subcomponent = 1, repetition = 1): string {
    if (n <= this.literalFields) return this.field(n);
    const reps = this.repetitions(n);
    const rep = reps[repetition - 1] ?? '';
    if (rep.length === 0) return '';
    const components = rep.split(this.delimiters.component);
    const chosen = components[component - 1] ?? '';
    if (chosen.length === 0) return '';
    const subs = chosen.split(this.delimiters.subcomponent);
    return unescapeHl7(subs[subcomponent - 1] ?? '', this.delimiters);
  }

  /** The whole field, unescaped, with separators intact. For free text such as NTE-3. */
  text(n: number): string {
    return unescapeHl7(this.field(n), this.delimiters);
  }
}

/**
 * A parsed message.
 *
 * Segment terminators: the standard says `<CR>`, and the field is full of
 * senders that use `<LF>` or `<CRLF>`. All three are accepted on the way in and
 * only `<CR>` is ever emitted, because an analyzer that accepts `<LF>` from us
 * is not a thing we can rely on.
 */
export class Hl7Message {
  private constructor(
    readonly delimiters: Hl7Delimiters,
    readonly segments: readonly Hl7Segment[],
    private readonly rawText: string,
  ) {}

  static parse(input: string): Hl7Message {
    // A leading `<CR>`/`<LF>` before MSH is a framing artefact, not data.
    const text = input.replace(/^[\r\n]+/, '');
    const delimiters = readDelimiters(text);

    const lines = text.split(/\r\n|\r|\n/).filter((line) => line.length > 0);
    if (lines.length === 0) throw new Hl7ParseError('empty_message', 'the message has no segments');

    const segments = lines.map((line) => {
      if (line.length < 3) {
        throw new Hl7ParseError(
          'segment_too_short',
          `segment ${JSON.stringify(line)} is shorter than a three-character segment name`,
        );
      }
      const parts = line.split(delimiters.field);
      const name = parts[0] ?? '';
      if (!/^[A-Z][A-Z0-9]{2}$/.test(name)) {
        throw new Hl7ParseError(
          'segment_too_short',
          `${JSON.stringify(name)} is not a three-character HL7 segment name`,
        );
      }
      if (name === 'MSH') {
        // field(1) is the separator itself; field(2) is the encoding characters.
        return new Hl7Segment(name, [delimiters.field, ...parts.slice(1)], delimiters, 2, line);
      }
      return new Hl7Segment(name, parts.slice(1), delimiters, 0, line);
    });

    if (segments[0]?.name !== 'MSH') {
      throw new Hl7ParseError('not_hl7', 'the first segment of an HL7 v2 message must be MSH');
    }

    return new Hl7Message(delimiters, segments, text);
  }

  raw(): string {
    return this.rawText;
  }

  segment(name: string, occurrence = 1): Hl7Segment | undefined {
    return this.all(name)[occurrence - 1];
  }

  all(name: string): readonly Hl7Segment[] {
    return this.segments.filter((segment) => segment.name === name);
  }

  /** `MSH-9.1`, `PID-3.1`, `OBX-5`. Missing segments and fields read as `''`. */
  get(path: string): string {
    const match = /^([A-Z][A-Z0-9]{2})(?:\[(\d+)\])?-(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(path);
    if (match === null) throw new Hl7ParseError('not_hl7', `${JSON.stringify(path)} is not an HL7 path`);
    const [, name = '', occurrence, field, component, subcomponent] = match;
    const segment = this.segment(name, occurrence === undefined ? 1 : Number(occurrence));
    if (segment === undefined) return '';
    const n = Number(field);
    if (component === undefined) return unescapeHl7(segment.field(n), this.delimiters);
    return segment.component(n, Number(component), subcomponent === undefined ? 1 : Number(subcomponent));
  }

  /** `MSH-9` as `ORU^R01`, which is how every driver switch reads it. */
  messageType(): string {
    const msh = this.segment('MSH');
    if (msh === undefined) return '';
    const code = msh.component(9, 1);
    const trigger = msh.component(9, 2);
    return trigger.length === 0 ? code : `${code}^${trigger}`;
  }

  /** `MSH-10`, the message control id. Half of the inbound idempotency key. */
  controlId(): string {
    return this.get('MSH-10');
  }

  sendingApplication(): string {
    return this.get('MSH-3.1');
  }

  sendingFacility(): string {
    return this.get('MSH-4.1');
  }
}

/**
 * Builds a message from segments given as arrays of already-composed fields.
 *
 * The builder deliberately does *not* escape: a caller composing
 * `['XN-1000', 'Sysmex']` into `XN-1000^Sysmex` has to be able to place a
 * component separator on purpose. `hl7Field()` is the helper for the other case
 * — user- or patient-supplied text, which must be escaped or it will inject a
 * separator into the message.
 */
export function buildHl7(
  segments: readonly (readonly string[])[],
  delimiters: Hl7Delimiters = DEFAULT_HL7_DELIMITERS,
): string {
  return (
    segments.map((fields) => fields.join(delimiters.field)).join(HL7_SEGMENT_TERMINATOR) +
    HL7_SEGMENT_TERMINATOR
  );
}

/** Escapes a value that came from data rather than from the protocol vocabulary. */
export function hl7Field(value: string, delimiters: Hl7Delimiters = DEFAULT_HL7_DELIMITERS): string {
  return escapeHl7(value, delimiters);
}

/** `YYYYMMDDHHMMSS` in UTC — the form `MSH-7` and `OBX-14` take. */
export function hl7Timestamp(at: Date): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return (
    `${pad(at.getUTCFullYear(), 4)}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}` +
    `${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}`
  );
}

/**
 * Reads an HL7 timestamp back. Returns `undefined` rather than an Invalid Date:
 * an analyzer with a flat clock battery sends `00000000000000`, and a result
 * dated to the year zero is worse than a result with no observation time.
 */
export function parseHl7Timestamp(value: string): Date | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(?:(\d{2}))?)?/.exec(value.trim());
  if (match === null) return undefined;
  const [, year = '', month = '', day = '', hour = '00', minute = '00', second = '00'] = match;
  const at = new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)),
  );
  if (Number.isNaN(at.getTime()) || Number(year) < 1900) return undefined;
  return at;
}
