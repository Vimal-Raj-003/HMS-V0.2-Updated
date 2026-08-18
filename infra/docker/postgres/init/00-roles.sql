-- ─────────────────────────────────────────────────────────────────────────────
-- Vim's HMS — database roles
--
-- docs/04 §6 requires least-privilege database roles: "app role cannot DDL;
-- separate migration role; read-only analytics role". docs/03 §RLS requires the
-- application role to be subject to RLS, which means it must NOT own the tables
-- (an owner implicitly bypasses RLS) and must NOT have BYPASSRLS.
--
-- This is the single most important file in the deployment: if `hms_app` ever
-- gains ownership or BYPASSRLS, every tenant-isolation guarantee in the product
-- silently evaporates while all the tests still pass. An integration test
-- asserts these properties (docs/09 §3.1 case 5).
-- ─────────────────────────────────────────────────────────────────────────────

-- Schema owner / migration role. Runs `prisma migrate`. May DDL.
-- Bypasses RLS *because it owns the tables* — migrations must see every row.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hms_migrator') THEN
    CREATE ROLE hms_migrator LOGIN PASSWORD 'hms_migrator_dev' CREATEDB;
  END IF;
END
$$;

-- Application role used by every service. NOBYPASSRLS is explicit and load-bearing.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hms_app') THEN
    CREATE ROLE hms_app LOGIN PASSWORD 'hms_app_dev' NOBYPASSRLS NOCREATEDB NOCREATEROLE NOSUPERUSER;
  END IF;
END
$$;

-- Read-only role for analytics / reporting / auditor workspace (docs/07 §6 stage 2).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hms_readonly') THEN
    CREATE ROLE hms_readonly LOGIN PASSWORD 'hms_readonly_dev' NOBYPASSRLS NOCREATEDB NOCREATEROLE NOSUPERUSER;
  END IF;
END
$$;

-- Retention/archival role. The ONLY role permitted to detach audit partitions
-- (EN-024 §3.4 point 4). Deliberately separate from hms_app so the application
-- cannot destroy audit history even if compromised.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hms_retention') THEN
    CREATE ROLE hms_retention LOGIN PASSWORD 'hms_retention_dev' NOBYPASSRLS NOCREATEDB NOCREATEROLE NOSUPERUSER;
  END IF;
END
$$;

GRANT CONNECT ON DATABASE vims_hms TO hms_app, hms_readonly, hms_retention;
ALTER DATABASE vims_hms OWNER TO hms_migrator;

-- Nobody gets anything by default; every grant is explicit in the migration.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO hms_app, hms_readonly, hms_retention;

-- ─────────────────────────────────────────────────────────────────────────────
-- Per-role runtime settings (docs/07 §5)
--
-- These are role *attributes*, so they are set here by the superuser rather than
-- by a migration: ALTER ROLE needs CREATEROLE plus ADMIN OPTION on the target,
-- and a migration role that could alter roles could escalate itself.
-- ─────────────────────────────────────────────────────────────────────────────

-- An interactive query running past 15 s is a defect, and letting it run holds a
-- snapshot open — the main cause of bloat on append-only tables like audit_log
-- and vitals (docs/07 §5).
ALTER ROLE hms_app SET statement_timeout = '15s';
ALTER ROLE hms_app SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE hms_app SET lock_timeout = '5s';

-- Reports legitimately take longer and run against a read replica.
ALTER ROLE hms_readonly SET statement_timeout = '120s';
ALTER ROLE hms_readonly SET idle_in_transaction_session_timeout = '60s';

-- Archival detaches whole partitions and must never be cut off mid-operation.
ALTER ROLE hms_retention SET statement_timeout = '0';
ALTER ROLE hms_retention SET idle_in_transaction_session_timeout = '300s';

-- `ext.` functions (gin_trgm_ops, digest, ltree operators) must resolve without
-- qualification in application SQL.
ALTER ROLE hms_app       SET search_path = "$user", public, ext;
ALTER ROLE hms_readonly  SET search_path = "$user", public, ext;
ALTER ROLE hms_retention SET search_path = "$user", public, ext;
ALTER ROLE hms_migrator  SET search_path = "$user", public, ext;
