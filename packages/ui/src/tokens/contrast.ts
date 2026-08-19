/**
 * WCAG 2.2 contrast mathematics — the engine behind `pnpm tokens:contrast`.
 *
 * docs/06 §3.4: "All body text >= 4.5:1, all >=18.66px/bold text >= 3:1, all UI
 * component boundaries & focus rings >= 3:1 (WCAG 2.2 AA: 1.4.3, 1.4.11, 2.4.11,
 * 2.4.13)." docs/06 §7 adds "High-contrast mode raises every `--fg-*` to >= 7:1".
 */

export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  /** 0..1 */
  readonly a: number;
}

export class ColorParseError extends Error {
  override readonly name = 'ColorParseError';
}

const HEX_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const RGBA_RE = /^rgba?\(\s*([^)]+)\)$/i;

/** Accepts `#RGB`, `#RGBA`, `#RRGGBB`, `#RRGGBBAA`, `rgb(r g b)`, `rgba(r,g,b,a)`. */
export function parseColor(input: string): Rgba {
  const value = input.trim();

  if (HEX_RE.test(value)) {
    const hex = value.slice(1);
    const expand = (s: string): number => parseInt(s.length === 1 ? s + s : s, 16);
    if (hex.length === 3 || hex.length === 4) {
      const parts = hex.split('');
      return {
        r: expand(parts[0] ?? '0'),
        g: expand(parts[1] ?? '0'),
        b: expand(parts[2] ?? '0'),
        a: parts.length === 4 ? expand(parts[3] ?? 'f') / 255 : 1,
      };
    }
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
      a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
    };
  }

  const rgbaMatch = RGBA_RE.exec(value);
  if (rgbaMatch) {
    const body = (rgbaMatch[1] ?? '').replace(/\//g, ' ').replace(/,/g, ' ');
    const parts = body.split(/\s+/).filter((p) => p.length > 0);
    if (parts.length < 3) {
      throw new ColorParseError(`Cannot parse colour "${input}"`);
    }
    const channel = (raw: string): number => {
      const n = raw.endsWith('%') ? (Number(raw.slice(0, -1)) / 100) * 255 : Number(raw);
      if (!Number.isFinite(n)) throw new ColorParseError(`Cannot parse channel "${raw}" in "${input}"`);
      return n;
    };
    const alphaRaw = parts[3];
    const alpha =
      alphaRaw === undefined
        ? 1
        : alphaRaw.endsWith('%')
          ? Number(alphaRaw.slice(0, -1)) / 100
          : Number(alphaRaw);
    if (!Number.isFinite(alpha)) throw new ColorParseError(`Cannot parse alpha in "${input}"`);
    return {
      r: channel(parts[0] ?? '0'),
      g: channel(parts[1] ?? '0'),
      b: channel(parts[2] ?? '0'),
      a: alpha,
    };
  }

  throw new ColorParseError(`Unsupported colour syntax "${input}"`);
}

/** Source-over alpha compositing of `fg` onto an opaque `bg`. */
export function composite(fg: Rgba, bg: Rgba): Rgba {
  if (fg.a >= 1) return fg;
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  };
}

/** WCAG 2.x relative luminance. */
export function relativeLuminance(color: Rgba): number {
  const channel = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/**
 * Contrast ratio of `foreground` against `background`. A translucent foreground is
 * composited over the background first (which is exactly what the browser paints),
 * so `rgba(255,255,255,.08)` hairlines are measured honestly rather than as white.
 */
export function contrastRatio(foreground: string, background: string): number {
  const bg = parseColor(background);
  if (bg.a < 1) {
    throw new ColorParseError(
      `Background "${background}" is translucent; resolve it against an opaque surface first.`,
    );
  }
  const fg = composite(parseColor(foreground), bg);
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const [lighter, darker] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (lighter + 0.05) / (darker + 0.05);
}

/** Two decimal places, truncated *down* so a 4.499 never reports as "4.50 (pass)". */
export function roundRatio(ratio: number): number {
  return Math.floor(ratio * 100) / 100;
}
