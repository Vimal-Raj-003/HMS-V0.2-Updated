# Runbook — ErrorRateHigh

**Severity P1 · pages platform-oncall**

More than 2 % of requests returned 5xx over five minutes.

## Impact

One request in fifty fails. Users experience it as random: a bill that will not save,
a result that will not open. That randomness is what makes it dangerous — staff work
around it rather than reporting it.

## First five minutes

1. Break the rate down by route and by status. One route at 100 % is a code path; every
   route at 2 % is a dependency.
2. Take one trace id from a failing response (`x-trace-id`, also the `reference` shown to
   the user) and follow it end to end. Every error response carries one.
3. Check whether the errors are `internal-error` or a specific problem type. Anything
   other than `internal-error` is a deliberate refusal, which means a _policy_ changed,
   not the code.
4. Correlate with the last deploy and the last migration.

## Common causes

- A dependency (database, Redis, object storage) refusing connections.
- A migration that added a NOT NULL column the running code does not populate — this is
  what the expand→migrate→contract rule in `docs/10` §6.1 exists to prevent.
- Statement timeout (15 s) hit by a query that lost its index.

## Escalation

Platform on-call. If the failing path is clinical or money-moving, page the module owner
immediately and treat every failed write as unrecorded until proven otherwise.
