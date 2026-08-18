-- ─────────────────────────────────────────────────────────────────────────────
-- Shadow database for `prisma migrate dev`
--
-- Prisma validates every migration by replaying it against a throwaway database.
-- Ours cannot be throwaway: the migrations legitimately reference
-- `ext.gin_trgm_ops` (trigram indexes, docs/07 §4) and `ext.create_parent`
-- (pg_partman). A database Prisma creates for itself would have neither, so a
-- perfectly correct migration would fail validation for an unrelated reason.
--
-- This is a *development and CI* concern only. `prisma migrate deploy`, which is
-- what runs in staging and production (docs/10 §5), uses no shadow database at
-- all — it applies the already-reviewed SQL directly.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE DATABASE vims_hms_shadow OWNER hms_migrator;

\connect vims_hms_shadow

CREATE SCHEMA IF NOT EXISTS ext AUTHORIZATION hms_migrator;

-- The same extension set as the real database (01-extensions.sql), minus the
-- ones needing shared_preload_libraries — a shadow database never runs jobs.
DO $$
DECLARE
  ext_name text;
  wanted   text[] := ARRAY['pgcrypto', 'citext', 'pg_trgm', 'btree_gist', 'ltree', 'vector', 'pg_partman'];
BEGIN
  FOREACH ext_name IN ARRAY wanted LOOP
    IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = ext_name) THEN
      EXECUTE format('CREATE EXTENSION IF NOT EXISTS %I SCHEMA ext', ext_name);
    END IF;
  END LOOP;
END
$$;

GRANT USAGE ON SCHEMA ext TO hms_app, hms_readonly, hms_retention;
ALTER DATABASE vims_hms_shadow SET search_path TO "$user", public, ext;
