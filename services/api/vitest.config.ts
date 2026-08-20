import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

/**
 * Unit tests only. NestJS decorators need a transform that emits decorator
 * metadata, which esbuild (vitest's default) does not do — hence swc.
 * Container-backed suites live in `*.integration.spec.ts`.
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
    include: ['src/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/*.integration.spec.ts'],
  },
});
