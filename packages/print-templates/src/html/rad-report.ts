/**
 * The radiology report — `OP-008 §3.4`, A4.
 *
 * The body is the structured-report skeleton the standard sections come from:
 * Technique, Comparison, Findings, Impression, Recommendations, plus the coded
 * scores (BI-RADS / TI-RADS / LI-RADS / PI-RADS), the contrast record, the
 * AERB dose record, and the key images. Around it sits the same shell as the
 * laboratory report — the seal, the amendment history, the page footer and the
 * verification QR — because a clinician holding two reports from the same
 * hospital should not have to learn two documents.
 *
 * ── What this template refuses to print ─────────────────────────────────────
 *
 * **A preliminary read that looks final.** `OP-008 §3.4.5` — a wet read by a
 * resident or an ER physician is flagged Preliminary with the final to follow.
 * That is `status.release: 'provisional'`, which forces the seal and removes
 * the signature block; the resident is recorded as `role: 'author'`.
 *
 * **A countersignature that is not one.** `OP-008 §3.4.2` runs resident draft →
 * consultant co-sign, and the API refuses a countersignature by the author. The
 * template prints both cards distinctly ("Authorised by" / "Countersigned by")
 * so a reader can tell which of the two names carries the responsibility.
 *
 * **Anything that could disclose foetal sex on a PC-PNDT study.** The schema for
 * a PC-PNDT-applicable report has no field that could carry it — matching the
 * promise `radiology.types.ts` makes on the API side — and `superRefine` scans
 * the narrative for the phrasings that would have to appear for it to be
 * disclosed in prose. The API checks this first; the print pipeline is the last
 * gate before the paper leaves the building, and the offence is criminal, so it
 * is checked twice on purpose.
 */

import { z } from 'zod';

import { defineTemplate, type PrintContext, type RegisteredTemplate, type RenderedHtml } from '../types.js';
import { bdi, escapeHtml } from './letterhead.js';
import {
  HEIGHT,
  authBlockMm,
  authoriserSchema,
  assertReleaseConsistency,
  closeDocument,
  firstPageBudgetMm,
  forbiddenInQr,
  linesFor,
  metaMm,
  openDocument,
  paginate,
  patientBannerMm,
  patientBannerSchema,
  proseMm,
  statusBannerMm,
  amendmentBlocks,
  renderAuthorisers,
  renderEndOfReport,
  renderMetaGrid,
  renderPatientBanner,
  renderReportPages,
  renderStatusBanner,
  renderVerifyBlock,
  reportStatusSchema,
  verifySchema,
  type PageBlock,
} from './report-shell.js';

// ── Payload ─────────────────────────────────────────────────────────────────

export const radFindingLevelSchema = z.enum(['none', 'incidental', 'urgent', 'critical']);

export type RadFindingLevel = z.infer<typeof radFindingLevelSchema>;

export const radCriticalFindingSchema = z.object({
  level: radFindingLevelSchema,
  text: z.string().min(1),
  detectedAtLabel: z.string().min(1),
  notifiedToName: z.string().optional(),
  notifiedToRole: z.string().optional(),
  notifiedAtLabel: z.string().optional(),
  notifiedByName: z.string().optional(),
  method: z.string().optional(),
  readBackConfirmed: z.boolean().default(false),
  clinicianUnreachable: z.boolean().default(false),
  escalatedTo: z.string().optional(),
});

export const radDoseSchema = z.object({
  ctdiVol: z.string().optional(),
  dlp: z.string().optional(),
  dap: z.string().optional(),
  fluoroscopyTime: z.string().optional(),
  estimatedEffectiveDose: z.string().optional(),
  drlComparison: z.string().optional(),
  cumulative12Months: z.string().optional(),
  source: z.enum(['rdsr', 'mpps', 'header', 'manual']).optional(),
});

export const radContrastSchema = z.object({
  given: z.boolean(),
  agent: z.string().optional(),
  volume: z.string().optional(),
  route: z.string().optional(),
  lotNo: z.string().optional(),
  reaction: z.string().optional(),
  premedication: z.string().optional(),
});

export const radKeyImageSchema = z.object({
  caption: z.string().min(1),
  /** Data URI only — the renderer runs air-gapped (`EN-005 §3.5`). */
  dataUri: z
    .string()
    .min(1)
    .refine((value) => value.startsWith('data:image/'), {
      message:
        'A key image must be an embedded data URI. A remote URL would print as a broken box on an on-prem server with no route to the PACS.',
    }),
});

const radLabelsSchema = z
  .object({
    technique: z.string().min(1),
    comparison: z.string().min(1),
    findings: z.string().min(1),
    impression: z.string().min(1),
    recommendations: z.string().min(1),
    indication: z.string().min(1),
    contrast: z.string().min(1),
    dose: z.string().min(1),
    keyImages: z.string().min(1),
    criticalHeading: z.string().min(1),
    notesHeading: z.string().min(1),
  })
  .partial()
  .default({});

/** Section headings, overridable per hospital and per locale — see `lab-report.ts`. */
export interface RadReportLabels {
  readonly technique: string;
  readonly comparison: string;
  readonly findings: string;
  readonly impression: string;
  readonly recommendations: string;
  readonly indication: string;
  readonly contrast: string;
  readonly dose: string;
  readonly keyImages: string;
  readonly criticalHeading: string;
  readonly notesHeading: string;
}

const DEFAULT_LABELS: RadReportLabels = Object.freeze({
  technique: 'Technique',
  comparison: 'Comparison',
  findings: 'Findings',
  impression: 'Impression',
  recommendations: 'Recommendations',
  indication: 'Clinical indication',
  contrast: 'Contrast',
  dose: 'Radiation dose',
  keyImages: 'Key images',
  criticalHeading: 'Critical / urgent finding',
  notesHeading: 'Notes',
});

function mergeLabels(overrides: z.infer<typeof radLabelsSchema>): RadReportLabels {
  return {
    technique: overrides.technique ?? DEFAULT_LABELS.technique,
    comparison: overrides.comparison ?? DEFAULT_LABELS.comparison,
    findings: overrides.findings ?? DEFAULT_LABELS.findings,
    impression: overrides.impression ?? DEFAULT_LABELS.impression,
    recommendations: overrides.recommendations ?? DEFAULT_LABELS.recommendations,
    indication: overrides.indication ?? DEFAULT_LABELS.indication,
    contrast: overrides.contrast ?? DEFAULT_LABELS.contrast,
    dose: overrides.dose ?? DEFAULT_LABELS.dose,
    keyImages: overrides.keyImages ?? DEFAULT_LABELS.keyImages,
    criticalHeading: overrides.criticalHeading ?? DEFAULT_LABELS.criticalHeading,
    notesHeading: overrides.notesHeading ?? DEFAULT_LABELS.notesHeading,
  };
}

/**
 * The phrasings a foetal-sex disclosure would have to take in English prose.
 * Narrow by design: this is a last-gate check on a PC-PNDT study, not a
 * general-purpose classifier, and a false positive that blocks a print is far
 * cheaper than a false negative that commits an offence under the 1994 Act.
 */
const FOETAL_SEX_PATTERNS: readonly RegExp[] = Object.freeze([
  /\b(?:sex|gender)\s+of\s+(?:the\s+)?(?:fo?etus|baby|child)\b/i,
  /\bfo?etal\s+(?:sex|gender)\b/i,
  /\b(?:male|female)\s+fo?etus\b/i,
  /\bit\s+is\s+a\s+(?:boy|girl)\b/i,
]);

export const radReportPayloadSchema = z
  .object({
    title: z.string().min(1).default('Radiology Report'),
    subtitle: z.string().optional(),
    reportNo: z.string().min(1),
    accessionNo: z.string().min(1),
    status: reportStatusSchema,
    patient: patientBannerSchema,
    study: z.object({
      description: z.string().min(1),
      modality: z.string().min(1),
      bodyPart: z.string().optional(),
      laterality: z.string().optional(),
      priority: z.enum(['routine', 'urgent', 'stat', 'portable_stat']).default('routine'),
      requestedAtLabel: z.string().optional(),
      performedAtLabel: z.string().min(1),
      reportedAtLabel: z.string().min(1),
      room: z.string().optional(),
      equipment: z.string().optional(),
      /** PC-PNDT registered machine number — mandatory on an obstetric ultrasound. */
      machineRegistrationNo: z.string().optional(),
      protocol: z.string().optional(),
      repeatCount: z.number().int().min(0).optional(),
    }),
    clinicalIndication: z.string().min(1),
    technique: z.array(z.string().min(1)).default([]),
    contrast: radContrastSchema.optional(),
    comparison: z.array(z.string().min(1)).default([]),
    findings: z.array(z.string().min(1)).min(1),
    impression: z.array(z.string().min(1)).min(1),
    recommendations: z.array(z.string().min(1)).default([]),
    /** Coded severity scales, printed as label/value pairs. */
    scores: z.array(z.object({ label: z.string().min(1), value: z.string().min(1) })).default([]),
    criticalFinding: radCriticalFindingSchema.optional(),
    dose: radDoseSchema.optional(),
    keyImages: z.array(radKeyImageSchema).default([]),
    /** `OP-008 §5` — an obstetric ultrasound is a PC-PNDT study. */
    pcpndt: z
      .object({
        applicable: z.boolean(),
        formFReference: z.string().optional(),
        declaration: z.string().optional(),
      })
      .optional(),
    notes: z.array(z.string().min(1)).default([]),
    authorisers: z.array(authoriserSchema).default([]),
    verify: verifySchema,
    footerNote: z.string().optional(),
    labels: radLabelsSchema,
  })
  .superRefine((payload, ctx) => {
    assertReleaseConsistency(payload.status, payload.authorisers, ctx);

    if (payload.criticalFinding !== undefined && payload.criticalFinding.level === 'none') {
      ctx.addIssue({
        code: 'custom',
        path: ['criticalFinding', 'level'],
        message: 'A critical-finding record with level "none" is a contradiction; omit the record instead.',
      });
    }

    if (payload.pcpndt?.applicable === true) {
      if (payload.study.machineRegistrationNo === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['study', 'machineRegistrationNo'],
          message:
            'A PC-PNDT study must print the registration number of the machine it was performed on (PC-PNDT Act 1994 / OP-008 §5).',
        });
      }
      const prose = [
        ...payload.findings,
        ...payload.impression,
        ...payload.recommendations,
        ...payload.notes,
      ].join('\n');
      for (const pattern of FOETAL_SEX_PATTERNS) {
        if (pattern.test(prose)) {
          ctx.addIssue({
            code: 'custom',
            path: ['findings'],
            message:
              'This report appears to disclose foetal sex. Communicating it in any form is an offence under the PC-PNDT Act 1994; the document will not be printed.',
          });
          break;
        }
      }
    }

    if (payload.status.release === 'amended' && payload.status.amendment === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['status', 'amendment'],
        message: 'An amended radiology report must carry its amendment record.',
      });
    }
  });

export type RadReportPayload = z.infer<typeof radReportPayloadSchema>;

// ── Body ────────────────────────────────────────────────────────────────────

/**
 * A prose section, one block per paragraph.
 *
 * A radiologist's findings can run to a page and a half on a polytrauma CT, so
 * the paragraphs are separate blocks inside one container: the section can then
 * break across pages, and the heading is reprinted when it does.
 */
function proseSection(
  id: string,
  heading: string,
  paragraphs: readonly string[],
  emphasis = false,
): PageBlock[] {
  if (paragraphs.length === 0) return [];
  const container = {
    id,
    open: `<h2 class="section-heading">${escapeHtml(heading)}</h2><div class="prose${emphasis ? ' impression' : ''}">`,
    close: '</div>',
  };
  return paragraphs.map((text, index) => ({
    html: `<p>${escapeHtml(text)}</p>`,
    heightMm: proseMm([text]) + (index === 0 ? HEIGHT.sectionHeading : 0),
    container,
  }));
}

function renderCriticalCallout(
  finding: z.infer<typeof radCriticalFindingSchema>,
  heading: string,
): PageBlock {
  const levelWord =
    finding.level === 'critical' ? 'CRITICAL FINDING' : `${finding.level.toUpperCase()} FINDING`;
  let communication: string;
  if (finding.clinicianUnreachable) {
    communication = `<strong>Referring clinician unreachable — escalated to ${escapeHtml(finding.escalatedTo ?? 'the on-call tier')}${finding.notifiedAtLabel === undefined ? '' : ` at ${escapeHtml(finding.notifiedAtLabel)}`}.</strong>`;
  } else if (finding.notifiedToName === undefined || finding.notifiedAtLabel === undefined) {
    communication = '<strong>Communication to the referring clinician is still pending.</strong>';
  } else {
    const role = finding.notifiedToRole === undefined ? '' : ` (${escapeHtml(finding.notifiedToRole)})`;
    const how = finding.method === undefined ? '' : ` via ${escapeHtml(finding.method)}`;
    const by = finding.notifiedByName === undefined ? '' : ` by ${escapeHtml(finding.notifiedByName)}`;
    const readBack = finding.readBackConfirmed
      ? ' Read-back confirmed.'
      : ' <strong>Read-back not confirmed.</strong>';
    communication = `Communicated to ${escapeHtml(finding.notifiedToName)}${role}${how}${by} at ${escapeHtml(finding.notifiedAtLabel)}.${readBack}`;
  }

  return {
    html: [
      '<div class="critical-callout">',
      `<h2>${escapeHtml(heading)} — ${escapeHtml(levelWord)}</h2>`,
      `<p><strong>${escapeHtml(finding.text)}</strong></p>`,
      `<p>Detected ${escapeHtml(finding.detectedAtLabel)}. ${communication}</p>`,
      '</div>',
    ].join(''),
    heightMm:
      HEIGHT.calloutFixed +
      proseMm([finding.text]) +
      (linesFor(
        `${finding.detectedAtLabel} ${finding.notifiedToName ?? ''} ${finding.notifiedToRole ?? ''} ${finding.notifiedByName ?? ''} ${finding.escalatedTo ?? ''} communicated read-back confirmed`,
      ) *
        HEIGHT.line +
        HEIGHT.calloutParagraphGap),
  };
}

function renderKeyImages(images: readonly z.infer<typeof radKeyImageSchema>[], heading: string): PageBlock[] {
  if (images.length === 0) return [];
  const container = {
    id: 'key-images',
    open: `<h2 class="section-heading">${escapeHtml(heading)}</h2><div class="key-images">`,
    close: '</div>',
  };
  return images.map((image, index) => ({
    html: `<figure class="key-image"><img src="${escapeHtml(image.dataUri)}" alt="${escapeHtml(image.caption)}" /><figcaption>${escapeHtml(image.caption)}</figcaption></figure>`,
    // Two figures sit side by side, so only every other one adds a row.
    heightMm: (index % 2 === 0 ? 52 : 0) + (index === 0 ? HEIGHT.sectionHeading : 0),
    container,
  }));
}

function buildBlocks(payload: RadReportPayload): readonly PageBlock[] {
  const labels = mergeLabels(payload.labels);
  const blocks: PageBlock[] = [];

  const banner = renderStatusBanner(payload.status);
  if (banner.length > 0) blocks.push({ html: banner, heightMm: statusBannerMm(payload.status) });

  blocks.push({ html: renderPatientBanner(payload.patient), heightMm: patientBannerMm(payload.patient) });

  blocks.push({
    html: renderMetaGrid([
      ['Accession No.', payload.accessionNo],
      ['Report No.', `${payload.reportNo} · v${String(payload.status.version)}`],
      ['Study', payload.study.description],
      ['Modality', payload.study.modality],
      ['Body part', payload.study.bodyPart],
      ['Laterality', payload.study.laterality],
      ['Priority', payload.study.priority.toUpperCase()],
      ['Requested', payload.study.requestedAtLabel],
      ['Performed', payload.study.performedAtLabel],
      ['Reported', payload.study.reportedAtLabel],
      ['Room', payload.study.room],
      ['Equipment', payload.study.equipment],
      ['Machine Reg. No.', payload.study.machineRegistrationNo],
      ['Protocol', payload.study.protocol],
      ['Repeats', payload.study.repeatCount === undefined ? undefined : String(payload.study.repeatCount)],
    ]),
    heightMm: metaMm(15, 2),
  });

  if (payload.criticalFinding !== undefined) {
    blocks.push(renderCriticalCallout(payload.criticalFinding, labels.criticalHeading));
  }

  if (payload.status.amendment !== undefined) {
    blocks.push(...amendmentBlocks(payload.status.amendment));
  }

  blocks.push(...proseSection('indication', labels.indication, [payload.clinicalIndication]));
  blocks.push(...proseSection('technique', labels.technique, payload.technique));

  if (payload.contrast !== undefined) {
    const contrast = payload.contrast;
    blocks.push({
      html: [
        `<h2 class="section-heading">${escapeHtml(labels.contrast)}</h2>`,
        contrast.given
          ? renderMetaGrid([
              ['Administered', 'Yes'],
              ['Agent', contrast.agent],
              ['Volume', contrast.volume],
              ['Route', contrast.route],
              ['Lot No.', contrast.lotNo],
              ['Pre-medication', contrast.premedication],
              ['Reaction', contrast.reaction],
            ])
          : '<div class="prose"><p>No intravenous contrast was administered.</p></div>',
      ].join(''),
      heightMm: HEIGHT.sectionHeading + (contrast.given ? metaMm(7, 2) : proseMm(['No contrast.'])),
    });
  }

  blocks.push(...proseSection('comparison', labels.comparison, payload.comparison));
  blocks.push(...proseSection('findings', labels.findings, payload.findings));

  if (payload.scores.length > 0) {
    blocks.push({
      html: renderMetaGrid(payload.scores.map((score) => [score.label, score.value] as const)),
      heightMm: metaMm(payload.scores.length, 2),
    });
  }

  blocks.push(...proseSection('impression', labels.impression, payload.impression, true));
  blocks.push(...proseSection('recommendations', labels.recommendations, payload.recommendations));

  if (payload.dose !== undefined) {
    const dose = payload.dose;
    blocks.push({
      html: [
        `<h2 class="section-heading">${escapeHtml(labels.dose)}</h2>`,
        renderMetaGrid([
          ['CTDIvol', dose.ctdiVol],
          ['DLP', dose.dlp],
          ['DAP', dose.dap],
          ['Fluoroscopy time', dose.fluoroscopyTime],
          ['Estimated effective dose', dose.estimatedEffectiveDose],
          ['Against DRL', dose.drlComparison],
          ['Cumulative (12 months)', dose.cumulative12Months],
          ['Dose source', dose.source],
        ]),
      ].join(''),
      heightMm: HEIGHT.sectionHeading + metaMm(8, 2),
    });
  }

  blocks.push(...renderKeyImages(payload.keyImages, labels.keyImages));

  const notes: string[] = [...payload.notes];
  if (payload.pcpndt?.applicable === true) {
    notes.push(
      payload.pcpndt.declaration ??
        'Declaration under the Pre-Conception and Pre-Natal Diagnostic Techniques (Prohibition of Sex Selection) Act, 1994: the sex of the foetus has not been determined, recorded or disclosed.',
    );
    if (payload.pcpndt.formFReference !== undefined) {
      notes.push(`Form F reference: ${payload.pcpndt.formFReference}`);
    }
  }
  if (notes.length > 0) {
    blocks.push(...proseSection('notes', labels.notesHeading, notes));
  }

  blocks.push({ html: renderEndOfReport(), heightMm: HEIGHT.endOfReport, keepWithNext: true });
  blocks.push({
    html: renderAuthorisers(payload.status, payload.authorisers),
    heightMm: authBlockMm(payload.authorisers),
    mayNotStartPage: true,
  });
  blocks.push({
    html: renderVerifyBlock(
      payload.verify,
      forbiddenInQr(payload.patient, [payload.accessionNo, payload.reportNo]),
    ),
    heightMm: HEIGHT.qrBlock,
  });
  if (payload.footerNote !== undefined) {
    blocks.push({
      html: `<div class="footer-note">${escapeHtml(payload.footerNote)}</div>`,
      heightMm: HEIGHT.footerNote,
    });
  }

  return blocks;
}

export function renderRadReport(payload: RadReportPayload, context: PrintContext): RenderedHtml {
  const pages = paginate(buildBlocks(payload), {
    firstPageBudgetMm: firstPageBudgetMm({ subtitle: true, accreditationNote: false }),
  });

  const subtitleParts = [payload.study.description, payload.study.modality, payload.study.laterality]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join(' · ');

  const html = [
    openDocument(context, `${payload.title} ${payload.reportNo}`),
    `<style>${keyImageStyles()}</style>`,
    renderReportPages(pages, context, {
      title: payload.title,
      subtitle: payload.subtitle ?? subtitleParts,
      reportNo: payload.reportNo,
      accessionNo: payload.accessionNo,
      status: payload.status,
      patient: payload.patient,
    }),
    closeDocument(),
  ].join('');

  return { format: 'a4', contentType: 'text/html', paper: 'A4', html };
}

function keyImageStyles(): string {
  return `
.key-images { display: flex; flex-wrap: wrap; gap: 6pt; break-inside: avoid; }
.key-image { margin: 0; inline-size: calc(50% - 3pt); break-inside: avoid; }
.key-image img { inline-size: 100%; block-size: auto; max-block-size: 44mm; object-fit: contain; border: 0.5pt solid #999; }
.key-image figcaption { font-size: 8pt; color: #222; margin-block-start: 2pt; }
`.trim();
}

/** Exported so the radiology spec can assert the study line without re-deriving it. */
export function studySummaryLine(payload: RadReportPayload): string {
  return bdi(`${payload.study.modality} · ${payload.study.description}`);
}

export const radReportTemplate: RegisteredTemplate = defineTemplate({
  key: 'rad_report.html.v1',
  docType: 'rad_report',
  format: 'a4',
  paper: 'A4',
  version: 1,
  description:
    'A4 radiology report — structured technique/findings/impression, contrast and AERB dose record, critical-finding call-out, co-signature, amendment history and a QR verification block (OP-008 §3.4, EN-005 §4.1).',
  phi: true,
  payloadSchema: radReportPayloadSchema,
  render: renderRadReport,
});
