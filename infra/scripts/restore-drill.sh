#!/usr/bin/env bash
#
# Restore drill — proves the backups are restorable, on a schedule, before an
# incident asks the question.
#
# docs/10 §8 and the nightly job in §6: "backup-restore verification". A backup
# that has never been restored is a hypothesis, and the moment you discover it is
# wrong is the moment you needed it. This restores to a SCRATCH instance on an
# alternate port — never onto the live data directory — brings it up, and then
# checks the things that actually matter clinically:
#
#   1. the database starts and accepts connections;
#   2. the schema is at the expected migration version;
#   3. row counts on the tenancy, identity and audit tables are non-zero;
#   4. RLS is still enabled on every table (a restore that loses policies is
#      worse than no restore — it comes back up looking healthy and leaking);
#   5. the audit hash chain still verifies, which is what makes the restored
#      copy admissible rather than merely present.
#
# Exit codes: 0 pass · 1 restore failed · 2 verification failed.
set -Eeuo pipefail

STANZA="${STANZA:-vimshms}"
RESTORE_PATH="${RESTORE_PATH:-/data/pg-restore}"
RESTORE_PORT="${RESTORE_PORT:-5433}"
TARGET_TIME="${TARGET_TIME:-}"          # empty = latest
REPORT="${REPORT:-/var/log/vims/restore-drill-$(date +%Y%m%dT%H%M%S).log}"

log()  { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$REPORT"; }
fail() { log "FAIL: $*"; exit "${2:-2}"; }

mkdir -p "$(dirname "$REPORT")"
log "restore drill starting — stanza=$STANZA target=${TARGET_TIME:-latest} path=$RESTORE_PATH port=$RESTORE_PORT"

# ── 0. the repository must be reachable before anything else ────────────────
pgbackrest --stanza="$STANZA" check || fail "pgbackrest check failed (archive command or repo unreachable)" 1
pgbackrest --stanza="$STANZA" info  | tee -a "$REPORT"

# ── 1. restore to a scratch directory, never the live one ───────────────────
if [ -d "$RESTORE_PATH" ] && [ "$(ls -A "$RESTORE_PATH" 2>/dev/null)" ]; then
  log "clearing previous drill data at $RESTORE_PATH"
  rm -rf "${RESTORE_PATH:?}/"*
fi
mkdir -p "$RESTORE_PATH"

restore_args=(--stanza="$STANZA" --delta --pg1-path="$RESTORE_PATH")
if [ -n "$TARGET_TIME" ]; then
  restore_args+=(--type=time --target="$TARGET_TIME" --target-action=promote)
fi
pgbackrest "${restore_args[@]}" restore || fail "restore failed" 1

# ── 2. start on an alternate port so the live instance is untouched ─────────
pg_ctl -D "$RESTORE_PATH" -o "-p $RESTORE_PORT" -w -t 300 start || fail "restored instance did not start" 1
trap 'pg_ctl -D "$RESTORE_PATH" -m immediate stop >/dev/null 2>&1 || true' EXIT

psql_r() { psql -p "$RESTORE_PORT" -d vims_hms -tAX -c "$1"; }

# ── 3. schema is at the expected version ────────────────────────────────────
applied=$(psql_r "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL" || echo 0)
[ "$applied" -ge 8 ] || fail "expected >= 8 applied migrations, found $applied"
log "migrations applied: $applied"

# ── 4. the data is actually there ───────────────────────────────────────────
for table in core.hospitals core.branches core.users core.roles core.permissions; do
  n=$(psql_r "SELECT count(*) FROM $table")
  [ "$n" -gt 0 ] || fail "$table is empty in the restored copy"
  log "$table rows: $n"
done

# ── 5. RLS survived the restore ─────────────────────────────────────────────
# A restore that comes back without policies looks healthy and leaks silently,
# which is the worst possible failure mode for a multi-tenant database.
no_rls=$(psql_r "SELECT count(*) FROM core.v_rls_coverage WHERE NOT rls_enabled")
[ "$no_rls" = "0" ] || fail "$no_rls table(s) have no row-level security after restore"
open=$(psql_r "SELECT count(DISTINCT table_name) FROM core.v_rls_open_policies")
[ "$open" = "2" ] || fail "expected exactly 2 unrestricted catalogues, found $open"
log "RLS intact: 0 tables unprotected, $open sanctioned open catalogues"

# ── 6. the audit chain still verifies ───────────────────────────────────────
# This is what makes the restored copy admissible rather than merely present.
findings=$(psql_r "
  SELECT coalesce(sum(n), 0) FROM (
    SELECT count(*) AS n
      FROM core.hospitals h,
           LATERAL core.verify_audit_chain(h.id, now() - interval '90 days', now())
  ) s")
[ "$findings" = "0" ] || fail "audit chain verification reported $findings finding(s) in the restored copy"
log "audit chain verifies clean"

log "restore drill PASSED"
