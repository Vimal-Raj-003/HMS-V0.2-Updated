'use client';

import { useCallback, useRef, useState, type ReactNode } from 'react';
import { formatClockTime } from '../lib/format';
import type { DeviceEvent } from '../lib/device-log';

export interface DiagnosticsCardProps {
  readonly deviceId: string | null;
  readonly boardId: string | null;
  readonly boardName: string | null;
  readonly appVersion: string;
  readonly transportKind: string;
  readonly events: readonly DeviceEvent[];
}

const TAPS_REQUIRED = 5;
const TAP_WINDOW_MS = 3000;

/**
 * EN-018 §8: "a hidden 5-tap corner gesture to reveal the device diagnostics
 * card". It is the only interaction the board has, and it exists so an engineer
 * standing in a corridor can answer "which board is this and when did it last
 * hear from the server" without a laptop.
 */
export function DiagnosticsCard(props: DiagnosticsCardProps): ReactNode {
  const [open, setOpen] = useState(false);
  const taps = useRef<number[]>([]);

  const onCornerTap = useCallback(() => {
    const nowMs = Date.now();
    taps.current = [...taps.current, nowMs].filter((at) => nowMs - at <= TAP_WINDOW_MS);
    if (taps.current.length >= TAPS_REQUIRED) {
      taps.current = [];
      setOpen((value) => !value);
    }
  }, []);

  return (
    <>
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        onClick={onCornerTap}
        className="fixed top-0 left-0 size-24 opacity-0"
        data-testid="diagnostics-gesture"
      >
        <span className="sr-only">Device diagnostics</span>
      </button>
      {open ? (
        <aside
          className="border-strong bg-layer-3 text-fg-default fixed top-6 left-6 z-50 max-h-[80vh] w-[40rem] overflow-hidden rounded-2xl border p-6"
          data-testid="diagnostics-card"
        >
          <h2 className="font-display text-2xl font-semibold">Device diagnostics</h2>
          <dl className="mt-4 grid grid-cols-2 gap-2 text-lg">
            <dt className="text-fg-muted">Device</dt>
            <dd className="tabular-nums">{props.deviceId ?? 'unpaired'}</dd>
            <dt className="text-fg-muted">Board</dt>
            <dd>{props.boardName ?? props.boardId ?? 'unassigned'}</dd>
            <dt className="text-fg-muted">Transport</dt>
            <dd>{props.transportKind}</dd>
            <dt className="text-fg-muted">App version</dt>
            <dd className="tabular-nums">{props.appVersion}</dd>
          </dl>
          <ul className="mt-4 flex flex-col gap-1 text-base">
            {props.events.slice(0, 12).map((event, index) => (
              <li key={`${event.at.toISOString()}-${String(index)}`} className="text-fg-muted">
                <span className="tabular-nums">{formatClockTime(event.at)}</span> {event.kind} —{' '}
                {event.detail}
              </li>
            ))}
          </ul>
        </aside>
      ) : null}
    </>
  );
}
