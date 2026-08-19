import type { ReactNode } from 'react';
import { formatClockTime } from '../../lib/format';
import type { PairingState } from './use-pairing';

export interface PairingScreenProps {
  readonly state: PairingState;
  readonly deviceId: string | null;
  readonly now: Date | null;
  readonly boardHint: string;
}

/**
 * EN-018 §3.2: the device shows a short code, an operator types it into the fleet
 * console and picks a board, and the device receives a scoped device token. The
 * code is set at kiosk scale on purpose — an IT engineer reads it from the
 * doorway of a corridor, not from a stepladder.
 *
 * The screen never blames the viewer and never shows a stack trace; when the
 * pairing service is unreachable it says so and keeps retrying by itself.
 */
export function PairingScreen(props: PairingScreenProps): ReactNode {
  const { state, deviceId, now, boardHint } = props;

  return (
    <main
      className="bg-canvas text-fg-default flex h-dvh w-dvw flex-col items-center justify-center gap-10 p-12"
      data-testid="pairing-screen"
      data-phase={state.phase}
    >
      <header className="text-center">
        <h1 className="font-display text-5xl font-semibold">Vim&apos;s HMS Display</h1>
        <p className="text-tv-body text-fg-muted mt-2">{boardHint}</p>
      </header>

      {state.phase === 'awaiting' ? (
        <section
          className="rounded-2xl border border-strong bg-layer-1 px-16 py-10 text-center"
          aria-live="polite"
        >
          <h2 className="text-tv-body font-display text-fg-muted font-semibold tracking-[0.08em] uppercase">
            Pairing code
          </h2>
          <p
            className="font-display text-tv-token text-accent-fg font-semibold tabular-nums"
            data-testid="pairing-code"
          >
            {state.challenge.pairingCode}
          </p>
          <p className="text-tv-body text-fg-muted mt-4">
            Enter this code in the display fleet console and choose a board.
          </p>
        </section>
      ) : null}

      {state.phase === 'requesting' || state.phase === 'restoring' ? (
        <p className="text-tv-body text-fg-muted" role="status">
          Preparing this screen…
        </p>
      ) : null}

      {state.phase === 'unreachable' ? (
        <section
          className="border-warning-border bg-warning-surface text-warning-fg max-w-4xl rounded-2xl border px-10 py-8 text-center"
          role="alert"
          data-testid="pairing-unreachable"
        >
          <h2 className="text-tv-body font-semibold">Cannot reach the pairing service</h2>
          <p className="text-tv-body mt-2">
            This screen will keep trying on its own. No action is needed here — if it persists, contact IT.
          </p>
        </section>
      ) : null}

      <footer className="text-tv-body text-fg-subtle flex items-center gap-8 tabular-nums">
        <span>Device {deviceId === null ? 'initialising' : deviceId.slice(0, 8)}</span>
        <span data-testid="pairing-clock">{now === null ? '--:--:--' : formatClockTime(now)}</span>
      </footer>
    </main>
  );
}
