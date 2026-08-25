'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  Input,
  Label,
  Textarea,
  WorklistTable,
  useToast,
} from '@vims/ui';
import { useEffect, useMemo, useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { ContextField, isIdentifier } from '@/features/frontoffice/components/context-field';
import { OctagonAlert, TriangleAlert } from '@/lib/icons';
import { useSession } from '@/lib/session-context';
import { createRadOrder, getPatientDoseSummary, listRadOrders, saveSafetyScreen } from '../api/client';
import { diagnosticsKeys } from '../api/keys';
import {
  PREGNANCY_STATUSES,
  RAD_PRIORITIES,
  type PregnancyStatus,
  type RadOrderView,
  type RadPriority,
} from '../api/types';
import { formatInstant, humanise, priorityTone } from '../lib/format';
import {
  EMPTY_SAFETY_SCREEN,
  doseBannerText,
  requirementsOf,
  safetyScreenFrom,
  safetyVerdict,
  toSafetyScreenRequest,
  type SafetyScreenState,
} from '../lib/safety-screen';
import { patientRef, worklistLabels } from '../lib/worklist-labels';
import { FormFPanel } from './form-f-panel';

/**
 * OP-008 §3.1 — the imaging request and the safety screen that decides whether
 * it may happen at all.
 *
 * ## The clinical question is mandatory, and that is not a validation choice
 *
 * OP-008 §5: an imaging request with no question is an exposure with no
 * justification, and the AERB inspection asks for the justification, not for the
 * order. `clinicalIndication` is `min(3)` on the API and required here, with the
 * reason said out loud rather than a red asterisk.
 *
 * ## The safety screen is a gate, not a questionnaire
 *
 * `lib/safety-screen.ts` decides. Blocking reasons stop the request; advisories
 * are shown and stop nothing, because `docs/06` §10 is right that styling every
 * warning as a hard stop is how alert fatigue is manufactured. The eGFR hard
 * stop, the unanswered pregnancy question and the unscreened MRI patient are
 * blocking. The metformin hold and the premedication regimen are not.
 *
 * ## PC-PNDT
 *
 * When any line is flagged `isPcpndt`, Form F appears — and it is the whole of
 * what appears. **There is no field on this screen, or anywhere in this feature,
 * that could carry a foetal sex**, and `lib/pcpndt.spec.ts` reads the source of
 * every file here to prove it on each run.
 *
 * ## What this screen cannot do
 *
 * `GET /rad/procedures` does not exist — the procedure master is not exposed —
 * so a new order takes a procedure key rather than offering a searchable
 * catalogue. That is a real usability hole and it is reported as an API gap
 * rather than papered over with a free-text procedure name, which would defeat
 * the point of a coded master.
 */
export function RadOrderScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = diagnosticsKeys(hospitalId);
  const queryClient = useQueryClient();
  const { publish } = useToast();

  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [screen, setScreen] = useState<SafetyScreenState>(EMPTY_SAFETY_SCREEN);

  const [patientId, setPatientId] = useState('');
  const [procedureKey, setProcedureKey] = useState('');
  const [indication, setIndication] = useState('');
  const [priority, setPriority] = useState<RadPriority>('routine');
  const [contrast, setContrast] = useState(false);

  const canList = granted.has('rad.order.list');
  const canUpdate = granted.has('rad.order.update');
  const canReadDose = granted.has('rad.dose.read');
  const canFormF = granted.has('rad.pnpdt.manage');

  const orders = useQuery({
    queryKey: keys.radOrders('all', 'all', 'all'),
    queryFn: ({ signal }) => listRadOrders({ cursor }, { signal }),
    enabled: canList,
  });

  const selected = useMemo<RadOrderView | null>(
    () => (orders.data?.items ?? []).find((order) => order.id === selectedId) ?? null,
    [orders.data, selectedId],
  );

  // The safety answers follow the selected order rather than being remembered:
  // a shared console must never carry one patient's pregnancy answer onto the
  // next patient's request.
  useEffect(() => {
    setScreen(selected === null ? EMPTY_SAFETY_SCREEN : safetyScreenFrom(selected));
  }, [selected]);

  const dose = useQuery({
    queryKey: keys.doseSummary(selected?.patientId ?? 'none'),
    queryFn: ({ signal }) =>
      selected === null ? Promise.resolve(null) : getPatientDoseSummary(selected.patientId, { signal }),
    enabled: selected !== null && canReadDose,
  });

  const need =
    selected === null
      ? { ionising: false, magneticResonance: false, pcpndt: false }
      : requirementsOf(selected.items);
  const verdict = safetyVerdict(screen, need);

  const create = useMutation({
    mutationFn: () =>
      createRadOrder({
        patientId: patientId.trim(),
        source: 'opd',
        priority,
        clinicalIndication: indication.trim(),
        icdCodes: [],
        isMlc: false,
        items: [
          {
            procedureKey: procedureKey.trim(),
            laterality: 'not_applicable',
            contrast,
            views: [],
          },
        ],
      }),
    onSuccess: (order) => {
      void queryClient.invalidateQueries({ queryKey: keys.radRoot });
      setSelectedId(order.id);
      setIndication('');
      publish({
        title: `Order ${order.accessionNo} raised`,
        description: 'Answer the safety screen before it can be scheduled.',
        severity: 'success',
      });
    },
  });

  const save = useMutation({
    mutationFn: () => {
      if (selected === null) throw new Error('No order is selected.');
      return saveSafetyScreen(selected.id, toSafetyScreenRequest(screen));
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.radRoot });
      publish({ title: 'Safety screen saved', severity: 'success' });
    },
  });

  const doseText = dose.data === null || dose.data === undefined ? null : doseBannerText(dose.data);
  const canCreate = patientId.trim() !== '' && procedureKey.trim() !== '' && indication.trim().length >= 3;

  return (
    <section className="flex flex-col gap-4" data-testid="rad-order-screen">
      <PageHeader
        eyebrow="OP-008 · order and safety"
        title="Imaging orders"
        description="The clinical question first, then the questions that decide whether the exposure may happen: pregnancy, renal function, contrast allergy, implants."
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <section className="flex flex-col gap-3 rounded-lg border border-strong bg-layer-1 p-4">
          <h2 className="text-md font-medium text-fg-default">Raise a request</h2>
          <ContextField
            label="Patient"
            hint="The patient this imaging is for. An identifier, never a name — no PHI reaches the address bar or the request log."
            value={patientId}
            onChange={setPatientId}
            testId="rad-patient"
          />
          <ContextField
            label="Procedure key"
            hint="From the radiology procedure master. The API exposes no procedure search, so the key is entered directly — reported as a gap."
            value={procedureKey}
            onChange={setProcedureKey}
            testId="rad-procedure"
          />
          <div className="flex flex-col gap-1">
            <Label htmlFor="rad-indication">Clinical question</Label>
            <Textarea
              id="rad-indication"
              data-testid="rad-indication"
              rows={3}
              value={indication}
              onChange={(event) => {
                setIndication(event.target.value);
              }}
            />
            <p className="text-2xs text-fg-subtle">
              What is this exposure meant to answer? An imaging request with no question is an exposure with
              no justification, and the AERB inspection asks for the justification.
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex min-w-40 flex-col gap-1">
              <Label htmlFor="rad-priority">Priority</Label>
              <select
                id="rad-priority"
                data-testid="rad-priority"
                className="h-9 rounded-md border border-control bg-layer-1 px-2 text-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                value={priority}
                onChange={(event) => {
                  setPriority(event.target.value as RadPriority);
                }}
              >
                {RAD_PRIORITIES.map((one) => (
                  <option key={one} value={one}>
                    {humanise(one)}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2 pb-2">
              <Checkbox
                id="rad-contrast"
                data-testid="rad-contrast"
                checked={contrast}
                onCheckedChange={(checked) => {
                  setContrast(checked === true);
                }}
              />
              <Label htmlFor="rad-contrast" className="font-normal">
                With contrast
              </Label>
            </div>
          </div>
          <Button
            data-testid="create-order"
            className="self-start"
            disabled={!canCreate || !isIdentifier(patientId) || create.isPending}
            onClick={() => {
              create.mutate();
            }}
          >
            {create.isPending ? 'Raising…' : 'Raise the request'}
          </Button>
          {create.error === null ? null : <ProblemCard error={create.error} />}
        </section>

        <section className="flex flex-col gap-3">
          {!canList ? (
            <EmptyState
              cause="Your roles do not include listing imaging orders."
              nextAction="You can still raise a request on the left; the order you raise will be selected automatically."
            />
          ) : (
            <AsyncPanel
              loading={orders.isPending}
              error={orders.error}
              isEmpty={(orders.data?.items.length ?? 0) === 0}
              skeletonLabel="Loading imaging orders"
              onRetry={() => {
                void orders.refetch();
              }}
              empty={
                <EmptyState
                  cause="No imaging order is open at this branch."
                  nextAction="Raise one on the left, and the safety screen will open against it."
                />
              }
            >
              <WorklistTable
                rows={orders.data?.items ?? []}
                getRowId={(row) => row.id}
                labels={worklistLabels('Imaging orders')}
                empty={{
                  cause: 'No imaging order is open at this branch.',
                  nextAction: 'Raise one on the left.',
                }}
                onRowOpen={(row) => {
                  setSelectedId(row.id);
                }}
                criticalRowIds={
                  new Set(
                    (orders.data?.items ?? [])
                      .filter((row) => row.priority === 'stat' || row.priority === 'portable_stat')
                      .map((row) => row.id),
                  )
                }
                hasMore={orders.data?.hasMore ?? false}
                loading={orders.isFetching}
                onLoadMore={() => {
                  setCursor(orders.data?.nextCursor ?? undefined);
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
                    key: 'procedures',
                    header: 'Procedures',
                    render: (row) => (
                      <span className="text-xs">
                        {row.items.map((item) => `${item.modality} ${item.procedureName}`).join(', ')}
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
                    key: 'safety',
                    header: 'Safety',
                    render: (row) => {
                      const requirements = requirementsOf(row.items);
                      if (!requirements.ionising && !requirements.magneticResonance) {
                        return <span className="text-2xs text-fg-subtle">not applicable</span>;
                      }
                      if (row.pregnancyStatus === null || row.pregnancyStatus === 'unknown') {
                        return (
                          <Badge tone="warning" icon={<TriangleAlert aria-hidden="true" />}>
                            not screened
                          </Badge>
                        );
                      }
                      return <Badge tone="success">screened</Badge>;
                    },
                  },
                  {
                    key: 'ordered',
                    header: 'Ordered',
                    importance: 'secondary',
                    render: (row) => (
                      <span className="font-mono text-2xs">{formatInstant(row.orderedAt)}</span>
                    ),
                  },
                ]}
              />
            </AsyncPanel>
          )}
        </section>
      </div>

      {selected === null ? null : (
        <section
          className="flex flex-col gap-3 rounded-lg border border-strong bg-layer-1 p-4"
          data-testid="safety-screen"
        >
          <header className="flex flex-col gap-1 border-b border-default pb-2">
            <h2 className="text-md font-medium text-fg-default">Safety screen — {selected.accessionNo}</h2>
            <p className="text-sm text-fg-muted">{selected.clinicalIndication}</p>
          </header>

          {doseText === null ? null : (
            <p
              data-testid="dose-banner"
              className="rounded-md border border-warning-border bg-warning-surface p-3 text-sm text-warning-on-surface"
            >
              {doseText}
            </p>
          )}

          {need.ionising ? (
            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-medium text-fg-default">Pregnancy</legend>
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex min-w-48 flex-col gap-1">
                  <Label htmlFor="pregnancy-status">Pregnancy status</Label>
                  <select
                    id="pregnancy-status"
                    data-testid="pregnancy-status"
                    className="h-9 rounded-md border border-control bg-layer-1 px-2 text-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                    value={screen.pregnancyStatus}
                    onChange={(event) => {
                      setScreen({ ...screen, pregnancyStatus: event.target.value as PregnancyStatus });
                    }}
                  >
                    {PREGNANCY_STATUSES.map((one) => (
                      <option key={one} value={one}>
                        {one === 'unknown' ? 'Not asked yet' : humanise(one)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex min-w-48 flex-col gap-1">
                  <Label htmlFor="lmp-date">Last menstrual period</Label>
                  <Input
                    id="lmp-date"
                    data-testid="lmp-date"
                    type="date"
                    value={screen.lmpDate}
                    onChange={(event) => {
                      setScreen({ ...screen, lmpDate: event.target.value });
                    }}
                  />
                </div>
              </div>
              {screen.pregnancyStatus === 'yes' || screen.pregnancyStatus === 'possible' ? (
                <div className="flex flex-col gap-1">
                  <Label htmlFor="radiation-justification">Why is this exposure justified?</Label>
                  <Textarea
                    id="radiation-justification"
                    data-testid="radiation-justification"
                    rows={3}
                    value={screen.radiationJustification}
                    onChange={(event) => {
                      setScreen({ ...screen, radiationJustification: event.target.value });
                    }}
                  />
                </div>
              ) : null}
            </fieldset>
          ) : null}

          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium text-fg-default">Contrast and renal function</legend>
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex items-center gap-2 pb-2">
                <Checkbox
                  id="contrast-required"
                  data-testid="contrast-required"
                  checked={screen.contrastRequired}
                  onCheckedChange={(checked) => {
                    setScreen({ ...screen, contrastRequired: checked === true });
                  }}
                />
                <Label htmlFor="contrast-required" className="font-normal">
                  Iodinated contrast is required
                </Label>
              </div>
              <div className="flex min-w-40 flex-col gap-1">
                <Label htmlFor="egfr">eGFR</Label>
                <Input
                  id="egfr"
                  data-testid="egfr"
                  inputMode="decimal"
                  className="font-mono tabular-nums"
                  value={screen.egfr}
                  onChange={(event) => {
                    setScreen({ ...screen, egfr: event.target.value });
                  }}
                />
              </div>
              <div className="flex items-center gap-2 pb-2">
                <Checkbox
                  id="contrast-allergy"
                  data-testid="contrast-allergy"
                  checked={screen.contrastAllergyKnown}
                  onCheckedChange={(checked) => {
                    setScreen({ ...screen, contrastAllergyKnown: checked === true });
                  }}
                />
                <Label htmlFor="contrast-allergy" className="font-normal">
                  Documented contrast allergy
                </Label>
              </div>
              <div className="flex items-center gap-2 pb-2">
                <Checkbox
                  id="metformin-hold"
                  data-testid="metformin-hold"
                  checked={screen.metforminHoldAdvised}
                  onCheckedChange={(checked) => {
                    setScreen({ ...screen, metforminHoldAdvised: checked === true });
                  }}
                />
                <Label htmlFor="metformin-hold" className="font-normal">
                  Metformin hold advised
                </Label>
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="contrast-approval">
                Radiologist approval and reason, if contrast proceeds anyway
              </Label>
              <Textarea
                id="contrast-approval"
                data-testid="contrast-approval"
                rows={2}
                value={screen.contrastApprovalReason}
                onChange={(event) => {
                  setScreen({ ...screen, contrastApprovalReason: event.target.value });
                }}
              />
            </div>
          </fieldset>

          {need.magneticResonance ? (
            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-medium text-fg-default">MRI screening</legend>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="mri-completed"
                  data-testid="mri-completed"
                  checked={screen.mriSafetyCompleted}
                  onCheckedChange={(checked) => {
                    setScreen({ ...screen, mriSafetyCompleted: checked === true });
                  }}
                />
                <Label htmlFor="mri-completed" className="font-normal">
                  The MRI safety questionnaire has been completed with the patient
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="mri-unsafe"
                  data-testid="mri-unsafe"
                  checked={screen.mriUnsafeImplant}
                  onCheckedChange={(checked) => {
                    setScreen({ ...screen, mriUnsafeImplant: checked === true });
                  }}
                />
                <Label htmlFor="mri-unsafe" className="font-normal">
                  An implant is flagged unsafe
                </Label>
              </div>
              {screen.mriUnsafeImplant ? (
                <div className="flex flex-col gap-1">
                  <Label htmlFor="mri-override">
                    MR-conditional evidence and the radiologist who accepted it
                  </Label>
                  <Textarea
                    id="mri-override"
                    data-testid="mri-override"
                    rows={2}
                    value={screen.mriOverrideReason}
                    onChange={(event) => {
                      setScreen({ ...screen, mriOverrideReason: event.target.value });
                    }}
                  />
                </div>
              ) : null}
            </fieldset>
          ) : null}

          {verdict.advisories.length === 0 ? null : (
            <ul data-testid="safety-advisories" className="flex flex-col gap-1 text-sm text-fg-muted">
              {verdict.advisories.map((advisory) => (
                <li key={advisory}>{advisory}</li>
              ))}
            </ul>
          )}

          {verdict.blocking.length === 0 ? null : (
            <div
              role="alert"
              data-testid="safety-blocking"
              className="rounded-md border border-danger-border bg-danger-surface p-3 text-sm text-danger-on-surface"
            >
              <p className="flex items-center gap-2 font-medium">
                <OctagonAlert className="size-4 shrink-0" aria-hidden="true" />
                This study cannot proceed yet
              </p>
              <ul className="mt-1 flex flex-col gap-1">
                {verdict.blocking.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </div>
          )}

          <Button
            data-testid="save-safety-screen"
            className="self-start"
            disabled={!canUpdate || verdict.blocking.length > 0 || save.isPending}
            onClick={() => {
              save.mutate();
            }}
          >
            {save.isPending ? 'Saving…' : 'Save the safety screen'}
          </Button>
          {save.error === null ? null : <ProblemCard error={save.error} />}

          {need.pcpndt ? (
            canFormF ? (
              <FormFPanel orderItemId={selected.items.find((item) => item.isPcpndt)?.id ?? ''} />
            ) : (
              <p
                data-testid="form-f-denied"
                className="rounded-md border border-violet-border bg-violet-surface p-3 text-sm text-violet-on-surface"
              >
                This is a prenatal diagnostic procedure and needs Form F before the study can be completed.
                Recording it is held by a named, PC-PNDT-registered doctor with step-up authentication — the
                Act makes that person personally liable, so it is not a permission that is handed around.
              </p>
            )
          ) : null}
        </section>
      )}
    </section>
  );
}
