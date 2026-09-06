# ADR-0012 — The scheme cash block is enforced in the database and scoped to the case

- Status: accepted
- Date: 2026-09-06
- Deciders: RCM (Phase 5, RC-007)

## Context

`docs/prompts/phase-05-billing-rcm.md` §5.6 requires "**no cash collection from a
scheme beneficiary — hard block at every collection point**", and exit gate 6
restates it as "a scheme beneficiary cannot be charged cash anywhere in the
system (test all collection points)".

This matters more than most billing rules. An empanelled hospital that takes ₹500
from an Ayushman cardholder for a covered admission is in breach of its
empanelment, and the patient — told the treatment is free — has no way to know
they were overcharged. The families the rule protects are the ones least able to
challenge a receipt.

Two questions had to be answered: **where** the block lives, and **who** it
applies to.

## Decision

### 1. The block is a database trigger, not a service check

`billing.refuse_scheme_cash_tender()` fires `BEFORE INSERT OR UPDATE` on
`billing.payment_lines` and refuses any line whose `mode` is `cash` or `forex`
when the payment's patient is a blocked beneficiary.

`payment_lines` is the one table every collection point in this system must write
to. The cash counter writes one, the pharmacy window writes one, an OPD advance,
an IP deposit and a forex tender are all a `billing.payments` row with lines
beneath it. Enforcing there — rather than in each service — means a module built
in Phase 7 or Phase 9 that collects money and has never heard of RC-007 is still
refused.

Gateway tenders need no equivalent: `billing."PayMethod"` has no `cash` member,
so `pay_payments` cannot represent a banknote.

The function is `SECURITY DEFINER` with a pinned `search_path`. A non-definer
function runs under the caller's RLS, so a session whose branch scope excluded
the row recording the entitlement would see no beneficiary and be allowed to
collect. A safety control must not be evadable by narrowing your own visibility.

### 2. The block is scoped to the episode, not to the person — by default

`scheme_masters.cash_block_scope` takes one of three values:

| Scope         | Meaning                                                                     |
| ------------- | --------------------------------------------------------------------------- |
| `active_case` | Cash-free from the moment a scheme case opens until it closes. **Default.** |
| `always`      | Cash-free for this patient at all times, case or no case.                   |
| `off`         | Advisory: the attempt is recorded, the tender is allowed.                   |

The literal reading of §5.6 is `always`. Applied to the person rather than the
episode, it refuses a PMJAY cardholder buying a strip of paracetamol at the
retail window — a legal cash sale with nothing to do with the scheme.

That is not a harmless excess of caution. A cashier who meets a rule they know is
wrong routes around it: they ring the sale under a different patient, or under
none. A control that gets routed around protects nobody, and the workaround
becomes the habit that later hides a real violation.

So the default is `active_case`, and the scope is a column rather than a
constant, so a state scheme whose MoU really is absolute is configuration rather
than a migration. The seeded ESIC scheme uses `always`, which keeps that branch
of the trigger exercised by real data.

### 3. The refusal is recorded before it is refused

A raised exception takes its transaction with it, so the trigger cannot write the
evidence of its own firing. `SchemesService.checkCash()` — called by every
collection point _before_ the drawer opens — writes an append-only
`billing.scheme_cash_attempts` row and raises `scheme.cash.refused`, then the
tender fails.

The trigger is the guarantee; `checkCash` is the control's voice and its memory.
A caller that skips it is still refused, but loses the explanation for the family
at the counter and the row an audit will ask for.

An NHA audit does not ask whether you take cash from scheme patients. It asks you
to show what happened when somebody tried, and "we were asked eleven times and
refused eleven times, here they are" is only an answer if the rows cannot be
tidied up afterwards. Hence append-only at the trigger _and_ `REVOKE UPDATE,
DELETE … FROM hms_app`.

## Consequences

- Exit gate 6 is provable rather than asserted: the block was exercised at the
  cash counter, the pharmacy, an advance, an IP deposit and a forex tender, with
  UPI and card as controls, and again at the SQL level bypassing the API
  entirely.
- The screen's `blocksCash` flag duplicates the trigger's predicate in
  TypeScript. Two answers to "is this patient blocked?" would be worse than one,
  so `SchemesService.toBeneficiary()` mirrors the SQL deliberately and both are
  commented as a pair. If one changes, the other must.
- A hospital that genuinely permits a scheme co-payment sets `off` and gets an
  advisory log instead of a refusal. No such scheme is seeded.
- The block lifts when the case closes, which is why `POST /cases/:id/close`
  carries its own permission (`scheme.case.close`) and refuses while a claim is
  still with the authority.

## Alternatives considered

- **Check in each collection service.** Rejected: it is exactly the shape of rule
  that a later module forgets, and the modules that will collect money in Phases
  7–10 have not been written yet.
- **A `patients.blocks_cash` flag maintained by triggers.** Rejected: a
  denormalised safety flag is only as good as the last job that refreshed it, and
  the cost of computing it live is one indexed lookup on a path that already
  writes several rows.
- **Blocking the whole `payments` row rather than the line.** Rejected: the mode
  lives on the line, and a split tender (₹500 cash + ₹1,200 UPI) must refuse only
  the cash half so the desk can see which part is the problem.
