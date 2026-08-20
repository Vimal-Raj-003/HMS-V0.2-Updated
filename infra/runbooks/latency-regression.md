# Runbook — LatencyRegression

**Severity P2 · pages platform-oncall**

Class C p95 has been above the 250 ms budget for 30 minutes (`docs/07` §7).

## Impact
Not an outage. It is the thing that makes staff describe the system as "slow", which is
how an HMS loses its users. Class C is the interactive clinical path.

## First five minutes
1. Is it one endpoint or all of them? A single endpoint means a query plan; all of them
   means a resource.
2. `pg_stat_statements` — sort by total time since the regression started. A plan that
   flipped from index scan to sequential scan shows up immediately.
3. Check replica lag: reports read replicas, and a lagging replica pushes load onto the primary.
4. Check whether a partition was created recently. A new month's partition starts with no
   statistics until it is analysed.

## Common causes
- A missing or invalidated index after a bulk load or a large seed.
- A table that has grown past the point where its old plan is sensible.
- Autovacuum falling behind on a high-write table, so the planner's row estimates are stale.

## Escalation
Platform on-call → DBA if the cause is a query plan. Do not silence the alert: the budget
is a product requirement (`CLAUDE.md` §0.6), not a target.
