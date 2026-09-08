'use client';

import { useQuery } from '@tanstack/react-query';
import { Badge, EmptyState } from '@vims/ui';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { useSession } from '@/lib/session-context';
import { getReferrals } from '../api/client';
import { handoffKeys } from '../api/keys';
import type { ReferralRow } from '../api/types';

/**
 * OP-021 — the referral desk.
 *
 * ── The overdue list is the screen, and everything else is below it ────────
 *
 * The commonest failure in a referral system is not a lost letter. It is a
 * referral acknowledged and never replied to, with the referrer reading
 * silence as "handled" — so a desk that opens on the full register and makes
 * you filter is a desk where the overdue ones are never seen. They open the
 * page.
 *
 * ── Acknowledged is shown, and does not stop the clock ─────────────────────
 *
 * Because that is the exact state the failure lives in: somebody has picked it
 * up, and nobody has answered.
 */
export function ReferralDesk(): React.JSX.Element {
  const { hospitalId } = useSession();
  const keys = handoffKeys(hospitalId);

  const overdue = useQuery({
    queryKey: keys.referrals('overdue'),
    queryFn: ({ signal }) => getReferrals({ overdueOnly: true }, { signal }),
    refetchInterval: 120_000,
  });

  const waiting = useQuery({
    queryKey: keys.referrals('awaiting'),
    queryFn: ({ signal }) => getReferrals({ awaitingReplyOnly: true }, { signal }),
    refetchInterval: 120_000,
  });

  const all = useQuery({
    queryKey: keys.referrals('all'),
    queryFn: ({ signal }) => getReferrals({}, { signal }),
    refetchInterval: 300_000,
  });

  const overdueRows = overdue.data ?? [];
  const overdueIds = new Set(overdueRows.map((r) => r.id));
  // Waiting but not yet overdue: still inside the clock, and worth seeing
  // separately from the ones that have run out of it.
  const waitingRows = (waiting.data ?? []).filter((r) => !overdueIds.has(r.id));
  const settled = (all.data ?? []).filter((r) => r.repliedAt !== null || r.status === 'cancelled');

  return (
    <section className="flex flex-col gap-5">
      <PageHeader
        title="Referrals"
        description="A referral is open until somebody replies. The date a reply is due comes from the urgency — four hours, forty-eight hours, fourteen days — and nobody sets it."
      />

      <section aria-label="Overdue referrals" className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Overdue</h2>
        <AsyncPanel
          loading={overdue.isPending}
          error={overdue.error}
          isEmpty={overdueRows.length === 0}
          skeletonLabel="Loading overdue referrals"
          skeletonRows={4}
          onRetry={() => void overdue.refetch()}
          empty={
            <EmptyState
              cause="Nothing is overdue."
              nextAction="Every referral raised has been answered inside its clock. The clock comes from the urgency, so nothing here needs maintaining."
            />
          }
        >
          <div className="rounded-lg border border-danger-border bg-danger-surface p-1">
            <ul className="flex flex-col gap-2 p-2">
              {overdueRows.map((row) => (
                <ReferralLine key={row.id} row={row} />
              ))}
            </ul>
          </div>
        </AsyncPanel>
      </section>

      <section aria-label="Awaiting a reply" className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Awaiting a reply</h2>
        <ul className="flex flex-col gap-2 text-sm">
          {waitingRows.map((row) => (
            <ReferralLine key={row.id} row={row} />
          ))}
          {waitingRows.length === 0 ? (
            <li className="text-xs text-fg-muted">Nothing is waiting inside its clock.</li>
          ) : null}
        </ul>
      </section>

      <section aria-label="Answered and cancelled" className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Answered and cancelled</h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[42rem] text-sm">
            <caption className="sr-only">
              Referrals that have been replied to or cancelled, most recently due first.
            </caption>
            <thead className="text-left text-xs uppercase tracking-wide text-fg-muted">
              <tr>
                <th scope="col" className="py-2">
                  Urgency
                </th>
                <th scope="col">Status</th>
                <th scope="col">Raised</th>
                <th scope="col">Reply</th>
              </tr>
            </thead>
            <tbody>
              {settled.map((row) => (
                <tr key={row.id} className="border-t border-default">
                  <td className="py-2">
                    <UrgencyChip urgency={row.urgency} />
                  </td>
                  <td>
                    {/* Cancelled is not closed, and the difference is the whole
                        point: one says somebody answered, the other says
                        nobody will. */}
                    <Badge tone={row.status === 'cancelled' ? 'neutral' : 'success'}>{row.status}</Badge>
                  </td>
                  <td className="text-xs text-fg-muted">{new Date(row.createdAt).toLocaleDateString()}</td>
                  <td className="max-w-[24rem] truncate text-xs text-fg-muted">{row.replyText ?? '—'}</td>
                </tr>
              ))}
              {settled.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-2 text-xs text-fg-muted">
                    None yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </section>
  );
}

function UrgencyChip({ urgency }: { readonly urgency: string }): React.JSX.Element {
  const tone = urgency === 'emergency' ? 'danger' : urgency === 'urgent' ? 'warning' : 'neutral';
  return <Badge tone={tone}>{urgency}</Badge>;
}

/**
 * One referral, with the clock said in the direction it is running.
 *
 * "Five hours overdue" and "in two days" are the same number with opposite
 * signs, and only one of them makes anybody pick up the phone.
 */
function ReferralLine({ row }: { readonly row: ReferralRow }): React.JSX.Element {
  const hours = Math.abs(row.hoursRemaining);
  const clock =
    row.hoursRemaining < 0
      ? hours >= 48
        ? `${String(Math.round(hours / 24))} days overdue`
        : `${String(Math.round(hours))} hours overdue`
      : hours >= 48
        ? `due in ${String(Math.round(hours / 24))} days`
        : `due in ${String(Math.round(hours))} hours`;

  return (
    <li className="flex flex-wrap items-center gap-3 rounded-md border border-default bg-layer-1 p-3">
      <UrgencyChip urgency={row.urgency} />
      <span className="flex-1 truncate">{row.reason}</span>
      {/* Acknowledged is not answered, and the clock did not stop for it. */}
      {row.acknowledgedAt !== null ? <Badge tone="neutral">acknowledged</Badge> : null}
      <Badge tone={row.overdue ? 'danger' : 'neutral'}>{clock}</Badge>
    </li>
  );
}
