/**
 * Non-colour tokens — `docs/06-ui-ux-design-system.md` §3.6 (typography) and §3.7
 * (spacing, radii, elevation, motion, z-index), plus §4.3 breakpoints and §6.3 density.
 *
 * These are theme-independent: only the colour maps in `themes.ts` change per theme
 * (elevation collapses on dark, which is handled in the generated CSS).
 */

/** §3.6 — font stacks. Self-hosted woff2, subset per locale, `font-display: swap`. */
export const fontFamilies = {
  '--font-ui': '"Inter var", Inter, system-ui, -apple-system, "Segoe UI", sans-serif',
  '--font-display':
    '"JetBrains Mono", "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
  '--font-mono': '"JetBrains Mono", "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
  '--font-indic':
    '"Noto Sans Devanagari", "Noto Sans Tamil", "Noto Sans Telugu", "Noto Sans Malayalam", "Noto Sans Kannada", "Noto Sans Bengali", "Noto Sans Gujarati", "Noto Sans Gurmukhi", "Noto Sans Oriya"',
  '--font-arabic': '"Noto Sans Arabic", "Noto Kufi Arabic", sans-serif',
} as const;

export interface FontSize {
  readonly size: string;
  readonly lineHeight: string;
  /** What the step is for — kept next to the value so nobody guesses. */
  readonly use: string;
}

/** §3.6 — the type scale. `md` (14/20) is the body default. */
export const fontSizes: Readonly<Record<string, FontSize>> = {
  '3xs': { size: '10px', lineHeight: '14px', use: 'dense meta & print footers' },
  '2xs': { size: '11px', lineHeight: '16px', use: 'chips & axis labels' },
  xs: { size: '12px', lineHeight: '16px', use: 'dense table body & helper text' },
  sm: { size: '13px', lineHeight: '18px', use: 'default table body' },
  md: { size: '14px', lineHeight: '20px', use: 'body default — inputs, nav, buttons' },
  lg: { size: '16px', lineHeight: '24px', use: 'tablet inputs & dialog body' },
  xl: { size: '18px', lineHeight: '26px', use: 'section headings & banner patient name' },
  '2xl': { size: '20px', lineHeight: '28px', use: 'page title' },
  '3xl': { size: '24px', lineHeight: '32px', use: 'card value' },
  '4xl': { size: '30px', lineHeight: '38px', use: 'KPI value' },
  '5xl': { size: '36px', lineHeight: '44px', use: 'KPI hero & kiosk heading' },
  '6xl': { size: '48px', lineHeight: '56px', use: 'kiosk primary action' },
  'display-1': { size: '64px', lineHeight: '68px', use: 'dark dashboard hero (mono)' },
  'display-2': { size: '88px', lineHeight: '92px', use: 'command-centre hero (mono)' },
  'tv-body': { size: '32px', lineHeight: '42px', use: 'TV body, min 28px @1080p (EN-018)' },
  'tv-token': { size: '180px', lineHeight: '1', use: 'TV token digits @1080p, mono 600' },
};

/** §3.6 — weights. Never 300: it fails legibility on cheap ward monitors. */
export const fontWeights = {
  '--fw-body': '400',
  '--fw-label': '500',
  '--fw-heading': '600',
  '--fw-numeral-alert': '700',
} as const;

export const letterSpacings = {
  '--ls-display': '-0.01em',
  '--ls-eyebrow': '0.08em',
  '--ls-normal': '0',
} as const;

/** §3.7 — 4 px base spacing scale. */
export const spacing: Readonly<Record<string, string>> = {
  '0': '0px',
  '0.5': '2px',
  '1': '4px',
  '1.5': '6px',
  '2': '8px',
  '3': '12px',
  '4': '16px',
  '5': '20px',
  '6': '24px',
  '8': '32px',
  '10': '40px',
  '12': '48px',
  '16': '64px',
  '20': '80px',
  '24': '96px',
};

/** §3.7 — radii. `md` is the default. */
export const radii: Readonly<Record<string, string>> = {
  xs: '2px',
  sm: '4px',
  md: '6px',
  lg: '8px',
  xl: '12px',
  '2xl': '16px',
  full: '9999px',
};

/**
 * §3.7 — elevation, light theme only. On dark the stack is expressed by layers +
 * hairlines, so `--e-1..3` collapse to `none` (see the generated dark block); only
 * dialogs and the critical alert keep a shadow.
 */
export const elevation: Readonly<Record<string, string>> = {
  '1': '0 1px 2px rgb(16 24 40 / 0.06), 0 1px 3px rgb(16 24 40 / 0.10)',
  '2': '0 2px 4px -2px rgb(16 24 40 / 0.06), 0 4px 8px -2px rgb(16 24 40 / 0.10)',
  '3': '0 4px 6px -2px rgb(16 24 40 / 0.03), 0 12px 16px -4px rgb(16 24 40 / 0.08)',
  '4': '0 8px 8px -4px rgb(16 24 40 / 0.04), 0 20px 24px -4px rgb(16 24 40 / 0.10)',
  '5': '0 12px 16px -4px rgb(16 24 40 / 0.08), 0 32px 40px -8px rgb(16 24 40 / 0.16)',
};

/** §3.7 — motion. `prefers-reduced-motion` collapses every duration to 1 ms. */
export const durations: Readonly<Record<string, string>> = {
  instant: '0ms',
  fast: '120ms',
  base: '180ms',
  slow: '240ms',
  deliberate: '320ms',
  tv: '400ms',
};

export const easings: Readonly<Record<string, string>> = {
  standard: 'cubic-bezier(0.2, 0, 0, 1)',
  decel: 'cubic-bezier(0, 0, 0, 1)',
  accel: 'cubic-bezier(0.3, 0, 1, 1)',
};

/** §3.7 — z-index. The emergency code overlay outranks everything. */
export const zIndex: Readonly<Record<string, string>> = {
  base: '0',
  sticky: '100',
  appbar: '150',
  banner: '200',
  dropdown: '300',
  'rail-overlay': '400',
  scrim: '900',
  dialog: '1000',
  popover: '1100',
  toast: '1200',
  'critical-alert': '1300',
  'emergency-code-overlay': '1400',
};

/** §4.3 — responsive breakpoints. */
export const breakpoints: Readonly<Record<string, string>> = {
  xs: '0px',
  sm: '480px',
  md: '768px',
  lg: '1024px',
  xl: '1280px',
  '2xl': '1536px',
  tv: '1920px',
  tv4k: '3840px',
};

/** §6.3 — three densities, persisted per user per device. */
export const density: Readonly<Record<string, string>> = {
  compact: '32px',
  default: '40px',
  touch: '52px',
};

/** §6.3 — minimum hit areas. WCAG 2.2 2.5.8 asks 24 px; clinical tablets get 44 px. */
export const targets = {
  '--target-min': '24px',
  '--target-touch': '44px',
  '--target-kiosk': '120px',
} as const;

/** Flattened `--fs-*` / `--lh-*` custom properties. */
export function typographyCssVariables(): Record<string, string> {
  const out: Record<string, string> = { ...fontFamilies, ...fontWeights, ...letterSpacings };
  for (const [key, value] of Object.entries(fontSizes)) {
    out[`--fs-${key}`] = value.size;
    out[`--lh-${key}`] = value.lineHeight;
  }
  return out;
}

export function scaleCssVariables(): Record<string, string> {
  const out: Record<string, string> = { ...targets };
  // `.` is not a legal character in a CSS ident, so the half-step keys must be
  // escaped or the browser discards the whole declaration (and every utility
  // built on it) without warning.
  for (const [key, value] of Object.entries(spacing)) out[`--sp-${key.replace(/\./g, '\\.')}`] = value;
  for (const [key, value] of Object.entries(radii)) out[`--r-${key}`] = value;
  for (const [key, value] of Object.entries(elevation)) out[`--e-${key}`] = value;
  for (const [key, value] of Object.entries(durations)) out[`--dur-${key}`] = value;
  for (const [key, value] of Object.entries(easings)) out[`--ease-${key}`] = value;
  for (const [key, value] of Object.entries(zIndex)) out[`--z-${key}`] = value;
  for (const [key, value] of Object.entries(breakpoints)) out[`--bp-${key}`] = value;
  for (const [key, value] of Object.entries(density)) out[`--row-${key}`] = value;
  return out;
}
