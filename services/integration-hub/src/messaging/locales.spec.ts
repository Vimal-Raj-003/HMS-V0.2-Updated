import { DEFAULT_LOCALE, LOCALE_CODES } from '@vims/i18n';
import { describe, expect, it } from 'vitest';
import { MESSAGING_DEFAULT_LOCALE, MESSAGING_LOCALE_CODES, isMessagingLocale } from './locales.js';

/**
 * The conformance test that makes the duplication in `locales.ts` safe.
 *
 * `@vims/i18n` ships TypeScript only, so a compiled service cannot import it —
 * see `locales.ts` for the whole reasoning. This suite runs under vitest, where
 * TypeScript resolution works, and imports the real package. If someone adds a
 * locale to D-13 and not here, or reorders the picker, or changes the fallback,
 * this fails. That is the entire point: the duplication is allowed to exist
 * because drift is impossible to commit.
 */
describe('the messaging locale list conforms to @vims/i18n (D-13)', () => {
  it('has exactly the same codes in exactly the same order', () => {
    expect([...MESSAGING_LOCALE_CODES]).toEqual([...LOCALE_CODES]);
  });

  it('has the same fallback, which nothing may turn off', () => {
    expect(MESSAGING_DEFAULT_LOCALE).toBe(DEFAULT_LOCALE);
    expect(MESSAGING_DEFAULT_LOCALE).toBe('en-IN');
  });

  it('recognises every D-13 locale and nothing else', () => {
    for (const code of LOCALE_CODES) expect(isMessagingLocale(code)).toBe(true);
    expect(isMessagingLocale('fr')).toBe(false);
    expect(isMessagingLocale('en')).toBe(false);
    expect(isMessagingLocale(undefined)).toBe(false);
  });
});
