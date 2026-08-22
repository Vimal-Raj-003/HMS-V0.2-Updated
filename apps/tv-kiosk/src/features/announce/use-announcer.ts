'use client';

import { useEffect, useRef, useState } from 'react';
import type { BoardSnapshot } from '../board/board-contract';
import type { Freshness } from '../board/staleness';
import { useRuntimeConfig } from '../../runtime/runtime-config';
import { planAnnouncements, type PlannedCall } from './announcement-plan';
import type { Utterance } from './announcement-script';

/**
 * How many call keys are remembered. A busy OPD board sees a few hundred calls
 * in a day; 400 is comfortably more than a day and still a trivial Set. It is
 * bounded at all because a board is expected to run for thirty days without a
 * restart (EN-018 §13), and an unbounded Set is exactly the kind of slow leak
 * that only shows up on week three.
 */
const REMEMBERED_CALLS = 400;

export interface AnnouncerState {
  /** The call being spoken, or null when the board is quiet. */
  readonly call: PlannedCall | null;
  /** The sentence currently being spoken, for the on-screen half. */
  readonly speaking: Utterance | null;
  /** False when there is no speech engine — the screen still announces. */
  readonly audible: boolean;
}

export interface AnnouncerInput {
  readonly snapshot: BoardSnapshot | null;
  readonly freshness: Freshness;
  readonly now: Date;
}

/**
 * Turns snapshots into announcements, exactly once each.
 *
 * The decision of *what* to announce is in `planAnnouncements`, which is pure;
 * everything here is the part that cannot be — remembering what has already been
 * said, and refusing to start a second call over the top of one still being
 * spoken. Overlapping calls are the failure that matters: two tokens spoken at
 * once in a waiting room is not twice the information, it is none.
 */
export function useAnnouncer(input: AnnouncerInput): AnnouncerState {
  const { speaker, announceAudio } = useRuntimeConfig();
  const [call, setCall] = useState<PlannedCall | null>(null);
  const [speaking, setSpeaking] = useState<Utterance | null>(null);

  const announcedRef = useRef<string[]>([]);
  const busyRef = useRef(false);
  const { snapshot, freshness, now } = input;

  useEffect(() => {
    if (snapshot === null) return;
    if (busyRef.current) return;

    const plan = planAnnouncements({
      snapshot,
      freshness,
      now,
      announced: new Set(announcedRef.current),
      ...(announceAudio === null ? {} : { fallbackAudio: announceAudio }),
    });

    const next = plan[0];
    if (next === undefined) return;

    // Marked before speaking, not after: if the component re-renders mid-call —
    // and it does, every second, because the clock ticks — the same call must
    // not be queued a second time.
    announcedRef.current = [...announcedRef.current, next.key].slice(-REMEMBERED_CALLS);
    busyRef.current = true;
    setCall(next);

    speaker.speak(
      { utterances: next.utterances, repeatCount: next.repeatCount },
      {
        onUtterance: (utterance) => {
          setSpeaking(utterance);
        },
        onFinished: () => {
          busyRef.current = false;
          setSpeaking(null);
          setCall(null);
        },
      },
    );
  }, [snapshot, freshness, now, speaker, announceAudio]);

  // A board that goes dark mid-sentence must not carry on talking to an empty
  // corridor after it is unmounted or re-paired.
  useEffect(
    () => () => {
      speaker.cancel();
    },
    [speaker],
  );

  return { call, speaking, audible: speaker.available };
}
