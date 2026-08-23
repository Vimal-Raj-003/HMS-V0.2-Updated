import { startTestPostgres, type TestPostgres } from '@vims/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_ESCALATION_LADDER,
  LAB_CRITICAL_QUEUE,
  RAD_CRITICAL_QUEUE,
  escalateOverdueCriticalValues,
  type CriticalQueue,
} from './critical-value-escalation.js';

/**
 * `OP-004 §5` line 1 / `OP-005` critical findings, and Phase 3 exit gate 2: a
 * critical result that nobody answers must climb the ladder on its own.
 *
 * Run against a real database because every property that matters is a database
 * property: the CHECK that decides what `escalated` may mean, the partial index
 * the query rides, and the outbox row that must be written in the same
 * transaction as the state change.
 *
 * **Both queues get the whole suite.** `rad.rad_critical_findings` shares the
 * status enum, the columns and the CHECK with `lab.lab_critical_value_alerts`,
 * so it shares the job — and running the assertions only against lab would leave
 * the radiology path with a copy of "never close an alert" that nobody ever
 * mutation-tested. That is precisely how the second copy of a safety property
 * goes wrong.
 *
 * Rows are inserted directly rather than driven through the raise triggers.
 * Those triggers have their own tests in the lab and radiology suites; what is
 * under test here is the clock-watcher, and building a whole order → sample →
 * result → version chain to reach it would mean a failure could come from six
 * places.
 */
let pg: TestPostgres;

const HOSPITAL = '00000000-0000-7000-8000-0000000000a1';
const BRANCH = '00000000-0000-7000-8000-0000000000b1';

type AlertStatus = 'open' | 'communicated' | 'escalated' | 'acknowledged' | 'retracted';

interface AlertSeed {
  readonly id: string;
  readonly minutesAgo: number;
  readonly dueMinutesAgo: number;
  readonly level?: number;
  readonly status?: AlertStatus;
  readonly communicated?: boolean;
}

/** The columns each table needs beyond the shared escalation core. */
const EXTRA_COLUMNS: Record<string, { readonly names: string; readonly values: string }> = {
  [LAB_CRITICAL_QUEUE.table]: {
    names:
      'result_id, result_version_id, result_version, order_id, order_test_id, analyte_name, flag, value_display, unit',
    values: `gen_random_uuid(), gen_random_uuid(), 1, gen_random_uuid(), gen_random_uuid(), 'Potassium', 'critical_high', '7.4', 'mmol/L'`,
  },
  [RAD_CRITICAL_QUEUE.table]: {
    // `$9` is the report id from `ensureRadParents()` — see its comment.
    names: 'report_id, report_version, order_item_id, level, finding_text',
    values: `$9, 1, gen_random_uuid(), 'critical', 'Large left tension pneumothorax with mediastinal shift.'`,
  },
};

/**
 * Radiology's finding has a real foreign key to `rad.rad_reports`, which has one
 * to `rad.rad_order_items`, which has one to `rad.rad_orders`. Lab's alert table
 * has no outbound keys at all, so the lab fixture could invent ids and the
 * radiology one cannot — the first run of this suite passed nine lab tests and
 * failed nine radiology ones on exactly that.
 *
 * The chain is built once and shared: what is under test is the clock, not
 * radiology's data model, and a fresh order per assertion would only add ways
 * for the fixture to fail.
 */
let radReportId: string | null = null;

async function ensureRadParents(): Promise<string> {
  if (radReportId !== null) return radReportId;
  const pool = pg.pool('migrator');
  const orderId = '33333333-3333-7333-8333-333333333331';
  const itemId = '33333333-3333-7333-8333-333333333332';
  const reportId = '33333333-3333-7333-8333-333333333333';

  await pool.query(
    `INSERT INTO rad.rad_orders (id, hospital_id, branch_id, accession_no, patient_id,
                                 clinical_indication, updated_at)
     VALUES ($1, $2, $3, 'TEST/RAD/0001', gen_random_uuid(), 'escalation fixture', now())
     ON CONFLICT (id) DO NOTHING`,
    [orderId, HOSPITAL, BRANCH],
  );
  await pool.query(
    `INSERT INTO rad.rad_order_items (id, hospital_id, order_id, line_no, procedure_key,
                                      procedure_code, procedure_name, modality, updated_at)
     VALUES ($1, $2, $3, 1, gen_random_uuid(), 'CXR', 'Chest X-ray', 'CR', now())
     ON CONFLICT (id) DO NOTHING`,
    [itemId, HOSPITAL, orderId],
  );
  await pool.query(
    `INSERT INTO rad.rad_reports (id, hospital_id, branch_id, order_item_id, patient_id,
                                  accession_no, updated_at)
     VALUES ($1, $2, $3, $4, gen_random_uuid(), 'TEST/RAD/0001', now())
     ON CONFLICT (id) DO NOTHING`,
    [reportId, HOSPITAL, BRANCH, itemId],
  );

  radReportId = reportId;
  return reportId;
}

async function seedAlert(queue: CriticalQueue, seed: AlertSeed): Promise<void> {
  const status: AlertStatus = seed.status ?? 'open';
  // `<queue>_communicated_pairing` pairs `first_communicated_at` with exactly
  // these three states. `retracted` is not one of them, so a retracted row must
  // carry no communication timestamp. Defaulting this on `status !== 'open'`
  // got that wrong and the constraint rejected the fixture — the constraint
  // doing its job on the test.
  const communicated = seed.communicated ?? ['communicated', 'escalated', 'acknowledged'].includes(status);
  const extra = EXTRA_COLUMNS[queue.table];
  if (extra === undefined) throw new Error(`no fixture columns for ${queue.table}`);
  const params: unknown[] = [
    seed.id,
    HOSPITAL,
    BRANCH,
    seed.minutesAgo,
    seed.dueMinutesAgo,
    status,
    seed.level ?? 0,
    communicated,
  ];
  if (queue === RAD_CRITICAL_QUEUE) params.push(await ensureRadParents());

  await pg.pool('migrator').query(
    `INSERT INTO ${queue.table}
       (id, hospital_id, branch_id, patient_id, ${extra.names},
        detected_at, due_by, status, escalation_level, first_communicated_at,
        acknowledged_by, acknowledged_at, retracted_reason, retracted_at,
        created_at, updated_at)
     VALUES ($1, $2, $3, gen_random_uuid(), ${extra.values},
             now() - make_interval(mins => $4), now() - make_interval(mins => $5),
             $6::lab."LabCriticalAlertStatus", $7,
             CASE WHEN $8 THEN now() - make_interval(mins => $4) ELSE NULL END,
             CASE WHEN $6 = 'acknowledged' THEN gen_random_uuid() ELSE NULL END,
             CASE WHEN $6 = 'acknowledged' THEN now() ELSE NULL END,
             CASE WHEN $6 = 'retracted' THEN 'wrong patient' ELSE NULL END,
             CASE WHEN $6 = 'retracted' THEN now() ELSE NULL END,
             now(), now())`,
    params,
  );
}

interface AlertRow {
  status: string;
  escalation_level: number;
  due_by: Date | null;
  acknowledged_at: Date | null;
  acknowledged_by: string | null;
}

async function readAlert(queue: CriticalQueue, id: string): Promise<AlertRow | undefined> {
  const { rows } = await pg.pool('migrator').query<AlertRow>(
    `SELECT status::text AS status, escalation_level, due_by, acknowledged_at, acknowledged_by
         FROM ${queue.table} WHERE id = $1`,
    [id],
  );
  return rows[0];
}

async function outboxFor(queue: CriticalQueue, alertId: string) {
  const { rows } = await pg.pool('migrator').query<{ event_type: string; payload: Record<string, unknown> }>(
    `SELECT event_type, payload FROM core.outbox_events
        WHERE aggregate = $2 AND aggregate_id = $1
        ORDER BY occurred_at`,
    [alertId, queue.aggregate],
  );
  return rows;
}

beforeAll(async () => {
  pg = await startTestPostgres();
}, 600_000);

afterAll(async () => {
  await pg?.stop();
});

/** Distinct id space per queue so the two runs cannot mask each other. */
const IDS: Record<string, (n: number) => string> = {
  [LAB_CRITICAL_QUEUE.table]: (n) => `1111111${n}-1111-7111-8111-111111111111`,
  [RAD_CRITICAL_QUEUE.table]: (n) => `2222222${n}-2222-7222-8222-222222222222`,
};

describe.each([
  ['laboratory', LAB_CRITICAL_QUEUE],
  ['radiology', RAD_CRITICAL_QUEUE],
] as const)('critical-value escalation — %s (OP-004 §5, OP-005, EN-037)', (_name, queue) => {
  const id = (n: number): string => {
    const make = IDS[queue.table];
    if (make === undefined) throw new Error(`no id space for ${queue.table}`);
    return make(n);
  };

  it('climbs one tier at a time and pushes due_by forward', async () => {
    const alertId = id(1);
    await seedAlert(queue, { id: alertId, minutesAgo: 12, dueMinutesAgo: 2 });

    const first = await escalateOverdueCriticalValues(pg.pool('migrator'), queue);
    expect(first.escalated).toBeGreaterThanOrEqual(1);

    const afterFirst = await readAlert(queue, alertId);
    expect(afterFirst?.escalation_level).toBe(1);
    // Tier 2 is 20 minutes from detection and detection was 12 minutes ago, so
    // the alert must not be due again yet. Without the push forward it would
    // re-escalate on the very next tick, once per poll interval, forever.
    expect(afterFirst?.due_by).not.toBeNull();
    expect(afterFirst?.due_by?.getTime()).toBeGreaterThan(Date.now());

    const second = await escalateOverdueCriticalValues(pg.pool('migrator'), queue);
    expect(second.escalated).toBe(0);
  });

  it('leaves an unanswered alert open — the level climbs, the status does not lie', async () => {
    const alertId = id(2);
    await seedAlert(queue, {
      id: alertId,
      minutesAgo: 15,
      dueMinutesAgo: 5,
      status: 'open',
      communicated: false,
    });

    await escalateOverdueCriticalValues(pg.pool('migrator'), queue);

    const alert = await readAlert(queue, alertId);
    expect(alert?.escalation_level).toBe(1);
    // `escalated` would assert somebody was told. Nobody answered, which is the
    // entire reason this fired.
    expect(alert?.status).toBe('open');
  });

  it('marks an alert escalated once somebody has actually communicated', async () => {
    const alertId = id(3);
    await seedAlert(queue, { id: alertId, minutesAgo: 15, dueMinutesAgo: 5, status: 'communicated' });

    await escalateOverdueCriticalValues(pg.pool('migrator'), queue);

    const alert = await readAlert(queue, alertId);
    expect(alert?.status).toBe('escalated');
    expect(alert?.escalation_level).toBe(1);
  });

  /**
   * The property this job exists not to break, asserted on a row the job
   * **did** act on.
   *
   * The first version of the suite tested "never acknowledges" only against
   * rows that were already acknowledged or retracted — rows the job skips
   * entirely — so a mutation adding `acknowledged_at = now()` to the escalating
   * UPDATE passed every test. A closed alert leaves the console and counts as
   * communicated on the NABL indicator: the loop reads as closed while nobody
   * has been told about a potassium of 7.4.
   */
  it('escalating an alert does not close it', async () => {
    const alertId = id(4);
    await seedAlert(queue, { id: alertId, minutesAgo: 15, dueMinutesAgo: 5, status: 'communicated' });

    const result = await escalateOverdueCriticalValues(pg.pool('migrator'), queue);
    expect(result.escalated).toBeGreaterThanOrEqual(1);

    const alert = await readAlert(queue, alertId);
    expect(alert?.escalation_level).toBe(1);
    expect(alert?.acknowledged_at).toBeNull();
    expect(alert?.acknowledged_by).toBeNull();
    expect(alert?.status).not.toBe('acknowledged');
    expect(alert?.status).not.toBe('retracted');
  });

  it('never touches an acknowledged or retracted alert', async () => {
    const acknowledged = id(5);
    const retracted = id(6);
    await seedAlert(queue, { id: acknowledged, minutesAgo: 90, dueMinutesAgo: 80, status: 'acknowledged' });
    await seedAlert(queue, { id: retracted, minutesAgo: 90, dueMinutesAgo: 80, status: 'retracted' });

    await escalateOverdueCriticalValues(pg.pool('migrator'), queue);

    expect((await readAlert(queue, acknowledged))?.escalation_level).toBe(0);
    expect((await readAlert(queue, retracted))?.escalation_level).toBe(0);
    expect(await outboxFor(queue, acknowledged)).toHaveLength(0);
    expect(await outboxFor(queue, retracted)).toHaveLength(0);
  });

  it('stops climbing at the top tier but leaves the alert open and overdue', async () => {
    const alertId = id(7);
    const top = DEFAULT_ESCALATION_LADDER.reduce((max, tier) => Math.max(max, tier.level), 0);
    await seedAlert(queue, {
      id: alertId,
      minutesAgo: 240,
      dueMinutesAgo: 200,
      level: top,
      status: 'communicated',
    });

    const result = await escalateOverdueCriticalValues(pg.pool('migrator'), queue);
    expect(result.atTopTier).toBeGreaterThanOrEqual(1);

    const alert = await readAlert(queue, alertId);
    expect(alert?.escalation_level).toBe(top);
    // Still overdue on purpose: the console sorts by due_by, so the
    // longest-unanswered alert stays where somebody will see it. Auto-closing it
    // would hide the one case that most needs a human.
    expect(alert?.acknowledged_at).toBeNull();
    expect(alert?.due_by?.getTime()).toBeLessThan(Date.now());
  });

  it('writes the announcement in the same transaction as the state change', async () => {
    const alertId = id(8);
    await seedAlert(queue, { id: alertId, minutesAgo: 15, dueMinutesAgo: 5 });

    await escalateOverdueCriticalValues(pg.pool('migrator'), queue);

    const events = await outboxFor(queue, alertId);
    expect(events).toHaveLength(1);
    expect(events[0]?.event_type).toBe(queue.eventType);
    expect(events[0]?.payload).toMatchObject({
      alertId,
      escalationLevel: 1,
      notifyRole: 'hod_on_call',
    });
  });

  it('carries the queue-specific detail into the payload', async () => {
    const alertId = id(9);
    await seedAlert(queue, { id: alertId, minutesAgo: 15, dueMinutesAgo: 5 });

    await escalateOverdueCriticalValues(pg.pool('migrator'), queue);

    const payload = (await outboxFor(queue, alertId))[0]?.payload ?? {};
    // Whoever is being paged needs to know what about. An envelope with ids and
    // no clinical detail is a page that says "something happened".
    if (queue === LAB_CRITICAL_QUEUE) {
      expect(payload).toMatchObject({ analyteName: 'Potassium', value: '7.4', unit: 'mmol/L' });
    } else {
      expect(payload).toMatchObject({ level: 'critical' });
      expect(String(payload['finding'])).toContain('pneumothorax');
    }
  });

  it('does not escalate an alert that is not yet due', async () => {
    const alertId = id(0);
    await seedAlert(queue, { id: alertId, minutesAgo: 2, dueMinutesAgo: -8 });

    await escalateOverdueCriticalValues(pg.pool('migrator'), queue);

    expect((await readAlert(queue, alertId))?.escalation_level).toBe(0);
    expect(await outboxFor(queue, alertId)).toHaveLength(0);
  });
});
