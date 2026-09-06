import type { SeedContext } from './context.js';
import { SEED_EPOCH, seedId } from './ids.js';
import type { SeededTenancy } from './tenancy.js';
import type { SeedRow } from './upsert.js';

/**
 * RC-006 — the four reconciliations, enabled with sane thresholds.
 *
 * The thresholds are the interesting part. A worklist full of ₹5 gaps is a
 * worklist nobody opens, and the ₹40,000 implant buried in it is the one that
 * mattered. So each reconciler stays quiet below an amount chosen for what it
 * finds:
 *
 *   orders      ₹100 — a repeat CBC is worth chasing; a ₹20 disposable is not
 *   dispense    ₹100 — same reasoning at the pharmacy window
 *   consignment ₹1    — effectively everything. An implant is never noise, and
 *                       this is the single largest leak in most hospitals
 *   discount    ₹500  — below this a desk-level courtesy is not worth an audit
 *                       row, and OP-005's approval matrix already covers it
 */

interface RuleSpec {
  readonly reconciler: string;
  readonly name: string;
  readonly minGap: string;
  readonly severity: 'low' | 'medium' | 'high';
  readonly lookbackDays: number;
}

const RULES: readonly RuleSpec[] = [
  {
    reconciler: 'orders_vs_charges',
    name: 'Delivered orders with no charge',
    minGap: '100.00',
    severity: 'high',
    lookbackDays: 30,
  },
  {
    reconciler: 'dispense_vs_charges',
    name: 'Drugs dispensed and not billed',
    minGap: '100.00',
    severity: 'high',
    lookbackDays: 30,
  },
  {
    reconciler: 'consignment_vs_charges',
    name: 'Implants used and not billed',
    minGap: '1.00',
    severity: 'high',
    lookbackDays: 90,
  },
  {
    reconciler: 'discount_without_approval',
    name: 'Discounts with no approved request',
    minGap: '500.00',
    severity: 'medium',
    lookbackDays: 30,
  },
];

export async function seedLeakage(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  for (const hospital of tenancy.hospitals) {
    const rows: SeedRow[] = RULES.map((rule) => ({
      id: seedId('leak-rule', hospital.code, rule.reconciler),
      hospital_id: hospital.id,
      reconciler: rule.reconciler,
      name: rule.name,
      min_gap_amount: rule.minGap,
      severity: rule.severity,
      lookback_days: rule.lookbackDays,
      is_active: true,
      notes: null,
      created_at: SEED_EPOCH,
      updated_at: SEED_EPOCH,
    }));

    await ctx.write({ table: 'billing.leak_rules', conflict: ['id'] }, rows);
  }
}
