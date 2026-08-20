# Runbook — DeadLetterQueueGrowth

**Severity P2 · pages integration-owner** (P1 for a new fingerprint on a clinical connector)

The integration dead-letter queue is above 500 messages.

## Impact

Messages in the DLQ have exhausted their retries and are going nowhere until somebody acts.
For a clinical connector this means results, orders or claims are not arriving, and the
sending system usually believes they were delivered.

## First five minutes

1. Group by fingerprint (`errorClass` + code + mapping path). One fingerprint at 500 is
   one bug; 500 fingerprints is a downstream outage.
2. Is the connector clinical? A new fingerprint on a clinical connector is P1 regardless
   of depth — one lost result matters more than 500 lost marketing messages.
3. Read one redacted payload and its error. Payloads are stored **redacted** (identifiers
   masked, structured messages reduced to their shape), so this is safe to look at.
4. Distinguish a _semantic_ rejection (the partner refused the content — a mapping bug)
   from a _transport_ failure (retryable, should not be here).

## Then

Fix the cause, then **replay** — replay creates a new message carrying the original
idempotency key and a `parent_message_id`, so a partner that already processed it will
deduplicate rather than double-post.

## Escalation

Integration owner. For a clinical connector, also tell the department that their interface
has been down since the first failure timestamp, not since the alert.
