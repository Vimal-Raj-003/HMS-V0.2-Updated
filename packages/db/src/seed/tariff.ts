import type { SeedContext } from './context.js';
import { SEED_EPOCH, seedId } from './ids.js';
import type { SeededTenancy } from './tenancy.js';
import { jsonb, type SeedRow } from './upsert.js';

/**
 * RC-003 — a working price list.
 *
 * Phase 5's whole point is that a delivered service becomes money, and nothing
 * downstream of `resolveRate` can be exercised — not OP-005, not the estimator,
 * not a pre-auth — until at least one plan has a published version with rates in
 * it. So this seed produces the minimum that is genuinely usable rather than a
 * decorative row:
 *
 *   SELFPAY   the default self-pay plan, one published version, every service in
 *             `mdm_services` priced
 *   CORP-ACME a corporate plan **derived** from self-pay at a 10 % discount,
 *             proving the derivation path without duplicating the grid
 *
 * ── Three things this seed is careful about ─────────────────────────────────
 *
 * **1. The published version is written published, in one shot.** The
 * immutability trigger (migration §C.2) refuses an INSERT into a published
 * version, so the rows must land while the version is still a draft and the
 * version flipped afterwards. That ordering is not incidental — it is the same
 * order the API's publish endpoint uses, and a seed that worked around the
 * trigger instead of obeying it would prove nothing.
 *
 * **2. Tax treatment comes from the service, not from a guess.** `mdm_services`
 * already carries `sac_code` and `gst_rate`, set by EN-027. Re-deciding it here
 * would create the second opinion `docs/03` exists to prevent — and the
 * migration's C.5 check would reject a taxable row with a zero rate anyway.
 *
 * **3. Rates are deterministic, not random.** `docs/09 §2` bans ambient
 * randomness. Each price is a fixed number chosen per service code, so the
 * seeded corpus is byte-identical across runs and a test can assert on ₹500.
 */

/** Deterministic, obviously-synthetic prices. Indian OPD ballpark, in rupees. */
const SELF_PAY_RATES: Readonly<Record<string, string>> = {
  REG: '200.00',
  REG_CARD: '100.00',
  CONS_OPD: '500.00',
  CONS_SPEC: '900.00',
  CONS_TELE: '400.00',
  ECG: '300.00',
  HC_BASIC: '2500.00',
  DRESS: '250.00',
  INJ: '150.00',
  PLASTER: '1200.00',
};

/** Anything EN-027 adds later still gets priced, so no bill is ever held. */
const FALLBACK_RATE = '500.00';

interface ServiceRow {
  readonly id: string;
  readonly code: string;
  readonly sac_code: string | null;
  readonly gst_rate: string;
}

export async function seedTariff(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  for (const hospital of tenancy.hospitals) {
    const { rows: services } = await ctx.db.query<ServiceRow>(
      `SELECT id, code, sac_code, gst_rate
         FROM mdm.mdm_services
        WHERE hospital_id = $1 AND status = 'active'
        ORDER BY code`,
      [hospital.id],
    );
    if (services.length === 0) continue;

    const selfPayPlanId = seedId('tariff-plan', hospital.code, 'SELFPAY');
    const corpPlanId = seedId('tariff-plan', hospital.code, 'CORP-ACME');

    await ctx.write({ table: 'mdm.tariff_plans', conflict: ['id'] }, [
      {
        id: selfPayPlanId,
        hospital_id: hospital.id,
        branch_id: null,
        code: 'SELFPAY',
        name: 'Self pay (standard)',
        plan_type: 'self_pay',
        currency: 'INR',
        scope: 'hospital',
        // Present-and-null rather than absent: `upsert()` takes its column list
        // from the FIRST row, so a key that appears only on a later row is
        // silently dropped from the INSERT. Self-pay derives from nothing, and
        // saying so explicitly is what keeps the corporate plan's derivation
        // from vanishing.
        derived_from_plan_id: null,
        derivation_formula: null,
        rounding_rule: jsonb({ mode: 'half_up', decimals: 2 }),
        priority: 0,
        is_default_self_pay: true,
        is_rate_editable: true,
        status: 'active',
        created_at: SEED_EPOCH,
        updated_at: SEED_EPOCH,
      },
      {
        id: corpPlanId,
        hospital_id: hospital.id,
        branch_id: null,
        code: 'CORP-ACME',
        name: 'Acme Industries (corporate)',
        plan_type: 'corporate',
        currency: 'INR',
        scope: 'hospital',
        // Derived rather than duplicated: "self-pay less 10 %" is one rule,
        // not ten thousand rows that drift apart at the next revision.
        derived_from_plan_id: selfPayPlanId,
        derivation_formula: jsonb({ op: 'discount_pct', value: '10' }),
        rounding_rule: jsonb({ mode: 'half_up', decimals: 2 }),
        // Beats self-pay when the encounter carries this corporate.
        priority: 10,
        is_default_self_pay: false,
        is_rate_editable: true,
        status: 'active',
        created_at: SEED_EPOCH,
        updated_at: SEED_EPOCH,
      },
    ] satisfies SeedRow[]);

    const versionId = seedId('tariff-version', hospital.code, 'SELFPAY', '1');

    // A published version is immutable, and the trigger enforces that on INSERT
    // as well as UPDATE — `ON CONFLICT` evaluates *after* `BEFORE INSERT` fires,
    // so even a no-op re-upsert of an unchanged row is refused. That is correct:
    // re-seeding a published price list is not idempotence, it is an attempt to
    // rewrite history. So the second run stops here, which is what "already
    // seeded" actually means for this table.
    const { rows: existing } = await ctx.db.query<{ status: string }>(
      `SELECT status FROM mdm.tariff_versions WHERE id = $1`,
      [versionId],
    );
    if (existing[0]?.status === 'published') continue;

    // Written as a draft first. The migration's §C.2 trigger refuses an item
    // INSERT into a published version, so this is the only legal order — and it
    // is the same order `POST /versions/{id}/publish` follows.
    await ctx.write({ table: 'mdm.tariff_versions', conflict: ['id'], immutable: ['status'] }, [
      {
        id: versionId,
        hospital_id: hospital.id,
        plan_id: selfPayPlanId,
        version_no: 1,
        effective_from: '2026-01-01',
        effective_to: null,
        status: 'draft',
        basis: jsonb({ source: 'seed', note: 'Opening price list for the demo tenancy.' }),
        change_note: 'Seeded opening self-pay tariff.',
        created_at: SEED_EPOCH,
        updated_at: SEED_EPOCH,
      },
    ] satisfies SeedRow[]);

    const items: SeedRow[] = services.map((service) => {
      const gstRate = Number(service.gst_rate);
      const taxable = gstRate > 0;
      return {
        id: seedId('tariff-item', hospital.code, 'SELFPAY', '1', service.code),
        hospital_id: hospital.id,
        version_id: versionId,
        service_id: service.id,
        bed_class_id: null,
        time_band: null,
        unit: 'each',
        base_rate: SELF_PAY_RATES[service.code] ?? FALLBACK_RATE,
        min_rate: null,
        max_rate: null,
        hsn_sac: service.sac_code,
        // EN-027 already decided this. C.5 rejects a taxable row at 0 %, so an
        // inconsistent service would fail loudly here rather than mis-bill.
        tax_treatment: taxable ? 'taxable' : 'exempt',
        gst_rate: service.gst_rate,
        is_negotiable: false,
        created_at: SEED_EPOCH,
        updated_at: SEED_EPOCH,
      };
    });

    await ctx.write({ table: 'mdm.tariff_items', conflict: ['id'] }, items);

    // Now it prices things. A re-run is a no-op: the row is already published
    // and `upsert` writes nothing when nothing differs.
    await ctx.db.query(
      `UPDATE mdm.tariff_versions
          SET status = 'published',
              published_at = $2,
              published_by = NULL
        WHERE id = $1 AND status <> 'published'`,
      [versionId, SEED_EPOCH],
    );
  }
}
