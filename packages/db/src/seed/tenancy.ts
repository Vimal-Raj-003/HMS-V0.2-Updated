import type { SeedContext } from './context.js';
import { SEED_EPOCH, seedId } from './ids.js';
import { jsonb, type SeedRow } from './upsert.js';

/**
 * The demo tenancy: one group → two hospitals → three branches
 * (`phase-00 §0.2`).
 *
 * Two hospitals rather than one is not decoration. `docs/09 §3.1` requires the
 * tenant-isolation suite to prove that "a user of hospital A cannot read
 * hospital B by direct id", and that test needs a second tenant that looks
 * plausible — same group, same seeded roles, same numbering series — so a
 * passing test means isolation works, not that hospital B was empty.
 *
 * Three branches (two under one hospital) is what makes the branch half of
 * `EN-041 §14 AC-1` testable: a Whitefield user querying the Bengaluru main
 * campus must get zero rows, and that is only meaningful when both branches
 * belong to the same tenant.
 */

export const DEMO_GROUP_KEY = 'vims-demo-group';

export interface SeededBranch {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly shortName: string;
  readonly isMain: boolean;
}

export interface SeededHospital {
  readonly id: string;
  readonly code: string;
  readonly displayName: string;
  readonly legalName: string;
  readonly branches: readonly SeededBranch[];
  readonly stateCode: string;
  readonly gstin: string;
}

export interface SeededTenancy {
  readonly groupId: string;
  readonly hospitals: readonly SeededHospital[];
}

function branch(
  hospitalCode: string,
  code: string,
  name: string,
  shortName: string,
  isMain: boolean,
): SeededBranch {
  return { id: seedId('branch', hospitalCode, code), code, name, shortName, isMain };
}

export function demoTenancy(): SeededTenancy {
  const groupId = seedId('org-group', DEMO_GROUP_KEY);

  const blr: SeededHospital = {
    id: seedId('hospital', 'VIMS-BLR'),
    code: 'VIMS-BLR',
    displayName: "Vim's Multispecialty Hospital, Bengaluru",
    legalName: "Vim's Healthcare (Bengaluru) Private Limited",
    stateCode: '29',
    // Synthetic. Structurally valid (state code + PAN-shaped block) but not
    // issued to anyone — docs/09 §11 forbids real identifiers in seed data.
    gstin: '29AADCV1234K1ZP',
    branches: [
      branch('VIMS-BLR', 'BLR-MAIN', 'Bengaluru Main Campus', 'BLR-Main', true),
      branch('VIMS-BLR', 'BLR-WF', 'Whitefield Satellite Clinic', 'BLR-WF', false),
    ],
  };

  const mys: SeededHospital = {
    id: seedId('hospital', 'VIMS-MYS'),
    code: 'VIMS-MYS',
    displayName: "Vim's Trauma & Orthopaedic Centre, Mysuru",
    legalName: "Vim's Trauma Care (Mysuru) Private Limited",
    stateCode: '29',
    gstin: '29AADCV9876K1ZQ',
    branches: [branch('VIMS-MYS', 'MYS-MAIN', 'Mysuru Main Campus', 'MYS-Main', true)],
  };

  return { groupId, hospitals: [blr, mys] };
}

export function mainBranchOf(hospital: SeededHospital): SeededBranch {
  return hospital.branches.find((b) => b.isMain) ?? (hospital.branches[0] as SeededBranch);
}

export async function seedTenancy(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  await ctx.write({ table: 'core.org_groups', conflict: ['id'] }, [
    {
      id: tenancy.groupId,
      name: "Vim's Demo Healthcare Group",
      legal_name: "Vim's Healthcare Group Private Limited",
      brand: "Vim's HMS",
      logo_file_id: null,
      default_currency: 'INR',
      default_timezone: 'Asia/Kolkata',
      hq_address: {
        line1: '1 Demo Tower, Residency Road',
        city: 'Bengaluru',
        state: 'Karnataka',
        country: 'IN',
        pincode: '560025',
      },
      status: 'active',
      created_at: SEED_EPOCH,
      created_by: null,
      updated_at: SEED_EPOCH,
      updated_by: null,
      version: 0,
    },
  ]);

  const hospitals: SeedRow[] = tenancy.hospitals.map((h) => ({
    id: h.id,
    group_id: tenancy.groupId,
    code: h.code,
    legal_name: h.legalName,
    display_name: h.displayName,
    entity_type: 'private_limited',
    primary_gstin: h.gstin,
    pan: 'AADCV1234K',
    tan: null,
    cin: null,
    registrations: {
      clinical_establishment: { number: `KA/CE/DEMO/${h.code}`, validTo: '2028-03-31' },
      nabh: { number: `NABH-DEMO-${h.code}`, validTo: '2029-03-31' },
    },
    rohini_id: null,
    hfr_id: null,
    timezone: 'Asia/Kolkata',
    locale: 'en-IN',
    languages: ['en-IN', 'hi', 'kn'],
    currency: 'INR',
    books_currency: 'INR',
    fy_start_month: 4,
    residency_zone: 'in',
    address: {
      line1: `1 Demo Road, ${h.code}`,
      city: h.code === 'VIMS-BLR' ? 'Bengaluru' : 'Mysuru',
      state: 'Karnataka',
      country: 'IN',
      pincode: h.code === 'VIMS-BLR' ? '560025' : '570001',
    },
    contacts: { phone: '+918000000000', email: `contact.${h.code.toLowerCase()}@demo.vims.local` },
    // DPDP Act 2023 requires both to be published; a hospital row without them
    // is not a lawful configuration, so the demo tenant models a lawful one.
    dpo: { name: 'Demo DPO', email: 'dpo@demo.vims.local', phone: '+918000000001' },
    grievance_officer: {
      name: 'Demo Grievance Officer',
      email: 'grievance@demo.vims.local',
      phone: '+918000000002',
    },
    logo_light_file_id: null,
    logo_dark_file_id: null,
    is_tenant_boundary: true,
    status: 'active',
    created_at: SEED_EPOCH,
    created_by: null,
    updated_at: SEED_EPOCH,
    updated_by: null,
    version: 0,
  }));
  await ctx.write({ table: 'core.hospitals', conflict: ['id'] }, hospitals);

  const branches: SeedRow[] = [];
  const units: SeedRow[] = [];
  for (const h of tenancy.hospitals) {
    h.branches.forEach((b, index) => {
      branches.push({
        id: b.id,
        hospital_id: h.id,
        group_id: tenancy.groupId,
        code: b.code,
        name: b.name,
        short_name: b.shortName,
        path: `${DEMO_GROUP_KEY}.${h.code.toLowerCase()}.${b.code.toLowerCase()}`.replace(/-/g, '_'),
        parent_branch_id: null,
        kind: b.isMain ? 'hospital' : 'polyclinic',
        serves_from_branch_id: null,
        address: { line1: b.name, city: h.code === 'VIMS-BLR' ? 'Bengaluru' : 'Mysuru', country: 'IN' },
        state_code: h.stateCode,
        // EN-041 §3.6: invoice series are legally per GSTIN. Both branches of
        // VIMS-BLR share one GSTIN, which is what makes the series shared.
        gstin: h.gstin,
        timezone: 'Asia/Kolkata',
        currency: 'INR',
        residency_zone: 'in',
        hfr_id: null,
        rohini_id: null,
        working_hours: { mon_sat: '08:00-20:00', sun: '09:00-13:00' },
        bed_count: b.isMain ? 250 : 0,
        module_profile: b.isMain ? 'full_hospital' : 'opd_only',
        colour_token: `branch-${index + 1}`,
        go_live_at: SEED_EPOCH,
        status: 'live',
        closed_at: null,
        successor_branch_id: null,
        created_at: SEED_EPOCH,
        created_by: null,
        updated_at: SEED_EPOCH,
        updated_by: null,
        version: 0,
      });

      if (!b.isMain) return;
      for (const [code, name, kind, capacity] of MAIN_CAMPUS_UNITS) {
        units.push({
          id: seedId('org-unit', b.code, code),
          hospital_id: h.id,
          branch_id: b.id,
          code,
          name,
          kind,
          path: null,
          capacity,
          active: true,
          created_at: SEED_EPOCH,
          created_by: null,
          updated_at: SEED_EPOCH,
          updated_by: null,
          version: 0,
        });
      }
    });
  }

  await ctx.write({ table: 'core.branches', conflict: ['id'] }, branches);
  await ctx.write({ table: 'core.org_units', conflict: ['id'] }, units);
}

const MAIN_CAMPUS_UNITS: readonly (readonly [string, string, string, number])[] = [
  ['W-4B', 'Ward 4B — General Medicine', 'ward', 32],
  ['W-5A', 'Ward 5A — Orthopaedics', 'ward', 28],
  ['ICU-1', 'Medical ICU', 'icu', 12],
  ['ICU-2', 'Surgical ICU', 'icu', 10],
  ['OT-CX', 'Operation Theatre Complex', 'ot_complex', 6],
  ['BLK-A', 'Block A — Outpatient', 'block', 0],
];

/**
 * `EN-027` departments, seeded through the effective-dated pattern rather than
 * as flat rows: `record_key` is the stable identity a later version supersedes,
 * and the exclusion constraint on the table guarantees the versions never
 * overlap. Every master built in a later phase copies this shape.
 */
export async function seedDepartments(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const rows: SeedRow[] = [];
  for (const h of tenancy.hospitals) {
    for (const [code, name, kind] of DEPARTMENTS) {
      const recordKey = seedId('mdm-department-key', h.code, code);
      rows.push({
        id: seedId('mdm-department', h.code, code, 'v1'),
        record_key: recordKey,
        hospital_id: h.id,
        branch_id: null,
        version: 1,
        code,
        name,
        kind,
        speciality_concept: null,
        parent_department_key: null,
        head_user_id: null,
        cost_centre_key: `CC-${code}`,
        active_branches: h.branches.map((b) => b.id),
        effective_from: SEED_EPOCH,
        effective_to: null,
        status: 'active',
        change_set_id: null,
        replaced_by_key: null,
        approved_by: null,
        approved_at: SEED_EPOCH,
        created_at: SEED_EPOCH,
        created_by: null,
        updated_at: SEED_EPOCH,
        updated_by: null,
      });
    }
  }
  await ctx.write({ table: 'mdm.mdm_departments', conflict: ['id'] }, rows);
}

const DEPARTMENTS: readonly (readonly [string, string, string])[] = [
  ['GENMED', 'General Medicine', 'clinical'],
  ['ORTHO', 'Orthopaedics', 'clinical'],
  ['GENSURG', 'General Surgery', 'clinical'],
  ['EMERG', 'Emergency & Trauma', 'clinical'],
  ['ANAES', 'Anaesthesiology', 'clinical'],
  ['OBGYN', 'Obstetrics & Gynaecology', 'clinical'],
  ['PAED', 'Paediatrics', 'clinical'],
  ['LAB', 'Laboratory Medicine', 'diagnostic'],
  ['RAD', 'Radiology & Imaging', 'diagnostic'],
  ['PHARM', 'Pharmacy', 'support'],
  ['NURS', 'Nursing Services', 'support'],
  ['ADMIN', 'Administration', 'support'],
];

/** Statutory holidays the SLA and appointment engines must observe. */
export async function seedHolidays(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const holidays: readonly (readonly [string, string, string])[] = [
    ['2026-01-26', 'Republic Day', 'national'],
    ['2026-08-15', 'Independence Day', 'national'],
    ['2026-10-02', 'Gandhi Jayanti', 'national'],
    ['2026-11-01', 'Kannada Rajyotsava', 'regional'],
  ];
  const rows: SeedRow[] = [];
  for (const h of tenancy.hospitals) {
    for (const [date, name, kind] of holidays) {
      rows.push({
        id: seedId('holiday', h.code, date),
        hospital_id: h.id,
        branch_id: null,
        date,
        name,
        kind,
        // EN-007 §3.1.3: an emergency department observes none of them.
        applies_to: jsonb({ excludeDepartments: ['EMERG'] }),
        created_at: SEED_EPOCH,
        created_by: null,
        updated_at: SEED_EPOCH,
      });
    }
  }
  await ctx.write({ table: 'core.holidays', conflict: ['id'] }, rows);
}
