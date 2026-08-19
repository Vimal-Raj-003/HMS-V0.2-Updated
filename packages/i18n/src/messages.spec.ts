import { describe, expect, it } from 'vitest';

import { getRawCatalogue } from './catalogues.js';
import { LOCALE_CODES } from './locales.js';
import {
  createTranslator,
  getMessages,
  hasOwnTranslation,
  interpolate,
  resolveMessage,
  translate,
} from './messages.js';
import { flattenMessages } from './coverage.js';

describe('en-IN fallback', () => {
  it('returns the locale string when the locale has one', () => {
    expect(translate('hi', 'errors.forbidden')).toBe('आपको यह करने की अनुमति नहीं है');
    expect(resolveMessage('hi', 'errors.forbidden')?.fellBack).toBe(false);
  });

  it('falls back to en-IN for a key the locale has not translated yet', () => {
    // `ta` is an allowlisted partial catalogue: it has no `nav.admin`.
    expect(hasOwnTranslation('ta', 'nav.admin')).toBe(false);
    expect(translate('ta', 'nav.admin')).toBe('Administration');

    const resolution = resolveMessage('ta', 'nav.admin');
    expect(resolution).toBeDefined();
    expect(resolution?.resolvedFrom).toBe('en-IN');
    expect(resolution?.fellBack).toBe(true);
  });

  it('never renders a raw key for any key that exists in en-IN, in any locale', () => {
    const referenceKeys = [...flattenMessages(getRawCatalogue('en-IN')).keys()];
    for (const locale of LOCALE_CODES) {
      for (const key of referenceKeys) {
        const value = translate(locale, key);
        expect(value, `${locale}:${key}`).not.toBe(key);
        expect(value.length, `${locale}:${key}`).toBeGreaterThan(0);
      }
    }
  });

  it('reports an unknown key as the key itself rather than an empty label', () => {
    expect(translate('hi', 'nav.doesNotExist')).toBe('nav.doesNotExist');
    expect(resolveMessage('en-IN', 'nav.doesNotExist')).toBeUndefined();
  });

  it('does not treat a namespace as a translatable leaf', () => {
    expect(resolveMessage('en-IN', 'nav')).toBeUndefined();
    expect(resolveMessage('en-IN', 'nav.admin.deeper')).toBeUndefined();
  });
});

describe('getMessages (what next-intl receives)', () => {
  it('is structurally complete for every locale, so next-intl never misses a key', () => {
    const referenceKeys = [...flattenMessages(getRawCatalogue('en-IN')).keys()].sort();
    for (const locale of LOCALE_CODES) {
      const merged = [...flattenMessages(getMessages(locale)).keys()].sort();
      expect(merged, locale).toEqual(referenceKeys);
    }
  });

  it('prefers the locale string over the reference where one exists', () => {
    const merged = getMessages('hi');
    const errors = merged['errors'];
    expect(typeof errors).toBe('object');
    expect(flattenMessages(getMessages('hi')).get('errors.network')).toBe('अस्पताल सर्वर से कनेक्शन नहीं है');
    expect(flattenMessages(getMessages('ta')).get('nav.admin')).toBe('Administration');
  });

  it('does not mutate the reference catalogue when merging', () => {
    getMessages('ar');
    expect(flattenMessages(getRawCatalogue('en-IN')).get('errors.network')).toBe(
      'No connection to the hospital server',
    );
  });

  it('returns a cached instance on repeat calls', () => {
    expect(getMessages('bn')).toBe(getMessages('bn'));
  });
});

describe('interpolation', () => {
  it('substitutes named placeholders', () => {
    expect(translate('en-IN', 'common.state.saved', { time: '14:03' })).toBe('Saved at 14:03');
    expect(translate('en-IN', 'common.units.itemCount', { count: 68 })).toBe('68 items');
  });

  it('leaves an unsupplied placeholder verbatim rather than throwing mid-document', () => {
    expect(translate('en-IN', 'common.state.saved')).toBe('Saved at {time}');
    expect(interpolate('{a} and {b}', { a: 'x' })).toBe('x and {b}');
  });

  it('keeps placeholders intact in translations (hi carries {time})', () => {
    expect(translate('hi', 'common.state.saved', { time: '१४:०३' })).toContain('१४:०३');
  });
});

describe('createTranslator', () => {
  it('binds a locale', () => {
    const t = createTranslator('ar');
    expect(t('errors.forbidden')).toBe('ليس لديك إذن للقيام بذلك');
    expect(t('nav.admin')).toBe('Administration');
  });
});
