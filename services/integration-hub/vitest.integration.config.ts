import { defineConfig } from 'vitest/config';

/**
 * Testcontainers-backed. Slow by construction: the suite builds and starts the
 * project's PostgreSQL 17 image, because the properties under test (RLS tenant
 * isolation, append-only message grants, monthly partitions) exist in the
 * database and cannot be asserted against a mock.
 */
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.integration.spec.ts'],
    testTimeout: 120_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
