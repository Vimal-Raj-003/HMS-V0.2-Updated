/**
 * HL7 v2 encoding characters, read from the message rather than assumed.
 *
 * `MSH-1` is the field separator and `MSH-2` is the four encoding characters,
 * and the standard is explicit that both are *declared by the sender*. Almost
 * every analyzer in the field sends `|^~\&` — and the two or three that do not
 * are precisely the ones that would silently produce garbage under a hard-coded
 * parser: a Mindray configured with `!` as its field separator does not fail,
 * it produces one enormous field whose contents look like a result and are not.
 *
 * So the delimiters travel with the message. Everything downstream — the parser,
 * the ACK builder, the ORU reader — takes an `Hl7Delimiters` and never reaches
 * for a literal `'|'`.
 *
 * `docs/prompts/phase-03` §Constraints and `EN-004 §5`: a message that cannot be
 * read is NAK'd and retained, never half-applied. Every failure here therefore
 * throws `Hl7ParseError` with a machine-readable `code`, which is what the
 * ingress maps onto `lab_if_messages.error_code` and an `AR` acknowledgement.
 */

export interface Hl7Delimiters {
  /** `MSH-1`. */
  readonly field: string;
  /** `MSH-2.1`. */
  readonly component: string;
  /** `MSH-2.2`. */
  readonly repetition: string;
  /** `MSH-2.3`. */
  readonly escape: string;
  /** `MSH-2.4`. */
  readonly subcomponent: string;
}

/** The standard's own segment terminator. Always `<CR>`, never configurable. */
export const HL7_SEGMENT_TERMINATOR = '\r';

/** What almost everyone sends. Used for *building* messages, never for parsing one. */
export const DEFAULT_HL7_DELIMITERS: Hl7Delimiters = Object.freeze({
  field: '|',
  component: '^',
  repetition: '~',
  escape: '\\',
  subcomponent: '&',
});

export type Hl7ErrorCode =
  | 'not_hl7'
  | 'bad_field_separator'
  | 'bad_encoding_characters'
  | 'duplicate_delimiters'
  | 'truncated_message'
  | 'empty_message'
  | 'segment_too_short';

export class Hl7ParseError extends Error {
  constructor(
    readonly code: Hl7ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'Hl7ParseError';
  }
}

/**
 * A delimiter has to be a character that cannot occur in data. Letters, digits
 * and the segment terminator can; a message declaring `A` as its field
 * separator is not an exotic configuration, it is a corrupt first line, and
 * accepting it would turn a transport fault into a plausible-looking result.
 */
function assertUsableDelimiter(char: string | undefined, what: string): string {
  if (char === undefined || char.length === 0) {
    throw new Hl7ParseError('bad_encoding_characters', `${what} is missing`);
  }
  if (char === '\r' || char === '\n') {
    throw new Hl7ParseError('bad_encoding_characters', `${what} may not be a segment terminator`);
  }
  if (/[A-Za-z0-9 ]/.test(char)) {
    throw new Hl7ParseError(
      'bad_encoding_characters',
      `${what} may not be alphanumeric or a space (got ${JSON.stringify(char)})`,
    );
  }
  return char;
}

/**
 * Reads `MSH-1`/`MSH-2` off the front of a message.
 *
 * Accepts the four-character form and the five-character form (some senders add
 * a truncation character, HL7 2.7 `MSH-2.5`); the fifth is read and ignored,
 * because nothing in this interface truncates.
 */
export function readDelimiters(message: string): Hl7Delimiters {
  if (message.length === 0) throw new Hl7ParseError('empty_message', 'the message is empty');
  if (!message.startsWith('MSH')) {
    throw new Hl7ParseError(
      'not_hl7',
      `an HL7 v2 message begins with the MSH segment (got ${JSON.stringify(message.slice(0, 8))})`,
    );
  }

  const field = assertUsableDelimiter(message[3], 'MSH-1 (the field separator)');

  const encodingEnd = message.indexOf(field, 4);
  if (encodingEnd === -1) {
    throw new Hl7ParseError(
      'truncated_message',
      'MSH-2 is not terminated: the message ends inside the encoding characters',
    );
  }

  const encoding = message.slice(4, encodingEnd);
  if (encoding.length !== 4 && encoding.length !== 5) {
    throw new Hl7ParseError(
      'bad_encoding_characters',
      `MSH-2 must be four encoding characters (five with a truncation character); got ${String(encoding.length)}`,
    );
  }

  const component = assertUsableDelimiter(encoding[0], 'MSH-2.1 (the component separator)');
  const repetition = assertUsableDelimiter(encoding[1], 'MSH-2.2 (the repetition separator)');
  const escape = assertUsableDelimiter(encoding[2], 'MSH-2.3 (the escape character)');
  const subcomponent = assertUsableDelimiter(encoding[3], 'MSH-2.4 (the subcomponent separator)');

  const all = [field, component, repetition, escape, subcomponent];
  if (new Set(all).size !== all.length) {
    throw new Hl7ParseError(
      'duplicate_delimiters',
      `the declared delimiters are not distinct: ${JSON.stringify(all.join(''))}`,
    );
  }

  return { field, component, repetition, escape, subcomponent };
}

function escapeForRegex(char: string): string {
  return char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Reverses the escape sequences the sender applied.
 *
 * `\X0D\` is decoded because analyzers use it for embedded carriage returns in
 * a comment; an unrecognised sequence is left *exactly as it arrived* rather
 * than dropped, because a silently discarded fragment of a result comment is
 * the kind of loss nobody notices until a report is disputed.
 */
export function unescapeHl7(value: string, delimiters: Hl7Delimiters): string {
  const e = escapeForRegex(delimiters.escape);
  const pattern = new RegExp(`${e}([^${e}]*)${e}`, 'g');
  return value.replace(pattern, (whole, inner: string) => {
    switch (inner) {
      case 'F':
        return delimiters.field;
      case 'S':
        return delimiters.component;
      case 'T':
        return delimiters.subcomponent;
      case 'R':
        return delimiters.repetition;
      case 'E':
        return delimiters.escape;
      case '.br':
        return '\n';
      default:
        break;
    }
    if (/^X[0-9A-Fa-f]+$/.test(inner)) {
      const hex = inner.slice(1);
      let out = '';
      for (let i = 0; i + 1 < hex.length; i += 2) {
        out += String.fromCharCode(Number.parseInt(hex.slice(i, i + 2), 16));
      }
      return out;
    }
    return whole;
  });
}

/** The inverse, for the messages this service builds (orders, query replies, ACKs). */
export function escapeHl7(value: string, delimiters: Hl7Delimiters): string {
  let out = '';
  for (const char of value) {
    switch (char) {
      case delimiters.escape:
        out += `${delimiters.escape}E${delimiters.escape}`;
        break;
      case delimiters.field:
        out += `${delimiters.escape}F${delimiters.escape}`;
        break;
      case delimiters.component:
        out += `${delimiters.escape}S${delimiters.escape}`;
        break;
      case delimiters.subcomponent:
        out += `${delimiters.escape}T${delimiters.escape}`;
        break;
      case delimiters.repetition:
        out += `${delimiters.escape}R${delimiters.escape}`;
        break;
      case '\r':
      case '\n':
        out += `${delimiters.escape}.br${delimiters.escape}`;
        break;
      default:
        out += char;
    }
  }
  return out;
}
