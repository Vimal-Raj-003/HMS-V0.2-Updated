import type { Metadata } from 'next';

export const metadata: Metadata = { title: "Offline · Vim's HMS" };

/**
 * Shown when a navigation is attempted with no network.
 *
 * It states plainly that data is not current. `docs/01` §7 allows a degraded
 * mode; it does not allow a screen that looks normal while showing nothing
 * recent. The wording matters clinically: a nurse must not read this page and
 * conclude that the absence of an alert means there is no alert.
 */
export default function OfflinePage(): React.JSX.Element {
  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight">You are offline</h1>
        <p className="mt-3 text-sm text-fg-subtle">
          Vim&rsquo;s HMS cannot reach the hospital network. Nothing on this screen is current.
        </p>
        <p className="mt-3 text-sm text-fg-subtle">
          Patient records, orders and alerts are <strong>not</strong> being shown. If you are waiting
          on a critical result or an alert, use the ward telephone — do not assume that no news is
          good news.
        </p>
        <p className="mt-6 text-sm text-fg-subtle">
          This page recovers automatically when the connection returns.
        </p>
      </div>
    </main>
  );
}
