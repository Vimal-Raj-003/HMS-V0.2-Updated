import { describe, expect, it } from 'vitest';
import { buildAstmOrders, readAstmQuery, readAstmResults } from './lis.js';
import {
  AstmParseError,
  astmValue,
  parseAstmRecord,
  parseAstmTimestamp,
  readAstmDelimiters,
  DEFAULT_ASTM_DELIMITERS,
} from './records.js';

const RESULTS = [
  'H|\\^&|C-77||SIM|||||LIS||P|1|20260823094500',
  'P|1|CBE-2026-004821|||IYER^RAMESH||19870311|M',
  'O|1|S12345|S12345|^^^CBC|R|20260823094000|20260823094000|||||N',
  'R|1|^^^WBC|8.4|10*3/uL|4.0-11.0|N||F||TECH1|20260823094500|20260823094500|SIM',
  'R|2|^^^HGB|9.1|g/dL|13.0-17.0|L||F||TECH1|20260823094500|20260823094500|SIM',
  'C|1|I|Slight haemolysis|G',
  'L|1|N',
];

describe('readAstmDelimiters', () => {
  it('reads the delimiters the H record declares', () => {
    expect(readAstmDelimiters('H|\\^&|||SIM')).toEqual({
      field: '|',
      repeat: '\\',
      component: '^',
      escape: '&',
    });
  });

  it('reads a non-standard field delimiter', () => {
    expect(readAstmDelimiters('H!\\^&!!!SIM').field).toBe('!');
  });

  it.each([
    ['a transmission that does not start with H', 'P|1|X', 'no_header'],
    ['an alphanumeric field delimiter', 'HA\\^&', 'bad_delimiters'],
    ['a short delimiter definition', 'H|\\^', 'bad_delimiters'],
    ['repeated delimiters', 'H|^^&|||SIM', 'bad_delimiters'],
  ])('rejects %s', (_label, input, code) => {
    try {
      readAstmDelimiters(input);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AstmParseError);
      expect((error as AstmParseError).code).toBe(code);
    }
  });
});

describe('parseAstmRecord', () => {
  it('numbers fields with the record type as field 1', () => {
    const record = parseAstmRecord('O|1|S12345|INSTR-7|^^^CBC|R', DEFAULT_ASTM_DELIMITERS);
    expect(record.type).toBe('O');
    expect(record.field(2)).toBe('1');
    // O-3 is the specimen id; reading O-4 gives the analyzer's own id, which
    // matches nothing and sends every result to the unmatched queue.
    expect(record.field(3)).toBe('S12345');
    expect(record.field(4)).toBe('INSTR-7');
    expect(record.component(5, 4)).toBe('CBC');
  });

  it('refuses something that is not a record', () => {
    expect(() => parseAstmRecord('', DEFAULT_ASTM_DELIMITERS)).toThrowError(AstmParseError);
    expect(() => parseAstmRecord('XX|1', DEFAULT_ASTM_DELIMITERS)).toThrowError(/not an ASTM record type/);
  });

  it('never splits the H record’s delimiter definition on its own component char', () => {
    const record = parseAstmRecord('H|\\^&|||SIM', DEFAULT_ASTM_DELIMITERS);
    expect(record.component(2, 1)).toBe('\\^&');
  });
});

describe('readAstmResults', () => {
  it('reads one batch per O record with its R records', () => {
    const batches = readAstmResults(RESULTS, 'fallback');
    expect(batches).toHaveLength(1);
    const batch = batches[0]!;
    expect(batch.controlId).toBe('C-77');
    expect(batch.specimenIdRaw).toBe('S12345');
    expect(batch.specimenIdSource).toBe('O-3');
    expect(batch.patient?.patientName).toBe('RAMESH IYER');
    expect(batch.operator).toBe('TECH1');
    expect(batch.observations).toHaveLength(2);
    expect(batch.observations[0]).toMatchObject({
      instrumentCode: 'WBC',
      valueNumeric: 8.4,
      unit: '10*3/uL',
      abnormalFlags: ['N'],
      resultStatus: 'F',
    });
    expect(batch.observations[1]?.comments).toEqual(['Slight haemolysis']);
  });

  it('falls back to the caller’s digest when H-13 is empty, as half of analyzers leave it', () => {
    const withoutControlId = RESULTS.map((record) =>
      record.startsWith('H|') ? 'H|\\^&|||SIM|||||LIS||P|1|20260823094500' : record,
    );
    expect(readAstmResults(withoutControlId, 'digest-abc')[0]?.controlId).toBe('digest-abc');
  });

  it('finds the test code wherever the vendor put it in R-3', () => {
    const variants = [
      ['H|\\^&', 'O|1|S1|S1|^^^CBC|R', 'R|1|^^^GLU|5.4|mmol/L', 'L|1|N'],
      ['H|\\^&', 'O|1|S1|S1|^^^CBC|R', 'R|1|^^^^GLU|5.4|mmol/L', 'L|1|N'],
      ['H|\\^&', 'O|1|S1|S1|^^^CBC|R', 'R|1|GLU|5.4|mmol/L', 'L|1|N'],
    ];
    for (const records of variants) {
      expect(readAstmResults(records, 'x')[0]?.observations[0]?.instrumentCode).toBe('GLU');
    }
  });

  it('marks control material by action code and by pattern', () => {
    const qc = ['H|\\^&', 'O|1|QC-L1|QC-L1|^^^CBC|R||||||Q', 'R|1|^^^WBC|8.4', 'L|1|N'];
    expect(readAstmResults(qc, 'x')[0]?.isControl).toBe(true);
    const byPattern = ['H|\\^&', 'O|1|QC-L1|QC-L1|^^^CBC|R', 'R|1|^^^WBC|8.4', 'L|1|N'];
    expect(readAstmResults(byPattern, 'x', { controlSpecimenPattern: '^QC-' })[0]?.isControl).toBe(true);
  });

  it('separates vendor flags from abnormal flags', () => {
    const records = ['H|\\^&', 'O|1|S1|S1|^^^CBC|R', 'R|1|^^^WBC|8.4|10*3/uL||H CLOT||X', 'L|1|N'];
    const observation = readAstmResults(records, 'x')[0]?.observations[0];
    expect(observation?.abnormalFlags).toEqual(['H']);
    expect(observation?.instrumentFlags).toEqual(['CLOT', 'cannot_obtain']);
  });

  it('refuses a transmission with no H record rather than guessing at delimiters', () => {
    expect(() => readAstmResults(['O|1|S1'], 'x')).toThrowError(AstmParseError);
  });
});

describe('readAstmQuery', () => {
  it('reads the barcode from Q-3 component 2', () => {
    const query = readAstmQuery([
      'H|\\^&|Q-1||SIM|||||LIS||P|1|20260823094500',
      'Q|1|^S12345^|||ALL||||||||O',
      'L|1|N',
    ]);
    expect(query).toMatchObject({ specimenIdRaw: 'S12345', isWildcard: false, controlId: 'Q-1' });
  });

  it('falls back to component 1 for analyzers that fill it instead', () => {
    expect(readAstmQuery(['H|\\^&', 'Q|1|S999|||ALL', 'L|1|N'])?.specimenIdRaw).toBe('S999');
  });

  it('treats ALL as a wildcard', () => {
    expect(readAstmQuery(['H|\\^&', 'Q|1|^ALL^|||ALL', 'L|1|N'])?.isWildcard).toBe(true);
  });

  it('returns undefined when the transmission is not a query', () => {
    expect(readAstmQuery(RESULTS)).toBeUndefined();
  });
});

describe('buildAstmOrders', () => {
  it('builds H/P/O/L with the tests repeated inside O-5', () => {
    const records = buildAstmOrders({
      identity: { sendingApplication: 'VIMSHMS', receivingApplication: 'SIM' },
      controlId: 'R-1',
      now: new Date('2026-08-23T09:45:00.000Z'),
      orders: [
        {
          specimenId: 'S12345',
          priority: 'stat',
          tests: [{ instrumentCode: 'CBC' }, { instrumentCode: 'GLU' }],
          action: 'new',
          isRerun: false,
        },
      ],
    });

    expect(records[0]?.startsWith('H|\\^&')).toBe(true);
    expect(records.at(-1)).toBe('L|1|N');
    const order = records.find((record) => record.startsWith('O|'));
    expect(order).toContain('S12345');
    expect(order).toContain('^^^CBC\\^^^GLU');
    expect(order?.split('|')[5]).toBe('S');

    // Whatever we build must read back as what we meant: one specimen, the
    // tests we asked for, and no observations (an order carries no results).
    const readBack = readAstmResults(records, 'x');
    expect(readBack).toHaveLength(1);
    expect(readBack[0]?.specimenIdRaw).toBe('S12345');
    expect(readBack[0]?.observations).toHaveLength(0);
    expect(readBack[0]?.controlId).toBe('R-1');
  });
});

describe('helpers', () => {
  it('escapes the delimiters out of a data value', () => {
    expect(astmValue('a|b^c\\d&e')).toBe('a&F&b&S&c&R&d&E&e');
  });

  it('reads a timestamp and refuses a nonsense one', () => {
    expect(parseAstmTimestamp('20260823094500')?.toISOString()).toBe('2026-08-23T09:45:00.000Z');
    expect(parseAstmTimestamp('00000000000000')).toBeUndefined();
    expect(parseAstmTimestamp('')).toBeUndefined();
  });
});
