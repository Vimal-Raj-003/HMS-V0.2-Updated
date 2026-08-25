import { describe, expect, it } from 'vitest';

import { sampleContext, sampleRadReport } from '../fixtures.js';
import { PrintTemplateError } from '../types.js';
import { radReportTemplate, renderRadReport, type RadReportPayload } from './rad-report.js';
import { buildVerifyUrl } from './report-shell.js';

const CONTEXT = sampleContext();

function render(payload: RadReportPayload): string {
  return renderRadReport(payload, CONTEXT).html;
}

function pageCount(html: string): number {
  return html.split('<section class="page">').length - 1;
}

const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('the radiology report — document shell', () => {
  const html = render(sampleRadReport());

  it('is a self-contained A4 page with lang, dir and an inline stylesheet', () => {
    const result = renderRadReport(sampleRadReport(), CONTEXT);
    expect(result.format).toBe('a4');
    expect(result.paper).toBe('A4');
    expect(html.startsWith('<!doctype html><html lang="en-IN" dir="ltr">')).toBe(true);
    expect(html).toContain('@page { size: A4; margin: 12mm 12mm 16mm; }');
    expect(html).not.toContain('<link');
    expect(html).not.toContain('<script');
  });

  it('prints the study identity: accession, modality, body part, room and equipment', () => {
    expect(html).toContain('<bdi>RAD-2026-001902</bdi>');
    expect(html).toContain('<bdi>CT Brain, plain</bdi>');
    expect(html).toContain('<bdi>CT</bdi>');
    expect(html).toContain('<bdi>Head</bdi>');
    expect(html).toContain('<bdi>CT Suite 1</bdi>');
    expect(html).toContain('<bdi>Siemens SOMATOM go.Top · AST-0112</bdi>');
    expect(html).toContain('<bdi>STAT</bdi>');
  });

  it('prints the request, acquisition and report times', () => {
    expect(html).toContain('<bdi>20-Aug-2026 05:52</bdi>');
    expect(html).toContain('<bdi>20-Aug-2026 06:08</bdi>');
    expect(html).toContain('<bdi>20-Aug-2026 06:31</bdi>');
  });

  it('prints the structured sections in reading order', () => {
    const order = [
      'Clinical indication',
      'Technique',
      'Contrast',
      'Comparison',
      'Findings',
      'Impression',
      'Recommendations',
      'Radiation dose',
    ];
    let cursor = -1;
    for (const heading of order) {
      const at = html.indexOf(`>${heading}</h2>`);
      expect(at, heading).toBeGreaterThan(cursor);
      cursor = at;
    }
    expect(html).toContain('class="prose impression"');
    expect(html).toContain('No intravenous contrast was administered.');
  });

  it('prints the AERB dose record with its source', () => {
    expect(html).toContain('<bdi>48.2 mGy</bdi>');
    expect(html).toContain('<bdi>812 mGy·cm</bdi>');
    expect(html).toContain('<bdi>1.71 mSv</bdi>');
    expect(html).toContain('Within the national DRL');
    expect(html).toContain('<bdi>rdsr</bdi>');
  });

  it('prints the reporting radiologist with credentials and registration', () => {
    expect(html).toContain('Authorised by');
    expect(html).toContain('Dr. Sanjay Rao');
    expect(html).toContain('MD, DNB (Radiodiagnosis) &middot; Consultant Radiologist');
    expect(html).toContain('Reg. No. TMC/33991');
    expect(html).toContain('Signed electronically (aadhaar_esign)');
    expect(html).toContain('— End of report —');
  });

  it('numbers every page', () => {
    const total = pageCount(html);
    for (let page = 1; page <= total; page += 1) {
      expect(html).toContain(`Page ${String(page)} of ${String(total)}`);
    }
  });

  it('uses only logical CSS properties so an ar-AE print mirrors', () => {
    const arabic = renderRadReport(sampleRadReport(), sampleContext({ direction: 'rtl', locale: 'ar' })).html;
    expect(arabic).toContain('dir="rtl"');
    expect(arabic).not.toMatch(/(?:^|[;{\s])(?:margin|padding|border|inset)-(?:left|right)\s*:/);
    expect(arabic).not.toMatch(/text-align:\s*(?:left|right)/);
  });

  it('escapes narrative text — a finding is never markup', () => {
    const html2 = render(sampleRadReport({ findings: ['<script>alert(1)</script> No acute finding.'] }));
    expect(html2).not.toContain('<script>alert(1)</script>');
    expect(html2).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('renders byte-identically for the same input', () => {
    expect(render(sampleRadReport())).toBe(render(sampleRadReport()));
  });
});

describe('a critical finding is unmissable', () => {
  const html = render(sampleRadReport());

  it('boxes it above the report with the documented call-back', () => {
    expect(html).toContain('class="critical-callout"');
    expect(html).toContain('Critical / urgent finding — CRITICAL FINDING');
    expect(html).toContain('Acute extradural haematoma with midline shift.');
    expect(html).toContain('Communicated to Dr. P. Iyer (Emergency physician) via telephone');
    expect(html).toContain('Read-back confirmed.');
  });

  it('says so when the call-back has not happened yet', () => {
    const payload = sampleRadReport();
    const finding = payload.criticalFinding;
    if (finding === undefined) throw new Error('fixture regression');
    const pending = render({
      ...payload,
      criticalFinding: { ...finding, notifiedToName: undefined, notifiedAtLabel: undefined },
    });
    expect(pending).toContain('Communication to the referring clinician is still pending.');
  });

  it('prints the escalation when the clinician could not be reached', () => {
    const payload = sampleRadReport();
    const finding = payload.criticalFinding;
    if (finding === undefined) throw new Error('fixture regression');
    const escalated = render({
      ...payload,
      criticalFinding: {
        ...finding,
        notifiedToName: undefined,
        clinicianUnreachable: true,
        escalatedTo: 'Medical Superintendent',
      },
    });
    expect(escalated).toContain('Referring clinician unreachable — escalated to Medical Superintendent');
  });

  it('labels an urgent finding as urgent rather than as critical', () => {
    const payload = sampleRadReport();
    const finding = payload.criticalFinding;
    if (finding === undefined) throw new Error('fixture regression');
    const urgent = render({ ...payload, criticalFinding: { ...finding, level: 'urgent' } });
    expect(urgent).toContain('URGENT FINDING');
    expect(urgent).not.toContain('CRITICAL FINDING');
  });

  it('refuses a critical-finding record whose level is "none"', () => {
    const payload = sampleRadReport();
    const finding = payload.criticalFinding;
    if (finding === undefined) throw new Error('fixture regression');
    const result = radReportTemplate.validate({ ...payload, criticalFinding: { ...finding, level: 'none' } });
    expect(result.ok).toBe(false);
  });
});

describe('a preliminary read is watermarked and unsigned', () => {
  function preliminary(): RadReportPayload {
    return sampleRadReport({
      status: {
        release: 'provisional',
        version: 1,
        provisionalReason: 'Preliminary wet read by the on-call resident; consultant report to follow',
      },
      authorisers: [
        {
          name: 'Dr. N. Shah',
          designation: 'Resident, Radiodiagnosis',
          registrationNo: 'TMC/91002',
          signedAtLabel: '20-Aug-2026 06:15',
          role: 'author',
        },
      ],
    });
  }

  const html = render(preliminary());

  it('stamps PROVISIONAL — NOT FOR CLINICAL USE', () => {
    expect(html).toContain('class="seal seal-provisional"');
    expect(html).toContain('PROVISIONAL<br />NOT FOR CLINICAL USE');
    expect(html).toContain('This report has not been medically authorised.');
    expect(html).toContain('Preliminary wet read by the on-call resident');
  });

  it('prints the resident as the author and no authorising signature', () => {
    expect(html).toContain('Not authorised');
    expect(html).toContain('Prepared by Dr. N. Shah');
    expect(html).not.toContain('Authorised by');
    expect(html).not.toContain('Reg. No. TMC/33991');
  });

  it('refuses a final release with no signatory', () => {
    const result = radReportTemplate.validate(sampleRadReport({ authorisers: [] }));
    expect(result.ok).toBe(false);
  });
});

describe('a co-signed report distinguishes the two names', () => {
  const html = render(
    sampleRadReport({
      authorisers: [
        {
          name: 'Dr. N. Shah',
          designation: 'Resident, Radiodiagnosis',
          registrationNo: 'TMC/91002',
          signedAtLabel: '20-Aug-2026 06:15',
          role: 'author',
        },
        {
          name: 'Dr. Sanjay Rao',
          credentials: 'MD, DNB (Radiodiagnosis)',
          designation: 'Consultant Radiologist',
          registrationNo: 'TMC/33991',
          signedAtLabel: '20-Aug-2026 06:31',
          signMethod: 'dsc',
          role: 'cosigner',
        },
      ],
    }),
  );

  it('prints the countersignature as a countersignature', () => {
    expect(html).toContain('Countersigned by');
    expect(html).toContain('Dr. Sanjay Rao');
  });

  it('does not print the resident author as an authorising signatory', () => {
    expect(html).not.toContain('Dr. N. Shah');
  });
});

describe('an amended radiology report', () => {
  const html = render(
    sampleRadReport({
      status: {
        release: 'amended',
        version: 2,
        amendment: {
          reason:
            'Addendum after review of the coronal reformats: a second, smaller contusion is now reported.',
          supersedesVersion: 1,
          supersedesIssuedAtLabel: '20-Aug-2026 06:31',
          amendedAtLabel: '20-Aug-2026 09:44',
          amendedBy: 'Dr. Sanjay Rao',
          changes: [
            {
              item: 'Impression',
              previous: 'Acute left extradural haematoma.',
              current: 'Acute left extradural haematoma and a right temporal contusion.',
            },
          ],
        },
      },
    }),
  );

  it('stamps AMENDED and banners what it supersedes', () => {
    expect(html).toContain('class="seal seal-amended"');
    expect(html).toContain('AMENDED REPORT — version 2.');
    expect(html).toContain('Supersedes version 1 issued 20-Aug-2026 06:31.');
    expect(html).toContain('Destroy or disregard any earlier printed copy.');
  });

  it('itemises what changed', () => {
    expect(html).toContain('Amendment history — what changed in this version');
    expect(html).toContain('<td><bdi>Acute left extradural haematoma.</bdi></td>');
    expect(html).toContain('right temporal contusion');
  });

  it('refuses an amended release with no amendment record', () => {
    const result = radReportTemplate.validate(
      sampleRadReport({ status: { release: 'amended', version: 2 } }),
    );
    expect(result.ok).toBe(false);
  });
});

describe('a superseded radiology print says so', () => {
  it('stamps SUPERSEDED and names the replacement', () => {
    const html = render(
      sampleRadReport({
        status: {
          release: 'final',
          version: 1,
          superseded: { bySupersedingVersion: 2, supersededAtLabel: '20-Aug-2026 09:44' },
        },
      }),
    );
    expect(html).toContain('class="seal seal-superseded"');
    expect(html).toContain('SUPERSEDED REPORT — DO NOT USE.');
    expect(html).toContain('It was replaced by version 2 on 20-Aug-2026 09:44.');
  });
});

describe('PC-PNDT', () => {
  function obstetric(overrides: Partial<RadReportPayload> = {}): RadReportPayload {
    return sampleRadReport({
      study: {
        description: 'Ultrasound, obstetric — level II',
        modality: 'US',
        priority: 'routine',
        performedAtLabel: '20-Aug-2026 10:05',
        reportedAtLabel: '20-Aug-2026 10:22',
        machineRegistrationNo: 'TN/USG/2019/00412',
      },
      clinicalIndication: 'Routine anomaly scan at 20 weeks.',
      findings: ['Single live intrauterine gestation. Biometry corresponds to 20 weeks 2 days.'],
      impression: ['Single live intrauterine gestation with no detectable structural anomaly.'],
      criticalFinding: undefined,
      dose: undefined,
      pcpndt: { applicable: true, formFReference: 'FORM-F/2026/00318' },
      ...overrides,
    });
  }

  it('prints the machine registration number and the statutory declaration', () => {
    const html = render(obstetric());
    expect(html).toContain('<bdi>TN/USG/2019/00412</bdi>');
    expect(html).toContain('Pre-Conception and Pre-Natal Diagnostic Techniques');
    expect(html).toContain('the sex of the foetus has not been determined, recorded or disclosed');
    expect(html).toContain('Form F reference: FORM-F/2026/00318');
  });

  it('refuses a PC-PNDT study with no machine registration number', () => {
    const result = radReportTemplate.validate(
      obstetric({ study: { ...obstetric().study, machineRegistrationNo: undefined } }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.message).join(' ')).toMatch(
        /registration number of the machine/,
      );
    }
  });

  it('refuses to print prose that discloses foetal sex', () => {
    for (const phrase of [
      'The sex of the foetus is noted.',
      'Foetal gender was assessed.',
      'A male foetus is seen in cephalic presentation.',
      'The parents were told it is a girl.',
    ]) {
      const result = radReportTemplate.validate(obstetric({ findings: [phrase] }));
      expect(result.ok, phrase).toBe(false);
      if (!result.ok) {
        expect(result.issues.map((issue) => issue.message).join(' ')).toMatch(/PC-PNDT Act 1994/);
      }
    }
  });

  it('leaves an ordinary radiology narrative alone', () => {
    expect(radReportTemplate.validate(obstetric())).toEqual({ ok: true });
    expect(radReportTemplate.validate(sampleRadReport())).toEqual({ ok: true });
  });
});

describe('key images', () => {
  it('embeds a data URI and captions it', () => {
    const html = render(
      sampleRadReport({ keyImages: [{ caption: 'Axial, 5 mm — extradural collection', dataUri: PIXEL }] }),
    );
    expect(html).toContain('Key images');
    expect(html).toContain(`src="${PIXEL}"`);
    expect(html).toContain('Axial, 5 mm — extradural collection');
  });

  it('refuses a remote image, which would not print on an air-gapped server', () => {
    const result = radReportTemplate.validate(
      sampleRadReport({ keyImages: [{ caption: 'Axial', dataUri: 'https://pacs.example/img/1.png' }] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.message).join(' ')).toMatch(/embedded data URI/);
    }
  });
});

describe('the verification QR carries a token and nothing else', () => {
  const payload = sampleRadReport();
  const html = render(payload);

  it('encodes exactly the verify base plus the opaque token', () => {
    const url = buildVerifyUrl(payload.verify, []);
    expect(url).toBe('https://verify.vims-hospital.example/r/RmFrZVJhZFRva2VuXzAwMDAwMDAwMDAwMQ');
    expect(html).toContain(url);
  });

  it('puts no patient identifier in the QR block', () => {
    const start = html.indexOf('<div class="qr-block">');
    const block = html.slice(start, html.indexOf('</div></div>', start));
    for (const identifier of ['Ramesh', 'CBE-000123456', '14-Feb-1968']) {
      expect(block, identifier).not.toContain(identifier);
    }
  });

  it('throws rather than print a QR whose URL carries an identifier', () => {
    expect(() =>
      buildVerifyUrl({ baseUrl: 'https://verify.example/r', token: 'CBE0001234561234567' }, [
        'CBE0001234561234567',
      ]),
    ).toThrow(PrintTemplateError);
  });
});

describe('the registered template', () => {
  it('validates the fixture and renders it', () => {
    expect(radReportTemplate.validate(sampleRadReport())).toEqual({ ok: true });
    expect(radReportTemplate.render(sampleRadReport(), CONTEXT).format).toBe('a4');
  });

  it('rejects a report with no findings and no impression', () => {
    expect(() => radReportTemplate.render({ ...sampleRadReport(), findings: [] }, CONTEXT)).toThrow(
      PrintTemplateError,
    );
    expect(() => radReportTemplate.render({ ...sampleRadReport(), impression: [] }, CONTEXT)).toThrow(
      PrintTemplateError,
    );
  });
});
