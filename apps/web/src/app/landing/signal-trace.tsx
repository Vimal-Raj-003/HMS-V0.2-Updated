/**
 * The hero backdrop: a rhythm strip that draws itself, the way the monitor at
 * the head of a bed does.
 *
 * It is a server component with no JavaScript at all — the sweep is a CSS
 * `stroke-dashoffset` animation, which the compositor runs off the main thread,
 * so it costs nothing while the page hydrates. The whole thing is inside
 * `@media (prefers-reduced-motion: no-preference)`, so a reader who asked for
 * stillness gets a static trace rather than a stopped one.
 *
 * The waveform is a real PQRST complex rather than a decorative squiggle: P
 * wave, the QRS spike, the T wave after it. Anyone who reads rhythm strips for
 * a living will recognise it, and that is the point of putting it here.
 */

/** One 200-unit beat, from the isoelectric line back to it. */
function beat(x: number): string {
  return [
    `L ${String(x + 24)} 100`,
    // P wave — atrial depolarisation, small and round.
    `Q ${String(x + 40)} 82 ${String(x + 56)} 100`,
    `L ${String(x + 74)} 100`,
    // QRS — the spike. Straight lines, because it is fast.
    `L ${String(x + 80)} 112`,
    `L ${String(x + 90)} 26`,
    `L ${String(x + 100)} 130`,
    `L ${String(x + 108)} 100`,
    `L ${String(x + 124)} 100`,
    // T wave — repolarisation, broader and lower than the P.
    `Q ${String(x + 148)} 72 ${String(x + 172)} 100`,
    `L ${String(x + 200)} 100`,
  ].join(' ');
}

const D = `M 0 100 ${[0, 200, 400, 600, 800, 1000].map(beat).join(' ')}`;

/**
 * Fades upward into the canvas, so the strip has a bottom edge (the foot of the
 * hero) and no top one — it reads as something the page is standing on rather
 * than a rectangle that was pasted in.
 */
const MASK = 'linear-gradient(to top, black 0%, black 46%, transparent 100%)';

export function SignalTrace() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 overflow-hidden"
      // Anchored to the foot of the hero rather than laid behind it. A backdrop
      // that runs through body copy is a legibility failure however good it
      // looks in a screenshot, and the first attempt at this ran the QRS spike
      // straight through the second line of the paragraph. Down here it crosses
      // nothing, it fills what was dead space under the buttons, and the queue
      // board's lower edge sits over it — which is where the sense of depth
      // actually comes from.
      style={{ maskImage: MASK, WebkitMaskImage: MASK }}
    >
      <style>{`
        @media (prefers-reduced-motion: no-preference) {
          .vh-trace { animation: vh-sweep 9s linear infinite; }
          .vh-trace-glow { animation: vh-sweep 9s linear infinite, vh-flicker 9s ease-in-out infinite; }
        }
        @keyframes vh-sweep {
          from { stroke-dashoffset: 2600; }
          to   { stroke-dashoffset: 0; }
        }
        @keyframes vh-flicker {
          0%, 100% { opacity: 0.18; }
          50%      { opacity: 0.50; }
        }
      `}</style>
      <svg
        viewBox="0 0 1200 200"
        preserveAspectRatio="none"
        className="h-48 w-full opacity-90 sm:h-56"
        role="presentation"
      >
        <defs>
          {/* The graticule of a paper strip, at the weight of a hairline rule. */}
          <pattern id="vh-grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M 40 0 L 0 0 0 40" fill="none" stroke="var(--border-default)" strokeWidth="1" />
          </pattern>
        </defs>

        <rect width="1200" height="200" fill="url(#vh-grid)" />

        {/* Laid down twice: a wide, dim pass for the phosphor bloom and a sharp
            one on top. Two strokes are cheaper and truer than an SVG filter. */}
        <path
          className="vh-trace-glow"
          d={D}
          fill="none"
          stroke="var(--color-accent-solid)"
          strokeWidth="6"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray="2600"
          strokeDashoffset="0"
          opacity="0.30"
        />
        <path
          className="vh-trace"
          d={D}
          fill="none"
          stroke="var(--color-accent-solid)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray="2600"
          strokeDashoffset="0"
        />
      </svg>
    </div>
  );
}
