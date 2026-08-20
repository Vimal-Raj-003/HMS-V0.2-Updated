/// <reference lib="webworker" />
import { defaultCache } from '@serwist/next/worker';
import type { PrecacheEntry, SerwistGlobalConfig } from 'serwist';
import { NetworkOnly, Serwist } from 'serwist';

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}
declare const self: ServiceWorkerGlobalScope;

/**
 * The service worker — Phase 0 exit gate 7, and the foundation of the offline
 * story in `docs/01` §7.
 *
 * The single most important rule here is what is **not** cached. A nurse's
 * tablet losing Wi-Fi in a lift must show a shell and a clear offline state; it
 * must never show a stale patient record, a stale bed board or a stale drug
 * chart as though it were current. Serving a cached clinical response is worse
 * than serving nothing, because nothing is obviously nothing and stale data is
 * indistinguishable from fresh.
 *
 * So: the app shell is precached, and every authenticated API call is
 * `NetworkOnly`. Offline queuing of nurse mutations (vitals, MAR, notes) is a
 * separate mechanism with explicit conflict resolution and arrives with IP-004
 * in Phase 7 — it is deliberately not a cache.
 */
// `exactOptionalPropertyTypes` is on, so an explicitly-undefined key is not the
// same as an absent one. The manifest is injected at build time and is genuinely
// absent when the service worker is disabled in development.
const precacheEntries = self.__SW_MANIFEST;

const serwist = new Serwist({
  ...(precacheEntries === undefined ? {} : { precacheEntries }),
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [
    {
      // Never cache anything that could carry clinical or financial state, and
      // never cache authentication. An offline request here must fail so the UI
      // can say so.
      matcher: ({ url }) => url.pathname.startsWith('/api/'),
      handler: new NetworkOnly(),
    },
    ...defaultCache,
  ],
  fallbacks: {
    entries: [
      {
        url: '/offline',
        matcher: ({ request }) => request.destination === 'document',
      },
    ],
  },
});

serwist.addEventListeners();
