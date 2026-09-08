import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PERMISSION_CATALOGUE, newId } from '@vims/contracts';
import { createTenantFixture, startTestPostgres, type TenantFixture, type TestPostgres } from '@vims/testing';
import argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../../app.module.js';
import { DietaryController } from './dietary.controller.js';
import { DietaryService } from './dietary.service.js';

/**
 * NC-033's Phase 8 half against a real PostgreSQL 17.
 *
 * Four rules, and all four are versions of *will this tray go*:
 *
 *  1. **A recipe whose allergens intersect the patient's is refused**, and the
 *     only exception is a dietician's named, reasoned override.
 *  2. **A recipe above the patient's IDDSI level cannot go on their tray**, and
 *     there is no override at all.
 *  3. **NPO is derived**, from the nil-by-mouth window against the slot's serve
 *     time in the hospital's own clock.
 *  4. **Hot food leaves at 63 °C or above, cold at 5 °C or below.**
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

/** The tray line: assembles and dispatches, overrides nothing. */
const kitchen = actor('dk-kitchen');
/** The dietician: sets the diet, and holds the one override. */
const dietician = actor('dk-dietician');
/** The ward: records what arrived and what was eaten. */
const nurse = actor('dk-nurse');

const KITCHEN_KEYS = [
  'dietary.read',
  'dietary.diet.read',
  'dietary.diet.operational',
  'dietary.tray.plan',
  'dietary.tray.assemble',
  'dietary.tray.dispatch',
  'dietary.master.manage',
];
const DIETICIAN_KEYS = [
  'dietary.read',
  'dietary.diet.read',
  'dietary.diet.operational',
  'dietary.allergen.override',
  'dietary.master.manage',
];
const NURSE_KEYS = ['dietary.read', 'dietary.diet.read', 'dietary.tray.deliver'];

const PATIENT = newId();
const ADMISSION = newId();
const WARD = newId();

const state = {
  breakfast: '',
  lunch: '',
  diet: '',
  tray: '',
  lunchTray: '',
  idli: '',
  chutney: '',
  toast: '',
  kanji: '',
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
     VALUES ($1, $2, $3, $4, $4, 'Meera', 'Meera Nair', 'female', '1951-02-14',
             '+919845007788', '9845007788', $4, 'active', now())`,
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

const TODAY = new Date().toISOString().slice(0, 10);

const appControllers = (Reflect.getMetadata('controllers', AppModule) ?? []) as unknown[];
const alreadyWired = appControllers.includes(DietaryController);

@Module({
  imports: [AppModule],
  controllers: alreadyWired ? [] : [DietaryController],
  providers: alreadyWired ? [] : [DietaryService],
})
class DietaryTestModule {}

beforeAll(async () => {
  pg = await startTestPostgres();
  tenants = await createTenantFixture(pg, { codePrefix: 'DK' });
  await syncPermissions();

  await seedActor(kitchen, KITCHEN_KEYS);
  await seedActor(dietician, DIETICIAN_KEYS);
  await seedActor(nurse, NURSE_KEYS);
  await seedPatient();

  process.env['DATABASE_URL'] = pg.connectionString('app');
  process.env['REDIS_URL'] = 'redis://127.0.0.1:6379';
  process.env['JWT_ACCESS_SECRET'] = 'a'.repeat(48);
  process.env['JWT_REFRESH_SECRET'] = 'b'.repeat(48);
  process.env['NODE_ENV'] = 'test';

  app = await NestFactory.create<NestFastifyApplication>(DietaryTestModule, new FastifyAdapter(), {
    logger: false,
  });
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });
  await app.init();

  for (const who of [kitchen, dietician, nurse]) {
    who.token = await login(who.username);
  }
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pg?.stop();
});

describe('NC-033 · the masters', () => {
  it('freezes the count before the meal is served', async () => {
    for (const [key, body] of [
      ['breakfast', { code: 'breakfast', name: 'Breakfast', serveMinute: 480, cutoffMinute: 360 }],
      ['lunch', { code: 'lunch', name: 'Lunch', serveMinute: 780, cutoffMinute: 600 }],
    ] as const) {
      const res = await call({
        method: 'POST',
        url: '/api/v1/dietary/slots',
        token: kitchen.token,
        payload: body,
      });
      expect(res.statusCode, res.body).toBe(201);
      state[key] = res.json<{ id: string }>().id;
    }

    const backwards = await call({
      method: 'POST',
      url: '/api/v1/dietary/slots',
      token: kitchen.token,
      payload: { code: 'supper', name: 'Supper', serveMinute: 1140, cutoffMinute: 1200 },
    });
    expect(backwards.statusCode).toBe(400);
  });

  it('builds a menu with allergens and IDDSI levels', async () => {
    for (const [key, body] of [
      ['idli', { code: 'idli_sambar', name: 'Idli and sambar', allergens: [], iddsiLevel: 6 }],
      [
        'chutney',
        {
          code: 'groundnut_chutney',
          name: 'Groundnut chutney',
          allergens: ['peanut'],
          iddsiLevel: 4,
          serveTemperature: 'cold',
        },
      ],
      ['toast', { code: 'toast', name: 'Buttered toast', allergens: ['wheat', 'milk'], iddsiLevel: 7 }],
      ['kanji', { code: 'kanji', name: 'Rice kanji', allergens: [], iddsiLevel: 3 }],
    ] as const) {
      const res = await call({
        method: 'POST',
        url: '/api/v1/dietary/recipes',
        token: kitchen.token,
        payload: body,
      });
      expect(res.statusCode, res.body).toBe(201);
      state[key] = res.json<{ id: string }>().id;
    }

    const offLadder = await call({
      method: 'POST',
      url: '/api/v1/dietary/recipes',
      token: kitchen.token,
      payload: { code: 'x', name: 'Off the ladder', iddsiLevel: 9 },
    });
    expect(offLadder.statusCode).toBe(400);
  });

  it('publishes the holding temperatures rather than making them discoverable by refusal', async () => {
    const res = await call({ method: 'GET', url: '/api/v1/dietary/holding-limits', token: kitchen.token });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ hotMinTenthC: number }>().hotMinTenthC).toBe(630);
    expect(res.json<{ coldMaxTenthC: number }>().coldMaxTenthC).toBe(50);
  });
});

describe('NC-033 · the tray copies the patient', () => {
  it('sets a diet, and the tray takes everything from it', async () => {
    const diet = await call({
      method: 'POST',
      url: '/api/v1/dietary/diets',
      token: dietician.token,
      payload: {
        admissionId: ADMISSION,
        patientId: PATIENT,
        wardId: WARD,
        bedLabel: 'W3-12',
        dietTypeCode: 'pureed',
        allergens: ['peanut'],
        iddsiFoodLevel: 4,
        iddsiFluidLevel: 4,
      },
    });
    expect(diet.statusCode, diet.body).toBe(201);
    state.diet = diet.json<{ id: string }>().id;

    const trays = await call({
      method: 'POST',
      url: '/api/v1/dietary/trays',
      token: kitchen.token,
      payload: {
        serviceDate: TODAY,
        slotId: state.breakfast,
        activeDietIds: [state.diet],
        // Offered and ignored: everything clinical is copied.
        dietTypeCode: 'regular',
        allergens: [],
      },
    });
    expect(trays.statusCode, trays.body).toBe(201);
    const rows =
      trays.json<{ id: string; dietTypeCode: string; allergens: string[]; iddsiFoodLevel: number }[]>();
    expect(rows).toHaveLength(1);
    state.tray = rows[0]?.id ?? '';
    expect(rows[0]?.dietTypeCode).toBe('pureed');
    expect(rows[0]?.allergens).toEqual(['peanut']);
    expect(rows[0]?.iddsiFoodLevel).toBe(4);
  });

  it('plans a meal twice without planning it twice', async () => {
    const again = await call({
      method: 'POST',
      url: '/api/v1/dietary/trays',
      token: kitchen.token,
      payload: { serviceDate: TODAY, slotId: state.breakfast, activeDietIds: [state.diet] },
    });
    expect(again.statusCode, again.body).toBe(201);
    expect(again.json<unknown[]>()).toHaveLength(0);
  });

  it('offers no route that sets a diet type or a texture level from the kitchen', async () => {
    for (const url of [
      `/api/v1/dietary/diets/${state.diet}/diet-type`,
      `/api/v1/dietary/trays/${state.tray}/diet-type`,
      `/api/v1/dietary/diets/${state.diet}/iddsi`,
    ]) {
      const res = await call({ method: 'POST', url, token: kitchen.token, payload: {} });
      expect(res.statusCode, url).toBe(404);
    }

    // And the operational route ignores what it is not allowed to change.
    const ok = await call({
      method: 'POST',
      url: `/api/v1/dietary/diets/${state.diet}`,
      token: kitchen.token,
      payload: { bedLabel: 'W3-14', dietTypeCode: 'regular', allergens: [], iddsiFoodLevel: 7 },
    });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json<{ bedLabel: string }>().bedLabel).toBe('W3-14');
    expect(ok.json<{ dietTypeCode: string }>().dietTypeCode).toBe('pureed');
    expect(ok.json<{ iddsiFoodLevel: number }>().iddsiFoodLevel).toBe(4);
  });
});

describe('NC-033 · the allergen guard and the IDDSI ceiling', () => {
  it('says which dishes are servable before anybody plates one', async () => {
    const res = await call({
      method: 'GET',
      url: `/api/v1/dietary/recipes?trayId=${state.tray}`,
      token: kitchen.token,
    });
    expect(res.statusCode, res.body).toBe(200);
    const rows =
      res.json<{ code: string; servable: boolean; overridable: boolean; reason: string | null }[]>();

    const kanji = rows.find((r) => r.code === 'kanji');
    expect(kanji?.servable).toBe(true);

    // The allergen refusal, which a dietician may override.
    const chutney = rows.find((r) => r.code === 'groundnut_chutney');
    expect(chutney?.servable).toBe(false);
    expect(chutney?.overridable).toBe(true);
    expect(chutney?.reason).toContain('peanut');

    // The IDDSI refusal, which nobody may. A screen that offered an override
    // here would be teaching a lie.
    const toast = rows.find((r) => r.code === 'toast');
    expect(toast?.servable).toBe(false);
    expect(toast?.overridable).toBe(false);
    expect(toast?.reason).toContain('swallow order at level 4');
  });

  it('refuses a peanut dish on a peanut-allergic patient', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/dietary/trays/${state.tray}/items`,
      token: kitchen.token,
      payload: { recipeId: state.chutney },
    });
    expect(res.statusCode).toBe(409);
    expect(detail(res)).toContain('recorded as allergic');
  });

  it('takes a dietician’s override, named and reasoned, and nobody else’s', async () => {
    const notTheirs = await call({
      method: 'POST',
      url: `/api/v1/dietary/trays/${state.tray}/items/override`,
      token: kitchen.token,
      payload: {
        recipeId: state.chutney,
        overrideReason: 'The patient asked for it and I think it is fine.',
      },
      reason: 'The patient asked for it and I think it is fine.',
    });
    expect(notTheirs.statusCode).toBe(403);

    const short = await call({
      method: 'POST',
      url: `/api/v1/dietary/trays/${state.tray}/items/override`,
      token: dietician.token,
      payload: { recipeId: state.chutney, overrideReason: 'ok' },
      reason: 'Reviewed the recorded reaction with the patient.',
    });
    expect(short.statusCode).toBe(400);

    const ok = await call({
      method: 'POST',
      url: `/api/v1/dietary/trays/${state.tray}/items/override`,
      token: dietician.token,
      payload: {
        recipeId: state.chutney,
        overrideReason:
          'Recorded reaction was oral itching to raw peanut only; roasted chutney tolerated for six months at home. Discussed with the patient.',
      },
      reason: 'Reviewed the recorded reaction with the patient.',
    });
    expect(ok.statusCode, ok.body).toBe(201);
    const item = ok
      .json<{ recipeId: string; overrideReason: string | null }[]>()
      .find((i) => i.recipeId === state.chutney);
    expect(item?.overrideReason).not.toBeNull();
  });

  it('refuses a dish above the swallow order’s level, with or without an override', async () => {
    const plain = await call({
      method: 'POST',
      url: `/api/v1/dietary/trays/${state.tray}/items`,
      token: kitchen.token,
      payload: { recipeId: state.toast },
    });
    expect(plain.statusCode).toBe(409);
    expect(detail(plain)).toContain('no override for this');

    // The dietician's override is for the allergen guard, and does not reach
    // this rule. That is the module's central distinction.
    const overridden = await call({
      method: 'POST',
      url: `/api/v1/dietary/trays/${state.tray}/items/override`,
      token: dietician.token,
      payload: {
        recipeId: state.toast,
        overrideReason: 'The patient asked for toast and their family agrees.',
      },
      reason: 'The patient asked for toast and their family agrees.',
    });
    expect(overridden.statusCode).toBe(409);
    expect(detail(overridden)).toContain('no override for this');

    const idli = await call({
      method: 'POST',
      url: `/api/v1/dietary/trays/${state.tray}/items`,
      token: kitchen.token,
      payload: { recipeId: state.idli },
    });
    expect(idli.statusCode).toBe(409);
  });

  it('takes a dish under the ceiling', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/dietary/trays/${state.tray}/items`,
      token: kitchen.token,
      payload: { recipeId: state.kanji },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(
      res.json<{ recipeId: string; iddsiLevel: number }[]>().find((i) => i.recipeId === state.kanji)
        ?.iddsiLevel,
    ).toBe(3);
  });

  it('offers no route that overrides a swallow order', async () => {
    for (const url of [
      `/api/v1/dietary/trays/${state.tray}/iddsi-override`,
      `/api/v1/dietary/trays/${state.tray}/items/force`,
      `/api/v1/dietary/diets/${state.diet}/swallow-waive`,
    ]) {
      const res = await call({ method: 'POST', url, token: dietician.token, payload: {} });
      expect(res.statusCode, url).toBe(404);
    }
  });
});

describe('NC-033 · NPO and the temperature at dispatch', () => {
  it('holds a tray when the patient is nil by mouth, and lifts it when the window ends', async () => {
    // Nil by mouth across the whole day, in the hospital's own clock.
    const npo = await call({
      method: 'POST',
      url: '/api/v1/dietary/diets',
      token: dietician.token,
      payload: {
        admissionId: ADMISSION,
        patientId: PATIENT,
        wardId: WARD,
        bedLabel: 'W3-14',
        dietTypeCode: 'pureed',
        allergens: ['peanut'],
        iddsiFoodLevel: 4,
        npoFrom: `${TODAY}T00:00:00+05:30`,
        npoTo: `${TODAY}T23:59:00+05:30`,
      },
    });
    expect(npo.statusCode, npo.body).toBe(201);

    const lunch = await call({
      method: 'POST',
      url: '/api/v1/dietary/trays',
      token: kitchen.token,
      payload: { serviceDate: TODAY, slotId: state.lunch, activeDietIds: [state.diet] },
    });
    expect(lunch.statusCode, lunch.body).toBe(201);
    const tray =
      lunch.json<{ id: string; status: string; holdReason: string | null; blockedBy: string[] }[]>()[0];
    state.lunchTray = tray?.id ?? '';
    // Derived, not chosen: nobody asked for this status.
    expect(tray?.status).toBe('held_npo');
    expect(tray?.holdReason).toContain('Nil by mouth');
    expect(tray?.blockedBy.length ?? 0).toBeGreaterThan(0);

    // And the breakfast tray, already planned, holds too.
    const held = await call({
      method: 'GET',
      url: `/api/v1/dietary/trays?serviceDate=${TODAY}&heldOnly=true`,
      token: kitchen.token,
    });
    expect(held.json<{ id: string }[]>().map((t) => t.id)).toContain(state.tray);

    const dispatched = await call({
      method: 'POST',
      url: `/api/v1/dietary/trays/${state.tray}/dispatch`,
      token: kitchen.token,
      payload: { temperatureTenthC: 700 },
    });
    expect(dispatched.statusCode).toBe(409);
    expect(detail(dispatched)).toContain('nil by mouth');

    // The window ends, and the hold lifts by itself.
    const lifted = await call({
      method: 'POST',
      url: '/api/v1/dietary/diets',
      token: dietician.token,
      payload: {
        admissionId: ADMISSION,
        patientId: PATIENT,
        wardId: WARD,
        bedLabel: 'W3-14',
        dietTypeCode: 'pureed',
        allergens: ['peanut'],
        iddsiFoodLevel: 4,
      },
    });
    expect(lifted.statusCode, lifted.body).toBe(201);

    const after = await call({
      method: 'GET',
      url: `/api/v1/dietary/trays?serviceDate=${TODAY}`,
      token: kitchen.token,
    });
    expect(after.json<{ id: string; status: string }[]>().find((t) => t.id === state.tray)?.status).toBe(
      'planned',
    );
  });

  it('offers no route that dispatches without a temperature', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/dietary/trays/${state.tray}/dispatch`,
      token: kitchen.token,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses hot food below 63 °C and takes it above', async () => {
    const cold = await call({
      method: 'POST',
      url: `/api/v1/dietary/trays/${state.tray}/dispatch`,
      token: kitchen.token,
      payload: { temperatureTenthC: 580 },
    });
    expect(cold.statusCode).toBe(409);
    expect(detail(cold)).toContain('hot-holding minimum');

    const ok = await call({
      method: 'POST',
      url: `/api/v1/dietary/trays/${state.tray}/dispatch`,
      token: kitchen.token,
      payload: { temperatureTenthC: 685 },
    });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json<{ status: string }>().status).toBe('dispatched');
  });

  it('refuses to dispatch an empty tray', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/dietary/trays/${state.lunchTray}/dispatch`,
      token: kitchen.token,
      payload: { temperatureTenthC: 700 },
    });
    expect(res.statusCode).toBe(409);
  });

  it('records what the patient actually ate, and keeps that out of the kitchen’s hands', async () => {
    const notTheirs = await call({
      method: 'POST',
      url: `/api/v1/dietary/trays/${state.tray}/deliver`,
      token: kitchen.token,
      payload: { intakePct: 40 },
    });
    expect(notTheirs.statusCode).toBe(403);

    const ok = await call({
      method: 'POST',
      url: `/api/v1/dietary/trays/${state.tray}/deliver`,
      token: nurse.token,
      payload: { intakePct: 40, feedback: { comment: 'Ate the kanji, left the rest.' } },
    });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json<{ status: string }>().status).toBe('delivered');
    expect(ok.json<{ intakePct: number }>().intakePct).toBe(40);

    const overFull = await call({
      method: 'POST',
      url: `/api/v1/dietary/trays/${state.tray}/deliver`,
      token: nurse.token,
      payload: { intakePct: 140 },
    });
    expect(overFull.statusCode).toBe(400);
  });

  it('needs a reason to refuse, return or cancel a tray', async () => {
    const bare = await call({
      method: 'POST',
      url: `/api/v1/dietary/trays/${state.lunchTray}/close`,
      token: nurse.token,
      payload: { status: 'cancelled', exception: 'x' },
    });
    expect(bare.statusCode).toBe(400);

    const ok = await call({
      method: 'POST',
      url: `/api/v1/dietary/trays/${state.lunchTray}/close`,
      token: nurse.token,
      payload: { status: 'cancelled', exception: 'Patient discharged before lunch.' },
    });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json<{ status: string }>().status).toBe('cancelled');
  });
});
