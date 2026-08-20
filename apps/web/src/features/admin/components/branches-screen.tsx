'use client';

import { useQuery } from '@tanstack/react-query';
import {
  Badge,
  Button,
  EmptyState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@vims/ui';
import { Building2, MapPinned } from '@/lib/icons';
import { useState } from 'react';
import { useSession } from '@/lib/session-context';
import { getBranch, listBranches } from '../api/client';
import { adminKeys } from '../api/keys';
import { formatCount, formatTimestamp } from '../lib/format';
import { AsyncPanel } from './async-panel';
import { PageHeader } from './page-header';

/**
 * Branches (EN-041 §6).
 *
 * Read-only, and honestly so. Creating or closing a branch is `org.branch.manage`
 * and carries the onboarding workflow from EN-041 §3.9 — a configuration clone
 * and a go-live smoke test that includes an RLS-isolation check. The API has no
 * bare `POST /branches` precisely so that nobody can create a live branch that
 * has never been proved isolated, and this screen does not pretend otherwise:
 * there is no "New branch" button to press and be refused by.
 */
export function BranchesScreen(): React.JSX.Element {
  const { hospitalId, branchId } = useSession();
  const keys = adminKeys(hospitalId);
  const [openId, setOpenId] = useState<string | null>(null);

  const list = useQuery({
    queryKey: keys.branches(),
    queryFn: ({ signal }) => listBranches({ signal }),
  });

  const detail = useQuery({
    queryKey: keys.branch(openId ?? 'none'),
    queryFn: ({ signal }) => getBranch(openId ?? '', { signal }),
    enabled: openId !== null,
  });

  const branches = list.data?.items ?? [];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow="EN-041"
        title="Branches"
        description="The hospital's sites, satellites and collection centres. Every business row in the database carries the branch it belongs to, and a role grant is scoped to one — which is what makes a group deployment safe to run in a single database."
        meta={
          <Badge tone="neutral" icon={<Building2 aria-hidden="true" />}>
            {formatCount(branches.length)} in this hospital
          </Badge>
        }
      />

      <div className="flex flex-col gap-4 xl:flex-row">
        <div className="min-w-0 flex-1">
          <AsyncPanel
            loading={list.isPending}
            error={list.error}
            isEmpty={branches.length === 0}
            onRetry={() => void list.refetch()}
            skeletonLabel="Loading branches"
            skeletonRows={6}
            skeletonColumns={[2, 3, 1, 1]}
            empty={
              <EmptyState
                icon={<MapPinned />}
                cause="This hospital has no branch recorded yet."
                nextAction="Branches are created through the onboarding wizard, which runs an isolation check before go-live."
              />
            }
          >
            <div className="rounded-lg border border-default bg-layer-1">
              <Table scrollRegionLabel="Branches">
                <TableHeader>
                  <TableRow>
                    <TableHead>Code</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Kind</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Beds</TableHead>
                    <TableHead>Time zone</TableHead>
                    <TableHead>
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {branches.map((branch) => (
                    <TableRow key={branch.id} data-testid="branch-row">
                      <TableCell className="font-mono text-xs">{branch.code}</TableCell>
                      <TableCell className="font-medium">
                        {branch.name}
                        {branch.id === branchId ? (
                          <Badge tone="accent" size="sm" className="ms-2">
                            your branch
                          </Badge>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-xs">{branch.kind}</TableCell>
                      <TableCell>
                        <Badge tone={branch.status === 'live' ? 'success' : 'warning'} size="sm">
                          {branch.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs tabular-nums">{formatCount(branch.bed_count)}</TableCell>
                      <TableCell className="text-xs">{branch.timezone}</TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-expanded={openId === branch.id}
                          onClick={() => {
                            setOpenId((current) => (current === branch.id ? null : branch.id));
                          }}
                        >
                          {openId === branch.id ? 'Hide' : 'Details'}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </AsyncPanel>
        </div>

        {openId === null ? null : (
          <aside
            aria-label="Branch detail"
            className="w-full shrink-0 rounded-lg border border-default bg-layer-1 p-3 xl:w-96"
          >
            <AsyncPanel
              loading={detail.isPending}
              error={detail.error}
              isEmpty={false}
              empty={null}
              onRetry={() => void detail.refetch()}
              skeletonLabel="Loading the branch"
              skeletonRows={8}
              skeletonColumns={[2, 3]}
            >
              {detail.data === undefined ? null : (
                <>
                  <h2 className="text-lg font-semibold">{detail.data.name}</h2>
                  <p className="font-mono text-xs text-fg-muted">{detail.data.code}</p>
                  {detail.data.granted_to_caller ? null : (
                    <p
                      role="status"
                      className="mt-2 rounded-md border border-warning-border bg-warning-surface p-2 text-xs text-warning-on-surface"
                    >
                      You hold no role in this branch, so you can see that it exists but not its clinical or
                      financial data.
                    </p>
                  )}
                  <dl className="mt-3 grid gap-x-4 gap-y-1 text-sm">
                    <Row label="Short name" value={detail.data.short_name} />
                    <Row label="Module profile" value={detail.data.module_profile} />
                    <Row label="GSTIN" value={detail.data.gstin} />
                    <Row label="State code" value={detail.data.state_code} />
                    <Row label="Currency" value={detail.data.currency} />
                    <Row label="Residency zone" value={detail.data.residency_zone} />
                    <Row label="HFR ID" value={detail.data.hfr_id} />
                    <Row label="ROHINI ID" value={detail.data.rohini_id} />
                    <Row label="Went live" value={formatTimestamp(detail.data.go_live_at)} />
                    <Row label="Created" value={formatTimestamp(detail.data.created_at)} />
                  </dl>
                </>
              )}
            </AsyncPanel>
          </aside>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { readonly label: string; readonly value: string | null }): React.JSX.Element {
  return (
    <div className="flex justify-between gap-3 border-b border-default py-1 last:border-b-0">
      <dt className="text-fg-muted">{label}</dt>
      <dd className="text-end text-fg-default">{value ?? '—'}</dd>
    </div>
  );
}
