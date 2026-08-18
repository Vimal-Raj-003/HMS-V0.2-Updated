-- ─────────────────────────────────────────────────────────────────────────────
-- Vim's HMS — extension matrix (docs/03 §Engine & version)
--
-- Each extension is created only if the server actually has it available, and
-- the outcome is recorded so the application can degrade knowingly rather than
-- crash on a managed provider that does not offer pg_partman or pg_cron
-- (docs/02 §1 promises Neon/RDS/Supabase as valid providers). See ADR-0008.
-- ─────────────────────────────────────────────────────────────────────────────
\connect vims_hms

-- `core`, `mdm`, `integration` and `analytics` are owned by Prisma migrations.
-- Infrastructure creates only `ext`, which holds the extensions.
CREATE SCHEMA IF NOT EXISTS ext AUTHORIZATION hms_migrator;

-- Capability register: the application reads this at boot to decide whether the
-- worker owns partition maintenance (always) and whether pg_cron can be used
-- for scheduling (optional).
CREATE TABLE IF NOT EXISTS ext.db_capabilities (
  extension     text PRIMARY KEY,
  available     boolean NOT NULL,
  installed     boolean NOT NULL,
  installed_version text,
  required      boolean NOT NULL,
  note          text,
  checked_at    timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE
  ext_name     text;
  ext_schema   text;
  is_required  boolean;
  is_available boolean;
  ver          text;
  -- name, target schema, required?
  specs        text[][] := ARRAY[
    ['pgcrypto',            'ext',  'true' ],  -- column encryption, digests (docs/04 §4)
    ['citext',              'ext',  'true' ],  -- emails, usernames (docs/03)
    ['pg_trgm',             'ext',  'true' ],  -- patient/drug fuzzy search (docs/07 §4)
    ['btree_gist',          'ext',  'true' ],  -- bed-occupancy & effective-range exclusions
    ['ltree',               'ext',  'true' ],  -- group→hospital→branch→unit (EN-041 §3.1)
    ['uuid-ossp',           'ext',  'false'],  -- UUIDv7 is generated in app code; this is a fallback
    ['pg_stat_statements',  'ext',  'false'],  -- EXPLAIN/perf gate (docs/07 §5)
    ['vector',              'ext',  'false'],  -- pgvector: created now, unused until Phase 12
    ['pg_partman',          'ext',  'false'],  -- optional: worker does partitioning either way
    ['pg_cron',             'ext',  'false'],  -- optional: BullMQ repeatable jobs are the fallback
    ['pgaudit',             'ext',  'false']   -- optional defence-in-depth alongside core.audit_log
  ];
  i int;
BEGIN
  FOR i IN 1 .. array_length(specs, 1) LOOP
    ext_name    := specs[i][1];
    ext_schema  := specs[i][2];
    is_required := specs[i][3]::boolean;

    SELECT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = ext_name) INTO is_available;

    IF is_available THEN
      -- pg_cron and pgaudit insist on living in the schema they choose.
      IF ext_name IN ('pg_cron', 'pgaudit') THEN
        EXECUTE format('CREATE EXTENSION IF NOT EXISTS %I', ext_name);
      ELSE
        EXECUTE format('CREATE EXTENSION IF NOT EXISTS %I SCHEMA %I', ext_name, ext_schema);
      END IF;
      SELECT extversion INTO ver FROM pg_extension WHERE extname = ext_name;
    ELSE
      ver := NULL;
      IF is_required THEN
        RAISE EXCEPTION
          'Required extension "%" is not available on this server. Vim''s HMS cannot run without it (docs/03).',
          ext_name;
      ELSE
        RAISE NOTICE
          'Optional extension "%" unavailable — the application will use its documented fallback (ADR-0008).',
          ext_name;
      END IF;
    END IF;

    INSERT INTO ext.db_capabilities (extension, available, installed, installed_version, required, note)
    VALUES (ext_name, is_available, ver IS NOT NULL, ver, is_required,
            CASE WHEN is_available THEN NULL ELSE 'unavailable on this server; using documented fallback' END)
    ON CONFLICT (extension) DO UPDATE
      SET available = EXCLUDED.available,
          installed = EXCLUDED.installed,
          installed_version = EXCLUDED.installed_version,
          required = EXCLUDED.required,
          note = EXCLUDED.note,
          checked_at = now();
  END LOOP;
END
$$;

-- `ext` must be on the search path for every role that uses citext/gen_random_uuid.
ALTER DATABASE vims_hms SET search_path TO "$user", public, ext;

GRANT USAGE ON SCHEMA ext TO hms_app, hms_readonly, hms_retention;
GRANT SELECT ON ext.db_capabilities TO hms_app, hms_readonly;
