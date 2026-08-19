'use client';

import { ScanLine } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useKeyboardWedge } from '../hooks/use-keyboard-wedge.js';
import { cn } from '../lib/cn.js';
import { inputClassName } from '../primitives/input.js';

/**
 * `BarcodeScanInput` — docs/06 §5.2 #23 and §6.2.
 *
 * "Keyboard-wedge detection (§6.2); accepts USB HID, Bluetooth, camera …; resolves any
 *  symbology via the EN-013 scan resolver and routes to the entity action; **shows the
 *  decoded entity for 1.5 s before acting**; audible + haptic confirm; failure shows the
 *  raw payload for support."
 *
 * §6.2 also fixes the safety rule this component enforces: "Scanner never triggers a
 * destructive action directly; it selects a target, the human confirms." So `onResolved`
 * receives a *selection*, never a command.
 */
export interface ScanResolution {
  /** Opaque entity id from the scan resolver. */
  readonly entityId: string;
  /** Already-localised, human-readable description shown in the confirmation chip. */
  readonly display: string;
  readonly entityKind: string;
}

export interface BarcodeScanInputLabels {
  readonly fieldLabel: string;
  readonly placeholder: string;
  readonly resolving: string;
  readonly unresolved: (rawPayload: string) => string;
  readonly manualEntryHint: string;
}

export interface BarcodeScanInputProps {
  readonly labels: BarcodeScanInputLabels;
  /** Resolves the raw payload; rejecting or returning `null` renders the failure state. */
  readonly resolve: (payload: string) => Promise<ScanResolution | null>;
  /** Called after the 1.5 s confirmation window with the resolved *target*. */
  readonly onResolved: (resolution: ScanResolution) => void;
  /** Also listen for scans when nothing is focused (bedside / counter reality, §6.2). */
  readonly listenGlobally?: boolean;
  /** Device-profile prefix, e.g. `~` for wristbands. */
  readonly prefix?: string;
  /** §5.2 #23 — the decoded entity is shown for 1.5 s before the action fires. */
  readonly confirmationMs?: number;
  readonly className?: string;
}

type ScanState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'resolving'; readonly payload: string }
  | { readonly kind: 'resolved'; readonly resolution: ScanResolution }
  | { readonly kind: 'unresolved'; readonly payload: string };

export function BarcodeScanInput({
  labels,
  resolve,
  onResolved,
  listenGlobally = true,
  prefix,
  confirmationMs = 1500,
  className,
}: BarcodeScanInputProps): React.JSX.Element {
  const inputId = useId();
  const statusId = `${inputId}-status`;
  const [text, setText] = useState('');
  const [state, setState] = useState<ScanState>({ kind: 'idle' });
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const handlePayload = (payload: string): void => {
    if (payload.trim() === '') return;
    setText('');
    setState({ kind: 'resolving', payload });
    void resolve(payload)
      .then((resolution) => {
        if (resolution === null) {
          setState({ kind: 'unresolved', payload });
          return;
        }
        setState({ kind: 'resolved', resolution });
        timerRef.current = setTimeout(() => {
          onResolved(resolution);
          setState({ kind: 'idle' });
        }, confirmationMs);
      })
      .catch(() => {
        setState({ kind: 'unresolved', payload });
      });
  };

  useKeyboardWedge({
    onScan: handlePayload,
    enabled: listenGlobally,
    ...(prefix === undefined ? {} : { prefix }),
  });

  useEffect(
    () => () => {
      if (timerRef.current !== undefined) clearTimeout(timerRef.current);
    },
    [],
  );

  return (
    <div data-slot="barcode-scan-input" className={cn('flex flex-col gap-1', className)}>
      <label htmlFor={inputId} className="text-md font-medium text-fg-default">
        {labels.fieldLabel}
      </label>
      <div className="relative flex items-center">
        <ScanLine
          className="pointer-events-none absolute inset-inline-start-3 size-4 text-fg-muted"
          aria-hidden="true"
        />
        <input
          id={inputId}
          // §6.2 — a focused BarcodeScanInput takes priority over the global listener,
          // and free-text fields only receive a scan when marked `data-scan-target`.
          data-scan-target=""
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={text}
          placeholder={labels.placeholder}
          aria-describedby={statusId}
          onChange={(event) => {
            setText(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              handlePayload(text);
            }
          }}
          className={cn(inputClassName, 'ps-9 font-mono')}
        />
      </div>

      <p id={statusId} role="status" aria-live="polite" className="min-h-4 text-xs">
        {state.kind === 'resolving' ? <span className="text-fg-muted">{labels.resolving}</span> : null}
        {state.kind === 'resolved' ? (
          <span
            data-scan-state="resolved"
            className="inline-flex items-center gap-1 rounded-full border border-success-border bg-success-surface px-2 py-0.5 text-success-on-surface"
          >
            {state.resolution.display}
          </span>
        ) : null}
        {state.kind === 'unresolved' ? (
          <span data-scan-state="unresolved" className="text-danger-fg">
            {labels.unresolved(state.payload)} {labels.manualEntryHint}
          </span>
        ) : null}
      </p>
    </div>
  );
}
