import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PERMISSION_CATALOGUE } from '@vims/contracts';
import { startTestPostgres, type TestPostgres } from '@vims/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from './app.module.js';

/**
 * Does the application actually serve the Phase 1 routes?
 *
 * `tsc` proves the module graph type-checks and the unit suites prove each
 * service works in isolation. Neither proves Nest can resolve the graph at
 * runtime or that a single route is mounted — a module that is written, tested
 * and simply never wired compiles perfectly and serves 404 for everything.
 */
let pg: TestPostgres;
let app: NestFastifyApplication;

beforeAll(async () => {
  pg = await startTestPostgres();

  // PermissionRegistryService verifies the catalogue at boot and fails startup
  // on drift, because `hms_app` has no INSERT on core.permissions by design. In
  // production the seed writes these as `hms_migrator`; here the fixture does.
  const owner = pg.pool('migrator');
  for (const perm of PERMISSION_CATALOGUE) {
    await owner.query(
      `INSERT INTO core.permissions (key, module, resource, action, description, data_class, risk, phase,
         sensitive_grant, requires_second_person, requires_reason, requires_step_up, phi_read, clinical_safety_exempt)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (key) DO NOTHING`,
      [
        perm.key,
        perm.module,
        perm.resource,
        perm.action,
        perm.description,
        perm.dataClass,
        perm.risk,
        perm.phase,
        perm.sensitiveGrant ?? false,
        perm.requiresSecondPerson ?? false,
        perm.requiresReason ?? false,
        perm.requiresStepUp ?? false,
        perm.phiRead ?? false,
        perm.clinicalSafetyExempt ?? false,
      ],
    );
  }

  process.env['DATABASE_URL'] = pg.connectionString('app');
  process.env['REDIS_URL'] = 'redis://127.0.0.1:6379';
  process.env['JWT_ACCESS_SECRET'] = 'a'.repeat(48);
  process.env['JWT_REFRESH_SECRET'] = 'b'.repeat(48);
  process.env['NODE_ENV'] = 'test';
  app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    logger: false,
  });
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
}, 600_000);

afterAll(async () => {
  await app?.close();
  await pg?.stop();
});

describe('Phase 1 wiring', () => {
  /**
   * Asserted by calling the routes, not by reading Fastify's route tree: the
   * radix tree splits shared prefixes, so `/appointments` prints as `a` ->
   * `ppointments` and a substring check on it fails while the route is mounted
   * perfectly. A 404 means not mounted; 401/403 means mounted and closed.
   */
  const PHASE_1_ROUTES = [
    ['GET', '/api/v1/patients'],
    ['POST', '/api/v1/patients'],
    ['GET', '/api/v1/patients/dedupe'],
    ['POST', '/api/v1/patients/merge'],
    ['GET', '/api/v1/appointments'],
    ['POST', '/api/v1/appointments'],
    ['GET', '/api/v1/visits'],
    ['POST', '/api/v1/visits'],
    ['GET', '/api/v1/queue/tokens'],
    ['POST', '/api/v1/queue/tokens'],
    ['GET', '/api/v1/cash/shifts'],
    ['POST', '/api/v1/cash/payments'],
    // EN-027 masters. Every picker on every screen reads these; before they
    // existed the screens asked a receptionist to paste a UUID.
    ['GET', '/api/v1/doctors'],
    ['GET', '/api/v1/departments'],
    ['GET', '/api/v1/specialities'],
    ['GET', '/api/v1/consult-types'],
    ['GET', '/api/v1/services'],
    ['GET', '/api/v1/rooms'],
    ['GET', '/api/v1/queues'],
    ['GET', '/api/v1/cash/counters'],
    ['GET', '/api/v1/areas'],
    ['GET', '/api/v1/masters/id_types'],
    // Phase 2 — vitals, encounters, prescribing, CDSS, orders.
    ['POST', '/api/v1/vitals/records'],
    ['GET', '/api/v1/vitals/records'],
    ['POST', '/api/v1/encounters'],
    ['GET', '/api/v1/encounters'],
    ['POST', '/api/v1/prescriptions'],
    // OP-002 §6 defines no list route for prescriptions -- a patient's current
    // medication comes from `GET /patients/:id/medications` on the timeline,
    // which is the list a clinician actually wants. Asserting a bare
    // `GET /prescriptions` here was my error, not a missing route.
    ['GET', '/api/v1/patients/00000000-0000-7000-8000-000000000000/medications'],
    ['GET', '/api/v1/drugs/search'],
    ['POST', '/api/v1/cdss/evaluate'],
    ['GET', '/api/v1/cdss/alerts'],
    ['POST', '/api/v1/orders'],
    ['GET', '/api/v1/orders'],
  ] as const;

  it('mounts every Phase 1 route', async () => {
    const missing: string[] = [];
    for (const [method, url] of PHASE_1_ROUTES) {
      const res = await app.inject({ method, url });
      if (res.statusCode === 404) missing.push(`${method} ${url}`);
    }
    expect(missing, 'routes that are written but not mounted').toEqual([]);
  });

  /**
   * The guards are global and ordered, so an anonymous request must be refused
   * before it reaches a handler. A 200 here would mean a Phase 1 route escaped
   * the guard chain -- patient data served to anyone who asks.
   */
  it('closes every Phase 1 route to anonymous callers', async () => {
    const open: string[] = [];
    for (const [method, url] of PHASE_1_ROUTES) {
      const res = await app.inject({ method, url });
      if (res.statusCode !== 401 && res.statusCode !== 403) {
        open.push(`${method} ${url} -> ${String(res.statusCode)}`);
      }
    }
    expect(open, 'Phase 1 routes reachable without authentication').toEqual([]);
  });
});
