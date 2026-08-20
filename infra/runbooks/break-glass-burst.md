# Runbook — BreakGlassBurst

**Severity P1 · pages security-oncall, dpo**

More than three break-glass record opens in one hour.

## Impact

Break-glass lets any clinician open a chart outside their care team by entering a reason
(`docs/05`). It is legitimate and it is meant to be rare. A burst is one of two things:
a genuine mass-casualty event, or somebody browsing records.

Both need the same first action, and neither is an IT decision.

## First five minutes

1. Pull the `READ_PHI` audit rows for the window: actor, patients, reasons, and whether
   the same actor or many.
2. **One actor, many unrelated patients** → treat as a privacy incident, not an outage.
3. **Many actors, patients arriving together** → almost certainly a real emergency. Note
   it in the incident record and stop; the control worked as designed.
4. Check whether the reasons are substantive. `"."` or `"test"` is itself a finding.

## Then

The Privacy Officer reviews break-glass daily as standing practice (`docs/05`); this alert
only shortens the loop. DPDP Act 2023 obligations apply if unauthorised access is confirmed —
see `docs/04` for the breach path and the 72-hour reporting clock.

## Escalation

Security on-call **and** the DPO. Do not revoke the clinician's access before the DPO has
looked: locking a doctor out mid-emergency is its own patient-safety event.
