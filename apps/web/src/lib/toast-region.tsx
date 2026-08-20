'use client';

import { Button, useToast, type ToastRecord, type ToastSeverity } from '@vims/ui';
import { useEffect } from 'react';
import { Check, Info, OctagonAlert, TriangleAlert, X } from './icons';

/**
 * Where toasts are drawn.
 *
 * `@vims/ui` ships a `ToastViewport`, and this is deliberately not it: that
 * component puts an `aria-label` on a `<div>` with no role, which axe reports as
 * a serious `aria-prohibited-attr` violation — an accessible name on an element
 * that has no semantics to name is simply dropped by assistive technology. The
 * workspace runs an axe scan in the browser suite and must stay at zero, and
 * this task may not change `packages/ui`, so the region is composed here from the
 * same `useToast()` state instead. The fix belongs upstream: `ToastViewport`
 * should carry `role="region"`.
 *
 * The behaviour contract of `docs/06` §6.8 is preserved exactly — auto-dismiss at
 * 4 s, 6 s when an Undo is offered, and **never** for a toast that requires
 * acknowledgement, which is what keeps a critical result from vanishing on a
 * timer (§5.2 #32).
 */
const AUTO_DISMISS_MS = 4000;
const AUTO_DISMISS_WITH_UNDO_MS = 6000;

const SEVERITY_STYLES: Readonly<Record<ToastSeverity, string>> = {
  info: 'border-info-border bg-info-surface text-info-on-surface',
  success: 'border-success-border bg-success-surface text-success-on-surface',
  warning: 'border-warning-border bg-warning-surface text-warning-on-surface',
  danger: 'border-danger-border bg-danger-surface text-danger-on-surface',
  critical: 'border-2 border-danger-border bg-danger-surface text-danger-on-surface shadow-e3',
};

function SeverityIcon({ severity }: { readonly severity: ToastSeverity }): React.JSX.Element {
  switch (severity) {
    case 'success':
      return <Check className="size-4 shrink-0" aria-hidden="true" />;
    case 'warning':
      return <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />;
    case 'danger':
    case 'critical':
      return <OctagonAlert className="size-4 shrink-0" aria-hidden="true" />;
    case 'info':
      return <Info className="size-4 shrink-0" aria-hidden="true" />;
  }
}

function Toast({
  toast,
  onDismiss,
  onAcknowledge,
}: {
  readonly toast: ToastRecord;
  readonly onDismiss: (id: string) => void;
  readonly onAcknowledge: (id: string) => void;
}): React.JSX.Element {
  useEffect(() => {
    // A toast that must be acknowledged has no timer at all. Giving one to a
    // critical result would let it disappear unread, which docs/06 §5.2 #32
    // treats as a safety defect rather than a UI nicety.
    if (toast.requiresAcknowledgement) return undefined;
    const timer = setTimeout(
      () => {
        onDismiss(toast.id);
      },
      toast.undo === undefined ? AUTO_DISMISS_MS : AUTO_DISMISS_WITH_UNDO_MS,
    );
    return () => {
      clearTimeout(timer);
    };
  }, [toast.id, toast.requiresAcknowledgement, toast.undo, onDismiss]);

  return (
    <div
      data-slot="toast"
      data-severity={toast.severity}
      data-requires-acknowledgement={toast.requiresAcknowledgement ? 'true' : 'false'}
      role={toast.requiresAcknowledgement ? 'alert' : 'status'}
      aria-live={toast.requiresAcknowledgement ? 'assertive' : 'polite'}
      className={`pointer-events-auto flex w-full max-w-96 items-start gap-2 rounded-lg border p-3 shadow-e3 ${SEVERITY_STYLES[toast.severity]}`}
    >
      <SeverityIcon severity={toast.severity} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-md font-medium">{toast.title}</p>
        {toast.description === undefined ? null : <p className="text-sm">{toast.description}</p>}
        {toast.undo === undefined && toast.action === undefined && !toast.requiresAcknowledgement ? null : (
          <div className="flex flex-wrap items-center gap-2">
            {toast.undo === undefined ? null : (
              <Button variant="link" size="sm" onClick={toast.undo.onSelect}>
                {toast.undo.label}
              </Button>
            )}
            {toast.action === undefined ? null : (
              <Button variant="secondary" size="sm" onClick={toast.action.onSelect}>
                {toast.action.label}
              </Button>
            )}
            {toast.requiresAcknowledgement ? (
              <Button
                variant="danger"
                size="sm"
                onClick={() => {
                  onAcknowledge(toast.id);
                }}
              >
                {toast.acknowledgeLabel ?? 'Acknowledge'}
              </Button>
            ) : null}
          </div>
        )}
      </div>
      {toast.requiresAcknowledgement ? null : (
        <button
          type="button"
          aria-label={toast.dismissLabel ?? 'Dismiss'}
          onClick={() => {
            onDismiss(toast.id);
          }}
          className="rounded-md p-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

export function ToastRegion({ label }: { readonly label: string }): React.JSX.Element | null {
  const { toasts, overflow, dismiss, acknowledge } = useToast();

  // Rendering an empty landmark puts a permanently empty region into every
  // screen-reader's landmark list, which is noise on every screen in the product.
  if (toasts.length === 0) return null;

  return (
    <div
      role="region"
      aria-label={label}
      data-slot="toast-region"
      className="pointer-events-none fixed inset-inline-end-4 bottom-4 z-toast flex w-full max-w-96 flex-col gap-2 max-sm:inset-inline-start-4 max-sm:bottom-auto max-sm:top-4 max-sm:max-w-none has-[[data-requires-acknowledgement=true]]:z-critical-alert"
    >
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} onDismiss={dismiss} onAcknowledge={acknowledge} />
      ))}
      {overflow > 0 ? (
        <p className="pointer-events-auto rounded-md border border-default bg-layer-1 p-2 text-xs text-fg-muted">
          +{overflow} more in the notification centre
        </p>
      ) : null}
    </div>
  );
}
