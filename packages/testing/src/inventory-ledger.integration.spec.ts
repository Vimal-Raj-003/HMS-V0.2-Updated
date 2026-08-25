import { startTestPostgres, type TestPostgres } from './containers/postgres.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `phase-04 §Constraints`: "The stock ledger never gets an UPDATE. Corrections
 * are new compensating entries with reason. Any code that mutates a ledger row
 * fails review."
 *
 * Review is the weakest of the three places to enforce that, so the migration
 * uses the other two: a trigger that raises on UPDATE and DELETE, and a REVOKE
 * that takes both privileges from `hms_app`. Both are asserted here, separately
 * and deliberately — a test that proved only the grant would go green the day
 * somebody dropped the trigger, and one that proved only the trigger would go
 * green the day somebody re-granted.
 *
 * Lives in `@vims/testing` for the reason its sibling suite records: these are
 * assertions *about* `@vims/db`, and the reverse dependency edge would make a
 * Turborepo cycle.
 *
 * Building the fixture was itself a test of the schema, and it kept refusing:
 * a batch-tracked item may not move without a batch ("invisible to a recall"),
 * a batch of an expiry-tracked item must carry one ("can never be blocked at
 * dispensing"), a quantity may not be stored in a UoM absent from the item's
 * conversion ladder ("an unconvertible quantity is not a quantity"), and
 * `is_base` must be true for exactly the base UoM. Each is enforced in the
 * database, and each refusal names what it wants.
 */

let pg: TestPostgres;
const HOSPITAL = '018f3a20-0000-7000-8000-00000000d001';
const BRANCH = '018f3a20-0000-7000-8000-00000000d002';
const UOM = '018f3a20-0000-7000-8000-00000000d003';
const ITEM = '018f3a20-0000-7000-8000-00000000d004';
const STORE = '018f3a20-0000-7000-8000-00000000d005';
const LEDGER = '018f3a20-0000-7000-8000-00000000d006';
const BATCH = '018f3a20-0000-7000-8000-00000000d007';

beforeAll(async () => {
  pg = await startTestPostgres();
  const db = pg.pool('migrator');
  await db.query(
    `INSERT INTO mdm.mdm_uoms (id, code, name, dimension, updated_at)
     VALUES ($1, 'TAB', 'Tablet', 'count', now())`,
    [UOM],
  );
  await db.query(
    `INSERT INTO inventory.items (id, hospital_id, code, name, category_id, item_type, base_uom_id, updated_at)
     VALUES ($1, $2, 'PARA500', 'Paracetamol 500mg', gen_random_uuid(), 'drug', $3, now())`,
    [ITEM, HOSPITAL, UOM],
  );
  await db.query(
    `INSERT INTO inventory.stores (id, hospital_id, branch_id, code, name, store_type, updated_at)
     VALUES ($1, $2, $3, 'PH1', 'Main Pharmacy', 'pharmacy', now())`,
    [STORE, HOSPITAL, BRANCH],
  );
  // "An unconvertible quantity is not a quantity" -- the ledger refuses a UoM
  // that is not on the item's conversion ladder.
  await db.query(
    `INSERT INTO inventory.item_uoms (id, hospital_id, item_id, uom_id, factor_to_base, is_base, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 1, true, now())`,
    [HOSPITAL, ITEM, UOM],
  );
  await db.query(
    `INSERT INTO inventory.item_batches (id, hospital_id, item_id, batch_no, expiry_date, received_at, updated_at)
     VALUES ($1, $2, $3, 'B-2026-001', current_date + 365, now(), now())`,
    [BATCH, HOSPITAL, ITEM],
  );
  await db.query(
    `INSERT INTO inventory.stock_ledger
       (id, hospital_id, branch_id, store_id, item_id, batch_id, movement_type, qty_base, qty_entered,
        uom_id, ref_type, ref_id, moved_at)
     VALUES ($1, $2, $3, $4, $5, $7, 'opening', 10, 10, $6, 'opening', gen_random_uuid(), now())`,
    [LEDGER, HOSPITAL, BRANCH, STORE, ITEM, UOM, BATCH],
  );
}, 900_000);
afterAll(async () => {
  await pg?.stop();
});

describe('the stock ledger is append-only', () => {
  it('revokes UPDATE and DELETE from the application role', async () => {
    const { rows } = await pg.pool('migrator').query<{ priv: string }>(
      `SELECT privilege_type AS priv FROM information_schema.table_privileges
        WHERE grantee = 'hms_app' AND table_schema = 'inventory' AND table_name = 'stock_ledger' ORDER BY 1`,
    );
    const granted = rows.map((r) => r.priv);
    expect(granted).toContain('INSERT');
    expect(granted).toContain('SELECT');
    expect(granted).not.toContain('UPDATE');
    expect(granted).not.toContain('DELETE');
  });

  // As `migrator`, the schema owner, so the REVOKE is not what stops it. That
  // isolates the trigger: a test proving only the grant would go green the day
  // somebody dropped the trigger, and vice versa. Two mechanisms, two tests.
  it('raises on UPDATE even for the schema owner', async () => {
    await expect(
      pg.pool('migrator').query(`UPDATE inventory.stock_ledger SET qty_base = 1 WHERE id = $1`, [LEDGER]),
    ).rejects.toThrow(/append-only/);
  });

  it('raises on DELETE even for the schema owner', async () => {
    await expect(
      pg.pool('migrator').query(`DELETE FROM inventory.stock_ledger WHERE id = $1`, [LEDGER]),
    ).rejects.toThrow(/append-only/);
  });

  it('leaves the row exactly as inserted', async () => {
    const { rows } = await pg
      .pool('migrator')
      .query<{ qty: string }>(`SELECT qty_base::text AS qty FROM inventory.stock_ledger WHERE id = $1`, [
        LEDGER,
      ]);
    expect(rows[0]?.qty).toBe('10.0000');
  });

  it('refuses a movement of a batch-tracked item that names no batch', async () => {
    // A movement with no batch is invisible to a recall, which is the whole
    // reason batch tracking exists. The trigger says so in those words.
    await expect(
      pg.pool('migrator').query(
        `INSERT INTO inventory.stock_ledger
           (id, hospital_id, branch_id, store_id, item_id, movement_type, qty_base, qty_entered,
            uom_id, ref_type, ref_id, moved_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 'opening', 1, 1, $5, 'opening', gen_random_uuid(), now())`,
        [HOSPITAL, BRANCH, STORE, ITEM, UOM],
      ),
    ).rejects.toThrow(/must name a batch/);
  });

  it('refuses a movement whose sign disagrees with its type', async () => {
    // `stock_ledger_sign_matches_movement`: positive in, negative out, so that
    // `sum(qty_base)` is the balance. A dispense recorded positive would make
    // every balance arithmetically valid and physically wrong.
    await expect(
      pg.pool('migrator').query(
        `INSERT INTO inventory.stock_ledger
           (id, hospital_id, branch_id, store_id, item_id, batch_id, movement_type, qty_base, qty_entered,
            uom_id, ref_type, ref_id, moved_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $6, 'dispense', 5, 5, $5, 'dispense', gen_random_uuid(), now())`,
        [HOSPITAL, BRANCH, STORE, ITEM, UOM, BATCH],
      ),
    ).rejects.toThrow();
  });
});
