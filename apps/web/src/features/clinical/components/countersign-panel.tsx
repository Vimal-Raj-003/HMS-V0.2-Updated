'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import {
  Badge,
  Button,
  ConfirmWithReasonDialog,
  EmptyState,
  useToast,
  type ConfirmWithReasonLabels,
} from '@vims/ui';
import { useState } from 'react';
import { ShieldAlert } from '@/lib/icons';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';
import { listAlerts, respondToAlert } from '../api/client';
import { clinicalKeys } from '../api/keys';
import type { AlertListItem } from '../api/types';
import { familyLabel } from '../lib/cdss';
import { formatInstant } from '../lib/numbers';
import { OVERRIDE_REASONS } from '../lib/override-reasons';
import { isSecondPersonRequired } from '../lib/problems';

/**
 * The second clinician's half of a hard stop — EN-029 §3.2.7.
 *
 * A product-level hard stop is cleared in exactly one way: **a different
 * clinician, holding `rx.cosign`, countersigns the alert**. That is a second
 * signature, not an override, and it deliberately lives here — on the
 * consultation a consultant opens to review — rather than on the prescriber's
 * own prescribing screen, where any control at all would read as a way past the
 * stop.
 *
 * Three refusals the API makes and this panel does not hide:
 *
 *  - **the prescriber cannot countersign their own alert** (`second-person-required`).
 *    If this consultant raised it, the refusal is rendered in as many words —
 *    the attempt is recorded, which is correct, and the panel says so;
 *  - **three of the six floor entries admit no countersignature at all**
 *    (pregnancy category X, the NDPS statutory cap, the missing paediatric
 *    weight). For those the answer is to change the order, and the API says so;
 *  - **a coded reason is mandatory.** The dialog offers the hospital's list, and
 *    free text alone is not a choice on it.
 */

const COUNTERSIGN_LABELS: ConfirmWithReasonLabels = {
  title: 'Countersign this hard stop?',
  description:
    'Your signature is recorded as a second signature against the alert and against the prescription it stopped. It is reportable, it is audited, and it does not remove the alert from the record.',
  reasonLabel: 'Reason',
  reasonPlaceholder: 'Choose the reason',
  notePlaceholder: 'What you checked before countersigning',
  confirm: 'Countersign',
  cancel: 'Do not countersign',
  typedValuePrompt: (expected) => `Type ${expected} to confirm`,
  reasonRequired: 'A coded reason is required. Free text on its own is not accepted.',
  typedValueMismatch: 'That does not match.',
};

export function CountersignPanel({ encounterId }: { readonly encounterId: string }): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = clinicalKeys(hospitalId);
  const { publish } = useToast();
  const [answering, setAnswering] = useState<AlertListItem | null>(null);

  const canRespond = granted.has('cdss.alert.respond') && granted.has('rx.cosign');

  const alerts = useQuery({
    queryKey: keys.alerts(encounterId),
    queryFn: ({ signal }) => listAlerts({ encounterId }, { signal }),
    enabled: canRespond && encounterId !== '',
  });

  const respond = useMutation({
    mutationFn: (input: {
      readonly alert: AlertListItem;
      readonly reasonCode: string;
      readonly note: string;
    }) =>
      respondToAlert(
        input.alert.id,
        {
          firedAt: input.alert.fired_at,
          kind: 'overridden',
          reasonCode: input.reasonCode,
          ...(input.note === '' ? {} : { note: input.note }),
        },
        // `cdss.alert.respond` is `requiresReason`: the header answers "why is
        // this user doing something reason-bearing at all", the code answers
        // "why was this alert not heeded". Both are required, and they are
        // different questions.
        `Countersigning a clinical hard stop after review: ${input.reasonCode}`,
      ),
    onSuccess: () => {
      setAnswering(null);
      void alerts.refetch();
      publish({
        title: 'Countersigned',
        description: 'The alert keeps its history; your signature is recorded against it.',
        severity: 'success',
      });
    },
  });

  if (!canRespond) return <></>;

  const outstanding = (alerts.data?.items ?? []).filter(
    (alert) => alert.interruption === 'hard_stop' && alert.action_kind === null,
  );

  return (
    <section
      aria-label="Hard stops awaiting a countersignature"
      data-testid="countersign-panel"
      className="flex flex-col gap-2"
    >
      <h2 className="flex items-center gap-2 text-md font-medium text-fg-default">
        <ShieldAlert className="size-4 shrink-0" aria-hidden="true" />
        Hard stops on this consultation
      </h2>

      <AsyncPanel
        loading={alerts.isLoading}
        error={alerts.error}
        isEmpty={outstanding.length === 0}
        skeletonLabel="Loading the alerts raised on this consultation"
        skeletonRows={2}
        onRetry={() => void alerts.refetch()}
        empty={
          <EmptyState
            cause="Nothing on this consultation is waiting for a countersignature."
            nextAction="A hard stop appears here when a prescriber raises one and asks a consultant to review it."
          />
        }
      >
        <ul className="flex flex-col gap-2">
          {outstanding.map((alert) => (
            <li
              key={alert.id}
              className="rounded-md border border-danger-border bg-danger-surface p-3"
              data-testid={`countersign-${alert.id}`}
            >
              <p className="text-sm font-medium text-danger-on-surface">
                {familyLabel(alert.family)} — {alert.title}
              </p>
              <p className="mt-1 font-mono text-2xs text-fg-muted">
                fired {formatInstant(alert.fired_at)} · {alert.safety_floor_key ?? 'no floor key'}
              </p>
              <Badge tone="danger" size="sm" className="mt-2">
                {alert.severity}
              </Badge>
              <div className="mt-2">
                <Button
                  variant="secondary"
                  size="sm"
                  data-testid={`countersign-open-${alert.id}`}
                  onClick={() => {
                    setAnswering(alert);
                  }}
                >
                  Review and countersign
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </AsyncPanel>

      {respond.isError ? (
        isSecondPersonRequired(respond.error) ? (
          <p role="alert" data-testid="self-countersign-refused" className="text-sm text-danger-on-surface">
            You raised this alert, so your signature cannot be the second one. A hard stop is cleared by
            another clinician, or by changing the prescription. The attempt has been recorded.
          </p>
        ) : (
          <ProblemCard error={respond.error} />
        )
      ) : null}

      <ConfirmWithReasonDialog
        open={answering !== null}
        onOpenChange={(open) => {
          if (!open) setAnswering(null);
        }}
        labels={COUNTERSIGN_LABELS}
        reasonOptions={OVERRIDE_REASONS}
        onConfirm={(result) => {
          const alert = answering;
          if (alert === null || result.reasonCode === undefined) return;
          respond.mutate({ alert, reasonCode: result.reasonCode, note: result.reasonText.trim() });
        }}
      />
    </section>
  );
}
