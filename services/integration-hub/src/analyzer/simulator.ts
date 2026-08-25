/**
 * A fake analyzer, speaking both protocols.
 *
 * `docs/prompts/phase-03` §3.3 asks for one in as many words — "Include a
 * simulator so this can be tested without hardware" — but the reason it is
 * *this* shape is exit gate 7. A simulator that only sends messages can prove
 * the happy path and nothing else. The property under test is that no result is
 * lost when something breaks, and "lost" is only meaningful against a peer that
 * behaves the way a real analyzer does:
 *
 *  * it **retains** every message until it is acknowledged;
 *  * a NAK, a closed socket or a silent timeout leaves the message retained;
 *  * on reconnect it **resends** what it still holds, in the original order.
 *
 * That is why `retained` is public and why `flush()` reports it. A test that
 * severs the downstream, pushes N messages and reconnects can then assert two
 * things that together mean zero loss: the analyzer is holding nothing, and the
 * laboratory received exactly N, once each, in order.
 *
 * Nothing in this file is production code — but it is not test-only either. It
 * is the tool an engineer runs against a newly configured instrument before the
 * vendor arrives, which is why it lives in `src/` and is exported.
 */
import { connect, type Socket } from 'node:net';
import { MllpDecoder, mllpFrame } from '../hl7/mllp.js';
import { Hl7Message } from '../hl7/message.js';
import { AstmSender } from '../astm/session.js';
import { buildAstmRecord, DEFAULT_ASTM_DELIMITERS } from '../astm/records.js';
import type { AnalyzerProtocol } from './canonical.js';

export interface FakeAnalyzerOptions {
  readonly host: string;
  readonly port: number;
  readonly protocol: AnalyzerProtocol;
  /** How long to wait for an acknowledgement before retaining the message. */
  readonly ackTimeoutMs?: number;
}

export interface FlushReport {
  readonly delivered: number;
  readonly retained: number;
  readonly rejected: number;
}

interface PendingMessage {
  readonly id: string;
  readonly payload: string;
}

export class FakeAnalyzer {
  private socket: Socket | undefined;
  private readonly decoder = new MllpDecoder();
  private queue: PendingMessage[] = [];
  private inbox: Buffer[] = [];
  private astmSender: AstmSender | undefined;
  private astmResolve: ((ok: boolean) => void) | undefined;
  private readonly ackTimeoutMs: number;

  constructor(private readonly options: FakeAnalyzerOptions) {
    this.ackTimeoutMs = options.ackTimeoutMs ?? 2_000;
  }

  /** Messages the analyzer is still holding because nobody acknowledged them. */
  get retained(): number {
    return this.queue.length;
  }

  get connected(): boolean {
    return this.socket !== undefined && !this.socket.destroyed;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    const socket = connect({ host: this.options.host, port: this.options.port });
    socket.setNoDelay(true);
    this.decoder.reset();

    socket.on('data', (chunk: Buffer) => {
      if (this.options.protocol === 'astm_e1394' && this.astmSender !== undefined) {
        const step = this.astmSender.push(chunk);
        if (step.write.length > 0 && !socket.destroyed) socket.write(step.write);
        if (this.astmSender.finished) {
          const ok = this.astmSender.succeeded;
          this.astmSender = undefined;
          this.astmResolve?.(ok);
          this.astmResolve = undefined;
        }
        return;
      }
      for (const frame of this.decoder.push(chunk)) this.inbox.push(frame);
    });

    socket.on('error', () => {
      // A closed or refused socket means "not acknowledged", which is the state
      // the queue is already in. Nothing to do but let `flush` time out.
    });

    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    this.socket = socket;
  }

  async disconnect(): Promise<void> {
    const socket = this.socket;
    this.socket = undefined;
    this.astmSender = undefined;
    this.astmResolve?.(false);
    this.astmResolve = undefined;
    if (socket === undefined) return;
    await new Promise<void>((resolve) => {
      socket.once('close', () => {
        resolve();
      });
      socket.destroy();
    });
  }

  /** Hands the analyzer a message to deliver. It is retained until acknowledged. */
  enqueue(id: string, payload: string): void {
    this.queue.push({ id, payload });
  }

  /** Ids still held. Useful for asserting *which* messages were not delivered. */
  retainedIds(): readonly string[] {
    return this.queue.map((message) => message.id);
  }

  /**
   * Delivers everything queued, in order, stopping at the first message that is
   * not acknowledged — because a real analyzer does not skip ahead either, and
   * skipping would hide an ordering bug rather than expose one.
   */
  async flush(): Promise<FlushReport> {
    let delivered = 0;
    let rejected = 0;

    while (this.queue.length > 0) {
      const next = this.queue[0];
      if (next === undefined) break;
      const outcome = await this.deliver(next.payload);
      if (outcome === 'retain') break;
      if (outcome === 'reject') rejected += 1;
      delivered += 1;
      this.queue.shift();
    }

    return { delivered, retained: this.queue.length, rejected };
  }

  /** Sends one message and reports whether the host took responsibility for it. */
  private async deliver(payload: string): Promise<'ack' | 'reject' | 'retain'> {
    if (!this.connected) return 'retain';
    return this.options.protocol === 'hl7_v2' ? this.deliverHl7(payload) : this.deliverAstm(payload);
  }

  private async deliverHl7(payload: string): Promise<'ack' | 'reject' | 'retain'> {
    const socket = this.socket;
    if (socket === undefined || socket.destroyed) return 'retain';
    this.inbox = [];
    socket.write(mllpFrame(payload));

    const reply = await this.awaitFrame();
    if (reply === undefined) return 'retain';

    let code = '';
    try {
      code = Hl7Message.parse(reply.toString('utf8')).get('MSA-1').toUpperCase();
    } catch {
      return 'retain';
    }
    // `AA` accepted, `AE` refused for a reason resending will not fix, `AR`
    // rejected — and a real analyzer resends on `AR`, which is what makes an
    // unstorable frame safe.
    if (code === 'AA') return 'ack';
    if (code === 'AE') return 'reject';
    return 'retain';
  }

  private async deliverAstm(payload: string): Promise<'ack' | 'reject' | 'retain'> {
    const socket = this.socket;
    if (socket === undefined || socket.destroyed) return 'retain';
    const records = payload.split(/[\r\n]+/).filter((record) => record.trim().length > 0);

    const sender = new AstmSender(records);
    this.astmSender = sender;
    const finished = new Promise<boolean>((resolve) => {
      this.astmResolve = resolve;
    });
    const timeout = new Promise<boolean>((resolve) => {
      setTimeout(() => {
        resolve(false);
      }, this.ackTimeoutMs).unref();
    });

    socket.write(sender.start().write);
    const ok = await Promise.race([finished, timeout]);
    this.astmSender = undefined;
    this.astmResolve = undefined;
    return ok ? 'ack' : 'retain';
  }

  /** Asks the host what tests a barcode needs, and returns the raw reply. */
  async hostQuery(barcode: string, controlId = 'Q1'): Promise<string | undefined> {
    const socket = this.socket;
    if (socket === undefined || socket.destroyed) return undefined;

    if (this.options.protocol === 'hl7_v2') {
      this.inbox = [];
      socket.write(mllpFrame(buildQbpQ11(barcode, controlId)));
      const reply = await this.awaitFrame();
      return reply?.toString('utf8');
    }

    const records = [
      buildAstmRecord([
        'H|\\^&',
        controlId,
        '',
        'SIM',
        '',
        '',
        '',
        '',
        'LIS',
        '',
        'P',
        '1',
        '20260823094500',
      ]),
      buildAstmRecord(['Q', '1', `^${barcode}^`, '', 'ALL', '', '', '', '', '', '', '', 'O']),
      buildAstmRecord(['L', '1', 'N']),
    ];
    const sent = await this.deliverAstm(records.join('\r'));
    if (sent !== 'ack') return undefined;
    // The host answers with its own transmission; collect it as records.
    const reply = await this.awaitAstmTransmission();
    return reply;
  }

  private async awaitFrame(): Promise<Buffer | undefined> {
    const deadline = Date.now() + this.ackTimeoutMs;
    for (;;) {
      const frame = this.inbox.shift();
      if (frame !== undefined) return frame;
      if (Date.now() >= deadline || !this.connected) return undefined;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 5).unref();
      });
    }
  }

  /**
   * Receives an ASTM transmission the host initiates (the host-query answer).
   *
   * The simulator plays receiver here: ACK the `<ENQ>`, ACK each frame, and
   * stop at `<EOT>`.
   */
  private async awaitAstmTransmission(): Promise<string | undefined> {
    const socket = this.socket;
    if (socket === undefined) return undefined;
    const { AstmReceiver } = await import('../astm/session.js');
    const receiver = new AstmReceiver();
    let collected: readonly string[] | undefined;

    const onData = (chunk: Buffer): void => {
      const outcome = receiver.push(chunk);
      if (outcome.reply.length > 0 && !socket.destroyed) socket.write(outcome.reply);
      for (const transmission of outcome.transmissions) {
        collected = transmission.records;
        if (transmission.awaitingConfirmation) {
          const settled = receiver.confirm(true);
          if (settled.reply.length > 0 && !socket.destroyed) socket.write(settled.reply);
        }
      }
    };
    socket.on('data', onData);

    const deadline = Date.now() + this.ackTimeoutMs;
    while (collected === undefined && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 5).unref();
      });
    }
    socket.removeListener('data', onData);
    return collected === undefined ? undefined : collected.join('\r');
  }
}

export interface OruFixture {
  readonly controlId: string;
  readonly specimenId: string;
  readonly sendingApplication?: string;
  readonly sendingFacility?: string;
  readonly patientName?: string;
  readonly patientId?: string;
  readonly observations: readonly {
    readonly code: string;
    readonly value: string;
    readonly unit?: string;
    readonly flags?: string;
    readonly type?: string;
  }[];
  readonly timestamp?: string;
}

/** A realistic `ORU^R01`, PID and all — including the PHI a redactor must catch. */
export function buildOruMessage(fixture: OruFixture): string {
  const ts = fixture.timestamp ?? '20260823094500';
  const lines: string[] = [
    `MSH|^~\\&|${fixture.sendingApplication ?? 'XN1000'}|${fixture.sendingFacility ?? 'LAB'}|VIMSHMS|VIMS|${ts}||ORU^R01|${fixture.controlId}|P|2.5.1`,
  ];
  if (fixture.patientName !== undefined || fixture.patientId !== undefined) {
    lines.push(
      `PID|1||${fixture.patientId ?? ''}||${fixture.patientName ?? ''}||19870311|M|||14/2 Nehru Nagar^^Coimbatore^TN^641012||9876543210`,
    );
  }
  lines.push(`OBR|1|${fixture.specimenId}|${fixture.specimenId}|CBC^Complete Blood Count|||${ts}`);
  fixture.observations.forEach((observation, index) => {
    lines.push(
      [
        'OBX',
        String(index + 1),
        observation.type ?? 'NM',
        `${observation.code}^${observation.code}`,
        '',
        observation.value,
        observation.unit ?? '',
        '',
        observation.flags ?? '',
        '',
        '',
        'F',
        '',
        ts,
      ].join('|'),
    );
  });
  lines.push(`SPM|1|${fixture.specimenId}||BLD`);
  return `${lines.join('\r')}\r`;
}

/** The ASTM equivalent, for an instrument that speaks E1394. */
export function buildAstmResultRecords(fixture: OruFixture): string {
  const d = DEFAULT_ASTM_DELIMITERS;
  const ts = fixture.timestamp ?? '20260823094500';
  const records: string[] = [
    `H${d.field}${d.repeat}${d.component}${d.escape}|${fixture.controlId}||SIM|||||LIS||P|1|${ts}`,
    buildAstmRecord(
      ['P', '1', fixture.patientId ?? '', '', '', fixture.patientName ?? '', '', '19870311', 'M'],
      d,
    ),
    buildAstmRecord(
      ['O', '1', fixture.specimenId, fixture.specimenId, '^^^CBC', 'R', ts, ts, '', '', '', 'N'],
      d,
    ),
  ];
  fixture.observations.forEach((observation, index) => {
    records.push(
      buildAstmRecord(
        [
          'R',
          String(index + 1),
          `^^^${observation.code}`,
          observation.value,
          observation.unit ?? '',
          '',
          observation.flags ?? '',
          '',
          'F',
          '',
          'TECH1',
          ts,
          ts,
          'SIM',
        ],
        d,
      ),
    );
  });
  records.push(buildAstmRecord(['L', '1', 'N'], d));
  return records.join('\r');
}

function buildQbpQ11(barcode: string, controlId: string): string {
  return (
    [
      `MSH|^~\\&|XN1000|LAB|VIMSHMS|VIMS|20260823094500||QBP^Q11^QBP_Q11|${controlId}|P|2.5.1`,
      `QPD|WOS^Work Order Specimen^HL70471|${controlId}|${barcode}`,
      'RCP|I',
    ].join('\r') + '\r'
  );
}
