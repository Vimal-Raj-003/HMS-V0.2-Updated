# ADR-0002 — PostgreSQL 17 as the core; Supabase only as an optional managed provider

**Status:** Accepted · 2026-08-17

## Context

The reference stack the founder was considering used Supabase as the platform (auth, storage, edge functions, RLS).
Vim's HMS must also run entirely inside hospitals, speak HL7 v2 over MLLP and ASTM over serial/TCP to lab
analyzers, run heavy stateful background work, and satisfy enterprise/government audit requirements.

## Decision

PostgreSQL 17 (minimum 16) as the database, accessed with Prisma + Kysely. Authentication, storage and scheduling
are our own services. Supabase, Neon, RDS, Azure Flexible Server or Cloud SQL may host the database for a cloud
tenant, because we depend only on standard PostgreSQL features plus common extensions.

## Consequences

- On-prem, hybrid and cloud deployments share one codebase.
- We own auth complexity (SSO/LDAP, 2FA policy, break-glass, device sessions) — which hospitals require anyway.
- No vendor lock-in on the most expensive-to-migrate layer.
- Version policy: start on 17, revisit 18 by ADR once the provider and extension matrix is green.
