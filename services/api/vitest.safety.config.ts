import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

/**
 * The clinical-safety suite — `docs/09` §15 stage 9, which runs on **every** PR,
 * not only when something clinical changed.
 *
 * It is a separate config rather than a tag inside the unit suite for one
 * reason: these assertions must never be skipped, filtered out by a `--changed`
 * flag, or lost among a thousand other tests. A safety assertion that fails
 * should be the only red thing on the page.
 *
 * `passWithNoTests` is deliberate and temporary. The suites arrive with the
 * modules that have hard stops to bypass — allergy and interaction checks
 * (EN-029, Phase 2), the 5-Rights MAR check and high-alert dosing (IP-003,
 * Phase 7), two-person verification for blood and narcotics, and the §269ST cash
 * ceiling (IP-005, Phase 5). Until then this stage proves the wiring, so that
 * adding the first safety test requires no CI change and cannot be forgotten.
 *
 * Files here are named `*.safety.spec.ts`.
 */
export default defineConfig({
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        target: 'es2022',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.safety.spec.ts'],
    passWithNoTests: true,
    // A safety assertion that is merely slow must still run.
    testTimeout: 120_000,
  },
});
