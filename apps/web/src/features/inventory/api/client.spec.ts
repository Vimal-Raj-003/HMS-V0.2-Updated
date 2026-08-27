import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PAGE_LIMIT,
  approveAdjustment,
  createGrn,
  listAdjustments,
  listCountPlans,
  listExpiring,
  listGrns,
  listInvoices,
  listItems,
  listLedger,
  listPurchaseIndents,
  listPurchaseOrders,
  listRfqs,
  listStock,
  listStoreIndents,
  listStores,
  listTransfers,
  listVendors,
  postGrn,
} from './client';

/**
 * What the inventory client puts on the wire.
 *
 * The property under test is the one that is invisible in the screen and fails
 * silently: **every list is cursor-paginated with a bounded limit**. A list that
 * quietly dropped its `limit` would work in a demo with forty items and melt a
 * store with forty thousand — and `docs/07 §4` bans the `OFFSET` scan that a
 * "load everything" client is, whatever it calls itself.
 */

interface Recorded {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
}

let calls: Recorded[] = [];

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
      calls.push({ url: input, method: init?.method ?? 'GET', headers });
      return Promise.resolve(
        new Response(JSON.stringify({ items: [], nextCursor: null, hasMore: false }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const LISTS: readonly { readonly name: string; readonly run: (cursor?: string) => Promise<unknown> }[] = [
  { name: 'listItems', run: (cursor) => listItems({ cursor }) },
  { name: 'listStores', run: (cursor) => listStores({ cursor }) },
  { name: 'listStock', run: (cursor) => listStock({ cursor }) },
  { name: 'listLedger', run: (cursor) => listLedger({ cursor }) },
  { name: 'listExpiring', run: (cursor) => listExpiring({ cursor }) },
  { name: 'listStoreIndents', run: (cursor) => listStoreIndents({ cursor }) },
  { name: 'listTransfers', run: (cursor) => listTransfers({ cursor }) },
  { name: 'listAdjustments', run: (cursor) => listAdjustments({ cursor }) },
  { name: 'listCountPlans', run: (cursor) => listCountPlans({ cursor }) },
  { name: 'listPurchaseIndents', run: (cursor) => listPurchaseIndents({ cursor }) },
  { name: 'listRfqs', run: (cursor) => listRfqs({ cursor }) },
  { name: 'listPurchaseOrders', run: (cursor) => listPurchaseOrders({ cursor }) },
  { name: 'listGrns', run: (cursor) => listGrns({ cursor }) },
  { name: 'listInvoices', run: (cursor) => listInvoices({ cursor }) },
  { name: 'listVendors', run: (cursor) => listVendors({ cursor }) },
];

describe('every list is server-paginated', () => {
  it('sends a bounded limit on all fifteen lists', async () => {
    for (const list of LISTS) {
      await list.run();
      const url = new URL(lastCall().url, 'https://hms.test');
      expect(url.searchParams.get('limit'), list.name).toBe(String(PAGE_LIMIT));
    }
  });

  it('passes the opaque cursor straight through on all fifteen', async () => {
    for (const list of LISTS) {
      await list.run('opaque-cursor-token');
      const url = new URL(lastCall().url, 'https://hms.test');
      expect(url.searchParams.get('cursor'), list.name).toBe('opaque-cursor-token');
    }
  });

  it('omits an empty cursor rather than sending one', async () => {
    await listItems({ q: '' });
    const url = lastCall().url;
    expect(url).not.toContain('cursor=');
    expect(url).not.toContain('q=');
  });

  it('keeps the page ceiling at the interactive maximum', () => {
    expect(PAGE_LIMIT).toBeLessThanOrEqual(50);
  });
});

describe('every write is idempotent', () => {
  it('sends an Idempotency-Key when a GRN is created', async () => {
    await createGrn({
      vendorId: 'v-1',
      storeId: 's-1',
      lines: [{ itemId: 'i-1', qtyEntered: 10, unitCost: 4.2, batchNo: 'B1', expiryDate: '2027-01-31' }],
    });
    expect(lastCall().headers['idempotency-key']).toMatch(/.+/u);
  });

  /** A retried post is a second delivery that never arrived. */
  it('sends one on the post that turns a receipt into stock', async () => {
    await postGrn('grn-1');
    expect(lastCall().headers['idempotency-key']).toMatch(/.+/u);
    expect(lastCall().method).toBe('POST');
  });

  it('sends one on an approval, which is what moves the stock', async () => {
    await approveAdjustment('adj-1', undefined);
    expect(lastCall().headers['idempotency-key']).toMatch(/.+/u);
  });
});
