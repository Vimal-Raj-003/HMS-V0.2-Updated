'use client';

import { OctagonAlert } from 'lucide-react';
import { useRef, useState } from 'react';
import { cn } from '../lib/cn.js';
import { Button } from '../primitives/button.js';

/**
 * `CriticalAlertToast` — docs/06 §5.2 #32.
 *
 * "`z 1300`, danger, **not auto-dismissing**, requires 'Acknowledge' (records who/when),
 *  stacks max 3 with '+n more' opening the inbox, plays a distinct sound once (respects
 *  device mute but not quiet hours for critical), duplicates the alert into the
 *  notification bell."
 *
 * There is deliberately no `onDismiss`, no close button and no timer in this component.
 * The ONLY way it leaves the screen is `onAcknowledge`, and the acknowledgement carries
 * the acknowledging user's identity so the audit trail (docs/04 §5) has an actor.
 */
export interface CriticalAlert {
  readonly id: string;
  /** Already-localised headline, e.g. "Critical result — Potassium 6.8 mmol/L". */
  readonly title: string;
  /** Full clinical sentence including unit, reference range and delta (docs/06 §7). */
  readonly detail: string;
  /** Patient identifiers — docs/06 §1.2.1 requires two on any patient-acting surface. */
  readonly patientName: string;
  readonly uhid: string;
  /** `dd-MM HH:mm` in hospital time, already formatted (docs/06 §1.2.10). */
  readonly raisedAt: string;
}

export interface CriticalAlertToastLabels {
  readonly region: string;
  readonly acknowledge: string;
  readonly acknowledging: string;
  readonly uhidPrefix: string;
  readonly openInbox: (count: number) => string;
}

export interface CriticalAlertToastProps {
  readonly alert: CriticalAlert;
  readonly labels: CriticalAlertToastLabels;
  /** Resolves once the acknowledgement has been recorded server-side. */
  readonly onAcknowledge: (alertId: string) => void | Promise<void>;
  /** Rendered as "+n more" when other critical alerts are queued behind this one. */
  readonly overflowCount?: number;
  readonly onOpenInbox?: () => void;
  readonly className?: string;
}

export function CriticalAlertToast({
  alert,
  labels,
  onAcknowledge,
  overflowCount = 0,
  onOpenInbox,
  className,
}: CriticalAlertToastProps): React.JSX.Element {
  const [pending, setPending] = useState(false);
  const acknowledged = useRef(false);

  const handleAcknowledge = (): void => {
    if (acknowledged.current || pending) return;
    const result = onAcknowledge(alert.id);
    if (result instanceof Promise) {
      setPending(true);
      void result.finally(() => {
        acknowledged.current = true;
        setPending(false);
      });
      return;
    }
    acknowledged.current = true;
  };

  return (
    <div
      data-slot="critical-alert-toast"
      data-alert-id={alert.id}
      data-requires-acknowledgement="true"
      // docs/06 §7 — critical results are an assertive live region, not a polite one.
      role="alert"
      aria-live="assertive"
      aria-label={labels.region}
      className={cn(
        'z-critical-alert flex w-full max-w-96 flex-col gap-2 rounded-lg border-2 p-3',
        'border-danger-border bg-danger-surface text-danger-on-surface shadow-e5',
        className,
      )}
    >
      <div className="flex items-start gap-2">
        <OctagonAlert className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-md font-bold">{alert.title}</p>
          <p className="text-sm">{alert.detail}</p>
          <p className="text-xs">
            {alert.patientName} · {labels.uhidPrefix} {alert.uhid} · {alert.raisedAt}
          </p>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2">
        {overflowCount > 0 && onOpenInbox !== undefined ? (
          <Button variant="link" size="sm" onClick={onOpenInbox}>
            {labels.openInbox(overflowCount)}
          </Button>
        ) : (
          <span />
        )}
        <Button variant="danger" size="sm" disabled={pending} onClick={handleAcknowledge}>
          {pending ? labels.acknowledging : labels.acknowledge}
        </Button>
      </div>
    </div>
  );
}
