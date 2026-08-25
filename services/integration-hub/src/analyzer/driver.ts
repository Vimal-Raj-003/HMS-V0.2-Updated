/**
 * The per-protocol drivers: bytes to canonical, canonical to bytes.
 *
 * Everything above this file — the ingress, the forwarder, the unmatched queue,
 * the listener — is written once against `AnalyzerDriver` and knows nothing
 * about pipes, carets, `<STX>` or checksums. That is what makes the third
 * protocol (POCT1-A, a vendor CSV drop) a new file rather than a new set of
 * conditionals in the store-and-forward loop.
 *
 * ── One asymmetry worth naming ──────────────────────────────────────────────
 *
 * `acknowledge()` returns `undefined` for ASTM, and that is not an omission:
 * E1394 has no application acknowledgement at all. Its `<ACK>` is a link-layer
 * byte handled by `AstmReceiver`, which withholds the one that completes a
 * transmission until the frame is stored. HL7 has a real application ACK, so
 * the driver builds one and the listener sends it *after* the commit. Both
 * satisfy "persist before acknowledge"; they satisfy it in different layers,
 * and pretending otherwise would put a fake ACK on the ASTM wire.
 */
import { buildAck, buildRejectAck, type AckCode } from '../hl7/ack.js';
import { Hl7ParseError } from '../hl7/delimiters.js';
import { Hl7Message } from '../hl7/message.js';
import { buildOml, buildOrm, buildRspK11, readHostQuery, readOru } from '../hl7/oru.js';
import { AstmParseError } from '../astm/records.js';
import { buildAstmOrders, readAstmQuery, readAstmResults } from '../astm/lis.js';
import type { AnalyzerHostQuery, AnalyzerInbound, AnalyzerOrder, AnalyzerProtocol } from './canonical.js';
import { contentDigest } from './message-store.js';
import type { AnalyzerInstrument, IngressDecision } from './types.js';

export class DriverParseError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DriverParseError';
  }
}

export interface AnalyzerDriver {
  readonly protocol: AnalyzerProtocol;
  /** Interpret one complete application message. Throws `DriverParseError`. */
  read(raw: Buffer, instrument: AnalyzerInstrument): AnalyzerInbound;
  /** The application acknowledgement, or `undefined` where the protocol has none. */
  acknowledge(input: {
    readonly raw: Buffer;
    readonly decision: IngressDecision;
    readonly instrument: AnalyzerInstrument;
    readonly controlId: string;
    readonly now: Date;
  }): Buffer | undefined;
  renderOrders(input: {
    readonly orders: readonly AnalyzerOrder[];
    readonly instrument: AnalyzerInstrument;
    readonly controlId: string;
    readonly now: Date;
  }): Buffer;
  renderQueryReply(input: {
    readonly query: AnalyzerHostQuery;
    readonly orders: readonly AnalyzerOrder[];
    readonly instrument: AnalyzerInstrument;
    readonly controlId: string;
    readonly now: Date;
  }): Buffer;
}

function hl7Identity(instrument: AnalyzerInstrument): {
  readonly sendingApplication: string;
  readonly sendingFacility: string;
  readonly receivingApplication: string;
  readonly receivingFacility: string;
  readonly version: string;
} {
  const c = instrument.connection;
  return {
    sendingApplication: c.sendingApplication,
    sendingFacility: c.sendingFacility,
    receivingApplication: c.receivingApplication,
    receivingFacility: c.receivingFacility,
    version: c.hl7Version,
  };
}

/**
 * `AA` only for a message that is durably stored, `AE` for one this system
 * cannot act on, `AR` for one it could not read. The mapping lives here so that
 * every protocol answers the same three outcomes the same way.
 */
function ackCodeFor(decision: IngressDecision): AckCode {
  switch (decision.kind) {
    case 'stored':
    case 'duplicate':
      return 'AA';
    case 'rejected':
      // A frame that could not be parsed is `AR` so the analyzer resends it; a
      // frame this system understood but refuses is `AE`, which most analyzers
      // do not resend — which is correct, because resending will not help.
      return decision.errorCode === 'parse_error' ? 'AR' : 'AE';
    default:
      return 'AE';
  }
}

const hl7DriverImpl: AnalyzerDriver = {
  protocol: 'hl7_v2' as const,

  read(raw: Buffer, instrument: AnalyzerInstrument): AnalyzerInbound {
    let message: Hl7Message;
    try {
      message = Hl7Message.parse(raw.toString('utf8'));
    } catch (error) {
      if (error instanceof Hl7ParseError) throw new DriverParseError('parse_error', error.message);
      throw new DriverParseError('parse_error', error instanceof Error ? error.message : 'unreadable frame');
    }

    const type = message.messageType();
    const trigger = type.split('^')[0] ?? '';

    if (trigger === 'ORU') {
      const options = {
        ...(instrument.connection.specimenIdFields === undefined
          ? {}
          : { specimenIdFields: instrument.connection.specimenIdFields }),
        ...(instrument.connection.controlSpecimenPattern === undefined
          ? {}
          : { controlSpecimenPattern: instrument.connection.controlSpecimenPattern }),
      };
      const batches = readOru(message, options);
      if (batches.length === 0) {
        throw new DriverParseError('parse_error', 'an ORU carried no OBR group, so it named no specimen');
      }
      return { kind: 'results', batches };
    }

    if (trigger === 'QBP' || trigger === 'QRY') {
      return { kind: 'host_query', query: readHostQuery(message) };
    }

    if (trigger === 'ACK') {
      return {
        kind: 'acknowledgement',
        controlId: message.get('MSA-2'),
        ackCode: message.get('MSA-1'),
      };
    }

    return { kind: 'ignored', messageType: type, controlId: message.controlId() };
  },

  acknowledge(input): Buffer | undefined {
    const identity = hl7Identity(input.instrument);
    const ackIdentity = {
      sendingApplication: identity.sendingApplication,
      sendingFacility: identity.sendingFacility,
      defaultVersion: identity.version,
    };

    let message: Hl7Message | undefined;
    try {
      message = Hl7Message.parse(input.raw.toString('utf8'));
    } catch {
      message = undefined;
    }

    if (message === undefined) {
      return Buffer.from(
        buildRejectAck({
          identity: ackIdentity,
          reason: input.decision.kind === 'rejected' ? input.decision.detail : 'the frame could not be read',
          errorCode: input.decision.kind === 'rejected' ? input.decision.errorCode : 'parse_error',
          controlId: input.controlId,
          now: input.now,
        }),
        'utf8',
      );
    }

    const code = ackCodeFor(input.decision);
    return Buffer.from(
      buildAck(message, {
        identity: ackIdentity,
        code,
        controlId: input.controlId,
        now: input.now,
        ...(input.decision.kind === 'rejected'
          ? { text: input.decision.detail, errorCode: input.decision.errorCode }
          : {}),
        ...(input.decision.kind === 'duplicate' ? { text: 'already received; not applied again' } : {}),
      }),
      'utf8',
    );
  },

  renderOrders(input): Buffer {
    const identity = hl7Identity(input.instrument);
    const order = input.orders[0];
    if (order === undefined) throw new DriverParseError('mapping_error', 'no order to render');
    const build = input.instrument.driverKey.includes('orm') ? buildOrm : buildOml;
    return Buffer.from(build({ identity, order, controlId: input.controlId, now: input.now }), 'utf8');
  },

  renderQueryReply(input): Buffer {
    return Buffer.from(
      buildRspK11({
        identity: hl7Identity(input.instrument),
        query: input.query,
        orders: input.orders,
        controlId: input.controlId,
        queryTag: input.query.controlId.length > 0 ? input.query.controlId : input.controlId,
        now: input.now,
      }),
      'utf8',
    );
  },
};

export const hl7Driver: AnalyzerDriver = Object.freeze(hl7DriverImpl);

/** Records joined by `<CR>`: the form the ASTM transport frames and the store keeps. */
export function astmRecordsToBuffer(records: readonly string[]): Buffer {
  return Buffer.from(`${records.join('\r')}\r`, 'latin1');
}

export function astmBufferToRecords(raw: Buffer): readonly string[] {
  return raw
    .toString('latin1')
    .split(/[\r\n]+/)
    .filter((record) => record.trim().length > 0);
}

const astmDriverImpl: AnalyzerDriver = {
  protocol: 'astm_e1394' as const,

  read(raw: Buffer, instrument: AnalyzerInstrument): AnalyzerInbound {
    const records = astmBufferToRecords(raw);
    if (records.length === 0)
      throw new DriverParseError('parse_error', 'the transmission carried no records');

    try {
      const query = readAstmQuery(records);
      if (query !== undefined) return { kind: 'host_query', query };

      // The digest is the fallback control id: half of ASTM analyzers leave
      // `H-13` empty, and an idempotency key that is empty for every message is
      // not an idempotency key.
      const batches = readAstmResults(records, contentDigest(raw).slice(0, 32), {
        ...(instrument.connection.controlSpecimenPattern === undefined
          ? {}
          : { controlSpecimenPattern: instrument.connection.controlSpecimenPattern }),
      });
      if (batches.length === 0) {
        return { kind: 'ignored', messageType: 'ASTM_H', controlId: contentDigest(raw).slice(0, 32) };
      }
      return { kind: 'results', batches };
    } catch (error) {
      if (error instanceof AstmParseError) throw new DriverParseError('parse_error', error.message);
      throw new DriverParseError(
        'parse_error',
        error instanceof Error ? error.message : 'unreadable records',
      );
    }
  },

  acknowledge(): Buffer | undefined {
    // E1394 has no application acknowledgement. `AstmReceiver.confirm()` holds
    // the link-layer ACK of the completing frame until the store commits, which
    // is where the guarantee lives for this protocol.
    return undefined;
  },

  renderOrders(input): Buffer {
    return astmRecordsToBuffer(
      buildAstmOrders({
        identity: {
          sendingApplication: input.instrument.connection.sendingApplication,
          receivingApplication: input.instrument.connection.receivingApplication,
        },
        orders: input.orders,
        controlId: input.controlId,
        now: input.now,
      }),
    );
  },

  renderQueryReply(input): Buffer {
    return astmDriverImpl.renderOrders({
      orders: input.orders,
      instrument: input.instrument,
      controlId: input.controlId,
      now: input.now,
    });
  },
};

export const astmDriver: AnalyzerDriver = Object.freeze(astmDriverImpl);

export function driverFor(instrument: AnalyzerInstrument): AnalyzerDriver {
  switch (instrument.protocol) {
    case 'hl7_v2':
      return hl7Driver;
    case 'astm_e1394':
    case 'lis2_a2':
      // LIS2-A2 is E1394's record layer with E1381 framing and a few extra
      // fields; the reader tolerates the additions.
      return astmDriver;
    case 'poct1_a':
    case 'csv':
    case 'proprietary':
      throw new DriverParseError(
        'not_supported',
        `no driver for protocol '${instrument.protocol}' — POCT1-A and file drops are a later phase (EN-004 §15)`,
      );
    default:
      throw new DriverParseError('not_supported', 'unknown instrument protocol');
  }
}
