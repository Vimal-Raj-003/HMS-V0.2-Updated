'use client';

import { useQuery } from '@tanstack/react-query';
import { Badge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@vims/ui';
import { HeartPulse, ReceiptText } from '@/lib/icons';
import { useSession } from '@/lib/session-context';
import { getLicence } from '../api/client';
import { adminKeys } from '../api/keys';
import { formatCount, formatTimestamp } from '../lib/format';
import { AsyncPanel } from './async-panel';
import { PageHeader } from './page-header';

/**
 * Licence (EN-040 §6).
 *
 * Read-only, because changing a subscription belongs to the operator and every
 * deviation from a plan has to be an audited override with an approver and an
 * expiry — a different surface entirely.
 *
 * A tenant with no subscription row is not an error and is not shown as one. An
 * on-prem or pre-billing installation is legitimately unlicensed, and EN-040 §3.2
 * decides what happens: fail open for clinical capability, closed for commercial.
 * Reporting "no licence" as a failure would take a hospital offline for a
 * commercial reason, which is the one outcome EN-040 exists to prevent.
 */
export function LicenceScreen(): React.JSX.Element {
  const { hospitalId } = useSession();
  const keys = adminKeys(hospitalId);
  const query = useQuery({ queryKey: keys.licence(), queryFn: ({ signal }) => getLicence({ signal }) });
  const state = query.data;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow="EN-040"
        title="Licence"
        description="What this hospital's plan allows, which capabilities are restricted at the current degradation tier, and which keys can never be restricted at all."
        meta={
          state === undefined ? null : (
            <>
              <Badge
                tone={state.subscription === null ? 'warning' : 'success'}
                icon={<ReceiptText aria-hidden="true" />}
              >
                {state.subscription === null ? 'No subscription recorded' : state.subscription.status}
              </Badge>
              <Badge tone={state.tier.tier === 0 ? 'success' : 'warning'}>
                Tier {String(state.tier.tier)} · {state.tier.label}
              </Badge>
            </>
          )
        }
      />

      <AsyncPanel
        loading={query.isPending}
        error={query.error}
        isEmpty={false}
        empty={null}
        onRetry={() => void query.refetch()}
        skeletonLabel="Loading the licence"
        skeletonRows={8}
        skeletonColumns={[3, 2, 1]}
      >
        {state === undefined ? null : (
          <>
            {state.usingDefaults ? (
              <p
                role="status"
                className="rounded-md border border-info-border bg-info-surface p-3 text-sm text-info-on-surface"
              >
                Nothing commercial is recorded for this hospital, so every answer below is the declared
                default. That is the correct state for an on-prem or pre-billing installation — clinical
                capability stays open, commercial capability stays closed.
              </p>
            ) : null}

            <section
              aria-labelledby="tier-heading"
              className="rounded-lg border border-default bg-layer-1 p-3"
            >
              <h2 id="tier-heading" className="text-lg font-semibold">
                {state.tier.label}
              </h2>
              <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                <Pair label="Still works" value={state.tier.stillWorks} />
                <Pair label="Restricted" value={state.tier.restricted} />
                {state.subscription === null ? null : (
                  <>
                    <Pair label="Started" value={formatTimestamp(state.subscription.startsAt)} />
                    <Pair label="Ends" value={formatTimestamp(state.subscription.endsAt)} />
                    <Pair label="Grace until" value={formatTimestamp(state.subscription.graceUntil)} />
                    <Pair label="Renewal" value={state.subscription.renewalMode} />
                  </>
                )}
              </dl>
            </section>

            <section
              aria-labelledby="exempt-heading"
              className="rounded-lg border border-violet-border bg-violet-surface p-3"
            >
              <h2
                id="exempt-heading"
                className="flex items-center gap-2 text-md font-medium text-violet-on-surface"
              >
                <HeartPulse className="size-4" aria-hidden="true" />
                Never gated by commercial state
              </h2>
              <p className="mt-1 text-sm text-violet-on-surface">
                {formatCount(state.clinicalSafetyExemptKeys.length)} permission keys stay available at every
                tier, on an expired subscription, and with every feature flag off. An automated test asserts
                this set at each tier — a regression here is a patient-safety defect, not a billing one.
              </p>
              <p className="mt-2 font-mono text-xs text-violet-on-surface">
                {state.clinicalSafetyExemptKeys.join(' · ')}
              </p>
            </section>

            <section aria-labelledby="entitlements-heading">
              <h2 id="entitlements-heading" className="mb-2 text-lg font-semibold">
                Entitlements
              </h2>
              <div className="rounded-lg border border-default bg-layer-1">
                <Table scrollRegionLabel="Entitlements">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Capability</TableHead>
                      <TableHead>Allowed</TableHead>
                      <TableHead>Limit</TableHead>
                      <TableHead>Source</TableHead>
                      <TableHead>What it means</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {state.entitlements.map((entitlement) => (
                      <TableRow key={entitlement.key} data-testid="entitlement-row">
                        <TableCell className="font-mono text-xs">
                          {entitlement.key}
                          <span className="block text-3xs text-fg-muted">{entitlement.family}</span>
                        </TableCell>
                        <TableCell>
                          <Badge tone={entitlement.allowed ? 'success' : 'danger'} size="sm">
                            {entitlement.allowed ? 'allowed' : 'blocked'}
                          </Badge>
                          {entitlement.clinicalSafetyExempt ? (
                            <Badge tone="violet" size="sm" className="ms-1">
                              exempt
                            </Badge>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-xs tabular-nums">
                          {entitlement.limitValue ?? '—'}
                        </TableCell>
                        <TableCell className="text-xs">{entitlement.source}</TableCell>
                        <TableCell className="max-w-96 text-xs text-fg-muted">
                          {entitlement.message}
                          {entitlement.upgradeCta === null ? null : (
                            <span className="block text-warning-fg">{entitlement.upgradeCta}</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </section>
          </>
        )}
      </AsyncPanel>
    </div>
  );
}

function Pair({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string | null;
}): React.JSX.Element {
  return (
    <div className="flex gap-2">
      <dt className="shrink-0 text-fg-muted">{label}</dt>
      <dd className="text-fg-default">{value ?? '—'}</dd>
    </div>
  );
}
