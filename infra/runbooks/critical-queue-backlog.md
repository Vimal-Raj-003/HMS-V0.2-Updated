# Runbook — CriticalQueueBacklog

**Severity P1 · pages platform-oncall**

The `critical` queue is deeper than 50 jobs, or its oldest job is older than 60 seconds.

## Impact
This is the queue that carries critical lab values, code-blue activations, deteriorating
NEWS2 scores and panic buttons (`docs/01` §6). A minute of delay here is a clinical event,
not an operational one.

## First five minutes
1. Is the worker alive and consuming? Check the worker's `/readyz` and the BullMQ
   `active` count, not just `waiting`.
2. Is one job poisoning the queue — failing, retrying, and blocking behind it? Look for a
   job with a high attempt count.
3. Is the delivery channel down (SMS/WhatsApp/push)? Critical alerts are delivered by
   push **and** SMS so they survive a closed browser; if both are failing, the in-app
   bell is still working and nursing should be told to watch it.
4. Redis health — see the Redis runbook. Eviction would silently drop jobs.

## Immediate mitigation
Tell the nursing supervisor. A delayed critical-value notification must be treated as an
undelivered one until proven otherwise: `EN-024` requires the read-back to be documented,
so the fallback is a phone call, and it is the correct fallback.

## Escalation
Platform on-call **and** the hospital nursing supervisor, per `docs/10` §7.1 #2.
