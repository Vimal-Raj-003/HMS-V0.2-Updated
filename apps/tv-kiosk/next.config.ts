import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript source, so Next compiles them itself —
  // the same reason apps/web does it (docs/09 §4): one Zod schema, not two copies.
  transpilePackages: ['@vims/ui', '@vims/contracts', '@vims/i18n'],
  poweredByHeader: false,
  webpack(config: { resolve: { extensionAlias?: Record<string, readonly string[]> } }) {
    // Same reason as apps/web: the workspace packages are ESM TypeScript and so
    // write `./x.js` in their import specifiers, which is what the spec requires
    // even though the file on disk is `./x.ts`. Node and `tsc` follow that;
    // webpack does not unless told. Without this, `@vims/i18n`'s barrel resolves
    // for typecheck and 500s at request time.
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
  // A display board calls `/api/v1` same-origin (src/lib/env.ts) because on-prem
  // it is served behind nginx, which proxies that prefix to the API
  // (infra/docker/nginx/onprem.conf). In local development there is no nginx, so
  // without this the board's pairing call goes cross-origin and dies on CORS —
  // and the API deliberately sends no CORS headers. Opt-in via API_ORIGIN so the
  // proxied deployment keeps resolving `/api/v1` at the edge, as it does today.
  async rewrites() {
    const apiOrigin = process.env['API_ORIGIN'];
    if (apiOrigin === undefined || apiOrigin === '') return [];
    return [{ source: '/api/v1/:path*', destination: `${apiOrigin}/api/v1/:path*` }];
  },
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
