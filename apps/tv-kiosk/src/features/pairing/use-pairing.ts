'use client';

import { useCallback, useEffect, useState } from 'react';
import { clearCredential, loadCredential, saveCredential } from './device-credential-store';
import { describeScreen, ensureDeviceId } from './device-identity';
import type { DeviceCredential, PairingChallenge } from './pairing-contract';
import { useRuntimeConfig } from '../../runtime/runtime-config';

export type PairingState =
  /** Reading the cached credential. One frame, and never a flash of the code. */
  | { readonly phase: 'restoring' }
  | { readonly phase: 'requesting' }
  | { readonly phase: 'awaiting'; readonly challenge: PairingChallenge }
  | { readonly phase: 'unreachable'; readonly message: string }
  | { readonly phase: 'paired'; readonly credential: DeviceCredential };

export interface PairingHandle {
  readonly state: PairingState;
  readonly deviceId: string | null;
  /** Drop the credential and go back to showing a code (token revoked/expired). */
  readonly forget: (reason: string) => void;
}

const RETRY_AFTER_UNREACHABLE_MS = 10_000;

/**
 * EN-018 §3.2. Boot order matters: restore first, ask for a code second. A board
 * that comes back from a power cut must repaint its board without anyone walking
 * to the corridor with an admin console.
 */
export function usePairing(): PairingHandle {
  const { storage, pairingClient, clock, log, deviceKind, appVersion } = useRuntimeConfig();
  const [state, setState] = useState<PairingState>({ phase: 'restoring' });
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

  const forget = useCallback(
    (reason: string) => {
      clearCredential(storage);
      log.record('unauthorized', reason);
      setState({ phase: 'restoring' });
      setGeneration((value) => value + 1);
    },
    [storage, log],
  );

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let releaseSleep: (() => void) | null = null;

    const sleep = (ms: number): Promise<void> =>
      new Promise<void>((resolve) => {
        releaseSleep = resolve;
        timer = setTimeout(resolve, ms);
      });

    const cached = loadCredential(storage);
    const id = ensureDeviceId(storage, globalThis.crypto);
    setDeviceId(id);

    if (cached !== null) {
      log.record('boot', `Restored board ${cached.boardId} from cache`);
      setState({ phase: 'paired', credential: cached });
      return () => {
        cancelled = true;
        controller.abort();
      };
    }

    const registration = {
      deviceId: id,
      kind: deviceKind,
      resolution: describeScreen(typeof window === 'undefined' ? null : window.screen),
      appVersion,
    };

    const run = async (): Promise<void> => {
      setState({ phase: 'requesting' });
      while (!cancelled) {
        let challenge: PairingChallenge;
        try {
          challenge = await pairingClient.requestChallenge(registration, controller.signal);
        } catch (error) {
          if (cancelled) return;
          const message = error instanceof Error ? error.message : 'Cannot reach the pairing service';
          log.record('pairing_failed', message);
          setState({ phase: 'unreachable', message });
          await sleep(RETRY_AFTER_UNREACHABLE_MS);
          continue;
        }
        if (cancelled) return;
        setState({ phase: 'awaiting', challenge });

        const expiresAt = Date.parse(challenge.expiresAt);
        let codeAlive = true;
        while (codeAlive && !cancelled) {
          await sleep(challenge.pollIntervalMs);
          if (cancelled) return;
          try {
            const status = await pairingClient.pollStatus(id, challenge.pairingCode, controller.signal);
            if (cancelled) return;
            if (status.status === 'paired') {
              saveCredential(storage, status.credential);
              log.record('paired', `Board ${status.credential.boardId}`);
              setState({ phase: 'paired', credential: status.credential });
              return;
            }
            if (status.status === 'expired') codeAlive = false;
          } catch {
            // Transient: the console may simply not be reachable yet. Keep the
            // code on screen until it actually expires.
          }
          if (Number.isFinite(expiresAt) && clock.now().getTime() >= expiresAt) codeAlive = false;
        }
      }
    };

    void run();

    return () => {
      cancelled = true;
      controller.abort();
      if (timer !== null) clearTimeout(timer);
      // Resolve any pending sleep so the loop unwinds instead of parking forever.
      releaseSleep?.();
    };
  }, [storage, pairingClient, clock, log, deviceKind, appVersion, generation]);

  return { state, deviceId, forget };
}
