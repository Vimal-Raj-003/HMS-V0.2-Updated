/**
 * `@vims/testing` — the harness every other package tests through.
 *
 * Nothing here may be imported by production code. It exists so that a
 * guarantee written in `docs/` can be *executed*: tenant isolation, audit
 * immutability and RLS default-deny are all properties of the running database,
 * not of the source, and can only be checked against one.
 */
export * from './containers/index.js';
export * from './fixtures/index.js';
export * from './factories/index.js';
export * from './generators/index.js';
export * from './matchers/index.js';
