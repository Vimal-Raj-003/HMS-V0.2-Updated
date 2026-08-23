import { startTestPostgres, type TestPostgres } from '@vims/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_ESCALATION_LADDER, escalateOverdueCriticalValues } from './critical-value-escalation.js';

/**
 * `OP-004 §5` line 1 and exit gate 2: a critical value that nobody answers must
 * climb the ladder on its own.
 *
 * Everything here is asserted against a real database because every property
 * that matters is a database property: the CHECK that decides what `escalated`
 * may mean, the partial index the query rides, and the outbox row that has to
 * be written in the same transaction as the state change.
 *
 * Alerts are inserted directly rather than driven through
 * `lab.raise_critical_value_alert()`. That trigger has its own tests in the lab
 * suite; what is under test here is the clock-watcher, and building a whole
 * order → sample → result → version chain to reach it would mean a failure
 * could come from six places.
 */
let pg: TestPostgres;

const HOSPITAL = '00000000-0000-7000-8000-00000000h001'.replace('h', 'a');
const BRANCH = '00000000-0000-7000-8000-00000000b001'.replace('b', 'a');

interface AlertSeed {
  readonly id: string;
  readonly minutesAgo: number;
  readonly dueMinutesAgo: number;
  readonly level?: number;
  readonly status?: 'open' | 'communicated' | 'escalated' | 'acknowledged' | 'retracted';
  readonly communicated?: boolean;
}

async function seedAlert(seed: AlertSeed): Promise<void> {
  const status = seed.status ?? 'open';
  // `lab_critical_value_alerts_communicated_pairing` pairs
  // `first_communicated_at` with exactly these three states. `retracted` is not
  // one of them, so a retracted alert must carry no communication timestamp.
  // Defaulting this on `status !== 'open'` got that wrong, and the constraint
  // rejected the fixture -- the constraint doing its job on the test.
  const communicated = seed.communicated ?? ['communicated', 'escalated', 'acknowledged'].includes(status);
  await pg.pool('migrator').query(
    `INSERT INTO lab.lab_critical_value_alerts
       (id, hospital_id, branch_id, result_id, result_version_id, result_version,
        order_id, order_test_id, patient_id, analyte_name, flag, value_display, unit,
        detected_at, due_by, status, escalation_level,
        first_communicated_at,
        acknowledged_by, acknowledged_at,
        retracted_reason, retracted_at,
        created_at, updated_at)
     VALUES ($1, $2, $3, gen_random_uuid(), gen_random_uuid(), 1,
             gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
             'Potassium', 'critical_high', '7.4', 'mmol/L',
             now() - make_interval(mins => $4), now() - make_interval(mins => $5),
             $6::lab."LabCriticalAlertStatus", $7,
             CASE WHEN $8 THEN now() - make_interval(mins => $4) ELSE NULL END,
             CASE WHEN $6 = 'acknowledged' THEN gen_random_uuid() ELSE NULL END,
             CASE WHEN $6 = 'acknowledged' THEN now() ELSE NULL END,
             CASE WHEN $6 = 'retracted' THEN 'wrong patient' ELSE NULL END,
             CASE WHEN $6 = 'retracted' THEN now() ELSE NULL END,
             now(), now())`,
    [seed.id, HOSPITAL, BRANCH, seed.minutesAgo, seed.dueMinutesAgo, status, seed.level ?? 0, communicated],
  );
}

async function readAlert(id: string) {
  const { rows } = await pg.pool('migrator').query<{
    status: string;
    escalation_level: number;
    due_by: Date | null;
    acknowledged_at: Date | null;
    acknowledged_by: string | null;
  }>(
    `SELECT status::text AS status, escalation_level, due_by, acknowledged_at, acknowledged_by
       FROM lab.lab_critical_value_alerts WHERE id = $1`,
    [id],
  );
  return rows[0];
}

async function outboxFor(alertId: string) {
  const { rows } = await pg.pool('migrator').query<{ event_type: string; payload: Record<string, unknown> }>(
    `SELECT event_type, payload FROM core.outbox_events
      WHERE aggregate = 'lab_critical_value' AND aggregate_id = $1
      ORDER BY occurred_at`,
    [alertId],
  );
  return rows;
}

beforeAll(async () => {
  pg = await startTestPostgres();
}, 600_000);

afterAll(async () => {
  await pg?.stop();
});

describe('critical-value escalation (OP-004 §5, EN-037)', () => {
  it('climbs one tier at a time and pushes due_by forward', async () => {
    const id = '11111111-1111-7111-8111-111111111111';
    await seedAlert({ id, minutesAgo: 12, dueMinutesAgo: 2 });

    const first = await escalateOverdueCriticalValues(pg.pool('migrator'));
    expect(first.escalated).toBe(1);

    const afterFirst = await readAlert(id);
    expect(afterFirst?.escalation_level).toBe(1);
    // The second tier is 20 minutes from detection and detection was 12 minutes
    // ago, so the alert must NOT be due again yet. Without the push forward it
    // would re-escalate on the very next tick, once per poll interval, forever.
    expect(afterFirst?.due_by).not.toBeNull();
    expect(afterFirst!.due_by!.getTime()).toBeGreaterThan(Date.now());

    const second = await escalateOverdueCriticalValues(pg.pool('migrator'));
    expect(second.escalated).toBe(0);
  });

  it('leaves an unanswered alert open — the level climbs, the status does not lie', async () => {
    const id = '22222222-2222-7222-8222-222222222222';
    await seedAlert({ id, minutesAgo: 15, dueMinutesAgo: 5, status: 'open', communicated: false });

    await escalateOverdueCriticalValues(pg.pool('migrator'));

    const alert = await readAlert(id);
    expect(alert?.escalation_level).toBe(1);
    // `escalated` would assert the laboratory communicated the value. Nobody
    // answered, which is the entire reason this fired.
    expect(alert?.status).toBe('open');
  });

  it('marks an alert escalated once somebody has actually communicated', async () => {
    const id = '33333333-3333-7333-8333-333333333333';
    await seedAlert({ id, minutesAgo: 15, dueMinutesAgo: 5, status: 'communicated' });

    await escalateOverdueCriticalValues(pg.pool('migrator'));

    const alert = await readAlert(id);
    expect(alert?.status).toBe('escalated');
    expect(alert?.escalation_level).toBe(1);
  });

  /**
   * The property this whole job exists not to break, asserted on an alert the
   * job **did** act on.
   *
   * The first version of the suite tested "never acknowledges" only against
   * alerts that were already acknowledged or retracted -- rows the job skips
   * entirely -- so a mutation that added `acknowledged_at = now()` to the
   * escalating UPDATE passed all seven tests. A closed alert leaves the
   * critical-value console, and the NABL indicator counts it as communicated:
   * the loop reads as closed while nobody has been told a potassium of 7.4.
   */
  it('escalating an alert does not close it', async () => {
    const id = '99999999-9999-7999-8999-999999999999';
    await seedAlert({ id, minutesAgo: 15, dueMinutesAgo: 5, status: 'communicated' });

    const result = await escalateOverdueCriticalValues(pg.pool('migrator'));
    expect(result.escalated).toBeGreaterThanOrEqual(1);

    const alert = await readAlert(id);
    expect(alert?.escalation_level).toBe(1);
    expect(alert?.acknowledged_at).toBeNull();
    expect(alert?.acknowledged_by).toBeNull();
    expect(alert?.status).not.toBe('acknowledged');
    expect(alert?.status).not.toBe('retracted');
  });

  it('never acknowledges, never closes, and never touches a retracted alert', async () => {
    const acknowledged = '44444444-4444-7444-8444-444444444444';
    const retracted = '55555555-5555-7555-8555-555555555555';
    await seedAlert({ id: acknowledged, minutesAgo: 90, dueMinutesAgo: 80, status: 'acknowledged' });
    await seedAlert({ id: retracted, minutesAgo: 90, dueMinutesAgo: 80, status: 'retracted' });

    await escalateOverdueCriticalValues(pg.pool('migrator'));

    expect((await readAlert(acknowledged))?.escalation_level).toBe(0);
    expect((await readAlert(retracted))?.escalation_level).toBe(0);
    expect(await outboxFor(acknowledged)).toHaveLength(0);
    expect(await outboxFor(retracted)).toHaveLength(0);
  });

  it('stops climbing at the top tier but leaves the alert open and overdue', async () => {
    const id = '66666666-6666-7666-8666-666666666666';
    const top = DEFAULT_ESCALATION_LADDER.reduce((max, tier) => Math.max(max, tier.level), 0);
    await seedAlert({ id, minutesAgo: 240, dueMinutesAgo: 200, level: top, status: 'communicated' });

    const result = await escalateOverdueCriticalValues(pg.pool('migrator'));
    expect(result.atTopTier).toBeGreaterThanOrEqual(1);

    const alert = await readAlert(id);
    expect(alert?.escalation_level).toBe(top);
    // Still overdue on purpose: the console sorts by due_by, so the
    // longest-unanswered alert stays where somebody will see it. Auto-closing
    // it would hide the one case that most needs a human.
    expect(alert?.acknowledged_at).toBeNull();
    expect(alert!.due_by!.getTime()).toBeLessThan(Date.now());
  });

  it('writes the announcement in the same transaction as the state change', async () => {
    const id = '77777777-7777-7777-8777-777777777777';
    await seedAlert({ id, minutesAgo: 15, dueMinutesAgo: 5 });

    await escalateOverdueCriticalValues(pg.pool('migrator'), { eventType: 'lab.critical.escalated' });

    const events = await outboxFor(id);
    expect(events).toHaveLength(1);
    expect(events[0]?.event_type).toBe('lab.critical.escalated');
    expect(events[0]?.payload).toMatchObject({
      alertId: id,
      escalationLevel: 1,
      notifyRole: 'hod_on_call',
    });
  });

  it('does not escalate an alert that is not yet due', async () => {
    const id = '88888888-8888-7888-8888-888888888888';
    await seedAlert({ id, minutesAgo: 2, dueMinutesAgo: -8 });

    await escalateOverdueCriticalValues(pg.pool('migrator'));

    expect((await readAlert(id))?.escalation_level).toBe(0);
    expect(await outboxFor(id)).toHaveLength(0);
  });
});
