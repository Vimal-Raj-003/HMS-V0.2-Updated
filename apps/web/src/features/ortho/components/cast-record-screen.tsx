'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, EmptyState, Label } from '@vims/ui';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';
import { addPinSite, getCast, recordCastCheck, recordPinCare, removeCast } from '../api/client';
import { orthoKeys } from '../api/keys';
import type { CastCheckView, PinSiteView } from '../api/types';

const inputClass = 'h-10 w-full rounded-md border border-control bg-layer-1 px-3 text-sm text-fg-default';

/**
 * The five findings that make a limb in plaster an emergency.
 *
 * Listed as checkboxes with the full clinical phrase rather than an
 * abbreviation, because the person filling this in at 2 a.m. is often the least
 * experienced one on the ward, and "5 Ps" is a mnemonic you only remember if
 * somebody taught it to you.
 */
const RED_FLAG_FINDINGS = [
  { key: 'painOutOfProportion', label: 'Pain out of proportion to the injury' },
  { key: 'painOnPassiveStretch', label: 'Pain on passive stretch of the digits' },
  { key: 'paraesthesia', label: 'Paraesthesia — pins and needles, numbness' },
  { key: 'pallor', label: 'Pallor' },
  { key: 'pulselessness', label: 'Pulselessness' },
] as const;

type FindingKey = (typeof RED_FLAG_FINDINGS)[number]['key'];

/**
 * TR-005 — one cast.
 *
 * ── The screen predicts the red flag; the database decides it ───────────────
 *
 * As soon as a finding is ticked, the form says a red flag will be raised and
 * asks what was done — before the submit, not after the refusal. The server
 * still computes the flag from the findings and still refuses a check with no
 * action; this is the explanation, not the enforcement. Two implementations of
 * the rule would be two rules.
 */
export function CastRecordScreen(): React.JSX.Element {
  const params = useSearchParams();
  const id = params.get('id') ?? '';
  const { hospitalId } = useSession();
  const keys = orthoKeys(hospitalId);
  const queryClient = useQueryClient();

  const cast = useQuery({
    queryKey: keys.cast(id),
    queryFn: ({ signal }) => getCast(id, { signal }),
    enabled: id !== '',
  });

  const [findings, setFindings] = useState<Readonly<Record<FindingKey, boolean>>>({
    painOutOfProportion: false,
    painOnPassiveStretch: false,
    paraesthesia: false,
    pallor: false,
    pulselessness: false,
  });
  const [refill, setRefill] = useState('');
  const [skinIntact, setSkinIntact] = useState(true);
  const [castIntact, setCastIntact] = useState(true);
  const [neuroIntact, setNeuroIntact] = useState(true);
  const [action, setAction] = useState('');
  const [removeReason, setRemoveReason] = useState('');
  const [pinLabel, setPinLabel] = useState('');

  const refillSeconds = refill.trim() === '' ? undefined : Number(refill);

  // The same predicate the trigger applies. Kept beside the form so the
  // question "what did you do about it?" appears with the finding rather than
  // after a rejected submit.
  const willRaise =
    RED_FLAG_FINDINGS.some((f) => findings[f.key]) ||
    !skinIntact ||
    !neuroIntact ||
    (refillSeconds !== undefined && Number.isFinite(refillSeconds) && refillSeconds > 3);

  function resetCheck(): void {
    setFindings({
      painOutOfProportion: false,
      painOnPassiveStretch: false,
      paraesthesia: false,
      pallor: false,
      pulselessness: false,
    });
    setRefill('');
    setSkinIntact(true);
    setCastIntact(true);
    setNeuroIntact(true);
    setAction('');
  }

  const check = useMutation({
    mutationFn: () =>
      recordCastCheck(id, {
        kind: 'ward_round',
        painOutOfProportion: findings.painOutOfProportion,
        painOnPassiveStretch: findings.painOnPassiveStretch,
        paraesthesia: findings.paraesthesia,
        pallor: findings.pallor,
        pulselessness: findings.pulselessness,
        skinIntact,
        castIntact,
        neurovascularIntact: neuroIntact,
        ...(refillSeconds !== undefined && Number.isFinite(refillSeconds)
          ? { capillaryRefillSec: refillSeconds }
          : {}),
        ...(action.trim() === '' ? {} : { actionTaken: action.trim() }),
      }),
    onSuccess: () => {
      resetCheck();
      void queryClient.invalidateQueries({ queryKey: keys.cast(id) });
      void queryClient.invalidateQueries({ queryKey: keys.castsRoot() });
    },
  });

  const remove = useMutation({
    mutationFn: () => removeCast(id, removeReason.trim()),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.cast(id) });
      void queryClient.invalidateQueries({ queryKey: keys.castsRoot() });
    },
  });

  const pin = useMutation({
    mutationFn: () => addPinSite(id, { pinLabel: pinLabel.trim(), intervalDays: 3 }),
    onSuccess: () => {
      setPinLabel('');
      void queryClient.invalidateQueries({ queryKey: keys.cast(id) });
    },
  });

  const care = useMutation({
    mutationFn: (input: { readonly pinId: string; readonly grade: number }) =>
      recordPinCare(id, input.pinId, { infectionGrade: input.grade }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.cast(id) });
    },
  });

  if (id === '') {
    return (
      <EmptyState
        cause="No cast was named in the address."
        nextAction="Open one from the plaster room list."
      />
    );
  }

  const detail = cast.data;
  const planned = detail?.plannedRemovalAt ?? null;
  const removingEarly = planned !== null && Date.now() < new Date(planned).getTime();

  return (
    <section className="flex flex-col gap-6">
      <AsyncPanel
        loading={cast.isPending}
        error={cast.error}
        isEmpty={false}
        skeletonLabel="Loading the cast"
        skeletonRows={6}
        onRetry={() => {
          void cast.refetch();
        }}
        empty={null}
      >
        {detail === undefined ? null : (
          <>
            <PageHeader
              title={`${detail.kind.replace('_', ' ')} — ${detail.side} ${detail.bodyRegion}`}
              description={
                detail.removedAt === null
                  ? `Applied ${(detail.appliedAt ?? '').slice(0, 16).replace('T', ' ')} in the ${detail.appliedIn.replace('_', ' ')}.`
                  : `Removed ${detail.removedAt.slice(0, 16).replace('T', ' ')}.`
              }
            />

            <div className="flex flex-wrap items-center gap-3">
              <Badge tone={detail.side === 'right' ? 'danger' : detail.side === 'left' ? 'info' : 'neutral'}>
                {detail.side.replace('_', ' ')}
              </Badge>
              {detail.lastCheckRedFlag ? (
                <Badge tone="danger">red flag on the last check</Badge>
              ) : (
                <Badge tone="success">last check clear</Badge>
              )}
              {detail.removedAt !== null ? (
                <Badge tone="neutral">off</Badge>
              ) : detail.checkDue ? (
                <Badge tone="warning">check due now</Badge>
              ) : (
                <span className="text-2xs text-fg-subtle">
                  next check {(detail.nextCheckDueAt ?? '').slice(0, 16).replace('T', ' ')}
                </span>
              )}
              {detail.request.instructions === null ? null : (
                <span className="text-2xs text-fg-muted">{detail.request.instructions}</span>
              )}
            </div>

            {/* ── The neurovascular check ────────────────────────────────── */}
            {detail.removedAt === null ? (
              <div className="rounded-lg border border-strong bg-layer-1 p-4">
                <h2 className="text-sm font-semibold text-fg-default">Neurovascular check</h2>

                <div className="mt-3 grid gap-2">
                  {RED_FLAG_FINDINGS.map((f) => (
                    <label key={f.key} className="flex min-h-12 items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="size-5"
                        checked={findings[f.key]}
                        onChange={(e) => {
                          setFindings({ ...findings, [f.key]: e.target.checked });
                        }}
                      />
                      {f.label}
                    </label>
                  ))}
                </div>

                <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="cast-refill">Capillary refill (seconds)</Label>
                    <input
                      id="cast-refill"
                      className={inputClass}
                      inputMode="numeric"
                      value={refill}
                      placeholder="2"
                      onChange={(e) => {
                        setRefill(e.target.value);
                      }}
                    />
                  </div>
                  <label className="flex min-h-12 items-center gap-2 self-end text-sm">
                    <input
                      type="checkbox"
                      className="size-5"
                      checked={neuroIntact}
                      onChange={(e) => {
                        setNeuroIntact(e.target.checked);
                      }}
                    />
                    Neurovascular status intact
                  </label>
                  <label className="flex min-h-12 items-center gap-2 self-end text-sm">
                    <input
                      type="checkbox"
                      className="size-5"
                      checked={skinIntact}
                      onChange={(e) => {
                        setSkinIntact(e.target.checked);
                      }}
                    />
                    Skin intact
                  </label>
                  <label className="flex min-h-12 items-center gap-2 self-end text-sm">
                    <input
                      type="checkbox"
                      className="size-5"
                      checked={castIntact}
                      onChange={(e) => {
                        setCastIntact(e.target.checked);
                      }}
                    />
                    Cast intact
                  </label>
                </div>

                {willRaise ? (
                  <div className="mt-4 rounded-md border border-danger bg-danger-subtle p-3">
                    <p className="text-sm font-semibold text-fg-danger">
                      This is a red flag. Say what was done about it.
                    </p>
                    <p className="mt-1 text-2xs text-fg-muted">
                      Compartment syndrome until proven otherwise. Split or bivalve the cast, release the
                      padding, escalate — and record it. A check that records a finding and no action will be
                      refused.
                    </p>
                    <div className="mt-2">
                      <Label htmlFor="cast-action">What was done</Label>
                      <input
                        id="cast-action"
                        className={inputClass}
                        value={action}
                        placeholder="Cast bivalved and padding released; registrar informed at 02:15"
                        onChange={(e) => {
                          setAction(e.target.value);
                        }}
                      />
                    </div>
                  </div>
                ) : null}

                {check.error === null ? null : <ProblemCard error={check.error} />}

                <div className="mt-3 flex items-center gap-3">
                  <Button
                    type="button"
                    disabled={check.isPending || (willRaise && action.trim().length < 8)}
                    onClick={() => {
                      check.mutate();
                    }}
                  >
                    {check.isPending ? 'Recording…' : 'Record the check'}
                  </Button>
                  <span className="text-2xs text-fg-subtle">
                    A clear check buys twenty-four hours. A red flag brings the next look forward to an hour.
                  </span>
                </div>
              </div>
            ) : null}

            {/* ── The checks so far ──────────────────────────────────────── */}
            <ChecksTable checks={detail.checks} />

            {/* ── Pin sites ──────────────────────────────────────────────── */}
            {detail.kind === 'external_fixator' || detail.pinSites.length > 0 ? (
              <PinSites
                pins={detail.pinSites}
                label={pinLabel}
                busy={pin.isPending || care.isPending}
                onLabel={setPinLabel}
                onAdd={() => {
                  pin.mutate();
                }}
                onCare={(pinId, grade) => {
                  care.mutate({ pinId, grade });
                }}
              />
            ) : null}

            {/* ── Taking it off ──────────────────────────────────────────── */}
            {detail.removedAt === null ? (
              <div className="rounded-lg border border-strong bg-layer-1 p-4">
                <h2 className="text-sm font-semibold text-fg-default">Remove</h2>
                <p className="mt-1 text-2xs text-fg-muted">
                  {planned === null
                    ? 'No removal date was planned for this cast.'
                    : removingEarly
                      ? `Planned for ${planned.slice(0, 10)}. Taking it off now is early — a fracture can still displace in the car park.`
                      : `Planned for ${planned.slice(0, 10)}.`}
                </p>
                <div className="mt-2">
                  <Label htmlFor="cast-remove-reason">Grounds</Label>
                  <input
                    id="cast-remove-reason"
                    className={inputClass}
                    value={removeReason}
                    placeholder="Planned removal at twelve weeks; radiographic union"
                    onChange={(e) => {
                      setRemoveReason(e.target.value);
                    }}
                  />
                </div>
                {remove.error === null ? null : <ProblemCard error={remove.error} />}
                <div className="mt-3">
                  <Button
                    type="button"
                    disabled={remove.isPending || removeReason.trim().length < 12}
                    onClick={() => {
                      remove.mutate();
                    }}
                  >
                    {remove.isPending ? 'Removing…' : 'Remove the cast'}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-default bg-layer-1 p-4 text-sm text-fg-muted">
                Removed {detail.removedAt.slice(0, 16).replace('T', ' ')}.
                {detail.removalNotes === null ? null : ` ${detail.removalNotes}`}
              </div>
            )}
          </>
        )}
      </AsyncPanel>
    </section>
  );
}

function ChecksTable({ checks }: { readonly checks: readonly CastCheckView[] }): React.JSX.Element {
  if (checks.length === 0) {
    return (
      <EmptyState
        cause="No neurovascular check has been recorded on this cast."
        nextAction="Record the first one — the limb has been in plaster since it was applied."
      />
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-strong bg-layer-1">
      <table className="w-full text-sm" data-testid="cast-checks">
        <caption className="sr-only">Neurovascular checks</caption>
        <thead>
          <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
            {['When', 'Flag', 'Findings', 'Refill', 'What was done'].map((h) => (
              <th key={h} scope="col" className="px-3 py-2 text-start">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {checks.map((c) => (
            <tr key={c.id} className="border-b border-default last:border-0">
              <td className="px-3 py-2 font-mono text-2xs">{c.at.slice(0, 16).replace('T', ' ')}</td>
              <td className="px-3 py-2">
                {c.redFlag ? <Badge tone="danger">red flag</Badge> : <Badge tone="success">clear</Badge>}
              </td>
              <td className="px-3 py-2 text-2xs">{describeFindings(c)}</td>
              <td className="px-3 py-2 font-mono text-2xs">
                {c.capillaryRefillSec === null ? '—' : `${String(c.capillaryRefillSec)} s`}
              </td>
              <td className="px-3 py-2 text-2xs text-fg-muted">{c.actionTaken ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function describeFindings(c: CastCheckView): string {
  const found: string[] = [];
  if (c.painOutOfProportion) found.push('pain out of proportion');
  if (c.painOnPassiveStretch) found.push('pain on passive stretch');
  if (c.paraesthesia) found.push('paraesthesia');
  if (c.pallor) found.push('pallor');
  if (c.pulselessness) found.push('pulselessness');
  if (!c.neurovascularIntact) found.push('neurovascular deficit');
  if (!c.skinIntact) found.push('skin not intact');
  if (!c.castIntact) found.push('cast not intact');
  found.push(...c.otherFindings);
  return found.length === 0 ? 'nothing abnormal' : found.join('; ');
}

function PinSites({
  pins,
  label,
  busy,
  onLabel,
  onAdd,
  onCare,
}: {
  readonly pins: readonly PinSiteView[];
  readonly label: string;
  readonly busy: boolean;
  readonly onLabel: (value: string) => void;
  readonly onAdd: () => void;
  readonly onCare: (pinId: string, grade: number) => void;
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-strong bg-layer-1 p-4">
      <h2 className="text-sm font-semibold text-fg-default">Pin sites</h2>
      <p className="mt-1 text-2xs text-fg-muted">
        Graded Checketts-Otterburn 1 to 6. Grade 3 needs antibiotics; grade 5 usually means the pin comes out
        — so the number is a decision, not a note.
      </p>

      {pins.length === 0 ? null : (
        <div className="mt-3 overflow-x-auto rounded-md border border-default">
          <table className="w-full text-sm" data-testid="pin-sites">
            <caption className="sr-only">Pin sites</caption>
            <thead>
              <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                {['Pin', 'Every', 'Last care', 'Next due', 'Grade', 'Record'].map((h) => (
                  <th key={h} scope="col" className="px-3 py-2 text-start">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pins.map((p) => (
                <tr key={p.id} className="border-b border-default last:border-0">
                  <td className="px-3 py-2">{p.pinLabel}</td>
                  <td className="px-3 py-2 font-mono text-2xs">{p.intervalDays} d</td>
                  <td className="px-3 py-2 font-mono text-2xs">{p.lastCareAt?.slice(0, 10) ?? '—'}</td>
                  <td className="px-3 py-2">
                    {p.overdue ? (
                      <Badge tone="warning">overdue</Badge>
                    ) : (
                      <span className="font-mono text-2xs">{p.nextDueAt.slice(0, 10)}</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {p.infectionGrade === null ? (
                      <span className="text-2xs text-fg-subtle">—</span>
                    ) : (
                      <Badge tone={p.infectionGrade >= 3 ? 'danger' : 'success'}>
                        {`grade ${String(p.infectionGrade)}`}
                      </Badge>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex gap-1">
                      {[1, 2, 3, 4, 5, 6].map((g) => (
                        <Button
                          key={g}
                          type="button"
                          variant="secondary"
                          disabled={busy}
                          onClick={() => {
                            onCare(p.id, g);
                          }}
                        >
                          {g}
                        </Button>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <div className="flex grow flex-col gap-1">
          <Label htmlFor="pin-label">Add a pin site</Label>
          <input
            id="pin-label"
            className={inputClass}
            value={label}
            placeholder="Proximal medial"
            onChange={(e) => {
              onLabel(e.target.value);
            }}
          />
        </div>
        <Button type="button" variant="secondary" disabled={busy || label.trim() === ''} onClick={onAdd}>
          Add
        </Button>
      </div>
    </div>
  );
}
