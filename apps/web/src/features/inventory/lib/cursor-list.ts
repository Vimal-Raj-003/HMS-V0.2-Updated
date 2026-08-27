'use client';

import type { Page } from '@vims/contracts';
import { useInfiniteQuery } from '@tanstack/react-query';

/**
 * A server-paginated list, and the only way this feature reads one.
 *
 * ── Why a hook rather than `useQuery` with a cursor in a `useState` ─────────
 *
 * That is the shape the Phase-3 screens use, and it has a bug worth naming so it
 * is not copied forward: TanStack refetches on a **key** change, and a cursor
 * held only in a closure does not change the key. The operator presses "Load the
 * next page", the state updates, the component re-renders, the query function
 * closes over a new cursor — and is never called. The list silently stops at
 * page one.
 *
 * `useInfiniteQuery` puts the cursor in `pageParam`, which is part of the query's
 * own identity, so the page that is asked for is the page that arrives.
 *
 * ── Why this is not "load everything" ──────────────────────────────────────
 *
 * `fetchNextPage` is only ever called from a button a person presses. Nothing
 * here loops until `hasMore` goes false, nothing prefetches, and the page size
 * is the client's fixed `PAGE_LIMIT` rather than a caller's parameter — so no
 * screen can ask the API for a thousand rows. `docs/07 §4` bans `OFFSET`
 * pagination; a client that concatenated pages automatically would be an
 * `OFFSET` scan wearing a different hat.
 */
export interface CursorList<T> {
  readonly items: readonly T[];
  /** True while the *first* page is in flight — the skeleton's condition. */
  readonly isPending: boolean;
  /** True while any page is in flight, including a background refetch. */
  readonly isFetching: boolean;
  readonly error: unknown;
  readonly hasMore: boolean;
  readonly loadMore: () => void;
  readonly refetch: () => void;
  /** How many pages the operator has asked for. Shown so the count is honest. */
  readonly pageCount: number;
}

export function useCursorList<T>(options: {
  readonly queryKey: readonly unknown[];
  readonly fetchPage: (cursor: string | undefined, signal: AbortSignal | undefined) => Promise<Page<T>>;
  readonly enabled?: boolean;
  readonly refetchInterval?: number;
  readonly staleTime?: number;
}): CursorList<T> {
  const query = useInfiniteQuery({
    queryKey: options.queryKey,
    queryFn: ({ pageParam, signal }) => options.fetchPage(pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: Page<T>) => last.nextCursor ?? undefined,
    enabled: options.enabled ?? true,
    ...(options.refetchInterval === undefined ? {} : { refetchInterval: options.refetchInterval }),
    ...(options.staleTime === undefined ? {} : { staleTime: options.staleTime }),
  });

  const pages = query.data?.pages ?? [];
  return {
    items: pages.flatMap((page) => page.items),
    isPending: query.isPending,
    isFetching: query.isFetching,
    error: query.error,
    hasMore: query.hasNextPage,
    loadMore: () => {
      if (!query.hasNextPage || query.isFetchingNextPage) return;
      void query.fetchNextPage();
    },
    refetch: () => {
      void query.refetch();
    },
    pageCount: pages.length,
  };
}

/**
 * The same shape for the handful of API routes that return `{ items }` with no
 * cursor at all — a store's bin list, an item's substitutes, an item's FEFO
 * batches.
 *
 * Those are bounded by the domain rather than by a page size: an item has a
 * handful of substitutes and a store a handful of bins. Wrapping them in the
 * same interface keeps the screens from growing two shapes of list, and keeps
 * the *unbounded* ones honest by contrast — if a route ever starts returning
 * thousands of rows, it needs a cursor and this is not the wrapper for it.
 */
export function boundedList<T>(
  data: { readonly items: readonly T[] } | undefined,
  state: {
    readonly isPending: boolean;
    readonly isFetching: boolean;
    readonly error: unknown;
    readonly refetch: () => void;
  },
): CursorList<T> {
  return {
    items: data?.items ?? [],
    isPending: state.isPending,
    isFetching: state.isFetching,
    error: state.error,
    hasMore: false,
    loadMore: () => undefined,
    refetch: state.refetch,
    pageCount: data === undefined ? 0 : 1,
  };
}
