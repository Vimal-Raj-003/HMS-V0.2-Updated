import { describe, expect, it } from 'vitest';

import { sampleContext } from '../fixtures.js';
import { PrintTemplateError } from '../types.js';
import { a4DocumentTemplate, renderA4Document, type A4DocumentPayload } from './document.js';
import { bdi, escapeHtml, renderLetterhead, renderPrintFooter } from './letterhead.js';

const payload: A4DocumentPayload = {
  title: 'Tax Invoice',
  subtitle: 'Outpatient consultation & investigations',
  meta: [
    { label: 'Patient', value: 'Ramesh S' },
    { label: 'UHID', value: 'UH0004471' },
    { label: 'Bill No.', value: 'OPB-2026-000481' },
    { label: 'Date', value: '20-Aug-2026' },
  ],
  sections: [
    {
      heading: 'Charges',
      table: {
        columns: [{ label: 'Service' }, { label: 'Qty', align: 'end' }, { label: 'Amount', align: 'end' }],
        rows: [
          ['Consultation — Orthopaedics', '1', '₹800.00'],
          ['X-ray, knee AP/Lat', '1', '₹1,200.00'],
        ],
        footRows: [['Total', '', '₹2,000.00']],
      },
    },
  ],
  footerNote: 'This is a computer-generated document.',
  signature: { name: 'Dr. A. Kumar', designation: 'Consultant Orthopaedics', registrationNo: 'TN/12345' },
};

describe('escaping', () => {
  it('escapes every HTML metacharacter', () => {
    expect(escapeHtml(`<script>alert("x" & 'y')</script>`)).toBe(
      '&lt;script&gt;alert(&quot;x&quot; &amp; &#39;y&#39;)&lt;/script&gt;',
    );
  });

  it('wraps identifiers in <bdi> so they stay LTR inside an RTL page (docs/06 §8)', () => {
    expect(bdi('UH0004471')).toBe('<bdi>UH0004471</bdi>');
    expect(bdi('<b>')).toBe('<bdi>&lt;b&gt;</bdi>');
  });
});

describe('the letterhead primitive', () => {
  it('prints the hospital, branch, address, contact, GSTIN and accreditation', () => {
    const html = renderLetterhead(sampleContext());
    expect(html).toContain('Vim&#39;s Trauma &amp; Multispeciality Hospital');
    expect(html).toContain('VIMS Healthcare Private Limited');
    expect(html).toContain('Main Campus');
    expect(html).toContain('Block A, Ground Floor');
    expect(html).toContain('GSTIN: 33AABCV1234F1Z5');
    expect(html).toContain('NABH accredited');
  });

  it('embeds a logo as a data URI and never as a remote URL', () => {
    const withLogo = renderLetterhead(
      sampleContext({
        hospital: { ...sampleContext().hospital, logoDataUri: 'data:image/png;base64,iVBORw0KGgo=' },
      }),
    );
    expect(withLogo).toContain('src="data:image/png;base64,iVBORw0KGgo="');
    expect(renderLetterhead(sampleContext())).not.toContain('<img');
  });

  it('drops the legal name when it matches the brand, and the tax line when there is none', () => {
    const plain = renderLetterhead(
      sampleContext({
        hospital: { name: 'Clinic A', addressLines: ['Somewhere'] },
        branch: { name: 'Only branch', addressLines: [] },
      }),
    );
    expect(plain).not.toContain('lh-legal');
    expect(plain).not.toContain('lh-tax');
    expect(plain).not.toContain('lh-contact');
  });

  it('closes the page with who printed it, when, and the document reference', () => {
    const footer = renderPrintFooter(sampleContext());
    expect(footer).toContain('Ref: <bdi>OPB-2026-000481</bdi>');
    expect(footer).toContain('Printed by R. Devi (Front Office)');
    expect(footer).toContain('20-Aug-2026 09:14');
    expect(renderPrintFooter(sampleContext({ documentRef: null }))).not.toContain('pf-ref');
  });
});

describe('the A4 letterhead document', () => {
  it('produces a self-contained page with lang, dir and an inline stylesheet', () => {
    const result = renderA4Document(payload, sampleContext());
    expect(result.format).toBe('a4');
    expect(result.contentType).toBe('text/html');
    expect(result.paper).toBe('A4');
    expect(result.html.startsWith('<!doctype html><html lang="en-IN" dir="ltr">')).toBe(true);
    expect(result.html).toContain('@page { size: A4; margin: 12mm 12mm 16mm; }');
    expect(result.html).not.toContain('<link');
    expect(result.html).not.toContain('http://');
  });

  it('renders the title, metadata grid, table and signature', () => {
    const html = renderA4Document(payload, sampleContext()).html;
    expect(html).toContain('<h1 class="doc-title">Tax Invoice</h1>');
    expect(html).toContain('<span class="meta-label">UHID</span>');
    expect(html).toContain('<bdi>UH0004471</bdi>');
    expect(html).toContain('<th class="num">Amount</th>');
    expect(html).toContain('<td class="num"><bdi>₹1,200.00</bdi></td>');
    expect(html).toContain('<tfoot>');
    expect(html).toContain('Dr. A. Kumar');
    expect(html).toContain('Consultant Orthopaedics &middot; TN/12345');
  });

  it('uses only logical CSS properties so RTL mirrors correctly (docs/06 §8)', () => {
    const html = renderA4Document(payload, sampleContext({ direction: 'rtl', locale: 'ar' })).html;
    expect(html).toContain('dir="rtl"');
    expect(html).not.toMatch(/(?:^|[;{\s])(?:margin|padding|border)-(?:left|right)\s*:/);
    expect(html).not.toMatch(/text-align:\s*(?:left|right)/);
  });

  it('stamps DUPLICATE with its reason on a reprint (EN-005 §5)', () => {
    const html = renderA4Document(
      payload,
      sampleContext({ duplicate: true, duplicateReason: 'Patient copy lost' }),
    ).html;
    expect(html).toContain('dup-watermark');
    expect(html).toContain('DUPLICATE COPY');
    expect(html).toContain('Reason: Patient copy lost');
    expect(renderA4Document(payload, sampleContext()).html).not.toContain('DUPLICATE');
  });

  it('shows the duplicate banner even when no reason was captured', () => {
    const html = renderA4Document(payload, sampleContext({ duplicate: true })).html;
    expect(html).toContain('DUPLICATE COPY');
    expect(html).not.toContain('<div class="dup-reason">');
  });

  it('escapes payload content — a patient name is never markup', () => {
    const html = renderA4Document(
      { ...payload, title: '<img src=x onerror=alert(1)>', meta: [{ label: 'Name', value: '<b>Bob</b>' }] },
      sampleContext(),
    ).html;
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('<bdi>&lt;b&gt;Bob&lt;/b&gt;</bdi>');
  });

  it('renders an A5 variant with the right page size', () => {
    const result = renderA4Document(payload, sampleContext(), 'A5');
    expect(result.format).toBe('a5');
    expect(result.paper).toBe('A5');
    expect(result.html).toContain('size: A5');
  });

  it('handles a minimal payload — prose sections, no table, no signature', () => {
    const html = renderA4Document(
      {
        title: 'Consent for Surgery',
        meta: [],
        sections: [{ paragraphs: ['I consent to the procedure described above.'] }],
      },
      sampleContext(),
    ).html;
    expect(html).toContain('I consent to the procedure described above.');
    expect(html).not.toContain('<table');
    expect(html).not.toContain('class="meta"');
    expect(html).not.toContain('class="signature"');
    expect(html).not.toContain('<div class="doc-subtitle">');
    expect(html).not.toContain('<p class="footer-note">');
  });

  it('rejects a payload without a title rather than printing a blank document', () => {
    expect(a4DocumentTemplate.validate(payload)).toEqual({ ok: true });
    const bad = a4DocumentTemplate.validate({ title: '' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.issues[0]?.path).toBe('title');
    }
    expect(() => a4DocumentTemplate.render({ title: '' }, sampleContext())).toThrow(PrintTemplateError);
    expect(() => a4DocumentTemplate.render({ title: '' }, sampleContext())).toThrow(/bill_a4\.html\.v1/);
  });
});
