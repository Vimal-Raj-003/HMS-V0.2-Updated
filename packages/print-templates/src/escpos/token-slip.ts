/**
 * The queue token slip — the first thing Vim's HMS ever prints
 * (`EN-005 §4.1`: `token`, ESC/POS 58/80 mm, auto-printed on
 * `queue.token.issued`, reprint free) and exit gate 6 of
 * `docs/prompts/phase-00-foundation.md`.
 *
 * Design constraints that show up in the byte stream:
 *  - The token number is the only thing a patient reads from three metres away,
 *    so it is printed at 4× size and nothing else is.
 *  - Digits are spoken and displayed one at a time elsewhere (`docs/06 §8` TTS),
 *    so the number is kept short and never grouped.
 *  - The QR carries the token URL for the patient's phone; it is the last thing
 *    before the cut so a short paper roll truncates the least important part.
 */

import { z } from 'zod';

import { defineTemplate, type PrintContext, type RegisteredTemplate, type RenderedEscPos } from '../types.js';
import { LINE_WIDTH, escpos } from './commands.js';

export const tokenSlipPayloadSchema = z.object({
  /** `C-45`, `A12` — already formatted by the numbering-series service. */
  tokenNumber: z.string().min(1).max(12),
  counterName: z.string().min(1),
  departmentName: z.string().min(1),
  doctorName: z.string().optional(),
  /** Optional: a walk-in token is issued before the patient is identified. */
  patientName: z.string().optional(),
  uhid: z.string().optional(),
  /** How many people are ahead — the single most asked question at a counter. */
  queueAhead: z.number().int().min(0),
  /** Pre-formatted by the caller (`@vims/i18n`), e.g. `20-08-2026 09:14`. */
  issuedAtLabel: z.string().min(1),
  /** Deep link for the patient's phone; omitted for anonymous kiosks. */
  qrData: z.string().optional(),
  paper: z.enum(['thermal_58mm', 'thermal_80mm']).default('thermal_80mm'),
});

export type TokenSlipPayload = z.infer<typeof tokenSlipPayloadSchema>;

export function renderTokenSlip(payload: TokenSlipPayload, context: PrintContext): RenderedEscPos {
  const width = LINE_WIDTH[payload.paper];
  const builder = escpos()
    .init()
    .codePage(19)
    .align('center')
    .bold(true)
    .line(context.hospital.name)
    .bold(false)
    .line(context.branch.name)
    .rule(width)
    .line(payload.departmentName);

  if (payload.doctorName !== undefined) {
    builder.line(payload.doctorName);
  }

  builder
    .feed(1)
    .size(4, 4)
    .bold(true)
    .line(payload.tokenNumber)
    .bold(false)
    .size(1, 1)
    .feed(1)
    .align('left')
    .keyValue('Counter', payload.counterName, width)
    .keyValue('Ahead of you', String(payload.queueAhead), width)
    .keyValue('Issued', payload.issuedAtLabel, width);

  if (payload.patientName !== undefined) {
    builder.keyValue('Patient', payload.patientName, width);
  }
  if (payload.uhid !== undefined) {
    builder.keyValue('UHID', payload.uhid, width);
  }
  if (context.duplicate) {
    builder.align('center').bold(true).line('** DUPLICATE **').bold(false).align('left');
  }

  builder.rule(width);

  if (payload.qrData !== undefined) {
    builder.align('center').qr(payload.qrData, 6).feed(1);
  }

  builder.align('center').line('Please wait for your number').cut(3);

  return {
    format: 'escpos',
    contentType: 'application/octet-stream',
    paper: payload.paper,
    bytes: builder.build(),
  };
}

export const tokenSlipTemplate: RegisteredTemplate = defineTemplate({
  key: 'token.escpos.v1',
  docType: 'token',
  format: 'escpos',
  paper: 'thermal_80mm',
  version: 1,
  description: 'Queue token slip for a counter or kiosk thermal printer (EN-005 §4.1, EN-006).',
  // A token may carry a patient name once the patient is identified.
  phi: true,
  payloadSchema: tokenSlipPayloadSchema,
  render: renderTokenSlip,
});
