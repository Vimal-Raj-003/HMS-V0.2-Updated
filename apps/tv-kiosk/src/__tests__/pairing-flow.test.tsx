import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DisplayRuntime } from '../runtime/display-runtime';
import { RuntimeConfigProvider, type RuntimeConfig } from '../runtime/runtime-config';
import { DEVICE_CREDENTIAL_KEY, loadCredential } from '../features/pairing/device-credential-store';
import type { PairingClient, PairingStatus } from '../features/pairing/pairing-contract';
import { createFixedClock } from '../lib/clock';
import { createDeviceLog } from '../lib/device-log';
import { parseKioskEnv } from '../lib/env';
import { createMemoryStore, type KeyValueStore } from '../lib/storage';
import { CREDENTIAL, createManualTransport, snapshot } from './fixtures';

const ENV = parseKioskEnv({
  apiUrl: 'https://hms.example/api/v1',
  realtimeUrl: undefined,
  transport: undefined,
  pollIntervalMs: '3000',
  staleAfterMs: '15000',
  expiredAfterMs: '120000',
});

describe('pairing flow', () => {
  it('shows a code, then renders the board it is paired to, then remembers it', async () => {
    const clock = createFixedClock(new Date('2026-08-19T14:07:02'));
    const storage: KeyValueStore = createMemoryStore();
    const manual = createManualTransport('polling');

    let polls = 0;
    const pairingClient: PairingClient = {
      requestChallenge: (input) =>
        Promise.resolve({
          deviceId: input.deviceId,
          pairingCode: '483920',
          expiresAt: new Date(clock.now().getTime() + 600_000).toISOString(),
          pollIntervalMs: 5,
        }),
      pollStatus: (): Promise<PairingStatus> => {
        polls += 1;
        // The operator types the code into the fleet console on the second poll.
        return Promise.resolve(
          polls >= 2 ? { status: 'paired', credential: CREDENTIAL } : { status: 'pending' },
        );
      },
    };

    const overrides: Partial<RuntimeConfig> = {
      clock,
      env: ENV,
      storage,
      log: createDeviceLog(() => clock.now()),
      pairingClient,
      createTransport: () => manual.transport,
    };

    render(
      <RuntimeConfigProvider overrides={overrides}>
        <DisplayRuntime />
      </RuntimeConfigProvider>,
    );

    expect(await screen.findByTestId('pairing-code')).toHaveTextContent('483920');

    // Paired: the device now holds a scoped board token and shows that board.
    expect(await screen.findByTestId('board-connecting')).toBeInTheDocument();
    expect(screen.queryByTestId('pairing-code')).not.toBeInTheDocument();

    act(() => {
      manual.emit(snapshot(), clock.now());
    });
    expect(screen.getByTestId('now-serving-token')).toHaveTextContent('C-45');

    // Persisted, so the next power cut does not need an operator.
    const stored = loadCredential(storage);
    expect(stored?.boardId).toBe('board-opd-a');
    expect(stored?.scopes).toContain('display.token_board.read');
  });

  it('keeps showing a code, and keeps retrying, when the pairing service is down', async () => {
    const clock = createFixedClock(new Date('2026-08-19T14:07:02'));
    const overrides: Partial<RuntimeConfig> = {
      clock,
      env: ENV,
      storage: createMemoryStore(),
      log: createDeviceLog(() => clock.now()),
      pairingClient: {
        requestChallenge: () => Promise.reject(new Error('fetch failed')),
        pollStatus: () => Promise.reject(new Error('fetch failed')),
      },
      createTransport: () => createManualTransport('polling').transport,
    };

    render(
      <RuntimeConfigProvider overrides={overrides}>
        <DisplayRuntime />
      </RuntimeConfigProvider>,
    );

    expect(await screen.findByTestId('pairing-unreachable')).toBeInTheDocument();
    expect(screen.queryByTestId('token-board')).not.toBeInTheDocument();
  });

  it('discards a corrupted stored credential rather than authenticating with it', () => {
    const storage = createMemoryStore(new Map([[DEVICE_CREDENTIAL_KEY, '{"token":']]));
    expect(loadCredential(storage)).toBeNull();
    expect(storage.read(DEVICE_CREDENTIAL_KEY)).toBeNull();
  });

  it('discards a stored credential that no longer matches the contract', () => {
    const storage = createMemoryStore(
      new Map([[DEVICE_CREDENTIAL_KEY, JSON.stringify({ boardId: 'board-opd-a' })]]),
    );
    expect(loadCredential(storage)).toBeNull();
  });
});
