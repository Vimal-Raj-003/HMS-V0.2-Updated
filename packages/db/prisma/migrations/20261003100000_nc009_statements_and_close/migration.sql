-- ═════════════════════════════════════════════════════════════════════════════
-- NC-009 §3.3 · Closing a period, and the statements that come out of it
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Phase 9A.3. The ledger balances and receives postings; what it could not do
-- was be closed or read as a set of accounts. This adds both.
--
-- ── The close checklist is a trigger, not a checklist ─────────────────────
--
-- NC-009 §3.8 asks for a "period-close checklist with sub-ledger locking". A
-- checklist is a document somebody ticks. The failure it is meant to prevent —
-- closing a month while money earned in it has not reached the ledger — is
-- silent, permanent and discovered at audit, so §B makes the checks a
-- precondition of the status change rather than a page in a runbook.
--
-- Two things must be true to close:
--
--   1. No draft journal in the period. A draft is an entry somebody started
--      and did not finish; closing over it means it can never be posted where
--      it belongs.
--   2. No money event dated in the period that has not reached a journal.
--      This is the one that matters. The poster runs every two minutes, so the
--      window is small — but "small" is exactly how a month gets closed thirty
--      seconds before the last receipt of the day posts, and the revenue lands
--      nowhere.
--
-- ── And the statements are views ──────────────────────────────────────────
--
-- Not a report builder, not a service method: `v_profit_and_loss` and
-- `v_balance_sheet` are SQL, so a controller with `psql`, an auditor with a
-- read-only login and the API all get the same numbers. `docs/07` §6 wants
-- heavy dashboards reading from views rather than from N live joins, and a
-- balance sheet assembled differently by each caller is how two people in one
-- meeting quote different figures.
--
-- §A  The statements
-- §B  What must be true before a period closes
-- §C  Grants

-- ═════════════════════════════════════════════════════════════════════════════
-- §A. THE STATEMENTS
-- ═════════════════════════════════════════════════════════════════════════════

/**
 * Profit and loss.
 *
 * Signed so that a positive number always means "this made money": income is
 * credit-normal, so its natural balance is negative in debit-minus-credit
 * terms, and flipping it here means nobody downstream has to remember which
 * way round each account type runs. That memory is where sign errors live.
 */
CREATE OR REPLACE VIEW finance.v_profit_and_loss AS
SELECT
  j.book_id,
  j.hospital_id,
  p.fiscal_year_id,
  p.id                AS fiscal_period_id,
  a.account_type,
  l.account_id,
  a.code              AS account_code,
  a.name              AS account_name,
  CASE a.account_type
    WHEN 'income'  THEN sum(l.credit) - sum(l.debit)
    ELSE                sum(l.debit)  - sum(l.credit)
  END                 AS amount
FROM finance.journal_lines l
JOIN finance.journals j       ON j.id = l.journal_id
JOIN finance.fiscal_periods p ON p.id = j.fiscal_period_id
JOIN finance.accounts a       ON a.id = l.account_id
WHERE j.status IN ('posted', 'reversed')
  AND a.account_type IN ('income', 'expense')
GROUP BY j.book_id, j.hospital_id, p.fiscal_year_id, p.id,
         a.account_type, l.account_id, a.code, a.name;

COMMENT ON VIEW finance.v_profit_and_loss IS
  'NC-009 §3.8: income and expense by account and period, signed so a positive amount always means the account made money.';


/**
 * The balance sheet, as at the end of a fiscal year.
 *
 * `retained_earnings_current` is not stored anywhere — it is income less
 * expense for the year, computed here. A hospital that posted it as a journal
 * would double-count it the moment the year rolled over, which is the classic
 * way a balance sheet stops balancing in February.
 *
 * It balances by construction, and the reason is worth stating: every journal
 * has debits equal to credits, so summing `debit - credit` across *all*
 * accounts is zero. Rearranged, that is
 *
 *     assets = liabilities + equity + (income - expense)
 *
 * which is the balance sheet. The deferred constraint in the previous
 * migration is therefore what makes this view true, not an assertion made here.
 */
CREATE OR REPLACE VIEW finance.v_balance_sheet AS
WITH signed AS (
  SELECT
    j.book_id,
    j.hospital_id,
    p.fiscal_year_id,
    a.account_type,
    sum(l.debit) - sum(l.credit) AS net_debit
  FROM finance.journal_lines l
  JOIN finance.journals j       ON j.id = l.journal_id
  JOIN finance.fiscal_periods p ON p.id = j.fiscal_period_id
  JOIN finance.accounts a       ON a.id = l.account_id
  WHERE j.status IN ('posted', 'reversed')
  GROUP BY j.book_id, j.hospital_id, p.fiscal_year_id, a.account_type
)
SELECT
  book_id,
  hospital_id,
  fiscal_year_id,
  coalesce(sum(net_debit)  FILTER (WHERE account_type = 'asset'), 0)      AS assets,
  coalesce(-sum(net_debit) FILTER (WHERE account_type = 'liability'), 0)  AS liabilities,
  coalesce(-sum(net_debit) FILTER (WHERE account_type = 'equity'), 0)     AS equity,
  coalesce(-sum(net_debit) FILTER (WHERE account_type = 'income'), 0)
    - coalesce(sum(net_debit) FILTER (WHERE account_type = 'expense'), 0) AS retained_earnings_current
FROM signed
GROUP BY book_id, hospital_id, fiscal_year_id;

COMMENT ON VIEW finance.v_balance_sheet IS
  'NC-009 §3.8: assets, liabilities, equity and the year''s retained earnings. Balances by construction — assets = liabilities + equity + profit follows from every journal balancing.';


-- ═════════════════════════════════════════════════════════════════════════════
-- §B. WHAT MUST BE TRUE BEFORE A PERIOD CLOSES
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION finance.a_period_closes_only_when_settled()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_drafts int; v_unposted int; v_book uuid;
BEGIN
  -- Only the open → closed/locked transition is gated. Reopening is a
  -- controller's decision and is audited; re-closing runs these checks again.
  IF NOT (OLD.status = 'open' AND NEW.status IN ('closed', 'locked')) THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO v_drafts
    FROM finance.journals
   WHERE fiscal_period_id = NEW.id AND status = 'draft';

  IF v_drafts > 0 THEN
    RAISE EXCEPTION
      'The period % to % has % unfinished journal(s) (NC-009 §B). Post them or discard them: a draft left behind a closed period can never be posted where it belongs.',
      NEW.starts_on, NEW.ends_on, v_drafts USING ERRCODE = 'NC009';
  END IF;

  -- Money earned in this period that has not reached the ledger. The poster
  -- runs every two minutes, so this is usually zero — and "usually" is exactly
  -- how a month gets closed thirty seconds before the day's last receipt posts.
  SELECT count(*) INTO v_unposted
    FROM core.outbox_events e
    JOIN finance.books b
      ON b.hospital_id = e.hospital_id AND b.id = NEW.book_id
   WHERE e.occurred_at::date BETWEEN NEW.starts_on AND NEW.ends_on
     AND e.event_type IN (SELECT DISTINCT event_type FROM finance.posting_rules WHERE active = true)
     AND NOT EXISTS (
       SELECT 1 FROM finance.journals j
        WHERE j.book_id = b.id
          AND j.source_module = 'outbox'
          AND j.source_event = e.event_type
          AND j.source_ref_id = e.id
     );

  IF v_unposted > 0 THEN
    RAISE EXCEPTION
      'The period % to % has % money event(s) that have not reached the ledger (NC-009 §B). Closing now would leave that revenue in no month at all. Wait for the posting job, or read the finance exception worklist for the ones it could not post.',
      NEW.starts_on, NEW.ends_on, v_unposted USING ERRCODE = 'NC009';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_a_period_closes_only_when_settled
  BEFORE UPDATE OF status ON finance.fiscal_periods
  FOR EACH ROW EXECUTE FUNCTION finance.a_period_closes_only_when_settled();


-- A locked period is final. `closed` is a controller's working state and may be
-- reopened; `locked` is what a filed return rests on, and reopening it would
-- change numbers somebody has already submitted to the government.
CREATE OR REPLACE FUNCTION finance.a_locked_period_stays_locked()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'locked' AND NEW.status <> 'locked' THEN
    RAISE EXCEPTION
      'The period % to % is locked (NC-009 §B). A locked period is what a filed return rests on; reopening it would change a number somebody has already submitted. Post a correcting entry in the current period instead.',
      OLD.starts_on, OLD.ends_on USING ERRCODE = 'NC009';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_a_locked_period_stays_locked
  BEFORE UPDATE OF status ON finance.fiscal_periods
  FOR EACH ROW EXECUTE FUNCTION finance.a_locked_period_stays_locked();


-- ═════════════════════════════════════════════════════════════════════════════
-- §C. GRANTS
-- ═════════════════════════════════════════════════════════════════════════════
GRANT SELECT ON finance.v_profit_and_loss TO hms_app, hms_readonly;
GRANT SELECT ON finance.v_balance_sheet   TO hms_app, hms_readonly;
