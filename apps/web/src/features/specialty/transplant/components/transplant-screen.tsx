'use client';

import { useQuery } from '@tanstack/react-query';
import { Badge, EmptyState } from '@vims/ui';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { useSession } from '@/lib/session-context';
import { getCycles, getDonations, getDonors, getRecipients } from '../api/client';
import { transplantKeys } from '../api/keys';
import type { DonationRow, RecipientRow } from '../api/types';

/**
 * IP-019 and OP-024 — the two registers.
 *
 * ── Donations waiting on the Authorisation Committee come first ────────────
 *
 * Because the Committee is not a hospital body. It meets on a schedule, a
 * workup begun before it has met is weeks of somebody's dialysis wasted, and
 * there is no way round it — India's transplant law exists because organs were
 * bought from people who were poor, and this is the thing standing in the way
 * of that.
 *
 * ── And the donor register shows who has already donated ───────────────────
 *
 * Once in a lifetime, and the count is the database's — so the list of
 * available donors is a fact rather than a filter somebody maintains.
 */
export function TransplantScreen(): React.JSX.Element {
  const { hospitalId } = useSession();
  const keys = transplantKeys(hospitalId);

  const recipients = useQuery({
    queryKey: keys.recipients('all'),
    queryFn: ({ signal }) => getRecipients({}, { signal }),
    refetchInterval: 300_000,
  });

  const donations = useQuery({
    queryKey: keys.donations('all'),
    queryFn: ({ signal }) => getDonations({}, { signal }),
    refetchInterval: 300_000,
  });

  const donors = useQuery({
    queryKey: keys.donors('all'),
    queryFn: ({ signal }) => getDonors({}, { signal }),
    refetchInterval: 600_000,
  });

  const cycles = useQuery({
    queryKey: keys.cycles('all'),
    queryFn: ({ signal }) => getCycles({ signal }),
    refetchInterval: 600_000,
  });

  const waiting = recipients.data ?? [];
  const all = donations.data ?? [];
  const committee = all.filter((d) => d.needsCommittee && d.committeeRef === null);
  const donorRows = donors.data ?? [];
  const cycleRows = cycles.data ?? [];

  return (
    <section className="flex flex-col gap-5">
      <PageHeader
        title="Transplant and fertility"
        description="Two registers, two statutes, and the same question in both: who may consent to what is done to a body, and what may not be bought."
      />

      {committee.length > 0 ? (
        <section
          aria-label="Donations awaiting the Authorisation Committee"
          className="rounded-lg border border-warning-border bg-warning-surface p-4"
        >
          <h2 className="text-sm font-semibold text-warning-on-surface">
            {committee.length} {committee.length === 1 ? 'donation is' : 'donations are'} waiting on the
            Authorisation Committee
          </h2>
          <p className="mt-1 text-xs text-warning-on-surface">
            The Committee is not a hospital body. It meets on a schedule, and a workup begun before it has met
            is weeks of somebody&rsquo;s dialysis wasted. There is no route round it.
          </p>
          <ul className="mt-3 flex flex-col gap-2 text-sm">
            {committee.map((donation) => (
              <li
                key={donation.id}
                className="flex flex-wrap items-center gap-3 rounded-md border border-warning-border bg-layer-1 p-3"
              >
                <Badge tone="warning">{donation.organ}</Badge>
                <span className="text-fg-muted">not a near relative under the Act</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-label="The waiting list" className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Waiting list</h2>
        <AsyncPanel
          loading={recipients.isPending}
          error={recipients.error}
          isEmpty={waiting.length === 0}
          skeletonLabel="Loading the waiting list"
          skeletonRows={5}
          onRetry={() => void recipients.refetch()}
          empty={
            <EmptyState
              cause="Nobody is listed."
              nextAction="List a recipient; a donation against them records its own authority — a relationship the Act names, or the Committee’s reference."
            />
          }
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[42rem] text-sm">
              <caption className="sr-only">
                Recipients on the transplant waiting list, longest wait first within each urgency.
              </caption>
              <thead className="text-left text-xs uppercase tracking-wide text-fg-muted">
                <tr>
                  <th scope="col" className="py-2">
                    Organ
                  </th>
                  <th scope="col">Group</th>
                  <th scope="col">Urgency</th>
                  <th scope="col">Waiting</th>
                  <th scope="col">Donations</th>
                </tr>
              </thead>
              <tbody>
                {waiting.map((row) => (
                  <tr key={row.id} className="border-t border-default">
                    <td className="py-2">{row.organ}</td>
                    <td className="font-mono text-xs">{row.bloodGroup}</td>
                    <td>
                      <UrgencyChip row={row} />
                    </td>
                    <td>{row.waitingDays} days</td>
                    <td>
                      {row.hasApprovedDonation ? (
                        <Badge tone="success">approved</Badge>
                      ) : (
                        <span className="text-fg-muted">{row.donationsRegistered}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </AsyncPanel>
      </section>

      <section aria-label="Donations" className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Donations</h2>
        <ul className="flex flex-col gap-2 text-sm">
          {all.map((donation) => (
            <DonationLine key={donation.id} donation={donation} />
          ))}
          {all.length === 0 ? <li className="text-xs text-fg-muted">None recorded.</li> : null}
        </ul>
      </section>

      <section aria-label="Gamete donors" className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Gamete donors</h2>
        <ul className="flex flex-wrap gap-2 text-sm">
          {donorRows.map((donor) => (
            <li
              key={donor.id}
              className="flex items-center gap-2 rounded-md border border-default bg-layer-1 p-2"
            >
              <span className="font-mono text-xs">{donor.bankDonorRef}</span>
              <span className="text-fg-muted">{donor.gamete}</span>
              {/* Once in a lifetime, counted by the database. */}
              <Badge tone={donor.available ? 'success' : 'neutral'}>
                {donor.available ? 'available' : 'donated'}
              </Badge>
            </li>
          ))}
          {donorRows.length === 0 ? <li className="text-xs text-fg-muted">None registered.</li> : null}
        </ul>
      </section>

      <section aria-label="Cycles" className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Cycles</h2>
        <ul className="flex flex-col gap-1 text-sm">
          {cycleRows.map((cycle) => (
            <li key={cycle.id} className="flex flex-wrap items-center gap-3">
              <span className="font-mono text-xs">cycle {cycle.cycleNo}</span>
              <span>{cycle.technique.replace(/_/gu, ' ')}</span>
              {cycle.embryosTransferred === null ? null : (
                <Badge tone="neutral">{cycle.embryosTransferred} transferred</Badge>
              )}
              {cycle.outcome === null ? null : (
                <Badge tone={cycle.outcome === 'live_birth' ? 'success' : 'neutral'}>
                  {cycle.outcome.replace(/_/gu, ' ')}
                </Badge>
              )}
              {cycle.blockedBy.length > 0 ? (
                <span className="text-xs text-fg-danger">{cycle.blockedBy.join('; ')}</span>
              ) : null}
            </li>
          ))}
          {cycleRows.length === 0 ? <li className="text-xs text-fg-muted">None open.</li> : null}
        </ul>
      </section>
    </section>
  );
}

function UrgencyChip({ row }: { readonly row: RecipientRow }): React.JSX.Element {
  const tone = row.urgency === 'super_urgent' ? 'danger' : row.urgency === 'urgent' ? 'warning' : 'neutral';
  return <Badge tone={tone}>{row.urgency.replace(/_/gu, ' ')}</Badge>;
}

/**
 * A donation, with the authority it rests on written out.
 *
 * "Brother" and "Authorisation Committee AC/KA/2026/318" are the two lawful
 * answers, and a reader should be able to see which one this is without
 * opening anything.
 */
function DonationLine({ donation }: { readonly donation: DonationRow }): React.JSX.Element {
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-md border border-default bg-layer-1 p-3">
      <Badge tone="neutral">{donation.organ}</Badge>
      {donation.relationship === null ? null : <Badge tone="success">{donation.relationship}</Badge>}
      {donation.committeeRef === null ? null : (
        <Badge tone="success">committee {donation.committeeRef}</Badge>
      )}
      <span className="text-fg-muted">{donation.donorType.replace(/_/gu, ' ')}</span>
      {donation.blockedBy.length > 0 ? (
        <span className="text-xs text-fg-danger">{donation.blockedBy.join('; ')}</span>
      ) : (
        <Badge tone="success">authority complete</Badge>
      )}
    </li>
  );
}
