'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Badge, Button, EmptyState, Input, Label, useToast } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';
import { erKeys } from '../api/keys';
import { acknowledgePage, declareMci, getTraumaBoard, standDown, standDownMci } from '../api/trauma-client';
import type { ActivationPageView, TraumaActivationView } from '../api/trauma-types';

const TIER_TONE: Readonly<Record<string, 'danger' | 'warning' | 'neutral'>> = {
  level_1: 'danger',
  level_2: 'warning',
  consult: 'neutral',
};
const TIER_LABEL: Readonly<Record<string, string>> = {
  level_1: 'Level 1',
  level_2: 'Level 2',
  consult: 'Consult',
};

const PAGE_TONE: Readonly<Record<string, 'success' | 'warning' | 'danger' | 'neutral'>> = {
  arrived: 'success',
  acknowledged: 'success',
  sent: 'warning',
  queued: 'neutral',
  failed: 'danger',
};

function roleLabel(role: string): string {
  return role.replace(/_/gu, ' ');
}

function answered(pages: readonly ActivationPageView[]): number {
  return pages.filter((page) => page.acknowledgedAt !== null).length;
}

/**
 * TR-001 — the trauma board.
 *
 * ── The page grid is the whole screen ───────────────────────────────────────
 *
 * An activation is not "the team was called". It is "the team was called and
 * seven people either answered or did not", and the second half is the only part
 * that tells the team leader whether anaesthesia is coming. So every row shows
 * every paged role, its state, and the seconds it took to answer.
 *
 * ── There is no mute ────────────────────────────────────────────────────────
 *
 * Not on this screen, and not in the database behind it: a level-1 page cannot
 * be created suppressed and cannot be updated to suppressed. The failure that
 * rule prevents is a night shift muting the trauma pager after two stand-downs
 * and not hearing the third page.
 *
 * ── Standing down asks why ──────────────────────────────────────────────────
 *
 * Calling the team is one click. Releasing them needs a sentence, stored on the
 * activation rather than in an audit row nobody reads — because the next
 * stand-down gets read in the light of this one.
 */
export function TraumaBoardScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = erKeys(hospitalId);
  const { publish } = useToast();

  const [includeClosed, setIncludeClosed] = useState(false);
  const [standingDown, setStandingDown] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [eta, setEta] = useState<Record<string, string>>({});
  const [mciName, setMciName] = useState('');

  const canAcknowledge = granted.has('trauma.page.acknowledge');
  const canStandDown = granted.has('trauma.activation.standdown');
  const canDeclare = granted.has('mci.incident.declare');
  const canCloseMci = granted.has('mci.incident.standdown');

  const board = useQuery({
    queryKey: keys.traumaBoard(includeClosed ? 'all' : 'active'),
    queryFn: ({ signal }) => getTraumaBoard({ includeClosed }, { signal }),
    // A running resuscitation changes every few seconds. A stale trauma board is
    // worse than a blank one, because it looks authoritative.
    refetchInterval: 8_000,
  });

  const activations: readonly TraumaActivationView[] = board.data?.activations ?? [];
  const mci = board.data?.activeMci ?? null;

  const answer = useMutation({
    mutationFn: (input: { readonly pageId: string; readonly arrived: boolean }) => {
      const typed = eta[input.pageId] ?? '';
      return acknowledgePage(input.pageId, {
        arrived: input.arrived,
        ...(typed.trim() === '' ? {} : { etaMinutes: Number(typed) }),
      });
    },
    onSuccess: () => {
      void board.refetch();
    },
  });

  const release = useMutation({
    mutationFn: (activationId: string) => standDown(activationId, reason.trim()),
    onSuccess: () => {
      setStandingDown(null);
      setReason('');
      void board.refetch();
      publish({ title: 'Team stood down', severity: 'success' });
    },
  });

  const declare = useMutation({
    mutationFn: () => declareMci({ name: mciName.trim() }),
    onSuccess: (incident) => {
      setMciName('');
      void board.refetch();
      publish({
        title: `${incident.incidentCode} declared`,
        description:
          'Triage switches to START. Black tags sort last on the ER board — expectant means expectant.',
        severity: 'warning',
      });
    },
  });

  const closeMci = useMutation({
    mutationFn: (id: string) =>
      standDownMci(
        id,
        'Incident over; casualties accounted for and the department is back to normal working',
      ),
    onSuccess: () => {
      void board.refetch();
      publish({ title: 'Incident closed', severity: 'success' });
    },
  });

  return (
    <section className="flex flex-col gap-5">
      <PageHeader
        title="Trauma board"
        description="Who was called, who answered, and how long the resuscitation has been running."
      />

      {/* ── The incident banner ─────────────────────────────────────────── */}
      {mci === null ? (
        canDeclare ? (
          <form
            className="flex flex-wrap items-end gap-3 rounded-lg border border-dashed border-strong bg-layer-1 p-4"
            data-testid="declare-mci"
            onSubmit={(event) => {
              event.preventDefault();
              declare.mutate();
            }}
          >
            <div className="flex min-w-72 flex-1 flex-col gap-1">
              <Label htmlFor="mci-name">Declare a mass-casualty incident</Label>
              <Input
                id="mci-name"
                value={mciName}
                autoComplete="off"
                placeholder="Bus and lorry collision, Hosur Road flyover"
                onChange={(event) => {
                  setMciName(event.target.value);
                }}
              />
            </div>
            <Button type="submit" variant="danger" disabled={mciName.trim().length < 3 || declare.isPending}>
              Declare
            </Button>
          </form>
        ) : null
      ) : (
        <div
          className="rounded-lg border-2 border-danger-border bg-danger-subtle p-4"
          data-testid="mci-banner"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-base font-medium">
                {mci.incidentCode} — {mci.name}
              </p>
              <p className="text-2xs text-fg-muted">
                Running {mci.minutesActive} min · declared {mci.source.replace('_', ' ')} · triage is START
                while this is open
              </p>
            </div>
            {canCloseMci ? (
              <Button
                type="button"
                disabled={closeMci.isPending}
                onClick={() => {
                  closeMci.mutate(mci.id);
                }}
              >
                Stand down and file the report
              </Button>
            ) : null}
          </div>
        </div>
      )}
      {declare.error === null ? null : <ProblemCard error={declare.error} />}
      {closeMci.error === null ? null : <ProblemCard error={closeMci.error} />}

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-5"
          checked={includeClosed}
          onChange={(event) => {
            setIncludeClosed(event.target.checked);
          }}
        />
        Show activations that have been stood down
      </label>

      {release.error === null ? null : <ProblemCard error={release.error} />}
      {answer.error === null ? null : <ProblemCard error={answer.error} />}

      <AsyncPanel
        loading={board.isPending}
        error={board.error}
        isEmpty={activations.length === 0}
        skeletonLabel="Loading the trauma board"
        skeletonRows={3}
        onRetry={() => {
          void board.refetch();
        }}
        empty={
          <EmptyState
            cause="No trauma team is running."
            nextAction="Activations appear here the moment somebody calls the team from the triage desk."
          />
        }
      >
        <ul className="flex flex-col gap-4" data-testid="trauma-board">
          {activations.map((activation) => (
            <li
              key={activation.id}
              data-testid={`activation-${activation.id}`}
              className={`rounded-lg p-4 ${
                activation.status === 'active' && activation.tier === 'level_1'
                  ? 'border-2 border-danger-border bg-danger-subtle'
                  : 'border border-strong bg-layer-1'
              }`}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="flex flex-wrap items-center gap-2 text-base font-medium">
                    <Badge tone={TIER_TONE[activation.tier] ?? 'neutral'}>
                      {TIER_LABEL[activation.tier] ?? activation.tier}
                    </Badge>
                    {activation.displayName ?? activation.erNo ?? 'Unidentified'}
                    {activation.status === 'active' ? null : (
                      <Badge tone="neutral">{activation.status.replace('_', ' ')}</Badge>
                    )}
                  </p>
                  <p className="mt-1 text-2xs text-fg-muted">
                    <span className="font-mono">{activation.erNo ?? '—'}</span> · running{' '}
                    {activation.minutesActive} min · {answered(activation.pages)} of {activation.pages.length}{' '}
                    answered
                  </p>
                  <p className="mt-1 text-2xs text-fg-subtle">
                    {activation.clinicalJudgement
                      ? 'Called on clinical judgement.'
                      : `Criteria: ${activation.criteriaFired
                          .map((criterion) => criterion.replace(/_/gu, ' '))
                          .join(', ')}`}
                  </p>
                  {activation.standDownReason === null ? null : (
                    <p className="mt-1 text-sm">Stood down: {activation.standDownReason}</p>
                  )}
                </div>
                {activation.status === 'active' && canStandDown ? (
                  <Button
                    type="button"
                    data-testid={`standdown-${activation.id}`}
                    onClick={() => {
                      setStandingDown(standingDown === activation.id ? null : activation.id);
                    }}
                  >
                    Stand down
                  </Button>
                ) : null}
              </div>

              {standingDown === activation.id ? (
                <form
                  className="mt-3 flex flex-wrap items-end gap-3 rounded-md border border-dashed border-strong p-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    release.mutate(activation.id);
                  }}
                >
                  <div className="flex min-w-80 flex-1 flex-col gap-1">
                    <Label htmlFor={`reason-${activation.id}`}>Why is the team being released?</Label>
                    <Input
                      id={`reason-${activation.id}`}
                      value={reason}
                      autoComplete="off"
                      placeholder="Patient to theatre with the team; resuscitation handed over"
                      onChange={(event) => {
                        setReason(event.target.value);
                      }}
                    />
                    <p className="text-2xs text-fg-subtle">
                      Stored on the activation. The next stand-down is read in the light of this one.
                    </p>
                  </div>
                  <Button type="submit" disabled={reason.trim().length < 8 || release.isPending}>
                    Release the team
                  </Button>
                </form>
              ) : null}

              {/* ── Who answered ──────────────────────────────────────── */}
              <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {activation.pages.map((page) => (
                  <li
                    key={page.id}
                    className="flex items-center justify-between gap-2 rounded-md border border-default bg-layer-1 px-3 py-2 text-sm"
                  >
                    <span className="min-w-0">
                      <span className="block truncate capitalize">{roleLabel(page.role)}</span>
                      <span className="block text-2xs text-fg-subtle">
                        {page.acknowledgedAt === null
                          ? 'No answer yet'
                          : `Answered in ${String(page.secondsToAcknowledge ?? 0)}s${
                              page.etaMinutes === null ? '' : `, ETA ${String(page.etaMinutes)} min`
                            }`}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <Badge tone={PAGE_TONE[page.status] ?? 'neutral'}>{page.status}</Badge>
                      {canAcknowledge && page.acknowledgedAt === null && activation.status === 'active' ? (
                        <>
                          <Input
                            aria-label={`ETA in minutes for ${roleLabel(page.role)}`}
                            inputMode="numeric"
                            className="h-8 w-16"
                            placeholder="min"
                            value={eta[page.id] ?? ''}
                            onChange={(event) => {
                              const next = event.target.value;
                              setEta((current) => ({ ...current, [page.id]: next }));
                            }}
                          />
                          <Button
                            type="button"
                            size="sm"
                            disabled={answer.isPending}
                            onClick={() => {
                              answer.mutate({ pageId: page.id, arrived: false });
                            }}
                          >
                            On my way
                          </Button>
                        </>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </AsyncPanel>

      <p className="text-2xs text-fg-subtle">
        A level-1 page cannot be silenced — not by a setting, not by a role, not by this screen. The database
        refuses both creating one suppressed and suppressing one afterwards.
      </p>
    </section>
  );
}
