import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_DRAFT } from './note';
import {
  clearCache,
  markOutboxError,
  MAX_AGE_MS,
  queueDraft,
  readCache,
  readOutbox,
  removeFromOutbox,
  stalenessLabel,
  writeCache,
  type CacheScope,
} from './offline';

/**
 * OP-019 §3 — the offline copy and the draft outbox.
 *
 * The two properties that matter clinically:
 *
 *  - **a cached chart is always labelled and never immortal.** An entry beyond
 *    `MAX_AGE_MS` is discarded rather than shown, because a day-old chart shown
 *    as a chart is worse than no chart;
 *  - **a queued note is never lost and never silently overwritten.** A refused
 *    sync keeps the entry and records why.
 */

const alice: CacheScope = { hospitalId: 'h1', userId: 'u-alice' };
const bob: CacheScope = { hospitalId: 'h1', userId: 'u-bob' };
const otherHospital: CacheScope = { hospitalId: 'h2', userId: 'u-alice' };

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe('the offline copy', () => {
  it('stamps what it stores with when it was captured', () => {
    const now = new Date('2026-08-22T09:00:00.000Z');
    writeCache(alice, 'encounter.e1', { id: 'e1' }, now);
    const entry = readCache<{ id: string }>(alice, 'encounter.e1', now);
    expect(entry?.value.id).toBe('e1');
    expect(entry?.capturedAt).toBe('2026-08-22T09:00:00.000Z');
  });

  it('discards an entry that has gone stale rather than serving it', () => {
    const captured = new Date('2026-08-22T09:00:00.000Z');
    writeCache(alice, 'encounter.e1', { id: 'e1' }, captured);
    const muchLater = new Date(captured.getTime() + MAX_AGE_MS + 1000);
    expect(readCache(alice, 'encounter.e1', muchLater)).toBeNull();
  });

  it('never serves one clinician’s cached chart to the next one on the same tablet', () => {
    const now = new Date();
    writeCache(alice, 'encounter.e1', { id: 'e1' }, now);
    expect(readCache(bob, 'encounter.e1', now)).toBeNull();
  });

  it('never serves one hospital’s cached chart in another tenant', () => {
    const now = new Date();
    writeCache(alice, 'encounter.e1', { id: 'e1' }, now);
    expect(readCache(otherHospital, 'encounter.e1', now)).toBeNull();
  });

  it('drops a corrupted entry rather than throwing on it', () => {
    window.localStorage.setItem('vims.clinical.h1.u-alice.encounter.e1', '{not json');
    expect(readCache(alice, 'encounter.e1', new Date())).toBeNull();
  });

  it('clears everything it owns and nothing it does not', () => {
    const now = new Date();
    writeCache(alice, 'encounter.e1', { id: 'e1' }, now);
    writeCache(bob, 'encounter.e2', { id: 'e2' }, now);
    clearCache(alice);
    expect(readCache(alice, 'encounter.e1', now)).toBeNull();
    expect(readCache(bob, 'encounter.e2', now)).not.toBeNull();
  });
});

describe('the draft outbox', () => {
  const draft = { ...EMPTY_DRAFT, plan: 'Amoxicillin 500 mg TDS' };

  it('holds a note written with no network', () => {
    queueDraft(alice, {
      id: 'q1',
      encounterId: 'e1',
      patientId: 'p1',
      draft,
      baseVersion: 4,
      queuedAt: '2026-08-22T09:00:00.000Z',
    });
    expect(readOutbox(alice)).toHaveLength(1);
    expect(readOutbox(alice)[0]?.draft.plan).toBe('Amoxicillin 500 mg TDS');
  });

  it('replaces an earlier draft for the same consultation rather than stacking them', () => {
    const base = {
      id: 'q1',
      encounterId: 'e1',
      patientId: 'p1',
      draft,
      baseVersion: 4,
      queuedAt: '2026-08-22T09:00:00.000Z',
    };
    queueDraft(alice, base);
    queueDraft(alice, { ...base, id: 'q2', draft: { ...draft, plan: 'Azithromycin' }, baseVersion: 5 });
    const queued = readOutbox(alice);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.draft.plan).toBe('Azithromycin');
  });

  /**
   * The version the doctor's edits actually started from is the earliest one
   * seen offline. Syncing against a later version would let the queued text win
   * over an edit made elsewhere in between — the silent loss OP-019 forbids.
   */
  it('keeps the earliest base version across repeated offline saves', () => {
    const base = {
      id: 'q1',
      encounterId: 'e1',
      patientId: 'p1',
      draft,
      baseVersion: 4,
      queuedAt: '2026-08-22T09:00:00.000Z',
    };
    queueDraft(alice, base);
    queueDraft(alice, { ...base, baseVersion: 9 });
    expect(readOutbox(alice)[0]?.baseVersion).toBe(4);
  });

  it('keeps the draft when a sync is refused, and records why', () => {
    queueDraft(alice, {
      id: 'q1',
      encounterId: 'e1',
      patientId: 'p1',
      draft,
      baseVersion: 4,
      queuedAt: '2026-08-22T09:00:00.000Z',
    });
    markOutboxError(alice, 'e1', 'Someone else saved this record first');
    const queued = readOutbox(alice);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.lastError).toBe('Someone else saved this record first');
  });

  it('removes a draft only once it has actually landed', () => {
    queueDraft(alice, {
      id: 'q1',
      encounterId: 'e1',
      patientId: 'p1',
      draft,
      baseVersion: 4,
      queuedAt: '2026-08-22T09:00:00.000Z',
    });
    removeFromOutbox(alice, 'e1');
    expect(readOutbox(alice)).toHaveLength(0);
  });

  it('ignores a corrupted queue rather than throwing on the doctor’s screen', () => {
    window.localStorage.setItem('vims.clinical.h1.u-alice.outbox', '{not json');
    expect(readOutbox(alice)).toStrictEqual([]);
  });

  it('drops a half-written entry that has no consultation to sync to', () => {
    window.localStorage.setItem('vims.clinical.h1.u-alice.outbox', JSON.stringify([{ nonsense: true }]));
    expect(readOutbox(alice)).toStrictEqual([]);
  });
});

describe('saying how stale something is', () => {
  it('speaks in minutes and hours, not in timestamps', () => {
    const now = new Date('2026-08-22T10:00:00.000Z');
    expect(stalenessLabel('2026-08-22T09:59:30.000Z', now)).toBe('captured less than a minute ago');
    expect(stalenessLabel('2026-08-22T09:30:00.000Z', now)).toBe('captured 30 min ago');
    expect(stalenessLabel('2026-08-22T08:15:00.000Z', now)).toBe('captured 1 h 45 min ago');
  });

  it('admits when it cannot tell', () => {
    expect(stalenessLabel('nonsense', new Date())).toBe('captured at an unknown time');
  });
});
