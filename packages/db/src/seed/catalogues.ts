import { z } from 'zod';
import {
  ENFORCEMENT_POINTS,
  PERMISSION_CATALOGUE,
  ROLE_TEMPLATES,
  SETTING_DEFINITIONS,
} from '@vims/contracts';
import type { SeedContext } from './context.js';
import { SEED_EPOCH, seedId } from './ids.js';
import { jsonb, type SeedRow } from './upsert.js';

/**
 * The catalogues that are *declared in code and mirrored into the database*.
 *
 * `EN-007 §3.3.1`: permissions are "registered in code
 * (`packages/contracts/permissions.ts`) → synced to `core.permissions` at boot
 * (new keys flagged 'unassigned' in Admin UI); modules cannot use unregistered
 * keys". The seed performs the same sync the API will perform at boot, so a
 * freshly seeded database is already in the state the API expects rather than
 * being one boot behind.
 *
 * Nothing here is tenant data: every row is identical on every deployment. That
 * is why `core.permissions`, `core.setting_definitions`,
 * `core.lic_enforcement_points`, `core.display_widgets_catalogue` and
 * `mdm.mdm_masters_registry` carry no `hospital_id` and are read-only to the
 * application role.
 */
export async function seedCatalogues(ctx: SeedContext): Promise<void> {
  await seedPermissions(ctx);
  await seedSettingDefinitions(ctx);
  await seedEnforcementPoints(ctx);
  await seedRoleTemplates(ctx);
  await seedMastersRegistry(ctx);
  await seedWidgetCatalogue(ctx);
}

async function seedPermissions(ctx: SeedContext): Promise<void> {
  const rows: SeedRow[] = PERMISSION_CATALOGUE.map((p) => ({
    key: p.key,
    module: p.module,
    resource: p.resource,
    action: p.action,
    description: p.description,
    data_class: p.dataClass,
    risk: p.risk,
    phase: p.phase,
    sensitive_grant: p.sensitiveGrant ?? false,
    requires_second_person: p.requiresSecondPerson ?? false,
    requires_reason: p.requiresReason ?? false,
    requires_step_up: p.requiresStepUp ?? false,
    phi_read: p.phiRead ?? false,
    clinical_safety_exempt: p.clinicalSafetyExempt ?? false,
    deprecated: p.deprecated ?? false,
    synced_at: SEED_EPOCH,
  }));
  await ctx.write({ table: 'core.permissions', conflict: ['key'] }, rows);
}

async function seedSettingDefinitions(ctx: SeedContext): Promise<void> {
  const rows: SeedRow[] = SETTING_DEFINITIONS.map((d) => ({
    key: d.key,
    module: d.module,
    label: d.label,
    description: d.description,
    scopes: [...d.scopes],
    json_schema: jsonSchemaOf(d.schema),
    default_value: jsonb(d.defaultValue),
    sensitivity: d.sensitivity,
    requires_approval: d.requiresApproval,
    dual_control: d.dualControl,
    synced_at: SEED_EPOCH,
  }));
  await ctx.write({ table: 'core.setting_definitions', conflict: ['key'] }, rows);
}

async function seedEnforcementPoints(ctx: SeedContext): Promise<void> {
  const rows: SeedRow[] = ENFORCEMENT_POINTS.map((e) => ({
    key: e.key,
    family: e.family,
    guard: e.guard,
    description: e.description,
    fail_open: e.failOpen,
    clinical_safety_exempt: e.clinicalSafetyExempt,
    // The message a nurse reads. English only until `packages/i18n` lands; the
    // shape is already per-locale so adding `hi` is data, not a migration.
    message_i18n: { 'en-IN': e.message },
    upgrade_cta: e.upgradeCta ?? null,
    synced_at: SEED_EPOCH,
  }));
  await ctx.write({ table: 'core.lic_enforcement_points', conflict: ['key'] }, rows);
}

/**
 * `EN-007 §3.3.2`: "System role templates (60+ per docs/05) seeded as read-only
 * templates; hospital clones to custom roles." They are seeded with
 * `hospital_id IS NULL`, which the RLS generator classifies as a system row:
 * readable by every tenant, writable by none through the application role.
 */
async function seedRoleTemplates(ctx: SeedContext): Promise<void> {
  const roles: SeedRow[] = [];
  const grants: SeedRow[] = [];

  for (const template of ROLE_TEMPLATES) {
    const roleId = seedId('role-template', template.key);
    roles.push({
      id: roleId,
      hospital_id: null,
      key: template.key,
      name: template.name,
      description: template.description,
      template_key: null,
      abac_defaults: jsonb(template.abacDefaults),
      home_workspace: template.homeWorkspace,
      nav_preset: {},
      is_system: true,
      mfa_mandatory: template.mfaMandatory,
      sensitive_grant: template.sensitiveGrant,
      requires_co_sign: template.requiresCoSign,
      category: template.category,
      docs_row: template.docsRow,
      version: 1,
      active: true,
      created_at: SEED_EPOCH,
      created_by: null,
      updated_at: SEED_EPOCH,
      updated_by: null,
    });

    for (const permissionKey of template.permissions) {
      grants.push({ role_id: roleId, permission_key: permissionKey });
    }
  }

  await ctx.write({ table: 'core.roles', conflict: ['id'] }, roles);
  await ctx.write({ table: 'core.role_permissions', conflict: ['role_id', 'permission_key'] }, grants);
}

/**
 * `EN-027 §4`: metadata about the masters themselves.
 *
 * Rows exist for masters whose tables do not exist yet. That is the point — the
 * registry is the honest list of what the product will own and which phase owns
 * it, so "where does the tariff master live?" has an answer before Phase 5
 * builds it, and the admin console can grey out what is not yet available.
 */
async function seedMastersRegistry(ctx: SeedContext): Promise<void> {
  const masters: readonly (readonly [string, string, string, string, string, number])[] = [
    ['department', 'Departments', 'mdm.mdm_departments', 'hospital', 'hospital_admin', 0],
    ['code_system', 'Code systems (ICD, LOINC, SNOMED, ATC, UCUM)', 'mdm.mdm_code_systems', 'system', 'quality_manager', 0],
    ['value_set', 'Value sets', 'mdm.mdm_value_sets', 'hospital', 'quality_manager', 0],
    ['concept_map', 'Concept maps', 'mdm.mdm_concept_maps', 'hospital', 'it_admin', 0],
    ['ward', 'Wards', 'mdm.mdm_wards', 'branch', 'nursing_superintendent', 7],
    ['bed', 'Beds', 'mdm.mdm_beds', 'branch', 'nursing_superintendent', 7],
    ['room_class', 'Room classes', 'mdm.mdm_room_classes', 'hospital', 'billing_manager', 7],
    ['service', 'Service catalogue & tariffs', 'mdm.mdm_services', 'hospital', 'billing_manager', 5],
    ['lab_test', 'Lab tests', 'mdm.mdm_lab_tests', 'hospital', 'lab_manager', 3],
    ['rad_procedure', 'Radiology procedures', 'mdm.mdm_rad_procedures', 'hospital', 'radiologist', 3],
    ['drug', 'Drug master', 'mdm.mdm_drugs', 'hospital', 'chief_pharmacist', 4],
    ['drug_brand', 'Drug brands', 'mdm.mdm_drug_brands', 'hospital', 'chief_pharmacist', 4],
    ['item', 'Stores items', 'mdm.mdm_items', 'hospital', 'stores_manager', 4],
    ['uom', 'Units of measure', 'mdm.mdm_uoms', 'system', 'stores_manager', 4],
    ['payer', 'Payers (TPA, insurer, corporate, government)', 'mdm.mdm_payers', 'hospital', 'insurance_executive', 5],
    ['scheme', 'Payer schemes & packages', 'mdm.mdm_schemes', 'hospital', 'insurance_executive', 5],
    ['hsn_sac', 'HSN / SAC codes', 'mdm.mdm_hsn_sac', 'system', 'accounts_manager', 5],
    ['tax_rate', 'GST rates', 'mdm.mdm_tax_rates', 'system', 'accounts_manager', 5],
  ];

  const rows: SeedRow[] = masters.map(([key, name, table, scope, ownerRole, phase]) => ({
    key,
    name,
    table_name: table,
    scope,
    owner_role: ownerRole,
    effective_dated: true,
    approval_matrix_ref: `mdm.${key}.change`,
    allow_local_override: scope === 'hospital',
    standard_bindings: {},
    consumers: [],
    review_frequency_months: 12,
    retention_policy: 'permanent',
    phase,
    // Only a master whose table exists can be edited today.
    active: phase === 0,
    synced_at: SEED_EPOCH,
  }));

  await ctx.write({ table: 'mdm.mdm_masters_registry', conflict: ['key'] }, rows);
}

/**
 * `EN-018 §3.1` widget catalogue, "seed, code-registered".
 *
 * `phi_level` is the load-bearing column: `EN-018 §5` forbids placing an
 * `identifiable` widget on a board in a public location, and a KPI board is
 * restricted to staff-only areas.
 */
async function seedWidgetCatalogue(ctx: SeedContext): Promise<void> {
  const widgets: readonly (readonly [string, string, string, string, string, readonly string[]])[] = [
    ['now_serving', 'Now serving', 'queue', 'queue.token.current', 'masked', ['opd_token', 'pharmacy_queue', 'cash_counter']],
    ['next_tokens', 'Next tokens', 'queue', 'queue.token.upcoming', 'masked', ['opd_token', 'pharmacy_queue']],
    ['queue_summary', 'Queue summary', 'queue', 'queue.summary', 'none', ['opd_token', 'pharmacy_queue', 'cash_counter']],
    ['counter_assignment', 'Counter assignment', 'queue', 'queue.counter', 'masked', ['cash_counter', 'opd_token']],
    ['doctor_availability', 'Doctor availability', 'clinical', 'opd.doctor.availability', 'none', ['doctor_availability', 'opd_token']],
    ['doctor_delay_notice', 'Doctor delay notice', 'clinical', 'opd.doctor.delay', 'none', ['doctor_availability']],
    ['ward_status', 'Ward status', 'clinical', 'ip.ward.status', 'masked', ['ward_status']],
    ['ward_census', 'Ward census', 'clinical', 'ip.ward.census', 'none', ['ward_status', 'management_kpi']],
    ['ot_schedule', 'OT schedule', 'clinical', 'ot.schedule', 'masked', ['ot_schedule']],
    ['ot_utilisation', 'OT utilisation', 'analytics', 'ot.utilisation', 'none', ['management_kpi']],
    ['lab_tat', 'Lab turnaround', 'diagnostics', 'lab.tat', 'none', ['lab_tat', 'management_kpi']],
    ['report_ready_tokens', 'Reports ready', 'diagnostics', 'lab.report.ready', 'masked', ['lab_tat']],
    ['er_status', 'Emergency status', 'clinical', 'er.status', 'none', ['er_status']],
    ['kpi_tile', 'KPI tile', 'analytics', 'analytics.kpi', 'none', ['management_kpi']],
    ['chart', 'Chart', 'analytics', 'analytics.series', 'none', ['management_kpi']],
    ['announcement_ticker', 'Announcement ticker', 'signage', 'display.announcements', 'none', ['opd_token', 'ward_status', 'signage_only']],
    ['health_tip_ticker', 'Health tip ticker', 'signage', 'display.health_tips', 'none', ['signage_only', 'opd_token']],
    ['media', 'Media playlist', 'signage', 'display.playlist', 'none', ['signage_only']],
    ['web_embed', 'Web embed', 'signage', 'display.embed', 'none', ['signage_only']],
    ['clock_date', 'Clock and date', 'signage', 'display.clock', 'none', ['opd_token', 'ward_status', 'signage_only']],
    ['hospital_branding', 'Hospital branding', 'signage', 'display.branding', 'none', ['opd_token', 'signage_only']],
    ['qr_widget', 'QR code', 'signage', 'display.qr', 'none', ['signage_only', 'opd_token']],
    ['visiting_hours', 'Visiting hours', 'signage', 'display.visiting_hours', 'none', ['ward_status', 'signage_only']],
    ['tariff_board', 'Tariff board', 'signage', 'display.tariff', 'none', ['signage_only']],
    ['citizen_charter', 'Citizen charter', 'signage', 'display.charter', 'none', ['signage_only']],
    ['evacuation_map', 'Evacuation map', 'safety', 'display.evacuation', 'none', ['signage_only', 'ward_status']],
    ['weather', 'Weather', 'signage', 'display.weather', 'none', ['signage_only']],
    ['emergency_banner', 'Emergency banner (reserved overlay)', 'safety', 'display.emergency', 'none', []],
  ];

  const rows: SeedRow[] = widgets.map(([type, name, category, dataSource, phiLevel, purposes]) => ({
    type,
    name,
    category,
    data_source: dataSource,
    params_schema: {},
    min_size: { w: 3, h: 2 },
    supports_audio: type === 'now_serving' || type === 'emergency_banner',
    phi_level: phiLevel,
    allowed_purpose_types: [...purposes],
    synced_at: SEED_EPOCH,
  }));

  await ctx.write({ table: 'core.display_widgets_catalogue', conflict: ['type'] }, rows);
}

/**
 * The admin console renders a settings form from JSON Schema, so the Zod
 * definition has to be projected into one. Zod 4 can do that for most schemas;
 * a schema it cannot represent (a refinement, a transform) yields `{}` rather
 * than failing the seed — the value is still validated by Zod on write, the
 * console just falls back to a raw editor for that key.
 */
function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  try {
    return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  } catch {
    return {};
  }
}
