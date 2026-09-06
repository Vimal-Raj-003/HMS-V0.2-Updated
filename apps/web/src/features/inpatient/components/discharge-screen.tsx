'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, EmptyState } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';
import {
  cosignSummary,
  getDischarge,
  getDischarges,
  markPatientLeft,
  prefillReconciliation,
  reconcileMedicines,
  signSummary,
} from '../api/client';
import { ipKeys } from '../api/keys';
import type { DischargeRow, ReconciliationRow } from '../api/types';

const inputClass = 'h-10 w-full rounded-md border border-control bg-layer-1 px-3 text-sm text-fg-default';

const ACTIONS = [
  { key: 'continue_same', label: 'Continue', needsReason: false },
  { key: 'change', label: 'Change', needsReason: true },
  { key: 'stop', label: 'Stop', needsReason: true },
  { key: 'new_medicine', label: 'Start', needsReason: true },
] as const;

/**
 * IP-002 — the discharge worklist and the reconciliation beside it.
 *
 * ── The blocker is on the row, before anybody tries to sign ─────────────────
 *
 * The count of undecided medicines is a column, not a message that appears
 * after a refused signature. A doctor who can see "2 undecided" from the
 * worklist deals with it during the round; one who finds out at the moment of
 * signing deals with it at 7 p.m. with the family already waiting downstairs.
 *
 * ── Every decision except "continue" asks why, here as well ─────────────────
 *
 * The database refuses a stop with no reason. The form asks for it before the
 * request is made, so the refusal is a rarity rather than the normal way of
 * finding out. The two say the same thing on purpose; the database is the one
 * that decides.
 *
 * ── Nothing on this screen offers a way past the gate ───────────────────────
 *
 * There is no "sign anyway", no override, no supervisor prompt. Sign is
 * disabled while medicines are undecided and the reason is written next to it,
 * because a disabled button with no explanation is read as a broken button.
 */
export function DischargeScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = ipKeys(hospitalId);
  const client = useQueryClient();

  const [openOnly, setOpenOnly] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, { action: string; reason: string; dose: string }>>({});

  const list = useQuery({
    queryKey: keys.discharges(String(openOnly)),
    queryFn: ({ signal }) => getDischarges({ openOnly }, { signal }),
    refetchInterval: 60_000,
  });

  const detail = useQuery({
    queryKey: keys.discharge(openId ?? 'none'),
    queryFn: ({ signal }) => getDischarge(openId ?? '', { signal }),
    enabled: openId !== null,
  });

  function invalidate(): void {
    void client.invalidateQueries({ queryKey: keys.dischargesRoot() });
    if (openId !== null) void client.invalidateQueries({ queryKey: keys.discharge(openId) });
  }

  const prefill = useMutation({
    mutationFn: () => prefillReconciliation(openId ?? ''),
    onSuccess: invalidate,
  });

  const decide = useMutation({
    mutationFn: (medicines: readonly Record<string, string>[]) =>
      reconcileMedicines(openId ?? '', medicines as never),
    onSuccess: () => {
      setDraft({});
      invalidate();
    },
  });

  const sign = useMutation({
    mutationFn: (summaryId: string) => signSummary(summaryId),
    onSuccess: invalidate,
  });

  const cosign = useMutation({
    mutationFn: (summaryId: string) => cosignSummary(summaryId),
    onSuccess: invalidate,
  });

  const left = useMutation({
    mutationFn: () => markPatientLeft(openId ?? ''),
    onSuccess: invalidate,
  });

  const rows: readonly DischargeRow[] = list.data?.items ?? [];
  const open = detail.data;
  const blocked = (open?.discharge.unresolvedMedicines ?? 0) > 0;
  const latest = open?.summaries[0];

  function submitDecisions(): void {
    const medicines = Object.entries(draft)
      .filter(([, v]) => v.action !== '')
      .map(([drugName, v]) => ({
        drugName,
        action: v.action,
        ...(v.dose === '' ? {} : { dischargeDose: v.dose }),
        ...(v.reason === '' ? {} : { reason: v.reason }),
      }));
    if (medicines.length > 0) decide.mutate(medicines);
  }

  return (
    <section className="flex flex-col gap-5">
      <PageHeader
        title="Discharges"
        description="Who is going home today, what is holding each one up, and the medicines they leave with."
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
        Only discharges still in progress
      </label>

      <AsyncPanel
        loading={list.isPending}
        error={list.error}
        isEmpty={rows.length === 0}
        skeletonLabel="Loading the discharge worklist"
        skeletonRows={6}
        onRetry={() => {
          void list.refetch();
        }}
        empty={
          <EmptyState
            cause={openOnly ? 'No discharge is in progress.' : 'No discharge has been started.'}
            nextAction="A doctor starts a discharge from the admission, and it appears here for the ward, pharmacy and billing at the same moment."
          />
        }
      >
        <div className="overflow-x-auto rounded-lg border border-strong bg-layer-1">
          <table className="w-full text-sm" data-testid="discharge-worklist">
            <caption className="sr-only">Discharge worklist</caption>
            <thead>
              <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                {['Started', 'Kind', 'Destination', 'Medicines', 'Summary', 'Left', ''].map((h) => (
                  <th key={h} scope="col" className="px-3 py-2 text-start">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id} className="border-b border-default last:border-0" data-testid={`dis-${d.id}`}>
                  <td className="px-3 py-2 font-mono text-2xs">
                    {d.initiatedAt.slice(0, 16).replace('T', ' ')}
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={d.kind === 'routine' ? 'neutral' : 'warning'}>
                      {d.kind.replace(/_/gu, ' ')}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-2xs">{d.destination ?? '—'}</td>
                  <td className="px-3 py-2">
                    {d.unresolvedMedicines > 0 ? (
                      <Badge tone="warning">{`${String(d.unresolvedMedicines)} undecided`}</Badge>
                    ) : (
                      <Badge tone="success">reconciled</Badge>
                    )}
                  </td>
                  <td className="px-3 py-2 text-2xs">
                    {d.summarySignedAt === null ? (
                      d.summaryVersion === null ? (
                        <span className="text-fg-muted">not started</span>
                      ) : (
                        <span className="text-fg-warning">draft</span>
                      )
                    ) : (
                      <span className="text-fg-success">{`signed v${String(d.summaryVersion ?? 1)}`}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-2xs">
                    {d.completedAt === null ? '—' : d.completedAt.slice(0, 16).replace('T', ' ')}
                  </td>
                  <td className="px-3 py-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setOpenId(d.id);
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
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-base font-semibold text-fg-default">Medication reconciliation</h2>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={prefill.isPending}
                onClick={() => {
                  prefill.mutate();
                }}
              >
                Pull the ward chart and the home list
              </Button>
              {granted.has('ip.discharge.reconcile') ? (
                <Button size="sm" disabled={decide.isPending} onClick={submitDecisions}>
                  Record the decisions
                </Button>
              ) : null}
            </div>
          </div>

          {decide.error === null ? null : <ProblemCard error={decide.error} />}
          {prefill.error === null ? null : <ProblemCard error={prefill.error} />}

          {open.reconciliation.length === 0 ? (
            <EmptyState
              cause="No medicine is on the reconciliation list yet."
              nextAction="Pull the ward chart and the home list, then decide each line."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="reconciliation">
                <caption className="sr-only">Medication reconciliation</caption>
                <thead>
                  <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                    {['Medicine', 'At home', 'On the ward', 'Going home on', 'Decision', 'Why'].map((h) => (
                      <th key={h} scope="col" className="px-3 py-2 text-start">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {open.reconciliation.map((m: ReconciliationRow) => {
                    const d = draft[m.drugName] ?? { action: '', reason: '', dose: '' };
                    const needsReason = ACTIONS.find((a) => a.key === d.action)?.needsReason ?? false;
                    return (
                      <tr key={m.id} className="border-b border-default last:border-0">
                        <td className="px-3 py-2 font-medium">{m.drugName}</td>
                        <td className="px-3 py-2 text-2xs text-fg-muted">{m.homeDose ?? '—'}</td>
                        <td className="px-3 py-2 text-2xs text-fg-muted">{m.inpatientDose ?? '—'}</td>
                        <td className="px-3 py-2">
                          {m.action === 'unresolved' ? (
                            <input
                              className={inputClass}
                              aria-label={`Discharge dose for ${m.drugName}`}
                              value={d.dose}
                              onChange={(e) => {
                                setDraft({ ...draft, [m.drugName]: { ...d, dose: e.target.value } });
                              }}
                            />
                          ) : (
                            <span className="text-2xs">{m.dischargeDose ?? '—'}</span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {m.action === 'unresolved' ? (
                            <div className="flex flex-wrap gap-1">
                              {ACTIONS.map((a) => (
                                <Button
                                  key={a.key}
                                  size="sm"
                                  variant={d.action === a.key ? 'primary' : 'secondary'}
                                  onClick={() => {
                                    setDraft({ ...draft, [m.drugName]: { ...d, action: a.key } });
                                  }}
                                >
                                  {a.label}
                                </Button>
                              ))}
                            </div>
                          ) : (
                            <Badge tone="success">{m.action.replace(/_/gu, ' ')}</Badge>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {m.action === 'unresolved' ? (
                            needsReason ? (
                              <input
                                className={inputClass}
                                aria-label={`Reason for ${m.drugName}`}
                                placeholder="Why this changed"
                                value={d.reason}
                                onChange={(e) => {
                                  setDraft({ ...draft, [m.drugName]: { ...d, reason: e.target.value } });
                                }}
                              />
                            ) : (
                              <span className="text-2xs text-fg-subtle">no reason needed</span>
                            )
                          ) : (
                            <span className="text-2xs text-fg-muted">{m.reason ?? '—'}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3 border-t border-default pt-4">
            {latest === undefined ? (
              <p className="text-2xs text-fg-subtle">No summary has been drafted for this discharge yet.</p>
            ) : (
              <>
                <span className="text-sm">
                  {`Summary v${String(latest.version)} — `}
                  {latest.signedAt === null
                    ? 'draft'
                    : latest.cosignedAt === null
                      ? 'signed, awaiting a countersignature'
                      : 'signed and countersigned'}
                </span>
                {latest.signedAt === null && granted.has('ip.discharge.summary.sign') ? (
                  <Button
                    size="sm"
                    disabled={blocked || sign.isPending}
                    onClick={() => {
                      sign.mutate(latest.id);
                    }}
                  >
                    Sign
                  </Button>
                ) : null}
                {latest.signedAt !== null &&
                latest.cosignedAt === null &&
                granted.has('ip.discharge.summary.cosign') ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={cosign.isPending}
                    onClick={() => {
                      cosign.mutate(latest.id);
                    }}
                  >
                    Countersign
                  </Button>
                ) : null}
              </>
            )}

            {blocked ? (
              <span className="text-2xs text-fg-warning">
                {`${String(open.discharge.unresolvedMedicines)} medicine(s) have no decision yet, so the summary cannot be signed. The patient goes home with a list; if the list and the ward chart disagree and nobody has said which is right, they take both or neither.`}
              </span>
            ) : null}

            {granted.has('ip.discharge.complete') && open.discharge.completedAt === null ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={left.isPending}
                onClick={() => {
                  left.mutate();
                }}
              >
                Patient has left
              </Button>
            ) : null}
          </div>

          {sign.error === null ? null : <ProblemCard error={sign.error} />}
          {cosign.error === null ? null : <ProblemCard error={cosign.error} />}
          {left.error === null ? null : <ProblemCard error={left.error} />}
        </div>
      )}

      <p className="text-2xs text-fg-subtle">
        A summary cannot be signed while any medicine is undecided, and once signed it cannot be edited — an
        amendment is a new version carrying its reason. A GP, an insurer and a court all read this document.
      </p>
    </section>
  );
}
