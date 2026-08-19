import { describe, expect, it } from 'vitest';

import { sampleContext } from './fixtures.js';
import {
  BUILT_IN_TEMPLATES,
  defaultTemplateFor,
  getTemplate,
  listTemplates,
  requireTemplate,
} from './registry.js';
import { PrintTemplateError } from './types.js';

describe('the built-in template registry', () => {
  it('registers one template per key, named `<docType>.<format>.v<version>`', () => {
    const keys = BUILT_IN_TEMPLATES.map((template) => template.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const template of BUILT_IN_TEMPLATES) {
      expect(template.key, template.key).toBe(`${template.docType}.${templateFormatSuffix(template.format)}.v${template.version}`);
    }
  });

  it('covers all three print pipelines EN-005 §3.5 requires', () => {
    const formats = new Set(BUILT_IN_TEMPLATES.map((template) => template.format));
    expect(formats).toEqual(new Set(['a4', 'escpos', 'zpl']));
  });

  it('marks every built-in template as PHI-bearing, so EN-024 audits the print', () => {
    for (const template of BUILT_IN_TEMPLATES) {
      expect(template.phi, template.key).toBe(true);
    }
  });

  it('looks templates up by key and filters by doc type and format', () => {
    expect(getTemplate('token.escpos.v1')?.docType).toBe('token');
    expect(getTemplate('nope.v1')).toBeUndefined();
    expect(listTemplates({ format: 'zpl' }).map((t) => t.key)).toEqual([
      'lab_label.zpl.v1',
      'wristband.zpl.v1',
    ]);
    expect(listTemplates({ docType: 'token' })).toHaveLength(1);
    expect(listTemplates({ docType: 'token', format: 'zpl' })).toHaveLength(0);
    expect(listTemplates()).toHaveLength(BUILT_IN_TEMPLATES.length);
  });

  it('resolves the seed default for a document type', () => {
    expect(defaultTemplateFor('lab_label')?.key).toBe('lab_label.zpl.v1');
    expect(defaultTemplateFor('visitor_pass')).toBeUndefined();
  });

  it('fails a print job loudly when its mapped template key does not exist', () => {
    expect(() => requireTemplate('token.escpos.v9')).toThrow(PrintTemplateError);
    expect(() => requireTemplate('token.escpos.v9')).toThrow(/Known keys/);
    expect(requireTemplate('wristband.zpl.v1').format).toBe('zpl');
  });

  it('renders every built-in template from its own sample payload without throwing', () => {
    const payloads: Readonly<Record<string, unknown>> = {
      'bill_a4.html.v1': { title: 'Tax Invoice' },
      'token.escpos.v1': {
        tokenNumber: 'C-1',
        counterName: 'C1',
        departmentName: 'OPD',
        queueAhead: 0,
        issuedAtLabel: '20-08-2026 09:00',
      },
      'lab_label.zpl.v1': {
        accessionNo: 'L-1',
        patientName: 'A B',
        uhid: 'UH1',
        ageSex: '30/F',
        testName: 'CBC',
        containerLabel: 'EDTA 1 of 1',
        collectedAtLabel: '20-08 08:00',
      },
      'wristband.zpl.v1': {
        patientName: 'A B',
        uhid: 'UH1',
        ipNumber: 'IP-1',
        ageSex: '30/F',
        wardBed: 'W1/B1',
        admittedAtLabel: '20-08-2026 07:00',
        barcodeData: 'UH1',
      },
    };

    for (const template of BUILT_IN_TEMPLATES) {
      const result = template.render(payloads[template.key], sampleContext());
      expect(result.format, template.key).toBe(template.format);
      expect(result.paper, template.key).toBe(template.paper);
      if (result.format === 'escpos') {
        expect(result.bytes.length, template.key).toBeGreaterThan(0);
      } else if (result.format === 'zpl') {
        expect(result.zpl.startsWith('^XA'), template.key).toBe(true);
      } else {
        expect(result.html.length, template.key).toBeGreaterThan(0);
      }
    }
  });
});

function templateFormatSuffix(format: string): string {
  return format === 'a4' || format === 'a5' ? 'html' : format;
}
