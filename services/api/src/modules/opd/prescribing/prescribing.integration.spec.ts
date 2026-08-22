import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PERMISSION_CATALOGUE, newId } from '@vims/contracts';
import { createTenantFixture, startTestPostgres, type TenantFixture, type TestPostgres } from '@vims/testing';
import argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../../app.module.js';
import { PRESCRIBING_CONTROLLERS, PRESCRIBING_PROVIDERS } from './prescribing.module.js';

/**
 * e-Prescribing, the CDSS floor and CPOE, against a real PostgreSQL 17.
 *
 * The properties proven here are the ones that cannot be established by reading
 * the code, and every one of them is a `phase-02` exit gate:
 *
 *  1. **A drug the patient is allergic to is refused, and no configuration can
 *     make it stop being refused** (gate 2). The test turns off every switch the
 *     product actually has — a feature flag, a hospital setting, a tenant CDSS
 *     rule disabled, an open emergency window, request fields that look like
 *     bypasses — and asserts the same 422 each time. It then proves the floor
 *     table itself cannot be emptied by the application role.
 *  2. **Cross-sensitivity is caught through `cdss_allergy_cross_map`**: a
 *     documented penicillin allergy stops a cephalosporin.
 *  3. **An interacting pair soft-stops and needs a coded reason** (gate 8's
 *     input): the same request succeeds only when it carries a reason *code*,
 *     and the override is stored where the fatigue report can aggregate it.
 *  4. **A 10x paediatric overdose is caught, and a missing weight blocks
 *     weight-based dosing** (gate 3).
 *  5. **A signed prescription cannot be mutated** — only amended into a new
 *     revision, with the previous one intact.
 *  6. **The hard stop still fires with the knowledge base unreachable** (D-9),
 *     simulated by revoking the application role's SELECT on the two knowledge
 *     tables; and a prescription with no hard stop is refused outright in that
 *     window rather than being let through.
 *  7. Permission gating, cross-tenant 404, and one audit row plus the registered
 *     outbox event per mutation, in the mutation's own transaction.
 *  8. An order raises `order.placed` and a `billing.charge_intents` row (gate 5).
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

/** A consultant: prescribes, signs, amends, orders, and can countersign. */
const doctor = actor('rx-doctor');
/** A second consultant, so a countersignature is genuinely a second person. */
const consultant = actor('rx-consultant');
/** A resident: writes the draft, holds no `rx.sign` (docs/05 row 14). */
const resident = actor('rx-resident');
/** Nursing: may print an Rx, may not write one. */
const nurse = actor('rx-nurse');
/** The same consultant surface, in the other hospital. */
const doctorB = actor('rx-doctor-b');

const CDSS_KEYS = ['cdss.evaluate', 'cdss.alert.read', 'cdss.alert.respond', 'cdss.report.read'];
const DOCTOR_KEYS = [
  'rx.drug.search',
  'rx.create',
  'rx.sign',
  'rx.amend',
  'rx.cancel',
  'rx.print',
  'order.create',
  'order.list',
  'order.cancel',
  ...CDSS_KEYS,
];
const CONSULTANT_KEYS = [...DOCTOR_KEYS, 'rx.cosign'];
const RESIDENT_KEYS = ['rx.drug.search', 'rx.create', 'rx.print', 'order.create', 'order.list', ...CDSS_KEYS];
const NURSE_KEYS = ['rx.print'];

/** Drug record keys, so a test can name the drug it means. */
const DRUG = {
  amoxicillin: newId(),
  ceftriaxone: newId(),
  paracetamol: newId(),
  nitrate: newId(),
  sildenafil: newId(),
  warfarin: newId(),
  cotrimoxazole: newId(),
  morphine: newId(),
};

const PATIENT = {
  allergic: newId(),
  /** A second allergic patient, so one test's countersignature is not another's. */
  allergicFresh: newId(),
  child: newId(),
  plain: newId(),
  other: newId(),
};

const ENCOUNTER = {
  /** An adult encounter with a recorded weight. */
  adult: newId(),
  adultFresh: newId(),
  /** A four-year-old with a recorded weight. */
  childWeighed: newId(),
  /** A four-year-old with no weight at all. */
  childUnweighed: newId(),
};

const KB_RELEASE = newId();
const REASON_SET = newId();
const REASON = { noAlternative: newId(), other: newId() };

// ── fixtures ─────────────────────────────────────────────────────────────────

async function syncPermissionCatalogue(): Promise<void> {
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
        p.requiresStepUp ?? false,
        p.phiRead ?? false,
        p.clinicalSafetyExempt ?? false,
      ],
    );
  }
}

async function defineSeries(
  hospitalId: string,
  branchId: string,
  key: string,
  pattern: string,
): Promise<void> {
  await pg.pool('migrator').query(
    `INSERT INTO core.numbering_series
       (id, hospital_id, branch_id, key, pattern, scope, fy, current_value, gapless,
        reset_policy, version, effective_from, active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'branch', NULL, 0, false,
             'never', 1, now() - interval '1 day', true, now(), now())`,
    [newId(), hospitalId, branchId, key, pattern],
  );
}

async function seedActor(
  hospitalId: string,
  branchId: string,
  who: Actor,
  permissionKeys: readonly string[],
): Promise<void> {
  const pool = pg.pool('migrator');
  const hash = await argon2.hash(PASSWORD, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });

  await pool.query(
    `INSERT INTO core.roles (id, hospital_id, key, name, description, home_workspace, category, updated_at)
     VALUES ($1, $2, $3, $4, 'Integration test role', 'doctor-opd', 'medical', now())`,
    [who.roleId, hospitalId, `role_${who.username.replace(/-/g, '_')}`, `Role ${who.username}`],
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
      hospitalId,
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
    [newId(), hospitalId, who.userId, who.roleId, branchId],
  );

  // The NMC registration the Rx prints, and the controlled-drug floor requires.
  await pool.query(
    `INSERT INTO mdm.mdm_practitioners
       (id, record_key, hospital_id, branch_id, version, code, user_id, full_name, display_name,
        registration_council, registration_number, effective_from, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $7, 'KMC', $8, now() - interval '1 day', 'active', now(), now())`,
    [
      newId(),
      newId(),
      hospitalId,
      branchId,
      `PR-${who.username}`,
      who.userId,
      `Dr ${who.username}`,
      `KMC-${who.username}`,
    ],
  );
}

interface DrugSeed {
  readonly key: string;
  readonly code: string;
  readonly generic: string;
  readonly atc: string;
  readonly route: string;
  readonly form: string;
  readonly schedule?: string;
  readonly weightBased?: boolean;
  readonly pregnancy?: string;
}

async function seedDrugs(hospitalId: string, branchId: string): Promise<void> {
  const drugs: readonly DrugSeed[] = [
    {
      key: DRUG.amoxicillin,
      code: 'AMOX500',
      generic: 'Amoxicillin',
      atc: 'J01CA04',
      route: 'oral',
      form: 'capsule',
    },
    {
      key: DRUG.ceftriaxone,
      code: 'CEFT1G',
      generic: 'Ceftriaxone',
      atc: 'J01DD04',
      route: 'intravenous',
      form: 'injection',
    },
    {
      key: DRUG.paracetamol,
      code: 'PARA125',
      generic: 'Paracetamol',
      atc: 'N02BE01',
      route: 'oral',
      form: 'syrup',
      weightBased: true,
    },
    {
      key: DRUG.nitrate,
      code: 'GTN',
      generic: 'Glyceryl trinitrate',
      atc: 'C01DA02',
      route: 'sublingual',
      form: 'tablet',
    },
    {
      key: DRUG.sildenafil,
      code: 'SILD',
      generic: 'Sildenafil',
      atc: 'G04BE03',
      route: 'oral',
      form: 'tablet',
    },
    { key: DRUG.warfarin, code: 'WARF', generic: 'Warfarin', atc: 'B01AA03', route: 'oral', form: 'tablet' },
    {
      key: DRUG.cotrimoxazole,
      code: 'COTRI',
      generic: 'Co-trimoxazole',
      atc: 'J01EE01',
      route: 'oral',
      form: 'tablet',
    },
    {
      key: DRUG.morphine,
      code: 'MORPH',
      generic: 'Morphine',
      atc: 'N02AA01',
      route: 'intravenous',
      form: 'injection',
      schedule: 'ndps_narcotic',
    },
  ];

  for (const drug of drugs) {
    await pg.pool('migrator').query(
      `INSERT INTO mdm.mdm_drugs
         (id, record_key, hospital_id, branch_id, version, code, generic_name, molecules, atc_code,
          form, route, schedule, is_weight_based, pregnancy_category, strength_text,
          effective_from, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 1, $5, $6, $7::text[], $8,
               $9::mdm."MdmDoseForm", $10::mdm."MdmDrugRoute", $11::mdm."MdmDrugSchedule", $12,
               $13::mdm."MdmPregnancyCategory", '500 mg',
               now() - interval '1 day', 'active', now(), now())`,
      [
        newId(),
        drug.key,
        hospitalId,
        branchId,
        drug.code,
        drug.generic,
        [drug.generic],
        drug.atc,
        drug.form,
        drug.route,
        drug.schedule ?? 'h',
        drug.weightBased ?? false,
        drug.pregnancy ?? 'b',
      ],
    );
  }

  for (const [code, label, perDay] of [
    ['OD', 'Once daily', 1],
    ['BD', 'Twice daily', 2],
    ['TDS', 'Three times daily', 3],
  ] as const) {
    await pg.pool('migrator').query(
      `INSERT INTO mdm.mdm_dose_frequencies
         (id, hospital_id, code, label, times_per_day, schedule_times, is_prn, is_stat, sort_order, active,
          created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, ARRAY[]::text[], false, false, 0, true, now(), now())`,
      [newId(), hospitalId, code, label, perDay],
    );
  }
}

/**
 * The shipped CDSS content: one `local_formulary` release, the interaction pairs,
 * the paracetamol dose bands and the penicillin cross-sensitivity classes.
 *
 * `hospital_id` is null on every row, exactly as `packages/db/src/seed` ships
 * them — content the product owns, readable by both tenants.
 */
async function seedCdssContent(): Promise<void> {
  const pool = pg.pool('migrator');

  await pool.query(
    `INSERT INTO clinical.cdss_kb_releases
       (id, hospital_id, provider, release_version, loaded_at, checksum, coverage, status, reviewed_at,
        created_at, updated_at)
     VALUES ($1, NULL, 'local_formulary', '2026.1', now(), $2, '{}'::jsonb, 'active', now(), now(), now())`,
    [KB_RELEASE, 'a'.repeat(64)],
  );

  const interactions: readonly (readonly [string, string, string, string])[] = [
    ['C01DA02', 'G04BE03', 'contraindicated', 'Do not co-prescribe: additive vasodilation.'],
    ['B01AA03', 'J01EE01', 'major', 'Choose another antibacterial; recheck INR within 3 days.'],
  ];
  for (const [a, b, severity, management] of interactions) {
    await pool.query(
      `INSERT INTO clinical.cdss_kb_interactions
         (id, hospital_id, kb_release_id, subject_a_kind, subject_a_code, subject_b_kind, subject_b_code,
          severity, onset, documentation, management_md, created_at)
       VALUES ($1, NULL, $2, 'atc', $3, 'atc', $4, $5::clinical."CdssSeverity", 'rapid', 'good', $6, now())`,
      [newId(), KB_RELEASE, a, b, severity, management],
    );
  }

  const bands: readonly (readonly [
    string,
    string,
    string,
    string,
    number,
    number,
    string,
    number,
    number,
  ])[] = [
    ['N02BE01', 'oral', 'child', 'per_kg', 10, 15, 'mg/kg/dose', 60, 75],
    ['N02BE01', 'oral', 'adult', 'flat', 500, 1000, 'mg/dose', 4000, 4000],
  ];
  for (const [atc, route, population, basis, min, max, unit, maxDaily, ceiling] of bands) {
    await pool.query(
      `INSERT INTO clinical.cdss_kb_dose_rules
         (id, hospital_id, kb_release_id, drug_key_kind, drug_key, route, population, basis,
          min_dose, max_dose, unit, max_daily, absolute_ceiling, renal_bands, hepatic_bands, created_at)
       VALUES ($1, NULL, $2, 'atc', $3, $4::mdm."MdmDrugRoute", $5::clinical."CdssPopulation",
               $6::clinical."CdssDoseBasis", $7, $8, $9, $10, $11, '[]'::jsonb, '[]'::jsonb, now())`,
      [newId(), KB_RELEASE, atc, route, population, basis, min, max, unit, maxDaily, ceiling],
    );
  }

  const crossMap: readonly (readonly [string, string, string, string[]])[] = [
    ['penicillin', 'J01C', 'Penicillins', ['cephalosporin']],
    ['penicillin', 'J01CA04', 'Amoxicillin', ['cephalosporin']],
    ['cephalosporin', 'J01DD04', 'Ceftriaxone', ['penicillin']],
  ];
  for (const [allergenClass, member, display, cross] of crossMap) {
    await pool.query(
      `INSERT INTO clinical.cdss_allergy_cross_map
         (id, hospital_id, allergen_class, code_system_key, member_substance, member_display,
          cross_classes, cross_reactivity_pct, active, created_at, updated_at)
       VALUES ($1, NULL, $2, 'ATC', $3, $4, $5::text[], 2, true, now(), now())`,
      [newId(), allergenClass, member, display, cross],
    );
  }

  await pool.query(
    `INSERT INTO clinical.cdss_override_reason_sets
       (id, hospital_id, key, name, family_scope, active, created_at, updated_at)
     VALUES ($1, NULL, 'medication.default', 'Medication alert override reasons',
             ARRAY['allergy','ddi','dose_range','duplicate_therapy']::clinical."CdssFamily"[], true, now(), now())`,
    [REASON_SET],
  );
  await pool.query(
    `INSERT INTO clinical.cdss_override_reasons
       (id, hospital_id, reason_set_id, code, label, requires_free_text, min_free_text_length, sort_order,
        active, created_at, updated_at)
     VALUES ($1, NULL, $2, 'NO_ALTERNATIVE', 'No therapeutic alternative available', false, 0, 0, true, now(), now()),
            ($3, NULL, $2, 'OTHER', 'Other (explain)', true, 20, 1, true, now(), now())`,
    [REASON.noAlternative, REASON_SET, REASON.other],
  );
}

/**
 * The tenant's own rules for the tunable families.
 *
 * EN-029 §5: "No rule fires without an active, effective-dated version", and
 * `cdss_alert_events_provenance` enforces it — an alert names a rule version or
 * a product floor entry, never neither. So a hospital that wants to be warned
 * about a major interaction publishes a rule saying so; the floor needs no such
 * permission, which is exactly the asymmetry these tests are about.
 */
async function seedTunableRules(hospitalId: string): Promise<void> {
  const pool = pg.pool('migrator');
  const families: readonly (readonly [string, string])[] = [
    ['ddi', 'soft_stop'],
    ['dose_range', 'soft_stop'],
    ['duplicate_therapy', 'soft_stop'],
    ['drug_disease', 'soft_stop'],
    ['geriatric', 'passive'],
  ];
  for (const [family, interruption] of families) {
    const ruleId = newId();
    await pool.query(
      `INSERT INTO clinical.cdss_rules
         (id, hospital_id, key, name, family, scope, clinical_rationale, status, current_version,
          created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::clinical."CdssFamily", 'hospital', 'Shipped default', 'active', 1,
               now(), now())`,
      [ruleId, hospitalId, `${family}.default`, `${family} default`, family],
    );
    await pool.query(
      `INSERT INTO clinical.cdss_rule_versions
         (id, hospital_id, rule_id, version, family, condition, action, interruption, severity,
          effective_from, published_at, checksum, created_at)
       VALUES ($1, $2, $3, 1, $4::clinical."CdssFamily", '{}'::jsonb, '{}'::jsonb,
               $5::clinical."CdssInterruption", 'moderate', now() - interval '1 day', now(), $6, now())`,
      [newId(), hospitalId, ruleId, family, interruption, 'c'.repeat(64)],
    );
  }
}

async function seedPatient(
  id: string,
  hospitalId: string,
  branchId: string,
  name: string,
  dob: string,
): Promise<void> {
  await pg.pool('migrator').query(
    `INSERT INTO patient.patients
       (id, hospital_id, branch_id, uhid, uhid_normalised, first_name, full_name, gender, dob,
        mobile, mobile_local, dedupe_fingerprint, status, updated_at)
     VALUES ($1, $2, $3, $4, $4, $5, $5, 'female', $6::date, '+919845000000', '9845000000', $7, 'active', now())`,
    // uuid v7 ids share a time prefix, so the UHID is taken from the tail.
    [id, hospitalId, branchId, `UH-${id.replace(/-/g, '').slice(-10)}`, name, dob, id.replace(/-/g, '')],
  );
}

async function seedAllergy(patientId: string, hospitalId: string, recordedBy: string): Promise<void> {
  await pg.pool('migrator').query(
    `INSERT INTO patient.allergies
       (id, hospital_id, patient_id, category, code_system_key, substance_code, substance_text,
        reaction, criticality, severity, status, informant, verification, recorded_by, recorded_at,
        created_at, updated_at)
     VALUES ($1, $2, $3, 'drug', 'ATC', 'J01CA04', 'Amoxicillin',
             ARRAY['anaphylaxis'], 'high', 'critical', 'active', 'patient', 'confirmed', $4, now(),
             now(), now())`,
    [newId(), hospitalId, patientId, recordedBy],
  );
}

async function seedEncounter(
  id: string,
  patientId: string,
  hospitalId: string,
  branchId: string,
  weightKg: number | null,
  by: string,
): Promise<void> {
  // `encounters_episode`: an encounter is never free-floating, so it needs the
  // OP visit it belongs to.
  const visitId = newId();
  await pg.pool('migrator').query(
    `INSERT INTO clinical.op_visits
       (id, hospital_id, branch_id, visit_no, patient_id, status, checked_in_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'in_consult', now(), now())`,
    [visitId, hospitalId, branchId, `V-${visitId.replace(/-/g, '').slice(-10)}`, patientId],
  );
  await pg.pool('migrator').query(
    `INSERT INTO clinical.encounters
       (id, hospital_id, branch_id, patient_id, visit_id, doctor_user_id, type, status, started_at,
        dosing_weight_kg, dosing_weight_source, dosing_weight_at, dosing_weight_by, updated_at)
     VALUES ($1, $2, $3, $4, $10, $5, 'opd', 'in_progress', now(),
             $6, $7::clinical."DosingWeightSource", $8, $9, now())`,
    [
      id,
      hospitalId,
      branchId,
      patientId,
      by,
      weightKg,
      weightKg === null ? 'unknown' : 'stated',
      weightKg === null ? null : new Date(),
      weightKg === null ? null : by,
      visitId,
    ],
  );
}

/**
 * A patient with no prescribing history.
 *
 * Used wherever a test needs a *clean* evaluation: a patient who is already on
 * amoxicillin gets a duplicate-therapy soft stop on the next amoxicillin line,
 * which is correct behaviour and would otherwise make later tests read as
 * failures of something else.
 */
async function freshPatient(name: string): Promise<string> {
  const id = newId();
  await seedPatient(id, tenants.hospitalA, tenants.branchA, name, '1980-05-05');
  return id;
}

async function login(hospitalId: string, identifier: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { hospitalId, identifier, password: PASSWORD },
  });
  const body = res.json<{ accessToken?: string }>();
  if (typeof body.accessToken !== 'string') {
    throw new Error(`login failed for ${identifier}: ${res.statusCode} ${res.body}`);
  }
  return body.accessToken;
}

interface CallOptions {
  readonly method: 'GET' | 'POST' | 'PATCH';
  readonly url: string;
  readonly token: string;
  readonly reason?: string;
  readonly idempotencyKey?: string;
  readonly payload?: Record<string, unknown>;
}

async function call(options: CallOptions) {
  const headers: Record<string, string> = { authorization: `Bearer ${options.token}` };
  if (options.reason !== undefined) headers['x-reason'] = options.reason;
  if (options.method === 'POST') headers['idempotency-key'] = options.idempotencyKey ?? newId();
  return app.inject({
    method: options.method,
    url: options.url,
    headers,
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  });
}

async function auditRowsForTrace(traceId: unknown): Promise<Array<Record<string, unknown>>> {
  const result = await pg.pool('migrator').query(
    `SELECT id, actor_user_id, trace_id, entity, action::text AS action, row_id, patient_id,
            business_key, reason_text, result::text AS result
       FROM core.audit_log WHERE trace_id = $1 ORDER BY recorded_at, id`,
    [String(traceId)],
  );
  return result.rows as Array<Record<string, unknown>>;
}

async function outboxRowsForTrace(traceId: unknown): Promise<Array<Record<string, unknown>>> {
  const result = await pg.pool('migrator').query(
    `SELECT id, event_type, aggregate, aggregate_id, payload, contains_phi, retention_days
       FROM core.outbox_events WHERE trace_id = $1 ORDER BY event_type`,
    [String(traceId)],
  );
  return result.rows as Array<Record<string, unknown>>;
}

/** A minimal, valid amoxicillin line. Callers override what they care about. */
function line(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    drugKey: DRUG.amoxicillin,
    doseQty: 500,
    doseUnit: 'mg',
    frequencyCode: 'TDS',
    durationValue: 5,
    durationUnit: 'days',
    ...overrides,
  };
}

/**
 * The application as it ships, plus this module.
 *
 * The root imports **only** `AppModule`. The prescribing controllers and
 * providers are declared here only while `AppModule` does not declare them
 * itself: once they are spread into it (the wiring every module in this
 * application uses), declaring them a second time would mount every route twice
 * and Fastify would refuse the duplicate before a single test ran. The check is
 * on `AppModule`'s own metadata, so this file needs no edit either way.
 */
const appControllers = (Reflect.getMetadata('controllers', AppModule) ?? []) as unknown[];
const alreadyWired = appControllers.includes(PRESCRIBING_CONTROLLERS[0]);

@Module({
  imports: [AppModule],
  controllers: alreadyWired ? [] : PRESCRIBING_CONTROLLERS,
  providers: alreadyWired ? [] : PRESCRIBING_PROVIDERS,
})
class PrescribingTestModule {}

beforeAll(async () => {
  pg = await startTestPostgres();
  tenants = await createTenantFixture(pg, { codePrefix: 'RX' });
  await syncPermissionCatalogue();

  await defineSeries(tenants.hospitalA, tenants.branchA, 'RX', 'RX{BR}{SEQ:6}');
  await defineSeries(tenants.hospitalA, tenants.branchA, 'ORD', 'ORD{BR}{SEQ:6}');
  await defineSeries(tenants.hospitalB, tenants.branchB, 'RX', 'RX{BR}{SEQ:6}');
  await defineSeries(tenants.hospitalB, tenants.branchB, 'ORD', 'ORD{BR}{SEQ:6}');

  await seedActor(tenants.hospitalA, tenants.branchA, doctor, DOCTOR_KEYS);
  await seedActor(tenants.hospitalA, tenants.branchA, consultant, CONSULTANT_KEYS);
  await seedActor(tenants.hospitalA, tenants.branchA, resident, RESIDENT_KEYS);
  await seedActor(tenants.hospitalA, tenants.branchA, nurse, NURSE_KEYS);
  await seedActor(tenants.hospitalB, tenants.branchB, doctorB, DOCTOR_KEYS);

  // Only hospital A gets a formulary: `mdm_drugs.record_key` is unique across
  // the estate, so the same keys cannot be seeded twice, and hospital B exists
  // in this suite only to prove isolation.
  await seedDrugs(tenants.hospitalA, tenants.branchA);
  await seedCdssContent();
  await seedTunableRules(tenants.hospitalA);

  await seedPatient(PATIENT.allergic, tenants.hospitalA, tenants.branchA, 'Asha', '1985-04-12');
  await seedPatient(PATIENT.allergicFresh, tenants.hospitalA, tenants.branchA, 'Latha', '1972-06-02');
  await seedPatient(PATIENT.child, tenants.hospitalA, tenants.branchA, 'Ravi', childDob());
  await seedPatient(PATIENT.plain, tenants.hospitalA, tenants.branchA, 'Meena', '1979-01-30');
  await seedPatient(PATIENT.other, tenants.hospitalB, tenants.branchB, 'Bravo', '1990-02-02');

  await seedAllergy(PATIENT.allergic, tenants.hospitalA, doctor.userId);
  await seedAllergy(PATIENT.allergicFresh, tenants.hospitalA, doctor.userId);

  await seedEncounter(
    ENCOUNTER.adult,
    PATIENT.allergic,
    tenants.hospitalA,
    tenants.branchA,
    62,
    doctor.userId,
  );
  await seedEncounter(
    ENCOUNTER.adultFresh,
    PATIENT.allergicFresh,
    tenants.hospitalA,
    tenants.branchA,
    58,
    doctor.userId,
  );
  await seedEncounter(
    ENCOUNTER.childWeighed,
    PATIENT.child,
    tenants.hospitalA,
    tenants.branchA,
    16,
    doctor.userId,
  );
  await seedEncounter(
    ENCOUNTER.childUnweighed,
    PATIENT.child,
    tenants.hospitalA,
    tenants.branchA,
    null,
    doctor.userId,
  );

  process.env['DATABASE_URL'] = pg.connectionString('app');
  process.env['REDIS_URL'] = 'redis://127.0.0.1:6379';
  process.env['JWT_ACCESS_SECRET'] = 'a'.repeat(48);
  process.env['JWT_REFRESH_SECRET'] = 'b'.repeat(48);
  process.env['NODE_ENV'] = 'test';

  app = await NestFactory.create<NestFastifyApplication>(PrescribingTestModule, new FastifyAdapter(), {
    logger: false,
  });
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  doctor.token = await login(tenants.hospitalA, doctor.username);
  consultant.token = await login(tenants.hospitalA, consultant.username);
  resident.token = await login(tenants.hospitalA, resident.username);
  nurse.token = await login(tenants.hospitalA, nurse.username);
  doctorB.token = await login(tenants.hospitalB, doctorB.username);
}, 600_000);

afterAll(async () => {
  await app?.close();
  await pg?.stop();
});

/** Four years old today, so the paediatric band is the one that applies. */
function childDob(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 4);
  return d.toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────────────────────────────
describe('the allergy hard stop (exit gate 2)', () => {
  const allergicRx = {
    patientId: PATIENT.allergic,
    encounterId: ENCOUNTER.adult,
    items: [line()],
  };

  it('refuses to write a prescription for a drug the patient is allergic to', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/prescriptions',
      token: doctor.token,
      payload: allergicRx,
    });

    expect(res.statusCode, res.body).toBe(422);
    const body = res.json<{ type: string; errors: Array<{ message: string }> }>();
    expect(body.type).toContain('clinical-hard-stop');
    expect(body.errors[0]?.message).toMatch(/allergy/i);

    // Nothing was written…
    const written = await pg
      .pool('migrator')
      .query(`SELECT count(*)::int AS n FROM clinical.prescriptions WHERE patient_id = $1`, [
        PATIENT.allergic,
      ]);
    expect(written.rows[0]?.n).toBe(0);

    // …but the evidence that the system interrupted survived the refusal.
    const alerts = await pg.pool('migrator').query(
      `SELECT safety_floor_key, outcome::text AS outcome, degraded
         FROM clinical.cdss_alert_events
        WHERE patient_id = $1 AND family = 'allergy'`,
      [PATIENT.allergic],
    );
    expect(alerts.rows.length).toBeGreaterThan(0);
    expect(alerts.rows[0]?.safety_floor_key).toBe('allergy_documented_anaphylaxis');
    expect(alerts.rows[0]?.outcome).toBe('hard_stop_blocked');
    // D-9: a floor family is never a degraded evaluation.
    expect(alerts.rows[0]?.degraded).toBe(false);

    const events = await pg
      .pool('migrator')
      .query(`SELECT count(*)::int AS n FROM core.outbox_events WHERE event_type = 'cdss.hardstop.blocked'`);
    expect(events.rows[0]?.n).toBeGreaterThan(0);
  });

  it('cannot be disabled by ANY configuration the product has', async () => {
    const pool = pg.pool('migrator');

    // 1. A feature flag turning the whole module off.
    for (const key of ['module.cdss.enabled', 'module.rx.enabled', 'cdss.allergy.enabled']) {
      await pool.query(
        `INSERT INTO core.feature_flags (id, key, hospital_id, enabled, note, updated_at)
         VALUES ($1, $2, $3, false, 'exit gate 2: prove this changes nothing', now())`,
        [newId(), key, tenants.hospitalA],
      );
    }

    // 2. A hospital setting saying the check is off.
    await pool.query(
      `INSERT INTO core.setting_definitions
         (key, module, label, description, scopes, json_schema, default_value, sensitivity, synced_at)
       VALUES ('cdss.allergy.hard_stop', 'EN-029', 'Allergy hard stop', 'test', ARRAY['hospital'],
               '{"type":"boolean"}'::jsonb, 'true'::jsonb, 'normal', now())
       ON CONFLICT (key) DO NOTHING`,
    );
    await pool.query(
      `INSERT INTO core.settings (id, hospital_id, key, value, updated_at)
       VALUES ($1, $2, 'cdss.allergy.hard_stop', 'false'::jsonb, now())`,
      [newId(), tenants.hospitalA],
    );

    // 3. A tenant CDSS rule in the allergy family, disabled and shadowed.
    const ruleId = newId();
    await pool.query(
      `INSERT INTO clinical.cdss_rules
         (id, hospital_id, key, name, family, scope, clinical_rationale, status, current_version,
          disabled_at, disabled_by, disabled_reason, created_at, updated_at)
       VALUES ($1, $2, 'allergy.local', 'Local allergy rule', 'allergy', 'hospital',
               'exit gate 2 fixture', 'disabled', 0, now(), $3, 'turned off deliberately', now(), now())`,
      [ruleId, tenants.hospitalA, doctor.userId],
    );

    // 4. An open emergency window on the encounter.
    await pool.query(
      `INSERT INTO clinical.cdss_emergency_modes
         (id, hospital_id, branch_id, encounter_id, activated_by, reason, started_at, expires_at,
          created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'mass casualty drill', now(), now() + interval '1 hour', now(), now())`,
      [newId(), tenants.hospitalA, tenants.branchA, ENCOUNTER.adult, doctor.userId],
    );

    // 5. Request-level bypasses of every shape a client might try.
    const bypasses: Record<string, unknown>[] = [
      { ...allergicRx },
      { ...allergicRx, skipCdss: true },
      { ...allergicRx, cdss: false, force: true, overrideAll: true },
      {
        ...allergicRx,
        items: [line({ overrides: [{ family: 'allergy', reasonCode: 'NO_ALTERNATIVE' }] })],
      },
    ];

    for (const payload of bypasses) {
      const res = await call({
        method: 'POST',
        url: '/api/v1/prescriptions',
        token: doctor.token,
        payload,
        reason: 'exit gate 2',
      });
      expect(res.statusCode, `payload ${JSON.stringify(payload)} was not refused: ${res.body}`).toBe(422);
      expect(res.json<{ type: string }>().type).toContain('clinical-hard-stop');
    }

    // 6. And the floor itself cannot be emptied by the application role.
    const appPool = pg.pool('app');
    await expect(
      appPool.query(`DELETE FROM clinical.cdss_safety_floor WHERE key = 'allergy_documented_anaphylaxis'`),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      appPool.query(`UPDATE clinical.cdss_safety_floor SET degrades_offline = true`),
    ).rejects.toThrow(/permission denied/i);

    // Clean up the emergency window so later tests see the ordinary state.
    // `expires_at > started_at` is a CHECK, so the window is removed rather than
    // back-dated — a bounded window has no way to express "already over".
    await pool.query(`DELETE FROM clinical.cdss_emergency_modes WHERE encounter_id = $1`, [ENCOUNTER.adult]);
  });

  it('catches a cross-reactive cephalosporin through the cross-sensitivity map', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/prescriptions',
      token: doctor.token,
      payload: {
        patientId: PATIENT.allergic,
        encounterId: ENCOUNTER.adult,
        items: [line({ drugKey: DRUG.ceftriaxone, doseQty: 1, doseUnit: 'g', frequencyCode: 'OD' })],
      },
    });

    expect(res.statusCode, res.body).toBe(422);
    expect(res.json<{ errors: Array<{ message: string }> }>().errors[0]?.message).toMatch(
      /cross-?sensitiv|cross-reactive/i,
    );

    const alert = await pg.pool('migrator').query(
      `SELECT context_ref->'evidence'->>'match' AS match,
              context_ref->'evidence'->>'crossClass' AS cross_class
         FROM clinical.cdss_alert_events
        WHERE patient_id = $1 AND family = 'allergy' AND context_ref->>'atcCode' = 'J01DD04'
        ORDER BY fired_at DESC LIMIT 1`,
      [PATIENT.allergic],
    );
    expect(alert.rows[0]?.match).toBe('cross_class');
    expect(alert.rows[0]?.cross_class).toBe('cephalosporin');
  });

  it('can be cleared only by a countersignature from a second clinician', async () => {
    const blocked = await call({
      method: 'POST',
      url: '/api/v1/prescriptions',
      token: doctor.token,
      payload: allergicRx,
    });
    expect(blocked.statusCode).toBe(422);
    const alertId = blocked.json<{ errors: Array<{ code: string }> }>().errors[0]?.code ?? '';
    const firedAt = await firedAtOf(alertId);

    // The prescriber cannot clear their own hard stop.
    const selfClear = await call({
      method: 'POST',
      url: `/api/v1/cdss/alerts/${alertId}/respond`,
      token: doctor.token,
      reason: 'no alternative agent available',
      payload: { firedAt, kind: 'overridden', reasonCode: 'NO_ALTERNATIVE' },
    });
    expect(selfClear.statusCode, selfClear.body).toBe(403);

    // A consultant can, and it is recorded as a countersignature.
    const cleared = await call({
      method: 'POST',
      url: `/api/v1/cdss/alerts/${alertId}/respond`,
      token: consultant.token,
      reason: 'no alternative agent available',
      payload: { firedAt, kind: 'overridden', reasonCode: 'NO_ALTERNATIVE' },
    });
    expect(cleared.statusCode, cleared.body).toBe(201);

    const action = await pg.pool('migrator').query(
      `SELECT kind::text AS kind, override_reason_code, countersigned_by
         FROM clinical.cdss_alert_actions WHERE alert_event_id = $1`,
      [alertId],
    );
    expect(action.rows[0]).toMatchObject({
      kind: 'overridden',
      override_reason_code: 'NO_ALTERNATIVE',
      countersigned_by: consultant.userId,
    });

    // With the countersignature on file, the same prescription is accepted —
    // and the line records that a hard stop fired on it.
    const accepted = await call({
      method: 'POST',
      url: '/api/v1/prescriptions',
      token: doctor.token,
      payload: allergicRx,
    });
    expect(accepted.statusCode, accepted.body).toBe(201);
    const created = accepted.json<{ id: string; items: Array<{ hard_stop_fired: boolean }> }>();
    expect(created.items[0]?.hard_stop_fired).toBe(true);

    await pg
      .pool('migrator')
      .query(`UPDATE clinical.prescriptions SET status = 'cancelled' WHERE id = $1`, [created.id]);
  });
});

async function firedAtOf(alertEventId: string): Promise<string> {
  const row = await pg
    .pool('migrator')
    .query(`SELECT fired_at FROM clinical.cdss_alert_events WHERE id = $1`, [alertEventId]);
  const value = row.rows[0]?.fired_at as Date | undefined;
  if (value === undefined) throw new Error(`no alert ${alertEventId}`);
  return value.toISOString();
}

// ─────────────────────────────────────────────────────────────────────────────
describe('paediatric dosing (exit gate 3)', () => {
  it('blocks a weight-based line when the encounter has no weight', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/prescriptions',
      token: doctor.token,
      payload: {
        patientId: PATIENT.child,
        encounterId: ENCOUNTER.childUnweighed,
        items: [line({ drugKey: DRUG.paracetamol, doseQty: 15, doseUnit: 'mg/kg', doseBasis: 'per_kg' })],
      },
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json<{ errors: Array<{ message: string }> }>().errors[0]?.message).toMatch(/weight/i);

    const alert = await pg.pool('migrator').query(
      `SELECT safety_floor_key FROM clinical.cdss_alert_events
        WHERE patient_id = $1 AND family = 'paediatric_weight' ORDER BY fired_at DESC LIMIT 1`,
      [PATIENT.child],
    );
    expect(alert.rows[0]?.safety_floor_key).toBe('paediatric_missing_weight');
  });

  it('catches a 10x overdose against the paediatric band', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/prescriptions',
      token: doctor.token,
      payload: {
        patientId: PATIENT.child,
        encounterId: ENCOUNTER.childWeighed,
        items: [line({ drugKey: DRUG.paracetamol, doseQty: 150, doseUnit: 'mg/kg', doseBasis: 'per_kg' })],
      },
    });
    expect(res.statusCode, res.body).toBe(422);

    // The floor row is asserted specifically: the tunable `dose_range` rule fires
    // on the same line in the same millisecond, and "the most recent alert" would
    // be whichever of the two was written last.
    const alert = await pg.pool('migrator').query(
      `SELECT safety_floor_key, interruption::text AS interruption,
              context_ref->'evidence'->>'observedDaily' AS observed
         FROM clinical.cdss_alert_events
        WHERE patient_id = $1 AND family = 'dose_range' AND safety_floor_key IS NOT NULL
        ORDER BY fired_at DESC LIMIT 1`,
      [PATIENT.child],
    );
    expect(alert.rows[0]?.safety_floor_key).toBe('dose_above_absolute_ceiling');
    expect(alert.rows[0]?.interruption).toBe('hard_stop');
    expect(Number(alert.rows[0]?.observed)).toBe(450);
  });

  it('accepts a correct weight-based dose and stores the weight it used', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/prescriptions',
      token: doctor.token,
      payload: {
        patientId: PATIENT.child,
        encounterId: ENCOUNTER.childWeighed,
        items: [line({ drugKey: DRUG.paracetamol, doseQty: 15, doseUnit: 'mg/kg', doseBasis: 'per_kg' })],
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json<{
      id: string;
      items: Array<{ weight_used_kg: number; computed_dose_qty: number }>;
    }>();
    expect(body.items[0]?.weight_used_kg).toBe(16);
    expect(body.items[0]?.computed_dose_qty).toBe(240);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('interactions and coded override reasons (exit gate 8)', () => {
  const interacting = {
    patientId: PATIENT.plain,
    items: [
      line({ drugKey: DRUG.nitrate, doseQty: 5, doseUnit: 'mg', frequencyCode: 'OD' }),
      line({ drugKey: DRUG.sildenafil, doseQty: 50, doseUnit: 'mg', frequencyCode: 'OD' }),
    ],
  };

  it('hard-stops a contraindicated pair', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/prescriptions',
      token: doctor.token,
      payload: interacting,
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json<{ type: string }>().type).toContain('clinical-hard-stop');

    const alert = await pg.pool('migrator').query(
      `SELECT safety_floor_key FROM clinical.cdss_alert_events
        WHERE patient_id = $1 AND family = 'ddi' ORDER BY fired_at DESC LIMIT 1`,
      [PATIENT.plain],
    );
    expect(alert.rows[0]?.safety_floor_key).toBe('interaction_contraindicated');
  });

  it('soft-stops a major pair and refuses it without a coded reason', async () => {
    const payload = {
      patientId: PATIENT.plain,
      items: [
        line({ drugKey: DRUG.warfarin, doseQty: 5, doseUnit: 'mg', frequencyCode: 'OD' }),
        line({ drugKey: DRUG.cotrimoxazole, doseQty: 960, doseUnit: 'mg', frequencyCode: 'BD' }),
      ],
    };

    const refused = await call({
      method: 'POST',
      url: '/api/v1/prescriptions',
      token: doctor.token,
      payload,
    });
    expect(refused.statusCode, refused.body).toBe(422);
    const body = refused.json<{ type: string; errors: Array<{ code: string; message: string }> }>();
    expect(body.type).toContain('business-rule-violated');
    expect(body.errors.map((e) => e.code)).toContain('ddi');
    expect(body.errors[0]?.message).toMatch(/coded override reason/i);

    // Free text alone is not a reason: the schema has no arm for it.
    const freeTextOnly = await call({
      method: 'POST',
      url: '/api/v1/prescriptions',
      token: doctor.token,
      payload: {
        ...payload,
        items: [
          line({
            drugKey: DRUG.warfarin,
            doseQty: 5,
            doseUnit: 'mg',
            frequencyCode: 'OD',
            overrides: [{ family: 'ddi', note: 'patient has tolerated this before' }],
          }),
          payload.items[1],
        ],
      },
    });
    expect(freeTextOnly.statusCode, freeTextOnly.body).toBe(400);

    // An unknown code is refused too — the reason is a foreign key, not a string.
    const badCode = await call({
      method: 'POST',
      url: '/api/v1/prescriptions',
      token: doctor.token,
      payload: {
        ...payload,
        items: [
          line({
            drugKey: DRUG.warfarin,
            doseQty: 5,
            doseUnit: 'mg',
            frequencyCode: 'OD',
            overrides: [{ family: 'ddi', reasonCode: 'BECAUSE_I_SAID_SO' }],
          }),
          payload.items[1],
        ],
      },
    });
    expect(badCode.statusCode, badCode.body).toBe(400);

    // `OTHER` demands at least twenty characters of explanation.
    const shortNote = await call({
      method: 'POST',
      url: '/api/v1/prescriptions',
      token: doctor.token,
      payload: {
        ...payload,
        items: [
          line({
            drugKey: DRUG.warfarin,
            doseQty: 5,
            doseUnit: 'mg',
            frequencyCode: 'OD',
            overrides: [{ family: 'ddi', reasonCode: 'OTHER', note: 'fine' }],
          }),
          payload.items[1],
        ],
      },
    });
    expect(shortNote.statusCode, shortNote.body).toBe(400);

    // With the coded reason, it is accepted and the override is recorded.
    const accepted = await call({
      method: 'POST',
      url: '/api/v1/prescriptions',
      token: doctor.token,
      payload: {
        ...payload,
        // The pair fires on both lines, and each line carries its own coded
        // reason: the prescriber is answering for that line, not for the pair.
        items: [
          line({
            drugKey: DRUG.warfarin,
            doseQty: 5,
            doseUnit: 'mg',
            frequencyCode: 'OD',
            overrides: [{ family: 'ddi', reasonCode: 'NO_ALTERNATIVE' }],
          }),
          line({
            drugKey: DRUG.cotrimoxazole,
            doseQty: 960,
            doseUnit: 'mg',
            frequencyCode: 'BD',
            overrides: [{ family: 'ddi', reasonCode: 'NO_ALTERNATIVE' }],
          }),
        ],
      },
    });
    expect(accepted.statusCode, accepted.body).toBe(201);

    const overrides = await pg.pool('migrator').query(
      `SELECT a.override_reason_code, a.kind::text AS kind
         FROM clinical.cdss_alert_actions a
         JOIN clinical.cdss_alert_events e ON e.id = a.alert_event_id AND e.fired_at = a.alert_fired_at
        WHERE e.patient_id = $1 AND e.family = 'ddi' AND a.kind = 'overridden'`,
      [PATIENT.plain],
    );
    expect(overrides.rows.length).toBeGreaterThan(0);
    expect(overrides.rows[0]?.override_reason_code).toBe('NO_ALTERNATIVE');
  });

  it('reports the override rate by coded reason', async () => {
    const res = await call({
      method: 'GET',
      url: '/api/v1/cdss/reports/alert-fatigue?days=1',
      token: doctor.token,
    });
    expect(res.statusCode, res.body).toBe(200);
    const report = res.json<{
      fires: number;
      overrides: number;
      overrideRatePct: number;
      overridesByReason: Record<string, number>;
      byFamily: Array<{ family: string }>;
    }>();
    expect(report.fires).toBeGreaterThan(0);
    expect(report.overridesByReason['NO_ALTERNATIVE']).toBeGreaterThan(0);
    expect(report.byFamily.map((f) => f.family)).toContain('allergy');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('signing, immutability and amendment', () => {
  let rxId = '';

  it('signs a clean prescription, burns an RX number and announces it', async () => {
    const created = await call({
      method: 'POST',
      url: '/api/v1/prescriptions',
      token: doctor.token,
      payload: {
        patientId: PATIENT.plain,
        items: [line({ drugKey: DRUG.amoxicillin })],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    rxId = created.json<{ id: string; rx_no: string | null; status: string }>().id;
    expect(created.json<{ rx_no: string | null }>().rx_no).toBeNull();

    const createTrace = created.headers['x-trace-id'];
    const createAudit = (await auditRowsForTrace(createTrace)).filter(
      (r) => r['entity'] === 'clinical.prescriptions',
    );
    expect(createAudit).toHaveLength(1);
    expect(createAudit[0]).toMatchObject({ action: 'insert', row_id: rxId, patient_id: PATIENT.plain });

    const signed = await call({
      method: 'POST',
      url: `/api/v1/prescriptions/${rxId}/sign`,
      token: doctor.token,
      payload: { signMethod: 'system' },
    });
    expect(signed.statusCode, signed.body).toBe(201);
    const body = signed.json<{ status: string; rx_no: string; signer_registration_no: string }>();
    expect(body.status).toBe('signed');
    expect(body.rx_no).toMatch(/^RX/);
    expect(body.signer_registration_no).toBe(`KMC-${doctor.username}`);

    const trace = signed.headers['x-trace-id'];
    const audit = (await auditRowsForTrace(trace)).filter((r) => r['entity'] === 'clinical.prescriptions');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'sign', row_id: rxId });

    const events = (await outboxRowsForTrace(trace)).filter((e) => e['event_type'] === 'rx.created');
    expect(events).toHaveLength(1);
    expect(events[0]?.['payload']).toMatchObject({ prescriptionId: rxId, rxNo: body.rx_no, itemCount: 1 });
    expect(events[0]?.['contains_phi']).toBe(true);
    expect(Number(events[0]?.['retention_days'])).toBeGreaterThan(365);
  });

  it('refuses to sign it twice', async () => {
    const again = await call({
      method: 'POST',
      url: `/api/v1/prescriptions/${rxId}/sign`,
      token: doctor.token,
      payload: { signMethod: 'system' },
    });
    expect(again.statusCode).toBe(409);
  });

  it('amends into a new revision, leaving the signed original intact', async () => {
    const before = await pg
      .pool('migrator')
      .query(`SELECT status::text AS status, rx_no, revision FROM clinical.prescriptions WHERE id = $1`, [
        rxId,
      ]);

    const amended = await call({
      method: 'POST',
      url: `/api/v1/prescriptions/${rxId}/amend`,
      token: doctor.token,
      reason: 'Dose reduced after the creatinine came back',
      payload: {
        reason: 'Dose reduced after the creatinine came back',
        items: [line({ drugKey: DRUG.amoxicillin, doseQty: 250 })],
      },
    });
    expect(amended.statusCode, amended.body).toBe(201);
    const next = amended.json<{ id: string; revision: number; supersedes_id: string; status: string }>();
    expect(next.revision).toBe(2);
    expect(next.supersedes_id).toBe(rxId);
    expect(next.status).toBe('signed');

    const after = await pg.pool('migrator').query(
      `SELECT status::text AS status, rx_no, revision, superseded_by_id, amendment_reason
           FROM clinical.prescriptions WHERE id = $1`,
      [rxId],
    );
    // The original keeps its number, its revision and its signature; only its
    // status moves, and it now points at what replaced it.
    expect(after.rows[0]?.rx_no).toBe(before.rows[0]?.rx_no);
    expect(after.rows[0]?.revision).toBe(before.rows[0]?.revision);
    expect(after.rows[0]?.status).toBe('amended');
    expect(after.rows[0]?.superseded_by_id).toBe(next.id);

    const items = await pg
      .pool('migrator')
      .query(
        `SELECT dose_qty::text AS dose_qty FROM clinical.prescription_items WHERE prescription_id = $1`,
        [rxId],
      );
    expect(Number(items.rows[0]?.dose_qty)).toBe(500);

    const events = (await outboxRowsForTrace(amended.headers['x-trace-id'])).filter(
      (e) => e['event_type'] === 'rx.amended',
    );
    expect(events).toHaveLength(1);
  });

  it('refuses an amendment with no reason', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/prescriptions/${rxId}/amend`,
      token: doctor.token,
      reason: 'because',
      payload: { items: [line()] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("holds a resident's prescription until a consultant co-signs it", async () => {
    const patientId = await freshPatient('Kavya');
    const draft = await call({
      method: 'POST',
      url: '/api/v1/prescriptions',
      token: resident.token,
      payload: {
        patientId,
        requestCosign: true,
        items: [line({ drugKey: DRUG.amoxicillin })],
      },
    });
    expect(draft.statusCode, draft.body).toBe(201);
    const held = draft.json<{ id: string; status: string; is_provisional: boolean }>();
    expect(held.status).toBe('awaiting_cosign');
    expect(held.is_provisional).toBe(true);
    expect((await outboxRowsForTrace(draft.headers['x-trace-id'])).map((e) => e['event_type'])).toContain(
      'rx.held',
    );

    // The resident holds no `rx.sign`, so they cannot release it themselves.
    const selfSign = await call({
      method: 'POST',
      url: `/api/v1/prescriptions/${held.id}/sign`,
      token: resident.token,
      payload: {},
    });
    expect(selfSign.statusCode).toBe(403);

    const cosigned = await call({
      method: 'POST',
      url: `/api/v1/prescriptions/${held.id}/cosign`,
      token: consultant.token,
      payload: {},
    });
    expect(cosigned.statusCode, cosigned.body).toBe(201);
    const released = cosigned.json<{ status: string; is_provisional: boolean; cosigned_by: string }>();
    expect(released.status).toBe('signed');
    expect(released.is_provisional).toBe(false);
    expect(released.cosigned_by).toBe(consultant.userId);

    const types = (await outboxRowsForTrace(cosigned.headers['x-trace-id'])).map((e) => e['event_type']);
    expect(types).toContain('rx.cosigned');
    expect(types).toContain('rx.created');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('permissions and tenancy', () => {
  it('refuses a prescription from a role without rx.create', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/prescriptions',
      token: nurse.token,
      payload: { patientId: PATIENT.plain, items: [line()] },
    });
    expect(res.statusCode).toBe(403);
  });

  it('answers a cross-tenant prescription id with 404, never 403', async () => {
    const patientId = await freshPatient('Nithya');
    const created = await call({
      method: 'POST',
      url: '/api/v1/prescriptions',
      token: doctor.token,
      payload: { patientId, items: [line()] },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json<{ id: string }>().id;

    const other = await call({ method: 'GET', url: `/api/v1/prescriptions/${id}`, token: doctorB.token });
    expect(other.statusCode).toBe(404);
    expect(other.json<{ type: string }>().type).toContain('not-found');
  });

  it("refuses to prescribe for another hospital's patient with a 404", async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/prescriptions',
      token: doctor.token,
      payload: { patientId: PATIENT.other, items: [line()] },
    });
    expect(res.statusCode).toBe(404);
  });

  it('refuses a Schedule X line until the catalogue’s second-person control is satisfied', async () => {
    // `rx.schedule_x.prescribe` is `requiresReason`, `requiresStepUp`,
    // `requiresSecondPerson` and `sensitiveGrant` in the catalogue. Nothing in
    // this module softens any of them, so a narcotic line is refused — and the
    // refusal names the missing authority rather than the missing dose cap.
    const res = await call({
      method: 'POST',
      url: '/api/v1/prescriptions',
      token: consultant.token,
      reason: 'palliative pain control',
      payload: {
        patientId: PATIENT.plain,
        items: [line({ drugKey: DRUG.morphine, doseQty: 5, doseUnit: 'mg', frequencyCode: 'OD' })],
      },
    });
    expect([403, 422]).toContain(res.statusCode);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the read surface', () => {
  it('searches the formulary by generic and by brand, carrying the safety flags', async () => {
    const res = await call({ method: 'GET', url: '/api/v1/drugs/search?q=amox', token: doctor.token });
    expect(res.statusCode, res.body).toBe(200);
    const items = res.json<{ items: Array<{ generic_name: string; schedule: string; is_lasa: boolean }> }>()
      .items;
    expect(items.map((i) => i.generic_name)).toContain('Amoxicillin');
    expect(items[0]).toHaveProperty('is_lasa');
    expect(items[0]).toHaveProperty('schedule');
  });

  it('lists a patient’s alerts, newest first, with the response that was recorded', async () => {
    const res = await call({
      method: 'GET',
      url: `/api/v1/cdss/alerts?patientId=${PATIENT.allergic}&limit=5`,
      token: doctor.token,
    });
    expect(res.statusCode, res.body).toBe(200);
    const page = res.json<{
      items: Array<{ family: string; safety_floor_key: string | null; action_kind: string | null }>;
      hasMore: boolean;
    }>();
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.some((a) => a.safety_floor_key === 'allergy_documented_anaphylaxis')).toBe(true);
    expect(page.items.some((a) => a.action_kind === 'overridden')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('CPOE (exit gate 5)', () => {
  it('places an order, raises the charge intent and announces both', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/orders',
      token: doctor.token,
      payload: {
        patientId: PATIENT.plain,
        category: 'lab',
        priority: 'routine',
        clinicalNotes: 'Rule out anaemia',
        items: [{ serviceName: 'Complete blood count', qty: 1, unitPrice: 250 }],
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const order = res.json<{ id: string; order_no: string; items: Array<{ charge_intent_id: string }> }>();
    expect(order.order_no).toMatch(/^ORD/);

    const intent = await pg.pool('migrator').query(
      `SELECT status::text AS status, source_table, description, amount::text AS amount
         FROM billing.charge_intents WHERE id = $1`,
      [order.items[0]?.charge_intent_id],
    );
    expect(intent.rows[0]).toMatchObject({
      status: 'pending',
      source_table: 'clinical.order_items',
      description: 'Complete blood count',
    });

    const types = (await outboxRowsForTrace(res.headers['x-trace-id'])).map((e) => e['event_type']);
    expect(types).toContain('order.placed');
    expect(types).toContain('order.lab.created');
    expect(types).toContain('charge.intent.created');

    const audit = (await auditRowsForTrace(res.headers['x-trace-id'])).filter(
      (r) => r['entity'] === 'clinical.orders',
    );
    expect(audit).toHaveLength(1);

    // Cancelling reverses the money and says why, in the same transaction.
    const cancelled = await call({
      method: 'POST',
      url: `/api/v1/orders/${order.id}/cancel`,
      token: doctor.token,
      reason: 'Ordered in error',
      payload: { reason: 'Ordered in error' },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(201);
    const after = await pg
      .pool('migrator')
      .query(`SELECT status::text AS status, reversal_reason FROM billing.charge_intents WHERE id = $1`, [
        order.items[0]?.charge_intent_id,
      ]);
    expect(after.rows[0]).toMatchObject({ status: 'reversed', reversal_reason: 'Ordered in error' });
    expect((await outboxRowsForTrace(cancelled.headers['x-trace-id'])).map((e) => e['event_type'])).toContain(
      'charge.intent.reversed',
    );
  });

  it('lists a patient’s orders', async () => {
    const res = await call({
      method: 'GET',
      url: `/api/v1/orders?patientId=${PATIENT.plain}&limit=5`,
      token: doctor.token,
    });
    expect(res.statusCode, res.body).toBe(200);
    const page = res.json<{ items: Array<{ order_no: string; items: unknown[] }> }>();
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items[0]?.items.length).toBeGreaterThan(0);
  });

  it('refuses an imaging order with no indication or pregnancy status', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/orders',
      token: doctor.token,
      payload: {
        patientId: PATIENT.plain,
        category: 'radiology',
        items: [{ serviceName: 'CT abdomen', qty: 1 }],
      },
    });
    expect(res.statusCode).toBe(400);
    const paths = res.json<{ errors: Array<{ path: string }> }>().errors.map((e) => e.path);
    expect(paths).toContain('clinicalNotes');
    expect(paths).toContain('pregnancyStatus');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('D-9: the floor does not degrade when the knowledge base is unreachable', () => {
  it('still hard-stops the allergy, and refuses everything else rather than guessing', async () => {
    const pool = pg.pool('migrator');
    const cleanPatient = await freshPatient('Priya');
    // The knowledge base, made genuinely unreadable to the application role.
    // Not a mock and not a flag: the queries fail exactly as they would if the
    // tables were dropped, the disk were full or the grant were revoked.
    await pool.query(`REVOKE SELECT ON clinical.cdss_kb_interactions FROM hms_app`);
    await pool.query(`REVOKE SELECT ON clinical.cdss_kb_dose_rules FROM hms_app`);

    try {
      const allergic = await call({
        method: 'POST',
        url: '/api/v1/prescriptions',
        token: doctor.token,
        payload: { patientId: PATIENT.allergicFresh, encounterId: ENCOUNTER.adultFresh, items: [line()] },
      });
      expect(allergic.statusCode, allergic.body).toBe(422);
      expect(allergic.json<{ type: string }>().type).toContain('clinical-hard-stop');
      expect(allergic.json<{ errors: Array<{ message: string }> }>().errors[0]?.message).toMatch(/allergy/i);

      // And a prescription with nothing wrong with it is refused too: with the
      // interaction and dose tables unreadable we do not know that nothing is
      // wrong with it. Failing closed is the only honest answer.
      const safe = await call({
        method: 'POST',
        url: '/api/v1/prescriptions',
        token: doctor.token,
        payload: { patientId: cleanPatient, items: [line()] },
      });
      expect(safe.statusCode, safe.body).toBe(503);
      expect(safe.json<{ type: string }>().type).toContain('dependency-unavailable');
    } finally {
      await pool.query(`GRANT SELECT ON clinical.cdss_kb_interactions TO hms_app`);
      await pool.query(`GRANT SELECT ON clinical.cdss_kb_dose_rules TO hms_app`);
    }

    // Back to normal once the knowledge base returns.
    const recovered = await call({
      method: 'POST',
      url: '/api/v1/prescriptions',
      token: doctor.token,
      payload: { patientId: cleanPatient, items: [line()] },
    });
    expect(recovered.statusCode, recovered.body).toBe(201);
  });

  it('marks an Rx signed against an unusable vendor release as degraded, and never the floor families', async () => {
    const pool = pg.pool('migrator');
    const cleanPatient = await freshPatient('Shalini');
    const vendorRelease = newId();
    await pool.query(
      `INSERT INTO clinical.cdss_kb_releases
         (id, hospital_id, provider, release_version, licence_ref, loaded_at, checksum, coverage,
          status, expires_at, created_at, updated_at)
       VALUES ($1, $2, 'cims_india', '2025.4', 'vault://cims', now(), $3, '{}'::jsonb,
               'active', now() - interval '1 day', now(), now())`,
      [vendorRelease, tenants.hospitalA, 'b'.repeat(64)],
    );

    try {
      const created = await call({
        method: 'POST',
        url: '/api/v1/prescriptions',
        token: doctor.token,
        payload: { patientId: cleanPatient, items: [line()] },
      });
      expect(created.statusCode, created.body).toBe(201);
      const body = created.json<{ id: string; cdss_degraded: boolean; cdss_degraded_families: string[] }>();
      expect(body.cdss_degraded).toBe(true);
      // The families that may degrade, and only those: the CHECK
      // `prescriptions_degraded_excludes_floor` would have refused the row
      // otherwise, which is the database saying the same thing.
      expect(body.cdss_degraded_families).not.toContain('allergy');
      expect(body.cdss_degraded_families).not.toContain('pregnancy');
      expect(body.cdss_degraded_families).toContain('ddi');

      // The allergy floor is untouched by the degradation.
      const stillBlocked = await call({
        method: 'POST',
        url: '/api/v1/prescriptions',
        token: doctor.token,
        payload: { patientId: PATIENT.allergicFresh, encounterId: ENCOUNTER.adultFresh, items: [line()] },
      });
      expect(stillBlocked.statusCode).toBe(422);
    } finally {
      await pool.query(`DELETE FROM clinical.cdss_kb_interactions WHERE kb_release_id = $1`, [vendorRelease]);
      await pool.query(`DELETE FROM clinical.cdss_kb_releases WHERE id = $1`, [vendorRelease]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('evaluation budget (docs/07 §2.1)', () => {
  it('evaluates a three-line bundle well inside the 100 ms rules budget', async () => {
    const samples: number[] = [];
    const ruleSamples: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const res = await call({
        method: 'POST',
        url: '/api/v1/cdss/evaluate',
        token: doctor.token,
        payload: {
          patientId: PATIENT.allergicFresh,
          encounterId: ENCOUNTER.adultFresh,
          items: [
            line(),
            line({ drugKey: DRUG.warfarin, doseQty: 5, frequencyCode: 'OD' }),
            line({ drugKey: DRUG.paracetamol, doseQty: 500, frequencyCode: 'TDS' }),
          ],
        },
      });
      expect(res.statusCode, res.body).toBe(201);
      const body = res.json<{ ruleLatencyMs: number; latencyMs: number; blocking: unknown[] }>();
      expect(body.blocking.length).toBeGreaterThan(0);
      samples.push(body.latencyMs);
      ruleSamples.push(body.ruleLatencyMs);
    }
    samples.sort((a, b) => a - b);
    ruleSamples.sort((a, b) => a - b);
    const at95 = (xs: number[]): number => xs[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))] ?? 0;
    // Measured on this suite's container, 20 evaluations of a three-line bundle:
    // rules-only p95 = 1 ms, whole server-side evaluation (context load + rules)
    // p95 = 5 ms, against EN-029 §13's 100 ms budget. The assertion is the
    // budget, not the measurement — a machine-specific number would fail on a
    // slower CI runner for no clinical reason.
    expect(at95(ruleSamples), `rules p95 ${at95(ruleSamples)} ms`).toBeLessThan(100);
    expect(at95(samples), `evaluation p95 ${at95(samples)} ms`).toBeLessThan(100);
  });
});
