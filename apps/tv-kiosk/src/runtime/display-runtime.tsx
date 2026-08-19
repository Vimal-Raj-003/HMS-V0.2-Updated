'use client';

import type { ReactNode } from 'react';
import { BoardStatusChip } from '../features/board/board-status-chip';
import { TokenBoard } from '../features/board/token-board';
import { freshnessOf } from '../features/board/staleness';
import { useBoardFeed } from '../features/board/use-board-feed';
import { PairingScreen } from '../features/pairing/pairing-screen';
import { usePairing } from '../features/pairing/use-pairing';
import type { DeviceCredential } from '../features/pairing/pairing-contract';
import { BoardClock } from '../features/board/board-clock';
import { DiagnosticsCard } from './diagnostics-card';
import { useNow } from './use-now';
import { useRuntimeConfig } from './runtime-config';

/**
 * The whole display client: restore or pair, then render the board. There is no
 * navigation, no login and nothing to click — a board is expected to come up
 * after a power cut and stay up for a month (EN-018 §13).
 */
export function DisplayRuntime(): ReactNode {
  const { clock, appVersion, log } = useRuntimeConfig();
  const now = useNow(clock, 1000);
  const pairing = usePairing();

  if (pairing.state.phase === 'paired') {
    return (
      <PairedBoard
        credential={pairing.state.credential}
        now={now}
        deviceId={pairing.deviceId}
        onRevoked={pairing.forget}
      />
    );
  }

  return (
    <>
      <PairingScreen
        state={pairing.state}
        deviceId={pairing.deviceId}
        now={now}
        boardHint="This screen is not yet assigned to a board."
      />
      <DiagnosticsCard
        deviceId={pairing.deviceId}
        boardId={null}
        boardName={null}
        appVersion={appVersion}
        transportKind="none"
        events={log.entries()}
      />
    </>
  );
}

interface PairedBoardProps {
  readonly credential: DeviceCredential;
  readonly now: Date | null;
  readonly deviceId: string | null;
  readonly onRevoked: (reason: string) => void;
}

function PairedBoard(props: PairedBoardProps): ReactNode {
  const { env, clock, appVersion, log } = useRuntimeConfig();
  const feed = useBoardFeed(props.credential, props.onRevoked);
  const now = props.now ?? clock.now();

  const freshness = freshnessOf({
    lastUpdatedAt: feed.lastUpdatedAt,
    now,
    status: feed.status,
    thresholds: { staleAfterMs: env.staleAfterMs, expiredAfterMs: env.expiredAfterMs },
  });

  // Before the first snapshot there is nothing truthful to show, so the board
  // says so rather than rendering an empty frame that looks like a quiet clinic.
  const diagnostics = (
    <DiagnosticsCard
      deviceId={props.deviceId}
      boardId={props.credential.boardId}
      boardName={props.credential.boardName}
      appVersion={appVersion}
      transportKind={feed.transportKind}
      events={log.entries()}
    />
  );

  if (feed.snapshot === null) {
    return (
      <>
        <main
          className="bg-canvas text-fg-default flex h-dvh w-dvw flex-col items-center justify-center gap-8 p-12"
          data-testid="board-connecting"
        >
          <h1 className="font-display text-5xl font-semibold">{props.credential.boardName}</h1>
          <p className="text-tv-body text-fg-muted" role="status">
            Waiting for the first update from the queue service…
          </p>
          <BoardClock now={props.now} />
          <BoardStatusChip
            freshness={freshness}
            status={feed.status}
            lastUpdatedAt={feed.lastUpdatedAt}
            now={props.now}
            transportKind={feed.transportKind}
          />
        </main>
        {diagnostics}
      </>
    );
  }

  return (
    <>
      <TokenBoard
        snapshot={feed.snapshot}
        freshness={freshness}
        status={feed.status}
        lastUpdatedAt={feed.lastUpdatedAt}
        now={props.now}
        transportKind={feed.transportKind}
      />
      {diagnostics}
    </>
  );
}
