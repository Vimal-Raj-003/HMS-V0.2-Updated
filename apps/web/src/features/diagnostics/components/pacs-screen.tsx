'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  EmptyState,
  Tabs,
  TabsList,
  TabsTrigger,
  Textarea,
  Label,
  WorklistTable,
  useToast,
} from '@vims/ui';
import { useMemo, useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { ContextField, isIdentifier } from '@/features/frontoffice/components/context-field';
import { EyeOff, OctagonAlert, ShieldCheck } from '@/lib/icons';
import { useSession } from '@/lib/session-context';
import { issueViewerToken, listPacsStudies, listReconciliationQueue, reconcileStudy } from '../api/client';
import { diagnosticsKeys } from '../api/keys';
import type { PacsStudyView } from '../api/types';
import { humanise } from '../lib/format';
import { formatStudySize, isQuarantined, reconcileMode, whyInQueue } from '../lib/reconciliation';
import { patientRef, worklistLabels } from '../lib/worklist-labels';

/**
 * EN-008 — the archive index and the reconciliation queue.
 *
 * ## The rule this screen is built around
 *
 * EN-008 §5: a study auto-links to a patient **only when it matched on an
 * identity the RIS itself minted** — the accession number, or the Study Instance
 * UID the worklist published. Anything else is a guess, and a guess goes to the
 * reconciliation queue rather than into a chart.
 *
 * So there is, deliberately:
 *
 *  - **no name search and no name-ranked candidate list.** Name is not a match
 *    key anywhere in the spec and it is not one here. Demographic resemblance is
 *    precisely how a study ends up in the wrong chart, and the report that
 *    follows is written about the wrong body.
 *  - **no bulk confirm.** Reconciling is a named human decision per study;
 *    `rad.study.reconcile` is `requiresReason` for that reason.
 *  - **a different action for a trusted match and a guessed one.** A trusted
 *    match is one click. A guess requires the human to *name* the patient — and
 *    the API refuses the guess without one, as does the CHECK underneath it.
 *
 * ## The viewer
 *
 * `POST /pacs/studies/{id}/viewer-token` returns a **token and an Orthanc object
 * id, never an image**: EN-008 §5 keeps the archive ports off the public
 * network, and this service indexes the archive rather than proxying it. Every
 * issue is written to `pacs_view_audit` *before* the token exists, so an image
 * view is auditable even when the viewer never loads. This screen shows the
 * grant and its expiry rather than embedding a viewer, because embedding OHIF is
 * EN-008's own deliverable and not this one.
 */
export function PacsScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = diagnosticsKeys(hospitalId);
  const queryClient = useQueryClient();
  const { publish } = useToast();

  const [tab, setTab] = useState<'all' | 'queue'>('all');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [namedPatient, setNamedPatient] = useState('');
  const [note, setNote] = useState('');
  const [grant, setGrant] = useState<{ readonly token: string; readonly expiresAt: string } | null>(null);

  const canReconcile = granted.has('rad.study.reconcile');
  const canView = granted.has('rad.image.view');

  const studies = useQuery({
    queryKey: keys.pacsStudies(tab),
    queryFn: ({ signal }) =>
      tab === 'queue'
        ? listReconciliationQueue({ cursor }, { signal })
        : listPacsStudies({ cursor }, { signal }),
    enabled: tab === 'all' || canReconcile,
  });

  const selected = useMemo<PacsStudyView | null>(
    () => (studies.data?.items ?? []).find((study) => study.id === selectedId) ?? null,
    [studies.data, selectedId],
  );

  const mode = selected === null ? null : reconcileMode(selected);

  const reconcile = useMutation({
    mutationFn: () => {
      if (selected === null || mode === null) throw new Error('No study is selected.');
      if (mode.kind === 'name_the_patient' && !isIdentifier(namedPatient)) {
        throw new Error(
          'This study was matched on a demographic resemblance. Confirming it means naming the patient it belongs to.',
        );
      }
      return reconcileStudy(
        selected.id,
        {
          ...(mode.kind === 'name_the_patient' ? { patientId: namedPatient.trim() } : {}),
          ...(note.trim() === '' ? {} : { note: note.trim() }),
        },
        note.trim() === ''
          ? `Reconciled against a ${mode.kind === 'confirm_trusted' ? mode.basis : 'named patient'} match.`
          : note.trim(),
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.pacsStudiesRoot() });
      setNamedPatient('');
      setNote('');
      publish({ title: 'Study reconciled', severity: 'success' });
    },
  });

  const viewer = useMutation({
    mutationFn: (studyId: string) =>
      issueViewerToken(studyId, { action: 'view', scope: 'view', expiresInMinutes: 15 }),
    onSuccess: (result) => {
      setGrant({ token: result.token, expiresAt: result.expiresAt });
      publish({
        title: 'Viewer grant issued',
        description: 'The access is already in the audit trail, whether or not the viewer opens.',
        severity: 'info',
      });
    },
  });

  return (
    <section className="flex flex-col gap-4" data-testid="pacs-screen">
      <PageHeader
        eyebrow="EN-008 · archive"
        title="PACS studies"
        description="What arrived, what it matched on, and what may not be attached to any chart until somebody names the patient it belongs to."
        actions={
          <Tabs
            value={tab}
            onValueChange={(next) => {
              setTab(next === 'queue' ? 'queue' : 'all');
              setCursor(undefined);
              setSelectedId(null);
            }}
          >
            <TabsList>
              <TabsTrigger value="all">All studies</TabsTrigger>
              <TabsTrigger value="queue">Reconciliation queue</TabsTrigger>
            </TabsList>
          </Tabs>
        }
      />

      {tab === 'queue' && !canReconcile ? (
        <EmptyState
          cause="Reconciling a study is not one of your permissions."
          nextAction="The queue is worked by radiology technologists and archive administrators, and every decision records a reason."
        />
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
          <AsyncPanel
            loading={studies.isPending}
            error={studies.error}
            isEmpty={(studies.data?.items.length ?? 0) === 0}
            skeletonLabel="Loading studies"
            onRetry={() => {
              void studies.refetch();
            }}
            empty={
              <EmptyState
                icon={<ShieldCheck aria-hidden="true" />}
                cause={
                  tab === 'queue'
                    ? 'No study is waiting to be reconciled.'
                    : 'No study is indexed in the archive for this hospital.'
                }
                nextAction={
                  tab === 'queue'
                    ? 'Every study currently in the archive matched on an accession number or a Study Instance UID, which is the only basis the archive links on by itself.'
                    : 'Studies appear here as the modalities send them. If one is missing, check the modality worklist first — no order means no worklist entry.'
                }
              />
            }
          >
            <WorklistTable
              rows={studies.data?.items ?? []}
              getRowId={(row) => row.id}
              labels={worklistLabels(tab === 'queue' ? 'Reconciliation queue' : 'Archive studies')}
              empty={{
                cause: tab === 'queue' ? 'Nothing to reconcile.' : 'No study indexed.',
                nextAction: 'Studies appear as the modalities send them.',
              }}
              onRowOpen={(row) => {
                setSelectedId(row.id);
                setGrant(null);
              }}
              criticalRowIds={new Set((studies.data?.items ?? []).filter(isQuarantined).map((row) => row.id))}
              hasMore={studies.data?.hasMore ?? false}
              loading={studies.isFetching}
              onLoadMore={() => {
                setCursor(studies.data?.nextCursor ?? undefined);
              }}
              columns={[
                {
                  key: 'accession',
                  header: 'Accession',
                  hideable: false,
                  render: (row) => <span className="font-mono text-xs">{row.accessionNo ?? '—'}</span>,
                },
                {
                  key: 'patient',
                  header: 'Patient ref',
                  hideable: false,
                  render: (row) =>
                    row.patientId === null ? (
                      <Badge tone="danger" icon={<OctagonAlert aria-hidden="true" />}>
                        not attached
                      </Badge>
                    ) : (
                      <span className="font-mono text-xs">{patientRef(row.patientId)}</span>
                    ),
                },
                {
                  key: 'modality',
                  header: 'Modality',
                  render: (row) => <span className="text-xs">{row.modality ?? '—'}</span>,
                },
                {
                  key: 'matched',
                  header: 'Matched on',
                  hideable: false,
                  render: (row) => (
                    <Badge tone={isQuarantined(row) ? 'warning' : 'neutral'}>{humanise(row.matchedBy)}</Badge>
                  ),
                },
                {
                  key: 'reconciliation',
                  header: 'Reconciliation',
                  render: (row) => <span className="text-xs">{humanise(row.reconciliationStatus)}</span>,
                },
                {
                  key: 'size',
                  header: 'Size',
                  numeric: true,
                  importance: 'secondary',
                  render: (row) => (
                    <span className="font-mono text-2xs tabular-nums">{formatStudySize(row.sizeBytes)}</span>
                  ),
                },
                {
                  key: 'counts',
                  header: 'Series / images',
                  numeric: true,
                  importance: 'secondary',
                  render: (row) => (
                    <span className="font-mono text-2xs tabular-nums">
                      {row.seriesCount} / {row.instanceCount}
                    </span>
                  ),
                },
              ]}
            />
          </AsyncPanel>

          <section className="flex flex-col gap-3 rounded-lg border border-strong bg-layer-1 p-4">
            {selected === null || mode === null ? (
              <EmptyState
                cause="No study is open."
                nextAction="Open one from the list to see what it matched on and what confirming it would mean."
              />
            ) : (
              <>
                <header className="flex flex-col gap-1 border-b border-default pb-2">
                  <p className="font-mono text-sm text-fg-default">{selected.studyInstanceUid}</p>
                  <p className="text-2xs text-fg-muted">
                    {selected.modality ?? 'unknown modality'} · {selected.seriesCount} series ·{' '}
                    {selected.instanceCount} images · {formatStudySize(selected.sizeBytes)}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {selected.isMlc ? <Badge tone="violet">medico-legal</Badge> : null}
                    {selected.legalHold ? <Badge tone="violet">legal hold</Badge> : null}
                    <Badge tone="neutral">tier {humanise(selected.tier)}</Badge>
                  </div>
                </header>

                <p className="text-sm text-fg-muted" data-testid="why-in-queue">
                  {whyInQueue(selected)}
                </p>

                {mode.kind === 'already_reconciled' ? (
                  <p className="text-sm text-fg-muted">
                    This study has already been reconciled. Moving it to a different patient is a
                    re-assignment, not a reconciliation, and needs a second pair of eyes through a PACS
                    correction.
                  </p>
                ) : canReconcile ? (
                  <div className="flex flex-col gap-3">
                    {mode.kind === 'name_the_patient' ? (
                      <>
                        <div
                          role="alert"
                          data-testid="guessed-match-warning"
                          className="rounded-md border border-warning-border bg-warning-surface p-3 text-sm text-warning-on-surface"
                        >
                          The archive did not match this on an identifier the hospital minted. Confirming it
                          means naming the patient — there is no one-click confirm for a resemblance, and
                          there is no search by name on this screen.
                        </div>
                        <ContextField
                          label="Patient this study belongs to"
                          hint="Verify it against the study itself, not against a name that looks similar."
                          value={namedPatient}
                          onChange={setNamedPatient}
                          testId="named-patient"
                        />
                      </>
                    ) : (
                      <p className="text-sm text-fg-muted">
                        Matched on <span className="font-mono">{mode.basis}</span>, an identifier this
                        hospital minted. Confirming it is a single decision, and it is still recorded with a
                        reason.
                      </p>
                    )}

                    <div className="flex flex-col gap-1">
                      <Label htmlFor="reconcile-note">Reason / note</Label>
                      <Textarea
                        id="reconcile-note"
                        data-testid="reconcile-note"
                        rows={2}
                        value={note}
                        onChange={(event) => {
                          setNote(event.target.value);
                        }}
                      />
                    </div>

                    <Button
                      data-testid="reconcile-study"
                      className="self-start"
                      disabled={
                        reconcile.isPending ||
                        (mode.kind === 'name_the_patient' && !isIdentifier(namedPatient))
                      }
                      onClick={() => {
                        reconcile.mutate();
                      }}
                    >
                      {mode.kind === 'name_the_patient' ? 'Attach to this patient' : 'Confirm the match'}
                    </Button>
                    {reconcile.error === null ? null : <ProblemCard error={reconcile.error} />}
                  </div>
                ) : (
                  <p className="text-sm text-fg-muted">
                    You can read the archive index but not reconcile. Reconciling is a named decision with a
                    recorded reason, held by radiology technologists and archive administrators.
                  </p>
                )}

                <div className="flex flex-col gap-2 border-t border-default pt-3">
                  <Button
                    variant="secondary"
                    className="self-start"
                    data-testid="issue-viewer-token"
                    disabled={!canView || isQuarantined(selected) || viewer.isPending}
                    onClick={() => {
                      viewer.mutate(selected.id);
                    }}
                  >
                    Open in the viewer
                  </Button>
                  {isQuarantined(selected) ? (
                    <p className="flex items-start gap-2 text-2xs text-fg-subtle">
                      <EyeOff className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                      An unreconciled study is quarantined: it cannot be viewed against a chart or reported
                      until it is linked to an order.
                    </p>
                  ) : null}
                  {grant === null ? null : (
                    <p className="text-2xs text-fg-muted" data-testid="viewer-grant">
                      A viewing grant was issued and audited. It expires at {grant.expiresAt}. The archive
                      gateway verifies the token; no image passes through this application.
                    </p>
                  )}
                  {viewer.error === null ? null : <ProblemCard error={viewer.error} />}
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </section>
  );
}
