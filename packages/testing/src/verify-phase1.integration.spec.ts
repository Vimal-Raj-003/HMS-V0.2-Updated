import type { Pool } from 'pg';
import { runSeed } from '@vims/db/seed';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestPostgres, type TestPostgres } from './containers/postgres.js';

/**
 * The allergy statement is a clinical-safety invariant, not a modelling nicety.
 * `patient.allergies` holding no rows must never be readable as "safe to
 * prescribe" when the truth is "nobody has asked yet" — that conflation is the
 * defect `docs/06 §10` names, and the four-arm statement on `patient.patients`
 * exists to prevent it.
 *
 * A trigger that merely *exists* proves nothing about what it does, so these
 * assertions drive it against a real PostgreSQL and check the resulting state.
 */
describe('Phase 1 — the allergy statement cannot be faked', () => {
  let pg: TestPostgres;
  let db: Pool;

  beforeAll(async () => {
    pg = await startTestPostgres();
    db = pg.pool('migrator');
    // 'demo' is the smallest tier that seeds patients.
    await runSeed(db, 'demo');
  }, 600_000);

  afterAll(async () => {
    await pg?.stop();
  });

  const statementFor = async (patientId: string): Promise<string> => {
    const { rows } = await db.query<{ allergy_statement: string }>(
      `SELECT allergy_statement FROM patient.patients WHERE id = $1`,
      [patientId],
    );
    return rows[0]?.allergy_statement ?? 'MISSING';
  };

  const fixture = async (): Promise<{ hospitalId: string; userId: string; patientId: string }> => {
    // The patient must start with no allergies of their own. The demo seed gives
    // some patients a history, and deleting *our* row from such a patient
    // correctly leaves the statement at `known` -- which would look like a
    // trigger bug when it is really a fixture that chose the wrong patient.
    const { rows } = await db.query<{ hospital_id: string; user_id: string; patient_id: string }>(
      `SELECT p.hospital_id, p.id AS patient_id, (SELECT id FROM core.users LIMIT 1) AS user_id
         FROM patient.patients p
        WHERE p.allergy_statement = 'not_recorded'
          AND NOT EXISTS (SELECT 1 FROM patient.allergies a WHERE a.patient_id = p.id)
        LIMIT 1`,
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error('fixture: the demo seed produced no patient without an allergy history');
    }
    return { hospitalId: row.hospital_id, userId: row.user_id, patientId: row.patient_id };
  };

  it('reverts to not_recorded when the last allergy is removed, never to none_known', async () => {
    const { hospitalId, userId, patientId } = await fixture();

    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO patient.allergies (id, hospital_id, patient_id, category, substance_text,
         criticality, verification, status, recorded_by, recorded_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'drug', 'Penicillin', 'high', 'confirmed',
         'active', $3, now(), now())
       RETURNING id`,
      [hospitalId, patientId, userId],
    );
    const allergyId = rows[0]?.id;
    expect(allergyId).toBeDefined();
    expect(await statementFor(patientId)).toBe('known');

    // Deleting rows is not the same as a clinician asserting there are none.
    await db.query(`DELETE FROM patient.allergies WHERE id = $1`, [allergyId]);
    expect(await statementFor(patientId)).toBe('not_recorded');
  }, 120_000);

  it('refuses "unable to assess" with no reason', async () => {
    const { userId, patientId } = await fixture();
    // An unexplained "unable to assess" tells the next clinician nothing.
    await expect(
      db.query(
        `UPDATE patient.patients
            SET allergy_statement = 'unable_to_assess', allergy_asserted_by = $2,
                allergy_asserted_at = now(), allergy_unable_reason = NULL
          WHERE id = $1`,
        [patientId, userId],
      ),
    ).rejects.toThrow();
  }, 120_000);

  it('refuses an unattributed "none known"', async () => {
    const { patientId } = await fixture();
    // "No known allergies" is a clinical assertion somebody is accountable for.
    // Unsigned, it is indistinguishable from nobody having asked.
    await expect(
      db.query(
        `UPDATE patient.patients
            SET allergy_statement = 'none_known', allergy_asserted_by = NULL,
                allergy_asserted_at = NULL
          WHERE id = $1`,
        [patientId],
      ),
    ).rejects.toThrow();
  }, 120_000);
});
