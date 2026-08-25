'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, EmptyState, Input, Label, Textarea, WorklistTable, useToast } from '@vims/ui';
import { useMemo, useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { ShortcutBar } from '@/features/frontoffice/components/keyboard-sheet';
import { useShortcuts, type Shortcut } from '@/features/frontoffice/lib/shortcuts';
import { TriangleAlert } from '@/lib/icons';
import { useSession } from '@/lib/session-context';
import {
  checkInInvestigation,
  completeInvestigation,
  cosignInvestigationReport,
  createInvestigationReport,
  listInvestigationWorklist,
  sendInvestigationForCosign,
  signInvestigationReport,
  startInvestigation,
} from '../api/client';
import { diagnosticsKeys } from '../api/keys';
import { MODALITY_GROUPS, type InvestigationStudyView, type ModalityGroup } from '../api/types';
import { formatInstant, humanise, priorityTone } from '../lib/format';
import { FOETAL_SEX_REFUSAL, mentionsFoetalSex } from '../lib/pcpndt';
import { patientRef, worklistLabels } from '../lib/worklist-labels';

/**
 * OP-022 — everything that is neither a lab analyzer nor a DICOM study.
 *
 * ECG strips, PFT traces, endoscopy images, external reports. The shape is the
 * same as radiology's — worklist, capture, report, sign — with two differences
 * that matter.
 *
 * ## Co-sign is a control, not a courtesy
 *
 * `invest.report.sign` and `invest.report.cosign` are two keys for one act, and
 * the split *is* the control: a resident holds the first and not the second, so
 * a service configured `cosign_required` cannot be finalised by them. OP-022 AC
 * §14.5 makes the disabled sign button explicit. `SEGREGATION_OF_DUTIES_RULES`
 * pairs create-and-cosign as a **warn** rather than a block, and the reason is
 * worth knowing: a consultant legitimately drafts their own reports and co-signs
 * a resident's. What cannot happen is one person doing both *on the same
 * report*, and that is enforced per report by
 * `clinical.enforce_investigation_cosign()`.
 *
 * ## PC-PNDT lives on the text here
 *
 * Unlike radiology — where no foetal-sex field exists to override — an
 * investigation service may legitimately be an obstetric ultrasound written on a
 * non-DICOM machine. So OP-022 §3.3.1 puts the Act's **keyword validator** on
 * the impression, with an override that is a named authorised doctor and a
 * written reason. The same pattern runs here before the click, so the refusal
 * arrives as a sentence rather than as a 422 — and it **refuses** rather than
 * rewriting, because stripping the phrase and storing the rest would be helping
 * to communicate it in the manner that remained.
 *
 * ## Identity before capture
 *
 * `identityVerified` is `z.literal(true)` on the API: "started without an
 * identity check" is not a state a request can describe. The screen asks how the
 * identity was verified, because "yes" with no method is a tick-box.
 */
export function InvestigationsScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = diagnosticsKeys(hospitalId);
  const queryClient = useQueryClient();
  const { publish } = useToast();

  const [group, setGroup] = useState<ModalityGroup | ''>('');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [focused, setFocused] = useState<InvestigationStudyView | null>(null);
  const [identityMethod, setIdentityMethod] = useState('wristband scan');
  const [impression, setImpression] = useState('');
  const [critical, setCritical] = useState(false);
  const [reportId, setReportId] = useState<string | null>(null);
  const [cosignRequired, setCosignRequired] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');

  const canManageStudy = granted.has('invest.study.manage');
  const canCreateReport = granted.has('invest.report.create');
  const canSign = granted.has('invest.report.sign');
  const canCosign = granted.has('invest.report.cosign');

  const worklist = useQuery({
    queryKey: keys.investigations('all', group === '' ? 'all' : group),
    queryFn: ({ signal }) =>
      listInvestigationWorklist(group === '' ? { cursor } : { modalityGroup: group, cursor }, { signal }),
  });

  function refresh(): void {
    void queryClient.invalidateQueries({ queryKey: keys.investigationsRoot() });
  }

  const statutoryRefusal = mentionsFoetalSex(impression) ? FOETAL_SEX_REFUSAL : null;
  const overrideOffered = statutoryRefusal !== null && focused?.isPcpndt === true;
  const overrideGiven = overrideReason.trim().length >= 8;

  const checkIn = useMutation({
    mutationFn: (id: string) => checkInInvestigation(id),
    onSuccess: () => {
      refresh();
      publish({ title: 'Checked in', severity: 'success' });
    },
  });

  const start = useMutation({
    mutationFn: (id: string) =>
      startInvestigation(id, { identityVerified: true, identityMethod: identityMethod.trim() }),
    onSuccess: () => {
      refresh();
      publish({
        title: 'Study started',
        description: 'The identity check is on the record with the method you named.',
        severity: 'success',
      });
    },
  });

  const done = useMutation({
    mutationFn: (id: string) => completeInvestigation(id, { repeatFlag: false }),
    onSuccess: () => {
      refresh();
      publish({ title: 'Study completed', severity: 'success' });
    },
  });

  const report = useMutation({
    mutationFn: (studyId: string) =>
      createInvestigationReport(studyId, { impression: impression.trim(), critical }),
    onSuccess: (created) => {
      setReportId(created.id);
      setCosignRequired(created.cosignRequired);
      refresh();
      publish({
        title: `Report ${created.reportNo} drafted`,
        description: created.cosignRequired
          ? 'This service needs a consultant co-signature before it is final.'
          : 'Sign it when you are ready.',
        severity: 'success',
      });
    },
  });

  const forCosign = useMutation({
    mutationFn: (id: string) => sendInvestigationForCosign(id),
    onSuccess: () => {
      refresh();
      publish({ title: 'Sent for co-signature', severity: 'success' });
    },
  });

  const sign = useMutation({
    mutationFn: (id: string) => {
      if (statutoryRefusal !== null && !overrideGiven) throw new Error(statutoryRefusal);
      return signInvestigationReport(id, {
        signMethod: 'system',
        ...(impression.trim() === '' ? {} : { impression: impression.trim() }),
        ...(overrideGiven ? { pcpndtOverrideReason: overrideReason.trim() } : {}),
      });
    },
    onSuccess: () => {
      refresh();
      publish({ title: 'Report signed', severity: 'success' });
    },
  });

  const cosign = useMutation({
    mutationFn: (id: string) =>
      cosignInvestigationReport(id, { signMethod: 'countersign', discrepancy: 'none' }),
    onSuccess: () => {
      refresh();
      publish({ title: 'Co-signed', severity: 'success' });
    },
  });

  const signBlocked =
    reportId === null ||
    !canSign ||
    (cosignRequired && !canCosign) ||
    (statutoryRefusal !== null && !overrideGiven);

  const shortcuts: readonly Shortcut[] = useMemo(
    () => [
      {
        key: 'Enter',
        ctrl: true,
        label: 'Sign the report',
        keys: ['Ctrl', '↵'],
        enabled: !signBlocked && !sign.isPending,
        run: () => {
          if (reportId !== null) sign.mutate(reportId);
        },
      },
    ],
    [signBlocked, sign, reportId],
  );
  useShortcuts(shortcuts);

  return (
    <section className="flex flex-col gap-4" data-testid="investigations-screen">
      <PageHeader
        eyebrow="OP-022 · investigation console"
        title="Investigation console"
        description="ECG, PFT, endoscopy, echo and the external report somebody carried in. Capture, report, co-sign, deliver."
        actions={
          <div className="flex min-w-56 flex-col gap-1">
            <Label htmlFor="modality-group">Modality group</Label>
            <select
              id="modality-group"
              data-testid="modality-group"
              className="h-9 rounded-md border border-control bg-layer-1 px-2 text-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
              value={group}
              onChange={(event) => {
                setGroup(event.target.value as ModalityGroup | '');
                setCursor(undefined);
                setFocused(null);
              }}
            >
              <option value="">Every group</option>
              {MODALITY_GROUPS.map((one) => (
                <option key={one} value={one}>
                  {humanise(one)}
                </option>
              ))}
            </select>
          </div>
        }
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <AsyncPanel
          loading={worklist.isPending}
          error={worklist.error}
          isEmpty={(worklist.data?.items.length ?? 0) === 0}
          skeletonLabel="Loading the investigation worklist"
          onRetry={() => {
            void worklist.refetch();
          }}
          empty={
            <EmptyState
              cause={
                group === ''
                  ? 'No investigation is scheduled or in progress.'
                  : `No ${humanise(group).toLowerCase()} study is scheduled or in progress.`
              }
              nextAction={
                group === ''
                  ? 'Studies appear here as they are ordered. A device under breakdown puts its studies on the reschedule list instead.'
                  : 'Clear the filter to see the rest of the console.'
              }
            />
          }
        >
          <WorklistTable
            rows={worklist.data?.items ?? []}
            getRowId={(row) => row.id}
            labels={worklistLabels('Investigation worklist')}
            empty={{
              cause: 'No investigation is scheduled or in progress.',
              nextAction: 'Studies appear here as they are ordered.',
            }}
            onRowOpen={(row) => {
              setFocused(row);
              setReportId(null);
              setImpression('');
              setCritical(false);
              setOverrideReason('');
            }}
            criticalRowIds={
              new Set(
                (worklist.data?.items ?? []).filter((row) => row.priority === 'stat').map((row) => row.id),
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
                key: 'service',
                header: 'Service',
                render: (row) => (
                  <span className="text-sm">
                    {row.serviceName}
                    <span className="ms-1 font-mono text-2xs text-fg-muted">
                      {humanise(row.modalityGroup)}
                    </span>
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
                key: 'status',
                header: 'Status',
                render: (row) => <span className="text-xs">{humanise(row.status)}</span>,
              },
              {
                key: 'flags',
                header: 'Flags',
                render: (row) => (
                  <span className="flex flex-wrap gap-1">
                    {row.isPcpndt ? <Badge tone="violet">PC-PNDT</Badge> : null}
                    {row.isIonising ? <Badge tone="warning">ionising</Badge> : null}
                  </span>
                ),
              },
              {
                key: 'media',
                header: 'Media',
                numeric: true,
                importance: 'secondary',
                render: (row) => <span className="font-mono text-2xs tabular-nums">{row.mediaCount}</span>,
              },
              {
                key: 'scheduled',
                header: 'Scheduled',
                importance: 'secondary',
                render: (row) => <span className="font-mono text-2xs">{formatInstant(row.scheduledAt)}</span>,
              },
            ]}
          />
        </AsyncPanel>

        <section className="flex flex-col gap-3 rounded-lg border border-strong bg-layer-1 p-4">
          {focused === null ? (
            <EmptyState
              cause="No study is open."
              nextAction="Open a row to check the patient in, verify their identity, and write the report."
            />
          ) : (
            <>
              <header className="flex flex-col gap-1 border-b border-default pb-2">
                <p className="text-md font-medium text-fg-default">{focused.serviceName}</p>
                <p className="font-mono text-2xs text-fg-muted">
                  {focused.accessionNo} · {patientRef(focused.patientId)} · {humanise(focused.status)}
                </p>
                {focused.isPcpndt ? (
                  <Badge tone="violet">
                    A prenatal diagnostic procedure — the Act’s text check applies to the impression
                  </Badge>
                ) : null}
              </header>

              {canManageStudy ? (
                <div className="flex flex-col gap-3">
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="identity-method">How was the patient’s identity verified?</Label>
                    <Input
                      id="identity-method"
                      data-testid="identity-method"
                      value={identityMethod}
                      onChange={(event) => {
                        setIdentityMethod(event.target.value);
                      }}
                    />
                    <p className="text-2xs text-fg-subtle">
                      "Verified" with no method is a tick-box. The API will not accept a start without both.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      data-testid="check-in"
                      disabled={checkIn.isPending}
                      onClick={() => {
                        checkIn.mutate(focused.id);
                      }}
                    >
                      Check in
                    </Button>
                    <Button
                      variant="secondary"
                      data-testid="start-study"
                      disabled={identityMethod.trim() === '' || start.isPending}
                      onClick={() => {
                        start.mutate(focused.id);
                      }}
                    >
                      Start
                    </Button>
                    <Button
                      variant="secondary"
                      data-testid="complete-study"
                      disabled={done.isPending}
                      onClick={() => {
                        done.mutate(focused.id);
                      }}
                    >
                      Complete
                    </Button>
                  </div>
                  {checkIn.error === null ? null : <ProblemCard error={checkIn.error} />}
                  {start.error === null ? null : <ProblemCard error={start.error} />}
                  {done.error === null ? null : <ProblemCard error={done.error} />}
                </div>
              ) : null}

              {canCreateReport ? (
                <div className="flex flex-col gap-3 border-t border-default pt-3">
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="invest-impression">Impression</Label>
                    <Textarea
                      id="invest-impression"
                      data-testid="invest-impression"
                      rows={5}
                      value={impression}
                      onChange={(event) => {
                        setImpression(event.target.value);
                      }}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      id="invest-critical"
                      data-testid="invest-critical"
                      type="checkbox"
                      className="size-5 rounded-sm border border-control"
                      checked={critical}
                      onChange={(event) => {
                        setCritical(event.target.checked);
                      }}
                    />
                    <Label htmlFor="invest-critical" className="font-normal">
                      This is a critical finding
                    </Label>
                  </div>

                  {statutoryRefusal === null ? null : (
                    <div
                      role="alert"
                      data-testid="pcpndt-refusal"
                      className="rounded-md border border-danger-border bg-danger-surface p-3 text-sm text-danger-on-surface"
                    >
                      <p className="flex items-center gap-2 font-medium">
                        <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
                        PC-PNDT Act 1994
                      </p>
                      <p className="mt-1">{statutoryRefusal}</p>
                      {overrideOffered ? (
                        <div className="mt-2 flex flex-col gap-1">
                          <Label htmlFor="pcpndt-override">
                            Authorised override — a named doctor and a written reason
                          </Label>
                          <Textarea
                            id="pcpndt-override"
                            data-testid="pcpndt-override"
                            rows={2}
                            value={overrideReason}
                            onChange={(event) => {
                              setOverrideReason(event.target.value);
                            }}
                          />
                          <p className="text-2xs">
                            The override is recorded against the version and reviewed. It is not a way past
                            the Act; it exists because the validator matches text, and text is sometimes
                            clinical rather than a disclosure.
                          </p>
                        </div>
                      ) : null}
                    </div>
                  )}

                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      data-testid="draft-report"
                      disabled={impression.trim() === '' || report.isPending}
                      onClick={() => {
                        report.mutate(focused.id);
                      }}
                    >
                      Draft the report
                    </Button>
                    <Button
                      variant="secondary"
                      data-testid="send-for-cosign"
                      disabled={reportId === null || forCosign.isPending}
                      onClick={() => {
                        if (reportId !== null) forCosign.mutate(reportId);
                      }}
                    >
                      Send for co-signature
                    </Button>
                    <Button
                      data-testid="sign-invest-report"
                      disabled={signBlocked || sign.isPending}
                      onClick={() => {
                        if (reportId !== null) sign.mutate(reportId);
                      }}
                    >
                      Sign
                    </Button>
                    {canCosign ? (
                      <Button
                        variant="secondary"
                        data-testid="cosign-report"
                        disabled={reportId === null || cosign.isPending}
                        onClick={() => {
                          if (reportId !== null) cosign.mutate(reportId);
                        }}
                      >
                        Co-sign
                      </Button>
                    ) : null}
                  </div>

                  {cosignRequired && !canCosign ? (
                    <p className="text-sm text-fg-muted" data-testid="cosign-required-notice">
                      This service is configured to need a consultant co-signature, and that is a key you do
                      not hold. Draft it and send it for co-signature — the consultant finalises it.
                    </p>
                  ) : null}

                  {report.error === null ? null : <ProblemCard error={report.error} />}
                  {forCosign.error === null ? null : <ProblemCard error={forCosign.error} />}
                  {sign.error === null ? null : <ProblemCard error={sign.error} />}
                  {cosign.error === null ? null : <ProblemCard error={cosign.error} />}
                </div>
              ) : null}
            </>
          )}
        </section>
      </div>

      <ShortcutBar shortcuts={shortcuts} label="Investigation shortcuts" />
    </section>
  );
}
