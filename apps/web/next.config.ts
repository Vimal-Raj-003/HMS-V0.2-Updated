import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // The workspace packages ship TypeScript source rather than build output, so
  // Next must compile them itself. This is what lets a Zod schema be literally
  // the same object in the browser and in the API (docs/09 §4) instead of two
  // copies that can drift.
  transpilePackages: ['@vims/ui', '@vims/contracts', '@vims/i18n', '@vims/flags'],
  poweredByHeader: false,
  experimental: { typedRoutes: true },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // A patient banner must never be framed by another site: it would let
          // an attacker overlay a different patient's name over real controls.
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=(self)' },
        ],
      },
    ];
  },
};

export default config;
