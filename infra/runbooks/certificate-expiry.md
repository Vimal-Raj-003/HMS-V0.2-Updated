# Runbook — CertificateExpiringSoon

**Severity P2 · pages platform-oncall**

A TLS certificate expires in under 14 days.

## Impact
None yet. On expiry: every browser, every tablet, every kiosk and every device integration
stops trusting the endpoint at once. On-prem this includes analyzers and PACS modalities
that will simply stop delivering results, often without an obvious error at the device.

## Action
1. Identify the endpoint and who issues it — cloud (Cloudflare/ACME, usually automatic)
   or on-prem (frequently a hospital-issued internal CA with a manual process).
2. If renewal is automatic, find out why it has not run: ACME challenge failing, or the
   renewal job not scheduled.
3. If manual, start now. Fourteen days is chosen to survive a hospital procurement cycle,
   not because it is comfortable.
4. After renewal, verify the full chain is served — a missing intermediate works in
   browsers and fails on medical devices with older trust stores.

## Escalation
Platform on-call → hospital IT for on-prem certificates. Do not let this reach P1 by ageing.
