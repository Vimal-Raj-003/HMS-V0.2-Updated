# ─────────────────────────────────────────────────────────────────────────────
# Vim's HMS — PostgreSQL 17 with the extension matrix from docs/03 §Extensions.
#
# The stock `postgres:17` image ships only the contrib extensions, so pgvector,
# pg_partman and pg_cron have to be added. Building them here (rather than
# picking a third-party bundle) keeps the on-prem image, the CI image and the
# developer image byte-identical, which is what makes an EXPLAIN plan captured
# on a laptop meaningful in a hospital.
#
# IMPORTANT (docs/02 §1): the application must remain runnable on a *managed*
# Postgres that offers none of pg_partman / pg_cron — that is the promise that
# lets a cloud tenant sit on Neon/RDS/Supabase. Partition maintenance therefore
# lives in `services/worker` (queue class `maintenance`) using native
# declarative-partition DDL, and pg_partman is used only when present. See
# ADR-0008.
# ─────────────────────────────────────────────────────────────────────────────
FROM postgres:17.7-bookworm

ARG PG_MAJOR=17

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        "postgresql-${PG_MAJOR}-pgvector" \
        "postgresql-${PG_MAJOR}-partman" \
        "postgresql-${PG_MAJOR}-cron" \
        "postgresql-${PG_MAJOR}-pgaudit" \
    ; \
    rm -rf /var/lib/apt/lists/*

# pg_cron and pg_partman's BGW must be preloaded, and pg_cron needs a named
# database to keep its job table in.
ENV POSTGRES_INITDB_ARGS="--encoding=UTF8 --locale=C.UTF-8"

COPY init/ /docker-entrypoint-initdb.d/

CMD [ \
  "postgres", \
  "-c", "shared_preload_libraries=pg_stat_statements,pg_cron,pg_partman_bgw,pgaudit", \
  "-c", "cron.database_name=vims_hms", \
  "-c", "pg_partman_bgw.dbname=vims_hms", \
  "-c", "pg_partman_bgw.interval=3600", \
  "-c", "pg_partman_bgw.role=hms_migrator", \
  "-c", "pg_stat_statements.track=all", \
  "-c", "timezone=UTC" \
]
