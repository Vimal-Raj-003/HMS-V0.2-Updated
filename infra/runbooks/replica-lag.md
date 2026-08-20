# Runbook — ReplicaLagHigh

**Severity P1 · pages dba**

Streaming replication lag has exceeded 60 seconds for five minutes.

## Impact
Reports, dashboards and the auditor workspace read replicas. Lag means a clinician can
see a bed as occupied that was released a minute ago, or a report that omits the last
minute's charges. It is a correctness problem, not a performance one.

## First five minutes
1. Is the replica applying or receiving? `pg_stat_replication` on the primary,
   `pg_last_wal_receive_lsn()` vs `pg_last_wal_replay_lsn()` on the replica.
2. Long-running query on the replica blocking replay? `max_standby_streaming_delay`
   trades this off deliberately; a report holding a snapshot will stall apply.
3. Network saturation or disk saturation on the replica.
4. A bulk operation on the primary — a large seed, a backfill, a partition detach.

## Mitigation
Route reports back to the primary temporarily if the lag cannot be cleared quickly; a
slower primary is better than a wrong report. Backfills must be throttled by the
clinical-latency guard (`docs/10` §6.1 rule 4), so a backfill causing this is a bug.

## Escalation
DBA. If lag exceeds the RPO window, treat the replica as unusable for DR until it catches up.
