import { defineConfig } from 'vitest/config';

export default defineConfig({
  // `jsx: preserve` in tsconfig.json is what Next's compiler wants; Vitest
  // transforms the same files itself and needs the automatic runtime instead.
  oxc: { jsx: { runtime: 'automatic', importSource: 'react' } },
  test: {
    globals: false,
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    restoreMocks: true,
  },
});
