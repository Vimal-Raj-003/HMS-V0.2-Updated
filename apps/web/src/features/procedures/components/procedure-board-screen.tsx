'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, EmptyState } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';
import {
  completeProcedure,
  confirmTimeout,
  getOrder,
  getOrders,
  overrideChecklist,
  recordRecovery,
  signProcedure,
  startProcedure,
} from '../api/client';
import { procedureKeys } from '../api/keys';
import type { OrderRow } from '../api/types';

const input = 'h-10 w-full rounded-md border border-control bg-layer-1 px-3 text-sm text-fg-default';

/**
 * OP-010 — the procedure board.
 *
 * ── The blockers are on the row, not behind a refusal ───────────────────────
 *
 * A list that says "consent not signed" before anybody walks the patient into
 * the room is worth more than a refusal at the door. The three chips are
 * computed by the server from the same facts the database trigger reads, so the
 * board and the refusal cannot tell different stories.
 *
 * ── Two buttons, and one of them does not exist ─────────────────────────────
 *
 * The checklist has an override; consent has none. There is no control here for
 * proceeding without a signature because there is no such act — OP-010 §5, and
 * the database agrees.
 *
 * ── The time-out asks for the second person by name ─────────────────────────
 *
 * Whoever is signed in is the first confirmer. The field is for the person
 * standing beside them, and the server refuses it when the two are the same.
 */
export function ProcedureBoardScreen(): React.JSX.Element {
  const { hospitalId, granted, userId } = useSession();
  const keys = procedureKeys(hospitalId);
  const client = useQueryClient();

  const [openOnly, setOpenOnly] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [secondPerson, setSecondPerson] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
  const [findings, setFindings] = useState('');
  const [aldrete, setAldrete] = useState('');
  const [escort, setEscort] = useState('');

  const orders = useQuery({
    queryKey: keys.orders(String(openOnly)),
    queryFn: ({ signal }) => getOrders({ openOnly }, { signal }),
    refetchInterval: 60_000,
  });

  const detail = useQuery({
    queryKey: keys.order(openId ?? 'none'),
    queryFn: ({ signal }) => getOrder(openId ?? '', { signal }),
    enabled: openId !== null,
  });

  function invalidate(): void {
    void client.invalidateQueries({ queryKey: keys.ordersRoot() });
    if (openId !== null) void client.invalidateQueries({ queryKey: keys.order(openId) });
  }

  const timeout = useMutation({
    mutationFn: () => confirmTimeout(openId ?? '', secondPerson.trim()),
    onSuccess: () => {
      setSecondPerson('');
      invalidate();
    },
  });

  const override = useMutation({
    mutationFn: () => overrideChecklist(openId ?? '', overrideReason.trim()),
    onSuccess: () => {
      setOverrideReason('');
      invalidate();
    },
  });

  const start = useMutation({
    mutationFn: (anaesthesia: string) => startProcedure(openId ?? '', { anaesthesia }),
    onSuccess: invalidate,
  });

  const complete = useMutation({
    mutationFn: (procedureId: string) =>
      completeProcedure(procedureId, { findings: findings.trim(), outcome: 'completed' }),
    onSuccess: () => {
      setFindings('');
      invalidate();
    },
  });

  const sign = useMutation({
    mutationFn: (procedureId: string) => signProcedure(procedureId),
    onSuccess: invalidate,
  });

  const discharge = useMutation({
    mutationFn: (procedureId: string) =>
      recordRecovery(procedureId, {
        aldreteScore: Number(aldrete),
        escortName: escort.trim(),
        discharge: true,
      }),
    onSuccess: () => {
      setAldrete('');
      setEscort('');
      invalidate();
    },
  });

  const rows: readonly OrderRow[] = orders.data ?? [];
  const open = detail.data;
  const live = open?.procedures.find((p) => p.signedAt === null);

  return (
    <section className="flex flex-col gap-5">
      <PageHeader
        title="Procedures"
        description="What is booked, what is ready, and what each case is still waiting on before anybody is in the room."
      />

      <label className="flex min-h-12 w-fit items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-5"
          checked={openOnly}
          onChange={(e) => {
            setOpenOnly(e.target.checked);
          }}
        />
        Only cases still open
      </label>

      <AsyncPanel
        loading={orders.isPending}
        error={orders.error}
        isEmpty={rows.length === 0}
        skeletonLabel="Loading the procedure board"
        skeletonRows={6}
        onRetry={() => {
          void orders.refetch();
        }}
        empty={
          <EmptyState
            cause={openOnly ? 'No procedure is open.' : 'Nothing has been ordered.'}
            nextAction="Procedures are ordered from a consultation or a console; they appear here for the room that will do them."
          />
        }
      >
        <div className="overflow-x-auto rounded-lg border border-strong bg-layer-1">
          <table className="w-full text-sm" data-testid="procedure-board">
            <caption className="sr-only">Procedure board</caption>
            <thead>
              <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                {['Number', 'Procedure', 'Side', 'From', 'State', 'Waiting on', ''].map((h) => (
                  <th key={h} scope="col" className="px-3 py-2 text-start">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => (
                <tr
                  key={o.id}
                  className={`border-b border-default last:border-0 ${openId === o.id ? 'bg-layer-2' : ''}`}
                  data-testid={`proc-${o.id}`}
                >
                  <td className="px-3 py-2 font-mono text-2xs">{o.orderNo}</td>
                  <td className="px-3 py-2">
                    <span className="font-medium">{o.procedureName}</span>
                    {o.category === 'invasive' ? (
                      <Badge tone="warning" className="ms-2">
                        invasive
                      </Badge>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-2xs">
                    {o.side === 'not_applicable' ? (o.siteText ?? '—') : o.side}
                  </td>
                  <td className="px-3 py-2 text-2xs text-fg-muted">{o.sourceModule ?? '—'}</td>
                  <td className="px-3 py-2 text-2xs">{o.status.replace(/_/gu, ' ')}</td>
                  <td className="px-3 py-2">
                    {o.readyToStart ? (
                      <Badge tone="success">ready</Badge>
                    ) : (
                      <ul className="flex flex-col gap-1 text-2xs text-fg-warning">
                        {o.blockers.map((b) => (
                          <li key={b}>{b}</li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setOpenId(o.id);
                      }}
                    >
                      Open
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AsyncPanel>

      {open === undefined ? null : (
        <div className="flex flex-col gap-4 rounded-lg border border-strong bg-layer-1 p-4">
          <h2 className="text-base font-semibold text-fg-default">
            {`${open.order.orderNo} · ${open.order.procedureName}`}
          </h2>

          <ul className="flex flex-col gap-1 text-sm" data-testid="procedure-gates">
            {(
              [
                [
                  'Consent signed',
                  !open.order.requiresConsent || open.order.consentId !== null,
                  'No override exists for this one.',
                ],
                [
                  'Time-out confirmed by two people',
                  open.order.category !== 'invasive' || open.timeouts.length > 0,
                  'Right patient, right procedure, right side, consent seen, allergies known.',
                ],
                [
                  'Checklist complete or overridden',
                  open.checklists.every(
                    (c) => c.ready || (c.overrideReason !== null && c.overrideBy !== null),
                  ),
                  'It can be overridden — not silently.',
                ],
              ] as const
            ).map(([label, done, note]) => (
              <li key={label} className="flex items-center gap-2">
                <Badge tone={done ? 'success' : 'warning'}>{done ? 'done' : 'outstanding'}</Badge>
                <span>{label}</span>
                <span className="text-2xs text-fg-subtle">{note}</span>
              </li>
            ))}
          </ul>

          {granted.has('procedure.timeout.confirm') && open.timeouts.length === 0 ? (
            <div className="flex flex-wrap items-end gap-3 border-t border-default pt-4">
              <div className="flex w-80 flex-col gap-1">
                <label className="text-2xs uppercase tracking-[0.08em] text-fg-subtle" htmlFor="tw-second">
                  Second person confirming (not you)
                </label>
                <input
                  id="tw-second"
                  className={input}
                  placeholder="User id of the person beside you"
                  value={secondPerson}
                  onChange={(e) => {
                    setSecondPerson(e.target.value);
                  }}
                />
              </div>
              <Button
                size="sm"
                disabled={timeout.isPending || secondPerson.trim() === '' || secondPerson.trim() === userId}
                onClick={() => {
                  timeout.mutate();
                }}
              >
                Confirm the time-out
              </Button>
              {timeout.error === null ? null : <ProblemCard error={timeout.error} />}
            </div>
          ) : null}

          {granted.has('procedure.checklist.override') &&
          open.checklists.some((c) => !c.ready && c.overrideReason === null) ? (
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex w-96 flex-col gap-1">
                <label className="text-2xs uppercase tracking-[0.08em] text-fg-subtle" htmlFor="ov-reason">
                  Proceed with an incomplete checklist — why
                </label>
                <input
                  id="ov-reason"
                  className={input}
                  value={overrideReason}
                  onChange={(e) => {
                    setOverrideReason(e.target.value);
                  }}
                />
              </div>
              <Button
                size="sm"
                variant="secondary"
                disabled={override.isPending || overrideReason.trim().length < 8}
                onClick={() => {
                  override.mutate();
                }}
              >
                Override
              </Button>
              {override.error === null ? null : <ProblemCard error={override.error} />}
            </div>
          ) : null}

          {granted.has('procedure.perform') && live === undefined && open.order.status !== 'completed' ? (
            <div className="flex flex-wrap items-center gap-2 border-t border-default pt-4">
              {(['none', 'local', 'regional'] as const).map((a) => (
                <Button
                  key={a}
                  size="sm"
                  disabled={start.isPending}
                  onClick={() => {
                    start.mutate(a);
                  }}
                >
                  {`Start (${a})`}
                </Button>
              ))}
              <span className="text-2xs text-fg-subtle">
                Sedation and general anaesthesia name the anaesthetist, so they are started from the theatre
                list rather than here.
              </span>
              {start.error === null ? null : <ProblemCard error={start.error} />}
            </div>
          ) : null}

          {live === undefined ? null : (
            <div className="flex flex-col gap-3 border-t border-default pt-4">
              <textarea
                className="min-h-24 w-full rounded-md border border-control bg-layer-1 p-3 text-sm text-fg-default"
                aria-label="Findings"
                placeholder="What was found, and what was done"
                value={findings}
                onChange={(e) => {
                  setFindings(e.target.value);
                }}
              />
              <div className="flex flex-wrap items-center gap-2">
                {live.endedAt === null ? (
                  <Button
                    size="sm"
                    disabled={complete.isPending || findings.trim().length < 4}
                    onClick={() => {
                      complete.mutate(live.id);
                    }}
                  >
                    Complete
                  </Button>
                ) : granted.has('procedure.sign') ? (
                  <Button
                    size="sm"
                    disabled={sign.isPending}
                    onClick={() => {
                      sign.mutate(live.id);
                    }}
                  >
                    Sign the note
                  </Button>
                ) : null}
                {complete.error === null ? null : <ProblemCard error={complete.error} />}
                {sign.error === null ? null : <ProblemCard error={sign.error} />}
              </div>

              {granted.has('procedure.recovery.record') &&
              (live.anaesthesia === 'sedation' || live.anaesthesia === 'general') ? (
                <div className="flex flex-wrap items-end gap-3">
                  <div className="flex w-32 flex-col gap-1">
                    <label className="text-2xs uppercase tracking-[0.08em] text-fg-subtle" htmlFor="rc-ald">
                      Aldrete
                    </label>
                    <input
                      id="rc-ald"
                      className={`${input} font-mono`}
                      value={aldrete}
                      onChange={(e) => {
                        setAldrete(e.target.value);
                      }}
                    />
                  </div>
                  <div className="flex w-64 flex-col gap-1">
                    <label className="text-2xs uppercase tracking-[0.08em] text-fg-subtle" htmlFor="rc-esc">
                      Escort taking them home
                    </label>
                    <input
                      id="rc-esc"
                      className={input}
                      value={escort}
                      onChange={(e) => {
                        setEscort(e.target.value);
                      }}
                    />
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={discharge.isPending}
                    onClick={() => {
                      discharge.mutate(live.id);
                    }}
                  >
                    Discharge from recovery
                  </Button>
                  {discharge.error === null ? null : <ProblemCard error={discharge.error} />}
                </div>
              ) : null}
            </div>
          )}
        </div>
      )}

      <p className="text-2xs text-fg-subtle">
        Consent, a time-out and a checklist stand between an order and the room. The checklist can be
        overridden by a named person with a reason; consent cannot be overridden by anybody. After sedation a
        patient leaves at Aldrete 9 with somebody to take them home.
      </p>
    </section>
  );
}
