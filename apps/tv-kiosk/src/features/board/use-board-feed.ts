'use client';

import { useEffect, useRef, useState } from 'react';
import type { BoardSnapshot } from './board-contract';
import type { BoardTransport, BoardTransportKind, TransportStatus } from './transport';
import type { DeviceCredential } from '../pairing/pairing-contract';
import { useRuntimeConfig } from '../../runtime/runtime-config';

export interface BoardFeed {
  readonly snapshot: BoardSnapshot | null;
  readonly status: TransportStatus;
  readonly detail: string | null;
  readonly lastUpdatedAt: Date | null;
  readonly transportKind: BoardTransportKind;
}

/**
 * How long the board may go without a successful update before it stops waiting
 * politely and re-arms the transport itself. Hospital Wi-Fi drops silently: the
 * socket believes it is connected, the poll timer believes it is scheduled, and
 * the screen sits on a token from twenty minutes ago. Nobody is coming to fix it.
 */
const WATCHDOG_INTERVAL_MS = 30_000;
const WATCHDOG_SILENCE_MS = 90_000;

export function useBoardFeed(
  credential: DeviceCredential,
  onUnauthorized: (reason: string) => void,
): BoardFeed {
  const { createTransport, clock, log } = useRuntimeConfig();
  const [snapshot, setSnapshot] = useState<BoardSnapshot | null>(null);
  const [status, setStatus] = useState<TransportStatus>('connecting');
  const [detail, setDetail] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [transportKind, setTransportKind] = useState<BoardTransportKind>('polling');

  const lastUpdatedRef = useRef<Date | null>(null);
  const unauthorizedRef = useRef(onUnauthorized);
  unauthorizedRef.current = onUnauthorized;

  useEffect(() => {
    const transport: BoardTransport = createTransport(credential);
    let stopped = false;
    let kindAtStart = transport.kind;

    setTransportKind(transport.kind);
    log.record('transport_started', `Board ${credential.boardId} via ${transport.kind}`);

    transport.start({
      onSnapshot: (next, receivedAt) => {
        if (stopped) return;
        // An out-of-order snapshot must never overwrite a newer one: that is how
        // a board flips back to a token that has already been served.
        setSnapshot((current) => (current !== null && next.version < current.version ? current : next));
        lastUpdatedRef.current = receivedAt;
        setLastUpdatedAt(receivedAt);
      },
      onStatus: (nextStatus, nextDetail) => {
        if (stopped) return;
        setStatus(nextStatus);
        setDetail(nextDetail);
        setTransportKind(transport.kind);
        if (nextStatus === 'reconnecting') log.record('reconnecting', nextDetail ?? 'unknown');
        if (transport.kind !== kindAtStart) {
          kindAtStart = transport.kind;
          log.record('transport_switched', `Now using ${transport.kind}`);
        }
        if (nextStatus === 'unauthorized') {
          unauthorizedRef.current(nextDetail ?? 'Device token rejected');
        }
      },
    });

    const refreshNow = (): void => {
      transport.refresh();
    };
    const onOnline = (): void => {
      refreshNow();
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') refreshNow();
    };

    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisibility);

    const watchdog = setInterval(() => {
      const last = lastUpdatedRef.current;
      const silentFor = last === null ? Number.POSITIVE_INFINITY : clock.now().getTime() - last.getTime();
      if (silentFor >= WATCHDOG_SILENCE_MS) {
        log.record('error', 'Watchdog re-armed the board feed after silence');
        transport.refresh();
      }
    }, WATCHDOG_INTERVAL_MS);

    return () => {
      stopped = true;
      clearInterval(watchdog);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisibility);
      transport.stop();
    };
  }, [createTransport, credential, clock, log]);

  return { snapshot, status, detail, lastUpdatedAt, transportKind };
}
