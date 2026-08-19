/**
 * `@vims/ui` — the Vim's HMS design system.
 *
 * Layers, in the order docs/06 defines them:
 *   - `./tokens.css`  — the three themes as CSS custom properties + the Tailwind v4 bridge
 *   - `./tokens`      — the same tokens as TypeScript, for print templates and RN (Phase 13)
 *   - `./primitives`  — shadcn/Radix bases restyled onto the tokens (docs/06 §5.1)
 *   - `./clinical`    — the clinical behaviour contracts (docs/06 §5.2)
 *   - `./shell`       — the app shell and role-aware navigation (docs/06 §4.1)
 */
export * from './lib/index.js';
export * from './hooks/index.js';
export * from './primitives/index.js';
export * from './clinical/index.js';
export * from './shell/index.js';
