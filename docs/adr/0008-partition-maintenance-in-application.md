# ADR-0008 — Partition maintenance lives in the application, not in pg_partman

**Status:** Accepted · **Date:** 2026-08-17 · **Phase:** 0

## Context

`docs/03 §Extensions` lists `pg_partman` in the extension matrix, and `docs/07 §4`
specifies monthly partitioning for thirteen tables with "premake 3 months ahead;
detach-and-archive rather than `DELETE`".

But `docs/02 §1` makes a load-bearing commercial promise:

> "because we depend only on _standard PostgreSQL_ + RLS, a pure-cloud tenant can
> be hosted on **Supabase, Neon, RDS, Azure Flexible Server or Cloud SQL** by
> changing `DATABASE_URL`."

Those two statements are in tension. `pg_partman` requires a background worker in
`shared_preload_libraries`, and `pg_cron` requires the same. Neon offers neither.
RDS offers `pg_partman` only on some versions and `pg_cron` with configuration.
Supabase offers both but on its own terms. A hard dependency on either would mean
the sentence above is false, and we would only discover that during a customer's
procurement process.

Separately, `CREATE EXTENSION pg_cron` needs superuser, which the migration role
deliberately does not have (`docs/04 §6`: "app role cannot DDL; separate migration
role").

## Decision

**Partition maintenance is owned by the application.** `services/worker`, in the
`maintenance` queue class (`docs/07 §4`), calls a plain SQL function
`core.ensure_month_partition(schema, table, month)` that creates the next months'
partitions using native declarative-partitioning DDL. The function is idempotent,
so a missed run is self-healing rather than an incident.

`pg_partman` is configured **when present**, as a second, independent driver. Its
absence produces a `NOTICE`, never an error.

Extensions are created by infrastructure — `infra/docker/postgres/init/01-extensions.sql`
locally, or the customer's DBA on a managed provider — into a dedicated `ext`
schema. The result is recorded in `ext.db_capabilities`, which the application
reads at boot so it can report what it actually got rather than assume.

Three supporting choices follow from this:

1. **Every partitioned table has a `DEFAULT` partition.** Without one, an `INSERT`
   whose timestamp falls outside every declared range fails. For `core.audit_log`
   that failure rolls back the clinical transaction that triggered it, because
   `EN-024 §5` makes audit writes non-optional — so a missed maintenance run or a
   clock anomaly would stop a nurse from charting. The default partition converts
   a catastrophic failure into a monitored anomaly: a non-empty default partition
   alerts and the maintenance job redistributes the rows.

2. **Storage parameters are applied to leaf partitions, not parents.** Postgres
   rejects `ALTER TABLE ... SET (fillfactor = ...)` on a partitioned parent, so
   the autovacuum profiles from `docs/07 §5` are applied by
   `core.apply_partition_storage_params()` — called both by the migration and by
   `ensure_month_partition`, so a partition created in 2029 is tuned identically
   to one created today.

3. **New partitions get RLS at creation time.** `ensure_month_partition` enables
   row-level security and creates the tenant policy on each child. Queries go
   through the parent and would inherit it anyway; this covers the direct-partition
   case (a support engineer, a restore into a scratch schema).

## Consequences

**Good**

- The product runs unmodified on any PostgreSQL 16+ instance, including managed
  services with no extension control. The `docs/02 §1` promise stays true.
- Partition creation is testable with a frozen clock in a normal integration test,
  rather than requiring a background worker to tick.
- Maintenance failures surface in the existing BullMQ dead-letter queue and
  alerting path (`docs/07 §4`), instead of in Postgres logs nobody reads.
- No superuser is needed anywhere in the migration path.

**Bad / accepted**

- We maintain ~120 lines of partition SQL that `pg_partman` would have provided.
  Mitigated by it being one function with one responsibility, covered by tests.
- Two drivers can run concurrently when `pg_partman` is present. Both are
  idempotent and `ensure_month_partition` returns early if the partition exists,
  so the race is benign — but it is a real duplication and is documented here so
  nobody "fixes" one by deleting the other.
- Retention (`detach + archive to Parquet`) is also ours to write. That was always
  true: `docs/04 §5` requires a row-level legal-hold check before detaching a
  partition, which `pg_partman` has no concept of.

**Revisit if** every target deployment profile is confirmed to support
`pg_partman` **and** the legal-hold check can be expressed inside its retention
hooks. The second condition is the harder one.
