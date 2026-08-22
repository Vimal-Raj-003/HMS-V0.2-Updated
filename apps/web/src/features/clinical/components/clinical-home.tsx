'use client';

import { Button, EmptyState } from '@vims/ui';
import Link from 'next/link';
import { PageHeader } from '@/features/admin/components/page-header';
import { useSession } from '@/lib/session-context';
import { CLINICAL_SCREENS } from '../screens';

/**
 * The clinical hub.
 *
 * It renders only the tiles this session can actually open — `docs/06` §4.1,
 * "never render an item the user cannot use" — and, when that is none, says so
 * with the specific reason rather than showing an empty page a user reads as
 * broken.
 *
 * The four screens are deliberately held by four different sets of hands: the
 * vitals room is a nurse's, the consultation and the prescription a doctor's,
 * and the alert-fatigue report a governance role's. Very few sessions see all
 * four, and that is the design rather than an accident of configuration.
 */
export function ClinicalHome(): React.JSX.Element {
  const { granted } = useSession();
  const available = CLINICAL_SCREENS.filter((screen) => granted.has(screen.permission));

  return (
    <section className="flex flex-col gap-4" data-testid="clinical-home">
      <PageHeader
        eyebrow="OPD clinical"
        title="Clinical"
        description="Observations, the consultation, the prescription and the safety-alert report — the Phase-2 OPD loop."
      />

      {available.length === 0 ? (
        <EmptyState
          cause="None of the clinical screens are open to your roles."
          nextAction="Recording observations, writing a consultation, prescribing and reading the governance report each carry their own permission. Ask your hospital administrator which one you need."
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {available.map((screen) => (
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
      )}
    </section>
  );
}
