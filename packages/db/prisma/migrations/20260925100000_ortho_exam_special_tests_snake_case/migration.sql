-- ═════════════════════════════════════════════════════════════════════════════
-- clinical.ortho_exams — the one camelCase column
-- ═════════════════════════════════════════════════════════════════════════════
--
-- `docs/03` and CLAUDE.md §4 both say the database is snake_case, and it is:
-- across 868 tables exactly one column was not, because its Prisma field
-- carried no `@map`. Prisma then created `"specialTests"`, while
-- `fracture.service.ts` wrote the name the convention promises — so
-- `POST /ortho/episodes/:id/exams` answered "column special_tests of relation
-- ortho_exams does not exist" on every call, for real episodes as much as
-- missing ones. An API surface sweep found it; nothing else had, because no
-- test records an orthopaedic examination.
--
-- Renamed rather than added-and-copied: the column has never been writable
-- through the only route that writes it, so there is nothing in it to migrate.
ALTER TABLE "clinical"."ortho_exams" RENAME COLUMN "specialTests" TO "special_tests";

DO $$
DECLARE v_found text;
BEGIN
  SELECT string_agg(format('%s.%s.%s', table_schema, table_name, column_name), ', ')
    INTO v_found
    FROM information_schema.columns
   WHERE table_schema IN ('core','mdm','patient','clinical','lab','rad','pharmacy','inventory',
                          'finance','queue','engage','billing','integration','ops','specialty')
     AND column_name ~ '[A-Z]';

  IF v_found IS NOT NULL THEN
    RAISE EXCEPTION
      'The database is snake_case (docs/03, CLAUDE.md §4). These columns are not, which means a Prisma field is missing its @map and the SQL written against the documented name will fail: %',
      v_found;
  END IF;
END $$;
