import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DisplayRuntime } from '../runtime/display-runtime';
import { RuntimeConfigProvider, type RuntimeConfig } from '../runtime/runtime-config';
import { DEVICE_CREDENTIAL_KEY } from '../features/pairing/device-credential-store';
import type { PairingClient } from '../features/pairing/pairing-contract';
import { createFixedClock } from '../lib/clock';
import { createDeviceLog } from '../lib/device-log';
import { parseKioskEnv } from '../lib/env';
import { createMemoryStore } from '../lib/storage';
import { CREDENTIAL, createManualTransport, snapshot, type ManualTransport } from './fixtures';
import { vi } from 'vitest';

const ENV = parseKioskEnv({
  apiUrl: 'https://hms.example/api/v1',
  realtimeUrl: undefined,
  transport: undefined,
  pollIntervalMs: '3000',
  staleAfterMs: '15000',
  expiredAfterMs: '120000',
});

const NEVER_PAIRS: PairingClient = {
  requestChallenge: () => Promise.reject(new Error('not used')),
  pollStatus: () => Promise.reject(new Error('not used')),
};

function mountPairedBoard(): { manual: ManualTransport; clock: ReturnType<typeof createFixedClock> } {
  const clock = createFixedClock(new Date('2026-08-19T14:07:02'));
  const manual = createManualTransport('polling');
  const storage = createMemoryStore(new Map([[DEVICE_CREDENTIAL_KEY, JSON.stringify(CREDENTIAL)]]));
  const overrides: Partial<RuntimeConfig> = {
    clock,
    env: ENV,
    storage,
    log: createDeviceLog(() => clock.now()),
    pairingClient: NEVER_PAIRS,
    createTransport: () => manual.transport,
  };

  render(
    <RuntimeConfigProvider overrides={overrides}>
      <DisplayRuntime />
    </RuntimeConfigProvider>,
  );

  return { manual, clock };
}

describe('DisplayRuntime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('restores its board from the cached device token after a power cut', () => {
    const { manual } = mountPairedBoard();

    // No pairing code: the screen came back on its own, unattended.
    expect(screen.queryByTestId('pairing-code')).not.toBeInTheDocument();
    expect(screen.getByTestId('board-connecting')).toBeInTheDocument();
    expect(screen.getByText('OPD Block A')).toBeInTheDocument();
    expect(manual.isStarted()).toBe(true);
  });

  it('renders the board once the first snapshot arrives', () => {
    const { manual, clock } = mountPairedBoard();

    act(() => {
      manual.emit(snapshot(), clock.now());
    });

    expect(screen.getByTestId('now-serving-token')).toHaveTextContent('C-45');
    expect(screen.getAllByTestId('next-token-row')).toHaveLength(3);
    expect(screen.getByTestId('board-status-chip')).toHaveAttribute('data-freshness', 'live');
  });

  it('flags a disconnected transport as reconnecting without discarding the board', () => {
    const { manual, clock } = mountPairedBoard();
    act(() => {
      manual.emit(snapshot(), clock.now());
    });

    act(() => {
      manual.setStatus('reconnecting', 'Wi-Fi dropped');
      vi.advanceTimersByTime(1000);
    });

    const chip = screen.getByTestId('board-status-chip');
    expect(chip).toHaveAttribute('data-freshness', 'stale');
    expect(chip).toHaveTextContent('Reconnecting');
    expect(chip).toHaveTextContent('Last updated 14:07:02');
    // Still actionable at this point, so the tokens stay presented as current.
    expect(screen.getByTestId('now-serving')).toHaveAttribute('aria-disabled', 'false');
  });

  it('stops presenting stale tokens as current once the feed goes quiet', () => {
    const { manual, clock } = mountPairedBoard();
    act(() => {
      manual.emit(snapshot(), clock.now());
    });

    act(() => {
      manual.setStatus('reconnecting', 'Wi-Fi dropped');
      clock.advance(150_000);
      vi.advanceTimersByTime(1000);
    });

    const chip = screen.getByTestId('board-status-chip');
    expect(chip).toHaveAttribute('data-freshness', 'expired');
    expect(chip).toHaveTextContent('Not live');
    expect(chip).toHaveTextContent('Last updated 14:07:02');

    expect(screen.getByTestId('not-live-banner')).toBeInTheDocument();
    expect(screen.getByText('Last called — not live')).toBeInTheDocument();
    expect(screen.queryByText('Now serving')).not.toBeInTheDocument();
    expect(screen.getByTestId('now-serving')).toHaveAttribute('aria-disabled', 'true');
    // The numerals remain visible but demoted; they are never removed silently.
    expect(screen.getByTestId('now-serving-token')).toHaveTextContent('C-45');
  });

  it('recovers to live when the feed comes back, with no reload and no re-pairing', () => {
    const { manual, clock } = mountPairedBoard();
    act(() => {
      manual.emit(snapshot(), clock.now());
    });
    act(() => {
      manual.setStatus('reconnecting', 'Wi-Fi dropped');
      clock.advance(150_000);
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByTestId('board-status-chip')).toHaveAttribute('data-freshness', 'expired');

    act(() => {
      manual.emit(snapshot({ version: 2, nextTokens: [] }), clock.now());
      vi.advanceTimersByTime(1000);
    });

    expect(screen.getByTestId('board-status-chip')).toHaveAttribute('data-freshness', 'live');
    expect(screen.queryByTestId('not-live-banner')).not.toBeInTheDocument();
    expect(screen.getByText('Now serving')).toBeInTheDocument();
  });

  it('ignores an out-of-order snapshot instead of flipping back to a served token', () => {
    const { manual, clock } = mountPairedBoard();
    act(() => {
      manual.emit(snapshot({ version: 9 }), clock.now());
    });
    act(() => {
      manual.emit(
        snapshot({
          version: 4,
          nowServing: [
            {
              id: 'tok-01',
              tokenDisplay: 'C-01',
              status: 'called',
              roomLabel: 'Room 3',
              counterLabel: '',
              doctorName: 'Dr A. Menon',
              doctorSpeciality: 'Orthopaedics',
              calledAt: '2026-08-19T09:00:00.000Z',
            },
          ],
        }),
        clock.now(),
      );
    });

    expect(screen.getByTestId('now-serving-token')).toHaveTextContent('C-45');
  });

  it('returns to the pairing screen when the device token is revoked', () => {
    const { manual } = mountPairedBoard();

    act(() => {
      manual.setStatus('unauthorized', 'Device token revoked');
    });

    expect(screen.getByTestId('pairing-screen')).toBeInTheDocument();
  });
});
