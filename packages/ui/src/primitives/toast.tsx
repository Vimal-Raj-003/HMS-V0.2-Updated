'use client';

import { AlertTriangle, CheckCircle2, Info, OctagonAlert, X } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { cn } from '../lib/cn.js';
import { Button } from './button.js';

/**
 * docs/06 §6.8 — a toast is "non-blocking confirmation of a user-initiated action …
 * auto-dismiss 4 s (6 s with Undo); max 3 stacked; bottom-right desktop / top mobile;
 * never for errors that need action; never for clinical alerts".
 *
 * docs/06 §5.2 #32 `CriticalAlertToast` is the exception that proves the rule: it is
 * `z 1300`, **not auto-dismissing**, and requires an explicit acknowledgement. That is
 * modelled here as `requiresAcknowledgement`, which the engine refuses to override —
 * `dismiss()` on such a toast is a no-op, so no future refactor can make a critical
 * result disappear on a timer.
 */
export type ToastSeverity = 'info' | 'success' | 'warning' | 'danger' | 'critical';

export interface ToastAction {
  readonly label: string;
  readonly onSelect: () => void;
}

export interface ToastOptions {
  readonly id?: string;
  /** Already localised by the caller — components never hold English (docs/06 §8). */
  readonly title: string;
  readonly description?: string;
  readonly severity?: ToastSeverity;
  readonly action?: ToastAction;
  /** §6.8 — an Undo affordance extends the auto-dismiss window from 4 s to 6 s. */
  readonly undo?: ToastAction;
  /** §5.2 #32 — forced on for `critical`; cannot be turned off for it. */
  readonly requiresAcknowledgement?: boolean;
  readonly acknowledgeLabel?: string;
  readonly onAcknowledge?: (id: string) => void;
  readonly dismissLabel?: string;
}

export interface ToastRecord {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly severity: ToastSeverity;
  readonly action?: ToastAction;
  readonly undo?: ToastAction;
  readonly requiresAcknowledgement: boolean;
  readonly acknowledgeLabel?: string;
  readonly onAcknowledge?: (id: string) => void;
  readonly dismissLabel?: string;
}

/** §6.8 — "max 3 stacked" with the remainder collapsing into the notification bell. */
export const TOAST_STACK_LIMIT = 3;
export const TOAST_DURATION_MS = 4000;
export const TOAST_DURATION_WITH_UNDO_MS = 6000;

interface ToastContextValue {
  readonly toasts: readonly ToastRecord[];
  readonly overflow: number;
  readonly publish: (options: ToastOptions) => string;
  /** Returns `false` when the toast requires acknowledgement and was therefore kept. */
  readonly dismiss: (id: string) => boolean;
  readonly acknowledge: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const value = useContext(ToastContext);
  if (value === null) {
    throw new Error('useToast must be used inside <ToastProvider>.');
  }
  return value;
}

export interface ToastProviderProps {
  readonly children: ReactNode;
  /** Deterministic id source for tests and SSR; defaults to a monotonic counter. */
  readonly generateId?: () => string;
}

export function ToastProvider({ children, generateId }: ToastProviderProps): React.JSX.Element {
  const [queue, setQueue] = useState<readonly ToastRecord[]>([]);
  const counter = useRef(0);

  const publish = useCallback(
    (options: ToastOptions): string => {
      counter.current += 1;
      const id = options.id ?? generateId?.() ?? `toast-${String(counter.current)}`;
      const severity = options.severity ?? 'info';
      const record: ToastRecord = {
        id,
        title: options.title,
        severity,
        requiresAcknowledgement: severity === 'critical' || options.requiresAcknowledgement === true,
        ...(options.description === undefined ? {} : { description: options.description }),
        ...(options.action === undefined ? {} : { action: options.action }),
        ...(options.undo === undefined ? {} : { undo: options.undo }),
        ...(options.acknowledgeLabel === undefined ? {} : { acknowledgeLabel: options.acknowledgeLabel }),
        ...(options.onAcknowledge === undefined ? {} : { onAcknowledge: options.onAcknowledge }),
        ...(options.dismissLabel === undefined ? {} : { dismissLabel: options.dismissLabel }),
      };
      setQueue((current) => [...current.filter((item) => item.id !== id), record]);
      return id;
    },
    [generateId],
  );

  const dismiss = useCallback((id: string): boolean => {
    let removed = false;
    setQueue((current) => {
      const target = current.find((item) => item.id === id);
      if (target === undefined || target.requiresAcknowledgement) {
        return current;
      }
      removed = true;
      return current.filter((item) => item.id !== id);
    });
    return removed;
  }, []);

  const acknowledge = useCallback((id: string): void => {
    setQueue((current) => {
      const target = current.find((item) => item.id === id);
      target?.onAcknowledge?.(id);
      return current.filter((item) => item.id !== id);
    });
  }, []);

  const value = useMemo<ToastContextValue>(() => {
    // Critical alerts outrank informational ones for the three visible slots.
    const ordered = [...queue].sort((a, b) => {
      const weight = (item: ToastRecord): number => (item.requiresAcknowledgement ? 0 : 1);
      return weight(a) - weight(b);
    });
    return {
      toasts: ordered.slice(0, TOAST_STACK_LIMIT),
      overflow: Math.max(0, ordered.length - TOAST_STACK_LIMIT),
      publish,
      dismiss,
      acknowledge,
    };
  }, [queue, publish, dismiss, acknowledge]);

  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

const SEVERITY_STYLES: Readonly<Record<ToastSeverity, string>> = {
  info: 'border-info-border bg-info-surface text-info-on-surface',
  success: 'border-success-border bg-success-surface text-success-on-surface',
  warning: 'border-warning-border bg-warning-surface text-warning-on-surface',
  danger: 'border-danger-border bg-danger-surface text-danger-on-surface',
  critical: 'border-2 border-danger-border bg-danger-surface text-danger-on-surface shadow-e5',
};

function SeverityIcon({ severity }: { readonly severity: ToastSeverity }): React.JSX.Element {
  switch (severity) {
    case 'success':
      return <CheckCircle2 className="size-4 shrink-0" aria-hidden="true" />;
    case 'warning':
      return <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />;
    case 'danger':
    case 'critical':
      return <OctagonAlert className="size-4 shrink-0" aria-hidden="true" />;
    case 'info':
      return <Info className="size-4 shrink-0" aria-hidden="true" />;
  }
}

interface ToastItemProps {
  readonly toast: ToastRecord;
  readonly onDismiss: (id: string) => void;
  readonly onAcknowledge: (id: string) => void;
}

function ToastItem({ toast, onDismiss, onAcknowledge }: ToastItemProps): React.JSX.Element {
  useEffect(() => {
    if (toast.requiresAcknowledgement) return undefined;
    const duration = toast.undo === undefined ? TOAST_DURATION_MS : TOAST_DURATION_WITH_UNDO_MS;
    const timer = setTimeout(() => {
      onDismiss(toast.id);
    }, duration);
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
      className={cn(
        'pointer-events-auto flex w-full max-w-96 items-start gap-2 rounded-lg border p-3 shadow-e3',
        SEVERITY_STYLES[toast.severity],
      )}
    >
      <SeverityIcon severity={toast.severity} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-md font-medium">{toast.title}</p>
        {toast.description === undefined ? null : <p className="text-sm">{toast.description}</p>}
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
          <X className="size-4" />
        </button>
      )}
    </div>
  );
}

export interface ToastViewportProps {
  /** Accessible name of the region, from the caller's i18n catalogue. */
  readonly label: string;
  /** Rendered when more than three alerts are queued (`+n more`). */
  readonly renderOverflow?: (count: number) => ReactNode;
}

export function ToastViewport({ label, renderOverflow }: ToastViewportProps): React.JSX.Element {
  const { toasts, overflow, dismiss, acknowledge } = useToast();
  return (
    <div
      data-slot="toast-viewport"
      // A bare <div> has no role, and ARIA prohibits an accessible name on a
      // generic element: `aria-label` is discarded, so the region announces as
      // nothing. `role="region"` is what makes the name survive, and it also
      // gives the alerts a landmark a screen-reader user can jump to — which is
      // the point of a toast region carrying clinical alerts.
      role="region"
      aria-label={label}
      className={cn(
        'pointer-events-none fixed inset-inline-end-4 bottom-4 z-toast flex w-full max-w-96 flex-col gap-2',
        // §6.8 — top on mobile, bottom-right on desktop.
        'max-sm:inset-inline-start-4 max-sm:bottom-auto max-sm:top-4 max-sm:max-w-none',
        // §5.2 #32 — a critical alert sits above every other toast.
        'has-[[data-requires-acknowledgement=true]]:z-critical-alert',
      )}
    >
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} onAcknowledge={acknowledge} />
      ))}
      {overflow > 0 && renderOverflow !== undefined ? (
        <div className="pointer-events-auto">{renderOverflow(overflow)}</div>
      ) : null}
    </div>
  );
}
