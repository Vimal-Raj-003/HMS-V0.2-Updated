# Runbook — AuthBypassAttempt

**Severity P1 · pages security-oncall, dpo**

More than 20 cross-tenant or unregistered-permission denials in five minutes.

## Impact
None directly — these requests were **refused**. Row-level security and the policy engine
did their job, and a cross-tenant read returns 404 rather than 403 so it does not even
confirm the record exists. The alert exists because the *pattern* matters.

## First five minutes
1. Group the denials by actor, source IP and reason.
   - `tenant_mismatch` in bulk from one session → enumeration attempt.
   - `unregistered_permission` in bulk → far more likely a deploy that shipped a route
     referencing a key that is not in the catalogue. Check `PermissionRegistryService`
     drift on boot and the last deploy.
2. Is it one user, one IP, or spread? A single service account is usually a misconfigured
   integration, not an attacker.
3. Check the audit log for the same actor: successful reads adjacent to the denials are
   the thing to worry about.

## Then
If it is a code defect, the fix is a deploy. If it is genuine probing, preserve the audit
window (it is append-only and hash-chained, so it cannot be tampered with, but export it
for the incident record) and follow `docs/04`'s security-incident path.

## Escalation
Security on-call and the DPO.
