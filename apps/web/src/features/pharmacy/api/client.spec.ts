import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PAGE_LIMIT,
  completeDispense,
  listDayCloses,
  listDispenses,
  listPharmacyExpiry,
  listPharmacyStock,
  listRecalls,
  listRegisterEntries,
  listRxQueue,
  markArrived,
  printLabels,
} from './client';

/**
 * What the pharmacy client puts on the wire.
 *
 * Three properties are asserted here rather than reviewed, because each of them
 * is invisible in the screen that consumes it and each fails silently:
 *
 *  1. **every list is cursor-paginated with a bounded limit** — a list that
 *     quietly dropped its `limit` would work in a demo with forty rows and melt
 *     a counter with forty thousand;
 *  2. **no PHI in a query string** — `GET /pharmacy/dispenses` *accepts* a
 *     `patientId` filter and this client refuses to expose it, which is only
 *     enforceable by looking at the URL;
 *  3. **every write carries an `Idempotency-Key`** — the API's interceptor fails
 *     closed without one, so a missing header is a 400 in front of a queue.
 */

interface Recorded {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | null;
}

let calls: Recorded[] = [];

function jsonResponse(): Response {
  return new Response(JSON.stringify({ items: [], nextCursor: null, hasMore: false }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function lastCall(): Recorded {
  const call = calls.at(-1);
  if (call === undefined) throw new Error('no request was made');
  return call;
}

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
        headers[key.toLowerCase()] = value;
      }
      calls.push({
        url: input,
        method: init?.method ?? 'GET',
        headers,
        body: typeof init?.body === 'string' ? init.body : null,
      });
      return Promise.resolve(jsonResponse());
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('every list is server-paginated', () => {
  const lists: readonly { readonly name: string; readonly run: (cursor?: string) => Promise<unknown> }[] = [
    { name: 'listRxQueue', run: (cursor) => listRxQueue({ cursor }) },
    { name: 'listDispenses', run: (cursor) => listDispenses({ cursor }) },
    { name: 'listRecalls', run: (cursor) => listRecalls({ cursor }) },
    { name: 'listRegisterEntries', run: (cursor) => listRegisterEntries({ cursor }) },
    { name: 'listDayCloses', run: (cursor) => listDayCloses({ cursor }) },
    { name: 'listPharmacyExpiry', run: (cursor) => listPharmacyExpiry({ cursor }) },
    { name: 'listPharmacyStock', run: (cursor) => listPharmacyStock({ pharmacyStoreId: 'store-1', cursor }) },
  ];

  it('sends a bounded limit on every list', async () => {
    for (const list of lists) {
      await list.run();
      const url = new URL(lastCall().url, 'https://hms.test');
      expect(url.searchParams.get('limit'), list.name).toBe(String(PAGE_LIMIT));
    }
  });

  it('keeps the page ceiling at or below the interactive maximum', () => {
    expect(PAGE_LIMIT).toBeLessThanOrEqual(50);
  });

  it('passes the opaque cursor straight through on every list', async () => {
    for (const list of lists) {
      await list.run('opaque-cursor-token');
      const url = new URL(lastCall().url, 'https://hms.test');
      expect(url.searchParams.get('cursor'), list.name).toBe('opaque-cursor-token');
    }
  });

  it('omits the cursor on the first page rather than sending an empty one', async () => {
    await listRxQueue({});
    expect(lastCall().url).not.toContain('cursor=');
  });
});

describe('no PHI in a query string', () => {
  /**
   * The API would accept `?patientId=…`. This client does not offer it, and this
   * is the assertion that keeps it that way: a patient's UUID in a URL reaches
   * the browser history, the `Referer` of anything the page loads, and every
   * proxy access log in between (`docs/04 §5`).
   */
  it('sends no patient identifier to the dispense list, even when asked', async () => {
    const filters = { patientId: 'pat-0192f0e2', cursor: undefined } as Parameters<typeof listDispenses>[0];
    await listDispenses(filters);
    const url = lastCall().url;
    expect(url).not.toContain('patientId');
    expect(url).not.toContain('pat-0192f0e2');
  });

  it('sends only coded filters and opaque tokens on the queue', async () => {
    await listRxQueue({ pharmacyStoreId: 'store-1', status: 'pending' });
    const url = new URL(lastCall().url, 'https://hms.test');
    expect([...url.searchParams.keys()].sort()).toEqual(['limit', 'pharmacyStoreId', 'status']);
  });
});

describe('every write is idempotent', () => {
  it('sends an Idempotency-Key on a queue arrival', async () => {
    await markArrived('q-1', 'wristband_scan');
    expect(lastCall().headers['idempotency-key']).toMatch(/.+/u);
    expect(lastCall().method).toBe('POST');
  });

  /**
   * `completeDispense` takes the key as a **required argument** rather than
   * defaulting it, so the screen has to mint one per press and reuse it across
   * retries. A key regenerated on retry is the same thing as no key at all, and
   * here that means the shelf loses two of everything.
   */
  it('makes the completion key the caller’s, so a retry reuses it', async () => {
    await completeDispense('disp-1', { acknowledgements: [] }, 'intent-key-1');
    await completeDispense('disp-1', { acknowledgements: [] }, 'intent-key-1');
    expect(calls.map((call) => call.headers['idempotency-key'])).toEqual(['intent-key-1', 'intent-key-1']);
  });

  it('records the identity method in the body, never in the URL', async () => {
    await markArrived('q-1', 'abha_verified');
    expect(lastCall().url).not.toContain('abha_verified');
    expect(lastCall().body).toContain('abha_verified');
  });
});

describe('the label print (exit gate 2)', () => {
  it('asks for both locales in one request', async () => {
    await printLabels('disp-1', ['en-IN', 'ta']);
    expect(JSON.parse(lastCall().body ?? '{}')).toEqual({ locales: ['en-IN', 'ta'] });
  });
});
