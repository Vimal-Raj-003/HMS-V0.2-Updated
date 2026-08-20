# ADR-0007 — Deterministic CDSS first; LLM assistance strictly on top

**Status:** Accepted · 2026-08-17

## Context

Medication safety is the highest-consequence function in the system. LLMs are useful but non-deterministic and
cannot be validated the way a rule can.

## Decision

EN-029 is a deterministic, versioned, testable rules engine built in Phase 2: allergy, interaction, duplicate
therapy, dose range, renal/hepatic/paediatric adjustment, pregnancy category, statutory guardrails, critical
values, NEWS2, sepsis screening. AI-002 (Phase 12) may add suggestions but may never suppress, delay, downgrade or
re-rank a deterministic alert. A defined set of hard-stops cannot be disabled by configuration, enforced by tests.

## Consequences

- The system is safe and auditable before any AI exists.
- Regulatory position is clean: decision support with mandatory human confirmation, not a diagnostic device.
- Rule authoring, versioning and clinical sign-off become a product feature, not a code deployment.
