import { describe, expect, it } from 'vitest';

import { getRawCatalogue, type MessageTree } from './catalogues.js';
import {
  CRITICAL_KEYS,
  PARTIAL_LOCALE_ALLOWLIST,
  computeCoverage,
  flattenMessages,
  formatCoverageReport,
  isCriticalKey,
} from './coverage.js';
import { LOCALE_CODES, type LocaleCode } from './locales.js';

function shippedCatalogues(): Map<LocaleCode, MessageTree> {
  return new Map(LOCALE_CODES.map((code) => [code, getRawCatalogue(code)] as const));
}

describe('flattenMessages', () => {
  it('produces dot-joined keys', () => {
    const flat = flattenMessages({ a: { b: 'x', c: { d: 'y' } }, e: 'z' });
    expect([...flat.entries()].sort()).toEqual([
      ['a.b', 'x'],
      ['a.c.d', 'y'],
      ['e', 'z'],
    ]);
  });
});

describe('the shipped catalogues', () => {
  const report = computeCoverage({ catalogues: shippedCatalogues() });

  it('passes the coverage check as shipped', () => {
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('treats en-IN as the complete reference', () => {
    const reference = report.locales.find((entry) => entry.locale === 'en-IN');
    expect(reference?.percent).toBe(100);
    expect(reference?.missing).toEqual([]);
    expect(report.referenceKeyCount).toBeGreaterThan(50);
  });

  it('has hi complete — it is not on the partial allowlist', () => {
    expect(PARTIAL_LOCALE_ALLOWLIST.has('hi')).toBe(false);
    const hi = report.locales.find((entry) => entry.locale === 'hi');
    expect(hi?.missing).toEqual([]);
    expect(hi?.percent).toBe(100);
  });

  it('has every critical key in every locale, including the partial ones', () => {
    for (const entry of report.locales) {
      expect(entry.criticalMissing, entry.locale).toEqual([]);
    }
    for (const locale of LOCALE_CODES) {
      const flat = flattenMessages(getRawCatalogue(locale));
      for (const key of CRITICAL_KEYS) {
        expect(flat.has(key), `${locale}:${key}`).toBe(true);
      }
      for (const key of [...flattenMessages(getRawCatalogue('en-IN')).keys()].filter(isCriticalKey)) {
        expect(flat.has(key), `${locale}:${key}`).toBe(true);
      }
    }
  });

  it('declares every incomplete locale on the allowlist with a reason', () => {
    for (const entry of report.locales) {
      if (entry.missing.length > 0) {
        expect(entry.allowedPartial, entry.locale).toBe(true);
        expect(entry.allowanceReason ?? '', entry.locale).not.toBe('');
      }
    }
  });

  it('prints a report that names the gaps', () => {
    const text = formatCoverageReport(report);
    expect(text).toContain('translation coverage');
    expect(text).toContain('PASS');
    expect(text).toContain('partial (allowed)');
  });
});

describe('the check is honest — it fails on real problems', () => {
  const reference = getRawCatalogue('en-IN');

  function withOverride(locale: LocaleCode, tree: MessageTree): Map<LocaleCode, MessageTree> {
    const catalogues = shippedCatalogues();
    catalogues.set(locale, tree);
    return catalogues;
  }

  it('fails when a critical key is missing, even from an allowlisted locale', () => {
    const broken: MessageTree = { ...getRawCatalogue('ta'), errors: { forbidden: 'x' } };
    const report = computeCoverage({ catalogues: withOverride('ta', broken) });
    expect(report.ok).toBe(false);
    expect(report.failures.join('\n')).toMatch(/ta: \d+ critical key\(s\) missing/);
  });

  it('fails a non-allowlisted locale that is merely incomplete', () => {
    const broken: MessageTree = { ...getRawCatalogue('hi'), nav: { admin: 'प्रशासन' } };
    const report = computeCoverage({ catalogues: withOverride('hi', broken) });
    expect(report.ok).toBe(false);
    expect(report.failures.join('\n')).toContain('not in PARTIAL_LOCALE_ALLOWLIST');
  });

  it('fails on a key that does not exist in en-IN (a typo or a stale key)', () => {
    const broken: MessageTree = {
      ...getRawCatalogue('hi'),
      nav: { ...(getRawCatalogue('hi')['nav'] as MessageTree), adminn: 'प्रशासन' },
    };
    const report = computeCoverage({ catalogues: withOverride('hi', broken) });
    expect(report.ok).toBe(false);
    expect(report.failures.join('\n')).toContain('nav.adminn');
  });

  it('fails when a translation drops a placeholder', () => {
    const flatHi = getRawCatalogue('hi');
    const common = flatHi['common'] as MessageTree;
    const broken: MessageTree = {
      ...flatHi,
      common: { ...common, state: { ...(common['state'] as MessageTree), saved: 'सहेजा गया' } },
    };
    const report = computeCoverage({ catalogues: withOverride('hi', broken) });
    expect(report.ok).toBe(false);
    expect(report.failures.join('\n')).toContain('common.state.saved (missing {time})');
  });

  it('fails when a leaf becomes a namespace', () => {
    const broken: MessageTree = {
      ...getRawCatalogue('hi'),
      errors: { ...(getRawCatalogue('hi')['errors'] as MessageTree), network: { deep: 'x' } },
    };
    const report = computeCoverage({ catalogues: withOverride('hi', broken) });
    expect(report.ok).toBe(false);
    expect(report.failures.join('\n')).toContain('shape differs');
  });

  it('fails when a catalogue file is missing entirely', () => {
    const catalogues = shippedCatalogues();
    catalogues.delete('or');
    const report = computeCoverage({ catalogues });
    expect(report.ok).toBe(false);
    expect(report.failures.join('\n')).toContain('or: catalogue file is missing');
  });

  it('fails when the reference itself is missing', () => {
    const report = computeCoverage({ catalogues: new Map() });
    expect(report.ok).toBe(false);
    expect(report.failures.join('\n')).toContain('Reference catalogue');
  });

  it('reports an allowlisted locale that has become complete, so the entry can be removed', () => {
    const report = computeCoverage({ catalogues: withOverride('ar', reference) });
    expect(report.staleAllowances).toContain('ar');
    expect(formatCoverageReport(report)).toContain('remove from PARTIAL_LOCALE_ALLOWLIST');
  });
});
