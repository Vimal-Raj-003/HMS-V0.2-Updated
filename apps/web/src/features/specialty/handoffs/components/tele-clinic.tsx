'use client';

import { useQuery } from '@tanstack/react-query';
import { Badge, EmptyState } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { useSession } from '@/lib/session-context';
import { getConsults, getDrugRules } from '../api/client';
import { handoffKeys } from '../api/keys';
import type { TeleConsultRow, TeleDrugRuleRow } from '../api/types';

const LIST_LABELS: Readonly<Record<string, string>> = {
  list_o: 'List O — over the counter',
  list_a: 'List A — may be started, having seen the patient',
  list_b: 'List B — an add-on to something already running',
  prohibited: 'Prohibited — scheduled under the NDPS Act',
};

/**
 * OP-018 — the tele-clinic.
 *
 * ── The lists are shown before a drug is typed, not after ──────────────────
 *
 * A doctor who reaches for azithromycin on an audio first consultation is
 * refused by the database, correctly. But the refusal arrives after the
 * consultation has gone somewhere it cannot finish, and the honest thing is to
 * say at the top of the screen which of the four lists this consultation can
 * reach — and, when it cannot reach one, why.
 *
 * ── And the prohibited entries are shown refused, not hidden ───────────────
 *
 * A catalogue that quietly omits them teaches a doctor the drug is missing from
 * the formulary. One that shows them struck through teaches what the rule is,
 * which is the thing they need to know at 11pm on a Sunday.
 */
export function TeleClinic(): React.JSX.Element {
  const { hospitalId } = useSession();
  const keys = handoffKeys(hospitalId);
  const [selected, setSelected] = useState<string | null>(null);

  const consults = useQuery({
    queryKey: keys.consults('open'),
    queryFn: ({ signal }) => getConsults({ openOnly: true }, { signal }),
    refetchInterval: 60_000,
  });

  const rows = consults.data ?? [];
  const active = rows.find((c) => c.id === selected) ?? rows[0] ?? null;

  const rules = useQuery({
    queryKey: keys.drugRules(active?.id ?? 'none'),
    queryFn: ({ signal }) => getDrugRules(active?.id, { signal }),
    refetchInterval: 600_000,
  });

  const ruleRows = rules.data ?? [];
  const byList = ['list_o', 'list_a', 'list_b', 'prohibited'].map((code) => ({
    code,
    drugs: ruleRows.filter((r) => r.listCode === code),
  }));

  return (
    <section className="flex flex-col gap-5">
      <PageHeader
        title="Tele-clinic"
        description="Four lists decide what may be prescribed remotely. The prohibited one is absolute: nothing scheduled under the NDPS Act, in any mode, on any consultation, by anybody."
      />

      <section aria-label="Open consultations" className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Open consultations</h2>
        <AsyncPanel
          loading={consults.isPending}
          error={consults.error}
          isEmpty={rows.length === 0}
          skeletonLabel="Loading open consultations"
          skeletonRows={3}
          onRetry={() => void consults.refetch()}
          empty={
            <EmptyState
              cause="No consultation is open."
              nextAction="Start one. The mode and whether it is a first contact are recorded on it, and the drug lists read both."
            />
          }
        >
          <ul className="flex flex-col gap-2 text-sm">
            {rows.map((consult) => (
              <li key={consult.id}>
                <button
                  type="button"
                  onClick={() => {
                    setSelected(consult.id);
                  }}
                  aria-pressed={active?.id === consult.id}
                  className={`flex w-full flex-wrap items-center gap-3 rounded-md border p-3 text-left ${
                    active?.id === consult.id
                      ? 'border-accent-border bg-accent-surface'
                      : 'border-default bg-layer-1'
                  }`}
                >
                  <Badge tone={consult.mode === 'video' ? 'success' : 'neutral'}>{consult.mode}</Badge>
                  <Badge tone="neutral">{consult.firstConsult ? 'first contact' : 'follow-up'}</Badge>
                  <span className="flex-1 truncate">{consult.complaint ?? 'No complaint recorded.'}</span>
                  {consult.identityVerified ? null : <Badge tone="danger">identity not verified</Badge>}
                  <span className="text-xs text-fg-muted">{consult.prescriptionLines} prescribed</span>
                </button>
              </li>
            ))}
          </ul>
        </AsyncPanel>
      </section>

      {active === null ? null : <Reachability consult={active} />}

      <section aria-label="The four lists" className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">The four lists</h2>
        {byList.map((group) => (
          <div key={group.code} className="flex flex-col gap-1">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
              {LIST_LABELS[group.code] ?? group.code}
            </h3>
            <ul className="flex flex-wrap gap-2 text-sm">
              {group.drugs.map((drug) => (
                <DrugChip key={drug.drugKey} drug={drug} />
              ))}
              {group.drugs.length === 0 ? (
                <li className="text-xs text-fg-muted">Nothing on this list.</li>
              ) : null}
            </ul>
          </div>
        ))}
      </section>
    </section>
  );
}

/** What this consultation can reach, and why it cannot reach the rest. */
function Reachability({ consult }: { readonly consult: TeleConsultRow }): React.JSX.Element {
  return (
    <section
      aria-label="What this consultation can prescribe"
      className="rounded-lg border border-default bg-layer-1 p-4"
    >
      <h2 className="text-sm font-semibold">What this consultation can prescribe</h2>
      <ul className="mt-2 flex flex-wrap gap-2 text-sm">
        {consult.reachableLists.map((code) => (
          <li key={code}>
            <Badge tone="success">{LIST_LABELS[code] ?? code}</Badge>
          </li>
        ))}
        {consult.reachableLists.length === 0 ? (
          <li className="text-xs text-fg-danger">Nothing, until the patient&rsquo;s identity is verified.</li>
        ) : null}
      </ul>
      {consult.blockedBy.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-1 text-xs text-fg-muted">
          {consult.blockedBy.map((why) => (
            <li key={why}>{why}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function DrugChip({ drug }: { readonly drug: TeleDrugRuleRow }): React.JSX.Element {
  return (
    <li
      className={`flex items-center gap-2 rounded-md border p-2 ${
        drug.reachable ? 'border-default bg-layer-2' : 'border-danger-border bg-danger-surface'
      }`}
      title={drug.reason ?? undefined}
    >
      <span className={drug.reachable ? '' : 'line-through'}>{drug.drugName}</span>
      {drug.reachable ? null : (
        <span className="text-xs text-fg-danger">{drug.reason ?? 'out of reach'}</span>
      )}
    </li>
  );
}
