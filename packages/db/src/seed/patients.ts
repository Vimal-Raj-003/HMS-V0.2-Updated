import type { SeedContext } from './context.js';
import { SEED_EPOCH, seedDate, seedId, seedPick } from './ids.js';
import { jsonb, type SeedRow } from './upsert.js';
import { mainBranchOf, type SeededHospital, type SeededTenancy } from './tenancy.js';
import { demoUsers } from './users.js';
import { dedupeFingerprint, patientSeedId, syntheticPatient, syntheticUhid } from './synthetic.js';

/**
 * The patient population and one day's worth of front-office activity.
 *
 * Runs from the `demo` tier upward. Two properties are load-bearing and are the
 * same two `activity.ts` established for Phase 0:
 *
 *   * **Every value is derived from `SEED_EPOCH` or from a hash of the row's own
 *     identity**, never from `now()` or a random source. A partitioned table's
 *     primary key contains its partition key, so a moving timestamp would make
 *     the same logical row conflict-free and the second run would insert a
 *     duplicate rather than doing nothing.
 *
 *   * **Rows are written in batches.** The `volume` tier registers 220 000
 *     patients with three child rows each; materialising all of them before the
 *     first INSERT would cost gigabytes for no benefit.
 *
 * The activity window is January 2026 — a fixed month, so rows always land in
 * the same partition on every machine and in every year. The partitions the
 * migration premakes are relative to *its* run date, so the seed asks for the
 * months it needs rather than assuming.
 */

const PARTITIONED_TARGETS: readonly (readonly [string, string])[] = [
  ['queue', 'queue_tokens'],
  ['queue', 'queue_events'],
  ['engage', 'msg_messages'],
  ['engage', 'msg_events'],
  ['billing', 'payments'],
  ['billing', 'cash_drawer_events'],
  ['patient', 'consent_ledger'],
  ['integration', 'abdm_messages'],
];

/** Patients are written this many at a time. */
const BATCH = 2_000;

export async function seedPatientPopulation(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  if (ctx.patientCount === 0) return;

  await ensurePartitions(ctx);

  // 80/20 across the two demo hospitals. Not a round split: an MPI whose two
  // tenants are the same size hides the one bug that matters — a query that is
  // fast because it happened to read the smaller tenant.
  const shares = [0.8, 0.2];
  const counts = tenancy.hospitals.map((_h, i) =>
    Math.round(ctx.patientCount * (shares[i] ?? 1 / tenancy.hospitals.length)),
  );

  // `patients_allergy_assertion_attributed` requires an asserter for every arm
  // but `not_recorded`, so the seed names one rather than leaving the column
  // null and the constraint unsatisfied. It is a real seeded clinician: an
  // allergy history nobody signed is worth nothing, and a seed that pretends
  // otherwise teaches the wrong shape.
  const users = demoUsers(tenancy);
  for (const [index, hospital] of tenancy.hospitals.entries()) {
    const asserter =
      users.find((u) => u.hospital.code === hospital.code && u.roleKey === 'nurse_opd') ??
      users.find((u) => u.hospital.code === hospital.code && u.roleKey === 'receptionist');
    if (asserter === undefined) throw new Error(`No seeded clinician for ${hospital.code}`);
    await seedPatientsFor(ctx, hospital, counts[index] ?? 0, asserter.id);
  }

  await seedMpiCases(ctx, tenancy);
  await seedFrontOfficeActivity(
    ctx,
    tenancy,
    new Map(tenancy.hospitals.map((h, i) => [h.code, counts[i] ?? 0])),
  );
}

async function ensurePartitions(ctx: SeedContext): Promise<void> {
  for (const [schema, table] of PARTITIONED_TARGETS) {
    for (const month of ['2026-01-01', '2026-02-01']) {
      await ctx.db.query('SELECT core.ensure_month_partition($1, $2, $3::date)', [schema, table, month]);
    }
  }
}

// ── the population ──────────────────────────────────────────────────────────

async function seedPatientsFor(
  ctx: SeedContext,
  hospital: SeededHospital,
  count: number,
  allergyAsserterId: string,
): Promise<void> {
  const branches = hospital.branches;

  for (let offset = 0; offset < count; offset += BATCH) {
    const size = Math.min(BATCH, count - offset);
    const patients: SeedRow[] = [];
    const identifiers: SeedRow[] = [];
    const contacts: SeedRow[] = [];
    const alerts: SeedRow[] = [];
    const allergies: SeedRow[] = [];

    for (let i = offset; i < offset + size; i += 1) {
      const p = syntheticPatient(hospital.code, i);
      // The seed presents the *settled* statement, not the pre-trigger one.
      // `patient.sync_allergy_statement()` would otherwise promote the row to
      // `known` after the upsert had written `not_recorded`, and the second run
      // would see a difference and rewrite it — which is exactly the drift the
      // idempotency proof exists to catch.
      const hasAllergy = i % 12 === 0;
      const branch = branches[seedPick(branches.length, hospital.code, String(i), 'branch')] ?? branches[0];
      if (branch === undefined) continue;
      const id = patientSeedId(hospital.code, i);
      const uhid = syntheticUhid(branch.shortName, i);

      patients.push({
        id,
        hospital_id: hospital.id,
        branch_id: branch.id,
        mpi_group_id: null,
        uhid,
        uhid_normalised: uhid.toUpperCase(),
        title_code: p.titleCode,
        first_name: p.firstName,
        middle_name: null,
        last_name: p.lastName,
        full_name: p.fullName,
        local_name: null,
        gender: p.gender,
        dob: p.dob,
        dob_is_estimated: false,
        age_years: p.ageYears,
        age_months: null,
        age_days: null,
        blood_group: p.bloodGroup,
        marital_status: p.maritalStatus,
        allergy_statement: hasAllergy
          ? 'known'
          : i % 5 === 1
            ? 'none_known'
            : i % 29 === 3
              ? 'unable_to_assess'
              : 'not_recorded',
        allergy_asserted_by: hasAllergy || i % 5 === 1 || i % 29 === 3 ? allergyAsserterId : null,
        allergy_asserted_at: hasAllergy || i % 5 === 1 || i % 29 === 3 ? SEED_EPOCH : null,
        allergy_unable_reason:
          !hasAllergy && i % 5 !== 1 && i % 29 === 3
            ? 'Patient unconscious on arrival and no attendant present; to be re-asked when a relative attends.'
            : null,
        mobile: p.mobile,
        mobile_local: p.mobileLocal,
        mobile_verified_at: p.index % 3 === 0 ? seedDate(2) : null,
        alt_phone: null,
        email: p.email,
        whatsapp_opt_in: p.index % 4 !== 0,
        preferred_language: p.language,
        nationality_code: 'IND',
        religion_code: p.religionCode,
        occupation_code: p.occupationCode,
        id_type_code: p.hasAadhaar ? 'AADHAAR' : p.idTypeCode,
        id_last4: p.idLast4,
        aadhaar_last4: p.aadhaarLast4,
        aadhaar_hash: p.aadhaarHash,
        // Key version 1 is the seeded pepper. Production derives the pepper per
        // hospital from the KMS and bumps this when it rotates.
        aadhaar_hash_key_version: p.aadhaarHash === null ? null : 1,
        aadhaar_kyc_verified_at: p.aadhaarHash === null ? null : seedDate(1),
        abha_number: p.abhaNumber,
        abha_address: p.abhaAddress,
        abha_linked_at: p.abhaNumber === null ? null : seedDate(1),
        photo_file_id: null,
        address_line1: p.addressLine1,
        address_line2: p.addressLine2,
        area_key: null,
        city: p.city,
        district: p.district,
        state: p.state,
        country_code: 'IN',
        pincode: p.pincode,
        category: p.category,
        payer_type: 'self',
        payer_ref: null,
        payer_id: null,
        referral_source_code: 'SELF',
        referred_by_doctor_key: null,
        referred_by_text: null,
        is_vip: false,
        is_staff: false,
        is_differently_abled: p.index % 97 === 0,
        is_pregnant: false,
        is_deceased: false,
        deceased_at: null,
        death_registration_no: null,
        status: 'active',
        merged_into_id: null,
        merged_at: null,
        dedupe_fingerprint: dedupeFingerprint(p),
        created_override_reason: null,
        import_batch_id: null,
        source_channel: p.sourceChannel,
        provisional_ref: null,
        registered_at: seedDate(p.index % 300),
        last_visit_at: null,
        created_at: SEED_EPOCH,
        created_by: null,
        updated_at: SEED_EPOCH,
        updated_by: null,
        deleted_at: null,
        version: 0,
      });

      // One identifier row each: the ABHA where there is one, otherwise the
      // government photo ID. Aadhaar never gets a row — there is nothing
      // lawful to put in `value_normalised` for it, and the hash on the patient
      // is the whole of what may be kept.
      if (p.abhaNumber !== null && p.abhaAddress !== null) {
        identifiers.push({
          id: seedId('patient-identifier', hospital.code, String(i), 'abha'),
          hospital_id: hospital.id,
          patient_id: id,
          type: 'abha_number',
          id_type_code: 'ABHA',
          value_normalised: p.abhaNumber.replace(/-/g, ''),
          value_masked: `••••${p.abhaNumber.slice(-4)}`,
          value_encrypted: null,
          issued_by: 'National Health Authority',
          issued_on: null,
          expires_on: null,
          verified_at: seedDate(1),
          verified_by: null,
          source: 'abdm',
          is_primary: true,
          created_at: SEED_EPOCH,
          created_by: null,
          updated_at: SEED_EPOCH,
          deleted_at: null,
        });
      } else if (!p.hasAadhaar) {
        const value = `${p.idTypeCode}${p.mobileLocal}${p.idLast4}`;
        identifiers.push({
          id: seedId('patient-identifier', hospital.code, String(i), 'govt'),
          hospital_id: hospital.id,
          patient_id: id,
          type:
            p.idTypeCode === 'PAN'
              ? 'pan'
              : p.idTypeCode === 'PASSPORT'
                ? 'passport'
                : p.idTypeCode === 'VOTER'
                  ? 'voter_id'
                  : 'driving_licence',
          id_type_code: p.idTypeCode,
          value_normalised: value,
          value_masked: `••••${p.idLast4}`,
          value_encrypted: null,
          issued_by: null,
          issued_on: null,
          expires_on: null,
          verified_at: null,
          verified_by: null,
          source: 'desk',
          is_primary: true,
          created_at: SEED_EPOCH,
          created_by: null,
          updated_at: SEED_EPOCH,
          deleted_at: null,
        });
      }

      // OP-001 §3.1: the emergency contact is captured at registration, with
      // the "same as attendant?" prompt. Every patient has one.
      const contactSource = syntheticPatient(hospital.code, i + 1_000_003);
      contacts.push({
        id: seedId('patient-contact', hospital.code, String(i), 'emergency'),
        hospital_id: hospital.id,
        patient_id: id,
        kind: p.ageYears < 18 ? 'guardian' : 'emergency',
        name: contactSource.fullName,
        relationship_code: p.ageYears < 18 ? 'FATHER' : 'SPOUSE',
        phone: contactSource.mobile,
        alt_phone: null,
        email: null,
        address_line: null,
        id_type_code: null,
        id_last4: null,
        is_primary: true,
        is_guardian: p.ageYears < 18,
        notes: null,
        created_at: SEED_EPOCH,
        created_by: null,
        updated_at: SEED_EPOCH,
        updated_by: null,
        deleted_at: null,
        version: 0,
      });

      // Roughly one patient in twelve carries a recorded drug allergy — the
      // figure a real MPI shows, and enough that the banner and the (Phase-2)
      // interaction checker have something to fire on.
      if (hasAllergy) {
        const substance =
          ['Penicillin', 'Sulfonamides', 'Ibuprofen', 'Iodinated contrast', 'Peanut'][i % 5] ?? 'Penicillin';
        allergies.push({
          id: seedId('patient-allergy', hospital.code, String(i)),
          hospital_id: hospital.id,
          patient_id: id,
          category:
            substance === 'Peanut' ? 'food' : substance === 'Iodinated contrast' ? 'biologic' : 'drug',
          code_system_key: null,
          substance_code: null,
          substance_text: substance,
          reaction: substance === 'Penicillin' ? ['rash', 'urticaria'] : ['rash'],
          reaction_text: null,
          criticality: i % 60 === 0 ? 'high' : 'low',
          severity: i % 60 === 0 ? 'critical' : 'moderate',
          status: 'active',
          informant: 'patient',
          verification: 'unconfirmed',
          onset_on: null,
          last_occurred_on: null,
          recorded_by: allergyAsserterId,
          recorded_at: SEED_EPOCH,
          notes: null,
          created_at: SEED_EPOCH,
          created_by: null,
          updated_at: SEED_EPOCH,
          updated_by: null,
          version: 0,
        });

        alerts.push({
          id: seedId('patient-alert', hospital.code, String(i), 'allergy'),
          hospital_id: hospital.id,
          patient_id: id,
          type: 'allergy',
          severity: i % 60 === 0 ? 'critical' : 'moderate',
          label: `Allergy: ${substance}`,
          detail: null,
          source_type: 'patient.allergies',
          source_id: seedId('patient-allergy', hospital.code, String(i)),
          active_from: SEED_EPOCH,
          active_to: null,
          is_active: true,
          acknowledged_by: null,
          acknowledged_at: null,
          created_at: SEED_EPOCH,
          created_by: null,
          updated_at: SEED_EPOCH,
          updated_by: null,
          version: 0,
        });
      }
    }

    await ctx.write({ table: 'patient.patients', conflict: ['id'] }, patients);
    await ctx.write({ table: 'patient.identifiers', conflict: ['id'] }, identifiers);
    await ctx.write({ table: 'patient.contacts', conflict: ['id'] }, contacts);
    await ctx.write({ table: 'patient.allergies', conflict: ['id'] }, allergies);
    await ctx.write({ table: 'patient.alerts', conflict: ['id'] }, alerts);
  }
}

// ── the MPI cases the merge tool exists for ─────────────────────────────────

/**
 * A deliberate near-duplicate pair per hospital, an open dedupe candidate over
 * it, and one completed, reversible merge. `phase-01` exit gate 2 is exactly
 * this: "a deliberate duplicate is caught on create; a merge is performed and
 * fully audited; nothing is lost."
 */
async function seedMpiCases(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const candidates: SeedRow[] = [];
  const merges: SeedRow[] = [];
  const repoints: SeedRow[] = [];
  const history: SeedRow[] = [];
  const relationships: SeedRow[] = [];

  for (const h of tenancy.hospitals) {
    // Indices 0 and 1 always exist wherever there are patients at all.
    const aIndex = 0;
    const bIndex = 1;
    const aId = patientSeedId(h.code, aIndex);
    const bId = patientSeedId(h.code, bIndex);
    const [lowId, highId] = aId < bId ? [aId, bId] : [bId, aId];

    candidates.push({
      id: seedId('dedupe-candidate', h.code, 'pair-0-1'),
      hospital_id: h.id,
      patient_a_id: lowId,
      patient_b_id: highId,
      // OP-001 §5: name trigram ≥ 0.6 with gender and DOB ±1 y scores 0.85 —
      // the threshold that blocks a save without `create_override`.
      score: '0.850',
      rule_hits: jsonb({
        nameTrigram: 0.72,
        genderMatch: true,
        dobWithinOneYear: true,
        mobileMatch: false,
        abhaMatch: false,
        aadhaarHashMatch: false,
      }),
      detected_by: 'create_time',
      status: 'open',
      reviewed_by: null,
      reviewed_at: null,
      decision_note: null,
      merge_id: null,
      created_at: SEED_EPOCH,
      created_by: null,
      updated_at: SEED_EPOCH,
      version: 0,
    });

    // A completed merge over a different pair, still inside its 30-day
    // reversal window, so the unmerge path has something real to act on.
    const survivorIndex = 2;
    const victimIndex = 3;
    const survivorId = patientSeedId(h.code, survivorIndex);
    const victimId = patientSeedId(h.code, victimIndex);
    const survivor = syntheticPatient(h.code, survivorIndex);
    const victim = syntheticPatient(h.code, victimIndex);
    const branch = mainBranchOf(h);
    const mergeId = seedId('patient-merge', h.code, 'demo');

    merges.push({
      id: mergeId,
      hospital_id: h.id,
      survivor_id: survivorId,
      victim_id: victimId,
      survivor_uhid: syntheticUhid(branch.shortName, survivorIndex),
      victim_uhid: syntheticUhid(branch.shortName, victimIndex),
      status: 'completed',
      reason:
        'Same patient registered twice on the same day at two counters; mobile and date of birth identical.',
      survivor_snapshot: jsonb({
        uhid: syntheticUhid(branch.shortName, survivorIndex),
        fullName: survivor.fullName,
        dob: survivor.dob,
        mobile: survivor.mobile,
      }),
      victim_snapshot: jsonb({
        uhid: syntheticUhid(branch.shortName, victimIndex),
        fullName: victim.fullName,
        dob: victim.dob,
        mobile: victim.mobile,
      }),
      field_choices: jsonb({
        fullName: 'survivor',
        mobile: 'survivor',
        address: 'victim',
        bloodGroup: 'victim',
      }),
      requested_by: null,
      requested_at: seedDate(10),
      approval_id: null,
      merged_by: null,
      merged_at: seedDate(10, 1),
      // OP-001 §3.8: "Unmerge within 30 days if wrong".
      unmerge_deadline: seedDate(40, 1),
      unmerged_by: null,
      unmerged_at: null,
      unmerge_reason: null,
      details: jsonb({ channel: 'mrd_console', twoStepConfirmed: true }),
      created_at: SEED_EPOCH,
      created_by: null,
      updated_at: SEED_EPOCH,
      version: 0,
    });

    for (const [module, table, rows] of [
      ['OP-001', 'clinical.op_visits', 3],
      ['OP-001', 'clinical.appointments', 1],
      ['EN-006', 'queue.queue_tokens', 3],
      ['NC-001', 'billing.payments', 2],
      ['EN-028', 'patient.consents', 1],
    ] as const) {
      repoints.push({
        id: seedId('merge-repoint', h.code, module, table),
        hospital_id: h.id,
        merge_id: mergeId,
        module,
        table_name: table,
        rows_repointed: rows,
        row_ids: [],
        status: 'applied',
        applied_at: seedDate(10, 1),
        reversed_at: null,
        error_text: null,
        created_at: SEED_EPOCH,
        updated_at: SEED_EPOCH,
      });
    }

    history.push({
      id: seedId('demographic-history', h.code, 'merge'),
      hospital_id: h.id,
      patient_id: survivorId,
      changed_fields: ['address_line1', 'blood_group'],
      before: jsonb({ addressLine1: survivor.addressLine1, bloodGroup: survivor.bloodGroup }),
      after: jsonb({ addressLine1: victim.addressLine1, bloodGroup: victim.bloodGroup }),
      reason:
        'Field-level choices applied during MPI merge; the surviving record keeps the more recent address.',
      channel: 'merge',
      changed_by: null,
      changed_at: seedDate(10, 1),
      audit_id: null,
      created_at: SEED_EPOCH,
    });

    // A family link, so the guardian and family-account paths have data.
    relationships.push({
      id: seedId('patient-relationship', h.code, 'family'),
      hospital_id: h.id,
      patient_id: patientSeedId(h.code, 4),
      related_patient_id: patientSeedId(h.code, 5),
      relationship_code: 'SPOUSE',
      consent_id: null,
      is_guardian: false,
      is_emergency_contact: true,
      valid_from: null,
      valid_to: null,
      created_at: SEED_EPOCH,
      created_by: null,
      updated_at: SEED_EPOCH,
      deleted_at: null,
    });
  }

  await ctx.write({ table: 'patient.dedupe_candidates', conflict: ['id'] }, candidates);
  await ctx.write({ table: 'patient.merges', conflict: ['id'] }, merges);
  await ctx.write({ table: 'patient.merge_repoints', conflict: ['id'] }, repoints);
  await ctx.write({ table: 'patient.demographic_history', conflict: ['id'] }, history);
  await ctx.write({ table: 'patient.relationships', conflict: ['id'] }, relationships);
}

// ── one day of front-office activity ────────────────────────────────────────

const PRACTITIONER_CODES = [
  'DR001',
  'DR002',
  'DR003',
  'DR004',
  'DR005',
  'DR006',
  'DR007',
  'DR008',
  'DR009',
  'DR010',
] as const;

/**
 * Slots, appointments, visits, tokens, receipts, consents and messages for a
 * fixed January-2026 day, sized by `ctx.scale`. This is what makes a screen
 * look real and what gives `EXPLAIN` something to plan against on the tables
 * that are not the patient master.
 */
async function seedFrontOfficeActivity(
  ctx: SeedContext,
  tenancy: SeededTenancy,
  populationByHospital: ReadonlyMap<string, number>,
): Promise<void> {
  if (ctx.scale === 0) return;

  const users = demoUsers(tenancy);

  for (const h of tenancy.hospitals) {
    const branch = mainBranchOf(h);
    // Activity is sized by `ctx.scale` and the population by `ctx.patientCount`,
    // and the two do not move together — the `hospital` tier books more
    // appointments per doctor than it registers patients per doctor. Wrapping
    // the index inside the population is what stops an appointment pointing at
    // a patient that was never created: these columns are deliberately not
    // foreign keys (a patient may be merged away under them), so nothing would
    // have complained.
    const population = Math.max(1, populationByHospital.get(h.code) ?? 0);
    const cashier = users.find((u) => u.hospital.code === h.code && u.roleKey === 'cashier');
    const receptionist = users.find((u) => u.hospital.code === h.code && u.roleKey === 'receptionist');

    const slots: SeedRow[] = [];
    const appointments: SeedRow[] = [];
    const statusHistory: SeedRow[] = [];
    const visits: SeedRow[] = [];
    const series: SeedRow[] = [];
    const offlineBlocks: SeedRow[] = [];
    const tokens: SeedRow[] = [];
    const events: SeedRow[] = [];
    const consents: SeedRow[] = [];
    const ledger: SeedRow[] = [];
    const acknowledgements: SeedRow[] = [];
    const messages: SeedRow[] = [];
    const shifts: SeedRow[] = [];
    const shiftTotals: SeedRow[] = [];
    const denominations: SeedRow[] = [];
    const payments: SeedRow[] = [];
    const paymentLines: SeedRow[] = [];

    // Day 4 after the epoch is Monday 5 January 2026 — a working weekday, and
    // inside the premade partitions.
    const businessDate = '2026-01-05';

    // ── the cashier's shift ────────────────────────────────────────────────
    const shiftId = seedId('cash-shift', h.code, businessDate, 'CASH-1');
    const counterId = seedId('cash-counter', h.code, branch.code, 'CASH-1');

    // ── slots and appointments ─────────────────────────────────────────────
    const perDoctor = Math.max(1, Math.floor(ctx.scale / PRACTITIONER_CODES.length));

    PRACTITIONER_CODES.forEach((drCode, drIndex) => {
      const practitionerKey = seedId('mdm-practitioner-key', h.code, drCode);
      const queueId = seedId('queue-definition', h.code, branch.code, `DR-${drCode}`);

      const seriesId = seedId('queue-token-series', h.code, businessDate, drCode);
      series.push({
        id: seriesId,
        hospital_id: h.id,
        branch_id: branch.id,
        queue_id: queueId,
        scope_key: drCode,
        series_date: businessDate,
        prefix: `D${drIndex + 1}`,
        number_width: 3,
        start_number: 1,
        last_number: perDoctor,
        offline_reserved_from: 900,
        issued_count: perDoctor,
        reset_at: null,
        closed_at: null,
        created_at: SEED_EPOCH,
        updated_at: SEED_EPOCH,
        version: 0,
      });

      offlineBlocks.push({
        id: seedId('queue-offline-block', h.code, businessDate, drCode),
        hospital_id: h.id,
        branch_id: branch.id,
        queue_id: queueId,
        series_date: businessDate,
        scope_key: drCode,
        counter_id: seedId('queue-counter', h.code, branch.code, 'REG-1'),
        workstation_id: null,
        device_id: null,
        range_from: 900,
        range_to: 999,
        issued_count: 0,
        synced_count: 0,
        status: 'allocated',
        allocated_at: SEED_EPOCH,
        allocated_by: null,
        last_synced_at: null,
        expires_at: seedDate(5),
        created_at: SEED_EPOCH,
        updated_at: SEED_EPOCH,
        version: 0,
      });

      for (let n = 0; n < perDoctor; n += 1) {
        const patientIndex = (drIndex * 500 + n + 10) % population;
        const patientId = patientSeedId(h.code, patientIndex);
        const startMinutes = 9 * 60 + n * 15;
        const slotStart = new Date(
          Date.UTC(2026, 0, 5, Math.floor(startMinutes / 60) - 5, (startMinutes % 60) - 30),
        );
        const slotEnd = new Date(slotStart.getTime() + 15 * 60_000);
        const slotId = seedId('schedule-slot', h.code, drCode, businessDate, String(n));

        slots.push({
          id: slotId,
          hospital_id: h.id,
          branch_id: branch.id,
          template_id: null,
          practitioner_key: practitionerKey,
          room_key: null,
          speciality_key: null,
          service_key: null,
          slot_date: businessDate,
          slot_start: slotStart,
          slot_end: slotEnd,
          capacity: 2,
          overbook_allowance: 1,
          booked_count: 1,
          online_quota: 1,
          online_booked_count: 0,
          walkin_reserve: 0,
          consult_type_keys: [],
          tele_enabled: false,
          status: 'filling',
          blocked_reason: null,
          exception_id: null,
          created_at: SEED_EPOCH,
          updated_at: SEED_EPOCH,
          version: 0,
        });

        // Derived from (doctor, slot) rather than from a running counter, so
        // the same logical appointment carries the same number at every tier.
        // A counter would make `hospital` and `volume` disagree about which
        // appointment owns `.../APPT/2026/000123`, and the unique index would
        // reject the second tier's row rather than recognising it.
        const sequence = drIndex * 1_000 + n + 1;
        const appointmentId = seedId('appointment', h.code, drCode, businessDate, String(n));
        const isNoShow = n % 17 === 0;
        const isCancelled = n % 23 === 0 && !isNoShow;
        const status = isCancelled ? 'cancelled' : isNoShow ? 'no_show' : 'completed';

        appointments.push({
          id: appointmentId,
          hospital_id: h.id,
          branch_id: branch.id,
          appointment_no: `${branch.shortName}/APPT/2026/${String(sequence).padStart(6, '0')}`,
          patient_id: patientId,
          lead_name: null,
          lead_mobile: null,
          practitioner_key: practitionerKey,
          resource_key: null,
          department_key: null,
          speciality_key: null,
          service_key: null,
          consult_type_key: seedId('mdm-consult-type-key', h.code, n % 3 === 0 ? 'FU' : 'NEW'),
          slot_id: slotId,
          series_id: null,
          slot_start: slotStart,
          slot_end: slotEnd,
          slot_date: businessDate,
          channel: n % 4 === 0 ? 'online' : 'counter',
          status,
          is_tele: false,
          is_overbooked: false,
          overbook_approved_by: null,
          advance_required: null,
          advance_receipt_id: null,
          payment_status: isCancelled ? 'none' : 'paid',
          currency: 'INR',
          rescheduled_from_id: null,
          rescheduled_to_id: null,
          cancel_reason: isCancelled ? 'patient_request' : null,
          cancel_note: isCancelled ? 'Patient could not travel.' : null,
          cancelled_by: null,
          cancelled_at: isCancelled ? seedDate(4, 6) : null,
          no_show_at: isNoShow ? seedDate(4, 14) : null,
          checked_in_at: status === 'completed' ? slotStart : null,
          visit_id: null,
          reminder_sent_at: [seedDate(3, 9), seedDate(4, 7)],
          confirmed_at: seedDate(3, 10),
          booked_by: null,
          booked_at: seedDate(2, 11),
          notes: null,
          idempotency_key: null,
          created_at: SEED_EPOCH,
          created_by: null,
          updated_at: SEED_EPOCH,
          updated_by: null,
          version: 0,
        });

        statusHistory.push({
          id: seedId('appointment-status', h.code, drCode, businessDate, String(n), 'booked'),
          hospital_id: h.id,
          appointment_id: appointmentId,
          from_status: null,
          to_status: 'booked',
          reason: null,
          channel: n % 4 === 0 ? 'online' : 'counter',
          actor_id: null,
          actor_type: n % 4 === 0 ? 'patient' : 'user',
          occurred_at: seedDate(2, 11),
          meta: jsonb({}),
          created_at: SEED_EPOCH,
        });
        statusHistory.push({
          id: seedId('appointment-status', h.code, drCode, businessDate, String(n), 'final'),
          hospital_id: h.id,
          appointment_id: appointmentId,
          from_status: 'booked',
          to_status: status,
          reason: isCancelled ? 'Patient could not travel.' : null,
          channel: 'counter',
          actor_id: null,
          actor_type: isNoShow ? 'system' : 'user',
          occurred_at: seedDate(4, 12),
          meta: jsonb({}),
          created_at: SEED_EPOCH,
        });

        if (status !== 'completed') continue;

        // ── the visit, its token and its receipt ────────────────────────────
        const visitId = seedId('op-visit', h.code, drCode, businessDate, String(n));
        visits.push({
          id: visitId,
          hospital_id: h.id,
          branch_id: branch.id,
          visit_no: `${branch.shortName}/OP/2026/${String(sequence).padStart(6, '0')}`,
          patient_id: patientId,
          appointment_id: appointmentId,
          practitioner_key: practitionerKey,
          department_key: null,
          speciality_key: null,
          consult_type_key: seedId('mdm-consult-type-key', h.code, n % 3 === 0 ? 'FU' : 'NEW'),
          room_key: null,
          visit_type: n % 3 === 0 ? 'follow_up' : 'new',
          payer_type: 'self',
          payer_ref_id: null,
          status: 'closed',
          token_id: seedId('queue-token', h.code, drCode, businessDate, String(n)),
          token_display: `D${drIndex + 1}-${String(n + 1).padStart(3, '0')}`,
          queue_id: queueId,
          vitals_required: true,
          source_channel: n % 4 === 0 ? 'online' : 'counter',
          checked_in_at: slotStart,
          consult_started_at: new Date(slotStart.getTime() + 12 * 60_000),
          consult_ended_at: new Date(slotStart.getTime() + 24 * 60_000),
          closed_at: new Date(slotStart.getTime() + 30 * 60_000),
          cancelled_at: null,
          cancel_reason: null,
          transferred_from_visit_id: null,
          fee_amount: n % 3 === 0 ? '300.00' : '600.00',
          fee_currency: 'INR',
          fee_receipt_id: seedId('payment', h.code, drCode, businessDate, String(n)),
          fee_status: 'paid',
          notes: null,
          idempotency_key: null,
          created_at: SEED_EPOCH,
          created_by: null,
          updated_at: SEED_EPOCH,
          updated_by: null,
          version: 0,
        });

        const tokenId = seedId('queue-token', h.code, drCode, businessDate, String(n));
        const issuedAt = new Date(slotStart.getTime() - 20 * 60_000);
        const senior = syntheticPatient(h.code, patientIndex).isSenior;
        tokens.push({
          id: tokenId,
          hospital_id: h.id,
          branch_id: branch.id,
          queue_id: queueId,
          journey_id: seedId('queue-journey', h.code, 'OPD_STANDARD'),
          stage_key: 'doctor',
          series_date: businessDate,
          token_no: n + 1,
          token_display: `D${drIndex + 1}-${String(n + 1).padStart(3, '0')}`,
          patient_id: patientId,
          visit_id: visitId,
          appointment_id: appointmentId,
          practitioner_key: practitionerKey,
          room_key: null,
          counter_id: null,
          source: n % 4 === 0 ? 'app' : 'desk',
          class: senior ? 'priority_senior' : 'appointment',
          priority_rank: senior ? 70 : 50,
          priority_reason: senior ? 'Senior citizen (age 60+), automatic' : null,
          priority_overridden_by: null,
          status: 'served',
          appointment_due_at: slotStart,
          activated_at: issuedAt,
          called_at: new Date(slotStart.getTime() + 10 * 60_000),
          called_by: null,
          service_start_at: new Date(slotStart.getTime() + 12 * 60_000),
          service_end_at: new Date(slotStart.getTime() + 24 * 60_000),
          est_wait_sec_at_issue: 1_800,
          actual_wait_sec: 1_800,
          skip_count: 0,
          recall_count: n % 11 === 0 ? 1 : 0,
          hold_count: 0,
          transfer_from_token_id: null,
          transfer_to_token_id: null,
          transfer_reason: null,
          cancel_reason: null,
          offline_origin: false,
          offline_block_id: null,
          synced_at: null,
          notes: null,
          idempotency_key: null,
          issued_at: issuedAt,
          issued_by: receptionist?.id ?? null,
          created_at: SEED_EPOCH,
          updated_at: SEED_EPOCH,
          version: 0,
        });

        for (const [suffix, event, at] of [
          ['issued', 'issued', issuedAt],
          ['called', 'called', new Date(slotStart.getTime() + 10 * 60_000)],
          ['served', 'served', new Date(slotStart.getTime() + 24 * 60_000)],
        ] as const) {
          events.push({
            id: seedId('queue-event', h.code, drCode, businessDate, String(n), suffix),
            hospital_id: h.id,
            branch_id: branch.id,
            queue_id: queueId,
            token_id: tokenId,
            token_display: `D${drIndex + 1}-${String(n + 1).padStart(3, '0')}`,
            event,
            from_status: null,
            to_status: event === 'issued' ? 'waiting' : event === 'called' ? 'called' : 'served',
            counter_id: null,
            room_key: null,
            actor_id: receptionist?.id ?? null,
            actor_type: 'user',
            reason: null,
            meta: jsonb({}),
            at,
          });
        }

        const paymentId = seedId('payment', h.code, drCode, businessDate, String(n));
        const paidAt = new Date(slotStart.getTime() - 15 * 60_000);
        const amount = n % 3 === 0 ? '300.00' : '600.00';
        payments.push({
          id: paymentId,
          hospital_id: h.id,
          branch_id: branch.id,
          receipt_no: `${branch.shortName}/RCP/2026/${String(sequence).padStart(6, '0')}`,
          series_key: 'RECEIPT',
          bill_id: null,
          patient_id: patientId,
          visit_id: visitId,
          appointment_id: appointmentId,
          purpose: 'consultation',
          kind: 'payment',
          amount,
          currency: 'INR',
          status: 'confirmed',
          counter_id: counterId,
          shift_id: shiftId,
          cashier_id: cashier?.id ?? null,
          voided_at: null,
          refunded_amount: '0.00',
          payer_name: null,
          remarks: null,
          print_job_id: null,
          idempotency_key: null,
          paid_at: paidAt,
          created_at: SEED_EPOCH,
          created_by: null,
          updated_at: SEED_EPOCH,
          updated_by: null,
          version: 0,
        });

        // OP-001/NC-001: a split payment every fifth receipt, so the split path
        // is exercised rather than assumed.
        if (n % 5 === 0) {
          paymentLines.push(
            paymentLine(
              h.id,
              branch.id,
              seedId('payment-line', h.code, drCode, businessDate, String(n), 'cash'),
              paymentId,
              paidAt,
              'cash',
              '100.00',
              '200.00',
              '100.00',
            ),
            paymentLine(
              h.id,
              branch.id,
              seedId('payment-line', h.code, drCode, businessDate, String(n), 'upi'),
              paymentId,
              paidAt,
              'upi',
              (Number(amount) - 100).toFixed(2),
              null,
              null,
            ),
          );
        } else {
          paymentLines.push(
            paymentLine(
              h.id,
              branch.id,
              seedId('payment-line', h.code, drCode, businessDate, String(n), 'only'),
              paymentId,
              paidAt,
              n % 2 === 0 ? 'cash' : 'upi',
              amount,
              n % 2 === 0 ? '1000.00' : null,
              n % 2 === 0 ? (1000 - Number(amount)).toFixed(2) : null,
            ),
          );
        }

        // ── consent, its ledger entries, and the notice acknowledgement ─────
        if (n % 7 !== 0) continue;
        const consentId = seedId('consent', h.code, drCode, businessDate, String(n));
        consents.push({
          id: consentId,
          hospital_id: h.id,
          branch_id: branch.id,
          patient_id: patientId,
          encounter_id: null,
          consent_type_id: seedId('consent-type', h.code, 'treatment.general'),
          template_version_id: seedId('consent-template-version', h.code, 'treatment.general', 'en-IN'),
          notice_id: seedId('consent-notice', h.code, 'en-IN', 'v1'),
          language: 'en-IN',
          status: 'active',
          granted_by: 'patient',
          grantor_name: null,
          grantor_relationship: null,
          grantor_id_type_code: null,
          grantor_id_last4: null,
          guardian_id: null,
          capacity_basis: null,
          purpose_codes: ['treatment'],
          scope: jsonb({ procedures: ['outpatient_consultation'] }),
          granted_at: paidAt,
          valid_from: paidAt,
          valid_to: null,
          explained_by_user_id: receptionist?.id ?? null,
          explanation_at: paidAt,
          comprehension_check: null,
          interpreter: null,
          witness_user_id: null,
          witness_name: null,
          second_doctor_user_id: null,
          channel: 'desk',
          esign_envelope_id: null,
          document_file_id: null,
          document_sha256: null,
          paper_origin: false,
          scan_file_id: null,
          withdrawn_at: null,
          withdrawn_channel: null,
          withdrawal_reason: null,
          withdrawn_by: null,
          superseded_by_consent_id: null,
          refusal_reason: null,
          created_at: SEED_EPOCH,
          created_by: null,
          updated_at: SEED_EPOCH,
          updated_by: null,
          version: 0,
        });

        for (const [suffix, event] of [
          ['notice', 'notice_shown'],
          ['explained', 'explained'],
          ['granted', 'granted'],
        ] as const) {
          ledger.push({
            id: seedId('consent-ledger', h.code, drCode, businessDate, String(n), suffix),
            hospital_id: h.id,
            patient_id: patientId,
            consent_id: consentId,
            event,
            purpose_code: 'treatment',
            actor_type: event === 'granted' ? 'patient' : 'user',
            actor_id: event === 'granted' ? null : (receptionist?.id ?? null),
            channel: 'desk',
            language: 'en-IN',
            evidence: jsonb({ device: 'registration-desk', scrollCompleted: true, noticeVersion: 1 }),
            notice_id: seedId('consent-notice', h.code, 'en-IN', 'v1'),
            // The chain is sealed by the worker, exactly as `core.audit_log`
            // is: a seeded row is deliberately unsealed so the sealer has work
            // to do and the sealing path is exercised rather than assumed.
            seq: null,
            prev_hash: null,
            row_hash: null,
            sealed_at: null,
            at: paidAt,
          });
        }

        acknowledgements.push({
          id: seedId('consent-ack', h.code, drCode, businessDate, String(n)),
          hospital_id: h.id,
          patient_id: patientId,
          notice_id: seedId('consent-notice', h.code, 'en-IN', 'v1'),
          language: 'en-IN',
          channel: 'desk',
          evidence: jsonb({ scrollCompleted: true, printed: true }),
          acknowledged_by: receptionist?.id ?? null,
          acknowledged_at: paidAt,
          created_at: SEED_EPOCH,
        });

        messages.push({
          id: seedId('msg-message', h.code, drCode, businessDate, String(n)),
          hospital_id: h.id,
          branch_id: branch.id,
          channel: 'sms',
          direction: 'out',
          template_key: 'token_issued',
          template_version_id: seedId('msg-template-version', h.code, 'token_issued', 'en-IN'),
          language: 'en-IN',
          to_e164: syntheticPatient(h.code, patientIndex).mobile,
          from_sender: 'VIMSHL',
          recipient_type: 'patient',
          recipient_id: patientId,
          provider_id: seedId('msg-provider', h.code, 'msg91', 'sms'),
          provider_msg_id: `demo-${seedId('msg-message', h.code, drCode, businessDate, String(n)).slice(0, 12)}`,
          class: 'transactional',
          category: 'transactional',
          module: 'EN-006',
          ref_type: 'queue.token',
          ref_id: tokenId,
          campaign_id: null,
          conversation_id: null,
          // EN-009 §5: rendered bodies are encrypted and purged at 90 days. A
          // seed writes none — there is no lawful reason for demo data to hold
          // a rendered message body, and a null here is the honest state after
          // the purge job has run.
          body_rendered: null,
          vars_hash: null,
          dedupe_key: `token_issued|${patientId}|${tokenId}`,
          status: 'delivered',
          error_code: null,
          error_text: null,
          attempts: 1,
          fallback_of_id: null,
          segments: 1,
          cost_amount: '0.16',
          cost_currency: 'INR',
          scheduled_at: null,
          sent_at: issuedAt,
          delivered_at: new Date(issuedAt.getTime() + 4_000),
          read_at: null,
          failed_at: null,
          next_attempt_at: null,
          idempotency_key: null,
          correlation_id: null,
          created_at: issuedAt,
          created_by: null,
          updated_at: SEED_EPOCH,
        });
      }
    });

    // ── close the shift, with a zero variance and a balanced sheet ──────────
    const cashCollected = paymentLines
      .filter((row) => row['mode'] === 'cash')
      .reduce((sum, row) => sum + Number(row['amount']), 0);
    const upiCollected = paymentLines
      .filter((row) => row['mode'] === 'upi')
      .reduce((sum, row) => sum + Number(row['amount']), 0);
    const openingFloat = 2_000;
    const expectedCash = openingFloat + cashCollected;

    shifts.push({
      id: shiftId,
      hospital_id: h.id,
      branch_id: branch.id,
      counter_id: counterId,
      cashier_user_id: cashier?.id ?? h.id,
      business_date: businessDate,
      opened_at: seedDate(4, 3),
      closed_at: seedDate(4, 15),
      status: 'closed',
      opening_float: openingFloat.toFixed(2),
      float_source: 'main_cash',
      previous_shift_id: null,
      currency: 'INR',
      expected_cash: expectedCash.toFixed(2),
      counted_cash: expectedCash.toFixed(2),
      // `phase-01` exit gate 5: "closes with a variance of zero, and the
      // denomination sheet balances."
      variance: '0.00',
      variance_reason: null,
      variance_approved_by: null,
      variance_approval_id: null,
      handover_to: 'main_cash',
      handover_bag_no: `BAG/${businessDate}/01`,
      handover_received_by: null,
      receipts_count: payments.length,
      voids_count: 0,
      refunds_count: 0,
      is_night: false,
      is_system_shift: false,
      closed_by: cashier?.id ?? null,
      z_report_file_id: null,
      created_at: SEED_EPOCH,
      created_by: null,
      updated_at: SEED_EPOCH,
      updated_by: null,
      version: 0,
    });

    for (const [mode, collections] of [
      ['cash', cashCollected],
      ['upi', upiCollected],
    ] as const) {
      shiftTotals.push({
        id: seedId('cash-shift-total', h.code, businessDate, mode),
        hospital_id: h.id,
        shift_id: shiftId,
        mode,
        collections: collections.toFixed(2),
        refunds: '0.00',
        advances: '0.00',
        voids: '0.00',
        count: paymentLines.filter((row) => row['mode'] === mode).length,
        pending_confirmation_amount: '0.00',
        currency: 'INR',
        created_at: SEED_EPOCH,
        updated_at: SEED_EPOCH,
      });
    }

    denominations.push(
      denominationSheet(
        h.id,
        branch.id,
        seedId('denomination', h.code, businessDate, 'opening'),
        shiftId,
        'opening',
        openingFloat,
        cashier?.id ?? h.id,
      ),
      denominationSheet(
        h.id,
        branch.id,
        seedId('denomination', h.code, businessDate, 'closing'),
        shiftId,
        'closing',
        expectedCash,
        cashier?.id ?? h.id,
      ),
    );

    await ctx.write({ table: 'clinical.schedule_slots', conflict: ['id'] }, slots);
    await ctx.write({ table: 'clinical.appointments', conflict: ['id'] }, appointments);
    await ctx.write({ table: 'clinical.appointment_status_history', conflict: ['id'] }, statusHistory);
    await ctx.write({ table: 'clinical.op_visits', conflict: ['id'] }, visits);
    await ctx.write({ table: 'queue.queue_token_series', conflict: ['id'] }, series);
    await ctx.write({ table: 'queue.queue_offline_blocks', conflict: ['id'] }, offlineBlocks);
    await ctx.write({ table: 'queue.queue_tokens', conflict: ['id', 'issued_at'] }, tokens);
    await ctx.write({ table: 'queue.queue_events', conflict: ['id', 'at'] }, events);
    await ctx.write({ table: 'billing.cash_shifts', conflict: ['id'] }, shifts);
    await ctx.write({ table: 'billing.payments', conflict: ['id', 'paid_at'] }, payments);
    await ctx.write({ table: 'billing.payment_lines', conflict: ['id'] }, paymentLines);
    await ctx.write({ table: 'billing.cash_shift_totals', conflict: ['id'] }, shiftTotals);
    await ctx.write({ table: 'billing.cash_denomination_sheets', conflict: ['id'] }, denominations);
    await ctx.write({ table: 'patient.consents', conflict: ['id'] }, consents);
    await ctx.write({ table: 'patient.consent_ledger', conflict: ['id', 'at'] }, ledger);
    await ctx.write({ table: 'patient.consent_notice_acknowledgements', conflict: ['id'] }, acknowledgements);
    await ctx.write({ table: 'engage.msg_messages', conflict: ['id', 'created_at'] }, messages);
  }
}

function paymentLine(
  hospitalId: string,
  branchId: string,
  id: string,
  paymentId: string,
  paidAt: Date,
  mode: string,
  amount: string,
  tendered: string | null,
  change: string | null,
): SeedRow {
  return {
    id,
    hospital_id: hospitalId,
    branch_id: branchId,
    payment_id: paymentId,
    payment_paid_at: paidAt,
    mode,
    amount,
    currency: 'INR',
    tendered,
    change_given: change,
    reference: mode === 'upi' ? `UTR${id.slice(0, 12).toUpperCase()}` : null,
    gateway_txn_id: null,
    card_last4: null,
    card_network: null,
    bank: null,
    cheque_date: null,
    status: 'confirmed',
    confirmed_at: paidAt,
    settled_at: null,
    settlement_batch_id: null,
    fx_currency: null,
    fx_amount: null,
    fx_rate: null,
    encashment_cert_no: null,
    created_at: SEED_EPOCH,
    created_by: null,
    updated_at: SEED_EPOCH,
    version: 0,
  };
}

/**
 * A denomination sheet whose lines actually add up to its total. NC-001 §5
 * requires the sheet total to equal the counted cash, so a seed whose sheet did
 * not balance would model an unclosable shift.
 */
function denominationSheet(
  hospitalId: string,
  branchId: string,
  id: string,
  shiftId: string,
  kind: string,
  total: number,
  countedBy: string,
): SeedRow {
  const denominations = [500, 200, 100, 50, 20, 10];
  const lines: { denom: number; count: number; amount: number }[] = [];
  let remaining = Math.round(total);
  for (const denom of denominations) {
    const count = Math.floor(remaining / denom);
    if (count > 0) {
      lines.push({ denom, count, amount: denom * count });
      remaining -= denom * count;
    }
  }
  if (remaining > 0) lines.push({ denom: 1, count: remaining, amount: remaining });

  return {
    id,
    hospital_id: hospitalId,
    branch_id: branchId,
    shift_id: shiftId,
    kind,
    currency: 'INR',
    lines: jsonb(lines),
    total: lines.reduce((sum, line) => sum + line.amount, 0).toFixed(2),
    counted_by: countedBy,
    witnessed_by: null,
    counted_at: SEED_EPOCH,
    created_at: SEED_EPOCH,
    created_by: null,
  };
}
