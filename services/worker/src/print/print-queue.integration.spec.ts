import { newId } from '@vims/contracts';
import { sampleContext } from '@vims/print-templates';
import {
  createTenantFixture,
  startTestPostgres,
  startTestRedis,
  type TenantFixture,
  type TestPostgres,
  type TestRedis,
} from '@vims/testing';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { EscPosEmulator } from './escpos-emulator.js';
import type { PdfRenderRequest, PdfRendererPort } from './pdf-renderer.js';
import { MapTransportResolver, StaticPayloadSource } from './print-dispatcher.js';
import { createPrintJob, findPrintJob, type PrintJobRecord } from './print-job-repository.js';
import {
  createPrintQueue,
  createPrintWorker,
  enqueuePrintJob,
  maxAttemptsFor,
  processPrintJob,
  type PrintProcessorDeps,
  type PrintRetryPolicy,
} from './print-queue.js';
import { listAlternativePrinters, resolvePrinter, withPrintScope } from './printer-registry.js';
import type { PrintArtifact } from './types.js';

/**
 * The print queue against a real PostgreSQL with RLS switched on.
 *
 * Everything here runs as **`hms_app`** — the role that is `NOBYPASSRLS` and
 * owns nothing — with the tenancy GUCs stamped by `withPrintScope()`. That is
 * the point: a resolution test run as the schema owner proves the SQL is
 * syntactically valid and nothing about whether one hospital can reach another's
 * printers. Fixtures are inserted as `hms_migrator`, which is the only role
 * allowed to write into two tenants at once.
 */

let pg: TestPostgres;
let redis: TestRedis;
let tenants: TenantFixture;
let appPool: Pool;

const TOKEN_PAYLOAD = {
  tokenNumber: 'C-45',
  counterName: 'Counter 3',
  departmentName: 'Orthopaedics OPD',
  queueAhead: 4,
  issuedAtLabel: '20-08-2026 09:14',
  qrData: 'https://hms.example.invalid/t/C-45',
};

/** No browser in this suite — the PDF path has its own gate-6 spec. */
class UnusedPdfRenderer implements PdfRendererPort {
  renderHtml(_request: PdfRenderRequest): Promise<PrintArtifact> {
    return Promise.reject(new Error('this suite prints ESC/POS only'));
  }
}

interface Fixtures {
  readonly agentId: string;
  readonly counterPrinterId: string;
  readonly backupPrinterId: string;
}

let fixtures: Fixtures;

async function insertPrintFixtures(): Promise<Fixtures> {
  const pool = pg.pool('migrator');
  const agentId = newId();
  const counterPrinterId = newId();
  const backupPrinterId = newId();

  await pool.query(
    `INSERT INTO core.print_agents (id, hospital_id, branch_id, name, host, status, last_heartbeat_at, updated_at)
     VALUES ($1, $2, $3, 'Counter PC 3', 'ws-c3.hospital.local', 'online', now(), now())`,
    [agentId, tenants.hospitalA, tenants.branchA],
  );

  await pool.query(
    `INSERT INTO core.print_printers
       (id, hospital_id, branch_id, agent_id, name, kind, connection, driver_mode, paper, status, updated_at)
     VALUES
       ($1, $4, $5, $3, 'OPD Counter 3 thermal', 'thermal', 'agent_os_printer', 'raw_escpos', 'thermal_80mm', 'online', now()),
       ($2, $4, $5, $3, 'Front Office backup thermal', 'thermal', 'agent_os_printer', 'raw_escpos', 'thermal_80mm', 'online', now())`,
    [counterPrinterId, backupPrinterId, agentId, tenants.hospitalA, tenants.branchA],
  );

  await pool.query(
    `INSERT INTO core.print_mappings
       (id, hospital_id, branch_id, doc_type, scope_type, scope_id, printer_id, template_key, copies, priority, updated_at)
     VALUES
       ($1, $3, $4, 'token', 'branch', $4, $5, 'token.escpos.v1', 1, 100, now()),
       ($2, $3, $4, 'token', 'branch', NULL, $6, 'token.escpos.v1', 1, 200, now())`,
    [newId(), newId(), tenants.hospitalA, tenants.branchA, counterPrinterId, backupPrinterId],
  );

  return { agentId, counterPrinterId, backupPrinterId };
}

async function setPrinterStatus(printerId: string, status: string): Promise<void> {
  await pg
    .pool('migrator')
    .query(
      `UPDATE core.print_printers SET status = $2, last_status_at = now(), updated_at = now() WHERE id = $1`,
      [printerId, status],
    );
}

async function newTokenJob(
  overrides: { readonly createdAtShiftHours?: number } = {},
): Promise<PrintJobRecord> {
  if (overrides.createdAtShiftHours !== undefined) {
    // Back-dated rows are inserted as `hms_migrator`, not by writing then
    // moving one: `created_at` is half of the partitioned primary key, and
    // `hms_app` has DELETE revoked on `core.print_jobs` on purpose — a print
    // job is a record of something that happened (`..._platform_modules` §2).
    const id = newId();
    const { rows } = await pg.pool('migrator').query<{ created_at_text: string }>(
      `INSERT INTO core.print_jobs
         (id, hospital_id, branch_id, doc_type, template_key, source_module, format, copies, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'token', 'token.escpos.v1', 'EN-006', 'escpos', 1, 'queued',
               now() - make_interval(hours => $4::int), now())
       RETURNING created_at::text AS created_at_text`,
      [id, tenants.hospitalA, tenants.branchA, overrides.createdAtShiftHours],
    );
    const createdAtText = rows[0]?.created_at_text ?? '';
    const stored = await withPrintScope(
      appPool,
      { hospitalId: tenants.hospitalA, branchIds: [tenants.branchA] },
      (client) => findPrintJob(client, id, createdAtText),
    );
    if (stored === null) throw new Error('back-dated print job was not visible to hms_app under RLS');
    return stored;
  }

  return withPrintScope(appPool, { hospitalId: tenants.hospitalA, branchIds: [tenants.branchA] }, (client) =>
    createPrintJob(client, {
      hospitalId: tenants.hospitalA,
      branchId: tenants.branchA,
      docType: 'token',
      format: 'escpos',
      templateKey: 'token.escpos.v1',
      sourceModule: 'EN-006',
      phi: false,
    }),
  );
}

function depsFor(emulator: EscPosEmulator, job: PrintJobRecord): PrintProcessorDeps {
  const payloads = new StaticPayloadSource().set(job.id, {
    payload: TOKEN_PAYLOAD,
    context: sampleContext(),
  });
  return {
    pool: appPool,
    pdf: new UnusedPdfRenderer(),
    payloads,
    transports: new MapTransportResolver(emulator),
  };
}

function refFor(job: PrintJobRecord): {
  jobId: string;
  createdAt: string;
  hospitalId: string;
  branchId: string;
} {
  return {
    jobId: job.id,
    createdAt: job.createdAtText,
    hospitalId: job.hospitalId,
    branchId: job.branchId,
  };
}

async function reload(job: PrintJobRecord): Promise<PrintJobRecord | null> {
  return withPrintScope(appPool, { hospitalId: job.hospitalId, branchIds: [job.branchId] }, (client) =>
    findPrintJob(client, job.id, job.createdAtText),
  );
}

async function outboxTypesFor(jobId: string): Promise<readonly string[]> {
  const { rows } = await pg
    .pool('migrator')
    .query<{ event_type: string }>(
      `SELECT event_type FROM core.outbox_events WHERE aggregate_id = $1 ORDER BY occurred_at`,
      [jobId],
    );
  return rows.map((row) => row.event_type);
}

beforeAll(async () => {
  pg = await startTestPostgres();
  redis = await startTestRedis();
  tenants = await createTenantFixture(pg);
  appPool = pg.pool('app');
  fixtures = await insertPrintFixtures();
}, 300_000);

afterAll(async () => {
  await redis?.stop();
  await pg?.stop();
});

/** Poll rather than sleep: the queue decides when, and a fixed sleep is a flake. */
async function waitFor(condition: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('condition not met within ' + String(timeoutMs) + ' ms');
}

beforeEach(async () => {
  await setPrinterStatus(fixtures.counterPrinterId, 'online');
  await setPrinterStatus(fixtures.backupPrinterId, 'online');
});

describe('printer registry resolution under RLS', () => {
  it('resolves the branch mapping to a physical printer and its agent', async () => {
    const resolution = await withPrintScope(
      appPool,
      { hospitalId: tenants.hospitalA, branchIds: [tenants.branchA] },
      (client) =>
        resolvePrinter(client, {
          hospitalId: tenants.hospitalA,
          branchId: tenants.branchA,
          docType: 'token',
        }),
    );

    expect(resolution?.printer.printerId).toBe(fixtures.counterPrinterId);
    expect(resolution?.printer.agentId).toBe(fixtures.agentId);
    expect(resolution?.printer.driverMode).toBe('raw_escpos');
    expect(resolution?.templateKey).toBe('token.escpos.v1');
  });

  /**
   * The isolation case. Hospital B is populated with the same shape of data and
   * asks for the same document type; the mapping it must not see belongs to A.
   */
  it('cannot resolve another tenant’s printer', async () => {
    const resolution = await withPrintScope(
      appPool,
      { hospitalId: tenants.hospitalB, branchIds: [tenants.branchB] },
      (client) =>
        resolvePrinter(client, {
          hospitalId: tenants.hospitalA,
          branchId: tenants.branchA,
          docType: 'token',
        }),
    );
    expect(resolution).toBeNull();
  });

  it('offers only ready printers as alternatives', async () => {
    await setPrinterStatus(fixtures.backupPrinterId, 'offline');
    const alternatives = await withPrintScope(
      appPool,
      { hospitalId: tenants.hospitalA, branchIds: [tenants.branchA] },
      (client) =>
        listAlternativePrinters(client, {
          hospitalId: tenants.hospitalA,
          branchId: tenants.branchA,
          docType: 'token',
        }),
    );
    expect(alternatives.map((printer) => printer.printerId)).toEqual([fixtures.counterPrinterId]);
  });
});

describe('print job processing', () => {
  it('renders, prints and completes a token job, emitting the outbox event', async () => {
    const job = await newTokenJob();
    const emulator = new EscPosEmulator();

    const outcome = await processPrintJob(depsFor(emulator, job), refFor(job));

    expect(outcome.state).toBe('printed');
    expect(emulator.lastSlip?.text).toContain('C-45');
    expect(emulator.lastSlip?.hasControl('CUT_PARTIAL')).toBe(true);

    const stored = await reload(job);
    expect(stored?.status).toBe('completed');
    expect(stored?.attempts).toBe(1);
    expect(stored?.printerId).toBe(fixtures.counterPrinterId);
    expect(stored?.agentId).toBe(fixtures.agentId);
    expect(stored?.error).toBeNull();

    expect(await outboxTypesFor(job.id)).toContain('print.job.completed');
  });

  /** The outbox is at-least-once, so re-delivery must not print a second slip. */
  it('is idempotent: a re-delivered job does not print again', async () => {
    const job = await newTokenJob();
    const emulator = new EscPosEmulator();
    const deps = depsFor(emulator, job);

    await processPrintJob(deps, refFor(job));
    const second = await processPrintJob(deps, refFor(job));

    expect(second).toEqual({ state: 'already_final', jobId: job.id, status: 'completed' });
    expect(emulator.slips).toHaveLength(1);
  });

  /**
   * `docs/01 §7`: "Printer offline → job stays in the print queue with retry +
   * 'print elsewhere' option." Both halves are asserted: the row is still
   * `queued`, and a usable alternative is offered.
   */
  it('keeps the job queued and offers another printer when the device is out of paper', async () => {
    await setPrinterStatus(fixtures.counterPrinterId, 'paper_out');
    const job = await newTokenJob();
    const emulator = new EscPosEmulator();

    const outcome = await processPrintJob(depsFor(emulator, job), refFor(job));

    expect(outcome.state).toBe('deferred');
    if (outcome.state !== 'deferred') throw new Error('unreachable');
    expect(outcome.reason).toBe('paper_out');
    expect(outcome.attempts).toBe(1);
    expect(outcome.retryInMs).toBe(30_000);
    expect(outcome.alternatives.map((printer) => printer.printerId)).toEqual([fixtures.backupPrinterId]);

    const stored = await reload(job);
    expect(stored?.status).toBe('queued');
    expect(stored?.attempts).toBe(1);
    expect(stored?.error).toContain('paper_out');
    expect(emulator.slips).toHaveLength(0);
    expect(await outboxTypesFor(job.id)).not.toContain('print.job.failed');
  });

  it('detects a device fault raised by the transport itself, not only by the registry', async () => {
    const job = await newTokenJob();
    const emulator = new EscPosEmulator({ fault: 'paper_out' });

    const outcome = await processPrintJob(depsFor(emulator, job), refFor(job));

    expect(outcome.state).toBe('deferred');
    expect((await reload(job))?.status).toBe('queued');
  });

  /** `EN-005 §3.3.2`: after 10 minutes of retrying, fail and alert IT. */
  it('fails the job once the retry window is exhausted', async () => {
    await setPrinterStatus(fixtures.counterPrinterId, 'offline');
    const job = await newTokenJob();
    await pg
      .pool('migrator')
      .query(`UPDATE core.print_jobs SET attempts = $2 WHERE id = $1`, [job.id, maxAttemptsFor() - 1]);

    const outcome = await processPrintJob(depsFor(new EscPosEmulator(), job), refFor(job));

    expect(outcome).toMatchObject({ state: 'failed', permanent: false });
    const stored = await reload(job);
    expect(stored?.status).toBe('failed');
    expect(stored?.attempts).toBe(maxAttemptsFor());
    expect(await outboxTypesFor(job.id)).toContain('print.job.failed');
  });

  /** `EN-005 §5`: yesterday's token must never print itself today. */
  it('auto-cancels a job that has been queued for more than 24 h', async () => {
    const job = await newTokenJob({ createdAtShiftHours: 30 });

    const outcome = await processPrintJob(depsFor(new EscPosEmulator(), job), refFor(job));

    expect(outcome.state).toBe('cancelled');
    expect((await reload(job))?.status).toBe('cancelled');
    expect(await outboxTypesFor(job.id)).toContain('print.job.cancelled');
  });

  /** `EN-005 §3.3.3`: no agent covers this workstation → the browser prints it. */
  it('falls back to browser printing when nothing is mapped for the document type', async () => {
    const job = await withPrintScope(
      appPool,
      { hospitalId: tenants.hospitalA, branchIds: [tenants.branchA] },
      (client) =>
        createPrintJob(client, {
          hospitalId: tenants.hospitalA,
          branchId: tenants.branchA,
          docType: 'visitor_pass',
          format: 'escpos',
          sourceModule: 'NC-021',
        }),
    );

    const outcome = await processPrintJob(depsFor(new EscPosEmulator(), job), refFor(job));

    expect(outcome.state).toBe('fallback_browser');
    expect((await reload(job))?.status).toBe('fallback_browser');
  });

  /** `EN-005 §3.3.2`: "permanent errors immediate fail" — no retry storm. */
  it('fails immediately when the template rejects the payload', async () => {
    const job = await newTokenJob();
    const deps: PrintProcessorDeps = {
      ...depsFor(new EscPosEmulator(), job),
      payloads: new StaticPayloadSource().set(job.id, {
        payload: { tokenNumber: '' },
        context: sampleContext(),
      }),
    };

    const outcome = await processPrintJob(deps, refFor(job));

    expect(outcome).toMatchObject({ state: 'failed', permanent: true });
    const stored = await reload(job);
    expect(stored?.status).toBe('failed');
    expect(stored?.error).toContain('token.escpos.v1');
    expect(await outboxTypesFor(job.id)).toContain('print.job.failed');
  });

  it('reports a job that does not exist rather than inventing one', async () => {
    const outcome = await processPrintJob(depsFor(new EscPosEmulator(), await newTokenJob()), {
      jobId: newId(),
      createdAt: new Date().toISOString(),
      hospitalId: tenants.hospitalA,
      branchId: tenants.branchA,
    });
    expect(outcome.state).toBe('missing');
  });
});

describe('BullMQ wiring', () => {
  /**
   * The queue half of `docs/01 §7`. The database says `queued` after a
   * paper-out, but only the Redis job makes it come back — a processor that
   * returned normally would leave the row correct and the job forgotten. Here
   * the printer is out of paper, the job retries, paper is loaded, and the slip
   * prints without anyone re-submitting anything.
   */
  it('retries a deferred job on the queue and prints it once the printer recovers', async () => {
    await setPrinterStatus(fixtures.counterPrinterId, 'paper_out');

    const job = await newTokenJob();
    const emulator = new EscPosEmulator();
    // A 250 ms interval instead of 30 s: the policy is asserted arithmetically
    // in the unit tests; what is being proved here is the wiring.
    const retry: PrintRetryPolicy = { intervalMs: 250, windowMs: 5_000 };
    const connection = { host: redis.host, port: redis.port, maxRetriesPerRequest: null };

    const queue = createPrintQueue(connection);
    const worker = createPrintWorker(connection, { ...depsFor(emulator, job), retry }, 1);

    try {
      await enqueuePrintJob(queue, refFor(job), retry);

      await waitFor(async () => ((await reload(job))?.attempts ?? 0) >= 1);
      expect((await reload(job))?.status).toBe('queued');
      expect(emulator.slips).toHaveLength(0);

      await setPrinterStatus(fixtures.counterPrinterId, 'online');

      await waitFor(async () => (await reload(job))?.status === 'completed');
      expect(emulator.slips).toHaveLength(1);
      expect(emulator.lastSlip?.text).toContain('C-45');
      expect(await outboxTypesFor(job.id)).toContain('print.job.completed');
    } finally {
      await worker.close();
      await queue.close();
    }
  }, 60_000);
});
