import { defineConfig } from 'vitest/config';

/**
 * Unit tests only — everything that runs without Docker.
 * Container-backed suites live in `*.integration.spec.ts` and are run by
 * `vitest.integration.config.ts` (`pnpm test:integration`), so a developer
 * without Docker running still gets a fast, meaningful `pnpm test`.
 */
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/*.integration.spec.ts'],
  },
});
