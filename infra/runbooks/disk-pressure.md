# Runbook — DiskPressure

**Severity P1 · pages platform-oncall**

A data or WAL volume is above 85 % full, or is predicted to fill within four hours.

## Impact
A full WAL volume **stops the database**. This is the alert with the shortest fuse and
the most predictable outcome.

## First five minutes
1. Which volume — data or WAL? They fail differently.
2. **WAL filling**: usually archiving has stopped. `pgbackrest --stanza=vimshms check`.
   If the archive command is failing, WAL accumulates until the disk dies. Fix archiving;
   do not delete WAL by hand.
3. **Data filling**: the fastest safe recovery is dropping an old partition, which is
   why the high-write tables are partitioned monthly (`docs/07` §4) — a month must be
   droppable in under a second, which `DELETE` can never be.
4. Check `core.v_audit_seal_backlog` and the outbox: an unpublished outbox backlog past
   its 7-day retention means the relay has stopped.

## Do not
Do not drop an audit partition to reclaim space. Audit retention has statutory floors
(`docs/04` §5) and medico-legal rows are exempt from compaction entirely. Archive first.

## Escalation
Platform on-call → DBA. If less than one hour of headroom remains, extend the volume
rather than deleting anything.
