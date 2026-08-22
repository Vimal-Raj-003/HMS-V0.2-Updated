import type { NoteDraft } from './note';

/**
 * OP-019 §3 — the doctor PWA's offline half: a **labelled** cache of what was
 * last seen, and an outbox for a draft note written with no network.
 *
 * ## Why this is not the service worker
 *
 * `apps/web/src/app/sw.ts` marks every `/api/` route `NetworkOnly`, and the
 * comment above that rule is right: *"Serving a cached clinical response is
 * worse than serving nothing, because nothing is obviously nothing and stale
 * data is indistinguishable from fresh."* A transparent HTTP cache would make an
 * hour-old allergy list look exactly like a live one to every screen in the app,
 * including the prescribing screen whose hard stop is computed from it.
 *
 * **`sw.ts` is therefore unchanged by this work** — it is also outside this
 * change's boundary. What is added instead is an *explicit* cache that the
 * clinical screens read only when the network has already failed, that stamps
 * every entry with the instant it was captured, and that the UI renders behind a
 * visible "last seen at …" badge in a read-only state. The difference is not
 * cosmetic: with this design there is no code path on which a screen shows stale
 * clinical data believing it to be current.
 *
 * ## What is stored, and where
 *
 * `localStorage`, not IndexedDB: the payloads are one patient's summary and one
 * draft note, both small, and `localStorage` is synchronous, which makes the
 * offline path testable without a fake IndexedDB and makes a write survive a tab
 * that is closed mid-save.
 *
 * Every key is namespaced by **hospital and user**. A shared tablet is the norm
 * in an OPD, and one clinician's cached chart must not be readable from the next
 * clinician's session by a screen that forgot to check. `clearCache` is exported
 * for a sign-out hook to call; `src/lib` is outside this change's boundary, so
 * wiring it there is a follow-up, and until then the namespace is what keeps the
 * two sessions apart.
 *
 * This is patient data at rest on a device. It is bounded (`CACHE_LIMIT`
 * entries), it is namespaced, and it is capped in age by `MAX_AGE_MS` — beyond
 * which an entry is discarded rather than shown. A hospital that forbids any
 * local clinical cache turns the feature off with the `mobile.sync` permission,
 * which is what gates the offline surface in the screens.
 */

const PREFIX = 'vims.clinical';
const CACHE_LIMIT = 24;

/** Beyond this an entry is dropped rather than offered. A day-old chart is not a chart. */
export const MAX_AGE_MS = 12 * 60 * 60 * 1000;

export interface CacheScope {
  readonly hospitalId: string;
  readonly userId: string;
}

export interface CachedEntry<T> {
  readonly value: T;
  /** ISO instant at which this was captured from the network. Always rendered. */
  readonly capturedAt: string;
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage;
  } catch {
    // Safari in private mode, or a locked-down kiosk profile. An unavailable
    // cache is a missing feature, never an error a clinician has to read.
    return null;
  }
}

function keyFor(scope: CacheScope, name: string): string {
  return `${PREFIX}.${scope.hospitalId}.${scope.userId}.${name}`;
}

export function writeCache<T>(scope: CacheScope, name: string, value: T, now: Date): void {
  const store = storage();
  if (store === null) return;
  const entry: CachedEntry<T> = { value, capturedAt: now.toISOString() };
  try {
    store.setItem(keyFor(scope, name), JSON.stringify(entry));
    pruneCache(scope);
  } catch {
    // A full quota must never break the online path, which is the one that
    // matters. The next read simply finds nothing cached.
  }
}

export function readCache<T>(scope: CacheScope, name: string, now: Date): CachedEntry<T> | null {
  const store = storage();
  if (store === null) return null;
  const raw = store.getItem(keyFor(scope, name));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as CachedEntry<T>;
    if (typeof parsed.capturedAt !== 'string') return null;
    const age = now.getTime() - new Date(parsed.capturedAt).getTime();
    if (!Number.isFinite(age) || age > MAX_AGE_MS) {
      store.removeItem(keyFor(scope, name));
      return null;
    }
    return parsed;
  } catch {
    store.removeItem(keyFor(scope, name));
    return null;
  }
}

function ownedKeys(scope: CacheScope): readonly string[] {
  const store = storage();
  if (store === null) return [];
  const prefix = `${PREFIX}.${scope.hospitalId}.${scope.userId}.`;
  const keys: string[] = [];
  for (let index = 0; index < store.length; index += 1) {
    const key = store.key(index);
    if (key !== null && key.startsWith(prefix)) keys.push(key);
  }
  return keys;
}

/** Oldest-first eviction, so a long clinic does not grow the cache without bound. */
function pruneCache(scope: CacheScope): void {
  const store = storage();
  if (store === null) return;
  const keys = ownedKeys(scope).filter((key) => !key.endsWith(OUTBOX));
  if (keys.length <= CACHE_LIMIT) return;

  const dated = keys.map((key) => {
    const raw = store.getItem(key);
    let capturedAt = '';
    try {
      capturedAt = raw === null ? '' : ((JSON.parse(raw) as CachedEntry<unknown>).capturedAt ?? '');
    } catch {
      capturedAt = '';
    }
    return { key, capturedAt };
  });
  dated.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  for (const entry of dated.slice(0, dated.length - CACHE_LIMIT)) store.removeItem(entry.key);
}

export function clearCache(scope: CacheScope): void {
  const store = storage();
  if (store === null) return;
  for (const key of ownedKeys(scope)) store.removeItem(key);
}

// ── the draft outbox ─────────────────────────────────────────────────────────

const OUTBOX = 'outbox';

/**
 * A note written offline, waiting for a network.
 *
 * `baseVersion` is the encounter version the draft was written against. It
 * travels with the draft because the conflict rule is the server's optimistic
 * lock, and a draft that syncs by *dropping* its version would overwrite
 * whatever the doctor did on another device in the meantime — the exact silent
 * loss OP-019 §3.6 forbids. On a conflict the entry is kept, not discarded, and
 * the screen shows both versions.
 */
export interface QueuedDraft {
  readonly id: string;
  readonly encounterId: string;
  readonly patientId: string;
  readonly draft: NoteDraft;
  readonly baseVersion: number;
  readonly queuedAt: string;
  /** Set when a sync attempt was refused; the entry stays queued and visible. */
  readonly lastError?: string;
}

function isQueuedDraft(value: unknown): value is QueuedDraft {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<QueuedDraft>;
  return (
    typeof candidate.encounterId === 'string' &&
    typeof candidate.baseVersion === 'number' &&
    typeof candidate.queuedAt === 'string' &&
    typeof candidate.draft === 'object' &&
    candidate.draft !== null
  );
}

export function readOutbox(scope: CacheScope): readonly QueuedDraft[] {
  const store = storage();
  if (store === null) return [];
  const raw = store.getItem(keyFor(scope, OUTBOX));
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Narrowed rather than cast. A corrupted or half-written entry is dropped,
    // because an outbox entry with no encounter id would sync into nowhere and
    // look like a note that saved.
    return parsed.filter((entry): entry is QueuedDraft => isQueuedDraft(entry));
  } catch {
    return [];
  }
}

function writeOutbox(scope: CacheScope, entries: readonly QueuedDraft[]): void {
  const store = storage();
  if (store === null) return;
  try {
    store.setItem(keyFor(scope, OUTBOX), JSON.stringify(entries));
  } catch {
    // See `writeCache`: a full quota must not break the working path.
  }
}

/**
 * Queue a draft, replacing any earlier draft for the same encounter.
 *
 * Replacing rather than appending is deliberate: the queue holds *the note*, not
 * a keystroke log, and replaying three stale versions of the same note on
 * reconnect would produce two pointless conflicts before the current text lands.
 * The kept entry always carries the **earliest** `baseVersion` seen for that
 * encounter, because that is the version the doctor's edits actually started
 * from.
 */
export function queueDraft(scope: CacheScope, entry: QueuedDraft): readonly QueuedDraft[] {
  const existing = readOutbox(scope);
  const previous = existing.find((queued) => queued.encounterId === entry.encounterId);
  const merged: QueuedDraft = {
    ...entry,
    baseVersion:
      previous === undefined ? entry.baseVersion : Math.min(previous.baseVersion, entry.baseVersion),
  };
  const next = [...existing.filter((queued) => queued.encounterId !== entry.encounterId), merged];
  writeOutbox(scope, next);
  return next;
}

export function removeFromOutbox(scope: CacheScope, encounterId: string): readonly QueuedDraft[] {
  const next = readOutbox(scope).filter((queued) => queued.encounterId !== encounterId);
  writeOutbox(scope, next);
  return next;
}

/** Records why a sync failed **without** dropping the draft. */
export function markOutboxError(
  scope: CacheScope,
  encounterId: string,
  message: string,
): readonly QueuedDraft[] {
  const next = readOutbox(scope).map((queued) =>
    queued.encounterId === encounterId ? { ...queued, lastError: message } : queued,
  );
  writeOutbox(scope, next);
  return next;
}

/** How stale a cached entry is, in words a clinician can act on. */
export function stalenessLabel(capturedAt: string, now: Date): string {
  const ms = now.getTime() - new Date(capturedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'captured at an unknown time';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'captured less than a minute ago';
  if (minutes < 60) return `captured ${String(minutes)} min ago`;
  const hours = Math.floor(minutes / 60);
  return `captured ${String(hours)} h ${String(minutes % 60)} min ago`;
}
