import { describe, expect, it } from 'vitest';
import {
  Hl7ParseError,
  readDelimiters,
  unescapeHl7,
  escapeHl7,
  DEFAULT_HL7_DELIMITERS,
} from './delimiters.js';
import { Hl7Message, buildHl7, hl7Timestamp, parseHl7Timestamp } from './message.js';

const ORU = [
  'MSH|^~\\&|XN1000|LAB|VIMSHMS|VIMS|20260823094500||ORU^R01|MSG0001|P|2.5.1',
  'PID|1||CBE-2026-004821||IYER^RAMESH||19870311|M',
  'OBR|1|S12345|S12345|CBC^Complete Blood Count|||20260823094000',
  'OBX|1|NM|WBC^White cell count||8.4|10*3/uL|4.0-11.0|N|||F|||20260823094500',
  'SPM|1|S12345||BLD',
].join('\r');

describe('MSH-1/MSH-2 are read, never assumed', () => {
  it('reads the standard delimiter set', () => {
    expect(readDelimiters(ORU)).toEqual({
      field: '|',
      component: '^',
      repetition: '~',
      escape: '\\',
      subcomponent: '&',
    });
  });

  it('reads a non-standard set an analyzer actually declared', () => {
    // A Mindray configured with `!` as its field separator is a real
    // configuration, and a hard-coded parser turns it into one enormous field
    // whose contents look like a result.
    const message = 'MSH!@#$%!XN!LAB!HIS!VIMS!20260823!!ORU@R01!C1!P!2.5.1\rOBX!1!NM!GLU@Glucose!!5.4';
    const delimiters = readDelimiters(message);
    expect(delimiters).toEqual({
      field: '!',
      component: '@',
      repetition: '#',
      escape: '$',
      subcomponent: '%',
    });
    const parsed = Hl7Message.parse(message);
    expect(parsed.messageType()).toBe('ORU^R01');
    expect(parsed.get('OBX-3.1')).toBe('GLU');
    expect(parsed.get('OBX-5')).toBe('5.4');
  });

  it('accepts the five-character encoding field (2.7 truncation character)', () => {
    const message = 'MSH|^~\\&#|A|B|C|D|20260823||ACK|C1|P|2.7\rMSA|AA|X1';
    expect(readDelimiters(message).subcomponent).toBe('&');
    expect(Hl7Message.parse(message).get('MSA-1')).toBe('AA');
  });

  it.each([
    ['not HL7 at all', 'GET /health HTTP/1.1', 'not_hl7'],
    ['an empty message', '', 'empty_message'],
    ['a truncated MSH-2', 'MSH|^~\\&', 'truncated_message'],
    ['a three-character MSH-2', 'MSH|^~\\|A|B', 'bad_encoding_characters'],
    ['an alphanumeric field separator', 'MSHA^~\\&AXNALAB', 'bad_encoding_characters'],
    ['repeated delimiters', 'MSH|^^\\&|A|B|C|D|20260823||ORU^R01|C1|P|2.5', 'duplicate_delimiters'],
  ])('rejects %s', (_label, input, code) => {
    expect(() => readDelimiters(input)).toThrowError(Hl7ParseError);
    try {
      readDelimiters(input);
    } catch (error) {
      expect((error as Hl7ParseError).code).toBe(code);
    }
  });
});

describe('field numbering is uniform across MSH and every other segment', () => {
  const message = Hl7Message.parse(ORU);

  it('reads MSH-9 and MSH-10 rather than sliding by one', () => {
    expect(message.get('MSH-9.1')).toBe('ORU');
    expect(message.get('MSH-9.2')).toBe('R01');
    expect(message.controlId()).toBe('MSG0001');
    expect(message.get('MSH-12')).toBe('2.5.1');
  });

  it('exposes MSH-1 as the separator and MSH-2 as the encoding characters', () => {
    const msh = message.segment('MSH');
    expect(msh?.field(1)).toBe('|');
    expect(msh?.field(2)).toBe('^~\\&');
    // MSH-2 must never be split on its own component separator.
    expect(msh?.component(2, 1)).toBe('^~\\&');
  });

  it('reads components and subcomponents on ordinary segments', () => {
    expect(message.get('PID-5.1')).toBe('IYER');
    expect(message.get('PID-5.2')).toBe('RAMESH');
    expect(message.get('OBX-3.1')).toBe('WBC');
    expect(message.get('OBX-6')).toBe('10*3/uL');
  });

  it('returns empty for absent segments and fields rather than throwing', () => {
    expect(message.get('NTE-3')).toBe('');
    expect(message.get('OBX-99')).toBe('');
  });

  it('accepts <LF> and <CRLF> segment terminators, which senders really use', () => {
    const lf = Hl7Message.parse(ORU.split('\r').join('\n'));
    const crlf = Hl7Message.parse(ORU.split('\r').join('\r\n'));
    expect(lf.segments).toHaveLength(5);
    expect(crlf.segments).toHaveLength(5);
    expect(crlf.get('OBX-5')).toBe('8.4');
  });

  it('rejects a message whose first segment is not MSH', () => {
    expect(() => Hl7Message.parse('MSH|^~\\&|A|B|C|D|20260823||ORU^R01|C1|P|2.5\rMSH|^~\\&')).not.toThrow();
    expect(() => Hl7Message.parse('PID|1||X\rMSH|^~\\&|A')).toThrowError(Hl7ParseError);
  });

  it('rejects a segment whose name is not three characters', () => {
    expect(() => Hl7Message.parse(`${ORU}\rXX|1|2`)).toThrowError(/not a three-character/);
  });
});

describe('repetitions and escapes', () => {
  it('splits repetitions but leaves a single value alone', () => {
    const message = Hl7Message.parse(
      'MSH|^~\\&|A|B|C|D|20260823||ORU^R01|C1|P|2.5\rOBX|1|NM|GLU||5.4|||H~A|||F',
    );
    const obx = message.segment('OBX');
    expect(obx?.repetitions(8)).toEqual(['H', 'A']);
    expect(obx?.repetitions(5)).toEqual(['5.4']);
  });

  it('unescapes the standard sequences and leaves an unknown one intact', () => {
    const d = DEFAULT_HL7_DELIMITERS;
    expect(unescapeHl7('a\\F\\b', d)).toBe('a|b');
    expect(unescapeHl7('a\\S\\b', d)).toBe('a^b');
    expect(unescapeHl7('a\\T\\b', d)).toBe('a&b');
    expect(unescapeHl7('a\\R\\b', d)).toBe('a~b');
    expect(unescapeHl7('a\\E\\b', d)).toBe('a\\b');
    expect(unescapeHl7('a\\X0D\\b', d)).toBe('a\rb');
    expect(unescapeHl7('a\\.br\\b', d)).toBe('a\nb');
    // A fragment silently dropped is the kind of loss nobody notices until a
    // report is disputed.
    expect(unescapeHl7('a\\Z9\\b', d)).toBe('a\\Z9\\b');
  });

  it('round-trips a value carrying every delimiter', () => {
    const d = DEFAULT_HL7_DELIMITERS;
    const value = 'a|b^c~d\\e&f';
    expect(unescapeHl7(escapeHl7(value, d), d)).toBe(value);
  });

  it('escapes with the sender’s own delimiters, not the default ones', () => {
    const d = { field: '!', component: '@', repetition: '#', escape: '$', subcomponent: '%' };
    expect(escapeHl7('a!b', d)).toBe('a$F$b');
    expect(unescapeHl7('a$F$b', d)).toBe('a!b');
  });
});

describe('timestamps', () => {
  it('renders and reads YYYYMMDDHHMMSS in UTC', () => {
    const at = new Date('2026-08-23T09:45:00.000Z');
    expect(hl7Timestamp(at)).toBe('20260823094500');
    expect(parseHl7Timestamp('20260823094500')?.toISOString()).toBe(at.toISOString());
  });

  it('reads a date-only value', () => {
    expect(parseHl7Timestamp('20260823')?.toISOString()).toBe('2026-08-23T00:00:00.000Z');
  });

  it('returns undefined for the flat-battery timestamp rather than the year zero', () => {
    expect(parseHl7Timestamp('00000000000000')).toBeUndefined();
    expect(parseHl7Timestamp('')).toBeUndefined();
    expect(parseHl7Timestamp('not-a-date')).toBeUndefined();
  });
});

describe('buildHl7', () => {
  it('joins fields and terminates every segment with <CR>', () => {
    const built = buildHl7([
      ['MSH', '^~\\&', 'VIMSHMS', 'VIMS', 'XN1000', 'LAB', '20260823094500', '', 'ACK', 'A1', 'P', '2.5.1'],
      ['MSA', 'AA', 'MSG0001'],
    ]);
    expect(built.endsWith('\r')).toBe(true);
    expect(built.split('\r').filter((s) => s.length > 0)).toHaveLength(2);
    expect(Hl7Message.parse(built).get('MSA-2')).toBe('MSG0001');
  });
});
