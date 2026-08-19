/**
 * The declared WCAG 2.2 AA obligations of the token set — the input to
 * `pnpm tokens:contrast`.
 *
 * Thresholds (docs/06 §3.4, §7):
 *   - `normal-text` 4.5:1  — SC 1.4.3, all body/label/chip text (chips are 11 px, so
 *                            they take the *normal* threshold, not the large one).
 *   - `large-text`  3.0:1  — SC 1.4.3 for >= 18.66 px bold / >= 24 px text.
 *   - `ui`          3.0:1  — SC 1.4.11 non-text contrast and SC 2.4.13 focus appearance.
 *   - high-contrast theme raises the neutral foreground family to 7:1 (docs/06 §7).
 */
import type { ThemeKey } from './themes.js';

export type RequirementKind = 'normal-text' | 'large-text' | 'ui';

export interface ContrastRequirement {
  readonly foreground: string;
  readonly background: string;
  readonly min: number;
  readonly kind: RequirementKind;
  readonly why: string;
}

/** Every opaque surface a foreground token may legitimately land on. */
const SURFACES = ['--bg-canvas', '--bg-layer-1', '--bg-layer-2', '--bg-layer-3', '--bg-sunken'] as const;

const ROLES = ['accent', 'success', 'warning', 'danger', 'info', 'violet'] as const;

/** Text tokens that must clear 4.5:1 (7:1 in high contrast) on every surface. */
const NEUTRAL_TEXT = ['--fg-default', '--fg-muted', '--fg-subtle', '--fg-link', '--fg-link-hover'] as const;

const STATUS_TEXT = [
  ...ROLES.map((role) => `--color-${role}-fg`),
  '--flag-normal',
  '--flag-high',
  '--flag-low',
  '--flag-critical-high',
  '--flag-critical-low',
  '--flag-abnormal',
  '--flag-delta',
  '--flag-corrected',
  '--flag-pending',
  '--q-waiting',
  '--q-called',
  '--q-in-progress',
  '--q-on-hold',
  '--q-skipped',
  '--q-completed',
  '--q-no-show',
  '--clinical-allergy',
  '--clinical-mlc',
  '--clinical-isolation',
  '--clinical-dnr',
  '--clinical-npo',
  '--clinical-fall-risk',
  '--clinical-infection',
] as const;

/** Chips whose fill/label pair must read, and whose outline must be visible on a card. */
const CHIPS = [
  '--esi-1',
  '--esi-2',
  '--esi-3',
  '--esi-4',
  '--esi-5',
  '--triage-immediate',
  '--triage-delayed',
  '--triage-minor',
  '--triage-expectant',
  '--triage-deceased',
  '--bed-vacant-clean',
  '--bed-occupied',
  '--bed-vacant-dirty',
  '--bed-cleaning',
  '--bed-blocked',
  '--bed-reserved',
  '--bed-discharge-pending',
  '--bed-isolation',
  '--bed-oos',
] as const;

const EWS = ['--ews-low', '--ews-low-medium', '--ews-medium', '--ews-high'] as const;

export function requirementsFor(theme: ThemeKey): ContrastRequirement[] {
  const out: ContrastRequirement[] = [];
  const neutralMin = theme === 'high' ? 7 : 4.5;

  for (const fg of NEUTRAL_TEXT) {
    for (const bg of SURFACES) {
      out.push({
        foreground: fg,
        background: bg,
        min: neutralMin,
        kind: 'normal-text',
        // docs/06 §7 — high contrast raises every neutral foreground to 7:1.
        why: theme === 'high' ? 'docs/06 §7 high-contrast body text' : 'WCAG 2.2 SC 1.4.3 body text',
      });
    }
  }

  for (const fg of STATUS_TEXT) {
    for (const bg of SURFACES) {
      out.push({
        foreground: fg,
        background: bg,
        min: 4.5,
        kind: 'normal-text',
        why: 'status/clinical label text — SC 1.4.3 (chips are 11 px, normal-text threshold)',
      });
    }
  }

  out.push({
    foreground: '--fg-inverse',
    background: '--bg-inverse',
    min: 4.5,
    kind: 'normal-text',
    why: 'tooltip and inverse-surface text — SC 1.4.3',
  });
  out.push({
    foreground: '--fg-on-accent',
    background: '--color-accent-solid',
    min: 4.5,
    kind: 'normal-text',
    why: 'label on the primary action — SC 1.4.3',
  });

  for (const role of ROLES) {
    out.push({
      foreground: `--color-${role}-on-solid`,
      background: `--color-${role}-solid`,
      min: 4.5,
      kind: 'normal-text',
      why: `label on the ${role} solid fill — SC 1.4.3`,
    });
    out.push({
      foreground: `--color-${role}-on-solid`,
      background: `--color-${role}-solid-hover`,
      min: 4.5,
      kind: 'normal-text',
      why: `label on the ${role} fill while hovered — SC 1.4.3`,
    });
    out.push({
      foreground: `--color-${role}-on-surface`,
      background: `--color-${role}-surface`,
      min: 4.5,
      kind: 'normal-text',
      why: `label on the ${role} subtle surface (banners, chips) — SC 1.4.3`,
    });
    out.push({
      foreground: `--color-${role}-solid`,
      background: '--bg-layer-1',
      min: 3,
      kind: 'ui',
      why: `the ${role} fill is the component boundary of a solid button — SC 1.4.11`,
    });
    out.push({
      foreground: `--color-${role}-border`,
      background: '--bg-layer-1',
      min: 3,
      kind: 'ui',
      why: `${role} banner/chip outline against a card — SC 1.4.11`,
    });
    out.push({
      foreground: `--color-${role}-border`,
      background: `--color-${role}-surface`,
      min: 3,
      kind: 'ui',
      why: `${role} outline against its own subtle fill — SC 1.4.11`,
    });
  }

  for (const bg of SURFACES) {
    out.push({
      foreground: '--border-control',
      background: bg,
      min: 3,
      kind: 'ui',
      why: 'input / checkbox / switch boundary — SC 1.4.11',
    });
    out.push({
      foreground: '--border-focus',
      background: bg,
      min: 3,
      kind: 'ui',
      why: 'focus ring, drawn with a 2 px offset so it sits on the surface — SC 2.4.13',
    });
  }

  for (const chip of CHIPS) {
    out.push({
      foreground: `${chip}-fg`,
      background: `${chip}-bg`,
      min: 4.5,
      kind: 'normal-text',
      why: 'triage numeral / bed state code — SC 1.4.3 (never colour alone, docs/06 §1.2.3)',
    });
    out.push({
      foreground: `${chip}-border`,
      background: '--bg-layer-1',
      min: 3,
      kind: 'ui',
      why: 'chip / bed-tile outline is what identifies the state on a white card — SC 1.4.11',
    });
  }

  for (const band of EWS) {
    out.push({
      foreground: `${band}-fg`,
      background: `${band}-bg`,
      min: 4.5,
      kind: 'normal-text',
      why: 'NEWS2 band numeral and required-action text — SC 1.4.3',
    });
    out.push({
      foreground: `${band}-bg`,
      background: '--bg-layer-1',
      min: 3,
      kind: 'ui',
      why: 'NEWS2 badge boundary against a card — SC 1.4.11',
    });
  }

  for (let i = 1; i <= 8; i += 1) {
    out.push({
      foreground: `--chart-${i}`,
      background: '--chart-plot-bg',
      min: 3,
      kind: 'ui',
      why: `categorical series ${i} against the plot background — SC 1.4.11 graphical object`,
    });
  }

  return out;
}

/**
 * Tokens deliberately outside the gate, with the reason. Anything not listed here and
 * not covered by `requirementsFor` is reported by the checker as UNGATED, so a new
 * token cannot quietly escape review.
 */
export const UNGATED: Readonly<Record<string, string>> = {
  '--bg-canvas': 'surface, measured as a background',
  '--bg-layer-1': 'surface',
  '--bg-layer-2': 'surface',
  '--bg-layer-3': 'surface',
  '--bg-sunken': 'surface',
  '--bg-inverse': 'surface',
  '--chart-plot-bg': 'surface',
  '--color-accent-surface': 'surface',
  '--color-success-surface': 'surface',
  '--color-warning-surface': 'surface',
  '--color-danger-surface': 'surface',
  '--color-info-surface': 'surface',
  '--color-violet-surface': 'surface',
  '--overlay-scrim':
    'translucent scrim over arbitrary page content; its job is to reduce contrast, not to carry any',
  '--border-default':
    'decorative hairline (card edge, table row rule). The boundary that identifies a control is --border-control, which IS gated (docs/06 §2.1: "cards on hairline borders").',
  '--border-strong': 'decorative hairline, one step up from --border-default',
  '--border-disabled': 'disabled controls are exempt from SC 1.4.3 / 1.4.11',
  '--fg-disabled': 'disabled text is exempt from SC 1.4.3',
  '--chart-grid': 'gridlines are decorative; the data marks and axis labels carry the meaning',
};
