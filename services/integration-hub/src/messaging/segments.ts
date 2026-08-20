/**
 * SMS segment counting — EN-009 §13 "Unicode SMS segment counting (70
 * chars/segment)" and §3.7 (cost is `segments × rate`).
 *
 * This is billing arithmetic, not a formatting detail. A Tamil appointment
 * reminder is UCS-2 at 70 characters per segment against GSM-7's 160; the same
 * sentence therefore costs two to three times as much, and a cost report built
 * on a character count rather than a segment count is wrong for every
 * non-English tenant — which is most of them.
 *
 * The GSM 03.38 tables are transcribed rather than approximated because the
 * extension characters (`€ [ ] { } \ | ^ ~`) each occupy **two** septets, and a
 * template that fits in 160 characters but contains four square brackets does
 * not fit in one segment.
 */

/** GSM 03.38 basic character set. */
const GSM7_BASIC = new Set<string>(
  [
    '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ',
    ' !"#¤%&\'()*+,-./0123456789:;<=>?',
    '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§',
    '¿abcdefghijklmnopqrstuvwxyzäöñüà',
  ]
    .join('')
    .split(''),
);

/** Characters that cost two septets because they are reached with an escape. */
const GSM7_EXTENDED = new Set<string>(['\f', '^', '{', '}', '\\', '[', '~', ']', '|', '€']);

export type SmsEncoding = 'gsm7' | 'ucs2';

export interface SegmentCount {
  readonly encoding: SmsEncoding;
  readonly segments: number;
  /** Septets for GSM-7, UTF-16 code units for UCS-2. */
  readonly units: number;
  readonly characters: number;
}

const GSM7_SINGLE = 160;
const GSM7_CONCATENATED = 153;
const UCS2_SINGLE = 70;
const UCS2_CONCATENATED = 67;

export function countSegments(body: string): SegmentCount {
  const characters = [...body].length;

  let septets = 0;
  let gsm7 = true;
  for (const char of body) {
    if (GSM7_BASIC.has(char)) {
      septets += 1;
    } else if (GSM7_EXTENDED.has(char)) {
      septets += 2;
    } else {
      gsm7 = false;
      break;
    }
  }

  if (gsm7) {
    const segments =
      septets <= GSM7_SINGLE
        ? Math.max(1, Math.ceil(septets / GSM7_SINGLE))
        : Math.ceil(septets / GSM7_CONCATENATED);
    return { encoding: 'gsm7', segments: Math.max(segments, 1), units: septets, characters };
  }

  // UCS-2 counts UTF-16 code units, so an emoji outside the BMP costs two.
  const units = body.length;
  const segments =
    units <= UCS2_SINGLE ? Math.max(1, Math.ceil(units / UCS2_SINGLE)) : Math.ceil(units / UCS2_CONCATENATED);
  return { encoding: 'ucs2', segments: Math.max(segments, 1), units, characters };
}
