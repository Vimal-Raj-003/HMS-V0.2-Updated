# Runbook — PrintAgentDown

**Severity P2 · pages hospital-it** (P1 during OPD peak)

A print agent has not sent a heartbeat in five minutes.

## Impact
The agent runs on the hospital LAN because printers do (`docs/01` §1). While it is down,
**jobs stay queued rather than failing** and the UI offers "print elsewhere" (`docs/01` §7).
Nothing is lost. But at an OPD counter, no token slip means no queue, and the waiting
room degrades within minutes — which is why this is P1 during peak.

## First five minutes
1. Which agent and which counter? `core.print_agents` last heartbeat and its workstation
   mapping.
2. Is it the agent process, the machine, or the network segment? Printers sit on their own
   VLAN (`docs/10` §5); a VLAN problem takes out several agents at once.
3. Tell the counter to use the "print elsewhere" option against a working printer — this
   is a one-click operation and should be the first thing said to them, before diagnosis.
4. Restart the agent service on that workstation.

## Then
Queued jobs flush automatically on reconnect. Verify the count drains rather than assuming;
a job that has exhausted its 10-minute retry window will have failed and needs reprinting.

## Escalation
Hospital IT during business hours. During OPD peak treat as P1 and get someone to the
counter physically — a walk to the machine is usually faster than remote diagnosis.
