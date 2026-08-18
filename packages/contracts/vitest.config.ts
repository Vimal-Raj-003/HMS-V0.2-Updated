import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts', 'src/index.ts', 'src/**/index.ts'],
      // docs/09 §2 coverage gates: packages/contracts >= 90% statements / 85% branches.
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 85,
        lines: 90,
        // Money / dose / safety calculators are on the 100% list (docs/09 §2).
        'src/primitives/money.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
      },
    },
  },
});
