# ADR-0010 — Global catalogues use an authenticated-session predicate, not `USING (true)`

* Status: accepted
* Date: 2026-08-19
* Deciders: platform team (Phase 0)

## Context

Ten of the 124 tables added in Phase 0 hold data that is genuinely identical for
every tenant: licence plans, entitlement enforcement points, terminology code
systems, the display-widget catalogue and the connector-package catalogue. They
have no tenant key, so the generated `hospital_id` policy cannot apply.

The obvious answer is `USING (true)`, which is what the two pre-existing global
catalogues (`core.permissions`, `core.setting_definitions`) use. But
`packages/db/src/rls/verify-isolation.sql` case 2 asserts that the set of
unrestricted policies is **exactly** those two — a deliberate allow-list, so that
"this table is world-readable" is always a decision somebody made rather than a
default somebody inherited. Adding ten more would have meant either widening the
allow-list tenfold or weakening the assertion.

There is also a real, if modest, difference between "every tenant may read this"
and "anyone who reaches the database may read this". An unauthenticated or
unscoped session has no business enumerating the licence plans on offer or the
connector packages installed.

## Decision

The new global catalogues carry an explicit policy:

```sql
USING (cardinality(core.accessible_hospital_ids()) > 0)
WITH CHECK (false)
```

The `USING` clause requires a session that has established *some* tenancy scope,
without constraining which. The `WITH CHECK (false)` clause makes them read-only
to the application role: these are code-owned catalogues, written by migration
and seed as `hms_migrator`, exactly as `core.permissions` is (see D-26).

The unrestricted-policy allow-list stays at two entries, and the isolation suite
continues to assert it.

## Consequences

* An unscoped session reads nothing at all, matching the default-deny posture
  everywhere else — `docs/09 §3.1`'s "unscoped means nothing" holds uniformly
  rather than having ten exceptions.
* Reading a catalogue costs one extra `current_setting` lookup per query. These
  are small, cached, rarely-changing tables, so the cost is not measurable
  against the query it accompanies.
* The two original catalogues keep `USING (true)`, because they are read on
  literally every request to render a nav menu and are already public in the
  source repository. That asymmetry is intentional and is documented in
  `..._rls_tenant_key_exceptions`.

## Alternatives considered

* **`USING (true)` for all ten.** Rejected: it would grow the allow-list from 2
  to 12 and make the "is this table meant to be open?" question unanswerable at a
  glance.
* **Give them a `hospital_id` and copy the rows per tenant.** Rejected: the data
  is genuinely identical, and duplicating it invites the copies to diverge.
