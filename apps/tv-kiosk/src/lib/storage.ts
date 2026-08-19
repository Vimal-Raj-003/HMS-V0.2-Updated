/**
 * The kiosk's only persistence. It is deliberately a two-method interface: the
 * device credential must survive a power cut (EN-018 §3.7 "power-on autostart"),
 * and everything else on a signage box is disposable.
 */
export interface KeyValueStore {
  read(key: string): string | null;
  write(key: string, value: string): void;
  remove(key: string): void;
}

/** In-memory fallback: SSR, private-mode Safari, and tests. */
export function createMemoryStore(seed?: ReadonlyMap<string, string>): KeyValueStore {
  const map = new Map<string, string>(seed ?? []);
  return {
    read: (key) => map.get(key) ?? null,
    write: (key, value) => {
      map.set(key, value);
    },
    remove: (key) => {
      map.delete(key);
    },
  };
}

/**
 * `localStorage` guarded on every call. A quota error or a locked-down WebView
 * must degrade to "ask to be paired again", never to an unhandled exception that
 * white-screens the board.
 */
export function createLocalStorageStore(): KeyValueStore {
  const backing = (): Storage | null => {
    try {
      if (typeof window === 'undefined') return null;
      return window.localStorage;
    } catch {
      return null;
    }
  };

  return {
    read: (key) => {
      try {
        return backing()?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    write: (key, value) => {
      try {
        backing()?.setItem(key, value);
      } catch {
        // A full or disabled store is survivable: the board still runs this
        // session, it just has to be re-paired after a power cut.
      }
    },
    remove: (key) => {
      try {
        backing()?.removeItem(key);
      } catch {
        // See above.
      }
    },
  };
}
