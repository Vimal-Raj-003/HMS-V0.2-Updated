import type { Utterance } from './announcement-script';

/**
 * One sentence handed to whatever actually makes the sound.
 *
 * `onDone` is called exactly once, whether the sentence finished or failed.
 * That single guarantee is what lets the multi-language chain be a chain at all:
 * a board with no Tamil voice installed must lose the Tamil sentence, not the
 * English one that comes after it.
 */
export interface SpeechRequest {
  readonly text: string;
  /** BCP-47, from `@vims/i18n` — the tag the engine picks a voice by. */
  readonly lang: string;
  readonly volume: number;
  readonly rate: number;
  readonly onDone: () => void;
}

/**
 * The engine, as a structural type rather than as `lib.dom`'s `SpeechSynthesis`.
 *
 * Same reasoning as `BoardSocket` in the socket transport: depending on the
 * shape keeps the whole announcement path drivable from a test with no browser,
 * and keeps the door open for EN-018 §3.4.2's other two engines — a server-side
 * TTS cache and a cloud provider — behind the same interface.
 */
export interface SpeechEngine {
  speak(request: SpeechRequest): void;
  cancel(): void;
}

export interface SpeakRequest {
  readonly utterances: readonly Utterance[];
  readonly repeatCount: number;
}

export interface SpeakHandlers {
  /** Fired as each utterance begins, so the screen can show what is being said. */
  readonly onUtterance: (utterance: Utterance) => void;
  readonly onFinished: () => void;
}

export interface Speaker {
  readonly available: boolean;
  speak(request: SpeakRequest, handlers: SpeakHandlers): void;
  cancel(): void;
}

/**
 * A board that cannot or must not make noise.
 *
 * It still drives `onUtterance`/`onFinished`, because the *visual* half of an
 * announcement is not optional: EN-018 §3.4.4 requires every announcement to be
 * simultaneously visible and audible for deaf and hard-of-hearing patients
 * (RPwD Act), and a muted board in a ward corridor is the common case, not the
 * exception. Silence must not also mean nothing on screen.
 */
export const silentSpeaker: Speaker = {
  available: false,
  speak(request, handlers) {
    for (const utterance of request.utterances) handlers.onUtterance(utterance);
    handlers.onFinished();
  },
  cancel() {
    // Nothing is in flight.
  },
};

export interface SpeechSpeakerOptions {
  readonly engine: SpeechEngine;
  readonly volume?: number;
  /** Slightly under natural pace: a corridor is reverberant. */
  readonly rate?: number;
}

/**
 * Speaks a call, one language after another, in order.
 *
 * Sequential and not parallel for the obvious reason, and chained on completion
 * rather than on a timer because "Token C 45, please proceed to Room 3" differs
 * in length by nearly a factor of two between English and Malayalam — a timer
 * would either clip the second language or leave dead air after it.
 */
export function createSpeechSpeaker(options: SpeechSpeakerOptions): Speaker {
  let generation = 0;

  return {
    available: true,

    speak(request, handlers) {
      generation += 1;
      const mine = generation;

      // EN-018 §3.4.3 allows a repeat for large halls. The sequence repeated is
      // the whole multi-language script, not each language in turn: "C 45, Room
      // 3" in English then Tamil then English then Tamil, so somebody who
      // arrives mid-call still hears a complete instruction in their language.
      const queue: Utterance[] = [];
      for (let round = 0; round < Math.max(1, request.repeatCount); round += 1) {
        queue.push(...request.utterances);
      }

      let index = 0;
      const next = (): void => {
        // A newer call, or a cancel, has superseded this one.
        if (mine !== generation) return;

        const current = queue[index];
        index += 1;
        if (current === undefined) {
          handlers.onFinished();
          return;
        }

        handlers.onUtterance(current);
        options.engine.speak({
          text: current.text,
          lang: current.bcp47,
          volume: options.volume ?? 1,
          rate: options.rate ?? 0.95,
          onDone: next,
        });
      };

      next();
    },

    cancel() {
      generation += 1;
      options.engine.cancel();
    },
  };
}

/**
 * The browser engine, or `null` where there is none.
 *
 * Returns `null` rather than throwing: a Raspberry Pi kiosk build of Chromium
 * often ships without speech synthesis, and that board must still render its
 * tokens. The caller substitutes `silentSpeaker` and the on-screen announcement
 * carries on.
 */
export function browserSpeechEngine(): SpeechEngine | null {
  if (typeof window === 'undefined') return null;
  const synth: SpeechSynthesis | undefined = window.speechSynthesis;
  if (synth === undefined) return null;
  if (typeof window.SpeechSynthesisUtterance !== 'function') return null;

  return {
    speak(request: SpeechRequest): void {
      const utterance = new window.SpeechSynthesisUtterance(request.text);
      utterance.lang = request.lang;
      utterance.volume = request.volume;
      utterance.rate = request.rate;

      // `end` and `error` can both arrive for one utterance on some engines, and
      // a chain advanced twice skips a language.
      let settled = false;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        request.onDone();
      };
      utterance.onend = settle;
      utterance.onerror = settle;

      synth.speak(utterance);
    },
    cancel(): void {
      synth.cancel();
    },
  };
}
