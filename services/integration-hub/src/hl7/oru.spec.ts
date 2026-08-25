import { describe, expect, it } from 'vitest';
import { buildAck, buildRejectAck } from './ack.js';
import { Hl7Message } from './message.js';
import { buildOml, buildOrm, buildRspK11, readHostQuery, readOru } from './oru.js';

const NOW = new Date('2026-08-23T09:45:00.000Z');

const IDENTITY = {
  sendingApplication: 'VIMSHMS',
  sendingFacility: 'VIMS',
  receivingApplication: 'XN1000',
  receivingFacility: 'LAB',
};

function oru(lines: readonly string[]): Hl7Message {
  return Hl7Message.parse(`${lines.join('\r')}\r`);
}

const HEADER = 'MSH|^~\\&|XN1000|LAB|VIMSHMS|VIMS|20260823094500||ORU^R01|MSG0001|P|2.5.1';

describe('readOru', () => {
  it('reads a single-specimen ORU into one batch', () => {
    const batches = readOru(
      oru([
        HEADER,
        'PID|1||CBE-2026-004821||IYER^RAMESH||19870311|M',
        'OBR|1|P-99|S12345|CBC^Complete Blood Count|||20260823094000',
        'OBX|1|NM|WBC^White cell count||8.4|10*3/uL|4.0-11.0|N|||F|||20260823094500',
        'OBX|2|NM|HGB^Haemoglobin||9.1|g/dL|13.0-17.0|L|||F|||20260823094500',
        'SPM|1|S12345||BLD',
      ]),
    );

    expect(batches).toHaveLength(1);
    const batch = batches[0]!;
    expect(batch.specimenIdRaw).toBe('S12345');
    expect(batch.specimenIdSource).toBe('SPM-2.1');
    expect(batch.controlId).toBe('MSG0001');
    expect(batch.patient?.patientName).toBe('RAMESH IYER');
    expect(batch.observations).toHaveLength(2);
    expect(batch.observations[0]).toMatchObject({
      instrumentCode: 'WBC',
      valueType: 'numeric',
      valueNumeric: 8.4,
      unit: '10*3/uL',
      abnormalFlags: ['N'],
      resultStatus: 'F',
    });
    expect(batch.observations[1]?.abnormalFlags).toEqual(['L']);
  });

  it('splits a multi-specimen ORU so one unknown barcode cannot hold up the others', () => {
    const batches = readOru(
      oru([
        HEADER,
        'OBR|1||S00001|CBC|||20260823094000',
        'OBX|1|NM|WBC||8.4|10*3/uL|||||F',
        'OBR|2||S00002|CBC|||20260823094100',
        'OBX|1|NM|WBC||6.1|10*3/uL|||||F',
      ]),
    );
    expect(batches.map((b) => b.specimenIdRaw)).toEqual(['S00001', 'S00002']);
    expect(batches[0]?.specimenIdSource).toBe('OBR-3.1');
    expect(batches.every((b) => b.observations.length === 1)).toBe(true);
  });

  it('falls back through the configured specimen-id fields in order', () => {
    // Older Sysmex firmware fills only the placer order number.
    const batches = readOru(oru([HEADER, 'OBR|1|S77777|||||20260823', 'OBX|1|NM|GLU||5.4|mmol/L|||||F']));
    expect(batches[0]?.specimenIdRaw).toBe('S77777');
    expect(batches[0]?.specimenIdSource).toBe('OBR-2.1');
  });

  it('honours a driver-specific field list', () => {
    const message = oru([HEADER, 'OBR|1|PLACER|FILLER|CBC', 'OBX|1|NM|GLU||5.4|||||F']);
    expect(readOru(message, { specimenIdFields: ['OBR-2.1'] })[0]?.specimenIdRaw).toBe('PLACER');
    expect(readOru(message, { specimenIdFields: ['OBR-3.1'] })[0]?.specimenIdRaw).toBe('FILLER');
  });

  it('reads comparators, SN values and text results', () => {
    const batches = readOru(
      oru([
        HEADER,
        'OBR|1||S1|CBC',
        'OBX|1|ST|TSH||<0.005|uIU/mL|||||F',
        'OBX|2|SN|CRP||>^10|mg/L|||||F',
        'OBX|3|TX|COMMENT||Sample slightly lipaemic|||||F',
        'OBX|4|CE|BLOODGRP||O^O positive|||||F',
      ]),
    );
    const observations = batches[0]!.observations;
    expect(observations[0]).toMatchObject({ valueType: 'numeric', valueNumeric: 0.005, valueOperator: '<' });
    expect(observations[1]).toMatchObject({ valueType: 'numeric', valueNumeric: 10, valueOperator: '>' });
    expect(observations[2]?.valueType).toBe('text');
    expect(observations[3]?.valueType).toBe('coded');
  });

  it('separates vendor codes from HL7 abnormal flags and surfaces a failed channel', () => {
    const batches = readOru(
      oru([HEADER, 'OBR|1||S1|CBC', 'OBX|1|NM|WBC||8.4|10*3/uL||H~CLOT|||X', 'NTE|1||Clot detected']),
    );
    const observation = batches[0]!.observations[0]!;
    expect(observation.abnormalFlags).toEqual(['H']);
    expect(observation.instrumentFlags).toEqual(['CLOT', 'cannot_obtain']);
    expect(observation.comments).toEqual(['Clot detected']);
  });

  it('marks control material rather than filing it against a patient', () => {
    const withActionCode = readOru(oru([HEADER, 'OBR|1||QC-L1|CBC|||||||Q', 'OBX|1|NM|WBC||8.4|||||F']));
    expect(withActionCode[0]?.isControl).toBe(true);

    const byPattern = readOru(oru([HEADER, 'OBR|1||QC-L1|CBC', 'OBX|1|NM|WBC||8.4|||||F']), {
      controlSpecimenPattern: '^QC-',
    });
    expect(byPattern[0]?.isControl).toBe(true);
    expect(byPattern[0]?.observations[0]?.isControl).toBe(true);
  });
});

describe('readHostQuery', () => {
  it('reads QBP^Q11', () => {
    const query = readHostQuery(
      oru([
        'MSH|^~\\&|XN1000|LAB|VIMSHMS|VIMS|20260823||QBP^Q11^QBP_Q11|Q1|P|2.5.1',
        'QPD|WOS^Work Order Specimen^HL70471|Q1|S12345',
        'RCP|I',
      ]),
    );
    expect(query).toMatchObject({ specimenIdRaw: 'S12345', isWildcard: false, controlId: 'Q1' });
  });

  it('treats an empty or ALL subject as a wildcard', () => {
    const query = readHostQuery(oru(['MSH|^~\\&|A|B|C|D|20260823||QBP^Q11|Q2|P|2.5.1', 'QPD|WOS|Q2|ALL']));
    expect(query.isWildcard).toBe(true);
  });
});

describe('acknowledgements', () => {
  const inbound = oru([HEADER, 'OBR|1||S1|CBC', 'OBX|1|NM|WBC||8.4|||||F']);

  it('swaps the addressing and echoes MSH-10 into MSA-2', () => {
    const ack = Hl7Message.parse(
      buildAck(inbound, {
        identity: { sendingApplication: 'VIMSHMS', sendingFacility: 'VIMS' },
        code: 'AA',
        controlId: 'ACK-1',
        now: NOW,
      }),
    );
    expect(ack.get('MSH-3')).toBe('VIMSHMS');
    expect(ack.get('MSH-5')).toBe('XN1000');
    expect(ack.get('MSH-6')).toBe('LAB');
    expect(ack.get('MSH-9.1')).toBe('ACK');
    expect(ack.get('MSH-9.2')).toBe('R01');
    expect(ack.get('MSH-12')).toBe('2.5.1');
    expect(ack.get('MSA-1')).toBe('AA');
    expect(ack.get('MSA-2')).toBe('MSG0001');
    expect(ack.segment('ERR')).toBeUndefined();
  });

  it('adds an ERR segment on AE/AR and carries no inbound content in it', () => {
    const ack = Hl7Message.parse(
      buildAck(inbound, {
        identity: { sendingApplication: 'VIMSHMS', sendingFacility: 'VIMS' },
        code: 'AE',
        text: 'instrument status is not live',
        errorCode: 'instrument_not_live',
        controlId: 'ACK-2',
        now: NOW,
      }),
    );
    expect(ack.get('MSA-1')).toBe('AE');
    expect(ack.get('ERR-3.1')).toBe('instrument_not_live');
    expect(ack.get('ERR-4')).toBe('E');
    // Nothing from PID/OBX may travel back out in the acknowledgement.
    expect(ack.raw()).not.toContain('8.4');
  });

  it('answers an unparseable frame with AR and a placeholder control id', () => {
    const ack = Hl7Message.parse(
      buildRejectAck({
        identity: { sendingApplication: 'VIMSHMS', sendingFacility: 'VIMS' },
        reason: 'the frame could not be read',
        errorCode: 'parse_error',
        controlId: 'ACK-3',
        now: NOW,
      }),
    );
    expect(ack.get('MSA-1')).toBe('AR');
    expect(ack.get('MSA-2')).toBe('UNKNOWN');
  });

  it('builds the acknowledgement in the sender’s own delimiters', () => {
    const exotic = Hl7Message.parse('MSH!@#$%!XN!LAB!HIS!VIMS!20260823!!ORU@R01!C9!P!2.5.1\r');
    const ack = buildAck(exotic, {
      identity: { sendingApplication: 'VIMSHMS', sendingFacility: 'VIMS' },
      code: 'AA',
      controlId: 'ACK-4',
      now: NOW,
    });
    expect(ack.startsWith('MSH!@#$%!')).toBe(true);
    expect(Hl7Message.parse(ack).get('MSA-2')).toBe('C9');
  });
});

describe('outbound orders', () => {
  const order = {
    specimenId: 'S12345',
    accessionNo: 'ACC-1',
    priority: 'stat' as const,
    collectedAt: new Date('2026-08-23T09:40:00.000Z'),
    specimenTypeCode: 'BLD',
    tests: [{ instrumentCode: 'CBC', name: 'Complete Blood Count' }, { instrumentCode: 'GLU' }],
    action: 'new' as const,
    isRerun: false,
  };

  it('builds an OML^O21 with one ORC/OBR per test and one SPM', () => {
    const message = Hl7Message.parse(buildOml({ identity: IDENTITY, order, controlId: 'O1', now: NOW }));
    expect(message.messageType()).toBe('OML^O21');
    expect(message.all('OBR')).toHaveLength(2);
    expect(message.all('ORC')).toHaveLength(2);
    expect(message.get('OBR-4.1')).toBe('CBC');
    expect(message.get('OBR-5')).toBe('S');
    expect(message.get('SPM-2')).toBe('S12345');
  });

  it('builds the legacy ORM^O01 for analyzers that require it', () => {
    const message = Hl7Message.parse(buildOrm({ identity: IDENTITY, order, controlId: 'O2', now: NOW }));
    expect(message.messageType()).toBe('ORM^O01');
    expect(message.get('ORC-1')).toBe('NW');
  });

  it('marks a cancellation with ORC-1 = CA', () => {
    const message = Hl7Message.parse(
      buildOml({ identity: IDENTITY, order: { ...order, action: 'cancel' }, controlId: 'O3', now: NOW }),
    );
    expect(message.get('ORC-1')).toBe('CA');
  });

  it('answers a host query with RSP^K11, and with QAK = NF when nothing is pending', () => {
    const query = {
      protocol: 'hl7_v2' as const,
      messageType: 'QBP^Q11',
      controlId: 'Q1',
      specimenIdRaw: 'S12345',
      isWildcard: false,
    };

    const found = Hl7Message.parse(
      buildRspK11({ identity: IDENTITY, query, orders: [order], controlId: 'R1', queryTag: 'Q1', now: NOW }),
    );
    expect(found.messageType()).toBe('RSP^K11');
    expect(found.get('MSA-2')).toBe('Q1');
    expect(found.get('QAK-2')).toBe('OK');
    expect(found.all('OBR')).toHaveLength(2);

    const empty = Hl7Message.parse(
      buildRspK11({ identity: IDENTITY, query, orders: [], controlId: 'R2', queryTag: 'Q1', now: NOW }),
    );
    expect(empty.get('QAK-2')).toBe('NF');
    expect(empty.all('OBR')).toHaveLength(0);
  });
});
