# Runbook — ServiceDown

**Severity P1 · pages platform-oncall**

`/healthz` has failed two consecutive probes for a service. `/healthz` deliberately
does **not** touch the database, so this means the process itself is gone or wedged —
not that a dependency is slow.

## Impact
Clinical screens return errors. Charting, ordering and billing stop for the affected
service. The PWA keeps its cached shell, and queued nurse mutations (vitals, MAR,
notes) survive in IndexedDB and sync on recovery (`docs/01` §7) — they are not lost.

## First five minutes
1. Which service, and is it all replicas or one? `kubectl get pods -l app=vims-<svc>` /
   `docker compose ps`.
2. `/readyz` on a surviving replica — if ready is failing but live is passing, this is a
   dependency problem, not a crash. Go to **DatabasePrimaryUnreachable** or the Redis runbook.
3. Last deploy time. If it is within the hour, roll back first and diagnose after
   (`docs/10` §6: rollback target < 10 min, the schema is backward-compatible by construction).
4. Logs since the last restart. A boot failure prints to stderr before the logger starts.

## Common causes
- **Bad config / missing secret.** The env contract is parsed at boot and refuses to start
  on a missing variable — by design, so it fails at start rather than on the first request.
- **OOM kill.** Check `kubectl describe pod` for `OOMKilled`.
- **Migration mismatch.** Readiness includes "migrations at expected version"; a partially
  applied migration keeps the pod unready.

## Escalation
Platform on-call → module owner if it is isolated to one module's routes.
Declare a Sev-1 and start the downtime protocol (`docs/01` §7) if it lasts beyond 15 minutes
during OPD hours: pre-printed forms, the reserved offline numbering block, and catch-up entry
with flagged back-dated timestamps.
