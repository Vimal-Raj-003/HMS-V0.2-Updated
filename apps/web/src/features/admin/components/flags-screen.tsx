'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, ConfirmWithReasonDialog, EmptyState, Input, Label, Switch, useToast } from '@vims/ui';
import { HeartPulse, Lock, ToggleLeft } from '@/lib/icons';
import { useMemo, useState } from 'react';
import { useSession } from '@/lib/session-context';
import { listFlags, putFlag } from '../api/client';
import { adminKeys } from '../api/keys';
import type { ResolvedFlag } from '../api/types';
import { formatCount, formatTimestamp } from '../lib/format';
import { AsyncPanel } from './async-panel';
import { PageHeader } from './page-header';
import { ProblemCard } from './problem-card';

/**
 * Feature flags (EN-007 §3.7, EN-040).
 *
 * Two states that look similar and are not:
 *
 *  - **Not licensed.** The toggle is rendered disabled, with the upgrade path
 *    next to it, rather than hidden. `docs/06` §6.7 hides an item the user has no
 *    *permission* for; a commercial limit is different — the administrator is
 *    entitled to know the capability exists and how to buy it, and EN-007 §3.7
 *    requires the upgrade path to be shown.
 *  - **Clinical-safety exempt.** The flag exists but no commercial state may ever
 *    turn it off (EN-040 §5). It is marked, not hidden, so that an administrator
 *    hunting for "why is this still on" finds the answer here instead of filing
 *    a bug.
 */
export function FlagsScreen(): React.JSX.Element {
  const { hospitalId } = useSession();
  const keys = adminKeys(hospitalId);
  const queryClient = useQueryClient();
  const { publish } = useToast();

  const [search, setSearch] = useState('');
  const [pending, setPending] = useState<{ readonly flag: ResolvedFlag; readonly next: boolean } | null>(
    null,
  );

  const query = useQuery({ queryKey: keys.flags(), queryFn: ({ signal }) => listFlags({ signal }) });

  const save = useMutation({
    mutationFn: putFlag,
    onSuccess: (flag) => {
      void queryClient.invalidateQueries({ queryKey: keys.flags() });
      publish({
        title: `${flag.key} ${flag.enabled ? 'enabled' : 'disabled'}`,
        severity: 'success',
      });
    },
  });

  const flags = useMemo(() => {
    const all = query.data?.items ?? [];
    const needle = search.trim().toLowerCase();
    if (needle === '') return all;
    return all.filter((flag) => `${flag.key} ${flag.description}`.toLowerCase().includes(needle));
  }, [query.data, search]);

  const licensed = flags.filter((flag) => flag.licensed).length;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow="EN-007 · EN-040"
        title="Feature flags"
        description="What this hospital has switched on, within what its licence allows. A flag can never enable a capability the plan does not carry, and it can never disable one that patient safety depends on."
        meta={
          <>
            <Badge tone="neutral" icon={<ToggleLeft aria-hidden="true" />}>
              {formatCount(flags.length)} flags
            </Badge>
            <Badge tone="accent">{formatCount(licensed)} licensed</Badge>
          </>
        }
      />

      {save.isError ? <ProblemCard error={save.error} /> : null}

      <div className="max-w-md">
        <Label htmlFor="flag-search">Search</Label>
        <Input
          id="flag-search"
          type="search"
          value={search}
          placeholder="flag key or description"
          data-testid="flag-search"
          onChange={(event) => {
            setSearch(event.target.value);
          }}
        />
      </div>

      <AsyncPanel
        loading={query.isPending}
        error={query.error}
        isEmpty={flags.length === 0}
        onRetry={() => void query.refetch()}
        skeletonLabel="Loading feature flags"
        skeletonRows={10}
        skeletonColumns={[4, 1]}
        empty={
          <EmptyState
            cause="No flag matches that search."
            nextAction="Clear the search to see every capability the platform declares."
            action={{
              label: 'Clear search',
              onSelect: () => {
                setSearch('');
              },
            }}
          />
        }
      >
        <ul className="flex flex-col gap-2" data-testid="flag-list">
          {flags.map((flag) => (
            <li
              key={flag.key}
              className="flex flex-wrap items-start gap-3 rounded-lg border border-default bg-layer-1 p-3"
            >
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm text-fg-default">{flag.key}</span>
                  <Badge tone={flag.enabled ? 'success' : 'neutral'} size="sm">
                    {flag.enabled ? 'on' : 'off'}
                  </Badge>
                  {flag.licensed ? null : (
                    <Badge tone="warning" size="sm" icon={<Lock aria-hidden="true" />}>
                      not licensed
                    </Badge>
                  )}
                  {flag.clinicalSafetyExempt ? (
                    <Badge tone="violet" size="sm" icon={<HeartPulse aria-hidden="true" />}>
                      safety-exempt
                    </Badge>
                  ) : null}
                  <Badge tone="neutral" size="sm">
                    {flag.scope}
                  </Badge>
                </p>
                <p className="mt-1 max-w-[72ch] text-sm text-fg-muted">{flag.description}</p>
                <p className="mt-1 text-xs text-fg-subtle">{flag.message}</p>
                {flag.expiresAt === null ? null : (
                  <p className="text-xs text-fg-subtle">Expires {formatTimestamp(flag.expiresAt)}</p>
                )}
                {flag.note === null ? null : <p className="text-xs text-fg-subtle">Note: {flag.note}</p>}
                {flag.licensed || flag.upgradeCta === null ? null : (
                  <p className="mt-1 text-xs text-warning-fg">{flag.upgradeCta}</p>
                )}
              </div>

              <span className="flex shrink-0 items-center gap-2">
                <Label htmlFor={`flag-${flag.key}`} className="text-sm font-normal">
                  {flag.enabled ? 'Enabled' : 'Disabled'}
                </Label>
                <Switch
                  id={`flag-${flag.key}`}
                  checked={flag.enabled}
                  disabled={!flag.licensed || save.isPending}
                  aria-describedby={`flag-${flag.key}-why`}
                  data-testid={`flag-toggle-${flag.key}`}
                  onCheckedChange={(next) => {
                    setPending({ flag, next });
                  }}
                />
                <span id={`flag-${flag.key}-why`} className="sr-only">
                  {flag.licensed
                    ? flag.description
                    : `Not available on this plan. ${flag.upgradeCta ?? 'Contact your account manager.'}`}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </AsyncPanel>

      <ConfirmWithReasonDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        labels={{
          title:
            pending === null
              ? 'Change a feature flag'
              : `${pending.next ? 'Enable' : 'Disable'} ${pending.flag.key}`,
          description:
            'A flag changes what every user of this hospital sees on their next request. The change and your reason are written to the audit log.',
          reasonLabel: 'Reason',
          reasonPlaceholder: 'Choose a reason',
          notePlaceholder: 'e.g. Pilot the queue board on the OPD block from Monday',
          confirm: 'Apply the change',
          cancel: 'Leave it as it is',
          typedValuePrompt: (expected) => `Type ${expected} to confirm`,
          reasonRequired: 'A reason is required and is kept as the flag’s note.',
          typedValueMismatch: 'The value must match exactly.',
        }}
        onConfirm={(result) => {
          const target = pending;
          setPending(null);
          if (target !== null) {
            save.mutate({ key: target.flag.key, enabled: target.next, note: result.reasonText });
          }
        }}
      />
    </div>
  );
}
