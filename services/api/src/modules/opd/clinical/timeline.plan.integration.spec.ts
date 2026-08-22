import { newId } from '@vims/contracts';
import { applyTenantContext } from '@vims/db/tenancy';
import { createTenantFixture, startTestPostgres, type TenantFixture, type TestPostgres } from '@vims/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TIMELINE_KINDS, buildTimelineQuery } from './timeline.service.js';

/**
 * phase-02 exit gate 6 — "patient timeline loads 5 years of history in < 1 s p95".
 *
 * A latency budget is only meaningful against a plan, so this suite builds five
 * years of real history for one patient and runs `EXPLAIN (ANALYZE, BUFFERS)`
 * on **the same SQL the service runs** — `buildTimelineQuery` is exported for
 * exactly this reason, so the thing measured cannot drift from the thing
 * served.
 *
 * Two assertions, and both are regression guards rather than benchmarks:
 *
 *  1. **No sequential scan.** Every branch must resolve through its
 *     `(hospital_id, patient_id, <time> DESC)` index. A `Seq Scan` on any of
 *     these tables means the plan has stopped being independent of the length
 *     of the record, which is the failure mode the gate exists to catch — it
 *     would still pass a wall-clock assertion today and fail it in year three.
 *  2. **A wall-clock ceiling far below the budget.** The gate is 1 s p95 on
 *     production hardware; the ceiling here is deliberately generous because CI
 *     runs in a container on shared hardware, and a tight bound would make this
 *     a flaky test rather than a useful one. The plan assertion is the real
 *     control; this one catches an accidental cartesian product.
 *
 * The volumes are the ones a five-year chronic patient actually accumulates:
 * quarterly visits with a consultation and a diagnosis each, monthly
 * observations, and a document per consultation.
 */

let pg: TestPostgres;
let tenants: TenantFixture;

const patientId = newId();
/** The acting user for the explained plan; `app.user_id` must be set for RLS. */
const readerId = newId();
/**
 * The rest of the hospital's record.
 *
 * Without it the planner is right to sequentially scan a twenty-row table, and
 * the test would assert nothing about how the query behaves in a hospital. This
 * is roughly one branch-month of OPD activity.
 */
const BACKGROUND_PATIENTS = 400;
const YEARS = 5;
const VISITS = 5 * 4; // quarterly
const VITALS = 5 * 12; // monthly
const HISTORY_DAYS = YEARS * 365;

/**
 * The indexes the timeline must ride, by name.
 *
 * `clinical.vitals` is partitioned, so its index name carries the partition
 * suffix; the shared tail is what identifies it.
 */
const GROWING_INDEXES = [
  'op_visits_hospital_id_patient_id_checked_in_at_idx',
  'encounters_hospital_id_patient_id_started_at_idx',
  'encounter_diagnoses_hospital_id_patient_id_created_at_idx',
  'documents_hospital_id_patient_id_created_at_idx',
  'hospital_id_patient_id_recorded_at_idx',
] as const;

interface PlanResult {
  readonly text: string;
  readonly executionMs: number;
}

/**
 * Explains the query **as the application role, with the tenancy scope set** —
 * not as the migrator.
 *
 * That is not a detail. Every index on these tables leads with `hospital_id`,
 * and the predicate that supplies it is the row-level security policy, which
 * `hms_migrator` bypasses by ownership. A plan taken as the migrator therefore
 * has no `hospital_id` qual, cannot use the leading column, and measures a
 * query the application never runs.
 */
async function explain(sql: string, values: readonly unknown[]): Promise<PlanResult> {
  const client = await pg.pool('app').connect();
  try {
    await client.query('BEGIN');
    await applyTenantContext(client, {
      hospitalId: tenants.hospitalA,
      userId: readerId,
      scope: 'branch',
      branchIds: [tenants.branchA],
    });
    const result = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sql}`, [...values]);
    const text = result.rows.map((row: Record<string, string>) => row['QUERY PLAN']).join('\n');
    const match = /Execution Time: ([\d.]+) ms/.exec(text);
    await client.query('ROLLBACK');
    return { text, executionMs: match === null ? Number.NaN : Number(match[1]) };
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  pg = await startTestPostgres();
  tenants = await createTenantFixture(pg, { codePrefix: 'TML' });
  const pool = pg.pool('migrator');

  await pool.query(
    `INSERT INTO patient.patients
       (id, hospital_id, branch_id, uhid, uhid_normalised, first_name, full_name,
        gender, dob, mobile, mobile_local, dedupe_fingerprint, updated_at)
     VALUES ($1, $2, $3, 'TML00001', 'TML00001', 'Timeline', 'Timeline Patient',
             'male', '1970-01-01', '+919845000001', '9845000001', 'tmlfingerprint', now())`,
    [patientId, tenants.hospitalA, tenants.branchA],
  );

  // Five years of visits, each with a consultation, a diagnosis and a document.
  await pool.query(
    `INSERT INTO clinical.op_visits
       (id, hospital_id, branch_id, visit_no, patient_id, status, checked_in_at, updated_at)
     SELECT gen_random_uuid(), $1, $2, 'TML-V' || g, $3, 'closed',
            now() - (g || ' days')::interval * ($4::int / $5::int), now()
       FROM generate_series(1, $5::int) AS g`,
    [tenants.hospitalA, tenants.branchA, patientId, HISTORY_DAYS, VISITS],
  );

  await pool.query(
    `INSERT INTO clinical.encounters
       (id, hospital_id, branch_id, patient_id, type, status, started_at, completed_at, updated_at, visit_id)
     SELECT gen_random_uuid(), $1, $2, $3, 'opd', 'completed',
            now() - (g || ' days')::interval * ($4::int / $5::int),
            now() - (g || ' days')::interval * ($4::int / $5::int), now(),
            (SELECT id FROM clinical.op_visits WHERE patient_id = $3 LIMIT 1)
       FROM generate_series(1, $5::int) AS g`,
    [tenants.hospitalA, tenants.branchA, patientId, HISTORY_DAYS, VISITS],
  );

  await pool.query(
    `INSERT INTO clinical.encounter_diagnoses
       (id, hospital_id, encounter_id, patient_id, code_system_key, code, description, created_at, updated_at)
     SELECT gen_random_uuid(), $1, e.id, $2, 'ICD10', 'J06.9', 'Acute URI', e.started_at, now()
       FROM clinical.encounters e WHERE e.patient_id = $2`,
    [tenants.hospitalA, patientId],
  );

  await pool.query(
    `INSERT INTO clinical.documents
       (id, hospital_id, branch_id, patient_id, encounter_id, type, title, created_at, updated_at)
     SELECT gen_random_uuid(), $1, $2, $3, e.id, 'consult_note', 'OPD consultation note',
            e.started_at, now()
       FROM clinical.encounters e WHERE e.patient_id = $3`,
    [tenants.hospitalA, tenants.branchA, patientId],
  );

  // Monthly observations, spread across the monthly partitions.
  await pool.query(
    `INSERT INTO clinical.vitals
       (id, hospital_id, branch_id, patient_id, context, recorded_at, recorded_by,
        systolic, diastolic, pulse, updated_at)
     SELECT gen_random_uuid(), $1, $2, $3, 'kiosk',
            now() - (g || ' days')::interval * ($4::int / $5::int), $3,
            118 + (g % 20), 76 + (g % 10), 70 + (g % 25), now()
       FROM generate_series(1, $5::int) AS g`,
    [tenants.hospitalA, tenants.branchA, patientId, HISTORY_DAYS, VITALS],
  );

  // The rest of the hospital: 400 other patients with the same five-year
  // shape, so the planner is choosing between an index and a scan of something
  // that is actually large.
  await pool.query(
    `INSERT INTO patient.patients
       (id, hospital_id, branch_id, uhid, uhid_normalised, first_name, full_name,
        gender, dob, mobile, mobile_local, dedupe_fingerprint, updated_at)
     SELECT gen_random_uuid(), $1, $2, 'TMLB' || g, 'TMLB' || g, 'Background', 'Background Patient',
            'male', '1970-01-01', '+91984' || lpad(g::text, 7, '0'), '984' || lpad(g::text, 7, '0'),
            'bg' || g, now()
       FROM generate_series(1, $3::int) AS g`,
    [tenants.hospitalA, tenants.branchA, BACKGROUND_PATIENTS],
  );

  await pool.query(
    `INSERT INTO clinical.op_visits
       (id, hospital_id, branch_id, visit_no, patient_id, status, checked_in_at, updated_at)
     SELECT gen_random_uuid(), $1, $2, 'TMLB-' || p.uhid || '-' || g, p.id, 'closed',
            now() - (g * 90 || ' days')::interval, now()
       FROM patient.patients p
       CROSS JOIN generate_series(1, $3::int) AS g
      WHERE p.uhid LIKE 'TMLB%'`,
    [tenants.hospitalA, tenants.branchA, VISITS],
  );

  // One encounter per visit: `encounters_episode` refuses a note with no
  // episode, which is the constraint doing its job.
  await pool.query(
    `INSERT INTO clinical.encounters
       (id, hospital_id, branch_id, patient_id, visit_id, type, status,
        started_at, completed_at, updated_at)
     SELECT gen_random_uuid(), $1, $2, v.patient_id, v.id, 'opd', 'completed',
            v.checked_in_at, v.checked_in_at, now()
       FROM clinical.op_visits v
      WHERE v.visit_no LIKE 'TMLB-%'`,
    [tenants.hospitalA, tenants.branchA],
  );

  await pool.query(
    `INSERT INTO clinical.encounter_diagnoses
       (id, hospital_id, encounter_id, patient_id, code_system_key, code, description, created_at, updated_at)
     SELECT gen_random_uuid(), $1, e.id, e.patient_id, 'ICD10', 'J06.9', 'Acute URI', e.started_at, now()
       FROM clinical.encounters e
       JOIN patient.patients p ON p.id = e.patient_id
      WHERE p.uhid LIKE 'TMLB%'`,
    [tenants.hospitalA],
  );

  await pool.query(
    `INSERT INTO clinical.documents
       (id, hospital_id, branch_id, patient_id, encounter_id, type, title, created_at, updated_at)
     SELECT gen_random_uuid(), $1, $2, e.patient_id, e.id, 'consult_note', 'OPD consultation note',
            e.started_at, now()
       FROM clinical.encounters e
       JOIN patient.patients p ON p.id = e.patient_id
      WHERE p.uhid LIKE 'TMLB%'`,
    [tenants.hospitalA, tenants.branchA],
  );

  await pool.query(
    `INSERT INTO clinical.vitals
       (id, hospital_id, branch_id, patient_id, context, recorded_at, recorded_by,
        systolic, diastolic, pulse, updated_at)
     SELECT gen_random_uuid(), $1, $2, p.id, 'kiosk',
            now() - (g * 30 || ' days')::interval, p.id,
            118 + (g % 20), 76 + (g % 10), 70 + (g % 25), now()
       FROM patient.patients p
       CROSS JOIN generate_series(1, $3::int) AS g
      WHERE p.uhid LIKE 'TMLB%'`,
    [tenants.hospitalA, tenants.branchA, VITALS],
  );

  await pool.query('ANALYZE clinical.op_visits, clinical.encounters, clinical.encounter_diagnoses');
  await pool.query('ANALYZE clinical.documents, clinical.vitals, clinical.problems, patient.allergies');
}, 600_000);

afterAll(async () => {
  await pg?.stop();
});

describe('the patient timeline plan', () => {
  it('has five years of history to read, inside a populated hospital', async () => {
    const counts = await pg.pool('migrator').query(
      `SELECT
         (SELECT count(*) FROM clinical.op_visits WHERE patient_id = $1) AS visits,
         (SELECT count(*) FROM clinical.encounters WHERE patient_id = $1) AS encounters,
         (SELECT count(*) FROM clinical.encounter_diagnoses WHERE patient_id = $1) AS diagnoses,
         (SELECT count(*) FROM clinical.documents WHERE patient_id = $1) AS documents,
         (SELECT count(*) FROM clinical.vitals WHERE patient_id = $1) AS vitals`,
      [patientId],
    );
    const row = counts.rows[0];
    expect(Number(row.visits)).toBe(VISITS);
    expect(Number(row.encounters)).toBe(VISITS);
    expect(Number(row.diagnoses)).toBe(VISITS);
    expect(Number(row.documents)).toBe(VISITS);
    expect(Number(row.vitals)).toBe(VITALS);
  });

  it('reads the first page through indexes only, with no sequential scan', async () => {
    const built = buildTimelineQuery({
      patientId,
      kinds: TIMELINE_KINDS,
      from: new Date(Date.now() - 5 * 365.25 * 86_400_000).toISOString(),
      to: null,
      cursor: null,
      limit: 26,
    });
    expect(built.sql).not.toBeNull();

    const plan = await explain(built.sql ?? '', built.values);

    // Every branch that grows with the length of the record resolves through
    // its own `(hospital_id, patient_id, <time> DESC)` index. Asserting the
    // index *by name* is the point: it fails if somebody adds a predicate the
    // index cannot serve, and it fails long before the wall clock would.
    for (const index of GROWING_INDEXES) {
      expect(plan.text, plan.text).toContain(index);
    }

    // …and none of them is scanned sequentially. `clinical.vitals` is excluded
    // from this list only because it is partitioned: the empty future-month
    // partitions are "scanned" for zero rows, which is what pruning looks like
    // in a plan, and the partition that holds the data is on the line above.
    expect(plan.text, plan.text).not.toMatch(
      /Seq Scan on (op_visits|encounters|encounter_diagnoses|documents)\b/,
    );

    expect(plan.executionMs).toBeLessThan(1000);
  });

  it('reads a deep page as cheaply as the first one', async () => {
    const first = buildTimelineQuery({
      patientId,
      kinds: TIMELINE_KINDS,
      from: new Date(Date.now() - 5 * 365.25 * 86_400_000).toISOString(),
      to: null,
      cursor: null,
      limit: 26,
    });
    const firstRows = await pg.pool('migrator').query(first.sql ?? '', [...first.values]);
    const last = firstRows.rows[firstRows.rows.length - 1] as { cursor_key: string; id: string };

    const deep = buildTimelineQuery({
      patientId,
      kinds: TIMELINE_KINDS,
      from: new Date(Date.now() - 5 * 365.25 * 86_400_000).toISOString(),
      to: null,
      cursor: { at: last.cursor_key, id: last.id },
      limit: 26,
    });

    const plan = await explain(deep.sql ?? '', deep.values);
    // Keyset, not OFFSET: page 2 does not re-read page 1, and it reaches its
    // rows through the same indexes as page 1 — which is the property `OFFSET`
    // does not have and the reason `docs/07` §4 bans it.
    for (const index of GROWING_INDEXES) {
      expect(plan.text, plan.text).toContain(index);
    }
    expect(plan.executionMs).toBeLessThan(1000);
  });

  it('reads fewer sources when the caller filters, rather than more rows', async () => {
    const filtered = buildTimelineQuery({
      patientId,
      kinds: ['vitals'],
      from: new Date(Date.now() - 5 * 365.25 * 86_400_000).toISOString(),
      to: null,
      cursor: null,
      limit: 26,
    });

    const plan = await explain(filtered.sql ?? '', filtered.values);
    expect(plan.text).not.toContain('encounter_diagnoses');
    expect(plan.text).not.toContain('op_visits');
    expect(plan.executionMs).toBeLessThan(1000);
  });
});
