'use client';

import { useEffect, useRef } from 'react';

/**
 * A number that counts up when it is scrolled to.
 *
 * The server renders the **final** value, and the animation only ever writes
 * into that same node and always lands on exactly the same string. So the
 * accessible name, the no-JavaScript render and the end state are identical —
 * a reader with a screen reader or a stopped script sees the real figure, not a
 * zero waiting for an animation that will not come.
 *
 * The tick writes `textContent` directly rather than going through React state.
 * That is deliberate: sixty renders a second to paint one integer would be a
 * waste, and React never re-renders this subtree, so nothing fights over it.
 */

interface CountUpProps {
  readonly value: number;
  /** Rendered after the number, inside the same node, e.g. `+`. */
  readonly suffix?: string;
}

const format = (n: number, suffix: string): string => `${n.toLocaleString('en-IN')}${suffix}`;

export function CountUp({ value, suffix = '' }: CountUpProps) {
  const ref = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const node = ref.current;
    if (node === null) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let frame = 0;
    let start: number | null = null;
    const duration = 1100;

    const tick = (now: number): void => {
      start ??= now;
      const t = Math.min((now - start) / duration, 1);
      // Ease-out quart: most of the distance early, so it reads as settling
      // rather than as a slot machine.
      const eased = 1 - Math.pow(1 - t, 4);
      node.textContent = format(Math.round(value * eased), suffix);
      if (t < 1) frame = window.requestAnimationFrame(tick);
    };

    const run = (): void => {
      node.textContent = format(0, suffix);
      frame = window.requestAnimationFrame(tick);
    };

    const rect = node.getBoundingClientRect();
    if (rect.top < window.innerHeight) {
      run();
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          observer.disconnect();
          run();
        }
      },
      { rootMargin: '0px 0px -10% 0px' },
    );
    observer.observe(node);

    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
      // Whatever happened, the node ends on the truth.
      node.textContent = format(value, suffix);
    };
  }, [value, suffix]);

  return (
    <span ref={ref} className="tabular-nums">
      {format(value, suffix)}
    </span>
  );
}
