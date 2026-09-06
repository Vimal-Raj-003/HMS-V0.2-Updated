'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, EmptyState } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';
import {
  attachDeviceResult,
  cancelDeviceOrder,
  getConsole,
  getDeviceOrders,
  orderDeviceResult,
  reviewDeviceResult,
} from '../api/client';
import { specialtyKeys } from '../api/keys';
import type { DeviceOrderRow } from '../api/types';

const inputClass = 'h-10 w-full rounded-md border border-control bg-layer-1 px-3 text-sm text-fg-default';

const SIDE_WORDS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  OPHTHA: { right: 'OD', left: 'OS', bilateral: 'OU', not_applicable: '—' },
};

/**
 * The one investigations pane, shared by every console (OP-025 §0.3).
 *
 * ── Ordered, performed, attached, reviewed ──────────────────────────────────
 *
 * Four states and one path. An OCT, an ECG and an audiogram all arrive here,
 * and all of them stay "unread" until a clinician says otherwise. The badge is
 * amber rather than grey on purpose: a result nobody has opened looks, in every
 * other system, exactly like one that has been seen and found normal.
 *
 * ── The side is shown in the specialty's own words ──────────────────────────
 *
 * Stored as left/right/bilateral, rendered as OD/OS/OU for an eye. An
 * ophthalmologist reading "left" instead of OS on a list re-reads it, and
 * re-reading a side under time pressure is where wrong-site errors live.
 */
export function InvestigationsPane({
  consoleCode,
  encounterId,
  patientId,
}: {
  readonly consoleCode: string;
  readonly encounterId: string;
  readonly patientId: string;
}): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = specialtyKeys(hospitalId);
  const client = useQueryClient();

  const [typeCode, setTypeCode] = useState('');
  const [side, setSide] = useState('not_applicable');
  const [studyUid, setStudyUid] = useState<Record<string, string>>({});

  const detail = useQuery({
    queryKey: keys.console(consoleCode),
    queryFn: ({ signal }) => getConsole(consoleCode, { signal }),
  });

  const orders = useQuery({
    queryKey: keys.orders(encounterId),
    queryFn: ({ signal }) => getDeviceOrders({ encounterId }, { signal }),
    refetchInterval: 60_000,
  });

  function invalidate(): void {
    void client.invalidateQueries({ queryKey: keys.ordersRoot() });
    void client.invalidateQueries({ queryKey: keys.worklistRoot() });
  }

  const order = useMutation({
    mutationFn: () => orderDeviceResult({ patientId, encounterId, deviceResultTypeCode: typeCode, side }),
    onSuccess: () => {
      setTypeCode('');
      setSide('not_applicable');
      invalidate();
    },
  });

  const attach = useMutation({
    mutationFn: (input: { readonly id: string; readonly uid: string }) =>
      attachDeviceResult(input.id, { pacsStudyUid: input.uid }),
    onSuccess: invalidate,
  });

  const review = useMutation({
    mutationFn: (id: string) => reviewDeviceResult(id),
    onSuccess: invalidate,
  });

  const cancel = useMutation({
    mutationFn: (input: { readonly id: string; readonly reason: string }) =>
      cancelDeviceOrder(input.id, input.reason),
    onSuccess: invalidate,
  });

  const rows: readonly DeviceOrderRow[] = orders.data ?? [];
  const types = (detail.data?.deviceTypes ?? []).filter((t) => t.active);
  const chosen = types.find((t) => t.code === typeCode);
  const words = SIDE_WORDS[consoleCode] ?? {
    right: 'Right',
    left: 'Left',
    bilateral: 'Both',
    not_applicable: '—',
  };

  return (
    <section className="flex flex-col gap-4">
      {granted.has('device.result.order') && types.length > 0 ? (
        <div className="flex flex-wrap items-end gap-3 rounded-lg border border-strong bg-layer-1 p-3">
          <div className="flex w-64 flex-col gap-1">
            <label className="text-2xs uppercase tracking-[0.08em] text-fg-subtle" htmlFor="inv-type">
              Order
            </label>
            <select
              id="inv-type"
              className={inputClass}
              value={typeCode}
              onChange={(e) => {
                setTypeCode(e.target.value);
              }}
            >
              <option value="">Choose an investigation</option>
              {types.map((t) => (
                <option key={t.code} value={t.code}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          {chosen?.sideRequired === true ? (
            <div className="flex w-40 flex-col gap-1">
              <label className="text-2xs uppercase tracking-[0.08em] text-fg-subtle" htmlFor="inv-side">
                Side
              </label>
              <select
                id="inv-side"
                className={inputClass}
                value={side}
                onChange={(e) => {
                  setSide(e.target.value);
                }}
              >
                <option value="not_applicable">Choose</option>
                <option value="right">{words['right']}</option>
                <option value="left">{words['left']}</option>
                <option value="bilateral">{words['bilateral']}</option>
              </select>
            </div>
          ) : null}
          <Button
            size="sm"
            disabled={
              order.isPending ||
              typeCode === '' ||
              (chosen?.sideRequired === true && side === 'not_applicable')
            }
            onClick={() => {
              order.mutate();
            }}
          >
            Order
          </Button>
        </div>
      ) : null}

      {order.error === null ? null : <ProblemCard error={order.error} />}
      {attach.error === null ? null : <ProblemCard error={attach.error} />}
      {review.error === null ? null : <ProblemCard error={review.error} />}
      {cancel.error === null ? null : <ProblemCard error={cancel.error} />}

      <AsyncPanel
        loading={orders.isPending}
        error={orders.error}
        isEmpty={rows.length === 0}
        skeletonLabel="Loading investigations"
        skeletonRows={4}
        onRetry={() => {
          void orders.refetch();
        }}
        empty={
          <EmptyState
            cause="Nothing has been ordered for this visit."
            nextAction="Order what you need; the technician's queue picks it up from here."
          />
        }
      >
        <div className="overflow-x-auto rounded-lg border border-strong bg-layer-1">
          <table className="w-full text-sm" data-testid="investigations">
            <caption className="sr-only">Investigations for this visit</caption>
            <thead>
              <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                {['Investigation', 'Side', 'State', 'Result', ''].map((h) => (
                  <th key={h} scope="col" className="px-3 py-2 text-start">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-default last:border-0" data-testid={`inv-${r.id}`}>
                  <td className="px-3 py-2 font-medium">
                    {r.deviceResultTypeName ?? r.deviceResultTypeCode}
                  </td>
                  <td className="px-3 py-2 font-mono text-2xs">{words[r.side] ?? r.side}</td>
                  <td className="px-3 py-2">
                    {r.status === 'cancelled' ? (
                      <Badge tone="neutral">cancelled</Badge>
                    ) : r.reviewedAt !== null ? (
                      <Badge tone="success">read</Badge>
                    ) : r.status === 'attached' ? (
                      <Badge tone={r.reviewOverdue ? 'danger' : 'warning'}>
                        {r.minutesUnreviewed === null
                          ? 'unread'
                          : `unread ${String(r.minutesUnreviewed)} min`}
                      </Badge>
                    ) : (
                      <Badge tone="neutral">{r.status}</Badge>
                    )}
                  </td>
                  <td className="px-3 py-2 text-2xs text-fg-muted">
                    {r.pacsStudyUid ?? (r.parsed === null ? '—' : 'parsed')}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      {granted.has('device.result.attach') &&
                      r.status !== 'cancelled' &&
                      r.attachedAt === null ? (
                        <>
                          <input
                            className="h-9 w-52 rounded-md border border-control bg-layer-1 px-2 text-2xs"
                            aria-label={`Study reference for ${r.deviceResultTypeCode}`}
                            placeholder="Study or file reference"
                            value={studyUid[r.id] ?? ''}
                            onChange={(e) => {
                              setStudyUid({ ...studyUid, [r.id]: e.target.value });
                            }}
                          />
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={attach.isPending || (studyUid[r.id] ?? '').trim() === ''}
                            onClick={() => {
                              attach.mutate({ id: r.id, uid: (studyUid[r.id] ?? '').trim() });
                            }}
                          >
                            Attach
                          </Button>
                        </>
                      ) : null}
                      {granted.has('device.result.review') &&
                      r.status === 'attached' &&
                      r.reviewedAt === null ? (
                        <Button
                          size="sm"
                          disabled={review.isPending}
                          onClick={() => {
                            review.mutate(r.id);
                          }}
                        >
                          Mark read
                        </Button>
                      ) : null}
                      {granted.has('device.result.cancel') &&
                      r.status !== 'cancelled' &&
                      r.reviewedAt === null ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={cancel.isPending}
                          onClick={() => {
                            cancel.mutate({
                              id: r.id,
                              reason: 'Cancelled from the console before the study was performed',
                            });
                          }}
                        >
                          Cancel
                        </Button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AsyncPanel>

      <p className="text-2xs text-fg-subtle">
        A result stays unread until a clinician marks it so, and the person who attached it cannot be that
        clinician. Cancelling an order before it is billed voids its charge; once it is on a bill it is
        reversed by billing instead.
      </p>
    </section>
  );
}
