/**
 * Translation-coverage analysis — the engine behind `pnpm --filter @vims/i18n
 * coverage:check`.
 *
 * `docs/06 §8`: "Untranslated keys fall back to `en-IN` and are reported by a CI
 * coverage check (fail below 100 % for P0 clinical screens in the hospital's
 * enabled locales)."
 *
 * The check is deliberately *honest* rather than merely green:
 *
 *  - Every locale is measured against `en-IN`, which is the reference.
 *  - A locale that is still being translated is allowed to be partial **only if
 *    it is named in `PARTIAL_LOCALE_ALLOWLIST` with a reason**, and its shortfall
 *    is still printed on every run.
 *  - `CRITICAL_KEYS` must be 100 % in *every* locale, allowlisted or not. These
 *    are the strings a user sees when everything else has already gone wrong —
 *    falling back to English in the middle of a failure is exactly when a nurse
 *    is least able to read it.
 *  - Extra keys (a typo, or a key deleted from `en-IN` and left behind) and
 *    string/object shape mismatches are always failures.
 */

import type { MessageTree } from './catalogues.js';
import { DEFAULT_LOCALE, LOCALE_CODES, type LocaleCode } from './locales.js';

/**
 * Locales permitted to be incomplete today, each with the reason it is on the
 * list. Removing a locale from this map is how a translation delivery is
 * "locked in": the check then fails if it ever regresses.
 */
export const PARTIAL_LOCALE_ALLOWLIST: ReadonlyMap<LocaleCode, string> = new Map([
  ['ta', 'Phase 0 scaffold — full catalogue lands with the Tamil clinical review.'],
  ['te', 'Phase 0 scaffold — awaiting translation vendor.'],
  ['ml', 'Phase 0 scaffold — awaiting translation vendor.'],
  ['kn', 'Phase 0 scaffold — awaiting translation vendor.'],
  ['mr', 'Phase 0 scaffold — awaiting translation vendor.'],
  ['bn', 'Phase 0 scaffold — awaiting translation vendor.'],
  ['gu', 'Phase 0 scaffold — awaiting translation vendor.'],
  ['or', 'Phase 0 scaffold — awaiting translation vendor.'],
  ['pa', 'Phase 0 scaffold — awaiting translation vendor.'],
  ['ar', 'Phase 0 scaffold — RTL layout verified, copy pending Gulf deployment.'],
]);

/**
 * Keys that must exist in every locale. Prefixes end with `.` and match a whole
 * namespace; exact keys have no trailing dot.
 */
export const CRITICAL_KEY_PREFIXES: readonly string[] = Object.freeze(['errors.']);

export const CRITICAL_KEYS: readonly string[] = Object.freeze([
  'common.actions.cancel',
  'common.actions.confirm',
]);

export function isCriticalKey(key: string): boolean {
  return CRITICAL_KEYS.includes(key) || CRITICAL_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** `{ a: { b: 'x' } }` → `Map { 'a.b' => 'x' }`. */
export function flattenMessages(tree: MessageTree, prefix = ''): Map<string, string> {
  const flat = new Map<string, string>();
  for (const [segment, value] of Object.entries(tree)) {
    const key = prefix.length > 0 ? `${prefix}.${segment}` : segment;
    if (typeof value === 'string') {
      flat.set(key, value);
    } else {
      for (const [nested, nestedValue] of flattenMessages(value, key)) {
        flat.set(nested, nestedValue);
      }
    }
  }
  return flat;
}

/** Every path in the tree, string leaves *and* branches, used for shape checks. */
function collectShape(tree: MessageTree, prefix = ''): Map<string, 'string' | 'object'> {
  const shape = new Map<string, 'string' | 'object'>();
  for (const [segment, value] of Object.entries(tree)) {
    const key = prefix.length > 0 ? `${prefix}.${segment}` : segment;
    if (typeof value === 'string') {
      shape.set(key, 'string');
    } else {
      shape.set(key, 'object');
      for (const [nested, kind] of collectShape(value, key)) {
        shape.set(nested, kind);
      }
    }
  }
  return shape;
}

export interface LocaleCoverage {
  readonly locale: LocaleCode;
  readonly total: number;
  readonly translated: number;
  readonly percent: number;
  readonly missing: readonly string[];
  readonly criticalMissing: readonly string[];
  /** Keys present here but not in `en-IN` — a typo or a stale key. */
  readonly extra: readonly string[];
  /** A key that is a string in one catalogue and an object in the other. */
  readonly shapeMismatch: readonly string[];
  /** Placeholders used by `en-IN` but absent from the translation. */
  readonly placeholderMismatch: readonly string[];
  readonly allowedPartial: boolean;
  readonly allowanceReason: string | null;
  readonly failures: readonly string[];
}

export interface CoverageReport {
  readonly reference: LocaleCode;
  readonly referenceKeyCount: number;
  readonly locales: readonly LocaleCoverage[];
  readonly ok: boolean;
  readonly failures: readonly string[];
  /** Allowlisted locales that are now complete — the allowlist entry can go. */
  readonly staleAllowances: readonly LocaleCode[];
}

const PLACEHOLDER = /\{(\w+)\}/g;

function placeholders(template: string): Set<string> {
  const found = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER)) {
    const name = match[1];
    if (name !== undefined) found.add(name);
  }
  return found;
}

export interface CoverageInput {
  /** Every locale in the superset must be present, `en-IN` included. */
  readonly catalogues: ReadonlyMap<LocaleCode, MessageTree>;
}

export function computeCoverage(input: CoverageInput): CoverageReport {
  const reference = input.catalogues.get(DEFAULT_LOCALE);
  if (reference === undefined) {
    return {
      reference: DEFAULT_LOCALE,
      referenceKeyCount: 0,
      locales: [],
      ok: false,
      failures: [`Reference catalogue "${DEFAULT_LOCALE}" is missing.`],
      staleAllowances: [],
    };
  }

  const referenceFlat = flattenMessages(reference);
  const referenceShape = collectShape(reference);
  const locales: LocaleCoverage[] = [];
  const failures: string[] = [];
  const staleAllowances: LocaleCode[] = [];

  for (const locale of LOCALE_CODES) {
    const tree = input.catalogues.get(locale);
    if (tree === undefined) {
      failures.push(`${locale}: catalogue file is missing.`);
      continue;
    }
    const flat = flattenMessages(tree);
    const shape = collectShape(tree);

    const missing: string[] = [];
    const placeholderMismatch: string[] = [];
    for (const [key, referenceValue] of referenceFlat) {
      const value = flat.get(key);
      if (value === undefined) {
        missing.push(key);
        continue;
      }
      const expected = placeholders(referenceValue);
      const actual = placeholders(value);
      for (const name of expected) {
        if (!actual.has(name)) {
          placeholderMismatch.push(`${key} (missing {${name}})`);
        }
      }
    }

    const extra = [...flat.keys()].filter((key) => !referenceFlat.has(key)).sort();
    const shapeMismatch = [...shape.entries()]
      .filter(([key, kind]) => {
        const referenceKind = referenceShape.get(key);
        return referenceKind !== undefined && referenceKind !== kind;
      })
      .map(([key]) => key)
      .sort();

    const criticalMissing = missing.filter(isCriticalKey);
    const allowanceReason = PARTIAL_LOCALE_ALLOWLIST.get(locale) ?? null;
    const allowedPartial = allowanceReason !== null;
    const translated = referenceFlat.size - missing.length;

    const localeFailures: string[] = [];
    if (criticalMissing.length > 0) {
      localeFailures.push(
        `${locale}: ${criticalMissing.length} critical key(s) missing — these must exist in every locale: ${criticalMissing.join(', ')}`,
      );
    }
    if (extra.length > 0) {
      localeFailures.push(
        `${locale}: ${extra.length} key(s) not present in ${DEFAULT_LOCALE}: ${extra.join(', ')}`,
      );
    }
    if (shapeMismatch.length > 0) {
      localeFailures.push(`${locale}: shape differs from ${DEFAULT_LOCALE} at ${shapeMismatch.join(', ')}`);
    }
    if (placeholderMismatch.length > 0) {
      localeFailures.push(
        `${locale}: placeholder(s) dropped in translation: ${placeholderMismatch.join(', ')}`,
      );
    }
    if (missing.length > 0 && !allowedPartial) {
      localeFailures.push(
        `${locale}: ${missing.length} key(s) missing and the locale is not in PARTIAL_LOCALE_ALLOWLIST.`,
      );
    }
    if (missing.length === 0 && allowedPartial && locale !== DEFAULT_LOCALE) {
      staleAllowances.push(locale);
    }

    failures.push(...localeFailures);
    locales.push({
      locale,
      total: referenceFlat.size,
      translated,
      percent: referenceFlat.size === 0 ? 100 : Math.round((translated / referenceFlat.size) * 1000) / 10,
      missing: missing.sort(),
      criticalMissing: criticalMissing.sort(),
      extra,
      shapeMismatch,
      placeholderMismatch: placeholderMismatch.sort(),
      allowedPartial,
      allowanceReason,
      failures: localeFailures,
    });
  }

  return {
    reference: DEFAULT_LOCALE,
    referenceKeyCount: referenceFlat.size,
    locales,
    ok: failures.length === 0,
    failures,
    staleAllowances,
  };
}

function bar(percent: number): string {
  const filled = Math.round(percent / 5);
  return `${'█'.repeat(filled)}${'·'.repeat(20 - filled)}`;
}

/**
 * Human-readable summary. Printed on every run, pass or fail.
 * `extraFailures` carries problems found outside the catalogues themselves
 * (a stray file, invalid JSON) so that one verdict line covers everything.
 */
export function formatCoverageReport(report: CoverageReport, extraFailures: readonly string[] = []): string {
  const lines: string[] = [];
  lines.push(
    `@vims/i18n translation coverage — reference ${report.reference} (${report.referenceKeyCount} keys)`,
  );
  lines.push('');
  for (const locale of report.locales) {
    const flag =
      locale.locale === report.reference
        ? 'reference'
        : locale.allowedPartial
          ? 'partial (allowed)'
          : 'required complete';
    lines.push(
      `  ${locale.locale.padEnd(6)} ${bar(locale.percent)} ${String(locale.percent).padStart(5)}%  ${String(locale.translated).padStart(3)}/${locale.total}  ${flag}`,
    );
    if (locale.missing.length > 0) {
      const preview = locale.missing.slice(0, 5).join(', ');
      const more = locale.missing.length > 5 ? `, +${locale.missing.length - 5} more` : '';
      lines.push(`         missing: ${preview}${more}`);
    }
  }
  lines.push('');
  if (report.staleAllowances.length > 0) {
    lines.push(
      `  note: ${report.staleAllowances.join(', ')} now complete — remove from PARTIAL_LOCALE_ALLOWLIST to lock it in.`,
    );
    lines.push('');
  }
  const allFailures = [...report.failures, ...extraFailures];
  if (allFailures.length === 0) {
    lines.push(
      '  PASS — every locale is structurally valid, critical keys are complete, and gaps are declared.',
    );
  } else {
    lines.push(`  FAIL — ${allFailures.length} problem(s):`);
    for (const failure of allFailures) {
      lines.push(`    · ${failure}`);
    }
  }
  return lines.join('\n');
}
