'use client';

import { SerwistProvider } from '@serwist/next/react';

/**
 * Registers the service worker.
 *
 * `@serwist/next` bundles the worker at build time but does **not** register it
 * — that is this component's job. Without it `/sw.js` is served and never
 * installed, so the app looks like a PWA to a code reviewer and behaves like an
 * ordinary website to a nurse whose tablet has just lost Wi-Fi.
 *
 * Disabled in development, where a worker caching a hot-reloaded build produces
 * failures that look like application bugs and are not.
 */
export function ServiceWorkerProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <SerwistProvider swUrl="/sw.js" disable={process.env.NODE_ENV === 'development'} register reloadOnOnline>
      {children}
    </SerwistProvider>
  );
}
