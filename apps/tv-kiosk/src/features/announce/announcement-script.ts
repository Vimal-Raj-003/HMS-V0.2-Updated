import { DEFAULT_LOCALE, getLocaleMeta, isLocaleCode, type LocaleCode } from '@vims/i18n';
import type { NowServing } from '../board/board-contract';

/**
 * What the board says, in which language, with which voice.
 *
 * `bcp47` comes from `@vims/i18n`'s locale registry rather than from the locale
 * code itself, because it is what `SpeechSynthesisUtterance.lang` needs in order
 * to pick a voice. Handing a browser `ta` where it expects `ta-IN` gets Tamil
 * text read aloud by an English voice, which is not an accent problem — it is
 * unintelligible, and the patient it was for keeps waiting.
 */
export interface Utterance {
  readonly localeCode: LocaleCode;
  readonly bcp47: string;
  readonly text: string;
}

/**
 * EN-018 §3.4.1: `"Token {token}, please proceed to {room}"`, per language.
 *
 * The eight languages here are exactly the eight EN-018 §3.4.1 names for token
 * announcements (`en, hi, ta, te, ml, kn, mr, bn`). The locale *superset* in
 * D-13 is larger — `gu, or, pa, ar` are also enabled locales — but no approved
 * announcement phrasing exists for them, and reading a Latin-script English
 * sentence with a Gujarati voice is worse than saying it in English. Those
 * locales therefore fall back to `en-IN`, visibly, rather than being guessed at.
 *
 * These live here and not in `@vims/i18n` deliberately: the catalogues carry
 * screen strings, and a spoken announcement in a public waiting area is content
 * a hospital's own communications policy signs off on. When it is approved it
 * belongs in a `queue.announce` namespace in the catalogues, and this map
 * becomes the fallback.
 */
const PHRASES: Partial<Record<LocaleCode, string>> = {
  'en-IN': 'Token {token}, please proceed to {room}.',
  hi: 'टोकन {token}, कृपया {room} पर जाएँ।',
  ta: 'டோக்கன் {token}, தயவுசெய்து {room} க்குச் செல்லவும்.',
  te: 'టోకెన్ {token}, దయచేసి {room} కు వెళ్లండి.',
  ml: 'ടോക്കൺ {token}, ദയവായി {room} ലേക്ക് പോകുക.',
  kn: 'ಟೋಕನ್ {token}, ದಯವಿಟ್ಟು {room} ಗೆ ಹೋಗಿ.',
  mr: 'टोकन {token}, कृपया {room} कडे जा.',
  bn: 'টোকেন {token}, অনুগ্রহ করে {room} এ যান।',
};

/** Whether this locale has its own approved announcement, or borrows English. */
export function hasApprovedPhrase(locale: LocaleCode): boolean {
  return PHRASES[locale] !== undefined;
}

/**
 * Resolves the configured language list to real locales.
 *
 * Three rules, in order, and each of them exists because of a way a board goes
 * wrong in the field:
 *
 *  - **`en-IN` is always first.** `docs/06` §8 makes it the fallback that can
 *    never be turned off, and a patient who speaks neither the regional language
 *    nor English is better served by two attempts than one.
 *  - **Unknown codes are dropped, not rendered.** A typo in
 *    `display_boards.tts_languages` must not silence the board.
 *  - **At most three**, per EN-018 §3.4.1 — a four-language call takes longer
 *    than the patient takes to reach the room.
 */
export function resolveAnnouncementLocales(configured: readonly string[]): readonly LocaleCode[] {
  const out: LocaleCode[] = [DEFAULT_LOCALE];
  for (const raw of configured) {
    const trimmed = raw.trim();
    if (!isLocaleCode(trimmed)) continue;
    if (out.includes(trimmed)) continue;
    out.push(trimmed);
    if (out.length === 3) break;
  }
  return out;
}

/**
 * How a token identifier should be *said*, as opposed to shown.
 *
 * `C-45` read literally becomes "C dash forty-five" or, on some engines, "C
 * minus forty-five". Separators become pauses instead, so it comes out as
 * "C, 45" — which is what the person listening for their token is expecting.
 */
export function speakableToken(tokenDisplay: string): string {
  return tokenDisplay
    .replace(/[-_/]+/g, ', ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface AnnouncementInput {
  readonly tokenDisplay: string;
  /** Room or counter, already resolved by the caller. Never a patient. */
  readonly destination: string;
  readonly locales: readonly LocaleCode[];
}

/**
 * Builds the spoken script for one call.
 *
 * The two substitutions are the *only* two, and that is the privacy control:
 * there is no branch of this function that can reach a patient name, because
 * the input type has no field that could hold one (EN-018 §5).
 */
export function buildAnnouncement(input: AnnouncementInput): readonly Utterance[] {
  const token = speakableToken(input.tokenDisplay);
  const destination = input.destination.trim();
  const seen = new Set<string>();
  const out: Utterance[] = [];

  for (const locale of input.locales) {
    const template = PHRASES[locale] ?? PHRASES[DEFAULT_LOCALE];
    if (template === undefined) continue;
    const meta = getLocaleMeta(locale);
    const text = template
      .replace('{token}', token)
      .replace('{room}', destination.length > 0 ? destination : 'the reception desk');

    // Deduplicated on the sentence, not on the voice. A locale with no approved
    // phrasing borrowed the English one; saying that same English sentence again
    // in a Gujarati voice is not a second language, it is the same instruction
    // made harder to understand.
    if (seen.has(text)) continue;
    seen.add(text);

    out.push({ localeCode: locale, bcp47: meta.bcp47, text });
  }

  return out;
}

/**
 * Where the board is sending the patient.
 *
 * The room is the instruction ("Room 3"); the counter is the instruction on a
 * cash or registration board ("Counter 2"). One of them is set, and if neither
 * is, the caller says so rather than announcing a token with nowhere to go.
 */
export function destinationOf(entry: NowServing): string {
  const room = entry.roomLabel.trim();
  if (room.length > 0) return room;
  return entry.counterLabel.trim();
}
