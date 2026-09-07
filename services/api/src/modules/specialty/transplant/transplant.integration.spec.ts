import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PERMISSION_CATALOGUE, newId } from '@vims/contracts';
import { createTenantFixture, startTestPostgres, type TenantFixture, type TestPostgres } from '@vims/testing';
import argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../../app.module.js';
import { TransplantController } from './transplant.controller.js';
import { TransplantService } from './transplant.service.js';

/**
 * IP-019 and OP-024 against a real PostgreSQL 17.
 *
 * Two statutes about who may consent to a body, and what may not be bought:
 *
 *  1. **A living donor is a near relative under the Act, or the Authorisation
 *     Committee has said yes.** There is no third route.
 *  2. **Brain-stem death is four different doctors, none on the transplant
 *     team, examining twice six hours apart.**
 *  3. **A gamete donor donates once in a lifetime**, counted by the database
 *     against the bank's own reference.
 *  4. **A cycle needs a registered clinic and both consents**, and no column
 *     anywhere records a payment.
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

/** Registers recipients and works them up. Cannot record a donation. */
const coordinator = actor('tx-coord');
/** The transplant surgeon: records the donation and certifies brain-stem death. */
const surgeon = actor('tx-surgeon');
/** Runs the fertility clinic. */
const embryologist = actor('tx-art');

const COORD_KEYS = ['transplant.read', 'transplant.recipient.manage'];
const SURGEON_KEYS = [...COORD_KEYS, 'transplant.donation.record', 'transplant.brainstem.certify'];
const ART_KEYS = ['art.read', 'art.cycle.manage', 'art.donor.manage'];

const RECIPIENT = newId();
const DONOR = newId();
const DECEASED = newId();
const WOMAN = newId();

/** What the suites hand each other. */
const state = { recipient: '', donation: '', brainstem: '', donor: '', cycle: '' };

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
const alreadyWired = appControllers.includes(TransplantController);

@Module({
  imports: [AppModule],
  controllers: alreadyWired ? [] : [TransplantController],
  providers: alreadyWired ? [] : [TransplantService],
})
class TransplantTestModule {}

beforeAll(async () => {
  pg = await startTestPostgres();
  tenants = await createTenantFixture(pg, { codePrefix: 'TX' });
  await syncPermissions();

  await seedActor(coordinator, COORD_KEYS);
  await seedActor(surgeon, SURGEON_KEYS);
  await seedActor(embryologist, ART_KEYS);

  await seedPatient(RECIPIENT, 'Ramesh Gupta');
  await seedPatient(DONOR, 'Suresh Gupta');
  await seedPatient(DECEASED, 'Vijay Rao');
  await seedPatient(WOMAN, 'Nisha Bhat');

  process.env['DATABASE_URL'] = pg.connectionString('app');
  process.env['REDIS_URL'] = 'redis://127.0.0.1:6379';
  process.env['JWT_ACCESS_SECRET'] = 'a'.repeat(48);
  process.env['JWT_REFRESH_SECRET'] = 'b'.repeat(48);
  process.env['NODE_ENV'] = 'test';

  app = await NestFactory.create<NestFastifyApplication>(TransplantTestModule, new FastifyAdapter(), {
    logger: false,
  });
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });
  await app.init();

  for (const who of [coordinator, surgeon, embryologist]) {
    who.token = await login(who.username);
  }
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pg?.stop();
});

describe('IP-019 · the near relative, or the Committee', () => {
  it('takes a brother with evidence, and refuses one without', async () => {
    const listed = await call({
      method: 'POST',
      url: '/api/v1/transplant/recipients',
      token: coordinator.token,
      payload: {
        patientId: RECIPIENT,
        organ: 'kidney',
        indication: 'End-stage renal disease, four years on haemodialysis.',
        bloodGroup: 'O+',
        listedAt: new Date(Date.now() - 200 * 86_400_000).toISOString().slice(0, 10),
      },
    });
    expect(listed.statusCode, listed.body).toBe(201);
    state.recipient = listed.json<{ id: string }>().id;
    expect(listed.json<{ waitingDays: number }>().waitingDays).toBeGreaterThan(190);

    const noEvidence = await call({
      method: 'POST',
      url: '/api/v1/transplant/donations',
      token: surgeon.token,
      reason: 'Brother-to-brother living donation.',
      payload: {
        recipientId: state.recipient,
        donorPatientId: DONOR,
        organ: 'kidney',
        donorType: 'living_near_relative',
        relationship: 'brother',
        reason: 'Brother-to-brother living donation.',
      },
    });
    expect(noEvidence.statusCode).toBe(409);
    expect(detail(noEvidence)).toContain('how the relationship was established');

    const withEvidence = await call({
      method: 'POST',
      url: '/api/v1/transplant/donations',
      token: surgeon.token,
      reason: 'Brother-to-brother living donation, relationship documented.',
      payload: {
        recipientId: state.recipient,
        donorPatientId: DONOR,
        organ: 'kidney',
        donorType: 'living_near_relative',
        relationship: 'brother',
        relationshipEvidence: { documents: ['ration card', 'birth certificates'], hlaHaplotype: true },
        reason: 'Brother-to-brother living donation, relationship documented.',
      },
    });
    expect(withEvidence.statusCode, withEvidence.body).toBe(201);
    state.donation = withEvidence.json<{ id: string }>().id;
    expect(withEvidence.json<{ needsCommittee: boolean }>().needsCommittee).toBe(false);
  });

  it('refuses a donor who is not a near relative until the Committee has decided', async () => {
    const refused = await call({
      method: 'POST',
      url: '/api/v1/transplant/donations',
      token: surgeon.token,
      reason: 'Unrelated living donation.',
      payload: {
        recipientId: state.recipient,
        donorPatientId: newId(),
        organ: 'kidney',
        donorType: 'living_other',
        reason: 'Unrelated living donation.',
      },
    });
    expect(refused.statusCode).toBe(409);
    expect(detail(refused)).toContain('There is no other route');
    // The message says why, because the person hitting it needs to know it is
    // not a workflow gap.
    expect(detail(refused)).toContain('organs were bought from people who were poor');

    const approved = await call({
      method: 'POST',
      url: '/api/v1/transplant/donations',
      token: surgeon.token,
      reason: 'Authorisation Committee approved on 14 September.',
      payload: {
        recipientId: state.recipient,
        donorPatientId: newId(),
        organ: 'kidney',
        donorType: 'living_other',
        committeeRef: 'AC/KA/2026/318',
        committeeDecidedAt: new Date().toISOString(),
        reason: 'Authorisation Committee approved on 14 September.',
      },
    });
    expect(approved.statusCode, approved.body).toBe(201);
    expect(approved.json<{ needsCommittee: boolean; blockedBy: string[] }>().needsCommittee).toBe(true);
  });

  it('does not let the coordinator record a donation', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/transplant/donations',
      token: coordinator.token,
      reason: 'Recording a donation.',
      payload: {
        recipientId: state.recipient,
        organ: 'kidney',
        donorType: 'living_near_relative',
        relationship: 'sister',
        relationshipEvidence: { documents: ['ration card'] },
        reason: 'Recording a donation.',
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('will not perform a donation without both consents', async () => {
    const oneConsent = await call({
      method: 'POST',
      url: `/api/v1/transplant/donations/${state.donation}`,
      token: coordinator.token,
      payload: { recipientConsentId: newId(), performedAt: new Date().toISOString() },
    });
    expect(oneConsent.statusCode).toBe(409);
    expect(detail(oneConsent)).toContain("donor's own consent");

    const both = await call({
      method: 'POST',
      url: `/api/v1/transplant/donations/${state.donation}`,
      token: coordinator.token,
      payload: {
        recipientConsentId: newId(),
        donorConsentId: newId(),
        performedAt: new Date().toISOString(),
        status: 'transplanted',
      },
    });
    expect(both.statusCode, both.body).toBe(201);
    expect(both.json<{ blockedBy: string[] }>().blockedBy).toEqual([]);
  });
});

describe('IP-019 · four doctors, twice, six hours apart', () => {
  it('refuses a panel of three people, or one overlapping the transplant team', async () => {
    const a = newId();
    const b = newId();
    const c = newId();

    const three = await call({
      method: 'POST',
      url: '/api/v1/transplant/brainstem',
      token: surgeon.token,
      reason: 'Brain-stem death examination.',
      payload: {
        patientId: DECEASED,
        firstExamAt: new Date(Date.now() - 8 * 3_600_000).toISOString(),
        firstExam: { apnoea: 'positive', reflexes: 'absent' },
        rmpInChargeId: a,
        authorityNomineeId: b,
        neurologistId: c,
        treatingDoctorId: c,
        reason: 'Brain-stem death examination.',
      },
    });
    expect(three.statusCode).toBe(409);
    expect(detail(three)).toContain('four means four different people');

    const overlapping = await call({
      method: 'POST',
      url: '/api/v1/transplant/brainstem',
      token: surgeon.token,
      reason: 'Brain-stem death examination.',
      payload: {
        patientId: DECEASED,
        firstExamAt: new Date(Date.now() - 8 * 3_600_000).toISOString(),
        firstExam: { apnoea: 'positive' },
        rmpInChargeId: a,
        authorityNomineeId: b,
        neurologistId: c,
        treatingDoctorId: surgeon.userId,
        transplantTeamIds: [surgeon.userId],
        reason: 'Brain-stem death examination.',
      },
    });
    expect(overlapping.statusCode).toBe(409);
    expect(detail(overlapping)).toContain('not the panel declaring the donor dead');

    const lawful = await call({
      method: 'POST',
      url: '/api/v1/transplant/brainstem',
      token: surgeon.token,
      reason: 'Brain-stem death examination, panel constituted.',
      payload: {
        patientId: DECEASED,
        firstExamAt: new Date(Date.now() - 8 * 3_600_000).toISOString(),
        firstExam: { apnoea: 'positive', reflexes: 'absent' },
        rmpInChargeId: a,
        authorityNomineeId: b,
        neurologistId: c,
        treatingDoctorId: newId(),
        transplantTeamIds: [surgeon.userId],
        reason: 'Brain-stem death examination, panel constituted.',
      },
    });
    expect(lawful.statusCode, lawful.body).toBe(201);
    state.brainstem = lawful.json<{ id: string }>().id;
    // Eight hours have already passed, so the second is due.
    expect(lawful.json<{ minutesUntilSecondExam: number }>().minutesUntilSecondExam).toBe(0);
  });

  it('refuses a second examination inside six hours, and certifies after it', async () => {
    const { rows } = await pg
      .pool('migrator')
      .query<{ first_exam_at: Date }>(
        `SELECT first_exam_at FROM specialty.brainstem_death_certifications WHERE id = $1`,
        [state.brainstem],
      );
    const first = rows[0]?.first_exam_at ?? new Date();

    const tooSoon = await call({
      method: 'POST',
      url: `/api/v1/transplant/brainstem/${state.brainstem}/second-exam`,
      token: surgeon.token,
      reason: 'Second brain-stem examination by the constituted panel.',
      payload: {
        secondExamAt: new Date(new Date(first).getTime() + 4 * 3_600_000).toISOString(),
        secondExam: { apnoea: 'positive' },
        reason: 'Second brain-stem examination by the constituted panel.',
      },
    });
    expect(tooSoon.statusCode).toBe(409);
    expect(detail(tooSoon)).toContain('The interval is the test');

    const certified = await call({
      method: 'POST',
      url: `/api/v1/transplant/brainstem/${state.brainstem}/second-exam`,
      token: surgeon.token,
      reason: 'Second brain-stem examination six hours after the first; panel agreed.',
      payload: {
        secondExamAt: new Date(new Date(first).getTime() + 6 * 3_600_000).toISOString(),
        secondExam: { apnoea: 'positive', reflexes: 'absent' },
        certify: true,
        form10Ref: 'F10/KA/2026/77',
        reason: 'Second brain-stem examination six hours after the first; panel agreed.',
      },
    });
    expect(certified.statusCode, certified.body).toBe(201);
    expect(certified.json<{ intervalMin: number; certifiedAt: string | null }>().intervalMin).toBe(360);
    expect(certified.json<{ certifiedAt: string | null }>().certifiedAt).not.toBeNull();
  });
});

describe('OP-024 · one donation in a lifetime', () => {
  it('counts the donation and refuses the second', async () => {
    const donor = await call({
      method: 'POST',
      url: '/api/v1/art/donors',
      token: embryologist.token,
      reason: 'Registered against the bank’s reference; screening complete.',
      payload: {
        bankRegistrationNo: 'ARTB/KA/2023/12',
        bankDonorRef: 'D-4471',
        gamete: 'oocyte',
        ageYears: 27,
        reason: 'Registered against the bank’s reference; screening complete.',
      },
    });
    expect(donor.statusCode, donor.body).toBe(201);
    state.donor = donor.json<{ id: string }>().id;
    expect(donor.json<{ available: boolean; donationCount: number }>()).toMatchObject({
      available: true,
      donationCount: 0,
    });

    const first = await call({
      method: 'POST',
      url: '/api/v1/art/cycles',
      token: embryologist.token,
      payload: {
        patientId: WOMAN,
        clinicRegistrationNo: 'ARTC/KA/2023/44',
        cycleNo: 1,
        startedAt: new Date().toISOString().slice(0, 10),
        technique: 'oocyte_donation',
        donorId: state.donor,
      },
    });
    expect(first.statusCode, first.body).toBe(201);
    state.cycle = first.json<{ id: string }>().id;

    const second = await call({
      method: 'POST',
      url: '/api/v1/art/cycles',
      token: embryologist.token,
      payload: {
        patientId: newId(),
        clinicRegistrationNo: 'ARTC/KA/2023/44',
        cycleNo: 1,
        startedAt: new Date().toISOString().slice(0, 10),
        technique: 'oocyte_donation',
        donorId: state.donor,
      },
    });
    expect(second.statusCode).toBe(409);
    expect(detail(second)).toContain('one donation in a lifetime');

    const donors = await call({
      method: 'GET',
      url: '/api/v1/art/donors?availableDonorsOnly=true',
      token: embryologist.token,
    });
    expect(donors.json<{ id: string }[]>().map((d) => d.id)).not.toContain(state.donor);
  });

  it('needs both consents before a transfer, and holds the embryo count to three', async () => {
    const missing = await call({
      method: 'POST',
      url: `/api/v1/art/cycles/${state.cycle}`,
      token: embryologist.token,
      payload: {
        patientConsentId: newId(),
        embryosTransferred: 2,
        transferredAt: new Date().toISOString(),
      },
    });
    // No partner is recorded on this cycle, so one consent is enough.
    expect(missing.statusCode, missing.body).toBe(201);

    const four = await call({
      method: 'POST',
      url: `/api/v1/art/cycles/${state.cycle}`,
      token: embryologist.token,
      payload: { embryosTransferred: 4 },
    });
    expect(four.statusCode).toBe(400);

    const outcome = await call({
      method: 'POST',
      url: `/api/v1/art/cycles/${state.cycle}`,
      token: embryologist.token,
      payload: { outcome: 'clinical_pregnancy', registryRef: 'NAR/2026/8812' },
    });
    expect(outcome.statusCode, outcome.body).toBe(201);
  });

  it('refuses a cycle at an unregistered clinic', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/art/cycles',
      token: embryologist.token,
      payload: {
        patientId: WOMAN,
        clinicRegistrationNo: '',
        cycleNo: 2,
        startedAt: new Date().toISOString().slice(0, 10),
        technique: 'ivf',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('leaves the committee requirement, the certification and the outcome on the outbox', async () => {
    const { rows } = await pg.pool('migrator').query<{ event_type: string }>(
      `SELECT DISTINCT event_type FROM core.outbox_events
          WHERE event_type LIKE 'transplant.%' OR event_type LIKE 'art.%'`,
    );
    const types = rows.map((r) => r.event_type);
    for (const type of [
      'transplant.committee.required',
      'transplant.brainstem.certified',
      'art.cycle.completed',
    ]) {
      expect(types, type).toContain(type);
    }
  });

  it('answers every filtered list', async () => {
    for (const [url, token] of [
      ['/api/v1/transplant/recipients?organ=kidney', coordinator.token],
      ['/api/v1/transplant/donations?awaitingCommitteeOnly=true', coordinator.token],
      ['/api/v1/art/cycles', embryologist.token],
    ] as const) {
      const res = await call({ method: 'GET', url, token });
      expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
      expect(Array.isArray(res.json())).toBe(true);
    }
  });
});
