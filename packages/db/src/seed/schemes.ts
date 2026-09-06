import type { SeedContext } from './context.js';
import { SEED_EPOCH, seedId } from './ids.js';
import type { SeededTenancy } from './tenancy.js';
import { jsonb, type SeedRow } from './upsert.js';

/**
 * RC-007 — a working government-scheme setup.
 *
 * Three schemes, because the differences between them are the point:
 *
 *   PMJAY  the strict case: an HBP rate list, pre-auth on everything, and a cash
 *          block scoped to the episode
 *   CGHS   a second scheme on the same patient's hospital, to prove the master
 *          is not a singleton and that per-scheme rules really are per-scheme
 *   ESIC   `cash_block_scope = 'always'`, so the stricter reading of §5.6 is
 *          exercised by something other than a test fixture
 *
 * ── The same immutability lesson as the tariff seed ─────────────────────────
 *
 * A published rate list refuses INSERTs, and `ON CONFLICT` is evaluated *after*
 * `BEFORE INSERT` fires, so even a no-op re-upsert is rejected. That is correct:
 * re-seeding a published rate list is not idempotence, it is rewriting the rates
 * historical claims were settled at. So a second run stops at the version that
 * is already published.
 *
 * ── No seeded beneficiary ───────────────────────────────────────────────────
 *
 * Deliberately. A verified beneficiary turns the cash block on for that patient
 * across every counter in the demo tenancy, and a developer who has not read
 * this file would meet an unexplained refusal at the cash counter. The card is
 * captured and verified through the API, which is also the path worth exercising.
 */

interface HbpPackage {
  readonly code: string;
  readonly name: string;
  readonly specialty: string;
  readonly procedureType: 'medical' | 'surgical' | 'daycare';
  readonly rate: string;
  readonly losDays: number;
  readonly implantCap?: string;
}

/**
 * A small slice of the real HBP 2.2 shape — codes and rate bands in the
 * published ballpark, chosen to cover the cases the module has to handle:
 * a surgical package with an implant cap, a medical package without one, and a
 * daycare package cheap enough that a shortfall on it is visible.
 */
const PMJAY_PACKAGES: readonly HbpPackage[] = [
  {
    code: 'HBP-OR-012',
    name: 'Total hip replacement (cemented, unilateral)',
    specialty: 'Orthopaedics',
    procedureType: 'surgical',
    rate: '90000.00',
    losDays: 7,
    implantCap: '40000.00',
  },
  {
    code: 'HBP-OR-004',
    name: 'Closed reduction and internal fixation, femur',
    specialty: 'Orthopaedics',
    procedureType: 'surgical',
    rate: '40000.00',
    losDays: 5,
    implantCap: '25000.00',
  },
  {
    code: 'HBP-GS-021',
    name: 'Laparoscopic cholecystectomy',
    specialty: 'General surgery',
    procedureType: 'surgical',
    rate: '30000.00',
    losDays: 3,
  },
  {
    code: 'HBP-MD-007',
    name: 'Acute myocardial infarction, conservative management',
    specialty: 'General medicine',
    procedureType: 'medical',
    rate: '15000.00',
    losDays: 5,
  },
  {
    code: 'HBP-MD-031',
    name: 'Severe community-acquired pneumonia, ward care',
    specialty: 'General medicine',
    procedureType: 'medical',
    rate: '11000.00',
    losDays: 6,
  },
  {
    code: 'HBP-DC-002',
    name: 'Haemodialysis, single session',
    specialty: 'Nephrology',
    procedureType: 'daycare',
    rate: '1500.00',
    losDays: 0,
  },
];

const CGHS_PACKAGES: readonly HbpPackage[] = [
  {
    code: 'CGHS-874',
    name: 'Total knee replacement (unilateral)',
    specialty: 'Orthopaedics',
    procedureType: 'surgical',
    rate: '105000.00',
    losDays: 7,
    implantCap: '55000.00',
  },
  {
    code: 'CGHS-231',
    name: 'Cataract surgery with foldable IOL',
    specialty: 'Ophthalmology',
    procedureType: 'daycare',
    rate: '17000.00',
    losDays: 1,
    implantCap: '9000.00',
  },
];

interface SchemeSpec {
  readonly code: string;
  readonly name: string;
  readonly type: 'pmjay' | 'cghs' | 'echs' | 'esic' | 'state';
  readonly authority: string;
  readonly cashBlockScope: 'active_case' | 'always';
  readonly claimFormat: 'pmjay_json' | 'cghs_pdf' | 'echs_xml' | 'esic_csv' | 'state_csv';
  readonly claimWindowDays: number;
  readonly packages: readonly HbpPackage[];
  readonly versionLabel: string;
  readonly authorityRef: string;
}

const SCHEMES: readonly SchemeSpec[] = [
  {
    code: 'PMJAY',
    name: 'Ayushman Bharat PM-JAY',
    type: 'pmjay',
    authority: 'National Health Authority',
    cashBlockScope: 'active_case',
    claimFormat: 'pmjay_json',
    claimWindowDays: 30,
    packages: PMJAY_PACKAGES,
    versionLabel: 'HBP 2.2',
    authorityRef: 'HBP-2.2',
  },
  {
    code: 'CGHS',
    name: 'Central Government Health Scheme',
    type: 'cghs',
    authority: 'CGHS Bengaluru',
    cashBlockScope: 'active_case',
    claimFormat: 'cghs_pdf',
    claimWindowDays: 45,
    packages: CGHS_PACKAGES,
    versionLabel: 'CGHS 2023 revision',
    authorityRef: 'CGHS-2023',
  },
  {
    code: 'ESIC',
    name: "Employees' State Insurance Corporation",
    type: 'esic',
    authority: 'ESIC Sub-Regional Office, Bengaluru',
    // The stricter reading of §5.6, so the `always` branch of the cash-block
    // trigger is exercised by seeded data rather than only by a test.
    cashBlockScope: 'always',
    claimFormat: 'esic_csv',
    claimWindowDays: 60,
    packages: [],
    versionLabel: 'ESIC 2024 rates',
    authorityRef: 'ESIC-2024',
  },
];

export async function seedSchemes(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  for (const hospital of tenancy.hospitals) {
    const masters: SeedRow[] = SCHEMES.map((scheme) => ({
      id: seedId('scheme-master', hospital.code, scheme.code),
      hospital_id: hospital.id,
      code: scheme.code,
      name: scheme.name,
      type: scheme.type,
      authority: scheme.authority,
      // Present-and-null on every row: `upsert()` takes its column list from the
      // first row, so a key that appears only later is silently dropped.
      state_code: null,
      empanelment_no: `VIMS/${hospital.code}/${scheme.code}`,
      cash_block_scope: scheme.cashBlockScope,
      requires_preauth: true,
      claim_format: scheme.claimFormat,
      claim_window_days: scheme.claimWindowDays,
      is_active: true,
      effective_from: '2026-04-01',
      effective_to: null,
      created_at: SEED_EPOCH,
      updated_at: SEED_EPOCH,
    }));

    await ctx.write({ table: 'billing.scheme_masters', conflict: ['id'] }, masters);

    for (const scheme of SCHEMES) {
      if (scheme.packages.length === 0) continue;

      const schemeId = seedId('scheme-master', hospital.code, scheme.code);
      const versionId = seedId('scheme-version', hospital.code, scheme.code, '1');

      // Same rule as `mdm.tariff_versions`: a published list is immutable, and
      // the trigger fires on INSERT too. A second run stops here rather than
      // trying to rewrite rates that claims have already settled at.
      const { rows: existing } = await ctx.db.query<{ status: string }>(
        `SELECT status FROM billing.scheme_package_versions WHERE id = $1`,
        [versionId],
      );
      if (existing[0]?.status === 'published') continue;

      await ctx.write({ table: 'billing.scheme_package_versions', conflict: ['id'], immutable: ['status'] }, [
        {
          id: versionId,
          hospital_id: hospital.id,
          scheme_id: schemeId,
          version_no: 1,
          label: scheme.versionLabel,
          authority_ref: scheme.authorityRef,
          status: 'draft',
          effective_from: '2026-04-01',
          effective_to: null,
          published_at: null,
          published_by: null,
          created_at: SEED_EPOCH,
          updated_at: SEED_EPOCH,
        },
      ] satisfies SeedRow[]);

      const packages: SeedRow[] = scheme.packages.map((pkg) => ({
        id: seedId('scheme-package', hospital.code, scheme.code, pkg.code),
        hospital_id: hospital.id,
        version_id: versionId,
        package_code: pkg.code,
        name: pkg.name,
        specialty: pkg.specialty,
        procedure_type: pkg.procedureType,
        base_rate: pkg.rate,
        // The authority's own tiers, kept in their published shape rather than
        // flattened into columns that would lose what each scheme means by them.
        stratification: jsonb({ cityClass: 'X', hospitalGrade: 'NABH', source: 'seed' }),
        implant_allowed: pkg.implantCap !== undefined,
        implant_cap: pkg.implantCap ?? null,
        pre_auth_required: true,
        los_days: pkg.losDays,
        incompatible_with: [],
        is_active: true,
        created_at: SEED_EPOCH,
        updated_at: SEED_EPOCH,
      }));

      await ctx.write({ table: 'billing.scheme_packages', conflict: ['id'] }, packages);

      await ctx.db.query(
        `UPDATE billing.scheme_package_versions
            SET status = 'published', published_at = $2, published_by = NULL
          WHERE id = $1 AND status <> 'published'`,
        [versionId, SEED_EPOCH],
      );
    }
  }
}
