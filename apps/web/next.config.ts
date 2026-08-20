import withSerwistInit from '@serwist/next';
import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // The workspace packages ship TypeScript source rather than build output, so
  // Next must compile them itself. This is what lets a Zod schema be literally
  // the same object in the browser and in the API (docs/09 §4) instead of two
  // copies that can drift.
  transpilePackages: ['@vims/ui', '@vims/contracts', '@vims/i18n', '@vims/flags'],
  poweredByHeader: false,
  webpack(config: { resolve: { extensionAlias?: Record<string, readonly string[]> } }) {
    // The workspace packages are ESM TypeScript and therefore write `./x.js` in
    // their import specifiers, which is what the spec requires even though the
    // file on disk is `./x.ts` or `./x.tsx`. Node and `tsc` follow that; webpack
    // does not unless told. Without this, `@vims/ui`'s barrel resolves for
    // typecheck and fails at build — the least helpful possible split.
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
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

/**
 * PWA — Phase 0 exit gate 7.
 *
 * Disabled in development because a service worker caching a hot-reloaded build
 * produces failures that look like application bugs and are not.
 */
const withSerwist = withSerwistInit({
  swSrc: 'src/app/sw.ts',
  swDest: 'public/sw.js',
  disable: process.env.NODE_ENV === 'development',
  // The offline fallback must be in the precache or it cannot be shown when
  // there is no network — which is the only time it is needed.
  additionalPrecacheEntries: [{ url: '/offline', revision: null }],
  reloadOnOnline: true,
});

export default withSerwist(config);
