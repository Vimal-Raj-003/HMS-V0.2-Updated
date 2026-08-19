import type { BoardSnapshot } from '../features/board/board-contract';
import type {
  BoardTransport,
  BoardTransportHandlers,
  BoardTransportKind,
  TransportStatus,
} from '../features/board/transport';
import type { DeviceCredential } from '../features/pairing/pairing-contract';
import { DISPLAY_BOARD_SCOPE } from '../features/pairing/pairing-contract';

export const CREDENTIAL: DeviceCredential = {
  deviceId: 'device-corridor-a',
  token: 'device-token-abc',
  boardId: 'board-opd-a',
  boardName: 'OPD Block A',
  scopes: [DISPLAY_BOARD_SCOPE],
  pairedAt: '2026-08-19T08:00:00.000Z',
};

export function snapshot(overrides: Partial<BoardSnapshot> = {}): BoardSnapshot {
  return {
    boardId: 'board-opd-a',
    version: 1,
    generatedAt: '2026-08-19T14:07:02.000Z',
    hospitalName: "Vim's Hospital",
    locationLabel: 'OPD Block A',
    nowServing: [
      {
        id: 'tok-45',
        tokenDisplay: 'C-45',
        status: 'called',
        roomLabel: 'Room 3',
        counterLabel: '',
        doctorName: 'Dr A. Menon',
        doctorSpeciality: 'Orthopaedics',
        calledAt: '2026-08-19T14:06:50.000Z',
      },
    ],
    nextTokens: [
      { id: 'tok-46', tokenDisplay: 'C-46', status: 'waiting', roomLabel: 'Room 3', etaMinutes: 6 },
      { id: 'tok-47', tokenDisplay: 'C-47', status: 'waiting', roomLabel: 'Room 3', etaMinutes: 14 },
      { id: 'tok-48', tokenDisplay: 'C-48', status: 'waiting', roomLabel: 'Room 4', etaMinutes: 21 },
    ],
    summary: { waiting: 18, averageWaitMinutes: 22, notice: null },
    ticker: ['Please keep the corridor clear'],
    ...overrides,
  };
}

export interface ManualTransport {
  readonly transport: BoardTransport;
  readonly isStarted: () => boolean;
  readonly emit: (next: BoardSnapshot, at: Date) => void;
  readonly setStatus: (status: TransportStatus, detail?: string) => void;
  readonly refreshCount: () => number;
}

/** A transport driven entirely from the test — no timers, no network. */
export function createManualTransport(kind: BoardTransportKind): ManualTransport {
  let handlers: BoardTransportHandlers | null = null;
  let refreshes = 0;

  const transport: BoardTransport = {
    kind,
    start(next) {
      handlers = next;
      next.onStatus('connecting', null);
    },
    refresh() {
      refreshes += 1;
    },
    stop() {
      handlers = null;
    },
  };

  return {
    transport,
    isStarted: () => handlers !== null,
    emit: (next, at) => {
      handlers?.onSnapshot(next, at);
      handlers?.onStatus('live', null);
    },
    setStatus: (status, detail) => {
      handlers?.onStatus(status, detail ?? null);
    },
    refreshCount: () => refreshes,
  };
}
