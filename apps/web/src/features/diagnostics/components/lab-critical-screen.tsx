'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, EmptyState, Switch, Label, useToast } from '@vims/ui';
import { useMemo, useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { Check, OctagonAlert, TriangleAlert } from '@/lib/icons';
import { useSession } from '@/lib/session-context';
import { acknowledgeCriticalValue, listCriticalValues, recordCriticalCallback } from '../api/client';
import { diagnosticsKeys } from '../api/keys';
import type { LabCriticalAlertView } from '../api/types';
import {
  EMPTY_CALLBACK_FORM,
  canRecordCallback,
  hasDocumentedCommunication,
  minutesToDue,
  toLabCallbackRequest,
  urgencyOf,
  type CallbackFormState,
} from '../lib/critical';
import { describeMinutes, formatInstant, humanise } from '../lib/format';
import { patientRef } from '../lib/worklist-labels';
import { CallbackForm } from './callback-form';
import { FlagChip } from './result-flag';

/**
 * OP-004 §3.5 and `docs/DECISIONS.md` D-10 — the critical-value board.
 *
 * ## The one sentence this screen exists to make true
 *
 * **A critical result is never withheld.** OP-004 §5 settles it as
 * "resolved — not configurable": the alert fires the instant the value exists,
 * before and independent of authorisation, and there is no setting anywhere in
 * this feature that hides one, delays one, or gates *seeing* one on paperwork.
 * The value is printed on this board in full — analyte, number, unit, flag —
 * whether or not anybody has yet managed to telephone a human about it.
 *
 * What the paperwork gates is **authorisation of that result**, and that gate
 * lives on the bench screen. The two are constantly confused, and confusing them
 * in the withholding direction is the failure this whole phase exists to
 * prevent.
 *
 * ## Two arms, no third
 *
 * A documented communication is a read-back from a named clinician, or
 * "clinician unreachable — escalated to <tier>". Both are two fields; neither is
 * harder than the other, because if escalation were harder the pressure would
 * fall back onto withholding. The escalation arm is labelled as a **tracked
 * exception on the NABL indicator**, which is exactly what it is — visible, not
 * silent, and not a failure.
 *
 * ## Clocks
 *
 * `due_by` is the server's, from the hospital's own configuration. Nothing here
 * invents a target: a laboratory that has set fifteen minutes for its ICU has
 * done so for a reason, and a client-side default of thirty would quietly
 * override it.
 */
export function LabCriticalScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = diagnosticsKeys(hospitalId);
  const queryClient = useQueryClient();
  const { publish } = useToast();

  const [openOnly, setOpenOnly] = useState(true);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [selected, setSelected] = useState<string | null>(null);
  const [form, setForm] = useState<CallbackFormState>(EMPTY_CALLBACK_FORM);

  const canNotify = granted.has('lab.critical.notify');

  const alerts = useQuery({
    queryKey: keys.criticalValues(openOnly),
    queryFn: ({ signal }) => listCriticalValues({ open: openOnly, cursor }, { signal }),
    // A board that goes stale is a board people stop trusting. Sixty seconds is
    // the compromise until the realtime channel carries `lab.result.critical`.
    refetchInterval: 60_000,
  });

  const items = alerts.data?.items ?? [];
  const active = useMemo(() => items.find((alert) => alert.id === selected) ?? null, [items, selected]);

  function refresh(): void {
    void queryClient.invalidateQueries({ queryKey: keys.criticalValuesRoot() });
  }

  const notify = useMutation({
    mutationFn: (alertId: string) => recordCriticalCallback(alertId, toLabCallbackRequest(form)),
    onSuccess: () => {
      refresh();
      setForm(EMPTY_CALLBACK_FORM);
      publish({
        title: 'Communication recorded',
        description:
          form.outcome === 'read_back_confirmed'
            ? 'The read-back is on file. The result may now be authorised.'
            : 'Recorded as a tracked exception on the NABL indicator, with the tier it went to.',
        severity: 'success',
      });
    },
  });

  const acknowledge = useMutation({
    mutationFn: (alertId: string) => acknowledgeCriticalValue(alertId, {}),
    onSuccess: () => {
      refresh();
      publish({ title: 'Acknowledged', severity: 'success' });
    },
  });

  const now = new Date();

  return (
    <section className="flex flex-col gap-4" data-testid="lab-critical-screen">
      <PageHeader
        eyebrow="OP-004 §3.5 · D-10"
        title="Critical values"
        description="Every panic value in the hospital, with its clock. The result itself is never held back — what needs documenting is the phone call, and authorisation waits for that rather than for the value."
        actions={
          <div className="flex items-center gap-2">
            <Switch
              id="open-only"
              data-testid="open-only"
              checked={openOnly}
              onCheckedChange={(checked) => {
                setOpenOnly(checked);
                setCursor(undefined);
              }}
            />
            <Label htmlFor="open-only">Outstanding only</Label>
          </div>
        }
      />

      <p
        data-testid="never-withheld-notice"
        className="rounded-md border border-info-border bg-info-surface p-3 text-sm text-info-on-surface"
      >
        Every value below has already been released and has already raised its alert. There is no setting that
        withholds one — OP-004 §5 settles that as resolved rather than configurable, because a value nobody
        can see is a value nobody acts on.
      </p>

      <AsyncPanel
        loading={alerts.isPending}
        error={alerts.error}
        isEmpty={items.length === 0}
        skeletonLabel="Loading the critical-value board"
        onRetry={() => {
          void alerts.refetch();
        }}
        empty={
          <EmptyState
            icon={<Check aria-hidden="true" />}
            cause={
              openOnly
                ? 'No critical value is outstanding in this hospital right now.'
                : 'No critical value has been raised in the window this board covers.'
            }
            nextAction={
              openOnly
                ? 'Turn off “Outstanding only” to see the ones already closed, with the call-back that closed each of them.'
                : 'Nothing to do here. The board refreshes itself every minute.'
            }
          />
        }
      >
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <ul className="flex flex-col gap-2" data-testid="critical-list">
            {items.map((alert) => (
              <li key={alert.id}>
                <AlertCard
                  alert={alert}
                  now={now}
                  selected={alert.id === selected}
                  onSelect={() => {
                    setSelected(alert.id);
                    setForm(EMPTY_CALLBACK_FORM);
                  }}
                />
              </li>
            ))}
            {alerts.data?.hasMore === true ? (
              <li>
                <Button
                  variant="secondary"
                  data-testid="load-more-criticals"
                  disabled={alerts.isFetching}
                  onClick={() => {
                    setCursor(alerts.data?.nextCursor ?? undefined);
                  }}
                >
                  {alerts.isFetching ? 'Loading…' : 'Load the next page'}
                </Button>
              </li>
            ) : null}
          </ul>

          <section className="flex flex-col gap-3 rounded-lg border border-strong bg-layer-1 p-4">
            {active === null ? (
              <EmptyState
                cause="No alert is open."
                nextAction="Choose one from the board to record the call-back against it."
              />
            ) : (
              <>
                <header className="flex flex-col gap-1 border-b border-default pb-2">
                  <p className="text-md font-medium text-fg-default">
                    {active.analyte_name} {active.value_display}
                    {active.unit === null ? '' : ` ${active.unit}`}
                  </p>
                  <p className="font-mono text-2xs text-fg-muted">
                    {patientRef(active.patient_id)} · detected {formatInstant(active.detected_at)} ·
                    escalation tier {active.escalation_level}
                  </p>
                </header>

                <ol className="flex flex-col gap-2" data-testid="callback-history">
                  {active.callbacks.length === 0 ? (
                    <li className="text-sm text-fg-muted">
                      Nothing has been recorded yet. The clock is running.
                    </li>
                  ) : (
                    active.callbacks.map((callback) => (
                      <li key={callback.id} className="text-sm text-fg-muted">
                        <span className="font-mono text-2xs text-fg-subtle">
                          #{callback.sequence} {formatInstant(callback.notified_at)}
                        </span>{' '}
                        {callback.read_back_confirmed
                          ? `${callback.notified_to_name ?? 'a clinician'} read back “${callback.read_back_value ?? ''}”`
                          : callback.clinician_unreachable
                            ? `unreachable — escalated to tier ${callback.escalated_to_level ?? '?'} (${callback.escalated_to_role ?? 'unnamed role'})`
                            : 'an attempt with no outcome recorded'}
                        {callback.latency_seconds === null
                          ? ''
                          : ` · ${describeMinutes(Math.round(callback.latency_seconds / 60))} after detection`}
                      </li>
                    ))
                  )}
                </ol>

                {canNotify ? (
                  <>
                    <CallbackForm form={form} onChange={setForm} disabled={notify.isPending} />
                    <div className="flex flex-wrap gap-2">
                      <Button
                        data-testid="record-callback"
                        disabled={!canRecordCallback(form) || notify.isPending}
                        onClick={() => {
                          notify.mutate(active.id);
                        }}
                      >
                        {notify.isPending ? 'Recording…' : 'Record this communication'}
                      </Button>
                      <Button
                        variant="secondary"
                        data-testid="acknowledge-alert"
                        disabled={acknowledge.isPending || active.acknowledged_at !== null}
                        onClick={() => {
                          acknowledge.mutate(active.id);
                        }}
                      >
                        {active.acknowledged_at === null ? 'Acknowledge' : 'Already acknowledged'}
                      </Button>
                    </div>
                    {notify.error === null ? null : <ProblemCard error={notify.error} />}
                    {acknowledge.error === null ? null : <ProblemCard error={acknowledge.error} />}
                  </>
                ) : (
                  <p className="text-sm text-fg-muted">
                    You can read this board but not record against it. Recording a call-back is held by
                    laboratory staff and the clinicians who take the calls.
                  </p>
                )}
              </>
            )}
          </section>
        </div>
      </AsyncPanel>
    </section>
  );
}

function AlertCard({
  alert,
  now,
  selected,
  onSelect,
}: {
  readonly alert: LabCriticalAlertView;
  readonly now: Date;
  readonly selected: boolean;
  readonly onSelect: () => void;
}): React.JSX.Element {
  const urgency = urgencyOf(alert, now);
  const minutes = minutesToDue(alert, now);
  const documented = hasDocumentedCommunication(alert);

  const clock =
    minutes === null
      ? 'No target time configured'
      : minutes < 0
        ? `Overdue by ${describeMinutes(-minutes)}`
        : `${describeMinutes(minutes)} left to communicate`;

  return (
    <button
      type="button"
      data-testid={`alert-${alert.id}`}
      data-urgency={urgency}
      aria-pressed={selected}
      onClick={onSelect}
      className={`flex w-full flex-col gap-1 rounded-lg border bg-layer-1 p-3 text-start focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${
        urgency === 'breached' ? 'border-s-[3px] border-danger-border' : 'border-strong'
      } ${selected ? 'ring-2 ring-focus' : ''}`}
    >
      <span className="flex flex-wrap items-baseline gap-2">
        <span className="text-md font-medium text-fg-default">{alert.analyte_name}</span>
        <span className="font-mono text-md tabular-nums text-fg-default" data-testid="critical-value">
          {alert.value_display}
          {alert.unit === null ? '' : ` ${alert.unit}`}
        </span>
        <FlagChip flag={alert.flag} />
      </span>
      <span className="flex flex-wrap items-center gap-2 text-2xs text-fg-muted">
        <span className="font-mono">{patientRef(alert.patient_id)}</span>
        <span>{humanise(alert.status)}</span>
        <span className={urgency === 'breached' ? 'text-danger-fg' : 'text-fg-muted'}>{clock}</span>
      </span>
      <span>
        {documented ? (
          <Badge tone="success" icon={<Check aria-hidden="true" />}>
            Communication documented
          </Badge>
        ) : urgency === 'breached' ? (
          <Badge tone="danger" icon={<OctagonAlert aria-hidden="true" />}>
            Nobody has been reached — authorisation is held
          </Badge>
        ) : (
          <Badge tone="warning" icon={<TriangleAlert aria-hidden="true" />}>
            Awaiting a documented call-back
          </Badge>
        )}
      </span>
    </button>
  );
}
