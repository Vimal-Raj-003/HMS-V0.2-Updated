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
  test: {
    globals: false,
    environment: 'jsdom',
    include: ['src/**/*.spec.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', 'e2e/**', '.next/**'],
  },
});
