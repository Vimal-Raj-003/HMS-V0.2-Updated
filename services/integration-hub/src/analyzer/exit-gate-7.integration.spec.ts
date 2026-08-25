import { newId } from '@vims/contracts';
import type { TenantContext } from '@vims/db/tenancy';
import { createTenantFixture, startTestPostgres, type TenantFixture, type TestPostgres } from '@vims/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Clock } from '../adapter/types.js';
import { IntegrationDatabase } from '../db/database.js';
import { silentLogger } from '../logger.js';
import { hl7Driver } from './driver.js';
import { AnalyzerForwarder } from './forwarder.js';
import { AnalyzerIngress } from './ingress.js';
import { InstrumentStore } from './instrument-store.js';
import { buildOruMessage } from './simulator.js';
import type { AnalyzerInstrument, LabResultDelivery, LabResultOutcome, LabResultSink } from './types.js';

/**
 * Phase 3 exit gate 7, asserted rather than asserted-about.
 *
 * > "Analyzer disconnected for 30 minutes → messages buffer and replay with
 * > zero loss; unmatched queue works."
 *
 * The analyzer layer arrived with sixteen source files and no tests. Its
 * comments state the property clearly and the ordering in `ingress.ts` looks
 * right, but "we persist before we ACK" is a sentence that survives exactly one
 * refactor when nothing checks it. This is what checks it.
 *
 * Run against a real PostgreSQL, as `hms_app` — `NOBYPASSRLS`, owning nothing,
 * the same role a real request uses. The properties under test are properties of
 * the running database: the buffered queue, the duplicate index, the error
 * queue's constraints. A mock would go green while production lost results.
 */
class TestClock implements Clock {
  private t: Date;
  constructor(start: Date) {
    this.t = start;
  }
  now(): Date {
    return new Date(this.t.getTime());
  }
  advance(ms: number): void {
    this.t = new Date(this.t.getTime() + ms);
  }
}

/**
 * The laboratory, and whether it is reachable.
 *
 * `unavailable` is the transient outcome the forwarder must treat as "leave it
 * buffered and stop", as distinct from `unmatched_sample`, which is a durable
 * answer that belongs in the error queue.
 */
class FakeLaboratory implements LabResultSink {
  up = true;
  readonly applied: string[] = [];
  /** Specimen ids the laboratory does not know — the unmatched path. */
  readonly unknown = new Set<string>();

  deliver(delivery: LabResultDelivery): Promise<LabResultOutcome> {
    if (!this.up) {
      return Promise.resolve({ status: 'unavailable', reason: 'laboratory unreachable' });
    }
    const specimen = delivery.batch.specimenIdRaw ?? '';
    if (this.unknown.has(specimen)) {
      return Promise.resolve({ status: 'unmatched_sample' });
    }
    this.applied.push(specimen);
    return Promise.resolve({ status: 'applied', sampleId: newId(), resultCount: 1 });
  }
}

let pg: TestPostgres;
let tenants: TenantFixture;
let db: IntegrationDatabase;
let clock: TestClock;
let ctx: TenantContext;
let instrument: AnalyzerInstrument;
let ingress: AnalyzerIngress;
let forwarder: AnalyzerForwarder;
let lab: FakeLaboratory;

const INSTRUMENT_ID = '018f3a20-0000-7000-8000-0000000a0001';
const TEST_KEY = '018f3a20-0000-7000-8000-0000000a0002';
const ANALYSER_CODE = 'K';

beforeAll(async () => {
  pg = await startTestPostgres();
  tenants = await createTenantFixture(pg);
  db = new IntegrationDatabase(pg.pool('app'));
  ctx = {
    hospitalId: tenants.hospitalA,
    userId: newId(),
    scope: 'branch',
    branchIds: [tenants.branchA],
  };

  const owner = pg.pool('migrator');
  // A serial is not optional: `lab_instruments_live_needs_serial` refuses a
  // `live` analyzer without one, because that number is what identifies the
  // instrument in a NABL QA record.
  await owner.query(
    `INSERT INTO integration.lab_instruments
       (id, hospital_id, branch_id, code, name, discipline, driver_key, protocol, transport,
        serial, status, host_query_mode, send_demographics, raw_retention_days, updated_at)
     VALUES ($1, $2, $3, 'XN1000', 'Sysmex XN-1000', 'haematology', 'hl7_generic', 'hl7_v2', 'tcp_server',
             'XN-1000-TEST-0001', 'live', false, false, 90, now())
     ON CONFLICT (id) DO NOTHING`,
    [INSTRUMENT_ID, tenants.hospitalA, tenants.branchA],
  );
  await owner.query(
    `INSERT INTO integration.lab_instrument_test_maps
       (id, hospital_id, instrument_id, instrument_code, test_key, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, now())
     ON CONFLICT DO NOTHING`,
    [tenants.hospitalA, INSTRUMENT_ID, ANALYSER_CODE, TEST_KEY],
  );

  const store = new InstrumentStore(db);
  const found = await store.get(ctx, INSTRUMENT_ID);
  if (found === undefined) throw new Error('the test instrument was not readable through RLS');
  instrument = found;
}, 900_000);

afterAll(async () => {
  await pg?.stop();
});

beforeEach(async () => {
  await pg.pool('migrator').query('DELETE FROM integration.lab_if_error_queue');
  await pg.pool('migrator').query('DELETE FROM integration.lab_if_messages');
  clock = new TestClock(new Date('2026-08-23T09:00:00.000Z'));
  lab = new FakeLaboratory();
  ingress = new AnalyzerIngress({ db, clock, newId, logger: silentLogger });
  forwarder = new AnalyzerForwarder({
    db,
    sink: lab,
    instruments: new InstrumentStore(db),
    clock,
    newId,
    logger: silentLogger,
  });
});

function oru(sequence: number): Buffer {
  return Buffer.from(
    buildOruMessage({
      controlId: `MSG${String(sequence).padStart(5, '0')}`,
      specimenId: `SPEC${String(sequence).padStart(5, '0')}`,
      patientName: 'SUBRAMANIAN^RAMESH',
      patientId: 'CBE-000123456',
      observations: [{ code: ANALYSER_CODE, value: '4.2', unit: 'mmol/L' }],
    }),
    'utf8',
  );
}

async function drainAll(): Promise<number> {
  let applied = 0;
  for (let pass = 0; pass < 20; pass += 1) {
    const report = await forwarder.drain(ctx, instrument, hl7Driver, { limit: 50 });
    applied += report.applied;
    if (report.attempted === 0) break;
  }
  return applied;
}

describe('exit gate 7 — a thirty-minute outage loses nothing', () => {
  const FRAMES = 40;

  it('acknowledges every frame while the laboratory is unreachable', async () => {
    lab.up = false;

    const decisions = [];
    for (let i = 1; i <= FRAMES; i += 1) {
      const result = await ingress.accept({ ctx, instrument, driver: hl7Driver, raw: oru(i) });
      decisions.push(result.decision.kind);
      clock.advance(45_000); // 30 minutes across 40 frames.
    }

    // The analyzer's ACK depends on *this* service's database and on nothing
    // else. If it depended on the laboratory, a downstream outage would become
    // an analyzer that retries, then blocks, then drops on the floor — which is
    // the loss this gate exists to prevent.
    expect(decisions.every((kind) => kind === 'stored')).toBe(true);
    expect(lab.applied).toHaveLength(0);
  });

  it('replays all forty when the laboratory returns, exactly once and in order', async () => {
    lab.up = false;
    for (let i = 1; i <= FRAMES; i += 1) {
      await ingress.accept({ ctx, instrument, driver: hl7Driver, raw: oru(i) });
      clock.advance(45_000);
    }
    // Nothing can be delivered while it is down, and the queue must stop rather
    // than skip ahead — order is preserved for a reason: a corrected result must
    // not overtake the value it corrects.
    const duringOutage = await forwarder.drain(ctx, instrument, hl7Driver, { limit: 50 });
    expect(duringOutage.applied).toBe(0);
    expect(duringOutage.deferred).toBeGreaterThan(0);

    lab.up = true;
    const applied = await drainAll();

    expect(applied).toBe(FRAMES);
    expect(lab.applied).toHaveLength(FRAMES);
    expect(new Set(lab.applied).size).toBe(FRAMES);
    expect(lab.applied).toEqual(
      Array.from({ length: FRAMES }, (_, i) => `SPEC${String(i + 1).padStart(5, '0')}`),
    );
  });

  it('leaves nothing buffered once the backlog has drained', async () => {
    lab.up = false;
    for (let i = 1; i <= 10; i += 1) {
      await ingress.accept({ ctx, instrument, driver: hl7Driver, raw: oru(i) });
    }
    lab.up = true;
    await drainAll();

    const { rows } = await pg.pool('migrator').query<{ n: string }>(
      `SELECT count(*)::text AS n FROM integration.lab_if_messages
        WHERE instrument_id = $1 AND status = 'buffered'`,
      [INSTRUMENT_ID],
    );
    expect(rows[0]?.n).toBe('0');
  });

  it('does not apply a frame twice when the analyzer retries after a lost ACK', async () => {
    lab.up = true;
    const frame = oru(1);

    const first = await ingress.accept({ ctx, instrument, driver: hl7Driver, raw: frame });
    expect(first.decision.kind).toBe('stored');
    // The analyzer never saw the ACK and sends the identical frame again.
    const second = await ingress.accept({ ctx, instrument, driver: hl7Driver, raw: frame });
    expect(second.decision.kind).toBe('duplicate');

    await drainAll();
    expect(lab.applied).toEqual(['SPEC00001']);
  });
});

describe('exit gate 7 — the unmatched queue', () => {
  it('queues a result for a specimen the laboratory does not know, and keeps the frame', async () => {
    lab.up = true;
    lab.unknown.add('SPEC00007');

    await ingress.accept({ ctx, instrument, driver: hl7Driver, raw: oru(7) });
    const report = await forwarder.drain(ctx, instrument, hl7Driver, { limit: 10 });

    expect(report.applied).toBe(0);
    expect(report.queued).toBe(1);

    const queued = await pg.pool('migrator').query<{ type: string; n: string; sample: string | null }>(
      `SELECT type::text AS type, count(*)::text AS n, max(sample_id_raw) AS sample
         FROM integration.lab_if_error_queue GROUP BY 1`,
    );
    expect(queued.rows).toEqual([{ type: 'unmatched_sample', n: '1', sample: 'SPEC00007' }]);

    // The raw frame is retained: `EN-004 §5` keeps it for 90 days so the
    // interface fault can be read from the bytes, and so the message can be
    // replayed once the sample is accessioned.
    const retained = await pg.pool('migrator').query<{ n: string }>(
      `SELECT count(*)::text AS n FROM integration.lab_if_messages
        WHERE instrument_id = $1 AND raw IS NOT NULL`,
      [INSTRUMENT_ID],
    );
    expect(retained.rows[0]?.n).not.toBe('0');
  });

  it('does not let an unmatched result block the results behind it', async () => {
    lab.up = true;
    lab.unknown.add('SPEC00002');

    for (let i = 1; i <= 4; i += 1) {
      await ingress.accept({ ctx, instrument, driver: hl7Driver, raw: oru(i) });
    }
    await drainAll();

    // An unmatched sample is a durable answer, not a transient one: parking it
    // and continuing is right, whereas stopping would let one mis-labelled tube
    // hold up a whole morning's chemistry.
    expect(lab.applied).toEqual(['SPEC00001', 'SPEC00003', 'SPEC00004']);
  });
});
