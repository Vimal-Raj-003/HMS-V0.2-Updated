import { Check, Clock, CornerDownRight, Hourglass, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn.js';
import { Button } from '../primitives/button.js';

/**
 * `ApprovalTimeline` — docs/06 §5.2 #28: "Vertical steps with actor, role, timestamp,
 * decision, reason, SLA timer; pending step highlighted with the action button for
 * authorised users; escalation shown as a branch (EN-038)."
 *
 * Rendered as an ordered list so a screen reader announces "step 2 of 5" without ARIA
 * gymnastics, and the state of each step is carried by icon + text, never by colour
 * alone (§1.2.3).
 */
export type ApprovalDecision = 'pending' | 'approved' | 'rejected' | 'escalated' | 'withdrawn';

export interface ApprovalStep {
  readonly id: string;
  /** Already-localised step name, e.g. "Ward sister". */
  readonly title: string;
  readonly actorName?: string;
  readonly actorRole?: string;
  /** `dd-MM HH:mm` in hospital time (§1.2.10). */
  readonly at?: string;
  readonly decision: ApprovalDecision;
  readonly reason?: string;
  /** Already-localised SLA remaining/overdue text, e.g. "SLA 12 m left". */
  readonly sla?: string;
  readonly slaBreached?: boolean;
  /** EN-038 escalation branch — rendered indented under its parent step. */
  readonly branch?: readonly ApprovalStep[];
}

export interface ApprovalTimelineLabels {
  readonly region: string;
  readonly decision: Readonly<Record<ApprovalDecision, string>>;
  readonly reasonPrefix: string;
  readonly slaBreached: string;
}

export interface ApprovalTimelineProps {
  readonly steps: readonly ApprovalStep[];
  readonly labels: ApprovalTimelineLabels;
  /** Rendered on the pending step when the current user may act (EN-038). */
  readonly action?: { readonly label: string; readonly onSelect: (stepId: string) => void };
  readonly className?: string;
}

const DECISION_ICON: Readonly<Record<ApprovalDecision, ReactNode>> = {
  pending: <Hourglass className="size-3.5" aria-hidden="true" />,
  approved: <Check className="size-3.5" aria-hidden="true" />,
  rejected: <X className="size-3.5" aria-hidden="true" />,
  escalated: <CornerDownRight className="size-3.5" aria-hidden="true" />,
  withdrawn: <Clock className="size-3.5" aria-hidden="true" />,
};

const DECISION_TONE: Readonly<Record<ApprovalDecision, string>> = {
  pending: 'border-warning-border bg-warning-surface text-warning-on-surface',
  approved: 'border-success-border bg-success-surface text-success-on-surface',
  rejected: 'border-danger-border bg-danger-surface text-danger-on-surface',
  escalated: 'border-violet-border bg-violet-surface text-violet-on-surface',
  withdrawn: 'border-default bg-layer-3 text-fg-muted',
};

function Step({
  step,
  labels,
  action,
}: {
  readonly step: ApprovalStep;
  readonly labels: ApprovalTimelineLabels;
  readonly action?: ApprovalTimelineProps['action'];
}): React.JSX.Element {
  return (
    <li data-slot="approval-step" data-decision={step.decision} className="relative ps-6">
      <span
        aria-hidden="true"
        className="absolute inset-inline-start-0 top-1 flex size-4 items-center justify-center rounded-full border border-strong bg-layer-1"
      />
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-md font-medium text-fg-default">{step.title}</span>
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-medium',
              DECISION_TONE[step.decision],
            )}
          >
            {DECISION_ICON[step.decision]}
            {labels.decision[step.decision]}
          </span>
          {step.sla === undefined ? null : (
            <span
              className={cn(
                'text-2xs',
                step.slaBreached === true ? 'font-medium text-danger-fg' : 'text-fg-muted',
              )}
            >
              {step.slaBreached === true ? `${labels.slaBreached} · ${step.sla}` : step.sla}
            </span>
          )}
        </div>

        {step.actorName === undefined ? null : (
          <p className="text-sm text-fg-muted">
            {step.actorName}
            {step.actorRole === undefined ? '' : ` · ${step.actorRole}`}
            {step.at === undefined ? '' : ` · ${step.at}`}
          </p>
        )}

        {step.reason === undefined ? null : (
          <p className="text-sm text-fg-default">
            {labels.reasonPrefix} {step.reason}
          </p>
        )}

        {step.decision === 'pending' && action !== undefined ? (
          <div>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                action.onSelect(step.id);
              }}
            >
              {action.label}
            </Button>
          </div>
        ) : null}

        {step.branch === undefined || step.branch.length === 0 ? null : (
          <ol className="mt-2 flex flex-col gap-3 border-s border-default ps-4">
            {step.branch.map((child) => (
              <Step key={child.id} step={child} labels={labels} {...(action === undefined ? {} : { action })} />
            ))}
          </ol>
        )}
      </div>
    </li>
  );
}

export function ApprovalTimeline({ steps, labels, action, className }: ApprovalTimelineProps): React.JSX.Element {
  return (
    <ol
      data-slot="approval-timeline"
      aria-label={labels.region}
      className={cn('flex flex-col gap-4 border-s border-default ps-3', className)}
    >
      {steps.map((step) => (
        <Step key={step.id} step={step} labels={labels} {...(action === undefined ? {} : { action })} />
      ))}
    </ol>
  );
}
