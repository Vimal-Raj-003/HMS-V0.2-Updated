'use client';

import { useEffect, useState } from 'react';

/**
 * The signature element of the landing page: a queue board.
 *
 * Every Indian hospital lobby has one, and it is the single screen that patients,
 * porters, nurses and consultants all read. Putting the product's own artefact in
 * the hero says what the software is far more directly than a description of it
 * would — and it is rendered from the same `--q-*` tokens a real TV board uses
 * (`docs/06 §5.2`), so it is the product's actual palette rather than an
 * illustration of it.
 *
 * The data is illustrative. Nothing here is a real patient: tokens are letters
 * and numbers, which is exactly what a real board shows, because `EN-018 §5`
 * forbids a patient identifier on a screen in a public waiting area.
 */

interface Call {
  readonly token: string;
  readonly room: string;
  readonly state: 'called' | 'in-progress' | 'waiting';
}

/**
 * A fixed sequence rather than random data: the server and client must render
 * the same first frame or React reports a hydration mismatch, and a board that
 * flickers on load reads as broken rather than live.
 */
const FRAMES: readonly (readonly Call[])[] = [
  [
    { token: 'A-042', room: 'OPD 3 · Orthopaedics', state: 'called' },
    { token: 'B-017', room: 'Sample collection', state: 'in-progress' },
    { token: 'T-004', room: 'Triage bay 2', state: 'in-progress' },
    { token: 'A-043', room: 'OPD 3 · Orthopaedics', state: 'waiting' },
    { token: 'C-009', room: 'Cash counter 1', state: 'waiting' },
  ],
  [
    { token: 'A-043', room: 'OPD 3 · Orthopaedics', state: 'called' },
    { token: 'B-018', room: 'Sample collection', state: 'in-progress' },
    { token: 'T-004', room: 'Triage bay 2', state: 'in-progress' },
    { token: 'C-009', room: 'Cash counter 1', state: 'waiting' },
    { token: 'R-011', room: 'Radiology · X-ray', state: 'waiting' },
  ],
  [
    { token: 'C-009', room: 'Cash counter 1', state: 'called' },
    { token: 'A-043', room: 'OPD 3 · Orthopaedics', state: 'in-progress' },
    { token: 'B-018', room: 'Sample collection', state: 'in-progress' },
    { token: 'R-011', room: 'Radiology · X-ray', state: 'waiting' },
    { token: 'A-044', room: 'OPD 3 · Orthopaedics', state: 'waiting' },
  ],
];

const STATE_LABEL: Record<Call['state'], string> = {
  called: 'Now calling',
  'in-progress': 'In progress',
  waiting: 'Waiting',
};

/** The state colour is the token the TV board itself uses. */
const STATE_COLOUR: Record<Call['state'], string> = {
  called: 'var(--q-called)',
  'in-progress': 'var(--q-in-progress)',
  waiting: 'var(--q-waiting)',
};

export function LandingBoard() {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    // A board that advances while someone is reading the page is the point; one
    // that advances for a user who asked for less motion is a nuisance.
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (reduced.matches) return;
    const id = window.setInterval(() => {
      setFrame((f) => (f + 1) % FRAMES.length);
    }, 3800);
    return () => {
      window.clearInterval(id);
    };
  }, []);

  const calls = FRAMES[frame] ?? FRAMES[0] ?? [];
  const [now, ...rest] = calls;

  return (
    <div
      className="rounded-2xl border border-strong bg-layer-1 p-5 shadow-e4 sm:p-6"
      // Illustrative, and announced as such: a screen reader should not be told
      // there are patients waiting in a hospital that does not exist.
      role="img"
      aria-label="Illustration of a Vim's HMS queue board: token A-042 calling to OPD 3, with four tokens behind it."
    >
      <div className="flex items-baseline justify-between gap-4 border-b border-default pb-4">
        <p className="font-mono text-[0.6875rem] uppercase tracking-[0.18em] text-fg-subtle">
          Queue board · Main block
        </p>
        <p className="flex items-center gap-2 font-mono text-[0.6875rem] uppercase tracking-[0.18em] text-fg-subtle">
          <span
            className="inline-block size-1.5 rounded-full motion-safe:animate-pulse"
            style={{ backgroundColor: 'var(--q-in-progress)' }}
            aria-hidden="true"
          />
          Live
        </p>
      </div>

      {now === undefined ? null : (
        <div className="py-6">
          <p className="font-mono text-[0.6875rem] uppercase tracking-[0.18em] text-fg-muted">
            {STATE_LABEL[now.state]}
          </p>
          <p
            className="mt-2 font-display text-5xl font-semibold tracking-tight tabular-nums sm:text-6xl"
            style={{ color: STATE_COLOUR[now.state] }}
          >
            {now.token}
          </p>
          <p className="mt-1 text-sm text-fg-muted">{now.room}</p>
        </div>
      )}

      <ul className="divide-y divide-[color:var(--border-default)] border-t border-default">
        {rest.map((call) => (
          <li key={call.token} className="flex items-center gap-3 py-2.5">
            <span
              className="size-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: STATE_COLOUR[call.state] }}
              aria-hidden="true"
            />
            <span className="font-mono text-sm tabular-nums text-fg-default">{call.token}</span>
            <span className="truncate text-sm text-fg-subtle">{call.room}</span>
            <span className="ms-auto shrink-0 font-mono text-[0.6875rem] uppercase tracking-[0.14em] text-fg-subtle">
              {STATE_LABEL[call.state]}
            </span>
          </li>
        ))}
      </ul>

      <div className="mt-4 flex flex-wrap gap-x-6 gap-y-1 border-t border-default pt-4 font-mono text-[0.6875rem] uppercase tracking-[0.14em] text-fg-subtle">
        <span>
          Waiting <span className="text-fg-default">23</span>
        </span>
        <span>
          Average wait <span className="text-fg-default">8 min</span>
        </span>
        <span>
          Counters <span className="text-fg-default">6 of 8</span>
        </span>
      </div>
    </div>
  );
}
