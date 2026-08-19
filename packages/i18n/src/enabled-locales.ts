/**
 * Per-hospital locale configuration.
 *
 * `@vims/contracts` owns the two settings (`ui.locale_default`,
 * `ui.enabled_locales`); this module owns the *rule* that makes them safe:
 *
 *   **`en-IN` is always enabled and can never be removed.**
 *
 * It is the fallback catalogue. A hospital that switched it off would be one
 * untranslated key away from a blank button on a consent form, so the resolver
 * silently re-adds it rather than offering an option to break the system.
 */

import { z } from 'zod';

import { DEFAULT_LOCALE, I18nError, LOCALE_CODES, isLocaleCode, type LocaleCode } from './locales.js';

export const localeCodeSchema = z.enum(LOCALE_CODES);

/** Matches `ui.enabled_locales` in `@vims/contracts`. */
export const enabledLocalesSchema = z.array(localeCodeSchema).min(1);

export interface HospitalLocaleConfig {
  /** What a user sees before they choose. Always a member of `enabledLocales`. */
  readonly defaultLocale: LocaleCode;
  /** Registry order, `en-IN` first, de-duplicated. */
  readonly enabledLocales: readonly LocaleCode[];
}

export interface HospitalLocaleInput {
  readonly defaultLocale?: string | undefined;
  readonly enabledLocales?: readonly string[] | undefined;
}

/**
 * Turn whatever the settings table holds into a usable configuration.
 * Unknown codes are a configuration bug, not something to paper over, so they
 * throw — the settings schema in `@vims/contracts` already rejects them at write
 * time and a value that got past it means the row was edited by hand.
 */
export function resolveHospitalLocales(input?: HospitalLocaleInput): HospitalLocaleConfig {
  const requested = input?.enabledLocales ?? [DEFAULT_LOCALE];
  for (const code of requested) {
    if (!isLocaleCode(code)) {
      throw new I18nError(
        `Unsupported locale ${JSON.stringify(code)} in ui.enabled_locales. Superset (D-13): ${LOCALE_CODES.join(', ')}.`,
      );
    }
  }
  const wanted = new Set<LocaleCode>(requested.filter(isLocaleCode));
  // The rule: en-IN is not optional.
  wanted.add(DEFAULT_LOCALE);
  const enabledLocales = LOCALE_CODES.filter((code) => wanted.has(code));

  const requestedDefault = input?.defaultLocale;
  if (requestedDefault !== undefined && !isLocaleCode(requestedDefault)) {
    throw new I18nError(`Unsupported locale ${JSON.stringify(requestedDefault)} in ui.locale_default.`);
  }
  const defaultLocale =
    requestedDefault !== undefined && wanted.has(requestedDefault) ? requestedDefault : DEFAULT_LOCALE;

  return { defaultLocale, enabledLocales };
}

export function isLocaleEnabled(config: HospitalLocaleConfig, locale: LocaleCode): boolean {
  return config.enabledLocales.includes(locale);
}

/**
 * Guard for the admin console: reject an attempt to disable `en-IN` loudly
 * instead of quietly re-adding it, so the administrator learns why.
 */
export function assertLocaleRemovable(locale: LocaleCode): void {
  if (locale === DEFAULT_LOCALE) {
    throw new I18nError(
      '`en-IN` is the fallback catalogue and cannot be disabled (CLAUDE.md §4, docs/06 §8).',
    );
  }
}

/**
 * Pick the locale for a request: the user's preference if the hospital enables
 * it, otherwise the hospital default, otherwise `en-IN`. Never throws — a stale
 * cookie must not block a login.
 */
export function pickLocale(config: HospitalLocaleConfig, preferred?: string): LocaleCode {
  if (isLocaleCode(preferred) && isLocaleEnabled(config, preferred)) return preferred;
  return isLocaleEnabled(config, config.defaultLocale) ? config.defaultLocale : DEFAULT_LOCALE;
}
