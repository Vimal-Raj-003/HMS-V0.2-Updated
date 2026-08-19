import { defineConfig } from 'vitest/config';

/**
 * Unit tests only. Container-backed suites are `*.integration.spec.ts` and run
 * under `vitest.integration.config.ts`, so `pnpm test` stays fast and does not
 * require Docker.
 */
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/*.integration.spec.ts'],
  },
});
