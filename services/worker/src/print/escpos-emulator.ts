import { ESC, GS, toHex, toPrintableText } from '@vims/print-templates';

import {
  PrintPermanentError,
  PrinterUnavailableError,
  type PrinterStatus,
  type PrinterTransport,
  type PrinterUnavailableReason,
  type TransportRequest,
  type TransportResult,
} from './types.js';

/**
 * The ESC/POS emulator — a thermal printer that exists only in a test.
 *
 * Phase 0 exit gate 6 asks for "a test job printed a token to the ESC/POS
 * emulator". The value is not that bytes were accepted; it is that the bytes are
 * *read back* and shown to contain the token number, the counter and a cut. A
 * receipt printer gives no feedback at all — an unterminated command silently
 * swallows the next 200 characters and the slip comes out blank — so decoding
 * the stream is the only way to know the slip is right before a hospital finds
 * out at a counter.
 *
 * The printable-text half is deliberately **not** reimplemented here:
 * `toPrintableText()` in `@vims/print-templates` already scans the stream with
 * knowledge of each command's length, and a second scanner would drift from the
 * builder that produced the bytes. What this module adds is the half that
 * scanner throws away — *which* control sequences were used, in order, with
 * their arguments — because "did the cutter fire?" cannot be answered from the
 * text.
 */

export type EscPosControlName =
  | 'INIT'
  | 'SELECT_CODE_PAGE'
  | 'ALIGN'
  | 'BOLD'
  | 'UNDERLINE'
  | 'CHAR_SIZE'
  | 'FEED_LINES'
  | 'CASH_DRAWER_KICK'
  | 'CUT_PARTIAL'
  | 'BARCODE_HEIGHT'
  | 'BARCODE_MODULE_WIDTH'
  | 'BARCODE_HRI'
  | 'BARCODE_PRINT'
  | 'QR_MODEL'
  | 'QR_MODULE_SIZE'
  | 'QR_ERROR_CORRECTION'
  | 'QR_STORE'
  | 'QR_PRINT'
  | 'UNKNOWN';

export interface EscPosControl {
  readonly name: EscPosControlName;
  /** Byte offset in the stream — lets a failure point at *where* it went wrong. */
  readonly offset: number;
  /** Total bytes consumed, opcode included. */
  readonly length: number;
  /** The whole sequence, hex-dumped, exactly as `toHex()` renders it. */
  readonly hex: string;
  /** Argument bytes, after the opcode. */
  readonly args: readonly number[];
  /** Decoded operand for the commands that carry one (QR/barcode payloads). */
  readonly data?: string | undefined;
}

export interface DecodedEscPos {
  /** What a patient reads, control sequences removed. */
  readonly text: string;
  readonly lines: readonly string[];
  readonly controls: readonly EscPosControl[];
  readonly hex: string;
  readonly byteLength: number;
  /** `GS V 66` occurrences — a slip that never cuts jams the next one. */
  readonly cuts: number;
  readonly qrPayloads: readonly string[];
  readonly barcodePayloads: readonly string[];
  hasControl(name: EscPosControlName): boolean;
}

/** Argument-byte counts for the fixed-length `ESC x` commands. */
const ESC_COMMANDS: Readonly<Record<number, readonly [EscPosControlName, number]>> = Object.freeze({
  0x40: ['INIT', 0],
  0x74: ['SELECT_CODE_PAGE', 1],
  0x61: ['ALIGN', 1],
  0x45: ['BOLD', 1],
  0x2d: ['UNDERLINE', 1],
  0x64: ['FEED_LINES', 1],
  0x70: ['CASH_DRAWER_KICK', 3],
});

/** Argument-byte counts for the fixed-length `GS x` commands. */
const GS_COMMANDS: Readonly<Record<number, readonly [EscPosControlName, number]>> = Object.freeze({
  0x21: ['CHAR_SIZE', 1],
  0x56: ['CUT_PARTIAL', 2],
  0x68: ['BARCODE_HEIGHT', 1],
  0x77: ['BARCODE_MODULE_WIDTH', 1],
  0x48: ['BARCODE_HRI', 1],
});

/** `GS ( k` sub-functions, keyed by the `fn` byte that follows `cn = 49`. */
const QR_FUNCTIONS: Readonly<Record<number, EscPosControlName>> = Object.freeze({
  0x41: 'QR_MODEL',
  0x43: 'QR_MODULE_SIZE',
  0x45: 'QR_ERROR_CORRECTION',
  0x50: 'QR_STORE',
  0x51: 'QR_PRINT',
});

function ascii(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) if (byte >= 0x20 && byte <= 0x7e) out += String.fromCharCode(byte);
  return out;
}

/**
 * Walk the stream and describe every control sequence.
 *
 * The lengths matter more than they look: half of the ESC/POS opcodes (`a`,
 * `E`, `d`, `!`, `V`) are printable ASCII, so a scanner that does not know how
 * many argument bytes each command consumes will resynchronise on an argument
 * byte and report commands that were never sent.
 */
export function scanEscPosControls(bytes: Uint8Array): readonly EscPosControl[] {
  const controls: EscPosControl[] = [];
  const push = (name: EscPosControlName, offset: number, end: number, data?: string): void => {
    const slice = bytes.subarray(offset, end);
    controls.push({
      name,
      offset,
      length: end - offset,
      hex: toHex(slice),
      args: [...slice.subarray(2)],
      data,
    });
  };

  let index = 0;
  while (index < bytes.length) {
    const byte = bytes[index];
    if (byte === undefined) break;

    if (byte === ESC && index + 1 < bytes.length) {
      const opcode = bytes[index + 1] ?? 0;
      const known = ESC_COMMANDS[opcode];
      const length = 2 + (known?.[1] ?? 0);
      push(known?.[0] ?? 'UNKNOWN', index, index + length);
      index += length;
      continue;
    }

    if (byte === GS && index + 1 < bytes.length) {
      const opcode = bytes[index + 1] ?? 0;

      if (opcode === 0x6b) {
        // GS k <symbology> <len> <data…> — the Code 128 form the builder emits.
        const length = bytes[index + 3] ?? 0;
        const end = index + 4 + length;
        push('BARCODE_PRINT', index, end, ascii(bytes.subarray(index + 4, end)));
        index = end;
        continue;
      }

      if (opcode === 0x28) {
        // GS ( k pL pH cn fn <data…>
        const pL = bytes[index + 3] ?? 0;
        const pH = bytes[index + 4] ?? 0;
        const end = index + 5 + (pL | (pH << 8));
        const fn = bytes[index + 6] ?? 0;
        const name = QR_FUNCTIONS[fn] ?? 'UNKNOWN';
        // The store command is `cn fn m <data…>`: three bytes before the payload.
        const data = name === 'QR_STORE' ? ascii(bytes.subarray(index + 8, end)) : undefined;
        push(name, index, end, data);
        index = end;
        continue;
      }

      const known = GS_COMMANDS[opcode];
      const length = 2 + (known?.[1] ?? 0);
      push(known?.[0] ?? 'UNKNOWN', index, index + length);
      index += length;
      continue;
    }

    index += 1;
  }

  return controls;
}

/** Decode a stream into everything a test can assert about it. */
export function decodeEscPos(bytes: Uint8Array): DecodedEscPos {
  const controls = scanEscPosControls(bytes);
  const text = toPrintableText(bytes);

  const decoded: DecodedEscPos = {
    text,
    lines: text.split('\n'),
    controls,
    hex: toHex(bytes),
    byteLength: bytes.length,
    cuts: controls.filter((control) => control.name === 'CUT_PARTIAL').length,
    qrPayloads: controls
      .filter((control) => control.name === 'QR_STORE')
      .map((control) => control.data ?? '')
      .filter((value) => value.length > 0),
    barcodePayloads: controls
      .filter((control) => control.name === 'BARCODE_PRINT')
      .map((control) => control.data ?? '')
      .filter((value) => value.length > 0),
    hasControl(name: EscPosControlName): boolean {
      return controls.some((control) => control.name === name);
    },
  };
  return decoded;
}

/**
 * Split a stream into slips at each cut.
 *
 * A job may contain several documents — `EN-005 §4.1` prints one receipt plus an
 * office copy, and a lab order prints one label per container — and "the cut
 * fired between them" is exactly the property that stops two patients' slips
 * coming out as one strip.
 */
export function splitEscPosOnCut(bytes: Uint8Array): readonly Uint8Array[] {
  const segments: Uint8Array[] = [];
  let start = 0;
  for (const control of scanEscPosControls(bytes)) {
    if (control.name !== 'CUT_PARTIAL') continue;
    const end = control.offset + control.length;
    segments.push(bytes.subarray(start, end));
    start = end;
  }
  if (start < bytes.length) segments.push(bytes.subarray(start));
  return segments;
}

export type EmulatorFault = 'none' | 'offline' | 'paper_out' | 'door_open' | 'error';

const FAULT_REASON: Readonly<Record<Exclude<EmulatorFault, 'none'>, PrinterUnavailableReason>> =
  Object.freeze({
    offline: 'printer_offline',
    paper_out: 'paper_out',
    door_open: 'door_open',
    error: 'printer_error',
  });

const FAULT_STATUS: Readonly<Record<EmulatorFault, PrinterStatus>> = Object.freeze({
  none: 'online',
  offline: 'offline',
  paper_out: 'paper_out',
  door_open: 'door_open',
  error: 'error',
});

export interface EscPosEmulatorOptions {
  readonly id?: string;
  /** Simulate a device fault from the start — the offline path of `docs/01 §7`. */
  readonly fault?: EmulatorFault;
}

/**
 * A thermal printer test double.
 *
 * It is a `PrinterTransport`, so the dispatcher cannot tell it from the LAN
 * agent, and it can be told to be out of paper — which is how the
 * "printer offline → job stays queued with a print-elsewhere option" path of
 * `docs/01 §7` is tested without unplugging anything.
 */
export class EscPosEmulator implements PrinterTransport {
  readonly id: string;
  #fault: EmulatorFault;
  readonly #slips: DecodedEscPos[] = [];
  readonly #jobs: string[] = [];

  constructor(options: EscPosEmulatorOptions = {}) {
    this.id = options.id ?? 'escpos-emulator';
    this.#fault = options.fault ?? 'none';
  }

  get status(): PrinterStatus {
    return FAULT_STATUS[this.#fault];
  }

  /** Every slip the printer has produced, in order, one per cut. */
  get slips(): readonly DecodedEscPos[] {
    return this.#slips;
  }

  get lastSlip(): DecodedEscPos | undefined {
    return this.#slips.at(-1);
  }

  /** Job ids accepted, so a test can assert the queue did not print twice. */
  get printedJobIds(): readonly string[] {
    return this.#jobs;
  }

  setFault(fault: EmulatorFault): void {
    this.#fault = fault;
  }

  reset(): void {
    this.#slips.length = 0;
    this.#jobs.length = 0;
  }

  send(request: TransportRequest): Promise<TransportResult> {
    if (request.artifact.format !== 'escpos') {
      return Promise.reject(
        new PrintPermanentError(
          `The ESC/POS emulator cannot print a "${request.artifact.format}" artifact; the printer mapping sends the wrong driver mode.`,
        ),
      );
    }

    if (this.#fault !== 'none') {
      return Promise.reject(
        new PrinterUnavailableError(FAULT_REASON[this.#fault], request.printer.printerId),
      );
    }

    for (let copy = 0; copy < Math.max(1, request.copies); copy += 1) {
      for (const segment of splitEscPosOnCut(request.artifact.bytes)) {
        this.#slips.push(decodeEscPos(segment));
      }
      this.#jobs.push(request.jobId);
    }

    return Promise.resolve({ state: 'printed', pages: this.#slips.length });
  }
}
