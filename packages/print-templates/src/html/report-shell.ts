/**
 * The chrome every diagnostic report shares: the patient banner, the release
 * status and its seal, the authorisation block, the verification QR, and the
 * pagination that produces a real "Page 2 of 5".
 *
 * Lab, radiology and the cumulative report differ in their *body*. Everything
 * around the body is fixed by NABL 112 §7.4 and `OP-004 §3.6.1` — patient
 * identified on every page, sample and report times, reference intervals, the
 * authorised signatory with a registration number, page numbering, amendment
 * history — so it is written once here and the three templates supply blocks.
 *
 * ── Four rules this file exists to make unavoidable ─────────────────────────
 *
 * **1. A document cannot look authorised unless it is.** `reportStatusSchema`
 * and `assertReleaseConsistency()` refuse a payload whose release is `final` or
 * `amended` but which carries no authoriser, and refuse a `provisional` payload
 * that carries one. There is no code path that prints a signature block for an
 * unauthorised report and no code path that omits the PROVISIONAL seal from
 * one: both come from the same discriminant.
 *
 * **2. An amendment is loud and itemised.** `OP-004 §5` — "reports immutable;
 * amendments new versions" — and `§3.4.3` prints "Amended — supersedes report
 * dated …". A banner alone is not enough to be safe: a clinician holding v2
 * needs to know *which analyte moved*, so `amendmentSchema` requires at least
 * one itemised change and the shell prints the table.
 *
 * **3. A superseded print says so.** A report reprinted after it was replaced
 * is the most dangerous piece of paper the laboratory produces, so it gets its
 * own seal and its own banner naming the version that replaced it.
 *
 * **4. The QR carries a token and nothing else.** `EN-013 §4`: "QR payloads for
 * public use are signed short tokens resolving server-side (no PHI)". The URL
 * is assembled here from exactly two fields, and `buildVerifyUrl()` then scans
 * the result for every identifier on the report and throws if one appears. That
 * check is deliberately at render time rather than in review: a hospital
 * override that put a UHID in the verify base would otherwise ship silently.
 */

import { z } from 'zod';

import { PrintTemplateError, type PrintContext } from '../types.js';
import { bdi, escapeHtml, letterheadStyles, renderLetterhead } from './letterhead.js';
import { renderQrSvg } from './qr.js';

// ── Patient identity ────────────────────────────────────────────────────────

export const patientBannerSchema = z.object({
  name: z.string().min(1),
  uhid: z.string().min(1),
  /** `45/M`, `3m/F` — already formatted by `@vims/i18n` (`docs/06 §8`). */
  ageSex: z.string().min(1),
  dateOfBirthLabel: z.string().optional(),
  /** Second identifier for the NABH two-identifier rule where DOB is not held. */
  secondaryId: z.object({ label: z.string().min(1), value: z.string().min(1) }).optional(),
  referringDoctor: z.string().optional(),
  referringFacility: z.string().optional(),
  wardBed: z.string().optional(),
  visitType: z.string().optional(),
  /** Red-flag line — allergies, isolation, MLC. Printed in bold caps (`docs/06 §4.2`). */
  alerts: z.array(z.string().min(1)).default([]),
});

export type PatientBanner = z.infer<typeof patientBannerSchema>;

/** Every identifier that must never reach the QR. Used by `buildVerifyUrl()`. */
function bannerIdentifiers(patient: PatientBanner): readonly string[] {
  const values = [patient.name, patient.uhid, patient.dateOfBirthLabel, patient.secondaryId?.value];
  return values.filter((value): value is string => value !== undefined && value.trim().length > 0);
}

// ── Release status ──────────────────────────────────────────────────────────

export const amendmentChangeSchema = z.object({
  item: z.string().min(1),
  previous: z.string().min(1),
  current: z.string().min(1),
});

export const amendmentSchema = z.object({
  reason: z.string().min(1),
  supersedesVersion: z.number().int().min(1),
  supersedesIssuedAtLabel: z.string().min(1),
  amendedAtLabel: z.string().min(1),
  amendedBy: z.string().min(1),
  /** At least one, because "something changed" is not a clinically usable statement. */
  changes: z.array(amendmentChangeSchema).min(1),
});

export type Amendment = z.infer<typeof amendmentSchema>;

export const supersededSchema = z.object({
  bySupersedingVersion: z.number().int().min(1),
  supersededAtLabel: z.string().min(1),
});

export const reportStatusSchema = z.object({
  release: z.enum(['provisional', 'final', 'amended']),
  version: z.number().int().min(1),
  /** Why this print is not authorised — "3 of 7 tests authorised", "preliminary read". */
  provisionalReason: z.string().optional(),
  amendment: amendmentSchema.optional(),
  /** Present when the version being printed is no longer the current one. */
  superseded: supersededSchema.optional(),
});

export type ReportStatus = z.infer<typeof reportStatusSchema>;

export const authoriserSchema = z.object({
  name: z.string().min(1),
  /** "MD (Path)", "DNB Radiodiagnosis" — NABL 112 wants the qualification, not just a name. */
  credentials: z.string().optional(),
  designation: z.string().optional(),
  registrationNo: z.string().min(1),
  /** PC-PNDT registration, mandatory on an obstetric ultrasound report (`OP-008 §5`). */
  pcpndtRegistrationNo: z.string().optional(),
  signedAtLabel: z.string().min(1),
  /** `EN-016` — how the signature was applied. Printed so an auditor can tell. */
  signMethod: z.enum(['dsc', 'aadhaar_esign', 'otp', 'password', 'system']).optional(),
  /** Data URI only; a remote signature image would not print on an air-gapped server. */
  signatureImageDataUri: z.string().optional(),
  role: z.enum(['author', 'authoriser', 'cosigner']).default('authoriser'),
});

export type Authoriser = z.infer<typeof authoriserSchema>;

/**
 * The rule of §1 in the file header, applied to a parsed payload.
 *
 * Written as a `superRefine` helper rather than as a check inside `render()`
 * because a template's `validate()` is what the admin preview and the print
 * queue call before anything is spooled — a report that cannot be printed
 * safely should fail at the payload, not at the paper.
 */
export function assertReleaseConsistency(
  status: ReportStatus,
  authorisers: readonly Authoriser[],
  ctx: z.RefinementCtx,
): void {
  const signatories = authorisers.filter((entry) => entry.role !== 'author');

  if (status.release === 'provisional') {
    if (signatories.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['authorisers'],
        message:
          'A provisional report carries no authorising signatory. Printing one under a PROVISIONAL seal is exactly the "looks final but is not" document OP-004 §3.6 forbids; record the writer with role "author" instead.',
      });
    }
    if (status.amendment !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['status', 'amendment'],
        message: 'A provisional report has nothing to amend — it was never released.',
      });
    }
    return;
  }

  if (signatories.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['authorisers'],
      message:
        'A released report needs its authorising signatory with a registration number (NABL 112 §7.4.1.3). Without one this document has no author and must not print as final.',
    });
  }

  if (status.release === 'amended' && status.amendment === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['status', 'amendment'],
      message:
        'An amended report must say what changed and why (OP-004 §3.4.3). Replacing a signed clinical document silently is a patient-safety failure.',
    });
  }

  if (status.release === 'final' && status.amendment !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['status', 'release'],
      message: 'A report carrying an amendment record must be released as "amended", not "final".',
    });
  }

  if (status.amendment !== undefined && status.amendment.supersedesVersion >= status.version) {
    ctx.addIssue({
      code: 'custom',
      path: ['status', 'amendment', 'supersedesVersion'],
      message:
        'An amendment supersedes an earlier version; the superseded version must be lower than this one.',
    });
  }
}

// ── Verification QR ─────────────────────────────────────────────────────────

export const verifySchema = z.object({
  /**
   * Public verification endpoint, e.g. `https://verify.hospital.example/r`.
   * No query string and no fragment: a template that accepted one could not
   * promise the QR carries nothing but the token.
   */
  baseUrl: z
    .string()
    .min(1)
    .refine((value) => /^https?:\/\/[^\s?#]+$/.test(value), {
      message:
        'The verification base URL must be a plain http(s) origin and path, with no query string and no fragment — anything else is a place to hide PHI.',
    }),
  /**
   * The opaque token from `lab.lab_report_versions.verify_token` /
   * `rad.rad_report_versions.verify_token`. Unguessable by construction and
   * meaningless without the server.
   */
  token: z
    .string()
    .min(16)
    .max(128)
    .regex(
      /^[A-Za-z0-9_-]+$/,
      'A verification token is base64url or hex. A value with other characters is carrying something it should not.',
    ),
  /** Printed under the QR so a reader without a camera can still verify. */
  caption: z.string().optional(),
  /** How long the public page will answer for this token (`EN-013 §7`). */
  validityNote: z.string().optional(),
});

export type VerifyBlock = z.infer<typeof verifySchema>;

/**
 * Assemble the verification URL and prove it carries no identifier.
 *
 * The `forbidden` list is every identifier printed on the document. Anything
 * shorter than four characters is skipped — an age of `45` would otherwise
 * match the digits of a random token and make the guard useless noise.
 */
export function buildVerifyUrl(verify: VerifyBlock, forbidden: readonly string[]): string {
  const url = `${verify.baseUrl.replace(/\/+$/, '')}/${verify.token}`;
  const haystack = url.toLowerCase();
  for (const identifier of forbidden) {
    const needle = identifier.trim().toLowerCase();
    if (needle.length < 4) continue;
    if (haystack.includes(needle)) {
      throw new PrintTemplateError(
        'The report verification URL contains a patient identifier. EN-013 §4 allows an opaque token and nothing else in a public QR; a scannable UHID on a report left on a ward desk is a DPDP disclosure.',
      );
    }
  }
  return url;
}

export function renderVerifyBlock(verify: VerifyBlock, forbidden: readonly string[]): string {
  const url = buildVerifyUrl(verify, forbidden);
  const caption = verify.caption ?? 'Scan to verify this report';
  const validity =
    verify.validityNote === undefined
      ? ''
      : `<div class="qr-validity">${escapeHtml(verify.validityNote)}</div>`;
  return [
    '<div class="qr-block">',
    renderQrSvg(url, { ecc: 'M', sizeCss: '22mm' }),
    '<div class="qr-text">',
    `<div class="qr-caption">${escapeHtml(caption)}</div>`,
    `<div class="qr-url">${bdi(url)}</div>`,
    validity,
    '</div></div>',
  ].join('');
}

// ── Rendering helpers ───────────────────────────────────────────────────────

export function renderPatientBanner(patient: PatientBanner): string {
  const rows: string[] = [
    metaRow('Patient', patient.name),
    metaRow('UHID', patient.uhid),
    metaRow('Age / Sex', patient.ageSex),
  ];
  if (patient.dateOfBirthLabel !== undefined) rows.push(metaRow('Date of birth', patient.dateOfBirthLabel));
  if (patient.secondaryId !== undefined)
    rows.push(metaRow(patient.secondaryId.label, patient.secondaryId.value));
  if (patient.referringDoctor !== undefined) rows.push(metaRow('Referred by', patient.referringDoctor));
  if (patient.referringFacility !== undefined)
    rows.push(metaRow('Referring facility', patient.referringFacility));
  if (patient.wardBed !== undefined) rows.push(metaRow('Ward / Bed', patient.wardBed));
  if (patient.visitType !== undefined) rows.push(metaRow('Visit', patient.visitType));

  const alerts =
    patient.alerts.length === 0
      ? ''
      : `<div class="pt-alerts">${patient.alerts.map((alert) => `<span class="pt-alert">${escapeHtml(alert)}</span>`).join('')}</div>`;

  return `<div class="pt-banner"><div class="meta">${rows.join('')}</div>${alerts}</div>`;
}

export function metaRow(label: string, value: string): string {
  return `<div class="meta-row"><span class="meta-label">${escapeHtml(label)}</span><span class="meta-value">${bdi(value)}</span></div>`;
}

export function renderMetaGrid(entries: readonly (readonly [string, string | undefined])[]): string {
  const rows = entries
    .filter((entry): entry is readonly [string, string] => entry[1] !== undefined && entry[1].length > 0)
    .map(([label, value]) => metaRow(label, value))
    .join('');
  return rows.length === 0 ? '' : `<div class="meta">${rows}</div>`;
}

/** The diagonal seal. Never omitted for a status that has one — see §1. */
export function renderStatusSeal(status: ReportStatus): string {
  if (status.superseded !== undefined) {
    return '<div class="seal seal-superseded" aria-hidden="true">SUPERSEDED</div>';
  }
  if (status.release === 'provisional') {
    return '<div class="seal seal-provisional" aria-hidden="true">PROVISIONAL<br />NOT FOR CLINICAL USE</div>';
  }
  if (status.release === 'amended') {
    return '<div class="seal seal-amended" aria-hidden="true">AMENDED</div>';
  }
  return '';
}

export function renderStatusBanner(status: ReportStatus): string {
  const banners: string[] = [];

  if (status.superseded !== undefined) {
    banners.push(
      `<div class="banner banner-stop"><strong>SUPERSEDED REPORT — DO NOT USE.</strong> This is version ${String(status.version)}. It was replaced by version ${String(status.superseded.bySupersedingVersion)} on ${escapeHtml(status.superseded.supersededAtLabel)}. Obtain the current version before acting on it.</div>`,
    );
  }

  if (status.release === 'provisional') {
    const reason = status.provisionalReason === undefined ? '' : ` ${escapeHtml(status.provisionalReason)}.`;
    banners.push(
      `<div class="banner banner-stop"><strong>PROVISIONAL — NOT FOR CLINICAL USE.</strong> This report has not been medically authorised.${reason} Results may change on validation.</div>`,
    );
  }

  if (status.release === 'amended' && status.amendment !== undefined) {
    banners.push(
      `<div class="banner banner-amend"><strong>AMENDED REPORT — version ${String(status.version)}.</strong> Supersedes version ${String(status.amendment.supersedesVersion)} issued ${escapeHtml(status.amendment.supersedesIssuedAtLabel)}. Amended by ${escapeHtml(status.amendment.amendedBy)} on ${escapeHtml(status.amendment.amendedAtLabel)}. Reason: ${escapeHtml(status.amendment.reason)}. Destroy or disregard any earlier printed copy.</div>`,
    );
  }

  return banners.join('');
}

const AMENDMENT_OPEN = [
  '<section class="section">',
  '<h2 class="section-heading">Amendment history — what changed in this version</h2>',
  '<table class="doc"><colgroup><col style="width:34%"/><col style="width:33%"/><col style="width:33%"/></colgroup><thead><tr>',
  '<th>Item</th><th>Superseded value</th><th>Amended value</th>',
  '</tr></thead><tbody>',
].join('');

const AMENDMENT_CLOSE = '</tbody></table></section>';

/**
 * The itemised amendment history, one block per changed item so a report that
 * corrected forty analytes still paginates.
 */
export function amendmentBlocks(amendment: Amendment): readonly PageBlock[] {
  const container = { id: 'amendment', open: AMENDMENT_OPEN, close: AMENDMENT_CLOSE };
  return amendment.changes.map((change, index) => ({
    html: `<tr><td>${bdi(change.item)}</td><td>${bdi(change.previous)}</td><td class="amended-cell">${bdi(change.current)}</td></tr>`,
    heightMm: HEIGHT.tableRow + (index === 0 ? HEIGHT.sectionHeading + HEIGHT.tableHead : 0),
    container,
  }));
}

export function renderAuthorisers(status: ReportStatus, authorisers: readonly Authoriser[]): string {
  if (status.release === 'provisional') {
    const author = authorisers.find((entry) => entry.role === 'author');
    const by =
      author === undefined
        ? ''
        : `<div class="auth-name">Prepared by ${escapeHtml(author.name)}${author.designation === undefined ? '' : ` &middot; ${escapeHtml(author.designation)}`}</div>`;
    return [
      '<div class="auth-block auth-unsigned">',
      '<div class="auth-title">Not authorised</div>',
      by,
      '<div class="auth-note">No authorising signatory. This document is a working copy and must not be filed, issued to a patient, or acted on clinically.</div>',
      '</div>',
    ].join('');
  }

  const cards = authorisers
    .filter((entry) => entry.role !== 'author')
    .map((entry) => renderAuthoriserCard(entry))
    .join('');

  return `<div class="auth-block">${cards}</div>`;
}

function renderAuthoriserCard(entry: Authoriser): string {
  const image =
    entry.signatureImageDataUri === undefined
      ? ''
      : `<img class="auth-sig" src="${escapeHtml(entry.signatureImageDataUri)}" alt="" />`;
  const line = [entry.credentials, entry.designation]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .map(escapeHtml)
    .join(' &middot; ');
  const registrations = [`Reg. No. ${escapeHtml(entry.registrationNo)}`];
  if (entry.pcpndtRegistrationNo !== undefined) {
    registrations.push(`PC-PNDT Reg. No. ${escapeHtml(entry.pcpndtRegistrationNo)}`);
  }
  const method =
    entry.signMethod === undefined
      ? ''
      : `<div class="auth-method">Signed electronically (${escapeHtml(entry.signMethod)})</div>`;
  const roleLabel = entry.role === 'cosigner' ? 'Countersigned by' : 'Authorised by';

  return [
    '<div class="auth-card">',
    image,
    `<div class="auth-role">${roleLabel}</div>`,
    `<div class="auth-name">${escapeHtml(entry.name)}</div>`,
    line.length === 0 ? '' : `<div class="auth-line">${line}</div>`,
    `<div class="auth-reg">${registrations.join(' &middot; ')}</div>`,
    `<div class="auth-at">${escapeHtml(entry.signedAtLabel)}</div>`,
    method,
    '</div>',
  ].join('');
}

export function renderEndOfReport(): string {
  return '<div class="end-of-report">— End of report —</div>';
}

// ── Pagination ──────────────────────────────────────────────────────────────

/**
 * One unit of printable content with an estimated height.
 *
 * The heights are estimates, and that is a deliberate trade. The alternative —
 * letting Chromium break the flow — cannot produce "Page 2 of 5" at all, because
 * Chromium implements neither `@page` margin boxes nor `counter(pages)`, and
 * `page.pdf()`'s header/footer templates live in the renderer rather than in the
 * template, which would put page numbering outside every unit test. Paginating
 * here buys a real page count, a patient identity repeated on every page (NABL
 * 112 §7.4.1.1), and rows that provably never split — at the cost of a
 * conservative budget that sometimes leaves whitespace at the foot of a page.
 */
export interface PageBlock {
  readonly html: string;
  /** Estimated printed height in millimetres at the shell's 9.5 pt body size. */
  readonly heightMm: number;
  /** Glue to the block that follows — a heading must never end a page. */
  readonly keepWithNext?: boolean | undefined;
  /** May not begin a page: the previous group is pulled forward with it. */
  readonly mayNotStartPage?: boolean | undefined;
  /**
   * A fragment of a repeating container — a table row, a list item — rather
   * than a free-standing block.
   *
   * Consecutive blocks sharing an `id` are wrapped in one container *per page*,
   * with `open` reprinted at the top of each page the run continues onto. That
   * is what lets a 200-analyte table break across ten pages with the column
   * headings on every one of them and identical column widths throughout.
   *
   * It is also what keeps any *list* splittable. A block is atomic — the
   * paginator can move it but never divide it — so a single block holding 200
   * rows, or 29 critical values, is a block taller than the paper, and no
   * amount of budgeting fixes that. Anything that can grow without bound is
   * therefore emitted one fragment per block.
   */
  readonly container?: { readonly id: string; readonly open: string; readonly close: string } | undefined;
}

/**
 * The page box, the chrome that surrounds the content, and the height model.
 *
 * **Every number below was measured, not guessed.** `letterheadStyles` declares
 * `@page { size: A4; margin: 12mm 12mm 16mm }`, so Chromium lays the document
 * out 186 mm wide and 269 mm tall. The constants are the printed heights of the
 * real elements at that width, read back out of a `page.pdf()` render and
 * rounded up: the first draft of this file estimated them, and the estimates
 * were 25–40 % low, which turned "Page 1 of 2" into a three-page PDF. If the
 * stylesheet changes, re-measure — a height model that drifts from its CSS is
 * worse than none, because it fails silently.
 *
 * They are rounded *up* on purpose. Over-reserving leaves whitespace at the
 * foot of a page; under-reserving pushes the absolutely-positioned page footer
 * onto the next sheet and makes the page numbering a lie.
 */
export const PAGE_BOX_MM = 264;
export const PAGE_FOOTER_MM = 8;
const LETTERHEAD_MM = 50;
const TITLE_MM = 11;
const SUBTITLE_MM = 8;
const ACCREDITATION_MM = 6;
const CONTINUATION_STRIP_MM = 14;

/** Measured heights of the shell's own repeated elements. */
export const HEIGHT = Object.freeze({
  /** One line of 9.5 pt body text at 1.45 line-height. */
  line: 5.0,
  /**
   * Characters per line at 186 mm. Measured at 107 for a pathological
   * all-narrow string and observed around 120 for real prose; 115 sits between
   * them, so ordinary paragraphs are slightly over-reserved and a page of
   * `lllll` is not under-reserved.
   */
  charsPerLine: 115,
  paragraphGap: 1.5,
  sectionHeading: 8,
  metaRowTwoColumn: 7.5,
  metaRowThreeColumn: 9,
  metaTrailing: 3,
  tableHead: 13,
  tableRow: 8.5,
  /** A LOINC/second line under the analyte name, and the taller critical row. */
  tableRowSubline: 4,
  tableRowCritical: 4,
  commentRowBase: 3.5,
  commentRowLine: 3.5,
  endOfReport: 7,
  authBlock: 36,
  authCardExtra: 30,
  qrBlock: 28,
  footerNote: 8,
  bannerFixed: 6,
  bannerAlerts: 9,
  calloutFixed: 16,
  calloutParagraphGap: 3.5,
});

export function linesFor(text: string): number {
  return Math.max(1, Math.ceil(text.length / HEIGHT.charsPerLine));
}

/** Height of a run of paragraphs rendered inside `.prose`. */
export function proseMm(paragraphs: readonly string[]): number {
  return paragraphs.reduce((sum, text) => sum + linesFor(text) * HEIGHT.line + HEIGHT.paragraphGap, 0);
}

/** Height of a `.meta` grid. The banner's grid is three columns; every other is two. */
export function metaMm(entries: number, columns: 2 | 3 = 2): number {
  if (entries === 0) return 0;
  const rowHeight = columns === 3 ? HEIGHT.metaRowThreeColumn : HEIGHT.metaRowTwoColumn;
  return Math.ceil(entries / columns) * rowHeight + HEIGHT.metaTrailing;
}

export function patientBannerMm(patient: PatientBanner): number {
  const entries =
    3 +
    (patient.dateOfBirthLabel === undefined ? 0 : 1) +
    (patient.secondaryId === undefined ? 0 : 1) +
    (patient.referringDoctor === undefined ? 0 : 1) +
    (patient.referringFacility === undefined ? 0 : 1) +
    (patient.wardBed === undefined ? 0 : 1) +
    (patient.visitType === undefined ? 0 : 1);
  return HEIGHT.bannerFixed + metaMm(entries, 3) + (patient.alerts.length === 0 ? 0 : HEIGHT.bannerAlerts);
}

export function authBlockMm(authorisers: readonly Authoriser[]): number {
  const signatories = authorisers.filter((entry) => entry.role !== 'author').length;
  return HEIGHT.authBlock + (signatories > 2 ? HEIGHT.authCardExtra : 0);
}

/** Height of the status banner run, which is the widest thing on an amended report. */
export function statusBannerMm(status: ReportStatus): number {
  let total = 0;
  if (status.superseded !== undefined) total += 8 + 2 * HEIGHT.line;
  if (status.release === 'provisional') total += 8 + 2 * HEIGHT.line;
  if (status.release === 'amended' && status.amendment !== undefined) {
    total += 8 + linesFor(status.amendment.reason) * HEIGHT.line + 3 * HEIGHT.line;
  }
  return total;
}

export interface ChromeShape {
  readonly subtitle: boolean;
  readonly accreditationNote: boolean;
}

/** What is left for content on page 1, under the letterhead and the title. */
export function firstPageBudgetMm(shape: ChromeShape): number {
  const chrome =
    LETTERHEAD_MM +
    TITLE_MM +
    (shape.subtitle ? SUBTITLE_MM : 0) +
    (shape.accreditationNote ? ACCREDITATION_MM : 0);
  return PAGE_BOX_MM - PAGE_FOOTER_MM - chrome;
}

/** What is left on a continuation page, under the repeated identity strip. */
export const LATER_PAGE_BUDGET_MM = PAGE_BOX_MM - PAGE_FOOTER_MM - CONTINUATION_STRIP_MM;

interface BlockGroup {
  readonly blocks: readonly PageBlock[];
  readonly heightMm: number;
  readonly mayNotStartPage: boolean;
}

function groupBlocks(blocks: readonly PageBlock[]): BlockGroup[] {
  const groups: BlockGroup[] = [];
  let current: PageBlock[] = [];
  let glued = false;

  for (const block of blocks) {
    if (current.length > 0 && !glued) {
      groups.push(toGroup(current));
      current = [];
    }
    current.push(block);
    glued = block.keepWithNext === true;
  }
  if (current.length > 0) groups.push(toGroup(current));
  return groups;
}

function toGroup(blocks: readonly PageBlock[]): BlockGroup {
  return {
    blocks,
    heightMm: blocks.reduce((sum, block) => sum + block.heightMm, 0),
    mayNotStartPage: blocks[0]?.mayNotStartPage === true,
  };
}

/**
 * Chunk blocks into pages, then run the orphan pass: a group flagged
 * `mayNotStartPage` — the authorisation block — drags the preceding group onto
 * its page rather than standing alone under a letterhead.
 */
export interface PaginateOptions {
  /** From `firstPageBudgetMm()` — page 1 carries the letterhead, so it is shorter. */
  readonly firstPageBudgetMm: number;
  /**
   * Height of the container header that `renderBlocks` reprints at the top of
   * every page a run continues onto. Reserved on continuation pages, because
   * that header appears there without any block accounting for it.
   */
  readonly repeatedTableHeadMm?: number | undefined;
}

export function paginate(
  blocks: readonly PageBlock[],
  options: PaginateOptions,
): readonly (readonly PageBlock[])[] {
  const groups = groupBlocks(blocks);
  const hasTable = blocks.some((block) => block.container !== undefined);
  const laterBudget =
    LATER_PAGE_BUDGET_MM - (hasTable ? (options.repeatedTableHeadMm ?? HEIGHT.tableHead) : 0);
  const pages: BlockGroup[][] = [];
  let current: BlockGroup[] = [];
  let used = 0;

  for (const group of groups) {
    const budget = pages.length === 0 ? options.firstPageBudgetMm : laterBudget;
    if (current.length > 0 && used + group.heightMm > budget) {
      pages.push(current);
      current = [];
      used = 0;
    }
    current.push(group);
    used += group.heightMm;
  }
  if (current.length > 0) pages.push(current);

  for (let index = pages.length - 1; index > 0; index -= 1) {
    const page = pages[index];
    const previous = pages[index - 1];
    if (page === undefined || previous === undefined) continue;
    if (page[0]?.mayNotStartPage !== true || previous.length < 2) continue;
    const pulled = previous.pop();
    if (pulled !== undefined) page.unshift(pulled);
  }

  return pages.map((page) => page.flatMap((group) => group.blocks));
}

/**
 * Emit one page's blocks, wrapping each run of container fragments in its
 * container. A run that spans a page break is reopened — headings and all — at
 * the top of the next page.
 */
export function renderBlocks(blocks: readonly PageBlock[]): string {
  const out: string[] = [];
  let open: { id: string; close: string } | null = null;

  for (const block of blocks) {
    const container = block.container;
    if (container === undefined) {
      if (open !== null) {
        out.push(open.close);
        open = null;
      }
      out.push(block.html);
      continue;
    }
    const current: { id: string; close: string } | null = open;
    if (current === null || current.id !== container.id) {
      if (current !== null) out.push(current.close);
      out.push(container.open);
      open = { id: container.id, close: container.close };
    }
    out.push(block.html);
  }
  if (open !== null) out.push(open.close);

  return out.join('');
}

export interface ShellOptions {
  readonly title: string;
  readonly subtitle?: string | undefined;
  readonly reportNo: string;
  readonly accessionNo: string;
  readonly status: ReportStatus;
  readonly patient: PatientBanner;
  readonly accreditationNote?: string | undefined;
}

function continuationStrip(options: ShellOptions, page: number): string {
  const statusWord =
    options.status.superseded !== undefined
      ? 'SUPERSEDED'
      : options.status.release === 'provisional'
        ? 'PROVISIONAL'
        : options.status.release === 'amended'
          ? 'AMENDED'
          : 'FINAL';
  return [
    '<div class="cont-strip">',
    `<span class="cont-name">${bdi(options.patient.name)}</span>`,
    `<span>UHID ${bdi(options.patient.uhid)}</span>`,
    `<span>${bdi(options.patient.ageSex)}</span>`,
    `<span>Accession ${bdi(options.accessionNo)}</span>`,
    `<span>Report ${bdi(options.reportNo)} v${String(options.status.version)}</span>`,
    `<span class="cont-status">${statusWord}</span>`,
    `<span class="cont-page">continued &mdash; page ${String(page)}</span>`,
    '</div>',
  ].join('');
}

/**
 * Wrap paginated blocks in pages with a repeated identity header and a real
 * `Page n of N` footer, then close the document.
 */
export function renderReportPages(
  pages: readonly (readonly PageBlock[])[],
  context: PrintContext,
  options: ShellOptions,
): string {
  const total = pages.length;
  // The seal is `position: fixed`, which Chromium repeats on every printed
  // page, so it is emitted once. Emitting it per page would stack N copies on
  // page 1 in a browser preview.
  const seal = renderStatusSeal(options.status);
  return (
    seal +
    pages
      .map((blocks, index) => {
        const pageNo = index + 1;
        const head =
          pageNo === 1
            ? [
                renderLetterhead(context),
                options.accreditationNote === undefined
                  ? ''
                  : `<div class="accreditation">${escapeHtml(options.accreditationNote)}</div>`,
                `<h1 class="doc-title">${escapeHtml(options.title)}</h1>`,
                options.subtitle === undefined
                  ? ''
                  : `<div class="doc-subtitle">${escapeHtml(options.subtitle)}</div>`,
              ].join('')
            : continuationStrip(options, pageNo);

        const duplicate = context.duplicate
          ? `<span class="pf-dup">DUPLICATE${context.duplicateReason === undefined ? '' : ` &mdash; ${escapeHtml(context.duplicateReason)}`}</span>`
          : '';

        return [
          '<section class="page">',
          head,
          '<div class="page-body">',
          renderBlocks(blocks),
          '</div>',
          '<footer class="page-foot">',
          `<span class="pf-ref">${bdi(options.reportNo)} &middot; v${String(options.status.version)} &middot; Accession ${bdi(options.accessionNo)}</span>`,
          duplicate,
          `<span class="pf-by">Printed ${escapeHtml(context.printedAtLabel)} by ${escapeHtml(context.printedBy)}</span>`,
          `<span class="pf-page">Page ${String(pageNo)} of ${String(total)}</span>`,
          '</footer>',
          '</section>',
        ].join('');
      })
      .join('')
  );
}

/** Open the document. The shell owns `<html lang dir>` — see `document.ts`. */
export function openDocument(context: PrintContext, title: string): string {
  return [
    `<!doctype html><html lang="${escapeHtml(context.locale)}" dir="${context.direction}"><head>`,
    '<meta charset="utf-8" />',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${letterheadStyles('A4')}\n${reportStyles()}</style>`,
    '</head><body class="report">',
  ].join('');
}

export function closeDocument(): string {
  return '</body></html>';
}

/**
 * The report stylesheet, layered on `letterheadStyles('A4')`.
 *
 * Monochrome by policy (`docs/06 §4.5`: `#000` on `#FFF`, hairline rules, 8 %
 * grey table headers). `print-color-adjust: exact` appears on exactly two
 * things — the QR and the critical/flag glyphs — because those are the two
 * places where a printer driver's "save toner" mode would destroy meaning
 * rather than contrast.
 */
export function reportStyles(): string {
  return `
body.report { font-size: 9.5pt; }
.page { position: relative; min-height: ${String(PAGE_BOX_MM)}mm; padding-block-end: ${String(PAGE_FOOTER_MM)}mm; }
.page + .page { break-before: page; }
.page-body { position: relative; }
.page-foot { position: absolute; inset-block-end: 0; inset-inline: 0; display: flex; gap: 8pt; justify-content: space-between; align-items: baseline; font-size: 7.5pt; color: #333; border-block-start: 0.5pt solid #999; padding-block-start: 3pt; }
.page-foot .pf-page { font-weight: 700; white-space: nowrap; }
.page-foot .pf-dup { font-weight: 700; }
.cont-strip { display: flex; flex-wrap: wrap; gap: 4pt 10pt; font-size: 8pt; border-block-end: 1pt solid #111; padding-block-end: 3pt; margin-block-end: 6pt; }
.cont-strip .cont-name { font-weight: 700; }
.cont-strip .cont-status { font-weight: 700; letter-spacing: 0.4pt; }
.cont-strip .cont-page { margin-inline-start: auto; }
.accreditation { font-size: 8pt; text-align: center; color: #333; margin-block-start: 2pt; }
.pt-banner { border: 0.5pt solid #999; padding: 4pt 6pt; margin-block-end: 6pt; break-inside: avoid; }
.pt-banner .meta { margin-block-end: 0; grid-template-columns: repeat(3, minmax(0, 1fr)); }
.pt-alerts { margin-block-start: 3pt; display: flex; flex-wrap: wrap; gap: 4pt; }
.pt-alert { border: 1pt solid #000; padding: 0 4pt; font-weight: 800; text-transform: uppercase; font-size: 8.5pt; letter-spacing: 0.3pt; }
.banner { border: 1.5pt solid #000; padding: 4pt 6pt; margin-block-end: 6pt; font-size: 9.5pt; break-inside: avoid; }
.banner-stop { border-width: 2.5pt; }
.banner-amend { border-style: double; border-width: 3pt; }
.seal { position: fixed; inset-block-start: 36%; inset-inline-start: 12%; font-size: 40pt; line-height: 1.05; font-weight: 800; letter-spacing: 2pt; color: rgba(0,0,0,0.13); transform: rotate(-22deg); pointer-events: none; text-align: center; }
.seal-superseded { font-size: 52pt; }
.critical-callout { border: 2.5pt solid #000; padding: 5pt 7pt; margin-block-end: 6pt; break-inside: avoid; }
.critical-callout h2 { font-size: 11pt; margin: 0 0 3pt; text-transform: uppercase; letter-spacing: 0.6pt; }
.critical-callout ul { margin: 0; padding-inline-start: 14pt; }
.critical-callout li { margin-block-end: 2pt; }
table.doc tr { break-inside: avoid; }
table.doc thead { display: table-header-group; }
tr.row-critical > td { font-weight: 800; border-block-color: #000; }
tr.row-critical > td:first-child { border-inline-start: 3pt solid #000; }
tr.row-abnormal > td { font-weight: 700; }
tr.row-amended > td { background: #ededed; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.flag { display: inline-block; font-weight: 800; font-size: 8.5pt; letter-spacing: 0.3pt; }
.flag-critical { background: #000; color: #fff; padding: 0 3pt; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.flag-abnormal { border: 0.75pt solid #000; padding: 0 3pt; }
.amended-cell { font-weight: 800; }
.amended-tag { font-weight: 800; font-size: 7.5pt; letter-spacing: 0.4pt; border: 0.75pt solid #000; padding: 0 2pt; margin-inline-start: 3pt; }
.row-comment { font-size: 8.5pt; color: #222; }
.prose p { margin: 0 0 3pt; }
.prose { white-space: normal; }
.impression p { font-weight: 700; }
.auth-block { display: flex; flex-wrap: wrap; gap: 12pt; justify-content: flex-end; margin-block-start: 10pt; break-inside: avoid; }
.auth-card { min-inline-size: 62mm; border-block-start: 0.75pt solid #111; padding-block-start: 3pt; text-align: start; }
.auth-sig { display: block; block-size: 14mm; inline-size: auto; margin-block-end: 2pt; }
.auth-role { font-size: 8pt; color: #333; }
.auth-name { font-weight: 800; }
.auth-line, .auth-reg, .auth-at, .auth-method { font-size: 8.5pt; }
.auth-method { color: #333; }
.auth-unsigned { border: 1.5pt dashed #000; padding: 5pt 7pt; justify-content: flex-start; display: block; }
.auth-unsigned .auth-title { font-weight: 800; text-transform: uppercase; letter-spacing: 0.5pt; }
.auth-note { font-size: 8.5pt; }
.end-of-report { text-align: center; font-size: 8.5pt; letter-spacing: 1pt; margin-block-start: 6pt; }
.qr-block { display: flex; gap: 8pt; align-items: center; margin-block-start: 8pt; break-inside: avoid; }
.qr-block .qr { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.qr-caption { font-weight: 700; font-size: 8.5pt; }
.qr-url { font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 7.5pt; word-break: break-all; }
.qr-validity { font-size: 7.5pt; color: #333; }
.footer-note { font-size: 8pt; color: #222; margin-block-start: 6pt; }
.trend { inline-size: 100%; block-size: 16mm; }
.legend { font-size: 7.5pt; color: #333; margin-block-start: 3pt; }
`.trim();
}

/** Identifiers the verify URL must not contain, gathered from the whole payload. */
export function forbiddenInQr(
  patient: PatientBanner,
  extra: readonly (string | undefined)[],
): readonly string[] {
  return [
    ...bannerIdentifiers(patient),
    ...extra.filter((value): value is string => value !== undefined && value.trim().length > 0),
  ];
}
