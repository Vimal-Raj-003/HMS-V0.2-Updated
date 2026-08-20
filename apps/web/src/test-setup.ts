import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

/**
 * Component-test environment for `apps/web`.
 *
 * It lives under `src/` rather than beside `vitest.config.ts` so that it is part
 * of the same TypeScript program as the code it supports — a setup file outside
 * the program cannot be type-checked or type-aware-linted, which is how a broken
 * stub survives until a test fails for an unrelated-looking reason.
 */
afterEach(() => {
  cleanup();
});

// jsdom implements none of these, and the Radix primitives the admin console is
// built from probe for all of them on mount.
if (typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      }) as MediaQueryList,
  });
}

if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = class {
    observe(): void {
      /* measured explicitly by the tests that care */
    }
    unobserve(): void {
      /* no-op */
    }
    disconnect(): void {
      /* no-op */
    }
  };
}

if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {
    /* no-op */
  };
}

// Radix Select calls this while positioning its popper.
if (typeof Element.prototype.hasPointerCapture !== 'function') {
  Element.prototype.hasPointerCapture = function hasPointerCapture(): boolean {
    return false;
  };
  Element.prototype.setPointerCapture = function setPointerCapture(): void {
    /* no-op */
  };
  Element.prototype.releasePointerCapture = function releasePointerCapture(): void {
    /* no-op */
  };
}
