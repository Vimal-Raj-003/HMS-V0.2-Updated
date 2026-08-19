import { describe, expect, it } from 'vitest';

import { sampleContext } from '../fixtures.js';
import { PrintTemplateError } from '../types.js';
import { LINE_WIDTH, encodeEscPosText, escpos, toHex, toPrintableText } from './commands.js';
import { renderTokenSlip, tokenSlipTemplate } from './token-slip.js';

describe('ESC/POS control sequences', () => {
  it('emits ESC @ for init and ESC a n for alignment', () => {
    expect(toHex(escpos().init().build())).toBe('1B 40');
    expect(toHex(escpos().align('left').build())).toBe('1B 61 00');
    expect(toHex(escpos().align('center').build())).toBe('1B 61 01');
    expect(toHex(escpos().align('right').build())).toBe('1B 61 02');
  });

  it('emits ESC E for bold, ESC - for underline and ESC t for the code page', () => {
    expect(toHex(escpos().bold(true).bold(false).build())).toBe('1B 45 01 1B 45 00');
    expect(toHex(escpos().underline(true).underline(false).build())).toBe('1B 2D 01 1B 2D 00');
    expect(toHex(escpos().codePage(19).build())).toBe('1B 74 13');
  });

  it('packs GS ! width/height multipliers into one nibble each, and clamps them', () => {
    expect(toHex(escpos().size(1, 1).build())).toBe('1D 21 00');
    expect(toHex(escpos().size(2, 2).build())).toBe('1D 21 11');
    expect(toHex(escpos().size(4, 4).build())).toBe('1D 21 33');
    expect(toHex(escpos().size(99, 0).build())).toBe('1D 21 70');
  });

  it('emits ESC d for feed and GS V 66 for the partial cut', () => {
    expect(toHex(escpos().feed(3).build())).toBe('1B 64 03');
    expect(toHex(escpos().cut().build())).toBe('1D 56 42 03');
    expect(toHex(escpos().cut(0).build())).toBe('1D 56 42 00');
    expect(toHex(escpos().feed(-5).build())).toBe('1B 64 00');
  });

  it('emits the ESC p cash-drawer kick', () => {
    expect(toHex(escpos().openCashDrawer().build())).toBe('1B 70 00 19 FA');
    expect(toHex(escpos().openCashDrawer(1).build())).toBe('1B 70 01 19 FA');
  });

  it('emits the four-part GS ( k QR sequence in order: model, size, ECC, store, print', () => {
    const hex = toHex(escpos().qr('AB', 6).build());
    expect(hex).toBe(
      [
        '1D 28 6B 04 00 31 41 32 00', // model 2
        '1D 28 6B 03 00 31 43 06', // module size 6
        '1D 28 6B 03 00 31 45 31', // error correction M
        '1D 28 6B 05 00 31 50 30 41 42', // store "AB" (len = 2 + 3)
        '1D 28 6B 03 00 31 51 30', // print
      ].join(' '),
    );
  });

  it('clamps the QR module size to the printer range', () => {
    expect(toHex(escpos().qr('A', 99).build())).toContain('31 43 10');
    expect(toHex(escpos().qr('A', 0).build())).toContain('31 43 01');
  });

  it('emits GS k 73 Code 128 with the code-set-B prefix and a length byte', () => {
    const hex = toHex(escpos().code128('L4471', 60).build());
    expect(hex).toContain('1D 68 3C'); // height 60
    expect(hex).toContain('1D 77 02'); // module width
    expect(hex).toContain('1D 48 02'); // HRI below
    // GS k 73 <len=7> { B L 4 4 7 1
    expect(hex).toContain('1D 6B 49 07 7B 42 4C 34 34 37 31');
  });

  it('lays out a key/value row padded to the paper width', () => {
    const text = toPrintableText(escpos().keyValue('Counter', 'C3', 20).build());
    expect(text).toBe(`Counter${' '.repeat(11)}C3\n`);
    expect(text.trimEnd()).toHaveLength(20);
  });

  it('never lets an overlong row lose the value', () => {
    expect(toPrintableText(escpos().keyValue('AAAAAAAAAA', 'BBBBBBBBBB', 5).build())).toBe(
      'AAAAAAAAAA BBBBBBBBBB\n',
    );
  });
});

describe('single-byte encoding', () => {
  it('transliterates characters the code page lacks instead of printing mojibake', () => {
    expect(String.fromCharCode(...encodeEscPosText('₹1,250.00'))).toBe('Rs.1,250.00');
    expect(String.fromCharCode(...encodeEscPosText('A — B … C'))).toBe('A - B ... C');
  });

  it('replaces anything else outside ASCII with ?', () => {
    expect(String.fromCharCode(...encodeEscPosText('ரமேஷ்'))).toBe('?????');
  });
});

describe('the token slip template', () => {
  const payload = {
    tokenNumber: 'C-45',
    counterName: 'C3',
    departmentName: 'Orthopaedics OPD',
    doctorName: 'Dr. A. Kumar',
    queueAhead: 4,
    issuedAtLabel: '20-08-2026 09:14',
    qrData: 'https://hms.example.invalid/t/C-45',
    paper: 'thermal_80mm' as const,
  };

  it('starts with an init, prints the token at 4x and ends with a cut', () => {
    const result = renderTokenSlip(payload, sampleContext());
    const hex = toHex(result.bytes);
    expect(result.format).toBe('escpos');
    expect(result.contentType).toBe('application/octet-stream');
    expect(result.paper).toBe('thermal_80mm');
    expect(hex.startsWith('1B 40')).toBe(true);
    expect(hex).toContain('1D 21 33'); // 4x4 for the token number
    expect(hex.endsWith('1D 56 42 03')).toBe(true);
  });

  it('prints the numbers a patient actually reads', () => {
    const text = toPrintableText(renderTokenSlip(payload, sampleContext()).bytes);
    expect(text).toContain('C-45');
    expect(text).toContain('Orthopaedics OPD');
    expect(text).toContain('Dr. A. Kumar');
    expect(text).toContain('Counter');
    expect(text).toContain('C3');
    expect(text).toContain('Ahead of you');
    expect(text).toContain('4');
    expect(text).toContain('20-08-2026 09:14');
  });

  it('sizes the rule to the paper width', () => {
    const wide = toPrintableText(renderTokenSlip(payload, sampleContext()).bytes);
    const narrow = toPrintableText(
      renderTokenSlip({ ...payload, paper: 'thermal_58mm' }, sampleContext()).bytes,
    );
    expect(wide).toContain('-'.repeat(LINE_WIDTH.thermal_80mm));
    expect(narrow).toContain('-'.repeat(LINE_WIDTH.thermal_58mm));
    expect(narrow).not.toContain('-'.repeat(LINE_WIDTH.thermal_80mm));
  });

  it('omits the optional blocks when they are absent', () => {
    const minimal = renderTokenSlip(
      {
        tokenNumber: 'A1',
        counterName: 'K1',
        departmentName: 'Kiosk',
        queueAhead: 0,
        issuedAtLabel: '20-08-2026 09:00',
        paper: 'thermal_58mm',
      },
      sampleContext(),
    );
    const hex = toHex(minimal.bytes);
    expect(hex).not.toContain('1D 28 6B'); // no QR
    expect(toPrintableText(minimal.bytes)).not.toContain('UHID');
    expect(toPrintableText(minimal.bytes)).not.toContain('Patient');
  });

  it('marks a reprint as a duplicate (EN-005 §5)', () => {
    const text = toPrintableText(
      renderTokenSlip(payload, sampleContext({ duplicate: true, duplicateReason: 'Patient lost slip' })).bytes,
    );
    expect(text).toContain('** DUPLICATE **');
  });

  it('validates its payload through the registry wrapper', () => {
    expect(tokenSlipTemplate.validate(payload)).toEqual({ ok: true });
    const bad = tokenSlipTemplate.validate({ ...payload, queueAhead: -1 });
    expect(bad.ok).toBe(false);
    expect(() => tokenSlipTemplate.render({ ...payload, tokenNumber: '' }, sampleContext())).toThrow(
      PrintTemplateError,
    );
  });

  it('is deterministic — the same payload produces the same bytes', () => {
    const a = renderTokenSlip(payload, sampleContext()).bytes;
    const b = renderTokenSlip(payload, sampleContext()).bytes;
    expect(toHex(a)).toBe(toHex(b));
  });
});
