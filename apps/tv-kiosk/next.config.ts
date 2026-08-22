import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript source, so Next compiles them itself —
  // the same reason apps/web does it (docs/09 §4): one Zod schema, not two copies.
  transpilePackages: ['@vims/ui', '@vims/contracts', '@vims/i18n'],
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // A token board carries a hospital's live queue: never let it be framed
          // and overlaid with a different set of numbers (EN-018 §13).
          { key: 'X-Frame-Options', value: 'DENY' },
          // An unattended screen in a corridor has no business asking for any of
          // these, and a compromised signage box must not be able to.
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
          },
        ],
      },
    ];
  },
};

export default config;
