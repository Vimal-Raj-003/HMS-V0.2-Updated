'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Badge, Button, EmptyState, Input, Label, useToast } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';
import { humanise } from '@/features/pharmacy/lib/format';
import { getBoard, markBayClean, quickReg } from '../api/client';
import { erKeys } from '../api/keys';
import type { ErBayView, ErVisitView } from '../api/types';

/**
 * The ESI colours, which are not decoration.
 *
 * `phase-06` §6.2 requires colour **plus numeral plus label** for every triage
 * category, because roughly one in twelve men has a colour vision deficiency and
 * a red/green board in a resus bay is a board that misleads exactly the people
 * who are moving fastest. Every badge below carries the number.
 */
const ESI_TONE: Readonly<Record<number, 'danger' | 'warning' | 'neutral' | 'success'>> = {
  1: 'danger',
  2: 'danger',
  3: 'warning',
  4: 'neutral',
  5: 'success',
};

const ESI_LABEL: Readonly<Record<number, string>> = {
  1: 'Resuscitation',
  2: 'Emergent',
  3: 'Urgent',
  4: 'Less urgent',
  5: 'Non-urgent',
};

const ARRIVAL_MODES = [
  { value: 'walk_in', label: 'Walked in' },
  { value: 'ambulance', label: 'Ambulance' },
  { value: 'police', label: 'Police' },
  { value: 'referred', label: 'Referred' },
  { value: 'transfer', label: 'Transfer' },
] as const;

/**
 * OP-006 — the ER board.
 *
 * ── The quick-registration form asks for one thing ──────────────────────────
 *
 * How they arrived. Everything else is optional, including the name. A patient
 * on a trolley who cannot speak gets a tag and a bay, and the desk fills in the
 * rest later — *Parmanand Katara v. Union of India* (1989) makes emergency
 * treatment a duty that cannot be conditioned on formalities, and a required
 * field is a formality with a person behind it.
 *
 * ── The order of the rows is the clinical priority ──────────────────────────
 *
 * Inbound first, then strictly by ESI, then by who has waited longest. The
 * server sorts it and the screen does not re-sort, because two sort orders is
 * one more than a department can safely have.
 *
 * ── The timer is the point ──────────────────────────────────────────────────
 *
 * Every triaged row shows how much of its ESI target has been used: amber at
 * 80%, red past 100. That is a NABH indicator, but more immediately it is the
 * only thing on the screen that says *this one has been waiting too long* when
 * the department is full and everybody looks equally busy.
 */
export function ErBoardScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = erKeys(hospitalId);
  const { publish } = useToast();

  const [showReg, setShowReg] = useState(false);
  const [arrivalMode, setArrivalMode] = useState<string>('walk_in');
  const [displayName, setDisplayName] = useState('');
  const [complaint, setComplaint] = useState('');
  const [mlc, setMlc] = useState(false);

  const canRegister = granted.has('er.quickreg');
  const canAssign = granted.has('er.bay.assign');

  const board = useQuery({
    queryKey: keys.board('live'),
    queryFn: ({ signal }) => getBoard({}, { signal }),
    // The board is a wall display. A stale ER board is worse than a blank one
    // because it looks authoritative, so it refetches rather than caching.
    refetchInterval: 10_000,
  });

  const register = useMutation({
    mutationFn: () =>
      quickReg({
        arrivalMode,
        ...(displayName.trim() === '' ? {} : { displayName: displayName.trim() }),
        ...(complaint.trim() === '' ? {} : { chiefComplaint: complaint.trim() }),
        mlcSuspected: mlc,
      }),
    onSuccess: (visit) => {
      void board.refetch();
      setShowReg(false);
      setDisplayName('');
      setComplaint('');
      setMlc(false);
      publish({
        title: `${visit.erNo} registered${visit.tempIdentity === null ? '' : ` as ${visit.tempIdentity}`}`,
        severity: 'success',
      });
    },
  });

  const clean = useMutation({
    mutationFn: (bayId: string) => markBayClean({ bayId }),
    onSuccess: () => {
      void board.refetch();
      publish({ title: 'Bay ready', severity: 'success' });
    },
  });

  const data = board.data;
  const visits = data?.visits ?? [];
  const bays = data?.bays ?? [];
  const counts = data?.counts;

  return (
    <section className="flex flex-col gap-4" data-testid="er-board-screen">
      <PageHeader
        eyebrow="OP-006 · emergency"
        title="ER board"
        description="Sorted by how sick, then by how long they have waited. Registration needs nothing but how they arrived — a patient who cannot tell you their name still gets a tag, a bay and treatment."
      />

      {counts === undefined ? null : (
        <dl className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6" data-testid="er-counts">
          {[
            { label: 'Inbound', value: counts.inbound, tone: 'warning' as const },
            { label: 'Waiting', value: counts.waiting, tone: 'neutral' as const },
            { label: 'In treatment', value: counts.inTreatment, tone: 'neutral' as const },
            { label: 'Target breached', value: counts.breached, tone: 'danger' as const },
            { label: 'Bays free', value: counts.baysFree, tone: 'success' as const },
            { label: 'Bays dirty', value: counts.baysCleaning, tone: 'warning' as const },
          ].map((card) => (
            <div key={card.label} className="rounded-lg border border-strong bg-layer-1 p-3">
              <dt className="text-2xs uppercase tracking-[0.08em] text-fg-subtle">{card.label}</dt>
              <dd
                className={`mt-1 font-mono text-2xl ${
                  card.tone === 'danger' && card.value > 0 ? 'text-danger-fg' : ''
                }`}
              >
                {card.value}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {canRegister ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            data-testid="open-quickreg"
            onClick={() => {
              setShowReg(!showReg);
            }}
          >
            {showReg ? 'Close' : 'Register an arrival'}
          </Button>
          <span className="text-2xs text-fg-subtle">
            Only &ldquo;how they arrived&rdquo; is required. A patient with no name gets a tag.
          </span>
        </div>
      ) : null}

      {register.error === null ? null : <ProblemCard error={register.error} />}

      {showReg ? (
        <div
          className="flex flex-col gap-3 rounded-lg border border-strong bg-layer-1 p-4"
          data-testid="quickreg-form"
        >
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium">How did they arrive?</legend>
            <div className="flex flex-wrap gap-2">
              {ARRIVAL_MODES.map((mode) => (
                <button
                  key={mode.value}
                  type="button"
                  data-testid={`arrival-${mode.value}`}
                  aria-pressed={arrivalMode === mode.value}
                  onClick={() => {
                    setArrivalMode(mode.value);
                  }}
                  // 48px targets: `phase-06` says glove-friendly, and a tablet in
                  // a resus bay is used by someone whose hands are full.
                  className={`min-h-12 rounded-lg border px-4 text-sm ${
                    arrivalMode === mode.value
                      ? 'border-accent-border bg-layer-2 text-fg-default'
                      : 'border-default text-fg-muted hover:text-fg-default'
                  }`}
                >
                  {mode.label}
                </button>
              ))}
            </div>
          </fieldset>

          <div className="flex flex-wrap gap-3">
            <div className="flex min-w-60 flex-col gap-1">
              <Label htmlFor="er-name">Name, if known</Label>
              <Input
                id="er-name"
                data-testid="er-name"
                value={displayName}
                autoComplete="off"
                placeholder="Leave blank for an unknown patient"
                onChange={(event) => {
                  setDisplayName(event.target.value);
                }}
              />
            </div>
            <div className="flex min-w-72 flex-col gap-1">
              <Label htmlFor="er-complaint">What is wrong?</Label>
              <Input
                id="er-complaint"
                data-testid="er-complaint"
                value={complaint}
                autoComplete="off"
                onChange={(event) => {
                  setComplaint(event.target.value);
                }}
              />
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              data-testid="er-mlc"
              checked={mlc}
              className="size-5"
              onChange={(event) => {
                setMlc(event.target.checked);
              }}
            />
            Possible medico-legal case
          </label>

          <div>
            <Button
              data-testid="submit-quickreg"
              disabled={register.isPending}
              onClick={() => {
                register.mutate();
              }}
            >
              {register.isPending ? 'Registering…' : 'Register'}
            </Button>
          </div>
          <p className="text-2xs text-fg-subtle">
            No identifier, no payer and no payment. There is nothing to collect here and nowhere in this
            module to record one — emergency treatment is not conditional on formalities.
          </p>
        </div>
      ) : null}

      <AsyncPanel
        loading={board.isPending}
        error={board.error}
        isEmpty={visits.length === 0}
        skeletonLabel="Loading the ER board"
        skeletonRows={8}
        onRetry={() => {
          void board.refetch();
        }}
        empty={
          <EmptyState
            cause="Nobody is in the department."
            nextAction="Arrivals appear here the moment they are registered, and inbound ambulances appear before that."
          />
        }
      >
        <div className="overflow-x-auto rounded-lg border border-strong bg-layer-1">
          <table className="w-full text-sm" data-testid="er-board">
            <caption className="sr-only">Emergency department board</caption>
            <thead>
              <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                <th scope="col" className="px-3 py-2 text-start">
                  Patient
                </th>
                <th scope="col" className="px-3 py-2 text-start">
                  Triage
                </th>
                <th scope="col" className="px-3 py-2 text-start">
                  Complaint
                </th>
                <th scope="col" className="px-3 py-2 text-start">
                  Where
                </th>
                <th scope="col" className="px-3 py-2 text-end">
                  In dept.
                </th>
                <th scope="col" className="px-3 py-2 text-start">
                  Target
                </th>
              </tr>
            </thead>
            <tbody>
              {visits.map((row: ErVisitView) => (
                <tr
                  key={row.id}
                  className={`border-b border-default last:border-0 ${
                    row.targetBreached ? 'bg-danger-subtle' : ''
                  }`}
                  data-testid={`er-row-${row.erNo}`}
                >
                  <td className="px-3 py-2">
                    <span className="font-mono text-2xs">{row.erNo}</span>
                    <p className="mt-1">{row.displayName ?? 'Unknown patient'}</p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {row.tempIdentity === null ? null : (
                        <Badge tone={row.isUnidentified ? 'warning' : 'neutral'}>{row.tempIdentity}</Badge>
                      )}
                      {row.mlcSuspected ? <Badge tone="danger">MLC</Badge> : null}
                      {row.status === 'inbound' ? <Badge tone="warning">inbound</Badge> : null}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    {row.esiLevel === null ? (
                      <Badge tone="neutral">not triaged</Badge>
                    ) : (
                      <Badge tone={ESI_TONE[row.esiLevel] ?? 'neutral'}>
                        {`ESI ${String(row.esiLevel)} · ${ESI_LABEL[row.esiLevel] ?? ''}`}
                      </Badge>
                    )}
                  </td>
                  <td className="px-3 py-2 text-2xs text-fg-muted">{row.chiefComplaint ?? '—'}</td>
                  <td className="px-3 py-2">
                    {row.bayCode === null ? (
                      <span className="text-2xs text-fg-subtle">no bay</span>
                    ) : (
                      <span className="font-mono text-2xs">{row.bayCode}</span>
                    )}
                    <p className="mt-1 text-2xs text-fg-subtle">{humanise(row.status)}</p>
                  </td>
                  <td className="px-3 py-2 text-end font-mono text-2xs">
                    {row.erLosMinutes === null ? '—' : `${String(row.erLosMinutes)} min`}
                  </td>
                  <td className="px-3 py-2">
                    {row.targetUsedPct === null ? (
                      <span className="text-2xs text-fg-subtle">—</span>
                    ) : row.firstSeenAt !== null ? (
                      <Badge tone="success">seen</Badge>
                    ) : (
                      <Badge
                        tone={
                          row.targetUsedPct >= 100
                            ? 'danger'
                            : row.targetUsedPct >= 80
                              ? 'warning'
                              : 'neutral'
                        }
                      >
                        {`${String(row.targetUsedPct)}% of target`}
                      </Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AsyncPanel>

      {bays.length === 0 ? null : (
        <div>
          <h2 className="mb-2 text-sm font-medium">Bays</h2>
          <div className="flex flex-wrap gap-2" data-testid="er-bays">
            {bays.map((bay: ErBayView) => (
              <div
                key={bay.id}
                className={`min-w-28 rounded-lg border p-2 text-2xs ${
                  bay.status === 'occupied'
                    ? 'border-strong bg-layer-2'
                    : bay.status === 'cleaning'
                      ? 'border-warning-border bg-warning-subtle'
                      : 'border-default'
                }`}
              >
                <p className="font-mono text-sm">{bay.code}</p>
                <p className="text-fg-muted">{humanise(bay.status)}</p>
                {bay.hasVentilator ? <Badge tone="neutral">vent</Badge> : null}
                {bay.status === 'cleaning' && canAssign ? (
                  <button
                    type="button"
                    data-testid={`clean-${bay.code}`}
                    className="mt-1 block text-accent-fg underline-offset-2 hover:underline"
                    disabled={clean.isPending}
                    onClick={() => {
                      clean.mutate(bay.id);
                    }}
                  >
                    Mark clean
                  </button>
                ) : null}
              </div>
            ))}
          </div>
          <p className="mt-2 text-2xs text-fg-subtle">
            A vacated bay goes to <strong>dirty</strong>, never straight to free. A bay that silently became
            free is how the next patient is put on an unwiped trolley.
          </p>
        </div>
      )}
    </section>
  );
}
