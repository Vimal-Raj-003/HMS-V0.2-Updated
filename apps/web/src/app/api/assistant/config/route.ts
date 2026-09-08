import { NextResponse } from 'next/server';

/**
 * Which hospital the landing page's assistant speaks for.
 *
 * ── Why this is a route and not a prop ─────────────────────────────────────
 *
 * It was a prop, read from `process.env` in the page's server component, and
 * that was wrong in a way that only showed up in a production build. `/` uses
 * no dynamic API, so Next prerenders it at build time — which meant
 * `LANDING_HOSPITAL_ID` was evaluated by `next build`, baked into static HTML,
 * and never read again. The variable is documented as configuration; it was
 * behaving as a build-time constant, so an operator setting it on the server
 * would see no assistant and no error.
 *
 * The fixes available were to force the page dynamic — giving up static
 * rendering on the one page a stranger loads on a phone in a hospital car park
 * — or to move the lookup to a route handler, which is dynamic by default. This
 * is the second. The page stays static; the widget, which is a client component
 * that matters only after a click, asks at runtime.
 */
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function GET(): NextResponse {
  const raw = process.env['LANDING_HOSPITAL_ID']?.trim();
  // A malformed value is treated as absent. The widget then does not render,
  // which is a landing page without a chat bubble rather than a chat bubble
  // that 400s on every turn.
  if (raw === undefined || !UUID.test(raw)) {
    return NextResponse.json(
      { configured: false },
      { status: 200, headers: { 'cache-control': 'no-store' } },
    );
  }
  return NextResponse.json(
    { configured: true, hospitalId: raw },
    { status: 200, headers: { 'cache-control': 'no-store' } },
  );
}
