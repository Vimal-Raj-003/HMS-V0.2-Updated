import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Component tests only.
 *
 * `e2e/` holds Playwright specs, and Playwright's `test.describe` throws when
 * loaded under vitest. Without this exclusion `pnpm test` fails for a reason
 * that has nothing to do with the code — the two runners simply must not read
 * each other's files.
 */
export default defineConfig({
  // `apps/web/tsconfig.json` sets `jsx: "preserve"` because Next does its own JSX
  // transform. The test runner has no Next in front of it, so it must be told to
  // compile JSX itself — otherwise every `.tsx` spec fails to parse with an error
  // ("Unexpected JSX expression") that looks like a syntax mistake in the test.
  oxc: { jsx: 'automatic' },
  resolve: {
    // The same `@/*` alias the app compiles with (`tsconfig.json` paths). Without
    // it a component that imports `@/lib/session-context` type-checks and then
    // fails to resolve under the test runner only.
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    globals: false,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.spec.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', 'e2e/**', '.next/**'],
  },
});
