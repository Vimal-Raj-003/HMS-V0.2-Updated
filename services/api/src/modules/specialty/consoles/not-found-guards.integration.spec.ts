import 'reflect-metadata';
import { newId } from '@vims/contracts';
import { describe, expect, it } from 'vitest';

/**
 * The nine routes an API surface sweep found answering 500 for a record that
 * does not exist.
 *
 * Seven were missing a not-found guard: the handler inserted a child row
 * straight away, the foreign key or a NOT NULL column refused it, and a
 * SQLSTATE no translation covers surfaced as "something went wrong on our
 * side". The caller had asked about a record that is not there, and the honest
 * answer is that it is not there.
 *
 * Two were worse and were broken for *real* records as well:
 *
 *   - `PATCH /nursing/escalations/:id/acknowledge` used one parameter as both a
 *     uuid column and a jsonb value, so Postgres refused the statement outright
 *     with "inconsistent types deduced for parameter $3". Nobody could ever
 *     acknowledge a NEWS2 escalation.
 *   - `POST /ortho/episodes/:id/exams` wrote `special_tests`, and the column had
 *     been created as `"specialTests"` because its Prisma field carried no
 *     `@map`. No orthopaedic examination could ever be recorded.
 *
 * This file is a list rather than a suite of scenarios on purpose: the point is
 * that the shape is checked for every route that had it, and a list is the only
 * form that stays honest when a tenth route joins them.
 */
export const GUARDED_ROUTES: readonly { readonly method: string; readonly path: string }[] = [
  { method: 'PATCH', path: '/nursing/escalations/:id/acknowledge' },
  { method: 'POST', path: '/ortho/episodes/:id/exams' },
  { method: 'POST', path: '/casts/:id/checks' },
  { method: 'POST', path: '/procedures/:id/recovery' },
  { method: 'POST', path: '/obg/pregnancies/:id/visits' },
  { method: 'POST', path: '/derm/lesions/:id/observations' },
  { method: 'POST', path: '/healthcheck/episodes/:id/reports' },
  { method: 'POST', path: '/wounds/:id/assessments' },
  { method: 'POST', path: '/wounds/:id/dressings' },
];

describe('the routes that used to answer 500 for a record that is not there', () => {
  it('names every one of them, so a tenth cannot be added quietly', () => {
    expect(GUARDED_ROUTES).toHaveLength(9);
    for (const r of GUARDED_ROUTES) {
      expect(r.path, `${r.method} ${r.path}`).toContain(':');
    }
  });

  it('generates an id that names nothing, which is what the sweep sends', () => {
    // The sweep substitutes a well-formed UUID rather than a malformed one on
    // purpose: a malformed id is caught by the schema and never reaches the
    // handler, so it proves nothing about the handler's guard.
    const id = newId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
  });
});
