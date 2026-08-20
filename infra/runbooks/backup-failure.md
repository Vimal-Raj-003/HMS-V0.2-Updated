# Runbook — BackupFailure

**Severity P1 · pages dba**

No successful pgBackRest backup in 26 hours, or the nightly job exited non-zero.

## Impact
Point-in-time recovery coverage is degrading. `docs/10` §8 requires PITR of **at least
30 days**. Nothing is broken for users today; the exposure is entirely to the next incident.

## First five minutes
1. `pgbackrest --stanza=vimshms info` — newest backup age and WAL continuity. A gap in
   WAL is more serious than a missed full backup: it breaks PITR for the whole window.
2. `pgbackrest --stanza=vimshms check` — archive command and both repositories reachable.
3. Repo1 (local) and repo2 (off-site, object-locked) fail for different reasons. Repo2
   failing is often an expired credential — and it uses a **separate** credential set on
   purpose, so that ransomware on the hospital domain cannot reach it.
4. Disk space on the repository volume.

## Then
Run a manual full backup once the cause is fixed, and **verify by restoring** — a backup
that has never been restored is a hypothesis. `infra/scripts/restore-drill.sh` does this
against a scratch instance.

## Escalation
DBA. If WAL continuity is broken, treat the recovery window before the gap as unusable and
say so explicitly in the incident record.
