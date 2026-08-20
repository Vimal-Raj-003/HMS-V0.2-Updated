# Runbook — ConnectorCircuitOpen

**Severity P2 · pages integration-owner**

An integration connector's circuit breaker has been open for five minutes.

## Impact
Traffic to that partner is being refused rather than retried, which is deliberate: an open
circuit stops a failing downstream from consuming the whole retry budget. What it means
clinically depends on the connector:
- **Analyzer / PACS** — results are not flowing automatically. **The manual result-entry
  path is always available** (`docs/01` §7) and the interface backlog replays on recovery.
  Tell the lab or radiology that they are on manual entry; do not let them discover it.
- **ABDM / payer** — queues with retry; the UI shows a "pending external" badge.
- **SMS / WhatsApp** — patient notifications delayed.

## First five minutes
1. `integration.ihub_circuit_state` for the connector: consecutive failures and
   `next_probe_at`.
2. `integration.ihub_messages` for the last failures — the redacted error text says
   whether it is auth, network or a payload rejection.
3. Is the partner actually down, or did a credential expire? Credential expiry is the
   most common cause and the least obvious from the error.
4. Check the DLQ for the same connector.

## Then
The breaker half-opens automatically and closes on a successful probe. Do not force it
closed while the downstream is still failing — that is what the breaker is preventing.

## Escalation
Integration owner → hospital lab/radiology IT for device interfaces.
