# Runbook — RedisMemoryPressure

**Severity P2 · pages platform-oncall**

Redis is above 85 % of `maxmemory`, or has evicted at least one key.

## Impact
**Any eviction is a defect, not a threshold.** `maxmemory-policy` is set to `noeviction`
precisely so that BullMQ job payloads and the refresh-token denylist are never silently
dropped. If keys are being evicted, that policy has been lost — check the running config
before anything else.

Evicted job data means a queued notification, PDF or claim simply vanishes with no error.
Evicted denylist entries mean a revoked refresh token becomes valid again.

## First five minutes
1. `CONFIG GET maxmemory-policy` on every node. It must be `noeviction`.
2. `INFO memory` — used vs max, and `evicted_keys`.
3. What is consuming it? Usually a queue that stopped being drained (see the queue
   runbooks) rather than genuine growth.
4. Redis is a cache and a queue, and jobs are recoverable from the outbox, so Redis is
   **not** part of the RPO (`docs/10` §8). Flushing is survivable; evicting silently is not.

## Escalation
Platform on-call. If the policy was found to be anything other than `noeviction`, treat it
as a configuration incident and check whether any job data was lost during the window.
