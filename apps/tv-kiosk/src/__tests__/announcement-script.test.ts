import { describe, expect, it } from 'vitest';
import {
  buildAnnouncement,
  destinationOf,
  hasApprovedPhrase,
  resolveAnnouncementLocales,
  speakableToken,
} from '../features/announce/announcement-script';
import { servingFixture } from './fixtures';

describe('resolveAnnouncementLocales', () => {
  it('always speaks English first, whatever the board was configured with', () => {
    expect(resolveAnnouncementLocales(['ta'])).toEqual(['en-IN', 'ta']);
  });

  it('does not repeat English when it was configured explicitly', () => {
    expect(resolveAnnouncementLocales(['en-IN', 'hi'])).toEqual(['en-IN', 'hi']);
  });

  it('drops a code that is not a locale rather than falling silent', () => {
    expect(resolveAnnouncementLocales(['tamil', 'ta'])).toEqual(['en-IN', 'ta']);
  });

  it('caps at three, per EN-018 §3.4.1', () => {
    expect(resolveAnnouncementLocales(['hi', 'ta', 'te', 'ml'])).toEqual(['en-IN', 'hi', 'ta']);
  });

  it('still speaks English when nothing was configured at all', () => {
    expect(resolveAnnouncementLocales([])).toEqual(['en-IN']);
  });
});

describe('buildAnnouncement', () => {
  it('speaks English then the hospital language, each with its own voice tag', () => {
    const utterances = buildAnnouncement({
      tokenDisplay: 'C-45',
      destination: 'Room 3',
      locales: ['en-IN', 'ta'],
    });

    expect(utterances).toHaveLength(2);
    expect(utterances[0]?.localeCode).toBe('en-IN');
    expect(utterances[0]?.text).toBe('Token C, 45, please proceed to Room 3.');
    expect(utterances[1]?.localeCode).toBe('ta');
    // The voice tag, not the locale key: `ta` alone gets Tamil read by an
    // English voice on most engines.
    expect(utterances[1]?.bcp47).toContain('ta');
    expect(utterances[1]?.text).toContain('C, 45');
    expect(utterances[1]?.text).toContain('Room 3');
  });

  it('carries the token and the destination and nothing else', () => {
    const utterances = buildAnnouncement({
      tokenDisplay: 'C-45',
      destination: 'Room 3',
      locales: ['en-IN'],
    });

    // EN-018 §5: a public-area board announces a token, never a person. There is
    // no input field that could carry a name, and this pins the output too.
    expect(utterances[0]?.text).toBe('Token C, 45, please proceed to Room 3.');
  });

  it('falls back to English for a locale with no approved phrasing, and says it once', () => {
    // `gu` is an enabled locale (D-13) but EN-018 §3.4.1 does not list it for
    // announcements. Reading an English sentence with a Gujarati voice would be
    // worse than English, so it collapses into the English utterance.
    expect(hasApprovedPhrase('gu')).toBe(false);
    const utterances = buildAnnouncement({
      tokenDisplay: 'A-1',
      destination: 'Counter 2',
      locales: ['en-IN', 'gu'],
    });
    expect(utterances).toHaveLength(1);
    expect(utterances[0]?.localeCode).toBe('en-IN');
  });

  it('has an approved phrase for each of the eight languages EN-018 §3.4.1 names', () => {
    for (const locale of ['en-IN', 'hi', 'ta', 'te', 'ml', 'kn', 'mr', 'bn'] as const) {
      expect(hasApprovedPhrase(locale), locale).toBe(true);
    }
  });

  it('sends a patient to reception rather than announcing a token with nowhere to go', () => {
    const utterances = buildAnnouncement({ tokenDisplay: 'A-1', destination: '', locales: ['en-IN'] });
    expect(utterances[0]?.text).toContain('reception');
  });
});

describe('speakableToken', () => {
  it('turns separators into pauses so "C-45" is not read as "C minus 45"', () => {
    expect(speakableToken('C-45')).toBe('C, 45');
    expect(speakableToken('OP/2026/117')).toBe('OP, 2026, 117');
  });

  it('leaves a plain token alone', () => {
    expect(speakableToken('45')).toBe('45');
  });
});

describe('destinationOf', () => {
  it('prefers the room, which is the instruction on a clinical board', () => {
    expect(destinationOf(servingFixture({ roomLabel: 'Room 3', counterLabel: 'Counter 2' }))).toBe('Room 3');
  });

  it('falls back to the counter, which is the instruction on a cash board', () => {
    expect(destinationOf(servingFixture({ roomLabel: '  ', counterLabel: 'Counter 2' }))).toBe('Counter 2');
  });
});
