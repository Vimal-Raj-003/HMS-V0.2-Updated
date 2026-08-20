/**
 * Specimen (container) label — `EN-005 §4.1`: `lab_label`, ZPL 50 × 25 mm,
 * printed at the collection point on `lab.order.collection_started`, one per
 * container, and `EN-005 §14.5`: "Given a lab order with 4 containers, when
 * collection labels are printed, then 4 ZPL labels with correct barcodes print
 * in order."
 *
 * Patient-safety content is fixed by NABH's two-identifier rule: the label
 * carries the accession barcode **and** two human-readable identifiers (name and
 * UHID), because a barcode that will not scan must still be safe to read.
 */

import { z } from 'zod';

import { defineTemplate, type PrintContext, type RegisteredTemplate, type RenderedZpl } from '../types.js';
import { zpl, type LabelDpi } from './commands.js';

export const labLabelPayloadSchema = z.object({
  /** Scanned by the analyzer; also the barcode content unless overridden. */
  accessionNo: z.string().min(1).max(32),
  barcodeData: z.string().min(1).max(64).optional(),
  patientName: z.string().min(1),
  uhid: z.string().min(1),
  /** `45/M`, `3m/F` — the age format of `docs/06 §8`. */
  ageSex: z.string().min(1),
  testName: z.string().min(1),
  /** `EDTA 1 of 3` — which tube of how many. */
  containerLabel: z.string().min(1),
  collectedAtLabel: z.string().min(1),
  priority: z.enum(['routine', 'stat']).default('routine'),
  copies: z.number().int().min(1).max(20).default(1),
  dpi: z.union([z.literal(203), z.literal(300)]).default(203),
});

export type LabLabelPayload = z.infer<typeof labLabelPayloadSchema>;

const WIDTH_MM = 50;
const HEIGHT_MM = 25;

export function renderLabLabel(payload: LabLabelPayload, context: PrintContext): RenderedZpl {
  const dpi: LabelDpi = payload.dpi;
  const builder = zpl(dpi).start(WIDTH_MM, HEIGHT_MM);

  builder.text(2, 1.5, `${payload.patientName} ${payload.ageSex}`, dpi === 300 ? 26 : 18);
  builder.text(2, 6, `UHID ${payload.uhid}`, dpi === 300 ? 22 : 15);
  builder.code128(2, 10, payload.barcodeData ?? payload.accessionNo, dpi === 300 ? 60 : 40);
  builder.textBlock(
    2,
    20,
    WIDTH_MM - 4,
    `${payload.testName} | ${payload.containerLabel}`,
    dpi === 300 ? 20 : 14,
    1,
  );
  builder.text(2, 22.6, `${payload.collectedAtLabel} | ${context.branch.name}`, dpi === 300 ? 17 : 12);

  if (payload.priority === 'stat') {
    builder.inverseText(38, 1.5, 'STAT', dpi === 300 ? 26 : 18);
  }
  if (context.duplicate) {
    builder.text(38, 6, 'RELABEL', dpi === 300 ? 18 : 12);
  }

  builder.quantity(payload.copies).end();

  return {
    format: 'zpl',
    contentType: 'application/vnd.zpl',
    paper: 'label_50x25',
    zpl: builder.build(),
    copies: payload.copies,
  };
}

export const labLabelTemplate: RegisteredTemplate = defineTemplate({
  key: 'lab_label.zpl.v1',
  docType: 'lab_label',
  format: 'zpl',
  paper: 'label_50x25',
  version: 1,
  description: 'Specimen container label, 50 × 25 mm, Code 128 accession barcode (EN-005 §4.1).',
  phi: true,
  payloadSchema: labLabelPayloadSchema,
  render: renderLabLabel,
});
