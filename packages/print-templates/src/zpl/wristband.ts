/**
 * Inpatient wristband — `EN-005 §4.1`: `wristband`, ZPL band, printed at the
 * ward or admission desk on `ip.admission.created`, "reissue deactivates old".
 *
 * `docs/06 §5` and NABH require **two identifiers** plus the allergy flag; the
 * band is the last line of defence when a patient cannot speak for themselves,
 * so the allergy line is inverse-printed and never abbreviated away.
 */

import { z } from 'zod';

import { defineTemplate, type PrintContext, type RegisteredTemplate, type RenderedZpl } from '../types.js';
import { zpl, type LabelDpi } from './commands.js';

export const wristbandPayloadSchema = z.object({
  patientName: z.string().min(1),
  uhid: z.string().min(1),
  ipNumber: z.string().min(1),
  ageSex: z.string().min(1),
  bloodGroup: z.string().optional(),
  wardBed: z.string().min(1),
  admittedAtLabel: z.string().min(1),
  /** Rendered verbatim and inverse. Empty means "no known allergies". */
  allergies: z.array(z.string()).default([]),
  /** Medico-legal case — the band must say so (`EN-005 §Regulatory`). */
  mlc: z.boolean().default(false),
  barcodeData: z.string().min(1),
  dpi: z.union([z.literal(203), z.literal(300)]).default(203),
});

export type WristbandPayload = z.infer<typeof wristbandPayloadSchema>;

const WIDTH_MM = 25;
const HEIGHT_MM = 280;

export function renderWristband(payload: WristbandPayload, context: PrintContext): RenderedZpl {
  const dpi: LabelDpi = payload.dpi;
  const big = dpi === 300 ? 30 : 22;
  const small = dpi === 300 ? 22 : 15;
  const builder = zpl(dpi).start(WIDTH_MM, HEIGHT_MM);

  builder.text(2, 2, context.hospital.name, small);
  builder.text(2, 6, payload.patientName, big);
  builder.text(2, 11, `${payload.ageSex}  ${payload.bloodGroup ?? ''}`.trim(), small);
  builder.text(2, 15, `UHID ${payload.uhid}`, small);
  builder.text(2, 19, `IP ${payload.ipNumber}  ${payload.wardBed}`, small);
  builder.code128(2, 23, payload.barcodeData, dpi === 300 ? 55 : 38);
  builder.text(2, 34, payload.admittedAtLabel, small);

  if (payload.allergies.length > 0) {
    builder.inverseText(2, 38, `ALLERGY: ${payload.allergies.join(', ')}`, small);
  }
  if (payload.mlc) {
    builder.inverseText(2, 43, 'MLC', small);
  }

  builder.quantity(1).end();

  return {
    format: 'zpl',
    contentType: 'application/vnd.zpl',
    paper: 'wristband',
    zpl: builder.build(),
    copies: 1,
  };
}

export const wristbandTemplate: RegisteredTemplate = defineTemplate({
  key: 'wristband.zpl.v1',
  docType: 'wristband',
  format: 'zpl',
  paper: 'wristband',
  version: 1,
  description: 'Inpatient wristband with two identifiers, allergy and MLC flags (EN-005 §4.1).',
  phi: true,
  payloadSchema: wristbandPayloadSchema,
  render: renderWristband,
});
