import { ENFORCEMENT_POINTS, SETTING_DEFINITIONS } from '@vims/contracts';
import type { SeedContext } from './context.js';
import { SEED_EPOCH, seedId } from './ids.js';
import { jsonb, type SeedRow } from './upsert.js';
import { mainBranchOf, type SeededTenancy } from './tenancy.js';

/**
 * Platform configuration every tenant needs before a single request can
 * complete: numbering series, effective settings, feature flags and the
 * business calendar the SLA engine measures against.
 */
export async function seedPlatform(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  await seedNumberingSeries(ctx, tenancy);
  await seedSettings(ctx, tenancy);
  await seedFeatureFlags(ctx, tenancy);
  await seedBusinessCalendars(ctx, tenancy);
}

/**
 * `docs/03 §Numbering series`. The `gapless` flag is the load-bearing one:
 * invoices, receipts, MLC registers and blood-bag numbers are legally required
 * to have no holes, which forces a row-locked allocation inside the business
 * transaction. Tokens deliberately are not gapless — a gap in a queue token
 * harms nobody and the throughput matters (`docs/09 §9.8`).
 *
 * `{BR}` is the branch short code, `{FY}` the Indian financial year, `{SEQ:n}`
 * a zero-padded counter.
 */
const SERIES: readonly (readonly [key: string, pattern: string, gapless: boolean, reset: string])[] = [
  ['UHID', '{BR}{SEQ:8}', false, 'never'],
  ['OP_VISIT', '{BR}/OP/{FY}/{SEQ:6}', false, 'fy'],
  // OP-001 §4: "appointment no per branch/FY". Not gapless — a booking that
  // fails validation must not burn a number that an auditor will later ask
  // about, and nothing legal depends on the sequence being unbroken.
  ['APPT', '{BR}/APPT/{FY}/{SEQ:6}', false, 'fy'],
  ['IP_NO', '{BR}/IP/{FY}/{SEQ:6}', false, 'fy'],
  ['TOKEN', '{SEQ:4}', false, 'day'],
  ['BILL_OP', '{BR}/OPB/{FY}/{SEQ:6}', true, 'fy'],
  ['BILL_IP', '{BR}/IPB/{FY}/{SEQ:6}', true, 'fy'],
  ['RECEIPT', '{BR}/RCP/{FY}/{SEQ:6}', true, 'fy'],
  ['REFUND', '{BR}/REF/{FY}/{SEQ:6}', true, 'fy'],
  ['CREDIT_NOTE', '{BR}/CN/{FY}/{SEQ:6}', true, 'fy'],
  ['LAB_ACC', '{BR}/LAB/{FY}/{SEQ:7}', false, 'fy'],
  ['SAMPLE', '{BR}/SMP/{SEQ:8}', false, 'never'],
  ['RAD_ACC', '{BR}/RAD/{FY}/{SEQ:7}', false, 'fy'],
  ['PO', '{BR}/PO/{FY}/{SEQ:5}', false, 'fy'],
  ['GRN', '{BR}/GRN/{FY}/{SEQ:5}', false, 'fy'],
  ['INDENT', '{BR}/IND/{FY}/{SEQ:5}', false, 'fy'],
  ['MLC', '{BR}/MLC/{FY}/{SEQ:4}', true, 'fy'],
  ['BLOOD_BAG', '{BR}/BB/{FY}/{SEQ:5}', true, 'fy'],
  ['LIC_INVOICE', 'VIMS/{FY}/{SEQ:5}', true, 'fy'],
];

async function seedNumberingSeries(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const rows: SeedRow[] = [];
  for (const h of tenancy.hospitals) {
    for (const b of h.branches) {
      for (const [key, pattern, gapless, reset] of SERIES) {
        // The SaaS invoice series belongs to the vendor, not to a branch.
        if (key === 'LIC_INVOICE' && !b.isMain) continue;
        rows.push({
          id: seedId('numbering-series', h.code, b.code, key),
          hospital_id: h.id,
          branch_id: key === 'LIC_INVOICE' ? null : b.id,
          key,
          pattern,
          scope: key === 'LIC_INVOICE' ? 'hospital' : 'branch',
          fy: reset === 'fy' ? '2026-27' : null,
          current_value: 0,
          gapless,
          reset_policy: reset,
          version: 1,
          effective_from: SEED_EPOCH,
          effective_to: null,
          locked_at: null,
          active: true,
          created_at: SEED_EPOCH,
          created_by: null,
          updated_at: SEED_EPOCH,
          updated_by: null,
        });
      }
    }
  }
  await ctx.write(
    { table: 'core.numbering_series', conflict: ['id'], immutable: ['current_value', 'locked_at'] },
    rows,
  );
}

/**
 * Effective settings at hospital scope.
 *
 * Only keys whose narrowest declared scope includes `hospital` are written, and
 * `secret` keys are skipped entirely — a secret's value belongs in the secret
 * store, and writing a placeholder into `core.settings.value` would put a
 * plausible-looking non-secret where the application expects a real one
 * (`EN-007 §5`). Everything else inherits from `setting_definitions.default_value`
 * at read time, so this is a small, deliberate set rather than all 46 keys.
 */
async function seedSettings(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const applicable = SETTING_DEFINITIONS.filter(
    (d) => d.sensitivity !== 'secret' && d.scopes.includes('hospital'),
  );

  const rows: SeedRow[] = [];
  for (const h of tenancy.hospitals) {
    for (const definition of applicable) {
      rows.push({
        id: seedId('setting', h.code, definition.key),
        hospital_id: h.id,
        branch_id: null,
        department_id: null,
        user_id: null,
        key: definition.key,
        value: jsonb(definition.defaultValue),
        value_encrypted: null,
        created_at: SEED_EPOCH,
        created_by: null,
        updated_at: SEED_EPOCH,
        updated_by: null,
        version: 0,
      });
    }
  }
  await ctx.write({ table: 'core.settings', conflict: ['id'] }, rows);
}

/**
 * `CLAUDE.md §4`: every module ships behind `module.<key>.enabled`.
 * `EN-007 §3.7`: a flag can never enable a module outside the licence — so the
 * seeded flags mirror the entitlement registry rather than being invented, and
 * a `clinical_safety_exempt` module is enabled unconditionally.
 */
async function seedFeatureFlags(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const moduleKeys = ENFORCEMENT_POINTS.filter(
    (e) => e.family === 'feature' && e.key.startsWith('module.'),
  );

  const rows: SeedRow[] = [];
  for (const h of tenancy.hospitals) {
    for (const point of moduleKeys) {
      rows.push({
        id: seedId('feature-flag', h.code, point.key),
        key: point.key,
        hospital_id: h.id,
        branch_id: null,
        role_key: null,
        user_id: null,
        enabled: true,
        rollout_pct: null,
        expires_at: null,
        note: point.clinicalSafetyExempt
          ? 'Clinical-safety exempt (EN-040 §5): this flag can never disable the module.'
          : 'Enabled for the demo tenant.',
        created_at: SEED_EPOCH,
        created_by: null,
        updated_at: SEED_EPOCH,
        updated_by: null,
      });
    }
  }
  await ctx.write({ table: 'core.feature_flags', conflict: ['id'] }, rows);
}

/** `EN-038 §5`: "SLA clocks use business calendars." */
async function seedBusinessCalendars(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const rows: SeedRow[] = [];
  for (const h of tenancy.hospitals) {
    const main = mainBranchOf(h);
    rows.push({
      id: seedId('wf-calendar', h.code, 'standard'),
      hospital_id: h.id,
      branch_id: null,
      name: 'Standard administrative hours',
      working_days: { mon: true, tue: true, wed: true, thu: true, fri: true, sat: true, sun: false },
      working_hours: { start: '09:00', end: '18:00' },
      holidays: [],
      timezone: 'Asia/Kolkata',
      is_default: true,
      created_at: SEED_EPOCH,
      created_by: null,
      updated_at: SEED_EPOCH,
      deleted_at: null,
    });
    rows.push({
      id: seedId('wf-calendar', h.code, 'roundtheclock'),
      hospital_id: h.id,
      branch_id: main.id,
      name: 'Round the clock (clinical)',
      working_days: { mon: true, tue: true, wed: true, thu: true, fri: true, sat: true, sun: true },
      working_hours: { start: '00:00', end: '24:00' },
      holidays: [],
      timezone: 'Asia/Kolkata',
      is_default: false,
      created_at: SEED_EPOCH,
      created_by: null,
      updated_at: SEED_EPOCH,
      deleted_at: null,
    });
  }
  await ctx.write({ table: 'core.wf_business_calendars', conflict: ['id'] }, rows);
}
