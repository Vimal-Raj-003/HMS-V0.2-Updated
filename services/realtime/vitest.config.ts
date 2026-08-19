import { defineConfig } from 'vitest/config';

/**
 * Unit tests only — no Docker, no network beyond loopback.
 *
 * The gateway suites here bind a real HTTP server on an ephemeral port and talk
 * to it with a real `socket.io-client`: an auth handshake that is only asserted
 * against a mock is not evidence that a socket is actually refused. Suites that
 * need a real Redis are `*.integration.spec.ts` and run under
 * `vitest.integration.config.ts`.
 */
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/*.integration.spec.ts'],
    testTimeout: 20_000,
  },
});
