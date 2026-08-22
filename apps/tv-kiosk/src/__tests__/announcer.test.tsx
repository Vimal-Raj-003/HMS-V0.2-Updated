import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DisplayRuntime } from '../runtime/display-runtime';
import { RuntimeConfigProvider, type RuntimeConfig } from '../runtime/runtime-config';
import { DEVICE_CREDENTIAL_KEY } from '../features/pairing/device-credential-store';
import type { PairingClient } from '../features/pairing/pairing-contract';
import type { Utterance } from '../features/announce/announcement-script';
import type { SpeakHandlers, SpeakRequest, Speaker } from '../features/announce/speaker';
import { BoardSnapshotSchema, type BoardAudio } from '../features/board/board-contract';
import { createFixedClock } from '../lib/clock';
import { createDeviceLog } from '../lib/device-log';
import { parseKioskEnv } from '../lib/env';
import { createMemoryStore } from '../lib/storage';
import {
  CREDENTIAL,
  createManualTransport,
  servingFixture,
  snapshot,
  type ManualTransport,
} from './fixtures';

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

/** Tamil, per EN-018 §3.4.1 — English plus one Indian language. */
const TAMIL_BOARD: BoardAudio = { enabled: true, locales: ['ta'], repeatCount: 1 };

/**
 * A speaker that records what it was asked to say.
 *
 * `autoFinish: false` leaves the call open, which is what a real synthesiser
 * does for the several seconds a two-language announcement takes — the state the
 * on-screen half of the announcement is visible in.
 */
function recordingSpeaker(autoFinish = true) {
  const calls: SpeakRequest[] = [];
  const pending: SpeakHandlers[] = [];
  let cancels = 0;
  const speaker: Speaker = {
    available: true,
    speak(request: SpeakRequest, handlers: SpeakHandlers) {
      calls.push(request);
      for (const utterance of request.utterances) handlers.onUtterance(utterance);
      if (autoFinish) {
        handlers.onFinished();
        return;
      }
      pending.push(handlers);
    },
    cancel() {
      cancels += 1;
    },
  };
  return {
    speaker,
    calls,
    cancels: () => cancels,
    finishLast: (): void => {
      pending.pop()?.onFinished();
    },
    spokenLocales: (): string[][] => calls.map((call) => call.utterances.map((u: Utterance) => u.localeCode)),
  };
}

interface Mounted {
  readonly manual: ManualTransport;
  readonly clock: ReturnType<typeof createFixedClock>;
  readonly heard: ReturnType<typeof recordingSpeaker>;
  readonly unmount: () => void;
}

function mountBoard(audio: BoardAudio | null = null, autoFinish = true): Mounted {
  const clock = createFixedClock(new Date('2026-08-19T14:07:02.000Z'));
  const manual = createManualTransport('polling');
  const heard = recordingSpeaker(autoFinish);
  const storage = createMemoryStore(new Map([[DEVICE_CREDENTIAL_KEY, JSON.stringify(CREDENTIAL)]]));
  const overrides: Partial<RuntimeConfig> = {
    clock,
    env: ENV,
    storage,
    log: createDeviceLog(() => clock.now()),
    pairingClient: NEVER_PAIRS,
    createTransport: () => manual.transport,
    speaker: heard.speaker,
    announceAudio: audio,
  };

  const view = render(
    <RuntimeConfigProvider overrides={overrides}>
      <DisplayRuntime />
    </RuntimeConfigProvider>,
  );

  return { manual, clock, heard, unmount: view.unmount };
}

const CALLED_AT = '2026-08-19T14:06:50.000Z';

function board(overrides: Parameters<typeof snapshot>[0] = {}) {
  return {
    ...snapshot(overrides),
    nowServing: [servingFixture({ status: 'called', calledAt: CALLED_AT })],
  };
}

describe('the board calls a token', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** `phase-01` exit gate 4: "audio in English + one Indian language". */
  it('speaks the token in English and in the hospital language', () => {
    const { manual, clock, heard } = mountBoard();

    act(() => {
      manual.emit({ ...board(), audio: TAMIL_BOARD }, clock.now());
    });

    expect(heard.spokenLocales()).toEqual([['en-IN', 'ta']]);
    const spoken = heard.calls[0]?.utterances ?? [];
    expect(spoken[0]?.text).toContain('C, 45');
    expect(spoken[0]?.text).toContain('Room 3');
    expect(spoken[1]?.bcp47).toContain('ta');
  });

  /** EN-018 §3.4.4 / RPwD Act: the announcement is visible as well as audible. */
  it('shows the announcement on screen for the length of the call', () => {
    const { manual, clock, heard } = mountBoard(null, false);

    act(() => {
      manual.emit({ ...board(), audio: TAMIL_BOARD }, clock.now());
    });

    const banner = screen.getByTestId('announcement-banner');
    expect(banner).toHaveAttribute('data-token', 'C-45');
    expect(banner).toHaveTextContent('Room 3');
    expect(banner).toHaveAttribute('aria-live', 'assertive');
    // The sentence being spoken is on screen too, tagged with its language so a
    // screen reader and the font stack both get it right.
    expect(screen.getByTestId('announcement-text')).toHaveAttribute('lang');

    act(() => {
      heard.finishLast();
    });
    expect(screen.queryByTestId('announcement-banner')).not.toBeInTheDocument();
  });

  it('announces once, however many times the poller re-delivers the snapshot', () => {
    const { manual, clock, heard } = mountBoard();
    const same = { ...board(), audio: TAMIL_BOARD };

    act(() => {
      manual.emit(same, clock.now());
    });
    act(() => {
      manual.emit({ ...same, version: 2 }, clock.now());
    });
    act(() => {
      manual.emit({ ...same, version: 3 }, clock.now());
    });

    expect(heard.calls).toHaveLength(1);
  });

  it('announces again when the same token is recalled', () => {
    const { manual, clock, heard } = mountBoard();
    const first = { ...board(), audio: TAMIL_BOARD };

    act(() => {
      manual.emit(first, clock.now());
    });

    act(() => {
      manual.emit(
        {
          ...first,
          version: 2,
          nowServing: [servingFixture({ status: 'recalled', calledAt: '2026-08-19T14:06:58.000Z' })],
        },
        clock.now(),
      );
    });

    expect(heard.calls).toHaveLength(2);
  });

  it('stays silent when the board was never configured for audio', () => {
    const { manual, clock, heard } = mountBoard();

    act(() => {
      manual.emit(board(), clock.now());
    });

    expect(heard.calls).toEqual([]);
    expect(screen.queryByTestId('announcement-banner')).not.toBeInTheDocument();
  });

  it('takes its language from the device when the snapshot has no audio block', () => {
    const { manual, clock, heard } = mountBoard({ enabled: true, locales: ['hi'], repeatCount: 1 });

    act(() => {
      manual.emit(board(), clock.now());
    });

    expect(heard.spokenLocales()).toEqual([['en-IN', 'hi']]);
  });

  it('stops talking when the board is torn down', () => {
    const { manual, clock, heard, unmount } = mountBoard();

    act(() => {
      manual.emit({ ...board(), audio: TAMIL_BOARD }, clock.now());
    });
    act(() => {
      unmount();
    });

    expect(heard.cancels()).toBeGreaterThanOrEqual(1);
  });
});

/**
 * EN-018 §5, stated as a test rather than as a comment.
 *
 * A waiting area is a public place, so the board carries a token, a room and a
 * clinician and nothing that identifies the patient. The control is at the
 * schema boundary, not in each component: an API that starts sending a name has
 * it dropped on parse, so no component has to remember not to render it.
 */
describe('no patient identifier reaches a public board', () => {
  it('drops patient fields the API should never have sent', () => {
    const leaky = {
      ...board(),
      nowServing: [
        {
          ...servingFixture({ status: 'called', calledAt: CALLED_AT }),
          patientName: 'Asha Rao',
          uhid: 'VH-000123',
          patientId: '01a02826-6b28-7d45-ad1f-1b5995fc42eb',
          mobile: '9845012345',
        },
      ],
    };

    const parsed = BoardSnapshotSchema.parse(leaky);
    const first = parsed.nowServing[0];
    expect(first).toBeDefined();
    expect(Object.keys(first ?? {})).toEqual([
      'id',
      'tokenDisplay',
      'status',
      'roomLabel',
      'counterLabel',
      'doctorName',
      'doctorSpeciality',
      'calledAt',
    ]);
    expect(JSON.stringify(parsed)).not.toContain('Asha Rao');
    expect(JSON.stringify(parsed)).not.toContain('VH-000123');
    expect(JSON.stringify(parsed)).not.toContain('9845012345');
  });

  it('renders and announces none of it, even when handed a leaky snapshot', () => {
    const { manual, clock, heard } = mountBoard();

    act(() => {
      manual.emit(
        BoardSnapshotSchema.parse({
          ...board(),
          audio: TAMIL_BOARD,
          nowServing: [
            {
              ...servingFixture({ status: 'called', calledAt: CALLED_AT }),
              patientName: 'Asha Rao',
              uhid: 'VH-000123',
            },
          ],
        }),
        clock.now(),
      );
    });

    expect(screen.queryByText(/Asha Rao/)).not.toBeInTheDocument();
    expect(screen.queryByText(/VH-000123/)).not.toBeInTheDocument();
    for (const call of heard.calls) {
      for (const utterance of call.utterances) {
        expect(utterance.text).not.toContain('Asha');
        expect(utterance.text).not.toContain('VH-000123');
      }
    }
  });
});
