'use client';

import { useEffect, useRef, type ElementType, type ReactNode } from 'react';

/**
 * Scroll-reveal, built on IntersectionObserver and the Web Animations API
 * rather than an animation library.
 *
 * `CLAUDE.md` §2 locks the stack and asks for an ADR before a dependency is
 * added; a fade and a 12px rise do not need 40 kB of GSAP to happen. What they
 * do need is to fail safely, and the order of operations below is the whole
 * point:
 *
 *   - The server renders the element **visible**. If JavaScript never runs, if
 *     hydration fails, or if a crawler reads the page, the content is simply
 *     there. A reveal that hides content until a script rescues it is a
 *     content-blanking bug wearing a nice animation.
 *   - Hiding happens on mount, and only for elements that are *below the fold*
 *     at that moment. An element already on screen animates immediately with
 *     `fill: 'backwards'`, so it is never painted at full opacity and then
 *     yanked to zero — which is the flash every naive implementation ships.
 *   - `prefers-reduced-motion` short-circuits before anything is hidden.
 */

interface RevealProps {
  readonly children: ReactNode;
  /** Milliseconds of stagger, for a list whose items should arrive in order. */
  readonly delay?: number;
  readonly className?: string;
  /** Defaults to a `div`; lists need `li`, sections need `section`. */
  readonly as?: ElementType;
}

export function Reveal({ children, delay = 0, className, as }: RevealProps) {
  const ref = useRef<HTMLElement | null>(null);
  const Tag: ElementType = as ?? 'div';

  useEffect(() => {
    const node = ref.current;
    if (node === null) return;

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    // A browser without WAAPI keeps the server's visible element.
    if (typeof node.animate !== 'function') return;

    const play = (): void => {
      node.style.removeProperty('opacity');
      node.animate(
        [
          { opacity: 0, transform: 'translateY(12px)' },
          { opacity: 1, transform: 'none' },
        ],
        { duration: 520, delay, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', fill: 'backwards' },
      );
    };

    const rect = node.getBoundingClientRect();
    if (rect.top < window.innerHeight) {
      // Already on screen: animate now. `fill: 'backwards'` applies the first
      // keyframe for the delay, so there is no full-opacity frame to flash.
      play();
      return;
    }

    // Below the fold, so setting opacity to 0 is invisible to the reader.
    node.style.opacity = '0';
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          observer.disconnect();
          play();
        }
      },
      { rootMargin: '0px 0px -12% 0px' },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [delay]);

  return (
    <Tag ref={ref} className={className}>
      {children}
    </Tag>
  );
}
