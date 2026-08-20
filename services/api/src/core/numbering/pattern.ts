/**
 * Human-facing identifier formatting for `core.numbering_series`
 * (`docs/03 §Numbering`).
 *
 * These are the numbers a patient reads back over the phone, a cashier writes on
 * a receipt and an auditor traces through a financial year, so the formatting is
 * pure and separately tested: a UHID that changes shape between releases is a
 * patient whose old card no longer matches their record.
 */

/** A token that a numbering pattern may contain. */
export type PatternToken = 'BR' | 'HOSP' | 'FY' | 'YYYY' | 'YY' | 'MM' | 'DD' | 'SEQ';

export interface PatternContext {
  /** Branch short code, e.g. `BLR`. Required by any pattern using `{BR}`. */
  readonly branchCode?: string | undefined;
  /** Hospital code, required by any pattern using `{HOSP}`. */
  readonly hospitalCode?: string | undefined;
  /** Indian financial year label, e.g. `2026-27`. */
  readonly fy?: string | undefined;
  /** The instant the number is allocated, for the date tokens. */
  readonly at: Date;
  /** IANA zone the hospital works in; date tokens are rendered in it. */
  readonly timeZone: string;
}

export class PatternError extends Error {}

const TOKEN_RE = /\{(BR|HOSP|FY|YYYY|YY|MM|DD|SEQ)(?::(\d{1,3}))?\}/g;

/**
 * The Indian financial year runs 1 April to 31 March and is written `2026-27`.
 *
 * Getting this wrong is not cosmetic: `RECEIPT` and `BILL_*` are gapless and
 * reset on it, so a boundary computed a day early restarts an invoice series
 * mid-year, and two receipts end up carrying the same number in the same FY.
 */
export function financialYearOf(at: Date, timeZone: string): string {
  const { year, month } = civilDateIn(at, timeZone);
  const startYear = month >= 4 ? year : year - 1;
  const endShort = String((startYear + 1) % 100).padStart(2, '0');
  return `${String(startYear)}-${endShort}`;
}

/** The calendar date in a given zone, which is what "today" means to a hospital. */
export function civilDateIn(at: Date, timeZone: string): { year: number; month: number; day: number } {
  // `en-CA` renders as YYYY-MM-DD, which parses without locale ambiguity.
  const formatted = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
  const [y, m, d] = formatted.split('-');
  if (y === undefined || m === undefined || d === undefined) {
    throw new PatternError(`could not read a civil date in time zone "${timeZone}"`);
  }
  return { year: Number(y), month: Number(m), day: Number(d) };
}

/** The tokens a pattern actually uses, so a caller can check its context first. */
export function tokensIn(pattern: string): readonly PatternToken[] {
  const found = new Set<PatternToken>();
  for (const match of pattern.matchAll(TOKEN_RE)) {
    found.add(match[1] as PatternToken);
  }
  return [...found];
}

/**
 * Renders `pattern` for `sequence`.
 *
 * A missing substitution throws rather than rendering an empty span: a UHID of
 * `00000042` where `BLR00000042` was meant is not a formatting blemish, it is a
 * different patient's identifier, and it would be discovered only when two
 * branches collide.
 */
export function formatNumber(pattern: string, sequence: bigint, ctx: PatternContext): string {
  if (sequence < 0n) throw new PatternError('sequence must not be negative');

  const date = civilDateIn(ctx.at, ctx.timeZone);
  let sawSequence = false;

  const rendered = pattern.replace(TOKEN_RE, (_whole, rawToken: string, rawWidth?: string) => {
    const token = rawToken as PatternToken;
    switch (token) {
      case 'SEQ': {
        sawSequence = true;
        const width = rawWidth === undefined ? 0 : Number(rawWidth);
        const digits = sequence.toString(10);
        if (digits.length > width && width > 0) {
          // Silently widening would break every downstream fixed-width parser
          // and print template; the series needs a new pattern, deliberately.
          throw new PatternError(`sequence ${digits} exceeds the ${String(width)} digits the pattern allows`);
        }
        return digits.padStart(width, '0');
      }
      case 'BR':
        return required(ctx.branchCode, 'BR', pattern);
      case 'HOSP':
        return required(ctx.hospitalCode, 'HOSP', pattern);
      case 'FY':
        return required(ctx.fy, 'FY', pattern);
      case 'YYYY':
        return String(date.year);
      case 'YY':
        return String(date.year % 100).padStart(2, '0');
      case 'MM':
        return String(date.month).padStart(2, '0');
      case 'DD':
        return String(date.day).padStart(2, '0');
      default:
        throw new PatternError(`unknown token {${String(token)}}`);
    }
  });

  if (!sawSequence) {
    // Without {SEQ} every allocation renders identically, so the "identifier"
    // identifies nothing while looking perfectly well-formed.
    throw new PatternError(`pattern "${pattern}" has no {SEQ} token`);
  }
  return rendered;
}

function required(value: string | undefined, token: PatternToken, pattern: string): string {
  if (value === undefined || value === '') {
    throw new PatternError(`pattern "${pattern}" needs {${token}} but none was supplied`);
  }
  return value;
}
