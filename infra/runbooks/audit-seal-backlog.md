# Runbook — AuditSealBacklog

**Severity P2 · pages platform-oncall**

More than 100,000 audit rows are unsealed.

## Impact
The audit hash chain is sealed asynchronously by a background pass (decision D-16, taken
because assigning a gapless sequence inline would hold a row lock until commit and could
block a nurse from charting). Until a row is sealed it is **not covered by the tamper
evidence** the §65B evidence chain depends on. Nothing is lost; the rows are all there.
What is missing is the proof that they have not been altered.

## First five minutes
1. `SELECT * FROM core.v_audit_seal_backlog` — per-tenant detail. One tenant or all?
2. Is the worker running, and is the sealer job scheduled? A worker that started but
   never mounted the sealer looks exactly like this.
3. `core.seal_audit_chain()` takes an advisory lock per tenant. A stuck session holding
   it blocks that tenant only — check `pg_locks`.
4. Write volume spike? At 8–15 M audit rows/day (`EN-024` §13) a backlog can be legitimate
   catch-up after an outage.

## Then
Once sealing catches up, run `core.verify_audit_chain()` over the affected window and
record the result. A clean verification is the evidence; the absence of an alert is not.

## Escalation
Platform on-call → DPO if the backlog persists beyond a day, because the tamper-evidence
gap becomes reportable.
