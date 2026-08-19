/**
 * Raw colour scales — `docs/06-ui-ux-design-system.md` §3.1–§3.3.
 *
 * This is the ONLY file in the package (with its siblings in `src/tokens/`) that is
 * allowed to contain a hex literal; `eslint.config.mjs` fails the build anywhere else.
 * Components never consume these directly — they consume the semantic aliases in
 * `themes.ts` (`--color-danger-fg`, not `--da-700`).
 */

/** Neutral scale — docs/06 §3.1. */
export const neutral = {
  0: '#FFFFFF',
  25: '#FAFBFC',
  50: '#F4F6F8',
  100: '#E8ECF1',
  200: '#D5DBE3',
  300: '#B3BDCA',
  400: '#8A97A8',
  500: '#67748A',
  600: '#4E5A6E',
  700: '#3A4553',
  800: '#262F3A',
  900: '#171E27',
  950: '#0D1219',
} as const;

/** Brand primary, "VIMS Teal" — docs/06 §3.2. */
export const primary = {
  50: '#E6F7F8',
  100: '#C2ECEF',
  200: '#93DDE3',
  300: '#5FC9D2',
  400: '#33B2BF',
  500: '#1596A5',
  600: '#0E7A88',
  700: '#0B606C',
  800: '#094A54',
  900: '#073942',
  950: '#04252B',
} as const;

/** Semantic scales — docs/06 §3.3. */
export const success = {
  50: '#ECFDF3',
  100: '#D1FADF',
  300: '#6CE9A6',
  500: '#12B76A',
  600: '#039855',
  700: '#027A48',
  800: '#05603A',
  900: '#04412A',
} as const;

export const warning = {
  50: '#FFFAEB',
  100: '#FEF0C7',
  300: '#FEC84B',
  500: '#F79009',
  600: '#DC6803',
  700: '#B54708',
  800: '#93370D',
  /** docs/06 §3.5 uses this as the ESI-3 text colour on `--wa-300`. */
  900: '#7A2E0E',
} as const;

export const danger = {
  50: '#FEF3F2',
  100: '#FEE4E2',
  300: '#FDA29B',
  500: '#F04438',
  600: '#D92D20',
  700: '#B42318',
  800: '#912018',
  900: '#6C1712',
} as const;

export const info = {
  50: '#EFF8FF',
  100: '#D1E9FF',
  300: '#84CAFF',
  500: '#2E90FA',
  600: '#1570EF',
  700: '#175CD3',
  800: '#1849A9',
  900: '#123A85',
} as const;

export const violet = {
  50: '#F4F3FF',
  100: '#EBE9FE',
  300: '#BDB4FE',
  500: '#7A5AF8',
  600: '#6938EF',
  700: '#5925DC',
  800: '#4A1FB8',
  900: '#39178C',
} as const;

/** Dark "Layered Stack" planes — docs/06 §2.2. */
export const darkLayers = {
  layer0: '#0D1219',
  layer1: '#111820',
  layer2: '#172029',
  layer3: '#1E2A35',
  sunken: '#0A0F15',
  fgDefault: '#E7ECF2',
  fgMuted: '#9FADBD',
  fgSubtle: '#7E8C9C',
} as const;

/** Chart categorical ramps — docs/06 §3.7. */
export const chartRamps = {
  light: ['#0E7A88', '#6938EF', '#DC6803', '#175CD3', '#027A48', '#B42318', '#8A97A8', '#5925DC'],
  dark: ['#5FC9D2', '#BDB4FE', '#FEC84B', '#84CAFF', '#6CE9A6', '#FDA29B', '#B3BDCA', '#D6BBFB'],
} as const;

export const palette = {
  n: neutral,
  p: primary,
  su: success,
  wa: warning,
  da: danger,
  in: info,
  vi: violet,
} as const;

export type PaletteFamily = keyof typeof palette;

/** Every raw scale token flattened to its CSS custom-property name (`--n-900`). */
export function paletteCssVariables(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [family, scale] of Object.entries(palette)) {
    for (const [step, value] of Object.entries(scale)) {
      out[`--${family}-${step}`] = value;
    }
  }
  return out;
}
