/**
 * Where the Next server proxies to reach `services/api`.
 *
 * ── Why this is a module and not two literals ───────────────────────────────
 *
 * It used to be `?? 'http://127.0.0.1:3001'`, written twice, while
 * `infra/env.example` sets `API_PORT=4000` and documents no `API_ORIGIN` at
 * all. A developer following the documented setup got a login page that
 * returned 500 with `ECONNREFUSED 127.0.0.1:3001` — a failure that says nothing
 * about the actual mistake, and one that only appears when the environment is
 * *correct* by the documentation.
 *
 * The default now follows `API_PORT`, so the two halves of the documented setup
 * agree by construction. `API_ORIGIN` still overrides, which is what a
 * containerised or split deployment needs.
 */
const DEFAULT_API_PORT = '4000';

function resolve(): string {
  const explicit = process.env['API_ORIGIN'];
  if (explicit !== undefined && explicit.trim() !== '') return explicit.trim();

  const port = process.env['API_PORT'];
  const resolved = port !== undefined && /^\d+$/u.test(port.trim()) ? port.trim() : DEFAULT_API_PORT;
  return `http://127.0.0.1:${resolved}`;
}

export const API_ORIGIN: string = resolve();
