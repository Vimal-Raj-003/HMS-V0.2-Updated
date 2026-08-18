-- ─────────────────────────────────────────────────────────────────────────────
-- RLS exceptions for tables whose tenant key is not literally `hospital_id`
--
-- The generated policies in `..._rls_policies` classify a table by looking for a
-- `hospital_id` column. Five tables have none, and the generator fell back to
-- `USING (true)` for all of them. For two that is correct. For three it was a
-- real cross-tenant metadata leak:
--
--   * `core.hospitals` — the tenancy anchor. Its tenant key IS `id`. Left as
--     `USING (true)`, any authenticated session could read every other tenant's
--     legal name, GSTIN, PAN, registered address and DPO contact details. Not
--     PHI, but squarely against docs/09 §3.1 case 3 ("A's rows must never
--     appear") and DPDP purpose limitation.
--   * `core.org_groups` — same problem one level up.
--   * `core.role_permissions` — a join table with no tenant column. Left open, a
--     session could enumerate another hospital's custom roles and therefore its
--     internal authorisation model. That is reconnaissance, not a leak of
--     patient data, but it is exactly what an attacker reads first.
--
-- The two that stay global are deliberate:
--
--   * `core.permissions` and `core.setting_definitions` are catalogues synced
--     from `packages/contracts` at boot. They are byte-identical for every
--     tenant, contain no tenant data, and every session needs them on every
--     request to render a nav menu. Scoping them would add a join to the hottest
--     read in the product to protect information that is already in the source
--     repository.
--
-- `core.v_rls_open_policies` below makes the remaining `USING (true)` policies
-- visible, and the integration suite asserts the list matches this allow-list
-- exactly — so a table added in Phase 4 cannot quietly join it.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── core.hospitals: tenant key is `id` ───────────────────────────────────────
DROP POLICY IF EXISTS tenant_isolation ON core.hospitals;
CREATE POLICY tenant_isolation ON core.hospitals
  FOR ALL TO hms_app
  USING (id = ANY (core.accessible_hospital_ids()))
  WITH CHECK (id = ANY (core.accessible_hospital_ids()));

DROP POLICY IF EXISTS tenant_isolation_ro ON core.hospitals;
CREATE POLICY tenant_isolation_ro ON core.hospitals
  FOR SELECT TO hms_readonly
  USING (id = ANY (core.accessible_hospital_ids()));

-- ── core.org_groups: visible only through a hospital the session can reach ───
-- A group-scoped role (EN-041 §3.3.4) sees the group because its widened
-- `app.hospital_ids` includes a member hospital. A branch-scoped user sees their
-- own group's row, which they need for branding — and nothing else.
DROP POLICY IF EXISTS tenant_isolation ON core.org_groups;
CREATE POLICY tenant_isolation ON core.org_groups
  FOR ALL TO hms_app
  USING (
    EXISTS (
      SELECT 1 FROM core.hospitals h
      WHERE h.group_id = core.org_groups.id
        AND h.id = ANY (core.accessible_hospital_ids())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM core.hospitals h
      WHERE h.group_id = core.org_groups.id
        AND h.id = ANY (core.accessible_hospital_ids())
    )
  );

DROP POLICY IF EXISTS tenant_isolation_ro ON core.org_groups;
CREATE POLICY tenant_isolation_ro ON core.org_groups
  FOR SELECT TO hms_readonly
  USING (
    EXISTS (
      SELECT 1 FROM core.hospitals h
      WHERE h.group_id = core.org_groups.id
        AND h.id = ANY (core.accessible_hospital_ids())
    )
  );

-- ── core.role_permissions: scope through the owning role ─────────────────────
-- `roles.hospital_id IS NULL` marks one of the 64 read-only system templates,
-- which every tenant legitimately reads. A custom role belongs to exactly one
-- hospital and must not be visible outside it.
DROP POLICY IF EXISTS tenant_isolation ON core.role_permissions;
CREATE POLICY tenant_isolation ON core.role_permissions
  FOR ALL TO hms_app
  USING (
    EXISTS (
      SELECT 1 FROM core.roles r
      WHERE r.id = core.role_permissions.role_id
        AND (r.hospital_id IS NULL OR r.hospital_id = ANY (core.accessible_hospital_ids()))
    )
  )
  WITH CHECK (
    -- A tenant may only ever attach permissions to its OWN role. Writing to a
    -- system template through this join table would silently re-privilege every
    -- hospital on the deployment.
    EXISTS (
      SELECT 1 FROM core.roles r
      WHERE r.id = core.role_permissions.role_id
        AND r.hospital_id = ANY (core.accessible_hospital_ids())
    )
  );

DROP POLICY IF EXISTS tenant_isolation_ro ON core.role_permissions;
CREATE POLICY tenant_isolation_ro ON core.role_permissions
  FOR SELECT TO hms_readonly
  USING (
    EXISTS (
      SELECT 1 FROM core.roles r
      WHERE r.id = core.role_permissions.role_id
        AND (r.hospital_id IS NULL OR r.hospital_id = ANY (core.accessible_hospital_ids()))
    )
  );

-- The join above must be index-backed or every permission-cache warm becomes a
-- sequential scan of `roles` (EN-041 §13).
CREATE INDEX IF NOT EXISTS idx_roles_id_hospital
  ON core.roles (id, hospital_id);

-- ── visibility of what remains open ──────────────────────────────────────────
CREATE OR REPLACE VIEW core.v_rls_open_policies AS
SELECT
  n.nspname                          AS schema_name,
  c.relname                          AS table_name,
  p.polname                          AS policy_name,
  pg_get_expr(p.polqual, p.polrelid) AS using_expr
FROM pg_policy p
JOIN pg_class c ON c.oid = p.polrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN ('core', 'mdm', 'integration')
  AND pg_get_expr(p.polqual, p.polrelid) = 'true';

COMMENT ON VIEW core.v_rls_open_policies IS
  'Every policy that permits unrestricted reads. The integration suite asserts this equals exactly {permissions, setting_definitions} — anything else is a cross-tenant leak.';

GRANT SELECT ON core.v_rls_open_policies TO hms_app, hms_readonly;

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK:
--   Reverting restores `USING (true)` on core.hospitals, core.org_groups and
--   core.role_permissions, which reopens the cross-tenant metadata leak this
--   migration exists to close. Do not.
--
--   DROP VIEW IF EXISTS core.v_rls_open_policies;
--   DROP INDEX IF EXISTS core.idx_roles_id_hospital;
--   -- then re-run the generator block from ..._rls_policies
-- ─────────────────────────────────────────────────────────────────────────────
