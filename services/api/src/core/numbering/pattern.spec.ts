import { describe, expect, it } from 'vitest';
import { PatternError, financialYearOf, formatNumber, tokensIn } from './pattern.js';

const IST = 'Asia/Kolkata';
const at = new Date('2026-08-21T09:30:00.000Z');

describe('financialYearOf', () => {
  /**
   * The gapless invoice series reset on this boundary. A day either side and a
   * receipt series restarts mid-year, so two receipts carry the same number in
   * the same FY — which is exactly what gapless numbering exists to prevent.
   */
  it('starts the year on 1 April in the hospital time zone', () => {
    expect(financialYearOf(new Date('2026-03-31T18:29:59.000Z'), IST)).toBe('2025-26');
    // 18:30 UTC is 00:00 IST on 1 April — the first instant of the new FY.
    expect(financialYearOf(new Date('2026-03-31T18:30:00.000Z'), IST)).toBe('2026-27');
  });

  it('is computed in the hospital zone, not the server zone', () => {
    // 31 March 20:00 UTC is already 1 April in India. A server in UTC would
    // still call this 2025-26 and issue a receipt in the closed year.
    const instant = new Date('2026-03-31T20:00:00.000Z');
    expect(financialYearOf(instant, IST)).toBe('2026-27');
    expect(financialYearOf(instant, 'UTC')).toBe('2025-26');
  });

  it('writes the second half as two digits, including across a century', () => {
    expect(financialYearOf(new Date('2099-06-01T00:00:00.000Z'), IST)).toBe('2099-00');
  });
});

describe('formatNumber', () => {
  it('renders the seeded UHID and receipt patterns', () => {
    expect(formatNumber('{BR}{SEQ:8}', 42n, { branchCode: 'BLR', at, timeZone: IST })).toBe('BLR00000042');
    expect(
      formatNumber('{BR}/RCP/{FY}/{SEQ:6}', 7n, {
        branchCode: 'MYS',
        fy: '2026-27',
        at,
        timeZone: IST,
      }),
    ).toBe('MYS/RCP/2026-27/000007');
  });

  /**
   * Rendering an empty span for a missing branch code would turn `BLR00000042`
   * into `00000042` — not a blemish but a different patient's identifier, and
   * one that collides silently with the other branch's series.
   */
  it('refuses to render a token it has no value for', () => {
    expect(() => formatNumber('{BR}{SEQ:8}', 1n, { at, timeZone: IST })).toThrow(PatternError);
    expect(() => formatNumber('{BR}/RCP/{FY}/{SEQ:6}', 1n, { branchCode: 'BLR', at, timeZone: IST })).toThrow(
      /FY/,
    );
  });

  /**
   * Overflow must stop the allocation. Widening the field silently breaks every
   * fixed-width print template and downstream parser that was built to the
   * documented pattern; the series needs a new pattern, chosen deliberately.
   */
  it('refuses to overflow the declared width', () => {
    expect(formatNumber('{BR}{SEQ:3}', 999n, { branchCode: 'BLR', at, timeZone: IST })).toBe('BLR999');
    expect(() => formatNumber('{BR}{SEQ:3}', 1000n, { branchCode: 'BLR', at, timeZone: IST })).toThrow(
      /exceeds the 3 digits/,
    );
  });

  it('refuses a pattern with no sequence at all', () => {
    // Every allocation would render identically: an identifier that identifies
    // nothing while looking perfectly well-formed.
    expect(() =>
      formatNumber('{BR}/RCP/{FY}', 1n, { branchCode: 'BLR', fy: '2026-27', at, timeZone: IST }),
    ).toThrow(/no \{SEQ\}/);
  });

  it('renders date tokens in the hospital zone', () => {
    // 20:00 UTC on 20 August is already the 21st in India.
    const instant = new Date('2026-08-20T20:00:00.000Z');
    expect(formatNumber('{YYYY}{MM}{DD}-{SEQ:4}', 5n, { at: instant, timeZone: IST })).toBe('20260821-0005');
    expect(formatNumber('{YYYY}{MM}{DD}-{SEQ:4}', 5n, { at: instant, timeZone: 'UTC' })).toBe(
      '20260820-0005',
    );
  });

  it('reports the tokens a pattern needs', () => {
    expect(tokensIn('{BR}/RCP/{FY}/{SEQ:6}').toSorted()).toEqual(['BR', 'FY', 'SEQ']);
  });
});
