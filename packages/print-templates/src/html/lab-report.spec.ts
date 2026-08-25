import { describe, expect, it } from 'vitest';

import { SAMPLE_VERIFY_TOKEN, sampleContext, sampleLabReport } from '../fixtures.js';
import { PrintTemplateError } from '../types.js';
import { labReportTemplate, renderLabReport, type LabReportPayload } from './lab-report.js';
import { buildVerifyUrl } from './report-shell.js';

const CONTEXT = sampleContext();

function render(payload: LabReportPayload): string {
  return renderLabReport(payload, CONTEXT).html;
}

/** How many `.page` sections the template emitted, and what the last footer claims. */
function pageCount(html: string): number {
  return html.split('<section class="page">').length - 1;
}

describe('the laboratory report — document shell', () => {
  const html = render(sampleLabReport());

  it('is a self-contained A4 page with lang, dir and an inline stylesheet', () => {
    const result = renderLabReport(sampleLabReport(), CONTEXT);
    expect(result.format).toBe('a4');
    expect(result.paper).toBe('A4');
    expect(result.contentType).toBe('text/html');
    expect(html.startsWith('<!doctype html><html lang="en-IN" dir="ltr">')).toBe(true);
    expect(html).toContain('@page { size: A4; margin: 12mm 12mm 16mm; }');
    expect(html).not.toContain('<link');
    expect(html).not.toContain('<script');
  });

  it('prints the letterhead and both patient identifiers', () => {
    expect(html).toContain('Vim&#39;s Trauma &amp; Multispeciality Hospital');
    expect(html).toContain('Ramesh Subramanian');
    expect(html).toContain('<bdi>CBE-000123456</bdi>');
    expect(html).toContain('<bdi>58/M</bdi>');
    expect(html).toContain('14-Feb-1968');
  });

  it('prints the NABL 112 §7.4 mandatory set: specimen, times, interval, unit, method', () => {
    expect(html).toContain('Specimens');
    expect(html).toContain('<bdi>Serum</bdi>');
    expect(html).toContain('<bdi>20-Aug-2026 06:58</bdi>'); // collected
    expect(html).toContain('<bdi>20-Aug-2026 07:12</bdi>'); // received
    expect(html).toContain('<bdi>20-Aug-2026 08:41</bdi>'); // reported
    expect(html).toContain('Biological reference interval');
    expect(html).toContain('<bdi>3.5 – 5.1</bdi>');
    expect(html).toContain('<bdi>mmol/L</bdi>');
    expect(html).toContain('<bdi>ISE indirect</bdi>');
    expect(html).toContain('LOINC <bdi>2823-3</bdi>');
    expect(html).toContain('— End of report —');
  });

  it('numbers every page and repeats the patient identity on continuation pages', () => {
    const total = pageCount(html);
    expect(total).toBeGreaterThanOrEqual(1);
    for (let page = 1; page <= total; page += 1) {
      expect(html, `page ${String(page)}`).toContain(`Page ${String(page)} of ${String(total)}`);
    }
    expect(html).not.toContain(`Page ${String(total + 1)} of`);
  });

  it('prints the authorising signatory with credentials, registration and sign method', () => {
    expect(html).toContain('Authorised by');
    expect(html).toContain('Dr. Lakshmi Narayanan');
    expect(html).toContain('MD (Pathology) &middot; Consultant Biochemist');
    expect(html).toContain('Reg. No. TMC/48210');
    expect(html).toContain('Signed electronically (dsc)');
  });

  it('uses only logical CSS properties so an ar-AE print mirrors (docs/06 §8)', () => {
    const rtl = render(sampleLabReport());
    const arabic = renderLabReport(sampleLabReport(), sampleContext({ direction: 'rtl', locale: 'ar' })).html;
    expect(arabic).toContain('dir="rtl"');
    for (const markup of [rtl, arabic]) {
      expect(markup).not.toMatch(/(?:^|[;{\s])(?:margin|padding|border|inset)-(?:left|right)\s*:/);
      expect(markup).not.toMatch(/text-align:\s*(?:left|right)/);
    }
  });

  it('escapes payload content — an analyte name is never markup', () => {
    const payload = sampleLabReport();
    const group = payload.groups[0];
    if (group === undefined) throw new Error('fixture regression');
    const row = group.rows[0];
    if (row === undefined) throw new Error('fixture regression');
    const html2 = render({
      ...payload,
      groups: [
        { ...group, rows: [{ ...row, analyte: '<img src=x onerror=alert(1)>' }, ...group.rows.slice(1)] },
      ],
    });
    expect(html2).not.toContain('<img src=x');
    expect(html2).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('a critical value is unmissable', () => {
  const html = render(sampleLabReport());

  it('boxes it above the results with the documented call-back', () => {
    expect(html).toContain('class="critical-callout"');
    expect(html).toContain('Critical values in this report');
    expect(html).toContain('<bdi>Potassium</bdi> <bdi>6.9 mmol/L</bdi> — ▲ CRITICAL HIGH');
    expect(html).toContain('Communicated to Dr. A. Kumar (Ordering physician) via telephone');
    expect(html).toContain('Read-back confirmed.');
  });

  it('marks the row itself with an inverted chip and a heavy inside rule', () => {
    expect(html).toContain('<tr class="row-critical">');
    expect(html).toContain('<span class="flag flag-critical">▲ CRITICAL HIGH</span>');
    expect(html).toContain('tr.row-critical > td:first-child { border-inline-start: 3pt solid #000; }');
    expect(html).toContain('.flag-critical { background: #000; color: #fff;');
    expect(html).toContain('print-color-adjust: exact');
  });

  it('says so loudly when the call-back has not happened yet', () => {
    const payload = sampleLabReport();
    const critical = payload.criticalValues[0];
    if (critical === undefined) throw new Error('fixture regression');
    const pending = render({
      ...payload,
      criticalValues: [
        {
          ...critical,
          notifiedToName: undefined,
          notifiedAtLabel: undefined,
          readBackConfirmed: false,
        },
      ],
    });
    expect(pending).toContain('Communication to the ordering clinician is still pending.');
  });

  it('prints the escalation when the clinician could not be reached', () => {
    const payload = sampleLabReport();
    const critical = payload.criticalValues[0];
    if (critical === undefined) throw new Error('fixture regression');
    const escalated = render({
      ...payload,
      criticalValues: [
        {
          ...critical,
          notifiedToName: undefined,
          clinicianUnreachable: true,
          escalatedTo: 'Medical Superintendent',
          notifiedAtLabel: '20-Aug-2026 08:31',
        },
      ],
    });
    expect(escalated).toContain('Clinician unreachable — escalated to Medical Superintendent');
  });

  it('refuses a report that prints a critical number with no call-back record at all', () => {
    const payload = sampleLabReport();
    const result = labReportTemplate.validate({ ...payload, criticalValues: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.message).toMatch(/missing from criticalValues/);
    }
  });
});

describe('an unauthorised report is watermarked and unsigned', () => {
  function provisional(): LabReportPayload {
    return sampleLabReport({
      status: {
        release: 'provisional',
        version: 1,
        provisionalReason: 'Interim — 2 of 4 tests authorised',
      },
      authorisers: [
        {
          name: 'S. Meena',
          designation: 'Senior Technologist',
          registrationNo: 'n/a',
          signedAtLabel: '20-Aug-2026 08:20',
          role: 'author',
        },
      ],
    });
  }

  const html = render(provisional());

  it('stamps PROVISIONAL — NOT FOR CLINICAL USE across the page', () => {
    expect(html).toContain('class="seal seal-provisional"');
    expect(html).toContain('PROVISIONAL<br />NOT FOR CLINICAL USE');
  });

  it('carries a banner saying it is not medically authorised, and why', () => {
    expect(html).toContain('PROVISIONAL — NOT FOR CLINICAL USE.');
    expect(html).toContain('This report has not been medically authorised.');
    expect(html).toContain('Interim — 2 of 4 tests authorised');
  });

  it('prints no signature block — only who prepared it, and a refusal to be filed', () => {
    expect(html).toContain('Not authorised');
    expect(html).toContain('Prepared by S. Meena');
    expect(html).toContain('must not be filed, issued to a patient, or acted on clinically');
    expect(html).not.toContain('Authorised by');
    expect(html).not.toContain('Reg. No. TMC/48210');
  });

  it('refuses to release as final without an authorising signatory', () => {
    const result = labReportTemplate.validate(sampleLabReport({ authorisers: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.message).join(' ')).toMatch(/authorising signatory/);
    }
  });

  it('refuses to print a signature block under a provisional seal', () => {
    const result = labReportTemplate.validate(
      sampleLabReport({ status: { release: 'provisional', version: 1 } }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.message).join(' ')).toMatch(/looks final but is not/);
    }
  });
});

describe('an amended report says so, and says what changed', () => {
  function amended(): LabReportPayload {
    const base = sampleLabReport();
    const group = base.groups[0];
    if (group === undefined) throw new Error('fixture regression');
    const rows = group.rows.map((row) =>
      row.analyte === 'Creatinine' ? { ...row, value: '2.18', amended: true } : row,
    );
    return {
      ...base,
      status: {
        release: 'amended',
        version: 2,
        amendment: {
          reason: 'Sample mix-up at accessioning; the creatinine was re-run on the correct specimen.',
          supersedesVersion: 1,
          supersedesIssuedAtLabel: '20-Aug-2026 08:41',
          amendedAtLabel: '20-Aug-2026 11:02',
          amendedBy: 'Dr. Lakshmi Narayanan',
          changes: [{ item: 'Creatinine', previous: '3.42 mg/dL', current: '2.18 mg/dL' }],
        },
      },
      groups: [{ ...group, rows }],
    };
  }

  const html = render(amended());

  it('stamps AMENDED across the page', () => {
    expect(html).toContain('class="seal seal-amended"');
    expect(html).toContain('>AMENDED</div>');
  });

  it('banners the version it supersedes, who amended it, when and why', () => {
    expect(html).toContain('AMENDED REPORT — version 2.');
    expect(html).toContain('Supersedes version 1 issued 20-Aug-2026 08:41.');
    expect(html).toContain('Amended by Dr. Lakshmi Narayanan on 20-Aug-2026 11:02.');
    expect(html).toContain('Sample mix-up at accessioning');
    expect(html).toContain('Destroy or disregard any earlier printed copy.');
  });

  it('itemises the change as previous value against amended value', () => {
    expect(html).toContain('Amendment history — what changed in this version');
    expect(html).toContain('<th>Superseded value</th><th>Amended value</th>');
    expect(html).toContain(
      '<td><bdi>3.42 mg/dL</bdi></td><td class="amended-cell"><bdi>2.18 mg/dL</bdi></td>',
    );
  });

  it('marks the changed row in the results table itself', () => {
    expect(html).toContain('row-amended');
    expect(html).toContain('<span class="amended-tag">AMENDED</span>');
  });

  it('refuses an amendment with no reason and no itemised change', () => {
    const base = amended();
    const result = labReportTemplate.validate({
      ...base,
      status: { release: 'amended', version: 2 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.message).join(' ')).toMatch(/must say what changed and why/);
    }
  });

  it('refuses an amended release whose result rows are all unchanged', () => {
    const base = amended();
    const group = base.groups[0];
    if (group === undefined) throw new Error('fixture regression');
    const result = labReportTemplate.validate({
      ...base,
      groups: [{ ...group, rows: group.rows.map((row) => ({ ...row, amended: false })) }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.message).join(' ')).toMatch(/mark the rows that changed/);
    }
  });

  it('refuses a "final" release that carries an amendment record', () => {
    const base = amended();
    const amendment = base.status.amendment;
    if (amendment === undefined) throw new Error('fixture regression');
    const result = labReportTemplate.validate({
      ...base,
      status: { release: 'final', version: 2, amendment },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.message).join(' ')).toMatch(/released as "amended"/);
    }
  });
});

describe('a superseded print says so', () => {
  const html = render(
    sampleLabReport({
      status: {
        release: 'final',
        version: 1,
        superseded: { bySupersedingVersion: 2, supersededAtLabel: '20-Aug-2026 11:02' },
      },
    }),
  );

  it('stamps SUPERSEDED and names the version that replaced it', () => {
    expect(html).toContain('class="seal seal-superseded"');
    expect(html).toContain('SUPERSEDED REPORT — DO NOT USE.');
    expect(html).toContain('It was replaced by version 2 on 20-Aug-2026 11:02.');
    expect(html).toContain('Obtain the current version before acting on it.');
  });

  it('shows SUPERSEDED on the continuation strip too, if the report runs on', () => {
    const long = sampleLabReport({
      status: {
        release: 'final',
        version: 1,
        superseded: { bySupersedingVersion: 2, supersededAtLabel: '20-Aug-2026 11:02' },
      },
      groups: [longGroup(60)],
      criticalValues: [],
    });
    const markup = render(long);
    expect(pageCount(markup)).toBeGreaterThan(1);
    expect(markup).toContain('<span class="cont-status">SUPERSEDED</span>');
  });
});

describe('the verification QR carries a token and nothing else', () => {
  const payload = sampleLabReport();
  const html = render(payload);

  it('encodes exactly the verify base plus the opaque token', () => {
    const url = buildVerifyUrl(payload.verify, []);
    expect(url).toBe(`https://verify.vims-hospital.example/r/${SAMPLE_VERIFY_TOKEN}`);
    expect(html).toContain(url);
  });

  it('puts no patient identifier anywhere in or around the symbol', () => {
    const start = html.indexOf('<div class="qr-block">');
    const end = html.indexOf('</div></div>', start);
    const block = html.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    for (const identifier of ['Ramesh', 'CBE-000123456', '14-Feb-1968', '58/M']) {
      expect(block, identifier).not.toContain(identifier);
    }
    expect(block).toContain('aria-label="QR code linking to the report verification page"');
  });

  it('throws rather than print a QR whose URL carries an identifier', () => {
    expect(() =>
      buildVerifyUrl({ baseUrl: 'https://verify.example/r', token: 'CBE0001234561234567' }, [
        'CBE-000123456',
        'CBE0001234561234567',
      ]),
    ).toThrow(PrintTemplateError);
    expect(() =>
      buildVerifyUrl({ baseUrl: 'https://verify.example/r/CBE-000123456', token: SAMPLE_VERIFY_TOKEN }, [
        'CBE-000123456',
      ]),
    ).toThrow(/opaque token and nothing else/);
  });

  it('rejects a verify base carrying a query string, which is where PHI would hide', () => {
    const result = labReportTemplate.validate({
      ...payload,
      verify: { ...payload.verify, baseUrl: 'https://verify.example/r?uhid=CBE-000123456' },
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a token that is not opaque', () => {
    const result = labReportTemplate.validate({
      ...payload,
      verify: { ...payload.verify, token: 'Ramesh Subramanian 58M' },
    });
    expect(result.ok).toBe(false);
  });
});

describe('accreditation marking', () => {
  it('footnotes an out-of-scope result and never claims the mark for it', () => {
    const html = render(sampleLabReport());
    expect(html).toContain('<sup>†</sup>');
    expect(html).toContain('not within the laboratory’s NABL accredited scope');
    expect(html).toContain('Performed at Partner Reference Laboratory, Chennai');
  });

  it('refuses to print the accreditation mark when any result is out of scope', () => {
    const result = labReportTemplate.validate(sampleLabReport({ accreditation: { nablLogoPrinted: true } }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.message).join(' ')).toMatch(/within accredited scope/);
    }
  });
});

// ── Pagination ──────────────────────────────────────────────────────────────

function longGroup(rows: number): LabReportPayload['groups'][number] {
  return {
    heading: 'Extended metabolic panel',
    method: 'Various',
    rows: Array.from({ length: rows }, (_, index) => ({
      analyte: `Analyte ${String(index + 1).padStart(2, '0')}`,
      value: (index + 1).toFixed(2),
      unit: 'mg/dL',
      referenceInterval: '0.10 – 9.90',
      flag: 'normal' as const,
      method: 'Enzymatic',
      deltaFlagged: false,
      amended: false,
      outsideNablScope: false,
    })),
    notes: [],
  };
}

describe('pagination', () => {
  const html = render(sampleLabReport({ groups: [longGroup(90)], criticalValues: [] }));
  const total = pageCount(html);

  it('breaks a long report across pages and numbers them n of N', () => {
    expect(total).toBeGreaterThan(2);
    for (let page = 1; page <= total; page += 1) {
      expect(html).toContain(`Page ${String(page)} of ${String(total)}`);
    }
  });

  it('identifies the patient on every continuation page (NABL 112 §7.4.1.1)', () => {
    const strips = html.split('<div class="cont-strip">').length - 1;
    expect(strips).toBe(total - 1);
    const stripUhids = html.split('<span>UHID <bdi>CBE-000123456</bdi></span>').length - 1;
    expect(stripUhids).toBe(total - 1);
  });

  it('repeats the column headings on every page a table spans', () => {
    const heads = html.split('<th>Investigation</th>').length - 1;
    expect(heads).toBe(total);
  });

  it('never splits a row: every <tr> opened on a page is closed on it', () => {
    for (const page of html.split('<section class="page">').slice(1)) {
      const opens = page.split('<tr').length - 1;
      const closes = page.split('</tr>').length - 1;
      expect(opens).toBe(closes);
      expect(page.split('<table').length - 1).toBe(page.split('</table>').length - 1);
    }
  });

  it('never orphans the signature block from the content it authorises', () => {
    const pages = html.split('<section class="page">').slice(1);
    const last = pages[pages.length - 1];
    expect(last).toBeDefined();
    expect(last).toContain('auth-block');
    // Something other than "end of report", the signature and the QR is on the
    // page: an authorisation alone under a letterhead is the orphan we forbid.
    expect(last?.includes('<td>')).toBe(true);
  });
});

describe('reprints', () => {
  it('marks a DUPLICATE print with its reason on every page footer', () => {
    const html = renderLabReport(
      sampleLabReport(),
      sampleContext({ duplicate: true, duplicateReason: 'Patient copy lost' }),
    ).html;
    expect(html).toContain('DUPLICATE &mdash; Patient copy lost');
    expect(render(sampleLabReport())).not.toContain('<span class="pf-dup">');
  });
});

describe('the registered template', () => {
  it('validates the fixture and renders it', () => {
    expect(labReportTemplate.validate(sampleLabReport())).toEqual({ ok: true });
    const rendered = labReportTemplate.render(sampleLabReport(), CONTEXT);
    expect(rendered.format).toBe('a4');
  });

  it('renders byte-identically for the same input', () => {
    expect(render(sampleLabReport())).toBe(render(sampleLabReport()));
  });

  it('rejects a payload with no results rather than printing an empty report', () => {
    expect(() => labReportTemplate.render({ ...sampleLabReport(), groups: [] }, CONTEXT)).toThrow(
      PrintTemplateError,
    );
  });
});
