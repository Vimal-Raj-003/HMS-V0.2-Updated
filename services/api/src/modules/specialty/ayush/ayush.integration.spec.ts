import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PERMISSION_CATALOGUE, newId } from '@vims/contracts';
import { createTenantFixture, startTestPostgres, type TenantFixture, type TestPostgres } from '@vims/testing';
import argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../../app.module.js';
import { AyushController } from './ayush.controller.js';
import { AyushService } from './ayush.service.js';

/**
 * OP-037 against a real PostgreSQL 17.
 *
 * Five systems India regulates as medicine, and four rules:
 *
 *  1. **A consultation's system matches a live council registration**, and a
 *     prescription inherits the consultation's system. A lapsed registration is
 *     not a registration.
 *  2. **A heavy-metal preparation has a duration ceiling**, and past a shorter
 *     threshold cannot exist without liver and kidney monitoring.
 *  3. **A pradhana karma needs a completed purvakarma session recording samyak
 *     snigdha lakshana**, and the course's consent.
 *  4. **A gender-matched therapy needs a therapist of the patient's gender**,
 *     unless the patient has consented otherwise — a consent id, not a boolean.
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

/** The vaidya: registered in Ayurveda only. */
const vaidya = actor('ay-vaidya');
/** The Panchakarma therapist: performs and logs, reviews nothing. */
const therapist = actor('ay-therapist');
/** The office that keeps the credentialling file. */
const registrar = actor('ay-registrar');

const CLINIC_KEYS = [
  'ayush.read',
  'ayush.consult.record',
  'ayush.consult.sign',
  'ayush.rx.create',
  'ayush.course.plan',
  'ayush.therapy.record',
  'ayush.therapy.review',
  'ayush.formulary.manage',
];
const THERAPIST_KEYS = ['ayush.read', 'ayush.therapy.record'];
const REGISTRAR_KEYS = ['ayush.read', 'ayush.registration.manage'];

/** A female patient — the gender-match rule needs a real gender to match. */
const PATIENT = newId();
const VAIDYA_PRACTITIONER = newId();
const HOMOEOPATH = newId();
const LAPSED = newId();

const state = {
  ayurvedaConsult: '',
  homoeoConsult: '',
  kwatha: '',
  bhasma: '',
  remedy: '',
  course: '',
  snehapana: '',
  abhyanga: '',
  virechana: '',
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

async function seedPatient(): Promise<void> {
  await pg.pool('migrator').query(
    `INSERT INTO patient.patients
       (id, hospital_id, branch_id, uhid, uhid_normalised, first_name, full_name, gender, dob,
        mobile, mobile_local, dedupe_fingerprint, status, updated_at)
     VALUES ($1, $2, $3, $4, $4, 'Lakshmi', 'Lakshmi Iyer', 'female', '1979-11-02',
             '+919845004411', '9845004411', $4, 'active', now())`,
    [PATIENT, tenants.hospitalA, tenants.branchA, `UH-${PATIENT.replace(/-/g, '').slice(-10)}`],
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
const alreadyWired = appControllers.includes(AyushController);

@Module({
  imports: [AppModule],
  controllers: alreadyWired ? [] : [AyushController],
  providers: alreadyWired ? [] : [AyushService],
})
class AyushTestModule {}

beforeAll(async () => {
  pg = await startTestPostgres();
  tenants = await createTenantFixture(pg, { codePrefix: 'AY' });
  await syncPermissions();

  await seedActor(vaidya, CLINIC_KEYS);
  await seedActor(therapist, THERAPIST_KEYS);
  await seedActor(registrar, REGISTRAR_KEYS);
  await seedPatient();

  process.env['DATABASE_URL'] = pg.connectionString('app');
  process.env['REDIS_URL'] = 'redis://127.0.0.1:6379';
  process.env['JWT_ACCESS_SECRET'] = 'a'.repeat(48);
  process.env['JWT_REFRESH_SECRET'] = 'b'.repeat(48);
  process.env['NODE_ENV'] = 'test';

  app = await NestFactory.create<NestFastifyApplication>(AyushTestModule, new FastifyAdapter(), {
    logger: false,
  });
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });
  await app.init();

  for (const who of [vaidya, therapist, registrar]) {
    who.token = await login(who.username);
  }
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pg?.stop();
});

describe('OP-037 · the registration is the boundary', () => {
  it('records three registrations, and says which are live', async () => {
    const rows: Record<string, { live: boolean; daysRemaining: number | null }> = {};

    for (const [key, body] of [
      [
        'ayurveda',
        {
          practitionerId: VAIDYA_PRACTITIONER,
          system: 'ayurveda',
          council: 'ncism',
          registrationNo: 'KA/AYU/2009/4412',
          validFrom: '2009-06-01',
          validTo: '2028-05-31',
        },
      ],
      [
        'homoeopathy',
        {
          practitionerId: HOMOEOPATH,
          system: 'homoeopathy',
          council: 'nch',
          registrationNo: 'KA/HOM/2014/1189',
          validFrom: '2014-04-01',
        },
      ],
      [
        'lapsed',
        {
          practitionerId: LAPSED,
          system: 'ayurveda',
          council: 'ncism',
          registrationNo: 'KA/AYU/2004/0871',
          validFrom: '2004-01-01',
          validTo: '2024-12-31',
        },
      ],
    ] as const) {
      const res = await call({
        method: 'POST',
        url: '/api/v1/ayush/registrations',
        token: registrar.token,
        payload: { ...body, reason: 'Credentialling file verified against the council register.' },
        reason: 'Credentialling file verified against the council register.',
      });
      expect(res.statusCode, res.body).toBe(201);
      rows[key] = res.json();
    }

    expect(rows.ayurveda?.live).toBe(true);
    expect(rows.homoeopathy?.live).toBe(true);
    // A lapsed registration is not a registration, and the row says so rather
    // than needing somebody to read the date.
    expect(rows.lapsed?.live).toBe(false);
    expect(rows.lapsed?.daysRemaining ?? 0).toBeLessThan(0);
  });

  it('refuses a registration whose council does not keep that register', async () => {
    // The National Commission for Homoeopathy does not register a vaidya.
    const res = await call({
      method: 'POST',
      url: '/api/v1/ayush/registrations',
      token: registrar.token,
      payload: {
        practitionerId: newId(),
        system: 'ayurveda',
        council: 'nch',
        registrationNo: 'X/1',
        validFrom: '2020-01-01',
        reason: 'Testing the council pairing.',
      },
      reason: 'Testing the council pairing.',
    });
    expect(res.statusCode).toBe(400);
  });

  it('keeps the credentialling file out of the clinic’s hands', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/ayush/registrations',
      token: vaidya.token,
      payload: {
        practitionerId: VAIDYA_PRACTITIONER,
        system: 'homoeopathy',
        council: 'nch',
        registrationNo: 'FORGED/1',
        validFrom: '2020-01-01',
        reason: 'A vaidya registering themselves in a second system.',
      },
      reason: 'A vaidya registering themselves in a second system.',
    });
    expect(res.statusCode).toBe(403);
  });

  it('opens a consultation in the registered system and refuses the others', async () => {
    const ok = await call({
      method: 'POST',
      url: '/api/v1/ayush/consults',
      token: vaidya.token,
      payload: {
        patientId: PATIENT,
        practitionerId: VAIDYA_PRACTITIONER,
        system: 'ayurveda',
        assessment: { prakriti: { vata: 45, pitta: 35, kapha: 20 }, agni: 'manda', koshtha: 'krura' },
      },
    });
    expect(ok.statusCode, ok.body).toBe(201);
    state.ayurvedaConsult = ok.json<{ id: string }>().id;
    expect(ok.json<{ blockedBy: string[] }>().blockedBy).toContain('no NAMASTE-coded diagnosis is recorded');

    const cross = await call({
      method: 'POST',
      url: '/api/v1/ayush/consults',
      token: vaidya.token,
      payload: { patientId: PATIENT, practitionerId: VAIDYA_PRACTITIONER, system: 'homoeopathy' },
    });
    expect(cross.statusCode).toBe(409);
    expect(detail(cross)).toContain('holds no homoeopathy registration');

    const lapsed = await call({
      method: 'POST',
      url: '/api/v1/ayush/consults',
      token: vaidya.token,
      payload: { patientId: PATIENT, practitionerId: LAPSED, system: 'ayurveda' },
    });
    expect(lapsed.statusCode).toBe(409);
    expect(detail(lapsed)).toContain('lapsed on 2024-12-31');

    const homoeo = await call({
      method: 'POST',
      url: '/api/v1/ayush/consults',
      token: vaidya.token,
      payload: { patientId: PATIENT, practitionerId: HOMOEOPATH, system: 'homoeopathy' },
    });
    expect(homoeo.statusCode, homoeo.body).toBe(201);
    state.homoeoConsult = homoeo.json<{ id: string }>().id;
  });

  it('offers no route that prescribes outside a registration', async () => {
    for (const url of [
      '/api/v1/ayush/registrations/waive',
      `/api/v1/ayush/consults/${state.ayurvedaConsult}/system`,
      '/api/v1/ayush/cross-system',
    ]) {
      const res = await call({ method: 'POST', url, token: vaidya.token, payload: {} });
      expect(res.statusCode, url).toBe(404);
    }
  });

  it('needs a NAMASTE code to sign', async () => {
    const bare = await call({
      method: 'POST',
      url: `/api/v1/ayush/consults/${state.ayurvedaConsult}/sign`,
      token: vaidya.token,
      payload: { diagnoses: [{ term: 'Amavata' }] },
    });
    expect(bare.statusCode).toBe(400);

    const coded = await call({
      method: 'POST',
      url: `/api/v1/ayush/consults/${state.ayurvedaConsult}/sign`,
      token: vaidya.token,
      payload: {
        diagnoses: [{ namasteCode: 'AAE-16', term: 'Amavata', icd11Tm2: 'SA01', primary: true }],
      },
    });
    expect(coded.statusCode, coded.body).toBe(201);
    expect(coded.json<{ signedAt: string | null }>().signedAt).not.toBeNull();
    expect(coded.json<{ blockedBy: string[] }>().blockedBy).toEqual([]);
  });
});

describe('OP-037 · the formulary, the metal and the potency', () => {
  it('builds a formulary and marks what this consultation cannot reach', async () => {
    for (const [key, body] of [
      [
        'kwatha',
        {
          system: 'ayurveda',
          code: 'dashamoola_kwatha',
          name: 'Dashamoola Kwatha',
          type: 'classical',
          form: 'Kwatha',
          classicalRef: { text: 'Sahasrayogam', chapter: 'Kashaya prakarana' },
        },
      ],
      [
        'bhasma',
        {
          system: 'ayurveda',
          code: 'rasa_sindoora',
          name: 'Rasa Sindoora',
          type: 'classical',
          form: 'Bhasma',
          scheduleE1: true,
          heavyMetal: true,
        },
      ],
      [
        'remedy',
        {
          system: 'homoeopathy',
          code: 'nux_vomica',
          name: 'Nux vomica',
          type: 'homoeo_remedy',
          form: 'Globules',
        },
      ],
    ] as const) {
      const res = await call({
        method: 'POST',
        url: '/api/v1/ayush/medicines',
        token: vaidya.token,
        payload: body,
      });
      expect(res.statusCode, res.body).toBe(201);
      state[key] = res.json<{ id: string }>().id;
    }

    // Read against the Ayurveda consultation: the homoeopathic remedy comes
    // back marked rather than filtered out, so the register boundary is
    // learnable instead of looking like a missing formulary entry.
    const res = await call({
      method: 'GET',
      url: `/api/v1/ayush/medicines?consultId=${state.ayurvedaConsult}`,
      token: vaidya.token,
    });
    expect(res.statusCode, res.body).toBe(200);
    const rows = res.json<{ code: string; reachable: boolean; reason: string | null }[]>();
    expect(rows.find((r) => r.code === 'dashamoola_kwatha')?.reachable).toBe(true);
    const remedy = rows.find((r) => r.code === 'nux_vomica');
    expect(remedy?.reachable).toBe(false);
    expect(remedy?.reason).toContain('not a licence in another');
  });

  it('publishes the heavy-metal ceiling rather than making it discoverable by refusal', async () => {
    const res = await call({
      method: 'GET',
      url: '/api/v1/ayush/heavy-metal-limits',
      token: vaidya.token,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ maxDays: number }>().maxDays).toBe(45);
    expect(res.json<{ monitoringAfterDays: number }>().monitoringAfterDays).toBe(21);
  });

  it('refuses a medicine from another system, and a potency in the wrong place', async () => {
    const cross = await call({
      method: 'POST',
      url: `/api/v1/ayush/consults/${state.ayurvedaConsult}/prescriptions`,
      token: vaidya.token,
      payload: {
        medicineId: state.remedy,
        dose: '4',
        unit: 'globules',
        durationDays: 7,
        potency: '30',
        scale: 'C',
      },
    });
    expect(cross.statusCode).toBe(409);
    expect(detail(cross)).toContain('belongs to the homoeopathy formulary');

    const potencyOnKwatha = await call({
      method: 'POST',
      url: `/api/v1/ayush/consults/${state.ayurvedaConsult}/prescriptions`,
      token: vaidya.token,
      payload: {
        medicineId: state.kwatha,
        dose: '40',
        unit: 'ml',
        durationDays: 7,
        potency: '200',
        scale: 'C',
      },
    });
    expect(potencyOnKwatha.statusCode).toBe(409);
    expect(detail(potencyOnKwatha)).toContain('A potency belongs to a homoeopathic remedy');

    const noPotency = await call({
      method: 'POST',
      url: `/api/v1/ayush/consults/${state.homoeoConsult}/prescriptions`,
      token: vaidya.token,
      payload: { medicineId: state.remedy, dose: '4', unit: 'globules', durationDays: 7 },
    });
    expect(noPotency.statusCode).toBe(409);
    expect(detail(noPotency)).toContain('carries a potency and a scale');
  });

  it('caps a heavy-metal course and requires monitoring past the threshold', async () => {
    const short = await call({
      method: 'POST',
      url: `/api/v1/ayush/consults/${state.ayurvedaConsult}/prescriptions`,
      token: vaidya.token,
      payload: { medicineId: state.bhasma, dose: '125', unit: 'mg', durationDays: 14 },
    });
    expect(short.statusCode, short.body).toBe(201);
    // Stamped from the master; there is no request field for either.
    expect(short.json<{ heavyMetal: boolean }>().heavyMetal).toBe(true);
    expect(short.json<{ scheduleE1: boolean }>().scheduleE1).toBe(true);
    expect(short.json<{ monitoringDueAt: string | null }>().monitoringDueAt).not.toBeNull();

    const unmonitored = await call({
      method: 'POST',
      url: `/api/v1/ayush/consults/${state.ayurvedaConsult}/prescriptions`,
      token: vaidya.token,
      payload: { medicineId: state.bhasma, dose: '125', unit: 'mg', durationDays: 30 },
    });
    expect(unmonitored.statusCode).toBe(409);
    expect(detail(unmonitored)).toContain('liver and kidney monitoring is required');

    const monitored = await call({
      method: 'POST',
      url: `/api/v1/ayush/consults/${state.ayurvedaConsult}/prescriptions`,
      token: vaidya.token,
      payload: {
        medicineId: state.bhasma,
        dose: '125',
        unit: 'mg',
        durationDays: 30,
        monitoringOrderId: newId(),
      },
    });
    expect(monitored.statusCode, monitored.body).toBe(201);

    const tooLong = await call({
      method: 'POST',
      url: `/api/v1/ayush/consults/${state.ayurvedaConsult}/prescriptions`,
      token: vaidya.token,
      payload: {
        medicineId: state.bhasma,
        dose: '125',
        unit: 'mg',
        durationDays: 90,
        monitoringOrderId: newId(),
      },
    });
    expect(tooLong.statusCode).toBe(409);
    expect(detail(tooLong)).toContain('exceeds the 45');
  });

  it('offers no route that clears a heavy-metal classification', async () => {
    for (const url of [
      `/api/v1/ayush/medicines/${state.bhasma}`,
      `/api/v1/ayush/medicines/${state.bhasma}/reclassify`,
    ]) {
      const res = await call({ method: 'POST', url, token: vaidya.token, payload: { heavyMetal: false } });
      expect(res.statusCode, url).toBe(404);
    }
  });
});

describe('OP-037 · the therapy course', () => {
  it('plans a course, and the plan becomes the worklist', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/ayush/courses',
      token: vaidya.token,
      payload: {
        patientId: PATIENT,
        consultId: state.ayurvedaConsult,
        system: 'ayurveda',
        name: 'Virechana karma for Amavata',
        planDays: [
          { day: 1, code: 'snehapana' },
          { day: 5, code: 'abhyanga' },
          { day: 6, code: 'virechana' },
          { day: 7, code: 'samsarjana' },
        ],
        startDate: new Date().toISOString().slice(0, 10),
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    state.course = res.json<{ id: string }>().id;
    expect(res.json<{ sessionsPlanned: number }>().sessionsPlanned).toBe(4);

    // Said before the therapist brings the patient in, not after.
    const blocked = res.json<{ blockedBy: string[]; readyForPradhana: boolean }>();
    expect(blocked.readyForPradhana).toBe(false);
    expect(blocked.blockedBy).toContain('no completed purvakarma session records samyak snigdha lakshana');
    expect(blocked.blockedBy).toContain('the course has no recorded consent');

    const sessions = await call({
      method: 'GET',
      url: `/api/v1/ayush/courses/${state.course}/sessions`,
      token: therapist.token,
    });
    expect(sessions.statusCode, sessions.body).toBe(200);
    const rows = sessions.json<{ id: string; procedureCode: string; phase: string }[]>();
    // The phase is copied from the procedure master, not named on the session.
    expect(rows.find((s) => s.procedureCode === 'snehapana')?.phase).toBe('purva');
    expect(rows.find((s) => s.procedureCode === 'virechana')?.phase).toBe('pradhana');
    state.snehapana = rows.find((s) => s.procedureCode === 'snehapana')?.id ?? '';
    state.abhyanga = rows.find((s) => s.procedureCode === 'abhyanga')?.id ?? '';
    state.virechana = rows.find((s) => s.procedureCode === 'virechana')?.id ?? '';
  });

  it('refuses a Virechana on an unoleated, unconsented course', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/ayush/sessions/${state.virechana}/log`,
      token: therapist.token,
      payload: {
        therapistIds: [therapist.userId],
        therapistGenders: ['female'],
        prechecks: { bp: '120/78', pulse: 76 },
        performedAt: new Date().toISOString(),
      },
    });
    expect(res.statusCode).toBe(409);
    // The oleation is checked first, and it is the one that kills people.
    expect(detail(res)).toContain('samyak snigdha lakshana');
  });

  it('refuses a session logged with no prechecks', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/ayush/sessions/${state.snehapana}/log`,
      token: therapist.token,
      payload: {
        therapistIds: [therapist.userId],
        therapistGenders: ['female'],
        prechecks: {},
        performedAt: new Date().toISOString(),
      },
    });
    expect(res.statusCode).toBe(409);
    expect(detail(res)).toContain('pre-therapy checks');
  });

  it('takes the oleation, then the consent, and Virechana becomes possible', async () => {
    const oleation = await call({
      method: 'POST',
      url: `/api/v1/ayush/sessions/${state.snehapana}/log`,
      token: therapist.token,
      payload: {
        therapistIds: [therapist.userId],
        therapistGenders: ['female'],
        prechecks: { bp: '118/74', pulse: 72, lastMealHoursAgo: 10, bowelsOpened: true },
        lakshana: 'samyak',
        performedAt: new Date().toISOString(),
      },
    });
    expect(oleation.statusCode, oleation.body).toBe(201);

    const consented = await call({
      method: 'POST',
      url: `/api/v1/ayush/courses/${state.course}`,
      token: vaidya.token,
      payload: { consentId: newId(), status: 'consented' },
    });
    expect(consented.statusCode, consented.body).toBe(201);
    expect(consented.json<{ readyForPradhana: boolean }>().readyForPradhana).toBe(true);
    expect(consented.json<{ blockedBy: string[] }>().blockedBy).toEqual([]);
  });

  it('matches the therapist’s gender, and takes a consent as the only exception', async () => {
    const mismatch = await call({
      method: 'POST',
      url: `/api/v1/ayush/sessions/${state.abhyanga}/log`,
      token: therapist.token,
      payload: {
        therapistIds: [therapist.userId],
        therapistGenders: ['male'],
        prechecks: { bp: '116/72', pulse: 70 },
        performedAt: new Date().toISOString(),
      },
    });
    expect(mismatch.statusCode).toBe(409);
    expect(detail(mismatch)).toContain('therapist of the patient');

    const waived = await call({
      method: 'POST',
      url: `/api/v1/ayush/sessions/${state.abhyanga}/log`,
      token: therapist.token,
      payload: {
        therapistIds: [therapist.userId],
        therapistGenders: ['male'],
        genderWaiverConsentId: newId(),
        prechecks: { bp: '116/72', pulse: 70 },
        lakshana: 'samyak',
        adverseEvent: 'Vasovagal episode at the end; recovered in ten minutes.',
        performedAt: new Date().toISOString(),
      },
    });
    expect(waived.statusCode, waived.body).toBe(201);
    // The adverse event is now what the course is waiting on, said on the row.
    expect(waived.json<{ blocksCourse: boolean }>().blocksCourse).toBe(true);
  });

  it('stops the course until the adverse event is reviewed', async () => {
    const blocked = await call({
      method: 'POST',
      url: `/api/v1/ayush/sessions/${state.virechana}/log`,
      token: therapist.token,
      payload: {
        therapistIds: [therapist.userId],
        therapistGenders: ['female'],
        prechecks: { bp: '120/78', pulse: 76, lastMealHoursAgo: 12 },
        performedAt: new Date().toISOString(),
      },
    });
    expect(blocked.statusCode).toBe(409);
    expect(detail(blocked)).toContain('adverse event that no physician has reviewed');

    // And the therapist cannot lift it themselves — the review is what
    // restarts the course, so it is the physician's key.
    const notTheirs = await call({
      method: 'POST',
      url: `/api/v1/ayush/sessions/${state.abhyanga}/review`,
      token: therapist.token,
      payload: { reviewNote: 'Looked fine to me.' },
    });
    expect(notTheirs.statusCode).toBe(403);

    const reviewed = await call({
      method: 'POST',
      url: `/api/v1/ayush/sessions/${state.abhyanga}/review`,
      token: vaidya.token,
      payload: {
        reviewNote: 'Postural. Hydrate before the next session and sit the patient up slowly.',
      },
    });
    expect(reviewed.statusCode, reviewed.body).toBe(201);
    expect(reviewed.json<{ blocksCourse: boolean }>().blocksCourse).toBe(false);

    const now = await call({
      method: 'POST',
      url: `/api/v1/ayush/sessions/${state.virechana}/log`,
      token: therapist.token,
      payload: {
        therapistIds: [therapist.userId],
        therapistGenders: ['female'],
        prechecks: { bp: '120/78', pulse: 76, lastMealHoursAgo: 12 },
        params: { vegaCount: 14 },
        lakshana: 'samyak',
        performedAt: new Date().toISOString(),
      },
    });
    expect(now.statusCode, now.body).toBe(201);
    expect(now.json<{ phase: string }>().phase).toBe('pradhana');
  });

  it('offers no route that skips the oleation or waives a gender match', async () => {
    for (const url of [
      `/api/v1/ayush/sessions/${state.virechana}/force`,
      `/api/v1/ayush/courses/${state.course}/skip-purvakarma`,
      `/api/v1/ayush/sessions/${state.abhyanga}/gender-override`,
    ]) {
      const res = await call({ method: 'POST', url, token: vaidya.token, payload: {} });
      expect(res.statusCode, url).toBe(404);
    }
  });

  it('needs a reason to skip a session and to abort a course', async () => {
    const skip = await call({
      method: 'POST',
      url: `/api/v1/ayush/sessions/${state.virechana}/skip`,
      token: therapist.token,
      payload: { skipReason: 'x' },
    });
    expect(skip.statusCode).toBe(400);

    const abort = await call({
      method: 'POST',
      url: `/api/v1/ayush/courses/${state.course}`,
      token: vaidya.token,
      payload: { status: 'aborted' },
    });
    expect(abort.statusCode).toBe(400);
  });
});
