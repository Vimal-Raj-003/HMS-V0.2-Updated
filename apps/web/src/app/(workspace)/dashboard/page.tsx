import type { Metadata } from 'next';

export const metadata: Metadata = { title: "Dashboard · Vim's HMS" };

/**
 * The role home workspace.
 *
 * Deliberately empty in Phase 0. `docs/prompts/phase-00-foundation.md` exit gate
 * 3 asks that each of eight roles can sign in and see "a different, correct,
 * **empty** workspace" — the platform rails are what is being proved here, not a
 * feature. Filling this with placeholder tiles would make the gate unfalsifiable.
 */
export default function DashboardPage(): React.JSX.Element {
  return (
    <section aria-labelledby="dashboard-heading" className="mx-auto max-w-3xl">
      <h1 id="dashboard-heading" className="text-xl font-semibold tracking-tight">
        Dashboard
      </h1>
      <div className="mt-6 rounded-lg border border-control bg-surface p-8 text-center">
        <p className="font-medium">Your workspace is ready</p>
        <p className="mt-2 text-sm text-subtle">
          Clinical and administrative modules appear here as they are enabled for your hospital and
          your role.
        </p>
      </div>
    </section>
  );
}
