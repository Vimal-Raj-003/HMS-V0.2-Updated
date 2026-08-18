# ADR-0003 — Row-level security for multi-tenancy, with escalation levers

**Status:** Accepted · 2026-08-17

## Context
Vim's HMS serves hospital groups with many branches, and enterprise customers who may demand physical isolation.

## Decision
Default: one database, `hospital_id` (+ `branch_id`) on every business table, PostgreSQL RLS policies driven by
`SET LOCAL app.hospital_id` inside every request transaction, plus an application-level tenant guard (defence in
depth). Escalation levers available per customer without code change: dedicated schema, dedicated database, or a
fully dedicated stack.

## Consequences
- Cross-branch features (shared patient master index, group reporting) are natural.
- A bug in the tenant guard is still contained by RLS, and vice versa — both are tested with negative tests in CI.
- Migrations run under a role that bypasses RLS; the application role can never DDL.
