#!/usr/bin/env node
/**
 * Every `--chart-1..8` ramp is colourblind-safe, and stays that way.
 *
 * `docs/06` §3.7 sets out three categorical ramps and tells you to consult the
 * `dataviz` skill before writing a chart. That skill's central instruction is
 * that the colour part is computable, so it should be computed rather than
 * argued about — and when the documented ramps were finally put through the
 * computation they did not pass:
 *
 *   - **light** — `#0E7A88` and `#8A97A8` fell under the chroma floor (they read
 *     as grey rather than as an identity), and `#B42318` sat directly beside
 *     `#027A48` at ΔE 6.2 under deuteranopia: red next to green, the one pair
 *     the commonest dichromacy collapses.
 *   - **dark** — failed four of the five checks. Worst was a ΔE of 9.0 between
 *     `#D6BBFB` and `#B3BDCA` under *normal* vision: a pair full-colour readers
 *     cannot reliably separate either. All eight steps also sat at OKLCH
 *     L 0.78–0.86, well above the 0.48–0.67 a dark plot ground wants, which is
 *     what pushed the hues together in the first place.
 *   - **high contrast** — three steps under the chroma floor and red against
 *     green at ΔE 5.4, in the theme that exists to keep things apart.
 *
 * The replacements draw only on steps the scales in §3.1–3.3 already own; what
 * changed is which step and in what order. This script is the reason that
 * derivation is a property of the repository rather than a note in a commit
 * message: a future edit that reintroduces a grey-reading step, or that puts red
 * back beside green, fails here.
 *
 * The maths is deliberately vendored rather than imported. The skill's script
 * lives in a plugin cache that CI does not have, and a check that silently stops
 * running is worse than no check — `check-gate-scripts.mjs` exists in this repo
 * because that had already happened three times.
 *
 * Method and thresholds follow the `dataviz` skill; the CVD simulation uses the
 * Machado, Oliveira & Santos (2009) matrices at full severity.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── thresholds (dataviz skill) ────────────────────────────────────────────────
const BAND = { light: [0.43, 0.77], dark: [0.48, 0.67] };
const CHROMA_FLOOR = 0.1;
const CVD_TARGET = 8.0;
const CVD_FLOOR = 6.0;
const NORMAL_FLOOR = 15.0;
const CONTRAST_MIN = 3.0;

const MACHADO = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritan: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};

// ── colour maths ──────────────────────────────────────────────────────────────
const hex2srgb = (h) => {
  const v = h.trim().replace(/^#/, '');
  return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255);
};
const s2lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lin = (h) => hex2srgb(h).map(s2lin);
const relLum = (h) => {
  const [r, g, b] = lin(h);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
function oklabFromLin([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
const oklch = (h) => {
  const [L, a, b] = oklabFromLin(lin(h));
  return [L, Math.hypot(a, b)];
};
function simulate(h, kind) {
  const [r, g, b] = lin(h);
  const M = MACHADO[kind];
  const clamp = (c) => Math.max(0, Math.min(1, c));
  return [
    clamp(M[0][0] * r + M[0][1] * g + M[0][2] * b),
    clamp(M[1][0] * r + M[1][1] * g + M[1][2] * b),
    clamp(M[2][0] * r + M[2][1] * g + M[2][2] * b),
  ];
}
function deltaE(h1, h2, kind) {
  const a = oklabFromLin(kind ? simulate(h1, kind) : lin(h1));
  const b = oklabFromLin(kind ? simulate(h2, kind) : lin(h2));
  return 100 * Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

// ── the ramps, read from the generated CSS rather than retyped ────────────────
/**
 * Read from `theme.generated.css` on purpose: retyping the hexes here would let
 * the check pass while the stylesheet the browser actually loads said something
 * else. `generate-css.ts` writes that file from `themes.ts`, so this asserts
 * against the artefact, not the intent.
 */
function readRamps() {
  const css = readFileSync(join(REPO, 'packages/ui/src/tokens/theme.generated.css'), 'utf8');
  const themes = {};
  // Each theme is a selector block; `:root` is light, then the two attribute
  // selectors. Matching on the block keeps a dark step from being read as light.
  const blocks = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)];

  // The raw scales (`--n-0`, `--p-500`, …) are declared once, in the light
  // block; the other themes reference them without redeclaring. Resolving only
  // against the block a token appears in therefore fails for every theme but
  // light — so collect a global fallback first.
  const globalScale = new Map();
  for (const [, sel, body] of blocks) {
    if (!sel.includes(':root')) continue;
    for (const [, k, v] of body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) {
      if (!globalScale.has(k)) globalScale.set(k, v.trim());
    }
  }

  for (const [, selectorRaw, body] of blocks) {
    const selector = selectorRaw.trim();
    // Order matters: the light block's selector is `:root, [data-theme="light"]`,
    // so test for the two attribute themes first and let `:root` mean light.
    // At-rules (`@media`, `@theme`) are containers, not theme blocks.
    let key = null;
    if (selector.startsWith('@')) key = null;
    else if (selector.includes('data-theme="dark"')) key = 'dark';
    else if (selector.includes('data-contrast="high"')) key = 'high';
    else if (selector.includes(':root') || selector.includes('data-theme="light"')) key = 'light';
    if (key === null || themes[key] !== undefined) continue;
    // A token may be a literal or a reference to a scale step in the same block
    // (`--chart-plot-bg: var(--n-0)`), so resolve one level of `var()` against
    // the block it was declared in. Reading only literals silently skipped two
    // of the three themes, which is the failure mode this script exists to catch.
    const declared = new Map(
      [...body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map(([, k, v]) => [k, v.trim()]),
    );
    const resolve = (raw) => {
      if (raw === undefined) return null;
      const ref = /^var\((--[a-z0-9-]+)\)$/.exec(raw);
      const value = ref === null ? raw : (declared.get(ref[1]) ?? globalScale.get(ref[1]) ?? '');
      return /^#[0-9a-fA-F]{6}$/.test(value) ? value : null;
    };

    const ramp = [];
    for (let i = 1; i <= 8; i += 1) {
      const hex = resolve(declared.get(`--chart-${i}`));
      if (hex !== null) ramp.push(hex);
    }
    const surface = resolve(declared.get('--chart-plot-bg'));
    if (ramp.length === 8 && surface !== null) themes[key] = { ramp, surface };
  }
  return themes;
}

// ── the checks ────────────────────────────────────────────────────────────────
function check(name, ramp, surface, mode) {
  const problems = [];
  const notes = [];
  const [lo, hi] = BAND[mode];

  const offBand = ramp.filter((c) => {
    const L = oklch(c)[0];
    return L < lo || L > hi;
  });
  if (offBand.length > 0) {
    problems.push(`lightness band: ${offBand.join(', ')} outside OKLCH L ${lo}–${hi}`);
  }

  const grey = ramp.filter((c) => oklch(c)[1] < CHROMA_FLOOR);
  if (grey.length > 0) {
    problems.push(`chroma floor: ${grey.join(', ')} read as grey (< ${CHROMA_FLOOR})`);
  }

  const pairs = ramp.slice(0, -1).map((c, i) => [c, ramp[i + 1]]);

  let worstCvd = null;
  for (const kind of ['protan', 'deutan']) {
    for (const [a, b] of pairs) {
      const d = deltaE(a, b, kind);
      if (worstCvd === null || d < worstCvd.d) worstCvd = { d, kind, a, b };
    }
  }
  if (worstCvd.d < CVD_FLOOR) {
    problems.push(
      `CVD separation: ${worstCvd.a}↔${worstCvd.b} ΔE ${worstCvd.d.toFixed(1)} (${worstCvd.kind}) — below the ${CVD_FLOOR} floor`,
    );
  } else if (worstCvd.d < CVD_TARGET) {
    // Legal, but only because the chart components carry a legend, direct
    // labels and a texture fill. If that ever stops being true this note is
    // where the reason lived.
    notes.push(
      `CVD separation is in the ${CVD_FLOOR}–${CVD_TARGET} floor band ` +
        `(${worstCvd.a}↔${worstCvd.b} ΔE ${worstCvd.d.toFixed(1)}, ${worstCvd.kind}) — ` +
        `legal only while every chart ships secondary encoding`,
    );
  }

  let worstNormal = null;
  for (const [a, b] of pairs) {
    const d = deltaE(a, b);
    if (worstNormal === null || d < worstNormal.d) worstNormal = { d, a, b };
  }
  if (worstNormal.d < NORMAL_FLOOR) {
    problems.push(
      `normal-vision floor: ${worstNormal.a}↔${worstNormal.b} ΔE ${worstNormal.d.toFixed(1)} — ` +
        `below ${NORMAL_FLOOR}; full-colour readers cannot separate them either`,
    );
  }

  const faint = ramp.map((c) => [c, contrast(c, surface)]).filter(([, r]) => r < CONTRAST_MIN);
  if (faint.length > 0) {
    problems.push(
      `contrast vs plot ground ${surface}: ${faint.map(([c, r]) => `${c} ${r.toFixed(2)}:1`).join(', ')} — below ${CONTRAST_MIN}:1`,
    );
  }

  // Red beside green is forbidden structurally, not just by its ΔE: it is the
  // pair that matters most and the one a later reorder is likeliest to recreate.
  const RED = /^#(B42318|D92D20|F04438)$/i;
  const GREEN = /^#(027A48|039855|12B76A)$/i;
  for (const [a, b] of pairs) {
    if ((RED.test(a) && GREEN.test(b)) || (GREEN.test(a) && RED.test(b))) {
      problems.push(`red and green are adjacent (${a}↔${b}) — reorder the ramp`);
    }
  }

  return { name, problems, notes };
}

const themes = readRamps();
const expected = ['light', 'dark', 'high'];
const missing = expected.filter((t) => themes[t] === undefined);
if (missing.length > 0) {
  process.stdout.write(
    `Chart-palette check failed: no --chart-1..8 ramp found for ${missing.join(', ')}.\n` +
      'Run `pnpm --filter @vims/ui build:tokens` so theme.generated.css is current.\n',
  );
  process.exit(1);
}

const results = expected.map((mode) =>
  check(mode, themes[mode].ramp, themes[mode].surface, mode === 'dark' ? 'dark' : 'light'),
);
const failed = results.filter((r) => r.problems.length > 0);

for (const r of results) {
  for (const n of r.notes) process.stdout.write(`  note (${r.name}): ${n}\n`);
}

if (failed.length > 0) {
  process.stdout.write('Chart-palette check failed (docs/06 §3.7 — see the dataviz skill):\n');
  for (const r of failed) {
    for (const p of r.problems) process.stdout.write(`  - ${r.name}: ${p}\n`);
  }
  process.exit(1);
}

process.stdout.write(
  `Chart-palette check passed: ${expected.length} ramps, 8 steps each — ` +
    'in-band, chromatic, separable under protanopia and deuteranopia, and legible on their plot ground.\n',
);
