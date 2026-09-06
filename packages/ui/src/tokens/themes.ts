/**
 * Semantic token maps — `docs/06-ui-ux-design-system.md` §3.4, §3.5, §7.
 *
 * Three themes:
 *   - `light`  — "Light Clinical", the default for clinical and data-entry work (§2.1).
 *   - `dark`   — "Dark Layered Stack" for dashboards, TV boards and kiosk idle (§2.2).
 *   - `high`   — high-contrast light for bright wards / ER ambulance bay (§7), `>= 7:1` body text.
 *
 * Components consume ONLY these names. Where a value here differs from the literal
 * hex printed in docs/06, the reason is always the same: the doc's ratio was computed
 * against pure white (or the page canvas) and the token also has to survive
 * `--bg-layer-3` / `--bg-sunken`. Every such change is listed in `DEVIATIONS` below and
 * printed by `pnpm tokens:contrast`.
 */
import { danger, darkLayers, info, neutral, primary, success, violet, warning } from './palette.js';

export type ThemeKey = 'light' | 'dark' | 'high';

export interface TokenValue {
  /** What is emitted into CSS — a `var(--n-900)` reference or a literal. */
  readonly css: string;
  /** The resolved colour, used by the contrast gate. */
  readonly color: string;
}

const n = (step: keyof typeof neutral): TokenValue => ({ css: `var(--n-${step})`, color: neutral[step] });
const p = (step: keyof typeof primary): TokenValue => ({ css: `var(--p-${step})`, color: primary[step] });
const su = (step: keyof typeof success): TokenValue => ({ css: `var(--su-${step})`, color: success[step] });
const wa = (step: keyof typeof warning): TokenValue => ({ css: `var(--wa-${step})`, color: warning[step] });
const da = (step: keyof typeof danger): TokenValue => ({ css: `var(--da-${step})`, color: danger[step] });
const inf = (step: keyof typeof info): TokenValue => ({ css: `var(--in-${step})`, color: info[step] });
const vi = (step: keyof typeof violet): TokenValue => ({ css: `var(--vi-${step})`, color: violet[step] });
const lit = (value: string): TokenValue => ({ css: value, color: value });

/**
 * Dark "Layered Stack" tinted surfaces — an 18 % wash of the role's 500 step over
 * `--bg-layer-2`, pre-composited so the contrast gate can measure them as opaque.
 */
const darkSurface = {
  accent: '#17353F',
  success: '#163B35',
  warning: '#3F3423',
  danger: '#3E262C',
  info: '#1B344F',
  violet: '#292A4E',
} as const;

export type SemanticTokens = Readonly<Record<string, TokenValue>>;

// ── light ────────────────────────────────────────────────────────────────────
const light: SemanticTokens = {
  // surfaces (§3.4)
  '--bg-canvas': n(25),
  '--bg-layer-1': n(0),
  '--bg-layer-2': n(0),
  '--bg-layer-3': n(50),
  '--bg-sunken': n(100),
  '--bg-inverse': n(900),
  '--overlay-scrim': lit('rgba(23, 30, 39, 0.55)'),

  // foreground
  '--fg-default': n(900),
  '--fg-muted': n(700),
  '--fg-subtle': n(600),
  '--fg-disabled': n(400),
  '--fg-on-accent': n(0),
  '--fg-inverse': n(0),
  '--fg-link': p(700),
  '--fg-link-hover': p(800),

  // borders
  '--border-default': n(200),
  '--border-strong': n(300),
  '--border-control': n(500),
  '--border-focus': p(600),
  '--border-disabled': n(200),

  // accent / primary
  '--color-accent-fg': p(700),
  '--color-accent-solid': p(600),
  '--color-accent-solid-hover': p(700),
  '--color-accent-on-solid': n(0),
  '--color-accent-surface': p(50),
  '--color-accent-on-surface': p(800),
  '--color-accent-border': p(700),

  '--color-success-fg': su(700),
  '--color-success-solid': su(700),
  '--color-success-solid-hover': su(800),
  '--color-success-on-solid': n(0),
  '--color-success-surface': su(50),
  '--color-success-on-surface': su(800),
  '--color-success-border': su(700),

  '--color-warning-fg': wa(700),
  '--color-warning-solid': wa(700),
  '--color-warning-solid-hover': wa(800),
  '--color-warning-on-solid': n(0),
  '--color-warning-surface': wa(50),
  '--color-warning-on-surface': wa(800),
  '--color-warning-border': wa(700),

  '--color-danger-fg': da(700),
  '--color-danger-solid': da(600),
  '--color-danger-solid-hover': da(700),
  '--color-danger-on-solid': n(0),
  '--color-danger-surface': da(50),
  '--color-danger-on-surface': da(800),
  '--color-danger-border': da(700),

  '--color-info-fg': inf(700),
  '--color-info-solid': inf(600),
  '--color-info-solid-hover': inf(700),
  '--color-info-on-solid': n(0),
  '--color-info-surface': inf(50),
  '--color-info-on-surface': inf(800),
  '--color-info-border': inf(700),

  '--color-violet-fg': vi(700),
  '--color-violet-solid': vi(600),
  '--color-violet-solid-hover': vi(700),
  '--color-violet-on-solid': n(0),
  '--color-violet-surface': vi(50),
  '--color-violet-on-surface': vi(800),
  '--color-violet-border': vi(700),

  // ESI triage (§3.5) — numeral is the primary signal, colour is corroborating
  '--esi-1-bg': da(700),
  '--esi-1-fg': n(0),
  '--esi-1-border': da(800),
  '--esi-2-bg': wa(700),
  '--esi-2-fg': n(0),
  '--esi-2-border': wa(800),
  '--esi-3-bg': wa(300),
  '--esi-3-fg': wa(900),
  '--esi-3-border': wa(700),
  '--esi-4-bg': su(600),
  '--esi-4-fg': n(950),
  '--esi-4-border': su(800),
  '--esi-5-bg': n(600),
  '--esi-5-fg': n(0),
  '--esi-5-border': n(800),

  // START / mass casualty
  '--triage-immediate-bg': da(700),
  '--triage-immediate-fg': n(0),
  '--triage-immediate-border': da(800),
  '--triage-delayed-bg': wa(300),
  '--triage-delayed-fg': wa(900),
  '--triage-delayed-border': wa(700),
  '--triage-minor-bg': su(600),
  '--triage-minor-fg': n(950),
  '--triage-minor-border': su(800),
  '--triage-expectant-bg': n(900),
  '--triage-expectant-fg': n(0),
  '--triage-expectant-border': n(950),
  '--triage-deceased-bg': n(950),
  '--triage-deceased-fg': n(0),
  '--triage-deceased-border': n(950),

  // bed states (§3.5) — every tile also carries a 2-letter code + hatch pattern
  '--bed-vacant-clean-bg': su(600),
  '--bed-vacant-clean-fg': n(950),
  '--bed-vacant-clean-border': su(800),
  '--bed-occupied-bg': inf(600),
  '--bed-occupied-fg': n(0),
  '--bed-occupied-border': inf(800),
  '--bed-vacant-dirty-bg': wa(600),
  '--bed-vacant-dirty-fg': n(950),
  '--bed-vacant-dirty-border': wa(800),
  '--bed-cleaning-bg': wa(300),
  '--bed-cleaning-fg': wa(900),
  '--bed-cleaning-border': wa(700),
  '--bed-blocked-bg': n(600),
  '--bed-blocked-fg': n(0),
  '--bed-blocked-border': n(800),
  '--bed-reserved-bg': p(300),
  '--bed-reserved-fg': n(950),
  '--bed-reserved-border': p(700),
  '--bed-discharge-pending-bg': wa(500),
  '--bed-discharge-pending-fg': n(950),
  '--bed-discharge-pending-border': wa(800),
  '--bed-isolation-bg': vi(600),
  '--bed-isolation-fg': n(0),
  '--bed-isolation-border': vi(800),
  '--bed-oos-bg': da(700),
  '--bed-oos-fg': n(0),
  '--bed-oos-border': da(800),

  // result flags (§3.5) — glyph is mandatory, colour never alone
  '--flag-normal': n(600),
  '--flag-high': wa(700),
  '--flag-low': inf(700),
  '--flag-critical-high': da(700),
  '--flag-critical-low': vi(700),
  '--flag-abnormal': wa(700),
  '--flag-delta': vi(600),
  '--flag-corrected': n(600),
  '--flag-pending': n(600),

  // queue states (§3.5)
  '--q-waiting': n(700),
  '--q-called': inf(700),
  '--q-in-progress': su(700),
  '--q-on-hold': wa(700),
  '--q-skipped': da(700),
  '--q-completed': n(600),
  '--q-no-show': n(800),

  // NEWS2 / EWS bands (§3.5)
  '--ews-low-bg': su(700),
  '--ews-low-fg': n(0),
  '--ews-low-medium-bg': wa(600),
  '--ews-low-medium-fg': n(950),
  '--ews-medium-bg': wa(800),
  '--ews-medium-fg': n(0),
  '--ews-high-bg': da(700),
  '--ews-high-fg': n(0),

  // other clinical flags (§3.5)
  '--clinical-allergy': da(700),
  '--clinical-mlc': vi(700),
  '--clinical-isolation': vi(600),
  '--clinical-dnr': n(800),
  '--clinical-npo': wa(700),
  '--clinical-fall-risk': wa(700),
  '--clinical-infection': su(800),

  // charts (§3.7)
  // Re-derived, not hand-picked — see DEVIATIONS. Every step below is one the
  // scales in §3.1–3.3 already own; only the choice of step and the ORDER are
  // new, and both come out of the dataviz validator rather than out of taste.
  '--chart-1': lit('#1596A5'), // teal   --p-500   — brand leads every chart
  '--chart-2': lit('#5925DC'), // violet --vi-700
  '--chart-3': lit('#B54708'), // amber  --wa-700
  '--chart-4': lit('#027A48'), // green  --su-700
  '--chart-5': lit('#175CD3'), // blue   --in-700
  '--chart-6': lit('#B42318'), // red    --da-700
  '--chart-7': lit('#DD2590'), // magenta
  '--chart-8': lit('#93370D'), // brown  --wa-900
  '--chart-grid': lit('rgba(23, 30, 39, 0.10)'),
  '--chart-plot-bg': n(0),
};

// ── dark ─────────────────────────────────────────────────────────────────────
const dark: SemanticTokens = {
  '--bg-canvas': lit(darkLayers.layer0),
  '--bg-layer-1': lit(darkLayers.layer1),
  '--bg-layer-2': lit(darkLayers.layer2),
  '--bg-layer-3': lit(darkLayers.layer3),
  '--bg-sunken': lit(darkLayers.sunken),
  '--bg-inverse': n(200),
  '--overlay-scrim': lit('rgba(0, 0, 0, 0.68)'),

  '--fg-default': lit(darkLayers.fgDefault),
  '--fg-muted': lit(darkLayers.fgMuted),
  '--fg-subtle': n(400),
  '--fg-disabled': n(600),
  '--fg-on-accent': p(950),
  '--fg-inverse': n(950),
  '--fg-link': p(300),
  '--fg-link-hover': p(200),

  '--border-default': lit('rgba(255, 255, 255, 0.08)'),
  '--border-strong': lit('rgba(255, 255, 255, 0.16)'),
  '--border-control': n(400),
  '--border-focus': p(300),
  '--border-disabled': lit('rgba(255, 255, 255, 0.08)'),

  '--color-accent-fg': p(300),
  '--color-accent-solid': p(400),
  '--color-accent-solid-hover': p(300),
  '--color-accent-on-solid': p(950),
  '--color-accent-surface': lit(darkSurface.accent),
  '--color-accent-on-surface': p(300),
  '--color-accent-border': p(300),

  '--color-success-fg': su(300),
  '--color-success-solid': su(300),
  '--color-success-solid-hover': su(100),
  '--color-success-on-solid': n(950),
  '--color-success-surface': lit(darkSurface.success),
  '--color-success-on-surface': su(300),
  '--color-success-border': su(300),

  '--color-warning-fg': wa(300),
  '--color-warning-solid': wa(300),
  '--color-warning-solid-hover': wa(100),
  '--color-warning-on-solid': n(950),
  '--color-warning-surface': lit(darkSurface.warning),
  '--color-warning-on-surface': wa(300),
  '--color-warning-border': wa(300),

  '--color-danger-fg': da(300),
  '--color-danger-solid': da(300),
  '--color-danger-solid-hover': da(100),
  '--color-danger-on-solid': n(950),
  '--color-danger-surface': lit(darkSurface.danger),
  '--color-danger-on-surface': da(300),
  '--color-danger-border': da(300),

  '--color-info-fg': inf(300),
  '--color-info-solid': inf(300),
  '--color-info-solid-hover': inf(100),
  '--color-info-on-solid': n(950),
  '--color-info-surface': lit(darkSurface.info),
  '--color-info-on-surface': inf(300),
  '--color-info-border': inf(300),

  '--color-violet-fg': vi(300),
  '--color-violet-solid': vi(300),
  '--color-violet-solid-hover': vi(100),
  '--color-violet-on-solid': n(950),
  '--color-violet-surface': lit(darkSurface.violet),
  '--color-violet-on-surface': vi(300),
  '--color-violet-border': vi(300),

  '--esi-1-bg': da(300),
  '--esi-1-fg': n(950),
  '--esi-1-border': da(300),
  '--esi-2-bg': wa(500),
  '--esi-2-fg': n(950),
  '--esi-2-border': wa(500),
  '--esi-3-bg': wa(300),
  '--esi-3-fg': n(950),
  '--esi-3-border': wa(300),
  '--esi-4-bg': su(300),
  '--esi-4-fg': n(950),
  '--esi-4-border': su(300),
  '--esi-5-bg': n(400),
  '--esi-5-fg': n(950),
  '--esi-5-border': n(400),

  '--triage-immediate-bg': da(300),
  '--triage-immediate-fg': n(950),
  '--triage-immediate-border': da(300),
  '--triage-delayed-bg': wa(300),
  '--triage-delayed-fg': n(950),
  '--triage-delayed-border': wa(300),
  '--triage-minor-bg': su(300),
  '--triage-minor-fg': n(950),
  '--triage-minor-border': su(300),
  '--triage-expectant-bg': n(400),
  '--triage-expectant-fg': n(950),
  '--triage-expectant-border': n(400),
  '--triage-deceased-bg': n(300),
  '--triage-deceased-fg': n(950),
  '--triage-deceased-border': n(300),

  '--bed-vacant-clean-bg': su(300),
  '--bed-vacant-clean-fg': n(950),
  '--bed-vacant-clean-border': su(300),
  '--bed-occupied-bg': inf(300),
  '--bed-occupied-fg': n(950),
  '--bed-occupied-border': inf(300),
  '--bed-vacant-dirty-bg': wa(500),
  '--bed-vacant-dirty-fg': n(950),
  '--bed-vacant-dirty-border': wa(500),
  '--bed-cleaning-bg': wa(300),
  '--bed-cleaning-fg': n(950),
  '--bed-cleaning-border': wa(300),
  '--bed-blocked-bg': n(400),
  '--bed-blocked-fg': n(950),
  '--bed-blocked-border': n(400),
  '--bed-reserved-bg': p(300),
  '--bed-reserved-fg': n(950),
  '--bed-reserved-border': p(300),
  '--bed-discharge-pending-bg': wa(100),
  '--bed-discharge-pending-fg': n(950),
  '--bed-discharge-pending-border': wa(100),
  '--bed-isolation-bg': vi(300),
  '--bed-isolation-fg': n(950),
  '--bed-isolation-border': vi(300),
  '--bed-oos-bg': da(300),
  '--bed-oos-fg': n(950),
  '--bed-oos-border': da(300),

  '--flag-normal': n(300),
  '--flag-high': wa(300),
  '--flag-low': inf(300),
  '--flag-critical-high': da(300),
  '--flag-critical-low': vi(300),
  '--flag-abnormal': wa(300),
  '--flag-delta': vi(300),
  '--flag-corrected': n(300),
  '--flag-pending': n(400),

  '--q-waiting': n(300),
  '--q-called': inf(300),
  '--q-in-progress': su(300),
  '--q-on-hold': wa(300),
  '--q-skipped': da(300),
  '--q-completed': n(400),
  '--q-no-show': n(400),

  '--ews-low-bg': su(300),
  '--ews-low-fg': n(950),
  '--ews-low-medium-bg': wa(300),
  '--ews-low-medium-fg': n(950),
  '--ews-medium-bg': wa(500),
  '--ews-medium-fg': n(950),
  '--ews-high-bg': da(300),
  '--ews-high-fg': n(950),

  '--clinical-allergy': da(300),
  '--clinical-mlc': vi(300),
  '--clinical-isolation': vi(300),
  '--clinical-dnr': n(300),
  '--clinical-npo': wa(300),
  '--clinical-fall-risk': wa(300),
  '--clinical-infection': su(300),

  // Re-stepped for the dark plot ground, not flipped onto it. The doc's 300-level
  // tints sit at OKLCH L 0.78–0.86, far above the L 0.48–0.67 a dark surface
  // wants, which is exactly why they crowded together: two of them were 9.0 ΔE
  // apart under NORMAL vision.
  '--chart-1': lit('#1596A5'), // teal
  '--chart-2': lit('#B98246'), // tan
  '--chart-3': lit('#1570EF'), // blue
  '--chart-4': lit('#DC6803'), // amber
  '--chart-5': lit('#039855'), // green
  '--chart-6': lit('#DD2590'), // magenta
  '--chart-7': lit('#7A5AF8'), // violet
  '--chart-8': lit('#F04438'), // red
  '--chart-grid': lit('rgba(255, 255, 255, 0.08)'),
  '--chart-plot-bg': lit(darkLayers.layer3),
};

// ── high contrast (§7) ───────────────────────────────────────────────────────
const high: SemanticTokens = {
  '--bg-canvas': n(0),
  '--bg-layer-1': n(0),
  '--bg-layer-2': n(0),
  '--bg-layer-3': n(50),
  '--bg-sunken': n(100),
  '--bg-inverse': n(950),
  '--overlay-scrim': lit('rgba(13, 18, 25, 0.72)'),

  '--fg-default': n(950),
  '--fg-muted': n(800),
  '--fg-subtle': n(700),
  '--fg-disabled': n(500),
  '--fg-on-accent': n(0),
  '--fg-inverse': n(0),
  '--fg-link': p(800),
  '--fg-link-hover': p(900),

  '--border-default': n(500),
  '--border-strong': n(700),
  '--border-control': n(700),
  '--border-focus': p(800),
  '--border-disabled': n(400),

  '--color-accent-fg': p(800),
  '--color-accent-solid': p(800),
  '--color-accent-solid-hover': p(900),
  '--color-accent-on-solid': n(0),
  '--color-accent-surface': p(50),
  '--color-accent-on-surface': p(900),
  '--color-accent-border': p(800),

  '--color-success-fg': su(800),
  '--color-success-solid': su(800),
  '--color-success-solid-hover': su(900),
  '--color-success-on-solid': n(0),
  '--color-success-surface': su(50),
  '--color-success-on-surface': su(900),
  '--color-success-border': su(800),

  '--color-warning-fg': wa(800),
  '--color-warning-solid': wa(800),
  '--color-warning-solid-hover': wa(900),
  '--color-warning-on-solid': n(0),
  '--color-warning-surface': wa(50),
  '--color-warning-on-surface': wa(900),
  '--color-warning-border': wa(800),

  '--color-danger-fg': da(800),
  '--color-danger-solid': da(800),
  '--color-danger-solid-hover': da(900),
  '--color-danger-on-solid': n(0),
  '--color-danger-surface': da(50),
  '--color-danger-on-surface': da(900),
  '--color-danger-border': da(800),

  '--color-info-fg': inf(800),
  '--color-info-solid': inf(800),
  '--color-info-solid-hover': inf(900),
  '--color-info-on-solid': n(0),
  '--color-info-surface': inf(50),
  '--color-info-on-surface': inf(900),
  '--color-info-border': inf(800),

  '--color-violet-fg': vi(800),
  '--color-violet-solid': vi(800),
  '--color-violet-solid-hover': vi(900),
  '--color-violet-on-solid': n(0),
  '--color-violet-surface': vi(50),
  '--color-violet-on-surface': vi(900),
  '--color-violet-border': vi(800),

  '--esi-1-bg': da(800),
  '--esi-1-fg': n(0),
  '--esi-1-border': da(900),
  '--esi-2-bg': wa(800),
  '--esi-2-fg': n(0),
  '--esi-2-border': wa(900),
  '--esi-3-bg': wa(300),
  '--esi-3-fg': n(950),
  '--esi-3-border': wa(800),
  '--esi-4-bg': su(800),
  '--esi-4-fg': n(0),
  '--esi-4-border': su(900),
  '--esi-5-bg': n(800),
  '--esi-5-fg': n(0),
  '--esi-5-border': n(950),

  '--triage-immediate-bg': da(800),
  '--triage-immediate-fg': n(0),
  '--triage-immediate-border': da(900),
  '--triage-delayed-bg': wa(300),
  '--triage-delayed-fg': n(950),
  '--triage-delayed-border': wa(800),
  '--triage-minor-bg': su(800),
  '--triage-minor-fg': n(0),
  '--triage-minor-border': su(900),
  '--triage-expectant-bg': n(900),
  '--triage-expectant-fg': n(0),
  '--triage-expectant-border': n(950),
  '--triage-deceased-bg': n(950),
  '--triage-deceased-fg': n(0),
  '--triage-deceased-border': n(950),

  '--bed-vacant-clean-bg': su(800),
  '--bed-vacant-clean-fg': n(0),
  '--bed-vacant-clean-border': su(900),
  '--bed-occupied-bg': inf(800),
  '--bed-occupied-fg': n(0),
  '--bed-occupied-border': inf(900),
  '--bed-vacant-dirty-bg': wa(800),
  '--bed-vacant-dirty-fg': n(0),
  '--bed-vacant-dirty-border': wa(900),
  '--bed-cleaning-bg': wa(300),
  '--bed-cleaning-fg': n(950),
  '--bed-cleaning-border': wa(800),
  '--bed-blocked-bg': n(800),
  '--bed-blocked-fg': n(0),
  '--bed-blocked-border': n(950),
  '--bed-reserved-bg': p(300),
  '--bed-reserved-fg': n(950),
  '--bed-reserved-border': p(800),
  '--bed-discharge-pending-bg': wa(100),
  '--bed-discharge-pending-fg': n(950),
  '--bed-discharge-pending-border': wa(800),
  '--bed-isolation-bg': vi(800),
  '--bed-isolation-fg': n(0),
  '--bed-isolation-border': vi(900),
  '--bed-oos-bg': da(800),
  '--bed-oos-fg': n(0),
  '--bed-oos-border': da(900),

  '--flag-normal': n(800),
  '--flag-high': wa(800),
  '--flag-low': inf(800),
  '--flag-critical-high': da(800),
  '--flag-critical-low': vi(800),
  '--flag-abnormal': wa(800),
  '--flag-delta': vi(800),
  '--flag-corrected': n(800),
  '--flag-pending': n(700),

  '--q-waiting': n(800),
  '--q-called': inf(800),
  '--q-in-progress': su(800),
  '--q-on-hold': wa(800),
  '--q-skipped': da(800),
  '--q-completed': n(700),
  '--q-no-show': n(900),

  '--ews-low-bg': su(800),
  '--ews-low-fg': n(0),
  '--ews-low-medium-bg': wa(800),
  '--ews-low-medium-fg': n(0),
  '--ews-medium-bg': wa(900),
  '--ews-medium-fg': n(0),
  '--ews-high-bg': da(800),
  '--ews-high-fg': n(0),

  '--clinical-allergy': da(800),
  '--clinical-mlc': vi(800),
  '--clinical-isolation': vi(800),
  '--clinical-dnr': n(900),
  '--clinical-npo': wa(800),
  '--clinical-fall-risk': wa(800),
  '--clinical-infection': su(800),

  // High contrast reuses the light ramp rather than going darker. Pushing every
  // hue to its 800/900 step drains chroma — three of the old steps read as grey
  // to the validator — and it collapsed red against green at ΔE 5.4, which is
  // the one pair a high-contrast theme exists to keep apart. The light ramp
  // clears every check on pure white, so identity here is carried by that ramp
  // plus the mandatory texture fill and a heavier grid.
  '--chart-1': lit('#1596A5'),
  '--chart-2': lit('#5925DC'),
  '--chart-3': lit('#B54708'),
  '--chart-4': lit('#027A48'),
  '--chart-5': lit('#175CD3'),
  '--chart-6': lit('#B42318'),
  '--chart-7': lit('#DD2590'),
  '--chart-8': lit('#93370D'),
  '--chart-grid': lit('rgba(23, 30, 39, 0.28)'),
  '--chart-plot-bg': n(0),
};

export const themes: Readonly<Record<ThemeKey, SemanticTokens>> = { light, dark, high };

export const themeSelectors: Readonly<Record<ThemeKey, string>> = {
  light: ':root, [data-theme="light"]',
  dark: '[data-theme="dark"]',
  high: '[data-contrast="high"]',
};

export const themeLabels: Readonly<Record<ThemeKey, string>> = {
  light: 'Light Clinical (default)',
  dark: 'Dark Layered Stack (dashboards, TV boards)',
  high: 'High-contrast Light (bright wards, ER bay)',
};

/**
 * Where this file knowingly departs from the literal hex in docs/06 — always because
 * the doc value fails the WCAG gate on at least one surface it is used against.
 */
export const DEVIATIONS: readonly string[] = [
  'light --fg-muted: --n-700 (docs: --n-600). --n-600 is 5.87:1 on --bg-sunken, fine, but --fg-subtle had to move up to --n-600, so muted moves with it to stay a visible step darker.',
  'light --fg-subtle: --n-600 (docs: --n-500). --n-500 is 3.98:1 on --bg-sunken (--n-100) and 4.36:1 on --bg-layer-3 — below 4.5:1.',
  'dark --fg-subtle: --n-400 (docs: #7E8C9C). #7E8C9C is 4.25:1 on --bg-layer-3 (#1E2A35).',
  'light --color-accent-fg: --p-700 (docs quotes --p-600 for fills). --p-600 as *text* is 4.25:1 on --bg-sunken; --p-600 is kept for --color-accent-solid where white sits on it at 5.05:1.',
  'ESI-4 / START-minor / bed-vacant-clean keep the doc fill --su-600 #039855 but take --n-950 text (5.03:1) instead of white (3.73:1 — fails).',
  'bed-vacant-dirty keeps the doc fill --wa-600 #DC6803 with --n-950 text (5.39:1) instead of white (3.48:1 — fails).',
  '--flag-abnormal, --clinical-fall-risk: --wa-700 (docs: --wa-600). --wa-600 is 2.93:1 on --bg-sunken.',
  '--flag-normal, --flag-pending, --q-completed: --n-600 (docs: --n-500 / --n-400). Both fail 4.5:1 on --bg-layer-3 and --bg-sunken.',
  '--q-waiting: --n-700 (docs: --n-500), --q-no-show: --n-800 (docs: --n-700) — kept one step apart from --q-completed so the greys stay distinguishable after the AA bump.',
  'high-contrast --border-default: --n-500 (docs §3.4 says --n-400). --n-400 is 2.96:1 on white — just under the 3:1 that 1.4.11 requires of a control boundary.',
  'All three --chart-1..8 ramps are re-derived from docs §3.7. The documented ramps do not pass the dataviz validator: light failed the chroma floor on #0E7A88 and #8A97A8 and put red beside green at ΔE 6.2 (deutan); dark failed on all five checks bar contrast, worst of all a NORMAL-vision ΔE of 9.0 between #D6BBFB and #B3BDCA — a pair full-colour readers cannot separate; high contrast failed the chroma floor three times and collapsed red against green at ΔE 5.4. The replacements use only steps the scales already own, are ordered so the VIMS teal leads and red never neighbours green, and are checked by scripts/check-chart-palette.mjs on every CI run.',
  'dark --chart-* sits in the CVD 6-8 floor band (worst adjacent 7.0 deutan), which the dataviz skill permits ONLY with secondary encoding. That is why the chart components make a legend mandatory above one series, direct-label up to four, and ship a texture fill.',
  '--border-default / --border-strong in light and dark are decorative hairlines (card edges, row rules); the gated control boundary is --border-control, which is a separate token precisely so the decorative one can stay a hairline.',
];
