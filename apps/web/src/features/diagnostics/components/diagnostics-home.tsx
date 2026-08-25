'use client';

import { Button, EmptyState } from '@vims/ui';
import Link from 'next/link';
import { PageHeader } from '@/features/admin/components/page-header';
import { useSession } from '@/lib/session-context';
import { AREA_LABELS, DIAGNOSTICS_SCREENS, type DiagnosticsScreen } from '../screens';

/**
 * The diagnostics hub.
 *
 * It renders only the tiles this session can actually open — `docs/06` §4.1,
 * "never render an item the user cannot use" — and, when that is none, says so
 * with the specific reason rather than showing an empty page a user reads as
 * broken.
 *
 * The eight screens are held by eight different sets of hands: a phlebotomist,
 * a technologist, a pathologist, a quality officer, a prescriber, a radiologist,
 * an archive administrator and a cardiac technician. Almost no session sees all
 * eight, and that is the design rather than an accident of configuration —
 * `SEGREGATION_OF_DUTIES_RULES` actively forbids one role holding both
 * `rad.study.complete` and `rad.report.sign`.
 */
const AREA_ORDER: readonly DiagnosticsScreen['area'][] = ['lab', 'radiology', 'investigations'];

export function DiagnosticsHome(): React.JSX.Element {
  const { granted } = useSession();
  const available = DIAGNOSTICS_SCREENS.filter((screen) => granted.has(screen.permission));

  return (
    <section className="flex flex-col gap-4" data-testid="diagnostics-home">
      <PageHeader
        eyebrow="Phase 3 · diagnostics"
        title="Diagnostics"
        description="The laboratory from tube to signed report, imaging from the safety screen to the archive, and everything in between that is neither an analyzer nor a DICOM study."
      />

      {available.length === 0 ? (
        <EmptyState
          cause="None of the diagnostics screens are open to your roles."
          nextAction="Collecting a specimen, resulting it, authorising it, reading an image and reconciling the archive each carry their own permission. Ask your hospital administrator which one you need."
        />
      ) : (
        AREA_ORDER.map((area) => {
          const inArea = available.filter((screen) => screen.area === area);
          if (inArea.length === 0) return null;
          return (
            <section key={area} className="flex flex-col gap-2" data-testid={`area-${area}`}>
              <h2 className="font-display text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                {AREA_LABELS[area]}
              </h2>
              <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {inArea.map((screen) => (
                  <li
                    key={screen.key}
                    className="flex flex-col gap-2 rounded-lg border border-strong bg-layer-1 p-4"
                  >
                    <p className="text-md font-medium text-fg-default">{screen.label}</p>
                    <p className="flex-1 text-sm text-fg-muted">{screen.summary}</p>
                    <Button asChild variant="secondary" size="sm" className="self-start">
                      <Link href={screen.href}>Open {screen.label.toLowerCase()}</Link>
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })
      )}
    </section>
  );
}
