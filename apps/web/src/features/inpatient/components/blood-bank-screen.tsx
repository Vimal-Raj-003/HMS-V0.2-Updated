'use client';

import { useQuery } from '@tanstack/react-query';
import { Badge, EmptyState } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { useSession } from '@/lib/session-context';
import { getBloodInventory } from '../api/client';
import { ipKeys } from '../api/keys';
import type { BloodUnitRow } from '../api/types';

const selectClass = 'h-10 rounded-md border border-control bg-layer-1 px-3 text-sm text-fg-default';

const GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] as const;

/**
 * IP-007 — the fridge.
 *
 * ── Expiry is a number of days, not a date ──────────────────────────────────
 *
 * Platelets last five days. A list of dates makes the reader subtract; a list
 * of days sorts itself, and the unit about to be wasted is at the top without
 * anybody deciding it should be.
 *
 * ── A unit in quarantine says which screen is outstanding ───────────────────
 *
 * "Quarantined" tells the technician nothing they can act on. "HCV" tells them
 * which result to chase.
 */
export function BloodBankScreen(): React.JSX.Element {
  const { hospitalId } = useSession();
  const keys = ipKeys(hospitalId);
  const [group, setGroup] = useState('');
  const [availableOnly, setAvailableOnly] = useState(true);

  const inventory = useQuery({
    queryKey: keys.bloodInventory(`${group}|${String(availableOnly)}`),
    queryFn: ({ signal }) =>
      getBloodInventory({ ...(group === '' ? {} : { bloodGroup: group }), availableOnly }, { signal }),
    refetchInterval: 120_000,
  });

  const rows: readonly BloodUnitRow[] = [...(inventory.data?.items ?? [])].sort(
    (a, b) => a.daysToExpiry - b.daysToExpiry,
  );
  const expiringSoon = rows.filter((u) => u.daysToExpiry <= 3 && u.daysToExpiry >= 0).length;
  const expired = rows.filter((u) => u.daysToExpiry < 0).length;
  const excursions = rows.filter((u) => u.temperatureExcursion).length;

  return (
    <section className="flex flex-col gap-5">
      <PageHeader
        title="Blood bank"
        description="What is in the fridge, by group and component, closest to expiry first."
      />

      <div className="flex flex-wrap items-end gap-3">
        {expired > 0 ? <Badge tone="danger">{`${String(expired)} expired`}</Badge> : null}
        {expiringSoon > 0 ? (
          <Badge tone="warning">{`${String(expiringSoon)} expiring within three days`}</Badge>
        ) : null}
        {excursions > 0 ? (
          <Badge tone="danger">{`${String(excursions)} with a temperature excursion`}</Badge>
        ) : null}
        <div className="flex flex-col gap-1">
          <label className="text-2xs uppercase tracking-[0.08em] text-fg-subtle" htmlFor="bb-group">
            Group
          </label>
          <select
            id="bb-group"
            className={selectClass}
            value={group}
            onChange={(e) => {
              setGroup(e.target.value);
            }}
          >
            <option value="">Every group</option>
            {GROUPS.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        </div>
        <label className="flex min-h-12 items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-5"
            checked={availableOnly}
            onChange={(e) => {
              setAvailableOnly(e.target.checked);
            }}
          />
          Only units that can be issued
        </label>
      </div>

      <AsyncPanel
        loading={inventory.isPending}
        error={inventory.error}
        isEmpty={rows.length === 0}
        skeletonLabel="Loading the inventory"
        skeletonRows={8}
        onRetry={() => {
          void inventory.refetch();
        }}
        empty={
          <EmptyState
            cause={availableOnly ? 'No unit is available for issue.' : 'The register is empty.'}
            nextAction={
              availableOnly
                ? 'Clear the filter to see what is in quarantine and what is reserved.'
                : 'Book units in as they are collected or received.'
            }
          />
        }
      >
        <div className="overflow-x-auto rounded-lg border border-strong bg-layer-1">
          <table className="w-full text-sm" data-testid="blood-inventory">
            <caption className="sr-only">Blood inventory</caption>
            <thead>
              <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                {['Unit', 'Group', 'Component', 'Volume', 'Expires', 'State', 'Screening', 'Location'].map(
                  (h) => (
                    <th key={h} scope="col" className="px-3 py-2 text-start">
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.id} className="border-b border-default last:border-0" data-testid={`unit-${u.id}`}>
                  <td className="px-3 py-2 font-mono text-2xs">{u.unitNo}</td>
                  <td className="px-3 py-2">
                    <Badge tone="neutral">{u.bloodGroup}</Badge>
                  </td>
                  <td className="px-3 py-2 text-2xs">{u.component.replace(/_/gu, ' ')}</td>
                  <td className="px-3 py-2 font-mono text-2xs">{u.volumeMl} ml</td>
                  <td className="px-3 py-2">
                    {u.daysToExpiry < 0 ? (
                      <Badge tone="danger">expired</Badge>
                    ) : u.daysToExpiry <= 3 ? (
                      <Badge tone="warning">{`${String(u.daysToExpiry)} d`}</Badge>
                    ) : (
                      <span className="font-mono text-2xs">{`${String(u.daysToExpiry)} d`}</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={u.state === 'available' ? 'success' : 'neutral'}>{u.state}</Badge>
                    {u.temperatureExcursion ? (
                      <div className="mt-1">
                        <Badge tone="danger">cold chain broken</Badge>
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-2xs">
                    {u.ttiPending.length === 0 ? (
                      <span className="text-fg-success">clear</span>
                    ) : (
                      <span className="text-fg-warning">{u.ttiPending.join(', ')}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-2xs text-fg-muted">{u.storageLocation ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AsyncPanel>

      <p className="text-2xs text-fg-subtle">
        A unit leaves quarantine only when all five screens read non-reactive, and it is issued only on two
        agreeing group samples drawn by two different people. At the bedside, two nurses scan the wristband
        and the bag before the first drop — none of those can be skipped, deferred or configured away.
      </p>
    </section>
  );
}
