-- ═════════════════════════════════════════════════════════════════════════════
-- Phase 8 follow-up · OP-025 §0.1
--
-- The application may not author the catalogue of components it can compose.
--
-- `core.permissions` has been read-only to `hms_app` since Phase 0 for exactly
-- this reason: an application that can write the list of things it may do can
-- grant itself authority, and least privilege becomes decorative. The console
-- component catalogue is the same shape of thing one step out — a compromised
-- API that could insert a component key could then register a console naming
-- it, and the trigger that makes "no code deploy" safe would be checking the
-- attacker's own row.
--
-- The catalogue is written by the seed as `hms_migrator` and verified at boot
-- by the running service, which is all it needs to do.
-- ═════════════════════════════════════════════════════════════════════════════

REVOKE INSERT, UPDATE, DELETE ON "mdm"."console_components" FROM hms_app;

COMMENT ON TABLE "mdm"."console_components" IS
  'What the build ships for a console tab to point at. Written by the seed as hms_migrator and read-only to the application, exactly as core.permissions is: an application that could add a component could then register a console naming it, and the trigger that makes "register a console as data" safe would be checking the attacker''s own row.';
