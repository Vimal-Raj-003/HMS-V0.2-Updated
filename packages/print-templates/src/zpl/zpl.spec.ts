import { describe, expect, it } from 'vitest';

import { sampleContext } from '../fixtures.js';
import { PrintTemplateError } from '../types.js';
import { escapeZplData, labelDots, mmToDots, zpl } from './commands.js';
import { labLabelTemplate, renderLabLabel } from './lab-label.js';
import { renderWristband, wristbandTemplate } from './wristband.js';

describe('ZPL command builder', () => {
  it('opens with ^XA, a UTF-8 code page and the label geometry, and closes with ^XZ', () => {
    const out = zpl(203).start(50, 25).end().build();
    expect(out.startsWith('^XA^CI28^LH0,0^PW400^LL200')).toBe(true);
    expect(out.endsWith('^XZ')).toBe(true);
  });

  it('converts millimetres to dots for both printer classes', () => {
    expect(mmToDots(50, 203)).toBe(400);
    expect(mmToDots(50, 300)).toBe(590);
    expect(labelDots(50, 25, 203)).toEqual({ width: 400, height: 200 });
    expect(zpl(300).start(50, 25).build()).toContain('^PW590^LL295');
    expect(zpl().dpi).toBe(203);
  });

  it('emits ^FO/^A0/^FD/^FS for text', () => {
    expect(zpl(203).text(2, 1.5, 'Ramesh 45/M', 18).build()).toBe('^FO16,12^A0N,18,11^FDRamesh 45/M^FS');
    expect(zpl(203).text(2, 2, 'Rotated', 18, 'R').build()).toContain('^A0R,18,11');
  });

  it('emits ^BY + ^BCN for Code 128 with human-readable text', () => {
    const out = zpl(203).code128(2, 10, 'L4471', 40).build();
    expect(out).toBe('^FO16,80^BY2,3.0,40^BCN,40,Y,N,N^FDL4471^FS');
    expect(zpl(203).code128(2, 10, 'L4471', 40, false).build()).toContain('^BCN,40,N,N,N');
    expect(zpl(300).code128(2, 10, 'L4471', 60).build()).toContain('^BY3,3.0,60');
  });

  it('emits ^BQN model 2 with the QA automatic-mode prefix', () => {
    expect(zpl(203).qr(2, 2, 'https://x.invalid/a', 4).build()).toBe(
      '^FO16,16^BQN,2,4^FDQA,https://x.invalid/a^FS',
    );
    expect(zpl(203).qr(0, 0, 'x', 99).build()).toContain('^BQN,2,10');
    expect(zpl(203).qr(0, 0, 'x', 0).build()).toContain('^BQN,2,1');
  });

  it('emits ^GB boxes, ^FB blocks, ^FR inverse fields and ^PQ quantities', () => {
    expect(zpl(203).box(0, 0, 50, 25, 2).build()).toBe('^FO0,0^GB400,200,2^FS');
    expect(zpl(203).textBlock(2, 20, 46, 'Serum potassium', 14, 1).build()).toContain('^FB368,1,0,L,0');
    expect(zpl(203).inverseText(38, 1.5, 'STAT', 18).build()).toContain('^FR^FDSTAT^FS');
    expect(zpl(203).quantity(4).build()).toBe('^PQ4,0,1,Y');
    expect(zpl(203).quantity(0).build()).toBe('^PQ1,0,1,Y');
    expect(zpl(203).quantity(10_000).build()).toBe('^PQ999,0,1,Y');
    expect(zpl(203).raw('^MD10').build()).toBe('^MD10');
  });

  it('sanitises ZPL control characters out of field data', () => {
    expect(escapeZplData('A^B~C\\D')).toBe('A B C D');
    expect(escapeZplData('line1\nline2')).toBe('line1 line2');
    expect(zpl(203).text(0, 0, 'Fever^~', 18).build()).toContain('^FDFever  ^FS');
  });
});

describe('the specimen label template', () => {
  const payload = {
    accessionNo: 'L-4471',
    patientName: 'Ramesh S',
    uhid: 'UH0004471',
    ageSex: '45/M',
    testName: 'Serum Potassium',
    containerLabel: 'EDTA 1 of 3',
    collectedAtLabel: '20-08 08:12',
    priority: 'routine' as const,
    copies: 3,
    dpi: 203 as const,
  };

  it('carries two human-readable identifiers plus the Code 128 accession barcode', () => {
    const result = renderLabLabel(payload, sampleContext());
    expect(result.format).toBe('zpl');
    expect(result.contentType).toBe('application/vnd.zpl');
    expect(result.paper).toBe('label_50x25');
    expect(result.zpl).toContain('^FDRamesh S 45/M^FS');
    expect(result.zpl).toContain('^FDUHID UH0004471^FS');
    expect(result.zpl).toContain('^BCN,40,Y,N,N^FDL-4471^FS');
    expect(result.zpl).toContain('Serum Potassium | EDTA 1 of 3');
  });

  it('prints one label per container (EN-005 §14.5)', () => {
    const result = renderLabLabel(payload, sampleContext());
    expect(result.copies).toBe(3);
    expect(result.zpl).toContain('^PQ3,0,1,Y');
  });

  it('lets the barcode data differ from the accession number', () => {
    expect(renderLabLabel({ ...payload, barcodeData: 'GS1-0012345' }, sampleContext()).zpl).toContain(
      '^FDGS1-0012345^FS',
    );
  });

  it('inverse-prints the STAT flag only for STAT orders', () => {
    expect(renderLabLabel({ ...payload, priority: 'stat' }, sampleContext()).zpl).toContain('^FR^FDSTAT^FS');
    expect(renderLabLabel(payload, sampleContext()).zpl).not.toContain('STAT');
  });

  it('marks a relabel after collection', () => {
    expect(renderLabLabel(payload, sampleContext({ duplicate: true })).zpl).toContain('^FDRELABEL^FS');
  });

  it('scales every coordinate for a 300 dpi printer', () => {
    const at300 = renderLabLabel({ ...payload, dpi: 300 }, sampleContext()).zpl;
    expect(at300).toContain('^PW590^LL295');
    expect(at300).toContain('^BY3,3.0,60');
  });

  it('rejects a payload that would produce an unscannable label', () => {
    expect(labLabelTemplate.validate(payload)).toEqual({ ok: true });
    const bad = labLabelTemplate.validate({ ...payload, accessionNo: '' });
    expect(bad.ok).toBe(false);
    expect(() => labLabelTemplate.render({ ...payload, copies: 0 }, sampleContext())).toThrow(
      PrintTemplateError,
    );
  });
});

describe('the wristband template', () => {
  const payload = {
    patientName: 'Ramesh S',
    uhid: 'UH0004471',
    ipNumber: 'IP-2026-0912',
    ageSex: '45/M',
    bloodGroup: 'B+',
    wardBed: 'Ward 3B / Bed 12',
    admittedAtLabel: '20-08-2026 07:40',
    allergies: ['Penicillin'],
    mlc: true,
    barcodeData: 'UH0004471',
    dpi: 203 as const,
  };

  it('carries two identifiers, the barcode, the allergy line and the MLC flag', () => {
    const result = renderWristband(payload, sampleContext());
    expect(result.paper).toBe('wristband');
    expect(result.copies).toBe(1);
    expect(result.zpl).toContain('^FDRamesh S^FS');
    expect(result.zpl).toContain('^FDUHID UH0004471^FS');
    expect(result.zpl).toContain('^FDIP IP-2026-0912  Ward 3B / Bed 12^FS');
    expect(result.zpl).toContain('^BCN,38,Y,N,N^FDUH0004471^FS');
    expect(result.zpl).toContain('^FR^FDALLERGY: Penicillin^FS');
    expect(result.zpl).toContain('^FR^FDMLC^FS');
  });

  it('omits the allergy and MLC bands when there is nothing to warn about', () => {
    const result = renderWristband({ ...payload, allergies: [], mlc: false }, sampleContext());
    expect(result.zpl).not.toContain('ALLERGY');
    expect(result.zpl).not.toContain('MLC');
  });

  it('tolerates a missing blood group without leaving a trailing gap', () => {
    const result = renderWristband({ ...payload, bloodGroup: undefined, allergies: [] }, sampleContext());
    expect(result.zpl).toContain('^FD45/M^FS');
  });

  it('validates through the registry wrapper', () => {
    expect(wristbandTemplate.validate(payload)).toEqual({ ok: true });
    expect(wristbandTemplate.validate({ ...payload, uhid: '' }).ok).toBe(false);
  });
});
