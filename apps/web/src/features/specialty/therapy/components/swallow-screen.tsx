'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, EmptyState } from '@vims/ui';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { useSession } from '@/lib/session-context';
import { acknowledgeSwallowOrder, getSwallowOrders } from '../api/client';
import { therapyKeys } from '../api/keys';
import type { SwallowOrderRow } from '../api/types';

/**
 * OP-035 — the swallow orders board.
 *
 * ── This screen exists for the gap between writing and knowing ─────────────
 *
 * A speech therapist assesses at eleven and writes level 4 fluids. The tray
 * arriving at twelve was plated at ten. Nothing about what the patient is
 * handed changes until the kitchen and the ward have both said they have read
 * the order — so the board's top half is the orders that are *not yet in
 * force*, and the two acknowledgement buttons are the only thing on it.
 *
 * ── The summary is words, not two numbers ──────────────────────────────────
 *
 * IDDSI numbers food 3–7 and drinks 0–4, and "level 4" means pureed food *and*
 * extremely thick fluid depending on which column you are reading. The server
 * spells both out; the screen shows the sentence first and the numbers after,
 * because the person about to hand somebody a glass of water is reading a
 * banner.
 *
 * ── One button each, and never both from one person ────────────────────────
 *
 * The kitchen's button and the ward's are separate calls, and the server
 * refuses the same person doing both. Reading a piece of paper twice does not
 * mean two departments changed what they are doing.
 */
export function SwallowScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = therapyKeys(hospitalId);
  const qc = useQueryClient();

  const canAcknowledge = granted.has('slp.swallow_order.acknowledge');

  const waiting = useQuery({
    queryKey: keys.swallowOrders('awaiting'),
    queryFn: ({ signal }) => getSwallowOrders({ awaitingAckOnly: true }, { signal }),
    refetchInterval: 30_000,
  });

  const all = useQuery({
    queryKey: keys.swallowOrders('all'),
    queryFn: ({ signal }) => getSwallowOrders({}, { signal }),
    refetchInterval: 120_000,
  });

  const acknowledge = useMutation({
    mutationFn: (input: { id: string; party: 'kitchen' | 'ward' }) =>
      acknowledgeSwallowOrder(input.id, input.party),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.swallowOrdersRoot() });
    },
  });

  const pending = waiting.data ?? [];
  const rows = all.data ?? [];

  return (
    <section className="flex flex-col gap-5">
      <PageHeader
        title="Swallow orders"
        description="What each patient may safely eat and drink — and which orders the kitchen and the ward have not read yet."
      />

      {pending.length > 0 ? (
        <section
          aria-label="Orders not yet in force"
          className="rounded-lg border border-warning-border bg-warning-surface p-4"
        >
          <h2 className="text-sm font-semibold text-warning-on-surface">
            {pending.length} {pending.length === 1 ? 'order is' : 'orders are'} not in force yet
          </h2>
          <p className="mt-1 text-xs text-warning-on-surface">
            Nothing about what these patients are handed changes until the kitchen and the ward have both read
            the order. The tray being plated right now was decided before it existed.
          </p>
          <ul className="mt-3 flex flex-col gap-2">
            {pending.map((order) => (
              <li key={order.id} className="rounded-md border border-warning-border bg-layer-1 p-3">
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  <span className="font-semibold">{order.summary}</span>
                  <IddsiChips order={order} />
                  <span className="font-mono text-xs text-fg-muted">
                    written {new Date(order.effectiveFrom).toLocaleString()}
                  </span>
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <AckState label="Kitchen" at={order.ackKitchenAt} />
                  <AckState label="Ward" at={order.ackWardAt} />
                </div>

                {canAcknowledge ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {order.awaitingKitchen ? (
                      <Button
                        size="sm"
                        disabled={acknowledge.isPending}
                        onClick={() => acknowledge.mutate({ id: order.id, party: 'kitchen' })}
                      >
                        Kitchen has read it
                      </Button>
                    ) : null}
                    {order.awaitingWard ? (
                      <Button
                        size="sm"
                        disabled={acknowledge.isPending}
                        onClick={() => acknowledge.mutate({ id: order.id, party: 'ward' })}
                      >
                        Ward has read it
                      </Button>
                    ) : null}
                  </div>
                ) : (
                  <p className="mt-2 text-xs text-fg-muted">
                    Acknowledging is held by the kitchen and the ward — the two places a tray is decided.
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <AsyncPanel
        loading={all.isPending}
        error={all.error}
        isEmpty={rows.length === 0}
        skeletonLabel="Loading swallow orders"
        skeletonRows={6}
        onRetry={() => void all.refetch()}
        empty={
          <EmptyState
            cause="No swallow order has been written."
            nextAction="A speech therapist writes one from a swallow assessment; it names a food level and a fluid level, or nil by mouth."
          />
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[48rem] text-sm">
            <caption className="sr-only">
              Swallow orders. An order is in force only once the kitchen and the ward have both acknowledged
              it.
            </caption>
            <thead className="text-left text-xs uppercase tracking-wide text-fg-muted">
              <tr>
                <th scope="col" className="py-2">
                  Written
                </th>
                <th scope="col">What they may have</th>
                <th scope="col">Levels</th>
                <th scope="col">Kitchen</th>
                <th scope="col">Ward</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((order) => (
                <tr key={order.id} className="border-t border-default">
                  <td className="py-2 font-mono text-xs">{new Date(order.effectiveFrom).toLocaleString()}</td>
                  <td className="font-medium">{order.summary}</td>
                  <td>
                    <IddsiChips order={order} />
                  </td>
                  <td>
                    <AckState label="" at={order.ackKitchenAt} />
                  </td>
                  <td>
                    <AckState label="" at={order.ackWardAt} />
                  </td>
                  <td>
                    <Badge
                      tone={order.inForce ? 'success' : order.status === 'pending' ? 'warning' : 'neutral'}
                    >
                      {order.inForce ? 'in force' : order.status}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AsyncPanel>
    </section>
  );
}

/**
 * The two numbers, after the sentence.
 *
 * Both are always shown, even for nil by mouth where there are none — an empty
 * pair is a fact, and a missing pair reads as a screen that did not load.
 */
function IddsiChips({ order }: { readonly order: SwallowOrderRow }): React.JSX.Element {
  if (order.npo) return <Badge tone="danger">nil by mouth</Badge>;
  return (
    <span className="flex flex-wrap gap-1">
      <Badge tone="neutral" size="sm">
        food {order.foodLevel ?? '—'}
      </Badge>
      <Badge tone="neutral" size="sm">
        fluid {order.fluidLevel ?? '—'}
      </Badge>
    </span>
  );
}

function AckState({ label, at }: { readonly label: string; readonly at: string | null }): React.JSX.Element {
  if (at === null) {
    return (
      <Badge tone="warning" size="sm">
        {label === '' ? 'not read' : `${label}: not read`}
      </Badge>
    );
  }
  return (
    <span className="text-xs text-fg-muted">
      {label === '' ? '' : `${label}: `}
      read {new Date(at).toLocaleTimeString()}
    </span>
  );
}
