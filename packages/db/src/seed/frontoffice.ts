import { createHash } from 'node:crypto';
import type { SeedContext } from './context.js';
import { SEED_EPOCH, seedId } from './ids.js';
import { jsonb, type SeedRow } from './upsert.js';
import { mainBranchOf, type SeededTenancy } from './tenancy.js';
import { demoUsers } from './users.js';

/**
 * Phase-1 configuration: everything a front office needs in place before the
 * first patient walks in, and nothing that is activity.
 *
 * Seeded from the `demo` tier upward, alongside `seedModuleConfiguration` —
 * `minimal` deliberately stays at tenancy, roles, users and numbering, because
 * that tier exists to prove a tenant can be provisioned from nothing.
 */
export async function seedFrontOffice(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  await seedSchedules(ctx, tenancy);
  await seedQueues(ctx, tenancy);
  await seedCounters(ctx, tenancy);
  await seedConsent(ctx, tenancy);
  await seedMessaging(ctx, tenancy);
  await seedAbdm(ctx, tenancy);
}

const PRACTITIONER_CODES = [
  'DR001', 'DR002', 'DR003', 'DR004', 'DR005',
  'DR006', 'DR007', 'DR008', 'DR009', 'DR010',
] as const;

/** DR code → speciality, so a template inherits the right consult types. */
const PRACTITIONER_SPECIALITY: Readonly<Record<string, string>> = {
  DR001: 'GENMED', DR002: 'ORTHO', DR003: 'ORTHO', DR004: 'OBGYN', DR005: 'GENSURG',
  DR006: 'PAED', DR007: 'CARDIO', DR008: 'DERMA', DR009: 'TRAUMA', DR010: 'PHYSIO',
};

// ── doctor schedules (OP-001 §3.6) ──────────────────────────────────────────

async function seedSchedules(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const templates: SeedRow[] = [];

  for (const h of tenancy.hospitals) {
    const branch = mainBranchOf(h);
    PRACTITIONER_CODES.forEach((code, index) => {
      const speciality = PRACTITIONER_SPECIALITY[code] ?? 'GENMED';
      // Monday–Saturday morning clinics, plus an evening clinic on alternate
      // days. Six weekdays because Indian OPDs run on Saturday, and because a
      // Monday-to-Friday seed hides every "is the clinic open?" bug.
      for (let weekday = 1; weekday <= 6; weekday += 1) {
        const evening = (weekday + index) % 2 === 0;
        templates.push({
          id: seedId('schedule-template', h.code, code, String(weekday), 'am'),
          hospital_id: h.id,
          branch_id: branch.id,
          practitioner_key: seedId('mdm-practitioner-key', h.code, code),
          room_key: seedId('mdm-room-key', h.code, branch.code, `OPD-10${(index % 4) + 1}`),
          department_key: null,
          speciality_key: seedId('mdm-speciality-key', h.code, speciality),
          weekday,
          start_time: '09:00:00',
          end_time: '13:00:00',
          slot_minutes: 15,
          capacity_per_slot: 2,
          overbook_allowance: 1,
          buffer_minutes: 0,
          consult_type_keys: [
            seedId('mdm-consult-type-key', h.code, 'NEW'),
            seedId('mdm-consult-type-key', h.code, 'FU'),
            seedId('mdm-consult-type-key', h.code, 'FREE_REVIEW'),
          ],
          // OP-001 §3.4.1: the website may take 60 % of a slot block; four
          // places a session are held back for walk-ins, which is what makes
          // the interleave rule in EN-006 §3.1 testable.
          online_quota_pct: 60,
          walkin_reserve: 4,
          online_booking_window_days: 30,
          max_walkins: 20,
          vitals_required: true,
          tele_enabled: speciality !== 'TRAUMA',
          version: 1,
          status: 'published',
          effective_from: '2026-01-01',
          effective_to: null,
          published_at: SEED_EPOCH,
          published_by: null,
          superseded_by_id: null,
          created_at: SEED_EPOCH,
          created_by: null,
          updated_at: SEED_EPOCH,
          updated_by: null,
          deleted_at: null,
        });

        if (!evening) continue;
        templates.push({
          id: seedId('schedule-template', h.code, code, String(weekday), 'pm'),
          hospital_id: h.id,
          branch_id: branch.id,
          practitioner_key: seedId('mdm-practitioner-key', h.code, code),
          room_key: seedId('mdm-room-key', h.code, branch.code, `OPD-10${(index % 4) + 1}`),
          department_key: null,
          speciality_key: seedId('mdm-speciality-key', h.code, speciality),
          weekday,
          start_time: '17:00:00',
          end_time: '20:00:00',
          slot_minutes: 15,
          capacity_per_slot: 2,
          overbook_allowance: 0,
          buffer_minutes: 0,
          consult_type_keys: [
            seedId('mdm-consult-type-key', h.code, 'NEW'),
            seedId('mdm-consult-type-key', h.code, 'FU'),
          ],
          online_quota_pct: 40,
          walkin_reserve: 2,
          online_booking_window_days: 14,
          max_walkins: 10,
          vitals_required: true,
          tele_enabled: false,
          version: 1,
          status: 'published',
          effective_from: '2026-01-01',
          effective_to: null,
          published_at: SEED_EPOCH,
          published_by: null,
          superseded_by_id: null,
          created_at: SEED_EPOCH,
          created_by: null,
          updated_at: SEED_EPOCH,
          updated_by: null,
          deleted_at: null,
        });
      }
    });
  }

  await ctx.write({ table: 'clinical.doctor_schedule_templates', conflict: ['id'] }, templates);
}

// ── queues (EN-006 §3.1) ────────────────────────────────────────────────────

/**
 * EN-006 §5 priority weights, verbatim: "emergency 100, appointment on time 50,
 * senior/disabled/pregnant +20, staff +10, walk-in 0; FIFO within weight",
 * plus the fairness cap that stops a run of priority tokens starving everyone
 * else — "after 3 consecutive priority calls serve 1 regular".
 */
const PRIORITY_RULES = {
  weights: {
    priority_emergency: 100,
    appointment: 50,
    priority_senior: 20,
    priority_pregnant: 20,
    priority_disabled: 20,
    priority_infant: 20,
    priority_vip: 15,
    priority_staff: 10,
    regular: 0,
  },
  fairness: { afterConsecutivePriority: 3, serveRegular: 1 },
  maxOrdinaryWaitMinutes: 90,
} as const;

const SKIP_POLICY = { returnAfter: 3, maxSkips: 2, reviveSameDay: true } as const;

async function seedQueues(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const queues: SeedRow[] = [];
  const journeys: SeedRow[] = [];
  const counters: SeedRow[] = [];

  for (const h of tenancy.hospitals) {
    const branch = mainBranchOf(h);

    journeys.push({
      id: seedId('queue-journey', h.code, 'OPD_STANDARD'),
      hospital_id: h.id,
      branch_id: null,
      code: 'OPD_STANDARD',
      name: 'Standard OPD journey',
      // EN-006 §3.1.2: registration → vitals → doctor → (pharmacy/cash).
      stages: jsonb([
        { stageKey: 'registration', queueSelector: { code: 'REG' }, autoForward: true },
        { stageKey: 'vitals', queueSelector: { code: 'VITALS' }, autoForward: true },
        { stageKey: 'doctor', queueSelector: { kind: 'doctor' }, autoForward: false },
        { stageKey: 'cash', queueSelector: { code: 'CASH' }, autoForward: false },
      ]),
      applies_to: jsonb({ visitTypes: ['new', 'follow_up'], departments: ['*'] }),
      active: true,
      version: 0,
      created_at: SEED_EPOCH,
      created_by: null,
      updated_at: SEED_EPOCH,
      deleted_at: null,
    });

    const shared: readonly (readonly [string, string, string, string, string, number])[] = [
      ['REG', 'Registration desks', 'counter_pool', 'R', 'registration', 180],
      ['VITALS', 'Vitals room', 'stage', 'V', 'vitals', 240],
      ['CASH', 'Cash counters', 'counter_pool', 'C', 'cash', 150],
      ['SAMPLE', 'Sample collection', 'stage', 'L', 'sample', 300],
    ];

    for (const [code, name, kind, prefix, stageKey, avgSec] of shared) {
      queues.push(queueRow(h.id, branch.id, h.code, branch.code, code, name, kind, prefix, stageKey, avgSec, null));
    }

    // One queue per doctor, which is what OP-001 §16 Q6 defaults to and what
    // the TV board and the doctor dashboard both key off.
    PRACTITIONER_CODES.forEach((drCode, index) => {
      queues.push(
        queueRow(
          h.id, branch.id, h.code, branch.code,
          `DR-${drCode}`, `Dr. queue ${drCode}`, 'doctor', `D${index + 1}`, 'doctor', 600,
          seedId('mdm-practitioner-key', h.code, drCode),
        ),
      );
    });

    for (const [queueCode, counterCode, display] of [
      ['REG', 'REG-1', 'Reg 1'],
      ['REG', 'REG-2', 'Reg 2'],
      ['CASH', 'CASH-1', 'Counter 1'],
      ['CASH', 'CASH-2', 'Counter 2'],
      ['VITALS', 'VITALS-1', 'Vitals'],
    ] as const) {
      counters.push({
        id: seedId('queue-counter', h.code, branch.code, counterCode),
        hospital_id: h.id,
        branch_id: branch.id,
        queue_id: seedId('queue-definition', h.code, branch.code, queueCode),
        code: counterCode,
        name: `${display} — ${branch.shortName}`,
        display_name: display,
        location: 'Ground floor, Block A',
        room_key: null,
        workstation_id: null,
        status: 'closed',
        current_user_id: null,
        current_token_id: null,
        opened_at: null,
        closed_at: null,
        consecutive_priority_calls: 0,
        active: true,
        created_at: SEED_EPOCH,
        created_by: null,
        updated_at: SEED_EPOCH,
        deleted_at: null,
        version: 0,
      });
    }
  }

  await ctx.write({ table: 'queue.queue_definitions', conflict: ['id'] }, queues);
  await ctx.write({ table: 'queue.queue_journeys', conflict: ['id'] }, journeys);
  await ctx.write({ table: 'queue.queue_counters', conflict: ['id'] }, counters);
}

function queueRow(
  hospitalId: string,
  branchId: string,
  hospitalCode: string,
  branchCode: string,
  code: string,
  name: string,
  kind: string,
  prefix: string,
  stageKey: string,
  avgServiceSec: number,
  practitionerKey: string | null,
): SeedRow {
  return {
    id: seedId('queue-definition', hospitalCode, branchCode, code),
    hospital_id: hospitalId,
    branch_id: branchId,
    code,
    name,
    kind,
    stage_key: stageKey,
    department_key: null,
    practitioner_key: practitionerKey,
    room_key: null,
    service_key: null,
    member_refs: jsonb({}),
    series_prefix: prefix,
    series_scope: kind === 'doctor' ? 'per_doctor' : 'per_queue',
    number_width: 3,
    reset_time: '00:00:00',
    start_number: 1,
    calling_mode: kind === 'counter_pool' ? 'auto_assign' : 'call_next',
    avg_service_sec_seed: avgServiceSec,
    max_length: null,
    priority_rules: jsonb(PRIORITY_RULES),
    fairness_cap: 3,
    appt_walkin_ratio: '2:1',
    appt_tolerance_min: 15,
    skip_policy: jsonb(SKIP_POLICY),
    // DPDP + EN-006 §5: the default is token and initial only. Full names on a
    // lobby screen require an admin to change this deliberately.
    display_config: jsonb({
      maskMode: 'initial',
      languages: ['en-IN', 'kn'],
      ttsVoice: null,
      showNext: 3,
    }),
    hours_source: 'schedule',
    fixed_hours: null,
    allow_unpaid: kind !== 'doctor',
    // EN-006 §3.6: numbers from 900 are the offline block, which is why
    // `queue_token_series.offline_reserved_from` defaults to the same figure.
    offline_block_size: 100,
    active: true,
    version: 0,
    created_at: SEED_EPOCH,
    created_by: null,
    updated_at: SEED_EPOCH,
    updated_by: null,
    deleted_at: null,
  };
}

// ── registration desks, kiosks and cash counters ────────────────────────────

async function seedCounters(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const registration: SeedRow[] = [];
  const kiosks: SeedRow[] = [];
  const cashCounters: SeedRow[] = [];
  const assignments: SeedRow[] = [];
  const users = demoUsers(tenancy);

  for (const h of tenancy.hospitals) {
    const branch = mainBranchOf(h);
    const cashier = users.find((u) => u.hospital.code === h.code && u.roleKey === 'cashier');
    const receptionist = users.find((u) => u.hospital.code === h.code && u.roleKey === 'receptionist');

    for (const [code, name] of [['REG-1', 'Registration Desk 1'], ['REG-2', 'Registration Desk 2']] as const) {
      registration.push({
        id: seedId('registration-counter', h.code, branch.code, code),
        hospital_id: h.id,
        branch_id: branch.id,
        code,
        name,
        location: 'Ground floor, Block A',
        room_key: null,
        workstation_id: null,
        card_printer_id: null,
        slip_printer_id: null,
        cash_counter_id: seedId('cash-counter', h.code, branch.code, code === 'REG-1' ? 'CASH-1' : 'CASH-2'),
        queue_id: seedId('queue-definition', h.code, branch.code, 'REG'),
        offline_block_size: 100,
        is_active: true,
        created_at: SEED_EPOCH,
        created_by: null,
        updated_at: SEED_EPOCH,
        updated_by: null,
        deleted_at: null,
        version: 0,
      });
    }

    kiosks.push({
      id: seedId('kiosk-device', h.code, branch.code, 'KIOSK-1'),
      hospital_id: h.id,
      branch_id: branch.id,
      code: 'KIOSK-1',
      name: 'Lobby self-service kiosk',
      location: 'Main lobby, near entrance',
      // Unpaired: a device token is issued at pairing time, never seeded. A
      // seeded credential is a credential that reaches production.
      device_token_hash: null,
      token_issued_at: null,
      token_expires_at: null,
      printer_id: null,
      scanner_profile_id: null,
      languages: ['en-IN', 'hi', 'kn'],
      capabilities: ['register', 'checkin'],
      idle_reset_seconds: 60,
      status: 'unpaired',
      last_heartbeat_at: null,
      app_version: null,
      created_at: SEED_EPOCH,
      created_by: null,
      updated_at: SEED_EPOCH,
      deleted_at: null,
      version: 0,
    });

    for (const [code, name, type, modes] of [
      ['CASH-1', 'Cash Counter 1', 'general', ['cash', 'card', 'upi', 'netbanking', 'cheque']],
      ['CASH-2', 'Cash Counter 2', 'general', ['cash', 'card', 'upi']],
      ['CASH-NIGHT', 'Night Counter', 'er_night', ['cash', 'upi']],
      ['CASH-ONLINE', 'Online collections', 'online_virtual', ['gateway_link', 'upi', 'card']],
    ] as const) {
      cashCounters.push({
        id: seedId('cash-counter', h.code, branch.code, code),
        hospital_id: h.id,
        branch_id: branch.id,
        code,
        name,
        location: type === 'online_virtual' ? null : 'Ground floor, Block A',
        counter_type: type,
        allowed_modes: modes,
        allowed_doc_types: ['receipt', 'advance', 'refund'],
        float_limit: type === 'online_virtual' ? '0.00' : '5000.00',
        // NC-001 §5: past this, the cashier is prompted to drop to main cash.
        drawer_alert_limit: type === 'online_virtual' ? '0.00' : '50000.00',
        currency: 'INR',
        receipt_series_key: 'RECEIPT',
        printer_profile_id: null,
        drawer_profile: jsonb(type === 'online_virtual' ? {} : { kick: 'escpos', pin: 2 }),
        upi_display_device_id: null,
        pos_terminal_id: null,
        department_key: null,
        is_virtual: type === 'online_virtual',
        is_active: true,
        created_at: SEED_EPOCH,
        created_by: null,
        updated_at: SEED_EPOCH,
        updated_by: null,
        deleted_at: null,
        version: 0,
      });
    }

    if (cashier !== undefined) {
      assignments.push({
        id: seedId('cash-counter-assignment', h.code, branch.code, 'CASH-1', cashier.roleKey),
        hospital_id: h.id,
        branch_id: branch.id,
        counter_id: seedId('cash-counter', h.code, branch.code, 'CASH-1'),
        user_id: cashier.id,
        valid_from: SEED_EPOCH,
        valid_to: null,
        shift_template_id: null,
        assigned_by: null,
        is_supervisor: false,
        created_at: SEED_EPOCH,
        created_by: null,
        updated_at: SEED_EPOCH,
        version: 0,
      });
    }
    if (receptionist !== undefined) {
      assignments.push({
        id: seedId('cash-counter-assignment', h.code, branch.code, 'CASH-2', receptionist.roleKey),
        hospital_id: h.id,
        branch_id: branch.id,
        counter_id: seedId('cash-counter', h.code, branch.code, 'CASH-2'),
        user_id: receptionist.id,
        valid_from: SEED_EPOCH,
        valid_to: null,
        shift_template_id: null,
        assigned_by: null,
        is_supervisor: false,
        created_at: SEED_EPOCH,
        created_by: null,
        updated_at: SEED_EPOCH,
        version: 0,
      });
    }
  }

  await ctx.write({ table: 'clinical.registration_counters', conflict: ['id'] }, registration);
  await ctx.write({ table: 'clinical.kiosk_devices', conflict: ['id'] }, kiosks);
  await ctx.write({ table: 'billing.cash_counters', conflict: ['id'] }, cashCounters);
  await ctx.write({ table: 'billing.cash_counter_assignments', conflict: ['id'] }, assignments);
}

// ── consent (EN-028) ────────────────────────────────────────────────────────

/** key, name, category, validity, days, guardian allowed, gates. */
const CONSENT_TYPES: readonly (readonly [string, string, string, string, number | null, boolean, readonly string[]])[] = [
  ['dpdp.notice', 'DPDP privacy notice acknowledgement', 'data', 'permanent', null, true, []],
  ['treatment.general', 'General consent to treatment', 'clinical', 'episode', null, true, ['visit.create']],
  ['comms.service', 'Service communication (appointments, reports, receipts)', 'data', 'duration', 1095, true, []],
  ['comms.marketing', 'Marketing communication', 'data', 'duration', 365, false, ['messaging.marketing.send']],
  ['abdm.share', 'ABDM health-record sharing', 'data', 'duration', 365, true, ['abdm.care_context.link']],
  ['photo.capture', 'Photograph and identity capture', 'administrative', 'permanent', null, true, []],
];

async function seedConsent(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const types: SeedRow[] = [];
  const templates: SeedRow[] = [];
  const versions: SeedRow[] = [];
  const notices: SeedRow[] = [];

  for (const h of tenancy.hospitals) {
    for (const [key, name, category, validity, days, guardianAllowed, gates] of CONSENT_TYPES) {
      const typeId = seedId('consent-type', h.code, key);
      types.push({
        id: typeId,
        hospital_id: h.id,
        key,
        name,
        category,
        statutory_basis: category === 'data'
          ? 'Digital Personal Data Protection Act 2023, s.6 read with DPDP Rules 2025'
          : 'Indian Contract Act 1872 s.13; NABH 5th ed. PRE.3',
        requires_witness: false,
        requires_counselling: false,
        requires_second_doctor: false,
        guardian_allowed: guardianAllowed,
        emergency_override_allowed: key === 'treatment.general',
        validity,
        validity_days: days,
        renewal_rule: days === null ? null : 'prompt_at_90_percent',
        gates: [...gates],
        required_fields: jsonb({}),
        required_attachments: jsonb([]),
        min_age_self_consent: 18,
        // DPDP Rules 2025 set 18; the MTP Act, the HIV Act 2017 (s.2(m): 12 for
        // testing) and POCSO each carve out a different age, and they are data
        // because they differ by statute and change by amendment.
        age_exceptions: jsonb(
          key === 'treatment.general'
            ? { hivTesting: 12, mtp: 18, pocsoReporting: 18 }
            : {},
        ),
        dpdp_purpose_code: category === 'data' ? key : null,
        abdm_purpose_code: key === 'abdm.share' ? 'CAREMGT' : null,
        active: true,
        created_at: SEED_EPOCH,
        created_by: null,
        updated_at: SEED_EPOCH,
        updated_by: null,
        deleted_at: null,
        version: 0,
      });

      const templateId = seedId('consent-template', h.code, key);
      templates.push({
        id: templateId,
        hospital_id: h.id,
        consent_type_id: typeId,
        key: `${key}.default`,
        name: `${name} — default template`,
        owner_role: category === 'data' ? 'privacy_officer' : 'medical_superintendent',
        status: 'active',
        created_at: SEED_EPOCH,
        created_by: null,
        updated_at: SEED_EPOCH,
        deleted_at: null,
        version: 0,
      });

      // OP-001 §14 AC-17: the notice and the consent must print in the
      // patient's language, so every seeded template exists in the three
      // languages the demo tenant has enabled.
      for (const language of ['en-IN', 'hi', 'kn'] as const) {
        versions.push({
          id: seedId('consent-template-version', h.code, key, language),
          hospital_id: h.id,
          template_id: templateId,
          version: 1,
          language,
          body_blocks: jsonb([
            { type: 'heading', text: name },
            { type: 'paragraph', key: `consent.${key}.body` },
            { type: 'declaration', key: `consent.${key}.declaration` },
          ]),
          risks: jsonb([]),
          benefits: jsonb([]),
          alternatives: jsonb([]),
          declaration_text: `I confirm that the contents of this form have been explained to me in ${language} and that I understand them.`,
          signature_blocks: jsonb([{ role: 'patient', required: true }, { role: 'staff', required: true }]),
          audio_file_id: null,
          translation_status: language === 'en-IN' ? 'approved' : 'reviewed',
          approved_by_clinical: null,
          approved_by_legal: null,
          approved_at: SEED_EPOCH,
          effective_from: SEED_EPOCH,
          effective_to: null,
          status: 'published',
          sha256: null,
          created_at: SEED_EPOCH,
          created_by: null,
          updated_at: SEED_EPOCH,
        });
      }
    }

    for (const language of ['en-IN', 'hi', 'kn'] as const) {
      notices.push({
        id: seedId('consent-notice', h.code, language, 'v1'),
        hospital_id: h.id,
        version: 1,
        language,
        title: 'How we use your personal and health data',
        body_text:
          `${h.displayName} collects and processes your personal and health data to provide care, to raise and settle bills, ` +
          'to meet statutory obligations under the Clinical Establishments Act and the Drugs and Cosmetics Rules, and to ' +
          'communicate with you about your care. You may withdraw consent for optional purposes at any time through the ' +
          'patient portal or at any registration desk, without affecting your right to treatment.',
        itemised_purposes: jsonb([
          { code: 'treatment', label: 'Providing clinical care', lawfulBasis: 'consent', optional: false },
          { code: 'billing', label: 'Billing, insurance and claims', lawfulBasis: 'legitimate_use', optional: false },
          { code: 'statutory', label: 'Statutory registers and notifiable disease reporting', lawfulBasis: 'legal_obligation', optional: false },
          { code: 'communication', label: 'Appointment, report and receipt messages', lawfulBasis: 'consent', optional: true },
          { code: 'marketing', label: 'Health camps, packages and offers', lawfulBasis: 'consent', optional: true },
          { code: 'research', label: 'De-identified research and quality improvement', lawfulBasis: 'consent', optional: true },
        ]),
        retention_statement:
          'Clinical records are retained for 8 years from the last encounter; a minor\'s record until 3 years past majority; ' +
          'medico-legal records for the life of the case. Financial records are retained for 8 years under the GST and ' +
          'Income-tax Acts. Consent records are retained with the clinical record and are not erased by a withdrawal request.',
        recipients: jsonb([
          { category: 'insurers_and_tpas', purpose: 'claims', onlyWithConsent: true },
          { category: 'abdm_health_locker', purpose: 'record_sharing', onlyWithConsent: true },
          { category: 'government_registries', purpose: 'statutory_reporting', onlyWithConsent: false },
          { category: 'referring_practitioner', purpose: 'continuity_of_care', onlyWithConsent: true },
        ]),
        dpo_contact: jsonb({ name: 'Demo DPO', email: 'dpo@demo.vims.local', phone: '+918000000001' }),
        grievance_process:
          'Write to the Grievance Officer at grievance@demo.vims.local. A response is due within 30 days. ' +
          'If unresolved you may escalate to the Data Protection Board of India.',
        rights_summary:
          'You may ask for access to your data, correction of what is wrong, erasure where the law permits, ' +
          'nomination of another person to act for you, and redress of a grievance.',
        cross_border_statement:
          'Your data is stored in India. It is not transferred outside India except where the Central Government permits.',
        effective_from: SEED_EPOCH,
        effective_to: null,
        approved_by: null,
        approved_at: SEED_EPOCH,
        sha256: null,
        status: 'active',
        created_at: SEED_EPOCH,
        created_by: null,
        updated_at: SEED_EPOCH,
      });
    }
  }

  await ctx.write({ table: 'patient.consent_types', conflict: ['id'] }, types);
  await ctx.write({ table: 'patient.consent_templates', conflict: ['id'] }, templates);
  await ctx.write({ table: 'patient.consent_template_versions', conflict: ['id'] }, versions);
  await ctx.write({ table: 'patient.consent_notices', conflict: ['id'] }, notices);
}

// ── messaging (EN-009) ──────────────────────────────────────────────────────

/**
 * EN-009 §4.1's seeded catalogue, narrowed to what Phase 1 actually fires.
 * key, name, channel, category, class, owner module, event, body.
 */
const MSG_TEMPLATES: readonly (readonly [string, string, string, string, string, string, string, string])[] = [
  ['otp_login', 'Login OTP', 'sms', 'authentication', 'critical', 'EN-007', 'auth.otp.requested',
    '{#var#} is your {#var#} verification code. Valid for {#var#} minutes. Do not share it with anyone.'],
  ['patient_registered', 'Welcome and UHID', 'whatsapp', 'utility', 'transactional', 'OP-001', 'patient.registered',
    'Welcome to {#var#}, {#var#}. Your UHID is {#var#}. Please carry it on every visit.'],
  ['appointment_confirmed', 'Appointment confirmed', 'whatsapp', 'utility', 'transactional', 'OP-001', 'appointment.booked',
    'Appointment confirmed: {#var#} with {#var#} on {#var#} at {#var#}, {#var#}. Reply CANCEL to cancel. {#var#}'],
  ['appointment_reminder_24h', 'Appointment reminder (24 h)', 'whatsapp', 'utility', 'transactional', 'OP-001', 'appointment.reminder.24h',
    'Reminder: your appointment with {#var#} is tomorrow at {#var#}, {#var#}. {#var#}'],
  ['appointment_reminder_2h', 'Appointment reminder (2 h)', 'sms', 'transactional', 'transactional', 'OP-001', 'appointment.reminder.2h',
    'Your appointment with {#var#} is at {#var#} today. Please arrive 15 minutes early. {#var#}'],
  ['appointment_cancelled', 'Appointment cancelled', 'whatsapp', 'utility', 'transactional', 'OP-001', 'appointment.cancelled',
    'Your appointment with {#var#} on {#var#} has been cancelled. To rebook, visit {#var#}.'],
  ['appointment_rescheduled', 'Appointment rescheduled', 'whatsapp', 'utility', 'transactional', 'OP-001', 'appointment.rescheduled',
    'Your appointment with {#var#} has moved to {#var#} at {#var#}. {#var#}'],
  ['token_issued', 'Token issued', 'sms', 'transactional', 'transactional', 'EN-006', 'queue.token.issued',
    'Token {#var#} for {#var#}. Approximate wait {#var#} minutes. Track live: {#var#}'],
  ['queue_called', 'Your turn', 'whatsapp', 'utility', 'transactional', 'EN-006', 'queue.token.called',
    'Token {#var#}: please proceed to {#var#} now.'],
  ['receipt_issued', 'Payment receipt', 'whatsapp', 'utility', 'transactional', 'NC-001', 'payment.captured',
    'Received {#var#} at {#var#}. Receipt no {#var#}. Thank you.'],
  ['refund_processed', 'Refund processed', 'sms', 'transactional', 'transactional', 'NC-001', 'billing.refund.processed',
    'Refund of {#var#} against receipt {#var#} has been processed. Reference {#var#}.'],
  ['waitlist_offer', 'Waitlist slot offered', 'whatsapp', 'utility', 'transactional', 'OP-001', 'appointment.waitlist.offered',
    'A slot with {#var#} is free on {#var#} at {#var#}. Accept within 30 minutes: {#var#}'],
  ['abha_linked', 'ABHA linked', 'sms', 'transactional', 'transactional', 'EN-011', 'patient.abha.linked',
    'Your ABHA {#var#} is now linked to your record at {#var#}.'],
  ['camp_invite', 'Health camp invitation', 'whatsapp', 'marketing', 'promotional', 'NC-026', 'campaign.dispatch',
    'Hello {#var#}, join our free {#var#} camp on {#var#}. Register: {#var#}'],
];

async function seedMessaging(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const providers: SeedRow[] = [];
  const dltTemplates: SeedRow[] = [];
  const templates: SeedRow[] = [];
  const versions: SeedRow[] = [];
  const whitelist: SeedRow[] = [];
  const triggers: SeedRow[] = [];
  // `msg_template_versions_approval` requires an approver on every active
  // version: a DLT-registered template that nobody signed off is a message the
  // hospital cannot account for to TRAI. The seed names the marketing/CRM
  // owner rather than leaving it null and the constraint unsatisfied.
  const users = demoUsers(tenancy);

  for (const h of tenancy.hospitals) {
    const approver =
      users.find((u) => u.hospital.code === h.code && u.roleKey === 'marketing_crm') ??
      users.find((u) => u.hospital.code === h.code && u.roleKey === 'hospital_admin');
    if (approver === undefined) throw new Error(`No seeded template approver for ${h.code}`);
    for (const [vendor, channel, priority] of [
      ['msg91', 'sms', 100],
      ['wa_cloud', 'whatsapp', 100],
      ['twilio', 'sms', 200],
    ] as const) {
      providers.push({
        id: seedId('msg-provider', h.code, vendor, channel),
        hospital_id: h.id,
        branch_id: null,
        channel,
        vendor,
        name: `${vendor} (${channel})`,
        // Never a credential — a vault reference. A seeded secret is a secret
        // that reaches production the first time someone copies a demo tenant.
        credentials_ref: `vault://vims/${h.code.toLowerCase()}/messaging/${vendor}`,
        sender_ids: jsonb(channel === 'sms' ? ['VIMSHL'] : ['+918000000003']),
        dlt: jsonb(channel === 'sms' ? { entityId: '1101000000000000000', headers: ['VIMSHL'], peTm: 'demo-pe-tm' } : {}),
        waba: jsonb(channel === 'whatsapp' ? { wabaId: 'demo-waba', phoneNumberId: 'demo-phone', display: h.displayName, quality: 'GREEN' } : {}),
        routes: jsonb(channel === 'sms' ? { otp: 'transactional', default: 'transactional' } : {}),
        rate_limit_per_sec: 20,
        cost_config: jsonb(
          channel === 'sms'
            ? { perSegment: 0.16, currency: 'INR' }
            : { perConversation: { utility: 0.115, marketing: 0.7 }, currency: 'INR' },
        ),
        priority,
        status: priority === 100 ? 'active' : 'paused',
        health: jsonb({}),
        last_healthy_at: null,
        created_at: SEED_EPOCH,
        created_by: null,
        updated_at: SEED_EPOCH,
        updated_by: null,
        deleted_at: null,
        version: 0,
      });
    }

    whitelist.push(
      {
        id: seedId('msg-url-whitelist', h.code, 'short'),
        hospital_id: h.id,
        url_pattern: 'https://s.vims.local/%',
        domain: 's.vims.local',
        dlt_registered: true,
        note: 'Short-link domain registered on the DLT platform',
        active: true,
        created_at: SEED_EPOCH,
        created_by: null,
        updated_at: SEED_EPOCH,
      },
      {
        id: seedId('msg-url-whitelist', h.code, 'portal'),
        hospital_id: h.id,
        url_pattern: 'https://portal.vims.local/%',
        domain: 'portal.vims.local',
        dlt_registered: true,
        note: 'Patient portal',
        active: true,
        created_at: SEED_EPOCH,
        created_by: null,
        updated_at: SEED_EPOCH,
      },
    );

    MSG_TEMPLATES.forEach(([key, name, channel, category, cls, ownerModule, eventType, body], index) => {
      const templateId = seedId('msg-template', h.code, key);
      templates.push({
        id: templateId,
        hospital_id: h.id,
        key,
        name,
        description: null,
        channel,
        category,
        class: cls,
        owner_module: ownerModule,
        ttl_sec: cls === 'critical' ? 300 : 86_400,
        dedupe_window_sec: 600,
        // EN-009 §5: an SMS may never carry clinical content. Every Phase-1
        // template is `none`, and the lint that enforces it reads this column.
        phi_level: 'none',
        channel_policy: channel === 'whatsapp' ? 'wa_then_sms' : 'sms_only',
        active: true,
        created_at: SEED_EPOCH,
        created_by: null,
        updated_at: SEED_EPOCH,
        updated_by: null,
        deleted_at: null,
        version: 0,
      });

      // The DLT registration exists only for SMS: WhatsApp templates are
      // approved by Meta, not by TRAI, and conflating the two is how a
      // WhatsApp-only template ends up blocked for a missing DLT id.
      let dltRefId: string | null = null;
      if (channel === 'sms') {
        dltRefId = seedId('msg-dlt-template', h.code, key);
        dltTemplates.push({
          id: dltRefId,
          hospital_id: h.id,
          entity_id: '1101000000000000000',
          header: 'VIMSHL',
          dlt_template_id: `11070000000000${String(index).padStart(5, '0')}`,
          template_name: name,
          category,
          language: 'en',
          content: body,
          content_hash: contentHash(body),
          variable_count: (body.match(/\{#var#\}/g) ?? []).length,
          status: 'approved',
          approved_at: SEED_EPOCH,
          rejection_reason: null,
          registered_by: null,
          created_at: SEED_EPOCH,
          created_by: null,
          updated_at: SEED_EPOCH,
          deleted_at: null,
        });
      }

      for (const language of ['en-IN', 'hi', 'kn'] as const) {
        // Only the English version claims the DLT registration: the registered
        // content is in English, and a Hindi body would hash differently.
        versions.push({
          id: seedId('msg-template-version', h.code, key, language),
          hospital_id: h.id,
          template_id: templateId,
          version: 1,
          language,
          body,
          header: null,
          footer: null,
          buttons: jsonb(key.startsWith('appointment_') ? [{ type: 'quick_reply', text: 'Cancel' }] : []),
          variables: jsonb(
            Array.from({ length: (body.match(/\{#var#\}/g) ?? []).length }, (_unused, i) => ({
              idx: i + 1,
              name: `var${i + 1}`,
              type: 'text',
              // EN-009 §5: DLT caps a variable at 30 characters.
              maxLen: 30,
              sample: 'sample',
            })),
          ),
          dlt_template_ref_id: language === 'en-IN' ? dltRefId : null,
          wa_template_name: channel === 'whatsapp' ? `${key}_${language.replace('-', '_').toLowerCase()}` : null,
          wa_status: channel === 'whatsapp' ? 'approved' : null,
          wa_quality: channel === 'whatsapp' ? 'GREEN' : null,
          wa_rejection_reason: null,
          body_hash: contentHash(body),
          status: 'active',
          approved_by: approver.id,
          approved_at: SEED_EPOCH,
          effective_from: SEED_EPOCH,
          effective_to: null,
          created_at: SEED_EPOCH,
          created_by: null,
          updated_at: SEED_EPOCH,
        });
      }

      triggers.push({
        id: seedId('msg-trigger', h.code, key),
        hospital_id: h.id,
        branch_id: null,
        event_type: eventType,
        template_key: key,
        condition: jsonb({}),
        channel_policy: channel === 'whatsapp' ? 'wa_then_sms' : 'sms_only',
        delay_sec: 0,
        offset_sec: key === 'appointment_reminder_24h' ? -86_400 : key === 'appointment_reminder_2h' ? -7_200 : null,
        module: ownerModule,
        // EN-009 §5: marketing needs explicit opt-in and a DND scrub, so the
        // campaign trigger ships switched off. A hospital turns it on when its
        // consent capture is live, not because a seed decided for it.
        active: cls !== 'promotional',
        created_at: SEED_EPOCH,
        created_by: null,
        updated_at: SEED_EPOCH,
        version: 0,
      });
    });
  }

  await ctx.write({ table: 'engage.msg_providers', conflict: ['id'] }, providers);
  await ctx.write({ table: 'engage.msg_dlt_templates', conflict: ['id'] }, dltTemplates);
  await ctx.write({ table: 'engage.msg_templates', conflict: ['id'] }, templates);
  await ctx.write({ table: 'engage.msg_template_versions', conflict: ['id'] }, versions);
  await ctx.write({ table: 'engage.msg_url_whitelist', conflict: ['id'] }, whitelist);
  await ctx.write({ table: 'engage.msg_triggers', conflict: ['id'] }, triggers);
}

/**
 * EN-009 §5: the SMS body must equal the DLT-registered content. Whitespace and
 * case are normalised out first, because an operator's portal round-trips them
 * and a hash that changes on a trailing newline is a hash nobody trusts.
 */
function contentHash(body: string): string {
  return createHash('sha256').update(body.trim().replace(/\s+/g, ' ').toLowerCase()).digest('hex');
}

// ── ABDM (EN-011 M1) ────────────────────────────────────────────────────────

async function seedAbdm(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const rows: SeedRow[] = [];
  for (const h of tenancy.hospitals) {
    for (const b of h.branches) {
      rows.push({
        id: seedId('abdm-config', h.code, b.code),
        hospital_id: h.id,
        branch_id: b.id,
        // `phase-01 §1.3`: "Sandbox config toggle." Nothing seeded ever points
        // at production ABDM — a demo tenant that could enrol a real ABHA is a
        // demo tenant that will.
        mode: 'sandbox',
        client_id: `SBX_${h.code.replace('-', '_')}`,
        secret_ref: `vault://vims/${h.code.toLowerCase()}/abdm/client-secret`,
        hip_id: `${h.code.toLowerCase()}-${b.code.toLowerCase()}`,
        hiu_id: null,
        hfr_id: null,
        cm_id: 'sbx',
        bridge_url: 'https://dev.abdm.gov.in/hiecm/api',
        gateway_url: 'https://dev.abdm.gov.in/gateway',
        callback_secret_ref: `vault://vims/${h.code.toLowerCase()}/abdm/callback-secret`,
        keys: jsonb([]),
        cert_status: 'not_started',
        last_token_at: null,
        // Off by default. `phase-01` Constraints: registration must never block
        // on ABDM, and the safest way to prove that is to ship it disabled.
        enabled: false,
        created_at: SEED_EPOCH,
        created_by: null,
        updated_at: SEED_EPOCH,
        updated_by: null,
        version: 0,
      });
    }
  }
  await ctx.write({ table: 'integration.abdm_config', conflict: ['id'] }, rows);
}
