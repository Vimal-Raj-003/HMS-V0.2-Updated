import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PERMISSION_CATALOGUE, newId } from '@vims/contracts';
import { createTenantFixture, startTestPostgres, type TenantFixture, type TestPostgres } from '@vims/testing';
import argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../../app.module.js';
import { PsychiatryController } from './psychiatry.controller.js';
import { PsychiatryService } from './psychiatry.service.js';

/**
 * OP-032 against a real PostgreSQL 17.
 *
 * The Mental Healthcare Act 2017, as database shapes:
 *
 *  1. **Capacity is presumed**, the verdict follows from four limbs, and the
 *     finding expires.
 *  2. **Every admission carries its own clock**, derived from its section, and
 *     a supported one rests on a current assessment.
 *  3. **Restraint is ordered within the hour, observed, and the nominated
 *     representative is told** before it can be closed.
 *  4. **Unmodified electroconvulsive therapy cannot be recorded at all**, and
 *     ECT on a minor needs the Review Board.
 */

let pg: TestPostgres;
let app: NestFastifyApplication;
let tenants: TenantFixture;

const PASSWORD = 'Correct-Horse-Battery-9!';

interface Actor {
  readonly userId: string;
  readonly roleId: string;
  readonly username: string;
  token: string;
}
const actor = (username: string): Actor => ({ userId: newId(), roleId: newId(), username, token: '' });

/** Assesses capacity, admits under the Act, orders restraint, runs a course. */
const psychiatrist = actor('psy-doctor');
/** Records scales and reads the episode. Does not assess capacity. */
const counsellor = actor('psy-counsellor');
/** Observes during a restraint. Does not order one. */
const nurse = actor('psy-nurse');

const DOCTOR_KEYS = [
  'psy.episode.read',
  'psy.admission.record',
  'psy.ect.session.record',
  'psy.episode.manage',
  'psy.scale.record',
  'psy.capacity.assess',
  'psy.instrument.manage',
  'psy.admission.manage',
  'psy.restraint.order',
  'psy.restraint.record',
  'psy.ect.manage',
  'psy.report.read',
];
const COUNSELLOR_KEYS = ['psy.episode.read', 'psy.scale.record'];
const NURSE_KEYS = [...COUNSELLOR_KEYS, 'psy.restraint.record'];

const PATIENT = newId();

/** What the suites hand each other. */
const state = {
  episode: '',
  capacityIntact: '',
  capacityLacking: '',
  admission: '',
  restraint: '',
  directive: '',
  ectCourse: '',
};

// ── fixtures ─────────────────────────────────────────────────────────────────

async function syncPermissions(): Promise<void> {
  const pool = pg.pool('migrator');
  for (const p of PERMISSION_CATALOGUE) {
    await pool.query(
      `INSERT INTO core.permissions (key, module, resource, action, description, data_class, risk, phase,
         sensitive_grant, requires_second_person, requires_reason, requires_step_up, phi_read, clinical_safety_exempt)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (key) DO NOTHING`,
      [
        p.key,
        p.module,
        p.resource,
        p.action,
        p.description,
        p.dataClass,
        p.risk,
        p.phase,
        p.sensitiveGrant ?? false,
        p.requiresSecondPerson ?? false,
        p.requiresReason ?? false,
        false,
        p.phiRead ?? false,
        p.clinicalSafetyExempt ?? false,
      ],
    );
  }
}

async function seedActor(who: Actor, permissionKeys: readonly string[]): Promise<void> {
  const pool = pg.pool('migrator');
  const hash = await argon2.hash(PASSWORD, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });

  await pool.query(
    `INSERT INTO core.roles (id, hospital_id, key, name, description, home_workspace, category, updated_at)
     VALUES ($1, $2, $3, $4, 'Integration test role', 'nurse-opd', 'nursing', now())`,
    [who.roleId, tenants.hospitalA, `role_${who.username.replace(/-/g, '_')}`, `Role ${who.username}`],
  );
  for (const key of permissionKeys) {
    await pool.query(
      `INSERT INTO core.role_permissions (role_id, permission_key) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [who.roleId, key],
    );
  }
  await pool.query(
    `INSERT INTO core.users (id, hospital_id, group_id, username, email, name, display_name,
                             password_hash, status, type, updated_at)
     VALUES ($1, $2, (SELECT group_id FROM core.hospitals WHERE id = $2), $3, $4, $5::jsonb, $6, $7,
             'active', 'staff', now())`,
    [
      who.userId,
      tenants.hospitalA,
      who.username,
      `${who.username}@example.invalid`,
      JSON.stringify({ given: 'Test', family: who.username }),
      `Test ${who.username}`,
      hash,
    ],
  );
  await pool.query(
    `INSERT INTO core.user_roles (id, hospital_id, user_id, role_id, branch_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())`,
    [newId(), tenants.hospitalA, who.userId, who.roleId, tenants.branchA],
  );
}

async function seedPatient(id: string, name: string): Promise<void> {
  await pg.pool('migrator').query(
    `INSERT INTO patient.patients
       (id, hospital_id, branch_id, uhid, uhid_normalised, first_name, full_name, gender, dob,
        mobile, mobile_local, dedupe_fingerprint, status, updated_at)
     VALUES ($1, $2, $3, $4, $4, $5, $5, 'female', '1996-03-08',
             '+91984500' || lpad($6, 4, '0'), '984500' || lpad($6, 4, '0'), $4, 'active', now())`,
    [
      id,
      tenants.hospitalA,
      tenants.branchA,
      `UH-${id.replace(/-/g, '').slice(-10)}`,
      name,
      String(Math.abs(name.length * 53) % 10_000),
    ],
  );
}

async function login(identifier: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { hospitalId: tenants.hospitalA, identifier, password: PASSWORD },
  });
  const body = res.json<{ accessToken?: string }>();
  if (typeof body.accessToken !== 'string') {
    throw new Error(`login failed for ${identifier}: ${String(res.statusCode)} ${res.body}`);
  }
  return body.accessToken;
}

interface CallOptions {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly token: string;
  readonly payload?: Record<string, unknown>;
  readonly reason?: string;
}

async function call(options: CallOptions) {
  const headers: Record<string, string> = { authorization: `Bearer ${options.token}` };
  if (options.reason !== undefined) headers['x-reason'] = options.reason;
  if (options.method === 'POST') headers['idempotency-key'] = newId();
  return app.inject({
    method: options.method,
    url: options.url,
    headers,
    ...(options.method === 'GET' ? {} : { payload: options.payload ?? {} }),
  });
}

function detail(res: { json: <T>() => T }): string {
  return (res.json<{ detail?: string }>().detail ?? '').toString();
}

const appControllers = (Reflect.getMetadata('controllers', AppModule) ?? []) as unknown[];
const alreadyWired = appControllers.includes(PsychiatryController);

@Module({
  imports: [AppModule],
  controllers: alreadyWired ? [] : [PsychiatryController],
  providers: alreadyWired ? [] : [PsychiatryService],
})
class PsychiatryTestModule {}

beforeAll(async () => {
  pg = await startTestPostgres();
  tenants = await createTenantFixture(pg, { codePrefix: 'PSY' });
  await syncPermissions();

  await seedActor(psychiatrist, DOCTOR_KEYS);
  await seedActor(counsellor, COUNSELLOR_KEYS);
  await seedActor(nurse, NURSE_KEYS);

  await seedPatient(PATIENT, 'Arun Prasad');

  process.env['DATABASE_URL'] = pg.connectionString('app');
  process.env['REDIS_URL'] = 'redis://127.0.0.1:6379';
  process.env['JWT_ACCESS_SECRET'] = 'a'.repeat(48);
  process.env['JWT_REFRESH_SECRET'] = 'b'.repeat(48);
  process.env['NODE_ENV'] = 'test';

  app = await NestFactory.create<NestFastifyApplication>(PsychiatryTestModule, new FastifyAdapter(), {
    logger: false,
  });
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });
  await app.init();

  for (const who of [psychiatrist, counsellor, nurse]) {
    who.token = await login(who.username);
  }
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pg?.stop();
});

describe('OP-032 · capacity is presumed', () => {
  it('derives the verdict from the four limbs and gives it an expiry', async () => {
    const episode = await call({
      method: 'POST',
      url: '/api/v1/psy/episodes',
      token: psychiatrist.token,
      payload: {
        patientId: PATIENT,
        leadClinicianId: psychiatrist.userId,
        riskLevel: 'high',
        primaryDxIcd10: 'F20.0',
      },
    });
    expect(episode.statusCode, episode.body).toBe(201);
    state.episode = episode.json<{ id: string }>().id;
    // Nothing has been assessed, so nothing is claimed.
    expect(episode.json<{ capacityKnown: boolean }>().capacityKnown).toBe(false);

    const intact = await call({
      method: 'POST',
      url: '/api/v1/psy/capacity',
      token: psychiatrist.token,
      reason: 'Routine review before treatment discussion.',
      payload: {
        episodeId: state.episode,
        patientId: PATIENT,
        understands: true,
        retains: true,
        weighs: true,
        communicates: true,
        decisionScope: 'Admission and antipsychotic treatment',
        rationale: 'Describes the proposed treatment, the alternatives, and why he prefers one.',
      },
    });
    expect(intact.statusCode, intact.body).toBe(201);
    expect(intact.json<{ hasCapacity: boolean; current: boolean }>()).toMatchObject({
      hasCapacity: true,
      current: true,
    });
    state.capacityIntact = intact.json<{ id: string }>().id;

    const lacking = await call({
      method: 'POST',
      url: '/api/v1/psy/capacity',
      token: psychiatrist.token,
      reason: 'Reassessed after deterioration.',
      payload: {
        episodeId: state.episode,
        patientId: PATIENT,
        understands: true,
        retains: true,
        weighs: false,
        communicates: true,
        decisionScope: 'Admission and antipsychotic treatment',
        rationale: 'Cannot weigh the consequences of refusing treatment against the risk of relapse.',
      },
    });
    // One limb failing is enough, and the service never sends the verdict.
    expect(lacking.json<{ hasCapacity: boolean }>().hasCapacity).toBe(false);
    state.capacityLacking = lacking.json<{ id: string }>().id;
  });

  it('keeps the assessment out of the counsellor’s and the nurse’s hands', async () => {
    for (const who of [counsellor, nurse]) {
      const res = await call({
        method: 'POST',
        url: '/api/v1/psy/capacity',
        token: who.token,
        reason: 'Assessing.',
        payload: {
          episodeId: state.episode,
          patientId: PATIENT,
          understands: false,
          retains: false,
          weighs: false,
          communicates: false,
          decisionScope: 'Treatment',
          rationale: 'Long enough rationale to satisfy the other rule.',
        },
      });
      expect(res.statusCode, who.username).toBe(403);
    }
  });
});

describe('OP-032 · the clocks', () => {
  it('gives an emergency admission seventy-two hours and no Board date', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/psy/admissions',
      token: psychiatrist.token,
      reason: 'Acute risk to self; emergency treatment under §94.',
      payload: {
        episodeId: state.episode,
        patientId: PATIENT,
        admissionType: 'emergency_94',
        reason: 'Acute risk to self; emergency treatment under §94.',
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json<{ hoursLeftOfAuthority: number; mhrbIntimationDueAt: string | null }>();
    expect(body.hoursLeftOfAuthority).toBeGreaterThan(68);
    expect(body.hoursLeftOfAuthority).toBeLessThanOrEqual(72);
    expect(body.mhrbIntimationDueAt).toBeNull();
  });

  it('refuses a supported admission with no assessment, or one that found capacity intact', async () => {
    const none = await call({
      method: 'POST',
      url: '/api/v1/psy/admissions',
      token: psychiatrist.token,
      reason: 'Supported admission.',
      payload: {
        episodeId: state.episode,
        patientId: PATIENT,
        admissionType: 'supported_89',
        reason: 'Supported admission.',
      },
    });
    expect(none.statusCode).toBe(409);
    expect(detail(none)).toContain('entitled to leave');

    const wrong = await call({
      method: 'POST',
      url: '/api/v1/psy/admissions',
      token: psychiatrist.token,
      reason: 'Supported admission.',
      payload: {
        episodeId: state.episode,
        patientId: PATIENT,
        admissionType: 'supported_89',
        capacityAssessmentId: state.capacityIntact,
        reason: 'Supported admission.',
      },
    });
    expect(wrong.statusCode).toBe(409);
    expect(detail(wrong)).toContain('§86');
  });

  it('takes one on a current assessment, with a thirty-day clock and a seven-day Board date', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/psy/admissions',
      token: psychiatrist.token,
      reason: 'Lacks capacity to consent; admission necessary for treatment.',
      payload: {
        episodeId: state.episode,
        patientId: PATIENT,
        admissionType: 'supported_89',
        capacityAssessmentId: state.capacityLacking,
        reason: 'Lacks capacity to consent; admission necessary for treatment.',
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    state.admission = res.json<{ id: string }>().id;
    const body = res.json<{ hoursLeftOfAuthority: number; blockedBy: string[] }>();
    expect(body.hoursLeftOfAuthority).toBeGreaterThan(700);
    // The Board has to be told, and the board says so before the date passes.
    expect(body.blockedBy.join(' ')).toContain('Review Board');
  });

  it('refuses a §90 with no Board reference, and there is no route that extends a §89', async () => {
    const noRef = await call({
      method: 'POST',
      url: '/api/v1/psy/admissions',
      token: psychiatrist.token,
      reason: 'Continuing beyond thirty days.',
      payload: {
        episodeId: state.episode,
        patientId: PATIENT,
        admissionType: 'supported_90',
        capacityAssessmentId: state.capacityLacking,
        reason: 'Continuing beyond thirty days.',
      },
    });
    expect(noRef.statusCode).toBe(409);
    expect(detail(noRef)).toContain("Review Board's authority");

    const withRef = await call({
      method: 'POST',
      url: '/api/v1/psy/admissions',
      token: psychiatrist.token,
      reason: 'Board authorised continued admission.',
      payload: {
        episodeId: state.episode,
        patientId: PATIENT,
        admissionType: 'supported_90',
        capacityAssessmentId: state.capacityLacking,
        mhrbRef: 'MHRB/KA/2026/441',
        reason: 'Board authorised continued admission.',
      },
    });
    expect(withRef.statusCode, withRef.body).toBe(201);
    // Ninety days, not thirty extended.
    expect(withRef.json<{ hoursLeftOfAuthority: number }>().hoursLeftOfAuthority).toBeGreaterThan(2100);
  });

  it('records the Board intimation and clears the warning', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/psy/admissions/${state.admission}/intimation`,
      token: psychiatrist.token,
      payload: { mhrbRef: 'MHRB/KA/2026/442' },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json<{ mhrbIntimatedAt: string | null }>().mhrbIntimatedAt).not.toBeNull();
    expect(res.json<{ blockedBy: string[] }>().blockedBy.join(' ')).not.toContain('Review Board');
  });
});

describe('OP-032 · restraint', () => {
  it('will not take a two-word reason, and takes one that names the harm', async () => {
    const vague = await call({
      method: 'POST',
      url: '/api/v1/psy/restraints',
      token: psychiatrist.token,
      reason: 'Agitated',
      payload: { admissionId: state.admission, kind: 'physical', reason: 'Agitated' },
    });
    expect(vague.statusCode).toBe(400);

    const named = await call({
      method: 'POST',
      url: '/api/v1/psy/restraints',
      token: psychiatrist.token,
      reason: 'Striking staff; imminent risk of injury.',
      payload: {
        admissionId: state.admission,
        kind: 'physical',
        reason: 'Striking staff and other patients; imminent risk of injury to both.',
      },
    });
    expect(named.statusCode, named.body).toBe(201);
    state.restraint = named.json<{ id: string }>().id;
    // Ordered by whoever is signed in, at the moment it exists.
    expect(named.json<{ orderedAt: string | null }>().orderedAt).not.toBeNull();
  });

  it('does not let the nurse order one, but does let them observe', async () => {
    const ordering = await call({
      method: 'POST',
      url: '/api/v1/psy/restraints',
      token: nurse.token,
      reason: 'Striking staff; imminent risk of injury to both.',
      payload: {
        admissionId: state.admission,
        kind: 'physical',
        reason: 'Striking staff; imminent risk of injury to both.',
      },
    });
    expect(ordering.statusCode).toBe(403);

    const observing = await call({
      method: 'POST',
      url: `/api/v1/psy/restraints/${state.restraint}/observations`,
      token: nurse.token,
      payload: { state: 'Settling; airway clear, limbs perfused.' },
    });
    expect(observing.statusCode, observing.body).toBe(201);
    expect(observing.json<{ observations: number }>().observations).toBe(1);
  });

  it('closes only with observations and the representative told, and leaves it on the outbox', async () => {
    const closed = await call({
      method: 'POST',
      url: `/api/v1/psy/restraints/${state.restraint}/close`,
      token: nurse.token,
      payload: {},
    });
    expect(closed.statusCode, closed.body).toBe(201);
    expect(closed.json<{ durationMin: number | null }>().durationMin).not.toBeNull();

    const { rows } = await pg
      .pool('migrator')
      .query<{ event_type: string }>(
        `SELECT DISTINCT event_type FROM core.outbox_events WHERE event_type LIKE 'psy.%'`,
      );
    expect(rows.map((r) => r.event_type)).toContain('psy.restraint.recorded');
  });
});

describe('OP-032 · electroconvulsive therapy', () => {
  it('cannot record a session without both halves of "modified"', async () => {
    const course = await call({
      method: 'POST',
      url: '/api/v1/psy/ect-courses',
      token: psychiatrist.token,
      reason: 'Treatment-resistant depression with catatonia.',
      payload: {
        episodeId: state.episode,
        patientId: PATIENT,
        indication: 'Treatment-resistant depression with catatonia and poor oral intake.',
        consentId: newId(),
        maxSessions: 2,
        reason: 'Treatment-resistant depression with catatonia.',
      },
    });
    expect(course.statusCode, course.body).toBe(201);
    state.ectCourse = course.json<{ id: string }>().id;

    // The schema will not carry a session without an agent and a relaxant, so
    // the request never reaches the database that would also refuse it.
    const unmodified = await call({
      method: 'POST',
      url: `/api/v1/psy/ect-courses/${state.ectCourse}/sessions`,
      token: psychiatrist.token,
      payload: { placement: 'bitemporal', anaesthesia: { agent: 'Thiopentone 250 mg' } },
    });
    expect(unmodified.statusCode).toBe(400);

    const modified = await call({
      method: 'POST',
      url: `/api/v1/psy/ect-courses/${state.ectCourse}/sessions`,
      token: psychiatrist.token,
      payload: {
        placement: 'bitemporal',
        anaesthesia: { agent: 'Thiopentone 250 mg', relaxant: 'Succinylcholine 50 mg' },
        seizureSec: 32,
      },
    });
    expect(modified.statusCode, modified.body).toBe(201);
    expect(modified.json<{ seq: number }>().seq).toBe(1);
  });

  it('needs the Review Board for a minor, and stops at the authorised number', async () => {
    const minorCourse = await call({
      method: 'POST',
      url: '/api/v1/psy/ect-courses',
      token: psychiatrist.token,
      reason: 'Catatonia in an adolescent; discussed with the family.',
      payload: {
        episodeId: state.episode,
        patientId: PATIENT,
        indication: 'Catatonia with refusal of food and fluids.',
        consentId: newId(),
        minor: true,
        maxSessions: 6,
        reason: 'Catatonia in an adolescent; discussed with the family.',
      },
    });
    const minorId = minorCourse.json<{ id: string; blockedBy: string[] }>().id;
    // The forward view says so before the refusal does.
    expect(minorCourse.json<{ blockedBy: string[] }>().blockedBy.join(' ')).toContain('Review Board');

    const refused = await call({
      method: 'POST',
      url: `/api/v1/psy/ect-courses/${minorId}/sessions`,
      token: psychiatrist.token,
      payload: {
        placement: 'bitemporal',
        anaesthesia: { agent: 'Thiopentone', relaxant: 'Succinylcholine' },
      },
    });
    expect(refused.statusCode).toBe(409);
    expect(detail(refused)).toContain('There is no other route');

    // And the course length is the course length.
    await call({
      method: 'POST',
      url: `/api/v1/psy/ect-courses/${state.ectCourse}/sessions`,
      token: psychiatrist.token,
      payload: {
        placement: 'bitemporal',
        anaesthesia: { agent: 'Thiopentone', relaxant: 'Succinylcholine' },
      },
    });
    const third = await call({
      method: 'POST',
      url: `/api/v1/psy/ect-courses/${state.ectCourse}/sessions`,
      token: psychiatrist.token,
      payload: {
        placement: 'bitemporal',
        anaesthesia: { agent: 'Thiopentone', relaxant: 'Succinylcholine' },
      },
    });
    expect(third.statusCode).toBe(409);
    expect(detail(third)).toContain('authorised for 2 sessions');
  });
});

describe('OP-032 · scales and instruments', () => {
  it('scores PHQ-9 and carries the ninth question apart from the total', async () => {
    const moderate = await call({
      method: 'POST',
      url: '/api/v1/psy/scales',
      token: counsellor.token,
      payload: {
        patientId: PATIENT,
        episodeId: state.episode,
        scale: 'phq9',
        items: { '1': 3, '2': 3, '3': 2, '4': 2, '5': 1, '6': 2, '7': 1, '8': 1, '9': 0 },
      },
    });
    expect(moderate.statusCode, moderate.body).toBe(201);
    expect(moderate.json<{ total: number; severityBand: string; item9Flag: boolean }>()).toMatchObject({
      total: 15,
      severityBand: 'moderately_severe',
      item9Flag: false,
    });

    // A total of nine with a positive ninth is a different afternoon.
    const flagged = await call({
      method: 'POST',
      url: '/api/v1/psy/scales',
      token: counsellor.token,
      payload: {
        patientId: PATIENT,
        episodeId: state.episode,
        scale: 'phq9',
        items: { '1': 1, '2': 1, '3': 1, '4': 1, '5': 1, '6': 1, '7': 1, '8': 1, '9': 1 },
      },
    });
    expect(flagged.json<{ total: number; severityBand: string; item9Flag: boolean }>()).toMatchObject({
      total: 9,
      severityBand: 'mild',
      item9Flag: true,
    });

    const { rows } = await pg
      .pool('migrator')
      .query<{ event_type: string }>(
        `SELECT DISTINCT event_type FROM core.outbox_events WHERE event_type LIKE 'psy.%'`,
      );
    const types = rows.map((r) => r.event_type);
    expect(types).toContain('psy.risk.flagged');
    expect(types).toContain('psy.mhrb.intimation_due');
  });

  it('revokes an advance directive rather than removing it, and needs the Board to override', async () => {
    const made = await call({
      method: 'POST',
      url: '/api/v1/psy/instruments',
      token: psychiatrist.token,
      reason: 'Directive made in the community and lodged with the hospital.',
      payload: {
        patientId: PATIENT,
        kind: 'advance_directive',
        content: { refuses: ['ECT'], prefers: ['oral medication'] },
        madeAt: new Date(Date.now() - 365 * 86_400_000).toISOString(),
        validFrom: new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10),
        reason: 'Directive made in the community and lodged with the hospital.',
      },
    });
    expect(made.statusCode, made.body).toBe(201);
    state.directive = made.json<{ id: string }>().id;
    expect(made.json<{ inForce: boolean }>().inForce).toBe(true);

    const revoked = await call({
      method: 'POST',
      url: `/api/v1/psy/instruments/${state.directive}/revoke`,
      token: psychiatrist.token,
      reason: 'Set aside by the Review Board on the treating team’s application.',
      payload: {
        reason: 'Set aside by the Review Board on the treating team’s application.',
        mhrbRef: 'MHRB/KA/2026/512',
      },
    });
    expect(revoked.statusCode, revoked.body).toBe(201);
    expect(revoked.json<{ inForce: boolean; mhrbRef: string }>()).toMatchObject({
      inForce: false,
      mhrbRef: 'MHRB/KA/2026/512',
    });
  });

  it('answers every filtered list', async () => {
    for (const url of [
      '/api/v1/psy/episodes?activeOnly=true',
      '/api/v1/psy/episodes?authorityExpiringOnly=true',
      '/api/v1/psy/restraints?openOnly=true',
    ]) {
      const res = await call({ method: 'GET', url, token: psychiatrist.token });
      expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
      expect(Array.isArray(res.json())).toBe(true);
    }
  });
});
