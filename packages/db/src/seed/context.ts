import type { Pool } from 'pg';
import { upsert, type SeedRow, type UpsertOptions, type UpsertResult } from './upsert.js';

/**
 * Seed tiers (`packages/db/package.json` scripts, `phase-00 §0.2`).
 *
 * Each tier is a strict superset of the one before it, so `demo` is `minimal`
 * plus configuration, and `hospital` is `demo` plus activity. Running a wider
 * tier over a narrower one is safe and additive; there is no "downgrade".
 */
export const TIERS = ['minimal', 'demo', 'hospital', 'volume'] as const;
export type Tier = (typeof TIERS)[number];

export function isTier(value: string): value is Tier {
  return (TIERS as readonly string[]).includes(value);
}

/** How much activity each tier generates, per hospital. */
export const TIER_SCALE: Readonly<Record<Tier, number>> = Object.freeze({
  minimal: 0,
  demo: 0,
  hospital: 40,
  /** `docs/09 §8`: load tests need enough rows for an index plan to be honest. */
  volume: 2_000,
});

/**
 * How many patients each tier registers, across the whole demo tenancy.
 *
 * Separate from `TIER_SCALE` because the two answer different questions. Forty
 * approvals make an approvals screen look real; forty patients make every
 * patient-search plan a sequential scan, and a sequential scan over forty rows
 * is faster than any index — so a search budget "proved" on that data proves
 * nothing at all.
 *
 * `phase-01 §1.2` budgets patient search at 200 ms p95 on a million rows.
 * 220 000 is what this repository seeds: enough that the planner picks the
 * trigram and prefix indexes over a scan for every one of the five search
 * paths, which is the property under test. See `docs/PROGRESS.md` for the
 * measured plans and the extrapolation to a million.
 */
export const TIER_PATIENTS: Readonly<Record<Tier, number>> = Object.freeze({
  minimal: 0,
  demo: 40,
  hospital: 3_000,
  volume: 220_000,
});

export interface SeedContext {
  readonly db: Pool;
  readonly tier: Tier;
  readonly scale: number;
  /** Patients to register across the whole tenancy, per `TIER_PATIENTS`. */
  readonly patientCount: number;
  /** Records every table touched, so the run can print an honest tally. */
  readonly write: (options: UpsertOptions, rows: readonly SeedRow[]) => Promise<UpsertResult>;
  readonly results: UpsertResult[];
}

export function createContext(db: Pool, tier: Tier): SeedContext {
  const results: UpsertResult[] = [];
  return {
    db,
    tier,
    scale: TIER_SCALE[tier],
    patientCount: TIER_PATIENTS[tier],
    results,
    async write(options, rows) {
      const result = await upsert(db, options, rows);
      results.push(result);
      return result;
    },
  };
}

export interface SeedTally {
  readonly rowsPresented: number;
  readonly rowsWritten: number;
  readonly tables: number;
  readonly byTable: ReadonlyMap<string, { presented: number; written: number }>;
}

export function tally(results: readonly UpsertResult[]): SeedTally {
  const byTable = new Map<string, { presented: number; written: number }>();
  let rowsPresented = 0;
  let rowsWritten = 0;
  for (const r of results) {
    const entry = byTable.get(r.table) ?? { presented: 0, written: 0 };
    entry.presented += r.presented;
    entry.written += r.written;
    byTable.set(r.table, entry);
    rowsPresented += r.presented;
    rowsWritten += r.written;
  }
  return { rowsPresented, rowsWritten, tables: byTable.size, byTable };
}
