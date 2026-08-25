'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, EmptyState, Input, Label, Textarea, WorklistTable, useToast } from '@vims/ui';
import { useMemo, useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { ShortcutBar } from '@/features/frontoffice/components/keyboard-sheet';
import { useShortcuts, type Shortcut } from '@/features/frontoffice/lib/shortcuts';
import { OctagonAlert, TriangleAlert } from '@/lib/icons';
import { useSession } from '@/lib/session-context';
import {
  amendRadReport,
  createRadReport,
  issuePreliminary,
  listCriticalFindings,
  listReadingWorklist,
  raiseCriticalFinding,
  recordRadCriticalCallback,
  signRadReport,
  updateRadReport,
} from '../api/client';
import { diagnosticsKeys } from '../api/keys';
import { FINDING_LEVELS, type FindingLevel, type ReadingWorklistItem } from '../api/types';
import {
  EMPTY_CALLBACK_FORM,
  canRecordCallback,
  toRadCallbackRequest,
  type CallbackFormState,
} from '../lib/critical';
import { formatInstant, humanise, priorityTone, tatVerdict } from '../lib/format';
import { FOETAL_SEX_REFUSAL, mentionsFoetalSex } from '../lib/pcpndt';
import { patientRef, worklistLabels } from '../lib/worklist-labels';
import { CallbackForm } from './callback-form';

/**
 * OP-008 §3.4 — the reading worklist and the report.
 *
 * ## Draft → preliminary → signed → amended, and why each step is separate
 *
 * `rad.report.create`, `rad.report.preliminary`, `rad.report.sign` and
 * `rad.report.amend` are four keys, not one. A resident may draft and issue a
 * wet read; only a registered radiologist signs. `rad.report.sign` is
 * `requiresStepUp` — a session that has been idle is asked to prove itself again
 * before a signature carries somebody's name. `rad.report.amend` is
 * `requiresReason`, and the reason prints on the amended report, because
 * `docs/06` §1.1 heuristic 3 says a clinical document is never *undone*: it is
 * superseded, with both versions visible.
 *
 * The autosave is a `PATCH` and is deliberately **not** idempotent — an autosave
 * is a last-write-wins overwrite by design, and giving it an idempotency key
 * would make the second keystroke replay the first.
 *
 * ## PC-PNDT, on the text rather than on a field
 *
 * There is no foetal-sex field on this screen — there is none anywhere in this
 * product. But OP-022 §5 and AC §14.4 require a **content** check too, because
 * prose can say what a field cannot, and `rad-reports.service.ts` applies it
 * server-side on sign. The same pattern runs here, before the click, so the
 * radiologist is told what to change rather than meeting a `statutory-limit`
 * refusal after pressing sign. It **refuses**; it never rewrites. A product that
 * quietly stripped the phrase and stored the rest would be helping to
 * communicate it in the manner that remained.
 *
 * ## The critical-finding loop
 *
 * Identical in shape to the laboratory's, and for the same reason: D-10 admits a
 * read-back from a named clinician or a documented escalation, and no third
 * state. `rad.critical.notify` and `rad.critical.read` are `clinicalSafetyExempt`
 * — a hospital whose subscription has lapsed still gets its intracranial
 * haemorrhage to a human.
 */
export function RadReadingScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = diagnosticsKeys(hospitalId);
  const queryClient = useQueryClient();
  const { publish } = useToast();

  const [modality, setModality] = useState('');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [focused, setFocused] = useState<ReadingWorklistItem | null>(null);
  const [reportId, setReportId] = useState<string | null>(null);
  const [findings, setFindings] = useState('');
  const [impression, setImpression] = useState('');
  const [recommendations, setRecommendations] = useState('');
  const [level, setLevel] = useState<FindingLevel>('none');
  const [amendReason, setAmendReason] = useState('');

  const [criticalText, setCriticalText] = useState('');
  const [findingId, setFindingId] = useState<string | null>(null);
  const [callback, setCallback] = useState<CallbackFormState>(EMPTY_CALLBACK_FORM);

  const canPreliminary = granted.has('rad.report.preliminary');
  const canSign = granted.has('rad.report.sign');
  const canAmend = granted.has('rad.report.amend');
  const canNotify = granted.has('rad.critical.notify');
  const canReadCriticals = granted.has('rad.critical.read');

  const worklist = useQuery({
    queryKey: keys.readingWorklist(modality === '' ? 'all' : modality, 'all'),
    queryFn: ({ signal }) =>
      listReadingWorklist(modality === '' ? { cursor } : { modality, cursor }, { signal }),
  });

  const criticals = useQuery({
    queryKey: keys.radCriticals(modality === '' ? 'all' : modality),
    queryFn: ({ signal }) => listCriticalFindings({ status: 'open' }, { signal }),
    enabled: canReadCriticals,
    refetchInterval: 60_000,
  });

  function refresh(): void {
    void queryClient.invalidateQueries({ queryKey: keys.readingWorklistRoot() });
    void queryClient.invalidateQueries({ queryKey: keys.radCriticalsRoot() });
  }

  /**
   * The PC-PNDT pre-flight.
   *
   * Checked across findings, impression and recommendations together, because
   * the Act does not care which box the sentence was typed into.
   */
  const statutoryRefusal = mentionsFoetalSex(findings, impression, recommendations)
    ? FOETAL_SEX_REFUSAL
    : null;

  const draft = useMutation({
    mutationFn: () => {
      if (focused === null) throw new Error('No study is open.');
      return createRadReport({
        orderItemId: focused.orderItemId,
        findingLevel: level,
        requestCosign: false,
        ...(findings.trim() === '' ? {} : { findingsText: findings.trim() }),
        ...(impression.trim() === '' ? {} : { impressionText: impression.trim() }),
      });
    },
    onSuccess: (report) => {
      setReportId(report.id);
      refresh();
      publish({ title: 'Draft created', severity: 'success' });
    },
  });

  const autosave = useMutation({
    mutationFn: () => {
      if (reportId === null) throw new Error('No draft exists yet.');
      return updateRadReport(reportId, {
        findingLevel: level,
        ...(findings.trim() === '' ? {} : { findingsText: findings.trim() }),
        ...(impression.trim() === '' ? {} : { impressionText: impression.trim() }),
        ...(recommendations.trim() === '' ? {} : { recommendations: recommendations.trim() }),
      });
    },
    onSuccess: () => {
      publish({ title: 'Draft saved', severity: 'info' });
    },
  });

  const preliminary = useMutation({
    mutationFn: () => {
      if (reportId === null) throw new Error('No draft exists yet.');
      return issuePreliminary(reportId, {
        signMethod: 'system',
        findingLevel: level,
        ...(impression.trim() === '' ? {} : { impressionText: impression.trim() }),
      });
    },
    onSuccess: () => {
      refresh();
      publish({
        title: 'Preliminary issued',
        description: 'It reaches the referring doctor watermarked "Preliminary". The final overrides it.',
        severity: 'success',
      });
    },
  });

  const sign = useMutation({
    mutationFn: () => {
      if (reportId === null) throw new Error('No draft exists yet.');
      if (statutoryRefusal !== null) throw new Error(statutoryRefusal);
      return signRadReport(reportId, {
        signMethod: 'system',
        findingLevel: level,
        ...(impression.trim() === '' ? {} : { impressionText: impression.trim() }),
      });
    },
    onSuccess: () => {
      refresh();
      publish({ title: 'Report signed', severity: 'success' });
    },
  });

  const amend = useMutation({
    mutationFn: () => {
      if (reportId === null) throw new Error('No report exists yet.');
      if (statutoryRefusal !== null) throw new Error(statutoryRefusal);
      return amendRadReport(reportId, {
        reason: amendReason.trim(),
        signMethod: 'system',
        findingLevel: level,
        impressionText: impression.trim(),
        ...(findings.trim() === '' ? {} : { findingsText: findings.trim() }),
        ...(recommendations.trim() === '' ? {} : { recommendations: recommendations.trim() }),
      });
    },
    onSuccess: () => {
      refresh();
      setAmendReason('');
      publish({
        title: 'Amended',
        description: 'A new version. The original is retained and the reason prints on the amended report.',
        severity: 'success',
      });
    },
  });

  const raise = useMutation({
    mutationFn: () => {
      if (reportId === null) throw new Error('No report exists yet.');
      return raiseCriticalFinding(reportId, {
        level: 'critical',
        findingText: criticalText.trim(),
        dueInMinutes: 60,
      });
    },
    onSuccess: (finding) => {
      setFindingId(finding.id);
      setCriticalText('');
      refresh();
      publish({
        title: 'Critical finding raised',
        description: 'It is on the clock. Record the call-back before the escalation ladder does it for you.',
        severity: 'danger',
      });
    },
  });

  const callbackMutation = useMutation({
    mutationFn: (id: string) => recordRadCriticalCallback(id, toRadCallbackRequest(callback)),
    onSuccess: () => {
      setCallback(EMPTY_CALLBACK_FORM);
      refresh();
      publish({ title: 'Communication recorded', severity: 'success' });
    },
  });

  const shortcuts: readonly Shortcut[] = useMemo(
    () => [
      {
        key: 'Enter',
        ctrl: true,
        label: 'Sign the report',
        keys: ['Ctrl', '↵'],
        enabled: canSign && reportId !== null && statutoryRefusal === null && !sign.isPending,
        run: () => {
          sign.mutate();
        },
      },
      {
        key: 'p',
        ctrl: true,
        shift: true,
        label: 'Issue a preliminary read',
        keys: ['Ctrl', 'Shift', 'P'],
        enabled: canPreliminary && reportId !== null && !preliminary.isPending,
        run: () => {
          preliminary.mutate();
        },
      },
      {
        key: 'c',
        alt: true,
        label: 'Raise a critical finding',
        keys: ['Alt', 'C'],
        enabled: canNotify && reportId !== null,
        run: () => {
          document.querySelector<HTMLTextAreaElement>('[data-testid="critical-text"]')?.focus();
        },
      },
    ],
    [canSign, canPreliminary, canNotify, reportId, statutoryRefusal, sign, preliminary],
  );
  useShortcuts(shortcuts);

  const now = new Date();

  return (
    <section className="flex flex-col gap-4" data-testid="rad-reading-screen">
      <PageHeader
        eyebrow="OP-008 §3.4 · reading"
        title="Reading worklist"
        description="STAT first, then urgent, then routine by age. Draft, wet read, signature and amendment are four different keys, and the signature is the one that carries a name."
        actions={
          <div className="flex min-w-40 flex-col gap-1">
            <Label htmlFor="modality-filter">Modality</Label>
            <Input
              id="modality-filter"
              data-testid="modality-filter"
              placeholder="CT, MR, CR…"
              value={modality}
              onChange={(event) => {
                setModality(event.target.value.toUpperCase().slice(0, 8));
                setCursor(undefined);
              }}
            />
          </div>
        }
      />

      {canReadCriticals && (criticals.data?.items.length ?? 0) > 0 ? (
        <div
          role="alert"
          data-testid="open-criticals"
          className="rounded-lg border border-danger-border bg-danger-surface p-3 text-sm text-danger-on-surface"
        >
          <p className="flex items-center gap-2 font-medium">
            <OctagonAlert className="size-4 shrink-0" aria-hidden="true" />
            {criticals.data?.items.length} critical finding
            {(criticals.data?.items.length ?? 0) === 1 ? '' : 's'} still waiting for a documented call-back
          </p>
          <ul className="mt-1 flex flex-col gap-1">
            {(criticals.data?.items ?? []).map((finding) => (
              <li key={finding.id}>
                <button
                  type="button"
                  data-testid={`finding-${finding.id}`}
                  className="text-start underline underline-offset-2"
                  onClick={() => {
                    setFindingId(finding.id);
                  }}
                >
                  {patientRef(finding.patientId)} — {finding.findingText} · escalation tier{' '}
                  {finding.escalationLevel} · {finding.callbackCount} attempt
                  {finding.callbackCount === 1 ? '' : 's'}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <AsyncPanel
          loading={worklist.isPending}
          error={worklist.error}
          isEmpty={(worklist.data?.items.length ?? 0) === 0}
          skeletonLabel="Loading the reading worklist"
          onRetry={() => {
            void worklist.refetch();
          }}
          empty={
            <EmptyState
              cause={
                modality === ''
                  ? 'Nothing is waiting to be read.'
                  : `Nothing on ${modality} is waiting to be read.`
              }
              nextAction={
                modality === ''
                  ? 'Studies reach this list once the technologist completes them and the images are in the archive.'
                  : 'Clear the modality filter to see the rest of the queue.'
              }
            />
          }
        >
          <WorklistTable
            rows={worklist.data?.items ?? []}
            getRowId={(row) => row.orderItemId}
            labels={worklistLabels('Reading worklist')}
            empty={{
              cause: 'Nothing is waiting to be read.',
              nextAction: 'Studies appear once the technologist completes them.',
            }}
            onRowOpen={(row) => {
              setFocused(row);
              setReportId(row.reportId);
              setFindings('');
              setImpression('');
              setRecommendations('');
              setLevel('none');
            }}
            criticalRowIds={
              new Set(
                (worklist.data?.items ?? [])
                  .filter((row) => row.priority === 'stat' || row.priority === 'portable_stat')
                  .map((row) => row.orderItemId),
              )
            }
            hasMore={worklist.data?.hasMore ?? false}
            loading={worklist.isFetching}
            onLoadMore={() => {
              setCursor(worklist.data?.nextCursor ?? undefined);
            }}
            columns={[
              {
                key: 'accession',
                header: 'Accession',
                hideable: false,
                render: (row) => <span className="font-mono text-xs">{row.accessionNo}</span>,
              },
              {
                key: 'patient',
                header: 'Patient ref',
                hideable: false,
                render: (row) => <span className="font-mono text-xs">{patientRef(row.patientId)}</span>,
              },
              {
                key: 'procedure',
                header: 'Study',
                render: (row) => (
                  <span className="text-sm">
                    <span className="font-mono text-xs text-fg-muted">{row.modality}</span>{' '}
                    {row.procedureName}
                  </span>
                ),
              },
              {
                key: 'priority',
                header: 'Priority',
                render: (row) => (
                  <span className={`text-xs font-medium ${priorityTone(row.priority)}`}>
                    {humanise(row.priority)}
                  </span>
                ),
              },
              {
                key: 'tat',
                header: 'Turnaround',
                render: (row) => {
                  const verdict = tatVerdict(row.tatDueAt, row.orderedAt, now);
                  return <span className={`text-xs ${verdict.toneClass}`}>{verdict.label}</span>;
                },
              },
              {
                key: 'indication',
                header: 'Clinical question',
                importance: 'secondary',
                render: (row) => <span className="text-xs text-fg-muted">{row.clinicalIndication}</span>,
              },
              {
                key: 'ordered',
                header: 'Ordered',
                importance: 'secondary',
                render: (row) => <span className="font-mono text-2xs">{formatInstant(row.orderedAt)}</span>,
              },
            ]}
          />
        </AsyncPanel>

        <section className="flex flex-col gap-3 rounded-lg border border-strong bg-layer-1 p-4">
          {focused === null ? (
            <EmptyState
              cause="No study is open."
              nextAction="Open a row from the worklist. The report editor opens against it, with the clinical question it has to answer."
            />
          ) : (
            <>
              <header className="flex flex-col gap-1 border-b border-default pb-2">
                <p className="text-md font-medium text-fg-default">
                  {focused.modality} {focused.procedureName}
                </p>
                <p className="font-mono text-2xs text-fg-muted">
                  {focused.accessionNo} · {patientRef(focused.patientId)} · {humanise(focused.status)}
                </p>
                <p className="text-sm text-fg-muted">{focused.clinicalIndication}</p>
              </header>

              <div className="flex flex-col gap-1">
                <Label htmlFor="report-findings">Findings</Label>
                <Textarea
                  id="report-findings"
                  data-testid="report-findings"
                  rows={6}
                  value={findings}
                  onChange={(event) => {
                    setFindings(event.target.value);
                  }}
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="report-impression">Impression</Label>
                <Textarea
                  id="report-impression"
                  data-testid="report-impression"
                  rows={3}
                  value={impression}
                  onChange={(event) => {
                    setImpression(event.target.value);
                  }}
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="report-recommendations">Recommendations</Label>
                <Textarea
                  id="report-recommendations"
                  data-testid="report-recommendations"
                  rows={2}
                  value={recommendations}
                  onChange={(event) => {
                    setRecommendations(event.target.value);
                  }}
                />
              </div>
              <div className="flex min-w-48 flex-col gap-1">
                <Label htmlFor="finding-level">Finding level</Label>
                <select
                  id="finding-level"
                  data-testid="finding-level"
                  className="h-9 rounded-md border border-control bg-layer-1 px-2 text-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                  value={level}
                  onChange={(event) => {
                    setLevel(event.target.value as FindingLevel);
                  }}
                >
                  {FINDING_LEVELS.map((one) => (
                    <option key={one} value={one}>
                      {humanise(one)}
                    </option>
                  ))}
                </select>
              </div>

              {statutoryRefusal === null ? null : (
                <p
                  role="alert"
                  data-testid="pcpndt-refusal"
                  className="rounded-md border border-danger-border bg-danger-surface p-3 text-sm text-danger-on-surface"
                >
                  {statutoryRefusal}
                </p>
              )}

              <div className="flex flex-wrap gap-2 border-t border-default pt-3">
                <Button
                  variant="secondary"
                  data-testid="create-draft"
                  disabled={reportId !== null || draft.isPending}
                  onClick={() => {
                    draft.mutate();
                  }}
                >
                  Create draft
                </Button>
                <Button
                  variant="ghost"
                  data-testid="autosave"
                  disabled={reportId === null || autosave.isPending}
                  onClick={() => {
                    autosave.mutate();
                  }}
                >
                  Save draft
                </Button>
                <Button
                  variant="secondary"
                  data-testid="issue-preliminary"
                  disabled={!canPreliminary || reportId === null || preliminary.isPending}
                  onClick={() => {
                    preliminary.mutate();
                  }}
                >
                  Issue preliminary
                </Button>
                <Button
                  data-testid="sign-report"
                  disabled={!canSign || reportId === null || statutoryRefusal !== null || sign.isPending}
                  onClick={() => {
                    sign.mutate();
                  }}
                >
                  {sign.isPending ? 'Signing…' : 'Sign'}
                </Button>
              </div>

              {canAmend ? (
                <div className="flex flex-col gap-1 border-t border-default pt-3">
                  <Label htmlFor="amend-reason">Amendment reason</Label>
                  <Textarea
                    id="amend-reason"
                    data-testid="amend-reason"
                    rows={2}
                    value={amendReason}
                    onChange={(event) => {
                      setAmendReason(event.target.value);
                    }}
                  />
                  <p className="text-2xs text-fg-subtle">
                    A signed report is never edited. An amendment is a new version; the original stays
                    retrievable and the reason prints on the amended report.
                  </p>
                  <Button
                    variant="secondary"
                    className="self-start"
                    data-testid="amend-report"
                    disabled={
                      reportId === null ||
                      amendReason.trim().length < 8 ||
                      impression.trim() === '' ||
                      statutoryRefusal !== null ||
                      amend.isPending
                    }
                    onClick={() => {
                      amend.mutate();
                    }}
                  >
                    Amend
                  </Button>
                </div>
              ) : null}

              {draft.error === null ? null : <ProblemCard error={draft.error} />}
              {autosave.error === null ? null : <ProblemCard error={autosave.error} />}
              {preliminary.error === null ? null : <ProblemCard error={preliminary.error} />}
              {sign.error === null ? null : <ProblemCard error={sign.error} />}
              {amend.error === null ? null : <ProblemCard error={amend.error} />}

              {canNotify ? (
                <section className="flex flex-col gap-2 border-t border-default pt-3">
                  <h3 className="flex items-center gap-2 text-md font-medium text-fg-default">
                    <TriangleAlert className="size-4" aria-hidden="true" />
                    Critical finding
                  </h3>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="critical-text">What did you find?</Label>
                    <Textarea
                      id="critical-text"
                      data-testid="critical-text"
                      rows={2}
                      value={criticalText}
                      onChange={(event) => {
                        setCriticalText(event.target.value);
                      }}
                    />
                  </div>
                  <Button
                    variant="danger"
                    className="self-start"
                    data-testid="raise-critical"
                    disabled={reportId === null || criticalText.trim().length < 3 || raise.isPending}
                    onClick={() => {
                      raise.mutate();
                    }}
                  >
                    Raise it and start the clock
                  </Button>
                  {raise.error === null ? null : <ProblemCard error={raise.error} />}

                  {findingId === null ? null : (
                    <>
                      <Badge tone="danger" icon={<OctagonAlert aria-hidden="true" />}>
                        Recording the call-back for finding {findingId.slice(-6)}
                      </Badge>
                      <CallbackForm
                        form={callback}
                        onChange={setCallback}
                        disabled={callbackMutation.isPending}
                      />
                      <Button
                        className="self-start"
                        data-testid="record-rad-callback"
                        disabled={!canRecordCallback(callback) || callbackMutation.isPending}
                        onClick={() => {
                          callbackMutation.mutate(findingId);
                        }}
                      >
                        Record this communication
                      </Button>
                      {callbackMutation.error === null ? null : (
                        <ProblemCard error={callbackMutation.error} />
                      )}
                    </>
                  )}
                </section>
              ) : null}
            </>
          )}
        </section>
      </div>

      <ShortcutBar shortcuts={shortcuts} label="Reading shortcuts" />
    </section>
  );
}
