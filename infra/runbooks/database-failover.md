# Runbook — DatabasePrimaryUnreachable

**Severity P1 · pages platform-oncall, dba**

The primary is unreachable, or a replica was promoted, or three connections failed in 60 s.

## Impact
**Writes fail loudly and are never silently dropped** (`docs/01` §7). Clinical charting,
ordering and billing stop. Reads may continue from a replica in read-only mode.

## First five minutes
1. Confirm which node believes it is primary. Two primaries is worse than none — stop and
   get the DBA before doing anything else.
2. `pgbackrest --stanza=vimshms check` — confirms the archive command and repository are
   reachable, which tells you whether PITR coverage is still intact.
3. If a replica was promoted: verify WAL continuity, then repoint PgBouncer. Do not repoint
   application config; PgBouncer is the indirection that exists for this.
4. Put the UI into read-only mode banner state rather than letting writes fail one by one.

## Do not
- Do not restore onto the live data directory. Restore to `/data/pg-restore`, start on an
  alternate port, verify, and only then cut over (`docs/10` §8).
- Do not skip the audit chain check afterwards: run `core.verify_audit_chain()` for the
  affected window before declaring recovery. A failover is exactly when a gap could appear.

## Escalation
DBA immediately. Declare a Sev-1 and start the downtime protocol if the outage exceeds
15 minutes during clinical hours.
