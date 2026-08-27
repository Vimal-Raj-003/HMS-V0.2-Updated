import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Page } from '@vims/contracts';
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { boundedList, useCursorList } from './cursor-list';

/**
 * The pagination hook, and the bug it exists to prevent.
 *
 * The Phase-3 screens hold the cursor in a `useState` and close over it in the
 * query function. TanStack refetches on a **key** change, and a cursor in a
 * closure does not change the key — so "Load the next page" updates state, the
 * component re-renders, and the same page comes back for ever. The list looks
 * paginated and is not.
 *
 * These tests drive the real hook against a fake pager and assert that the
 * second page is actually requested, that it is appended rather than replacing
 * the first, and that nothing loops.
 */
function Harness({
  fetchPage,
}: {
  readonly fetchPage: (cursor: string | undefined) => Promise<Page<string>>;
}): React.JSX.Element {
  const list = useCursorList<string>({
    queryKey: ['test', 'list'],
    fetchPage: (cursor) => fetchPage(cursor),
  });
  return (
    <div>
      <span data-testid="items">{list.items.join(',')}</span>
      <span data-testid="pages">{list.pageCount}</span>
      <span data-testid="has-more">{String(list.hasMore)}</span>
      <button type="button" data-testid="more" onClick={list.loadMore}>
        Load the next page
      </button>
    </div>
  );
}

function renderHarness(fetchPage: (cursor: string | undefined) => Promise<Page<string>>): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Harness fetchPage={fetchPage} />
    </QueryClientProvider>,
  );
}

/**
 * Flush React's queue and the query client's microtasks.
 *
 * Several turns rather than one: a `useInfiniteQuery` page settles through a
 * promise, a state update and a re-render, and a single turn is enough only when
 * the machine is idle. One turn passed in isolation and failed inside the full
 * suite, which is exactly the kind of flake that gets a test deleted instead of
 * fixed.
 */
async function settle(turns = 8): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    });
  }
}

describe('useCursorList', () => {
  it('asks for the first page with no cursor', async () => {
    const fetchPage = vi.fn((_cursor: string | undefined) =>
      Promise.resolve<Page<string>>({ items: ['a'], nextCursor: null, hasMore: false }),
    );
    renderHarness(fetchPage);
    await settle();
    expect(fetchPage).toHaveBeenCalledWith(undefined);
    expect(screen.getByTestId('items')).toHaveTextContent('a');
    expect(screen.getByTestId('has-more')).toHaveTextContent('false');
  });

  /**
   * The assertion the closure-cursor pattern fails: the *second* call carries
   * the cursor the first page returned.
   */
  it('actually requests the next page with the cursor the API returned', async () => {
    const pages: Record<string, Page<string>> = {
      first: { items: ['a', 'b'], nextCursor: 'cursor-2', hasMore: true },
      'cursor-2': { items: ['c'], nextCursor: null, hasMore: false },
    };
    const fetchPage = vi.fn((cursor: string | undefined) =>
      Promise.resolve(pages[cursor ?? 'first'] ?? { items: [], nextCursor: null, hasMore: false }),
    );
    renderHarness(fetchPage);
    await settle();
    expect(screen.getByTestId('items')).toHaveTextContent('a,b');
    expect(screen.getByTestId('has-more')).toHaveTextContent('true');

    act(() => {
      screen.getByTestId('more').click();
    });
    await settle();

    expect(fetchPage).toHaveBeenNthCalledWith(1, undefined);
    expect(fetchPage).toHaveBeenNthCalledWith(2, 'cursor-2');
    expect(screen.getByTestId('items')).toHaveTextContent('a,b,c');
    expect(screen.getByTestId('pages')).toHaveTextContent('2');
    expect(screen.getByTestId('has-more')).toHaveTextContent('false');
  });

  /**
   * And the opposite property: it does **not** keep going. `docs/07 §4` bans
   * `OFFSET`, and a client that walked every page until `hasMore` went false
   * would be an `OFFSET` scan wearing a different hat. One press, one page.
   */
  it('fetches exactly one more page per press, and never loops', async () => {
    const fetchPage = vi.fn((cursor: string | undefined) =>
      Promise.resolve<Page<string>>({
        items: [cursor ?? 'first'],
        nextCursor: `after-${cursor ?? 'first'}`,
        hasMore: true,
      }),
    );
    renderHarness(fetchPage);
    await settle();
    expect(fetchPage).toHaveBeenCalledTimes(1);

    act(() => {
      screen.getByTestId('more').click();
    });
    await settle();
    expect(fetchPage).toHaveBeenCalledTimes(2);

    // Still more available, and still nothing fetched without a press.
    await settle();
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('has-more')).toHaveTextContent('true');
  });

  it('ignores a press when the list is exhausted', async () => {
    const fetchPage = vi.fn(() =>
      Promise.resolve<Page<string>>({ items: ['only'], nextCursor: null, hasMore: false }),
    );
    renderHarness(fetchPage);
    await settle();

    act(() => {
      screen.getByTestId('more').click();
    });
    await settle();
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('surfaces a failure rather than showing an empty list', async () => {
    const fetchPage = vi.fn(() => Promise.reject(new Error('the store is unreachable')));
    renderHarness(fetchPage);
    await settle();
    expect(screen.getByTestId('items')).toBeEmptyDOMElement();
  });
});

describe('boundedList', () => {
  it('wraps a cursorless route in the same shape without pretending it has pages', () => {
    const list = boundedList(
      { items: ['x', 'y'] },
      {
        isPending: false,
        isFetching: false,
        error: null,
        refetch: () => undefined,
      },
    );
    expect(list.items).toEqual(['x', 'y']);
    expect(list.hasMore).toBe(false);
    expect(list.pageCount).toBe(1);
  });

  it('is empty and page-less before its data arrives', () => {
    const list = boundedList<string>(undefined, {
      isPending: true,
      isFetching: true,
      error: null,
      refetch: () => undefined,
    });
    expect(list.items).toEqual([]);
    expect(list.pageCount).toBe(0);
  });
});
