-- ═════════════════════════════════════════════════════════════════════════════
-- NC-009 §3.1–3.2 · The general ledger, and the rule that it balances
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Phase 9A.1. Everything in phases 4–7 moved money and none of it landed
-- anywhere a finance controller could read: bills were raised, receipts taken,
-- refunds issued, stock consumed, and the `finance` schema was empty. This is
-- the book those events post into.
--
-- ── The one rule this file exists for ─────────────────────────────────────
--
-- **A journal that does not balance cannot be committed.** Not "is rejected by
-- the service", not "is caught by a nightly report" — cannot be committed. §D
-- installs a `CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED` that sums
-- the lines at COMMIT and raises if debits and credits differ by a paisa.
--
-- Deferred is not a detail, it is the only thing that works. A journal is built
-- line by line and is unbalanced by construction until the last line lands, so
-- a row-level check would refuse the first INSERT of every correct journal ever
-- written. Checking at commit is what lets an accountant write a journal and
-- still makes an unbalanced one impossible to store.
--
-- ── Why debit and credit are two columns ──────────────────────────────────
--
-- A single signed `amount` is one column fewer and wrong for this domain. An
-- accountant reads a journal as two columns that foot to the same number, every
-- report and every export is shaped that way, and "negative debit" is not a
-- thing anybody says out loud. §B.2 makes exactly one of the pair non-zero, so
-- the shape cannot express a line that is both.
--
-- ── And why posting is idempotent by index, not by care ───────────────────
--
-- The relay delivers an outbox event at least once. A ledger that double-posts
-- a receipt on redelivery has silently invented revenue, and it is the kind of
-- error nobody finds until a period close will not tie out. §B.6 is a unique
-- index on what the journal came from, so the second delivery collides instead
-- of balancing beautifully and wrongly.
--
-- §A  The books: entities, fiscal calendar, chart of accounts, cost centres
-- §B  Journals, and what a journal may say about itself
-- §C  Turning domain events into journals
-- §D  Double entry, enforced at commit
-- §E  Grants
-- §F  Row-level security

-- ═════════════════════════════════════════════════════════════════════════════
-- §A. THE BOOKS
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE "finance"."legal_entities" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "code" VARCHAR(24) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "gstin" VARCHAR(15),
    "pan" VARCHAR(10),
    "cin" VARCHAR(21),
    "state_code" VARCHAR(2),
    "base_currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "legal_entities_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_legal_entity_code" ON "finance"."legal_entities"("hospital_id", "code");

-- A GSTIN encodes its own state in the first two characters, and an invoice
-- that disagrees with it computes the wrong place of supply — CGST/SGST where
-- it should be IGST. Checked here so the pair cannot drift apart.
ALTER TABLE "finance"."legal_entities"
  ADD CONSTRAINT "a_gstin_agrees_with_its_state"
  CHECK ("gstin" IS NULL OR "state_code" IS NULL OR left("gstin", 2) = "state_code");

ALTER TABLE "finance"."legal_entities"
  ADD CONSTRAINT "a_gstin_is_the_right_shape"
  CHECK ("gstin" IS NULL OR "gstin" ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$');


/**
 * One set of books. A hospital group runs several — one per legal entity, and
 * optionally one per branch where the branch is separately assessed.
 */
CREATE TABLE "finance"."books" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID,
    "legal_entity_id" UUID NOT NULL,
    "code" VARCHAR(24) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    -- `full_ledger` — Vim's HMS is the general ledger.
    -- `sub_ledger`  — an incumbent Tally/SAP is, and this reconciles and exports.
    -- NC-009 §3.10 requires both paths to work end to end, and the sub-ledger
    -- path must still balance internally or a reconciliation difference cannot
    -- be told from a bug.
    "mode" VARCHAR(16) NOT NULL DEFAULT 'full_ledger',
    "base_currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "books_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_book_code" ON "finance"."books"("hospital_id", "code");

ALTER TABLE "finance"."books"
  ADD CONSTRAINT "a_book_mode_is_known"
  CHECK ("mode" IS NOT NULL AND "mode" IN ('full_ledger', 'sub_ledger'));


/**
 * The fiscal calendar. India's year runs April–March, which is why this is data
 * and not `date_trunc('year', ...)` anywhere in the codebase.
 */
CREATE TABLE "finance"."fiscal_years" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "code" VARCHAR(16) NOT NULL,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "fiscal_years_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_fiscal_year_code" ON "finance"."fiscal_years"("book_id", "code");

ALTER TABLE "finance"."fiscal_years"
  ADD CONSTRAINT "a_fiscal_year_runs_forwards" CHECK ("ends_on" > "starts_on");
ALTER TABLE "finance"."fiscal_years"
  ADD CONSTRAINT "a_fiscal_year_status_is_known"
  CHECK ("status" IS NOT NULL AND "status" IN ('open', 'closed', 'locked'));

-- Two fiscal years in one book may not cover the same day. Without this a
-- posting date resolves to two periods and the trial balance depends on which
-- one the planner happened to pick.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE "finance"."fiscal_years"
  ADD CONSTRAINT "a_fiscal_years_do_not_overlap"
  EXCLUDE USING gist (
    "book_id" WITH =,
    daterange("starts_on", "ends_on", '[]') WITH &&
  );


/**
 * The month a journal lands in, and the lock that stops it landing there after
 * the books are closed.
 */
CREATE TABLE "finance"."fiscal_periods" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "fiscal_year_id" UUID NOT NULL,
    "period_no" SMALLINT NOT NULL,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE NOT NULL,
    -- open → closed reversibly by a controller; `locked` is final and is what
    -- a filed return rests on.
    "status" VARCHAR(16) NOT NULL DEFAULT 'open',
    "closed_by" UUID,
    "closed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "fiscal_periods_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_fiscal_period_no" ON "finance"."fiscal_periods"("fiscal_year_id", "period_no");
CREATE INDEX "fiscal_periods_range_idx" ON "finance"."fiscal_periods"("book_id", "starts_on", "ends_on");

ALTER TABLE "finance"."fiscal_periods"
  ADD CONSTRAINT "a_fiscal_period_runs_forwards" CHECK ("ends_on" >= "starts_on");
ALTER TABLE "finance"."fiscal_periods"
  ADD CONSTRAINT "a_fiscal_period_status_is_known"
  CHECK ("status" IS NOT NULL AND "status" IN ('open', 'closed', 'locked'));
ALTER TABLE "finance"."fiscal_periods"
  ADD CONSTRAINT "a_closed_period_names_who_closed_it"
  CHECK (("status" = 'open') OR ("closed_by" IS NOT NULL AND "closed_at" IS NOT NULL));
ALTER TABLE "finance"."fiscal_periods"
  ADD CONSTRAINT "a_fiscal_periods_do_not_overlap"
  EXCLUDE USING gist (
    "fiscal_year_id" WITH =,
    daterange("starts_on", "ends_on", '[]') WITH &&
  );


/**
 * The chart of accounts.
 *
 * `normal_balance` is derived from `account_type` by a trigger rather than
 * typed: an asset account whose normal balance somebody set to credit produces
 * a balance sheet that is wrong in a way no constraint downstream can detect,
 * and there is exactly one right answer per type.
 */
CREATE TABLE "finance"."accounts" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "parent_id" UUID,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "account_type" VARCHAR(16) NOT NULL,
    "normal_balance" CHAR(2) NOT NULL DEFAULT 'DR',
    -- A group account is a heading. Postings go to leaves only, so that a
    -- balance is the sum of its children and never partly its own.
    "is_group" BOOLEAN NOT NULL DEFAULT false,
    "is_bank_or_cash" BOOLEAN NOT NULL DEFAULT false,
    "requires_cost_centre" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_account_code" ON "finance"."accounts"("book_id", "code");
CREATE INDEX "accounts_tree_idx" ON "finance"."accounts"("book_id", "parent_id");

ALTER TABLE "finance"."accounts"
  ADD CONSTRAINT "a_account_type_is_known"
  CHECK ("account_type" IS NOT NULL
         AND "account_type" IN ('asset', 'liability', 'equity', 'income', 'expense'));
ALTER TABLE "finance"."accounts"
  ADD CONSTRAINT "a_normal_balance_is_dr_or_cr"
  CHECK ("normal_balance" IN ('DR', 'CR'));


-- `finance.cost_centres` is NOT created here. Phase 4 already built it, with a
-- richer shape than this file would have written — a hierarchy, a centre type,
-- an allocation basis and a GL expense map. Recreating it was the first draft
-- of this migration and the migration chain caught it on a fresh database,
-- which is the argument for running the whole chain rather than only the new
-- file. Cost centres are hospital-scoped, not book-scoped, so nothing here
-- needs to change about them; §B simply points at them.



-- ═════════════════════════════════════════════════════════════════════════════
-- §B. JOURNALS
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE "finance"."journals" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID,
    "book_id" UUID NOT NULL,
    "fiscal_period_id" UUID NOT NULL,
    "journal_no" VARCHAR(32),
    "journal_date" DATE NOT NULL,
    -- automatic | manual | reversal | opening | closing
    "kind" VARCHAR(16) NOT NULL DEFAULT 'automatic',
    "narration" VARCHAR(500),
    -- Where it came from. An automatic journal must name its source; §B.5.
    "source_module" VARCHAR(40),
    "source_event" VARCHAR(80),
    "source_ref_id" UUID,
    "reverses_journal_id" UUID,
    "status" VARCHAR(16) NOT NULL DEFAULT 'posted',
    "posted_by" UUID,
    "posted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "journals_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "journals_book_date_idx" ON "finance"."journals"("book_id", "journal_date");
CREATE INDEX "journals_period_idx" ON "finance"."journals"("fiscal_period_id");

-- §B.5  An automatic journal names what produced it.
ALTER TABLE "finance"."journals"
  ADD CONSTRAINT "a_automatic_journal_names_its_source"
  CHECK ("kind" <> 'automatic'
         OR ("source_module" IS NOT NULL AND "source_event" IS NOT NULL AND "source_ref_id" IS NOT NULL));

ALTER TABLE "finance"."journals"
  ADD CONSTRAINT "a_journal_kind_is_known"
  CHECK ("kind" IS NOT NULL
         AND "kind" IN ('automatic', 'manual', 'reversal', 'opening', 'closing'));

ALTER TABLE "finance"."journals"
  ADD CONSTRAINT "a_journal_status_is_known"
  CHECK ("status" IS NOT NULL AND "status" IN ('draft', 'posted', 'reversed'));

-- A reversal names what it reverses, and nothing else does.
ALTER TABLE "finance"."journals"
  ADD CONSTRAINT "a_only_a_reversal_reverses"
  CHECK (("kind" = 'reversal') = ("reverses_journal_id" IS NOT NULL));

-- §B.6  Replay safety. The relay delivers at least once; a ledger that posts a
-- receipt twice has invented revenue, and nobody finds it until a close will
-- not tie out. The second delivery collides here.
CREATE UNIQUE INDEX "uq_journal_source"
  ON "finance"."journals"("book_id", "source_module", "source_event", "source_ref_id")
  WHERE "source_ref_id" IS NOT NULL AND "kind" = 'automatic';

-- One reversal per journal, for the same reason.
CREATE UNIQUE INDEX "uq_journal_reversal"
  ON "finance"."journals"("reverses_journal_id")
  WHERE "reverses_journal_id" IS NOT NULL;


CREATE TABLE "finance"."journal_lines" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "journal_id" UUID NOT NULL,
    "line_no" SMALLINT NOT NULL,
    "account_id" UUID NOT NULL,
    "cost_centre_id" UUID,
    "debit" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "credit" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "narration" VARCHAR(500),
    -- Who the line is against, when it is a sub-ledger control account.
    "party_kind" VARCHAR(24),
    "party_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "journal_lines_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_journal_line_no" ON "finance"."journal_lines"("journal_id", "line_no");
CREATE INDEX "journal_lines_account_idx" ON "finance"."journal_lines"("account_id");

-- §B.1  Neither side is ever negative. A negative debit is a credit written by
-- somebody who did not want to move the number to the other column, and it
-- makes every sum in every report wrong in a way that still foots.
ALTER TABLE "finance"."journal_lines"
  ADD CONSTRAINT "a_journal_line_amounts_are_positive"
  CHECK ("debit" >= 0 AND "credit" >= 0);

-- §B.2  Exactly one side carries the money.
ALTER TABLE "finance"."journal_lines"
  ADD CONSTRAINT "a_journal_line_is_debit_or_credit_not_both"
  CHECK (("debit" > 0 AND "credit" = 0) OR ("credit" > 0 AND "debit" = 0));

-- A party reference is both halves or neither.
ALTER TABLE "finance"."journal_lines"
  ADD CONSTRAINT "a_party_is_named_completely"
  CHECK (("party_kind" IS NULL) = ("party_id" IS NULL));



-- Foreign keys, written the way every other migration here writes them:
-- separate statements with an explicit ON UPDATE. Postgres defaults the
-- clause to NO ACTION and `pg_get_constraintdef` then omits it, so leaving it
-- implicit reads as schema drift for ever after: Postgres never prints its own
-- default, so only an explicit CASCADE round-trips through introspection.

ALTER TABLE "finance"."books" ADD CONSTRAINT "books_legal_entity_id_fkey"
  FOREIGN KEY ("legal_entity_id") REFERENCES "finance"."legal_entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "finance"."fiscal_years" ADD CONSTRAINT "fiscal_years_book_id_fkey"
  FOREIGN KEY ("book_id") REFERENCES "finance"."books"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "finance"."fiscal_periods" ADD CONSTRAINT "fiscal_periods_fiscal_year_id_fkey"
  FOREIGN KEY ("fiscal_year_id") REFERENCES "finance"."fiscal_years"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "finance"."accounts" ADD CONSTRAINT "accounts_parent_id_fkey"
  FOREIGN KEY ("parent_id") REFERENCES "finance"."accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "finance"."journals" ADD CONSTRAINT "journals_book_id_fkey"
  FOREIGN KEY ("book_id") REFERENCES "finance"."books"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "finance"."journals" ADD CONSTRAINT "journals_fiscal_period_id_fkey"
  FOREIGN KEY ("fiscal_period_id") REFERENCES "finance"."fiscal_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "finance"."journals" ADD CONSTRAINT "journals_reverses_journal_id_fkey"
  FOREIGN KEY ("reverses_journal_id") REFERENCES "finance"."journals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "finance"."journal_lines" ADD CONSTRAINT "journal_lines_journal_id_fkey"
  FOREIGN KEY ("journal_id") REFERENCES "finance"."journals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "finance"."journal_lines" ADD CONSTRAINT "journal_lines_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "finance"."accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "finance"."journal_lines" ADD CONSTRAINT "journal_lines_cost_centre_id_fkey"
  FOREIGN KEY ("cost_centre_id") REFERENCES "finance"."cost_centres"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "finance"."posting_rules" ADD CONSTRAINT "posting_rules_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "finance"."accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ═════════════════════════════════════════════════════════════════════════════
-- §C. TURNING DOMAIN EVENTS INTO JOURNALS
-- ═════════════════════════════════════════════════════════════════════════════
--
-- The map, not a switch statement. NC-009 §3.2 wants a hospital's controller to
-- decide which account service revenue lands in without a deploy, and the
-- alternative — a `case event_type of` in a service — makes every chart-of-
-- accounts decision an engineering ticket.
CREATE TABLE "finance"."posting_rules" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "event_type" VARCHAR(80) NOT NULL,
    -- Which leg this row describes, and how much of the event's money it takes.
    "leg_no" SMALLINT NOT NULL,
    "side" CHAR(2) NOT NULL,
    "account_id" UUID NOT NULL,
    -- The field of the event payload this leg is measured from (`gross`,
    -- `tax`, `net`, `discount`…). Resolved by the poster, which refuses an
    -- amount key the event does not carry rather than posting a zero.
    "amount_key" VARCHAR(40) NOT NULL,
    "narration_template" VARCHAR(200),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "posting_rules_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_posting_rule_leg"
  ON "finance"."posting_rules"("book_id", "event_type", "leg_no", "effective_from");
CREATE INDEX "posting_rules_lookup_idx"
  ON "finance"."posting_rules"("book_id", "event_type", "active");

ALTER TABLE "finance"."posting_rules"
  ADD CONSTRAINT "a_posting_rule_side_is_dr_or_cr" CHECK ("side" IN ('DR', 'CR'));
ALTER TABLE "finance"."posting_rules"
  ADD CONSTRAINT "a_posting_rule_runs_forwards"
  CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from");


-- ═════════════════════════════════════════════════════════════════════════════
-- §D. DOUBLE ENTRY, ENFORCED AT COMMIT
-- ═════════════════════════════════════════════════════════════════════════════

-- §D.1  Postings go to leaves, and only to accounts in the journal's own book.
--
-- Posting to a group account makes its balance partly its own and partly its
-- children's, and no report can then be trusted. Posting across books is how
-- one entity's revenue turns up in another's P&L.
CREATE OR REPLACE FUNCTION finance.a_line_posts_to_a_real_account()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_is_group boolean; v_active boolean; v_acct_book uuid; v_jrnl_book uuid; v_needs_cc boolean;
BEGIN
  SELECT a.is_group, a.active, a.book_id, a.requires_cost_centre
    INTO v_is_group, v_active, v_acct_book, v_needs_cc
    FROM finance.accounts a WHERE a.id = NEW.account_id;

  IF v_is_group THEN
    RAISE EXCEPTION
      'Account % is a heading, not a posting account (NC-009 §D.1). Post to one of its children — a heading that carries its own balance makes every report above it wrong.',
      NEW.account_id USING ERRCODE = 'NC009';
  END IF;

  IF NOT v_active THEN
    RAISE EXCEPTION 'Account % is closed and cannot take a posting (NC-009 §D.1).',
      NEW.account_id USING ERRCODE = 'NC009';
  END IF;

  SELECT j.book_id INTO v_jrnl_book FROM finance.journals j WHERE j.id = NEW.journal_id;
  IF v_acct_book IS DISTINCT FROM v_jrnl_book THEN
    RAISE EXCEPTION
      'Account % belongs to a different set of books than this journal (NC-009 §D.1). One entity''s revenue must never land in another''s ledger.',
      NEW.account_id USING ERRCODE = 'NC009';
  END IF;

  IF v_needs_cc AND NEW.cost_centre_id IS NULL THEN
    RAISE EXCEPTION
      'Account % is configured to require a cost centre and this line names none (NC-009 §D.1). Departmental P&L is built from this column; a blank one silently leaves the cost nowhere.',
      NEW.account_id USING ERRCODE = 'NC009';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_a_line_posts_to_a_real_account
  BEFORE INSERT OR UPDATE OF account_id, cost_centre_id ON finance.journal_lines
  FOR EACH ROW EXECUTE FUNCTION finance.a_line_posts_to_a_real_account();


-- §D.2  A journal lands in the period its date falls in, and not in a closed one.
CREATE OR REPLACE FUNCTION finance.a_journal_lands_in_an_open_period()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status text; v_from date; v_to date;
BEGIN
  SELECT p.status, p.starts_on, p.ends_on INTO v_status, v_from, v_to
    FROM finance.fiscal_periods p WHERE p.id = NEW.fiscal_period_id;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'That accounting period does not exist (NC-009 §D.2).' USING ERRCODE = 'NC009';
  END IF;

  IF NEW.journal_date < v_from OR NEW.journal_date > v_to THEN
    RAISE EXCEPTION
      'A journal dated % cannot be filed in the period % to % (NC-009 §D.2). The period a journal belongs to is decided by its date, not chosen.',
      NEW.journal_date, v_from, v_to USING ERRCODE = 'NC009';
  END IF;

  IF v_status <> 'open' THEN
    RAISE EXCEPTION
      'The period % to % is %, so nothing further can be posted into it (NC-009 §D.2). A closed period is what a filed return rests on; post to the current period, or have a controller reopen this one.',
      v_from, v_to, v_status USING ERRCODE = 'NC009';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_a_journal_lands_in_an_open_period
  BEFORE INSERT OR UPDATE OF fiscal_period_id, journal_date ON finance.journals
  FOR EACH ROW EXECUTE FUNCTION finance.a_journal_lands_in_an_open_period();


-- §D.3  A posted journal is immutable. It is corrected by a counter-entry.
--
-- NC-009 §3.1: "every posting is reversible only by a counter-entry". An edited
-- journal is an audit trail that disagrees with itself, and in a statutory book
-- that is indistinguishable from fraud.
CREATE OR REPLACE FUNCTION finance.a_posted_journal_is_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'posted' OR OLD.status = 'reversed' THEN
      RAISE EXCEPTION
        'Journal % is posted and cannot be deleted (NC-009 §D.3). Reverse it: a statutory book that loses an entry cannot be told apart from one that was tampered with.',
        OLD.id USING ERRCODE = 'NC009';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'posted' THEN
    -- The one field a posted journal may still gain is the reversal pointer,
    -- and its status moving to `reversed`.
    IF NEW.status = 'reversed' AND
       NEW.book_id IS NOT DISTINCT FROM OLD.book_id AND
       NEW.journal_date IS NOT DISTINCT FROM OLD.journal_date AND
       NEW.fiscal_period_id IS NOT DISTINCT FROM OLD.fiscal_period_id THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION
      'Journal % is posted and cannot be altered (NC-009 §D.3). Post a reversing journal and then the corrected one.',
      OLD.id USING ERRCODE = 'NC009';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_a_posted_journal_is_immutable
  BEFORE UPDATE OR DELETE ON finance.journals
  FOR EACH ROW EXECUTE FUNCTION finance.a_posted_journal_is_immutable();


-- A posted journal's lines are equally immutable.
CREATE OR REPLACE FUNCTION finance.a_posted_journals_lines_are_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status text; v_journal uuid;
BEGIN
  v_journal := CASE WHEN TG_OP = 'DELETE' THEN OLD.journal_id ELSE NEW.journal_id END;
  SELECT status INTO v_status FROM finance.journals WHERE id = v_journal;

  -- A CASCADE delete of a draft journal reaches here with the header already
  -- gone; that is the one legitimate way a line disappears.
  IF v_status IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF v_status <> 'draft' THEN
    -- `lower(TG_OP)` gives "delete"/"update", and "cannot be delete" is not a
    -- sentence. The message is read by somebody who thinks they have found a
    -- bug, so it had better not look like one.
    RAISE EXCEPTION
      'Journal % is posted, so its lines cannot be % (NC-009 §D.3). Reverse the journal instead.',
      v_journal,
      CASE TG_OP WHEN 'DELETE' THEN 'deleted' WHEN 'UPDATE' THEN 'changed' ELSE lower(TG_OP) END
      USING ERRCODE = 'NC009';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

CREATE TRIGGER trg_a_posted_journals_lines_are_immutable
  BEFORE UPDATE OR DELETE ON finance.journal_lines
  FOR EACH ROW EXECUTE FUNCTION finance.a_posted_journals_lines_are_immutable();


-- §D.4  ── THE RULE ──────────────────────────────────────────────────────────
--
-- Debits equal credits, checked at COMMIT.
--
-- `DEFERRABLE INITIALLY DEFERRED` is the whole design. A journal is built line
-- by line and is unbalanced by construction until the last line lands, so a
-- row-level check would refuse the first INSERT of every correct journal ever
-- written. Deferring to commit is what makes "an unbalanced journal cannot be
-- stored" a property of the database rather than a promise from a service.
--
-- It fires on the LINES, not the header: a journal with no lines at all is also
-- refused, because its debits (0) and credits (0) are equal but it is not a
-- journal. §D.5 handles that case separately.
CREATE OR REPLACE FUNCTION finance.a_journal_balances()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_journal uuid;
  v_debit numeric(18,2);
  v_credit numeric(18,2);
  v_lines int;
BEGIN
  v_journal := CASE WHEN TG_OP = 'DELETE' THEN OLD.journal_id ELSE NEW.journal_id END;

  -- The header may have gone in the same transaction (a draft deleted whole).
  IF NOT EXISTS (SELECT 1 FROM finance.journals WHERE id = v_journal) THEN
    RETURN NULL;
  END IF;

  SELECT coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*)
    INTO v_debit, v_credit, v_lines
    FROM finance.journal_lines WHERE journal_id = v_journal;

  IF v_lines < 2 THEN
    RAISE EXCEPTION
      'Journal % has % line(s) (NC-009 §D.4). An entry needs at least two: money comes from somewhere and goes somewhere.',
      v_journal, v_lines USING ERRCODE = 'NC009';
  END IF;

  IF v_debit <> v_credit THEN
    RAISE EXCEPTION
      'Journal % does not balance: debits %, credits %, difference % (NC-009 §D.4). This is checked when the transaction commits, so the entry has not been stored.',
      v_journal, v_debit, v_credit, (v_debit - v_credit) USING ERRCODE = 'NC009';
  END IF;

  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER trg_a_journal_balances
  AFTER INSERT OR UPDATE OR DELETE ON finance.journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION finance.a_journal_balances();


-- §D.5  A journal with no lines at all is not a journal.
--
-- The balance trigger above cannot see this case: it fires on lines, and a
-- header with none produces no rows to fire on. So the header carries its own
-- deferred check.
CREATE OR REPLACE FUNCTION finance.a_journal_has_lines()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_lines int;
BEGIN
  IF NEW.status = 'draft' THEN RETURN NULL; END IF;

  SELECT count(*) INTO v_lines FROM finance.journal_lines WHERE journal_id = NEW.id;
  IF v_lines = 0 THEN
    RAISE EXCEPTION
      'Journal % was posted with no lines (NC-009 §D.5). An empty journal balances trivially and records nothing, which is worse than an error.',
      NEW.id USING ERRCODE = 'NC009';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER trg_a_journal_has_lines
  AFTER INSERT OR UPDATE ON finance.journals
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION finance.a_journal_has_lines();


-- §D.6  `normal_balance` is derived from the account type, never typed.
CREATE OR REPLACE FUNCTION finance.a_derive_normal_balance()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.normal_balance := CASE NEW.account_type
    WHEN 'asset'     THEN 'DR'
    WHEN 'expense'   THEN 'DR'
    WHEN 'liability' THEN 'CR'
    WHEN 'equity'    THEN 'CR'
    WHEN 'income'    THEN 'CR'
  END;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_a_derive_normal_balance
  BEFORE INSERT OR UPDATE ON finance.accounts
  FOR EACH ROW EXECUTE FUNCTION finance.a_derive_normal_balance();


/**
 * The trial balance, as a view, so "do the books balance" is one query and not
 * a report somebody has to build.
 */
CREATE OR REPLACE VIEW finance.v_trial_balance AS
SELECT
  j.book_id,
  j.hospital_id,
  p.fiscal_year_id,
  l.account_id,
  a.code   AS account_code,
  a.name   AS account_name,
  a.account_type,
  sum(l.debit)  AS total_debit,
  sum(l.credit) AS total_credit,
  sum(l.debit) - sum(l.credit) AS balance
FROM finance.journal_lines l
JOIN finance.journals j       ON j.id = l.journal_id
JOIN finance.fiscal_periods p ON p.id = j.fiscal_period_id
JOIN finance.accounts a       ON a.id = l.account_id
WHERE j.status IN ('posted', 'reversed')
GROUP BY j.book_id, j.hospital_id, p.fiscal_year_id, l.account_id, a.code, a.name, a.account_type;

COMMENT ON VIEW finance.v_trial_balance IS
  'NC-009: debits and credits per account. The sum of `balance` across a book and fiscal year is zero when the books balance, which — given the deferred constraint in §D.4 — it always is.';


-- ═════════════════════════════════════════════════════════════════════════════
-- §E. GRANTS
-- ═════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE r record; v_count int := 0;
BEGIN
  FOR r IN
    SELECT n.nspname AS s, c.relname AS t, c.oid
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'r' AND n.nspname = 'finance'
      AND NOT has_table_privilege('hms_app', c.oid, 'SELECT')
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.%I TO hms_app', r.s, r.t);
    EXECUTE format('GRANT SELECT ON %I.%I TO hms_readonly', r.s, r.t);
    v_count := v_count + 1;
  END LOOP;
  GRANT SELECT ON finance.v_trial_balance TO hms_app, hms_readonly;
  RAISE NOTICE 'Granted application DML on % finance table(s)', v_count;
END $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- §F. ROW-LEVEL SECURITY
-- ═════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  r record; v_has_hospital boolean; v_hospital_null boolean; v_has_branch boolean;
  v_using text; v_check text; v_count int := 0;
BEGIN
  FOR r IN
    SELECT n.nspname AS schema_name, c.relname AS table_name
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('core','mdm','patient','clinical','lab','rad','pharmacy','inventory','finance','queue','engage','billing','integration','ops','specialty')
      AND c.relkind IN ('r','p') AND c.relispartition = false
      AND c.relname NOT LIKE '\_prisma%'
      AND c.relname NOT IN ('cdss_safety_floor','console_components','opioid_conversion_factors',
                            'anticholinergic_scores','beers_criteria','telemedicine_drug_rules')
      AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation')
    ORDER BY n.nspname, c.relname
  LOOP
    SELECT count(*) FILTER (WHERE column_name='hospital_id') > 0,
           bool_or(column_name='hospital_id' AND is_nullable='YES'),
           count(*) FILTER (WHERE column_name='branch_id') > 0
      INTO v_has_hospital, v_hospital_null, v_has_branch
      FROM information_schema.columns
     WHERE table_schema = r.schema_name AND table_name = r.table_name;
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', r.schema_name, r.table_name);
    IF v_has_hospital AND NOT v_hospital_null THEN
      v_using := 'hospital_id = ANY (core.accessible_hospital_ids())';
      IF v_has_branch THEN v_using := v_using || ' AND (branch_id IS NULL OR branch_id = ANY (core.current_branch_ids()))'; END IF;
      v_check := v_using;
    ELSIF v_has_hospital AND v_hospital_null THEN
      v_using := '(hospital_id IS NULL OR hospital_id = ANY (core.accessible_hospital_ids()))';
      IF v_has_branch THEN v_using := v_using || ' AND (branch_id IS NULL OR branch_id = ANY (core.current_branch_ids()))'; END IF;
      v_check := 'hospital_id = ANY (core.accessible_hospital_ids())';
      IF v_has_branch THEN v_check := v_check || ' AND (branch_id IS NULL OR branch_id = ANY (core.current_branch_ids()))'; END IF;
    ELSE v_using := 'false'; v_check := 'false';
    END IF;
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I.%I', r.schema_name, r.table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I.%I FOR ALL TO hms_app USING (%s) WITH CHECK (%s)', r.schema_name, r.table_name, v_using, v_check);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_ro ON %I.%I', r.schema_name, r.table_name);
    EXECUTE format('CREATE POLICY tenant_isolation_ro ON %I.%I FOR SELECT TO hms_readonly USING (%s)', r.schema_name, r.table_name, v_using);
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE 'RLS enabled on % new table(s)', v_count;
END $$;

DO $$
DECLARE v_dupes text;
BEGIN
  SELECT string_agg(format('%s (%s)', conname, tables), '; ' ORDER BY conname) INTO v_dupes
  FROM (
    SELECT c.conname, string_agg(DISTINCT t.relname, ', ') AS tables
      FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname IN ('core','mdm','patient','clinical','lab','rad','pharmacy','inventory',
                         'finance','queue','engage','billing','integration','ops','specialty')
       AND c.contype IN ('c','u','x') AND t.relispartition = false
     GROUP BY c.conname HAVING count(DISTINCT t.relname) > 1
  ) d;
  IF v_dupes IS NOT NULL THEN
    RAISE EXCEPTION 'Two rules share a constraint name: %', v_dupes;
  END IF;
END $$;
