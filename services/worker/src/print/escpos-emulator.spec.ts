import { escpos, sampleContext, tokenSlipTemplate } from '@vims/print-templates';
import { describe, expect, it } from 'vitest';

import { EscPosEmulator, decodeEscPos, scanEscPosControls, splitEscPosOnCut } from './escpos-emulator.js';
import { PrintPermanentError, PrinterUnavailableError, type PrinterTarget } from './types.js';

const TOKEN_PAYLOAD = {
  tokenNumber: 'C-45',
  counterName: 'Counter 3',
  departmentName: 'Orthopaedics OPD',
  doctorName: 'Dr S. Iyer',
  queueAhead: 4,
  issuedAtLabel: '20-08-2026 09:14',
  qrData: 'https://hms.example.invalid/t/C-45',
  paper: 'thermal_80mm' as const,
};

function tokenSlipBytes(): Uint8Array {
  const rendered = tokenSlipTemplate.render(TOKEN_PAYLOAD, sampleContext());
  if (rendered.format !== 'escpos') throw new Error('token template must render ESC/POS');
  return rendered.bytes;
}

const PRINTER: PrinterTarget = {
  printerId: '2f1c8bb0-9f4b-4c9a-8a2f-1d6ba0f2e001',
  name: 'OPD Counter 3 thermal',
  kind: 'thermal',
  driverMode: 'raw_escpos',
  paper: 'thermal_80mm',
  status: 'online',
  agentId: null,
  agentStatus: null,
  agentLastHeartbeatAt: null,
  branchId: '2f1c8bb0-9f4b-4c9a-8a2f-1d6ba0f2e002',
};

describe('ESC/POS control scanner', () => {
  it('names each command and records its argument bytes', () => {
    const controls = scanEscPosControls(escpos().init().align('center').bold(true).size(4, 4).cut(3).build());
    expect(controls.map((c) => c.name)).toEqual(['INIT', 'ALIGN', 'BOLD', 'CHAR_SIZE', 'CUT_PARTIAL']);
    expect(controls[1]?.args).toEqual([0x01]);
    expect(controls[4]?.hex).toBe('1D 56 42 03');
  });

  /**
   * The bug this guards against is subtle and real: `a`, `E`, `d`, `!` and `V`
   * are printable ASCII *and* ESC/POS opcodes, so a scanner that does not
   * consume each command's argument bytes resynchronises inside a command and
   * invents sequences that were never sent.
   */
  it('does not mistake printable text for commands', () => {
    const controls = scanEscPosControls(escpos().init().line('Ed Vaz size 4! GS V').build());
    expect(controls.map((c) => c.name)).toEqual(['INIT']);
  });

  it('decodes the QR and Code 128 payloads out of their variable-length wrappers', () => {
    const decoded = decodeEscPos(escpos().qr('https://x.invalid/t/9', 6).code128('L4471').build());
    expect(decoded.qrPayloads).toEqual(['https://x.invalid/t/9']);
    expect(decoded.barcodePayloads).toEqual(['{BL4471']);
  });
});

describe('token slip decoded from the byte stream', () => {
  const decoded = decodeEscPos(tokenSlipBytes());

  /** Phase 0 exit gate 6, asserted on the bytes rather than on the builder. */
  it('contains the token number, the counter and the queue position as printable text', () => {
    expect(decoded.text).toContain('C-45');
    expect(decoded.text).toContain('Counter');
    expect(decoded.text).toContain('Counter 3');
    expect(decoded.text).toContain('Ahead of you');
    expect(decoded.text).toContain('Orthopaedics OPD');
  });

  it('prints the hospital and branch identity a patient can read', () => {
    const context = sampleContext();
    expect(decoded.text).toContain(context.hospital.name);
    expect(decoded.text).toContain(context.branch.name);
  });

  it('ends with a cut, so the next patient does not receive this slip', () => {
    expect(decoded.hasControl('CUT_PARTIAL')).toBe(true);
    expect(decoded.cuts).toBe(1);
    expect(decoded.controls.at(-1)?.name).toBe('CUT_PARTIAL');
  });

  it('prints the token number at 4x and returns to 1x afterwards', () => {
    const sizes = decoded.controls.filter((c) => c.name === 'CHAR_SIZE').map((c) => c.args[0]);
    expect(sizes).toContain(0x33); // width 4, height 4
    expect(sizes.at(-1)).toBe(0x00); // back to normal before the key/value block
  });

  it('carries the patient-facing QR payload', () => {
    expect(decoded.qrPayloads).toEqual([TOKEN_PAYLOAD.qrData]);
  });

  it('never emits a byte the printer cannot render as text or command', () => {
    // Every byte is either consumed by a control sequence or printable/LF.
    const consumed = decoded.controls.reduce((total, control) => total + control.length, 0);
    const printable = decoded.text.length;
    expect(consumed + printable).toBe(decoded.byteLength);
  });
});

describe('splitEscPosOnCut', () => {
  it('splits a multi-document stream into one slip per cut', () => {
    const twice = new Uint8Array([...tokenSlipBytes(), ...tokenSlipBytes()]);
    const slips = splitEscPosOnCut(twice);
    expect(slips).toHaveLength(2);
    expect(decodeEscPos(slips[0] ?? new Uint8Array()).text).toContain('C-45');
    expect(decodeEscPos(slips[1] ?? new Uint8Array()).text).toContain('C-45');
  });

  it('keeps a trailing uncut fragment rather than discarding it', () => {
    const bytes = new Uint8Array([...tokenSlipBytes(), ...escpos().line('orphan').build()]);
    const slips = splitEscPosOnCut(bytes);
    expect(slips).toHaveLength(2);
    expect(decodeEscPos(slips[1] ?? new Uint8Array()).text).toContain('orphan');
  });
});

describe('EscPosEmulator as a transport', () => {
  const artifact = {
    format: 'escpos' as const,
    contentType: 'application/octet-stream',
    bytes: tokenSlipBytes(),
    pages: null,
  };

  it('accepts a slip and exposes it decoded', async () => {
    const printer = new EscPosEmulator();
    const result = await printer.send({ jobId: 'job-1', printer: PRINTER, artifact, copies: 1 });

    expect(result.state).toBe('printed');
    expect(printer.slips).toHaveLength(1);
    expect(printer.lastSlip?.text).toContain('C-45');
    expect(printer.lastSlip?.hasControl('CUT_PARTIAL')).toBe(true);
  });

  it('prints one slip per copy', async () => {
    const printer = new EscPosEmulator();
    await printer.send({ jobId: 'job-2', printer: PRINTER, artifact, copies: 3 });
    expect(printer.slips).toHaveLength(3);
    expect(printer.printedJobIds).toEqual(['job-2', 'job-2', 'job-2']);
  });

  it('reports a paper-out as a transient device fault, not a bad document', async () => {
    const printer = new EscPosEmulator({ fault: 'paper_out' });
    await expect(
      printer.send({ jobId: 'job-3', printer: PRINTER, artifact, copies: 1 }),
    ).rejects.toBeInstanceOf(PrinterUnavailableError);
    await expect(
      printer.send({ jobId: 'job-3', printer: PRINTER, artifact, copies: 1 }),
    ).rejects.toMatchObject({
      reason: 'paper_out',
    });
    expect(printer.status).toBe('paper_out');
    expect(printer.slips).toHaveLength(0);
  });

  it('refuses a format it cannot speak, permanently', async () => {
    const printer = new EscPosEmulator();
    await expect(
      printer.send({
        jobId: 'job-4',
        printer: PRINTER,
        artifact: { format: 'zpl', contentType: 'application/vnd.zpl', bytes: new Uint8Array([1]), pages: 1 },
        copies: 1,
      }),
    ).rejects.toBeInstanceOf(PrintPermanentError);
  });
});
