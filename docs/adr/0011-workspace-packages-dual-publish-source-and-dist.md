# ADR-0011 — Workspace packages publish both source and `dist` via export conditions

- Status: accepted
- Date: 2026-08-20
- Deciders: platform team (Phase 0)

## Context

`packages/contracts` originally declared `"main": "./src/index.ts"` and exported
raw TypeScript. That works for the Next apps (which compile workspace packages
through `transpilePackages`) and for vitest, but it means a built service cannot
start: `node dist/main.js` in `services/realtime` failed with
`ERR_MODULE_NOT_FOUND … packages/contracts/src/primitives/index.js`, because Node
resolves the `.js` specifier the emitted code contains and finds only `.ts`.

The consequence was that `services/worker`, `services/realtime` and
`services/integration-hub` could only run under `tsx`. A production image cannot
depend on a TypeScript loader, and `docs/10` §6 expects signed, built images.

## Decision

Each package that is on a service's runtime path — `contracts`, `db`, `flags`,
`print-templates` — gains a `tsconfig.build.json` that emits JavaScript and
declarations, and every `exports` entry becomes:

```json
{
  "development": "./src/….ts",
  "types": "./dist/….d.ts",
  "import": "./dist/….js",
  "default": "./dist/….js"
}
```

- **Node, Next.js and `tsc`** never enable the `development` condition, so they
  resolve `dist`: Node gets JavaScript, TypeScript gets declarations (with
  declaration maps, so go-to-definition still lands in source).
- **Vite and Vitest** resolve `development` by default, so tests and dev servers
  compile the real `.ts`. Unit tests therefore need no build step, and there is
  no class of bug where a test passes against a stale `dist`.

`@vims/i18n` is deliberately left on source: it is imported only by `apps/web`,
is on no service's runtime path, and its catalogue statically imports twelve JSON
files, which a Node-loadable build would require import attributes on. That is a
real source change with real bundler risk for no current benefit.

## Consequences

- All three services start from `node dist/main.js`, verified by committed
  startup tests that build the service and spawn the artefact.
- `pnpm build` must run before a service is started from `dist`; Turborepo's
  dependency graph handles the ordering.
- A stale `dist` cannot silently affect unit tests, because they resolve source.
  It _can_ affect a locally-started service, which is the trade accepted here.

## Alternatives considered

- **TypeScript project references.** Rejected: `tsc` would pull each package's
  `.ts` into its dependents' programs, producing `rootDir` violations, and it
  would not fix Node's runtime resolution — which was the actual defect.
- **Publish only `dist`.** Rejected: every unit test would then require a build
  first, and a stale `dist` would silently change test results.
