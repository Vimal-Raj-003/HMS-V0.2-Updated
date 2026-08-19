import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.integration.spec.ts'],
    // Cold image build is ~90 s; the suite shares one container via beforeAll.
    testTimeout: 120_000,
    hookTimeout: 300_000,
    // Testcontainers binds host ports and shares an image build lock; parallel
    // files would race and multiply container count on a laptop.
    fileParallelism: false,
  },
});
