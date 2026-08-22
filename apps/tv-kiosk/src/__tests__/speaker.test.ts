import { describe, expect, it } from 'vitest';
import type { Utterance } from '../features/announce/announcement-script';
import {
  createSpeechSpeaker,
  silentSpeaker,
  type SpeechEngine,
  type SpeechRequest,
} from '../features/announce/speaker';

const ENGLISH: Utterance = { localeCode: 'en-IN', bcp47: 'en-IN-u-nu-latn', text: 'Token C, 45.' };
const TAMIL: Utterance = { localeCode: 'ta', bcp47: 'ta-IN-u-nu-latn', text: 'டோக்கன் C, 45.' };

/** A speech engine that never finishes on its own — the test decides when. */
function manualEngine() {
  const spoken: SpeechRequest[] = [];
  let cancels = 0;
  const engine: SpeechEngine = {
    speak(request) {
      spoken.push(request);
    },
    cancel() {
      cancels += 1;
    },
  };
  return {
    engine,
    spoken,
    cancels: () => cancels,
    /** Completes the utterance currently being spoken. */
    finishLast(): void {
      spoken[spoken.length - 1]?.onDone();
    },
  };
}

function collect() {
  const heard: string[] = [];
  let finished = 0;
  return {
    handlers: {
      onUtterance: (u: Utterance) => heard.push(u.localeCode),
      onFinished: () => {
        finished += 1;
      },
    },
    heard,
    finished: () => finished,
  };
}

describe('createSpeechSpeaker', () => {
  it('speaks each language in turn, and only starts the next when the last ends', () => {
    const eng = manualEngine();
    const sink = collect();
    const speaker = createSpeechSpeaker({ engine: eng.engine });

    speaker.speak({ utterances: [ENGLISH, TAMIL], repeatCount: 1 }, sink.handlers);

    // One in flight, not both: two tokens spoken at once is no information.
    expect(eng.spoken).toHaveLength(1);
    expect(eng.spoken[0]?.lang).toBe('en-IN-u-nu-latn');
    expect(sink.finished()).toBe(0);

    eng.finishLast();
    expect(eng.spoken).toHaveLength(2);
    expect(eng.spoken[1]?.lang).toBe('ta-IN-u-nu-latn');

    eng.finishLast();
    expect(sink.heard).toEqual(['en-IN', 'ta']);
    expect(sink.finished()).toBe(1);
  });

  it('repeats the whole script, not each language in turn', () => {
    const eng = manualEngine();
    const sink = collect();
    const speaker = createSpeechSpeaker({ engine: eng.engine });

    speaker.speak({ utterances: [ENGLISH, TAMIL], repeatCount: 2 }, sink.handlers);
    for (let i = 0; i < 4; i += 1) eng.finishLast();

    // Somebody who walks in halfway still hears a complete instruction.
    expect(sink.heard).toEqual(['en-IN', 'ta', 'en-IN', 'ta']);
    expect(sink.finished()).toBe(1);
  });

  it('loses one language to a missing voice, not the rest of the call', () => {
    const eng = manualEngine();
    const sink = collect();
    const speaker = createSpeechSpeaker({ engine: eng.engine });

    speaker.speak({ utterances: [ENGLISH, TAMIL], repeatCount: 1 }, sink.handlers);
    // The engine reports failure the same way it reports completion.
    eng.finishLast();
    expect(eng.spoken).toHaveLength(2);
    eng.finishLast();
    expect(sink.finished()).toBe(1);
  });

  it('stops mid-call when cancelled, and does not report the call as finished', () => {
    const eng = manualEngine();
    const sink = collect();
    const speaker = createSpeechSpeaker({ engine: eng.engine });

    speaker.speak({ utterances: [ENGLISH, TAMIL], repeatCount: 1 }, sink.handlers);
    speaker.cancel();
    eng.finishLast();

    expect(eng.cancels()).toBe(1);
    expect(eng.spoken).toHaveLength(1);
    expect(sink.finished()).toBe(0);
  });

  it('drops a superseded call rather than interleaving it with the new one', () => {
    const eng = manualEngine();
    const sink = collect();
    const speaker = createSpeechSpeaker({ engine: eng.engine });

    speaker.speak({ utterances: [ENGLISH, TAMIL], repeatCount: 1 }, sink.handlers);
    speaker.speak({ utterances: [ENGLISH], repeatCount: 1 }, sink.handlers);

    // The first call's pending completion must not advance the second's queue.
    const stale = eng.spoken[0];
    expect(stale).toBeDefined();
    stale?.onDone();

    expect(sink.heard).toEqual(['en-IN', 'en-IN']);
    expect(sink.finished()).toBe(0);
  });
});

describe('silentSpeaker', () => {
  it('still announces on screen, which the RPwD Act makes non-optional', () => {
    const sink = collect();
    silentSpeaker.speak({ utterances: [ENGLISH, TAMIL], repeatCount: 1 }, sink.handlers);

    expect(sink.heard).toEqual(['en-IN', 'ta']);
    expect(sink.finished()).toBe(1);
    expect(silentSpeaker.available).toBe(false);
  });
});
