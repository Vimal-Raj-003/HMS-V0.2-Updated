-- ═════════════════════════════════════════════════════════════════════════════
-- The one exempt table that was not actually global
-- ═════════════════════════════════════════════════════════════════════════════
--
-- `packages/db/src/rls/verify-isolation.sql` has been failing three cases, and
-- the build gate it ends with says in terms that such a build must not ship. It
-- had been failing before this session's work and was not caused by it. Two of
-- the three are stale allow-lists. One is real, and this migration closes it.
--
-- ── The real one ──────────────────────────────────────────────────────────
--
-- Five `mdm` tables are deliberately outside row-level security: the opioid
-- conversion factors, the Beers criteria, the anticholinergic scores, the
-- telemedicine drug lists and the immunisation schedules. The reason given each
-- time is the same and it is a good one — they are published law, identical in
-- every tenant, and a hospital that could not read them could not compute a due
-- date or refuse an early dose.
--
-- Four of them have no `hospital_id` column at all, so the claim is structural:
-- there is no tenant data to leak because there is no column that could hold
-- any. `mdm.immunisation_schedules` is the exception. It carries a **nullable**
-- `hospital_id`, which means the schema permits a row belonging to one hospital
-- — a local variation on the national schedule, which is a thing hospitals
-- genuinely do — and with RLS off every other tenant could read it.
--
-- Nothing has leaked: the table holds no rows at all today, national or local.
-- But "identical in every tenant" was a claim about the data, and the column
-- makes it a claim the schema does not enforce. The same argument the PC-PNDT
-- block makes about foetal sex applies here in miniature: a column that exists
-- is a column that gets filled.
--
-- The fix is the nullable-hospital policy shape the generator already writes
-- elsewhere: everyone reads the global rows, each tenant reads its own, and
-- nobody writes a row belonging to somebody else. The national schedule stays
-- readable by all, so the reason for the original exemption is preserved.
--
-- ── The two stale ones ────────────────────────────────────────────────────
--
-- Cases 1a and 2 name allow-lists that stopped matching the schema several
-- phases ago: the verification knows about two open-policy catalogues and there
-- are three, and it does not know that four tables are deliberately outside RLS
-- at all. Those are edits to `verify-isolation.sql`, not to the database, and
-- they are in the same commit as this file.

ALTER TABLE "mdm"."immunisation_schedules" ENABLE ROW LEVEL SECURITY;

-- Read: the national programme (hospital_id IS NULL) plus your own variations.
-- Write: only your own. A tenant cannot edit the national schedule and cannot
-- write a row into another hospital.
DROP POLICY IF EXISTS tenant_isolation ON "mdm"."immunisation_schedules";
CREATE POLICY tenant_isolation ON "mdm"."immunisation_schedules"
  FOR ALL TO hms_app
  USING (hospital_id IS NULL OR hospital_id = ANY (core.accessible_hospital_ids()))
  WITH CHECK (hospital_id = ANY (core.accessible_hospital_ids()));

DROP POLICY IF EXISTS tenant_isolation_ro ON "mdm"."immunisation_schedules";
CREATE POLICY tenant_isolation_ro ON "mdm"."immunisation_schedules"
  FOR SELECT TO hms_readonly
  USING (hospital_id IS NULL OR hospital_id = ANY (core.accessible_hospital_ids()));

COMMENT ON TABLE "mdm"."immunisation_schedules" IS
  'The national immunisation programme, plus any local variation a hospital records against its own id. Rows with a NULL hospital_id are the published schedule and are readable by every tenant; a row with a hospital_id belongs to that hospital alone. Not RLS-exempt, unlike the four pharmacology catalogues beside it, because this one has a tenant column and they do not.';

-- And the invariant that made this necessary, asserted rather than trusted: a
-- table carrying `hospital_id` must have row-level security. The four genuinely
-- global catalogues are named here because they have no such column, which is
-- checkable rather than asserted — if somebody adds one, this stops failing to
-- notice.
DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(format('%s.%s', n.nspname, c.relname), ', ' ORDER BY c.relname) INTO v_bad
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname IN ('core','mdm','patient','clinical','lab','rad','pharmacy','inventory',
                       'finance','queue','engage','billing','integration','ops','specialty')
     AND c.relkind IN ('r','p') AND c.relispartition = false
     AND c.relname NOT LIKE '\_prisma%'
     AND NOT c.relrowsecurity
     AND EXISTS (
       SELECT 1 FROM information_schema.columns col
        WHERE col.table_schema = n.nspname AND col.table_name = c.relname
          AND col.column_name = 'hospital_id'
     );
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION
      'These tables carry hospital_id and have no row-level security: %. A tenant column without a policy is a cross-tenant read waiting to be written.',
      v_bad;
  END IF;
END $$;
