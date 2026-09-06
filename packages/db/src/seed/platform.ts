import { ENFORCEMENT_POINTS, SETTING_DEFINITIONS } from '@vims/contracts';
import type { SeedContext } from './context.js';
import { SEED_EPOCH, seedId } from './ids.js';
import { jsonb, type SeedRow } from './upsert.js';
import { mainBranchOf, type SeededTenancy } from './tenancy.js';

/**
 * Platform configuration every tenant needs before a single request can
 * complete: numbering series, effective settings, feature flags and the
 * business calendar the SLA engine measures against.
 */
export async function seedPlatform(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  await seedNumberingSeries(ctx, tenancy);
  await seedSettings(ctx, tenancy);
  await seedFeatureFlags(ctx, tenancy);
  await seedBusinessCalendars(ctx, tenancy);
}

/**
 * `docs/03 §Numbering series`. The `gapless` flag is the load-bearing one:
 * invoices, receipts, MLC registers and blood-bag numbers are legally required
 * to have no holes, which forces a row-locked allocation inside the business
 * transaction. Tokens deliberately are not gapless — a gap in a queue token
 * harms nobody and the throughput matters (`docs/09 §9.8`).
 *
 * `{BR}` is the branch short code, `{FY}` the Indian financial year, `{SEQ:n}`
 * a zero-padded counter.
 */
const SERIES: readonly (readonly [key: string, pattern: string, gapless: boolean, reset: string])[] = [
  ['UHID', '{BR}{SEQ:8}', false, 'never'],
  ['OP_VISIT', '{BR}/OP/{FY}/{SEQ:6}', false, 'fy'],
  // OP-001 §4: "appointment no per branch/FY". Not gapless — a booking that
  // fails validation must not burn a number that an auditor will later ask
  // about, and nothing legal depends on the sequence being unbroken.
  ['APPT', '{BR}/APPT/{FY}/{SEQ:6}', false, 'fy'],
  ['IP_NO', '{BR}/IP/{FY}/{SEQ:6}', false, 'fy'],
  ['TOKEN', '{SEQ:4}', false, 'day'],
  ['BILL_OP', '{BR}/OPB/{FY}/{SEQ:6}', true, 'fy'],
  ['BILL_IP', '{BR}/IPB/{FY}/{SEQ:6}', true, 'fy'],
  ['RECEIPT', '{BR}/RCP/{FY}/{SEQ:6}', true, 'fy'],
  ['REFUND', '{BR}/REF/{FY}/{SEQ:6}', true, 'fy'],
  ['CREDIT_NOTE', '{BR}/CN/{FY}/{SEQ:6}', true, 'fy'],
  // OP-005 §4/§5: GST documents are numbered gaplessly **per series per FY**,
  // and that is only true if they have a series of their own. Sharing `BILL_OP`
  // would interleave bill numbers and invoice numbers in one counter, so the
  // invoice register would show gaps wherever a bill took the next number —
  // which is precisely the defect gapless numbering exists to prevent.
  // A tax invoice and a bill of supply are separate registers under GST.
  ['TAX_INVOICE', '{BR}/INV/{FY}/{SEQ:6}', true, 'fy'],
  ['BILL_SUPPLY', '{BR}/BOS/{FY}/{SEQ:6}', true, 'fy'],
  // RC-007 §5.6: a scheme case and its claim carry the authority's reference on
  // every document and every appeal. Gapless, because a missing claim number in
  // a settlement batch is a claim the authority will say it never received.
  ['SCHEME_CASE', '{BR}/SCH/{FY}/{SEQ:6}', true, 'fy'],
  ['SCHEME_CLAIM', '{BR}/SCLM/{FY}/{SEQ:6}', true, 'fy'],
  // RC-008 §5.7: an estimate is a document a family keeps and brings back. Not
  // gapless — an abandoned draft must not burn a number, and nothing legal
  // depends on the sequence being unbroken.
  ['ESTIMATE', '{BR}/EST/{FY}/{SEQ:6}', false, 'fy'],
  // NC-034 §5.7: a payout statement is a document a doctor keeps and a figure
  // that appears on a TDS return. Gapless per branch per FY, because a missing
  // statement number in a 26Q filing is a question somebody has to answer.
  ['PAYOUT', '{BR}/PAY/{FY}/{SEQ:6}', true, 'fy'],
  // OP-006 §6.1: the ER number is the identity of an episode that may start
  // before anybody knows the patient's name. Gapless per branch per FY, because
  // a missing ER number is an episode somebody has to account for.
  ['ER_NO', '{BR}/ER/{FY}/{SEQ:6}', true, 'fy'],
  // The temporary tag. Never reset, and deliberately so: a tag recycled daily
  // means two patients called ER-TAG-0007 a week apart, and if either is still
  // unidentified that is exactly the confusion the tag exists to prevent. Not
  // gapless — an abandoned tag must not burn a number an auditor asks about.
  ['ER_TAG', 'ER-TAG-{SEQ:5}', false, 'never'],
  // TR-001 §6.5: the mass-casualty incident code. Per branch and reset yearly,
  // because an MCI is referenced by name in a district report months later and
  // "MCI/2026/003" has to mean one incident. Not gapless: a declaration that is
  // cancelled in the first minute must not leave a number an auditor chases.
  ['MCI_NO', '{BR}/MCI/{YYYY}/{SEQ:3}', false, 'year'],
  // OP-002 §5: "Numbering: `RX`, `ORD` per hospital/branch/FY (non-gapless)."
  // Not gapless — an abandoned prescription draft must not burn a number an
  // auditor will later ask about, and nothing legal depends on the sequence
  // being unbroken. The number is allocated at signing, not at draft.
  ['RX', '{BR}/RX/{FY}/{SEQ:6}', false, 'fy'],
  ['ORD', '{BR}/ORD/{FY}/{SEQ:6}', false, 'fy'],
  // NC-003: the medical-record number. Per hospital rather than per branch and
  // never reset, because a patient's record follows them between campuses.
  ['MRD', 'MRD{SEQ:8}', false, 'never'],
  ['LAB_ACC', '{BR}/LAB/{FY}/{SEQ:7}', false, 'fy'],
  ['SAMPLE', '{BR}/SMP/{SEQ:8}', false, 'never'],
  ['RAD_ACC', '{BR}/RAD/{FY}/{SEQ:7}', false, 'fy'],
  ['PO', '{BR}/PO/{FY}/{SEQ:5}', false, 'fy'],
  ['GRN', '{BR}/GRN/{FY}/{SEQ:5}', false, 'fy'],
  ['INDENT', '{BR}/IND/{FY}/{SEQ:5}', false, 'fy'],
  // Phase 4 — pharmacy, stores and supply chain. `PO`, `GRN` and `INDENT`
  // already existed above and are not repeated; `INDENT` numbers the *store*
  // indent (NC-006) and `IND` the *purchase* indent (NC-005 §3.14), which are
  // two different documents with two different approval chains.
  //
  // Only two of these are gapless, and for the same reason `RECEIPT` is:
  //   `BILL_PH`  a pharmacy sale is a GST tax invoice (OP-003 §5, docs/04 §1).
  //   `NARC_REG` the controlled-drug register serial. A statutory register with
  //              a hole in its page numbers is not a register — a drug
  //              inspector reads the sequence, not the rows.
  // The rest are documents whose abandoned drafts must not burn a number an
  // auditor will later ask about.
  ['IND', '{BR}/IND/{FY}/{SEQ:5}', false, 'fy'],
  ['RFQ', '{BR}/RFQ/{FY}/{SEQ:5}', false, 'fy'],
  ['PRN', '{BR}/PRN/{FY}/{SEQ:5}', false, 'fy'],
  ['VINV', '{BR}/VINV/{FY}/{SEQ:6}', false, 'fy'],
  ['ISSUE', '{BR}/ISS/{FY}/{SEQ:6}', false, 'fy'],
  ['TRANSFER', '{BR}/TRF/{FY}/{SEQ:6}', false, 'fy'],
  ['ADJ', '{BR}/ADJ/{FY}/{SEQ:5}', false, 'fy'],
  ['COUNT', '{BR}/CNT/{FY}/{SEQ:5}', false, 'fy'],
  ['CONS', '{BR}/CON/{FY}/{SEQ:7}', false, 'fy'],
  ['CSN_IN', '{BR}/CSN/{FY}/{SEQ:5}', false, 'fy'],
  ['DISP', '{BR}/DSP/{FY}/{SEQ:7}', false, 'fy'],
  ['PHRET', '{BR}/PHR/{FY}/{SEQ:6}', false, 'fy'],
  ['BILL_PH', '{BR}/PHB/{FY}/{SEQ:6}', true, 'fy'],
  ['NARC_REG', '{BR}/NDPS/{FY}/{SEQ:5}', true, 'fy'],
  // Item and vendor codes are per hospital and never reset: an item code that
  // restarts each April is an item code that means two different things.
  ['ITEM', 'ITM{SEQ:6}', false, 'never'],
  ['VEND', 'VND{SEQ:5}', false, 'never'],
  // TR-008 §5: gapless per branch, and never reused — a cancelled case keeps
  // its number. On the financial year like every other gapless statutory series
  // here; the spec says "per branch/year" without saying which year, and an MLC
  // register alone on the calendar year would be the surprise in a hospital
  // whose invoice, narcotics and blood-bag registers all turn over in April.
  ['MLC', '{BR}/MLC/{FY}/{SEQ:4}', true, 'fy'],
  // The certified-copy register. Not gapless: a withdrawn copy request must not
  // burn a number, and nothing legal rests on the sequence being unbroken —
  // only on each issued copy being individually numbered.
  ['MLC_COPY', '{BR}/MLC-COPY/{FY}/{SEQ:4}', false, 'fy'],
  // NC-013: the ambulance request and the trip it becomes. Not gapless — a
  // request cancelled before dispatch must not burn a number, and nothing
  // legal rests on the sequence being unbroken.
  ['AMB_REQ', '{BR}/AMB/{FY}/{SEQ:5}', false, 'fy'],
  ['AMB_TRIP', '{BR}/TRIP/{FY}/{SEQ:5}', false, 'fy'],
  ['BLOOD_BAG', '{BR}/BB/{FY}/{SEQ:5}', true, 'fy'],
  // TR-007: the polytrauma coordination board. Not gapless — a board opened and
  // immediately closed because the second injury turned out to be a graze must
  // not burn a number, and nothing statutory rests on the sequence.
  ['POLYTRAUMA', '{BR}/PT/{FY}/{SEQ:5}', false, 'fy'],
  // IP-006: the theatre case. Not gapless — a case cancelled before it reaches
  // the table must not burn a number, and nothing legal rests on the sequence.
  ['OT_CASE', '{BR}/OT/{FY}/{SEQ:5}', false, 'fy'],
  // IP-013 and IP-007. Neither is gapless: a code called and stood down as a
  // false alarm is still a code, and a blood request cancelled before a sample
  // is drawn must not burn a number.
  ['CODE_BLUE', '{BR}/CODE/{FY}/{SEQ:4}', false, 'fy'],
  ['BLOOD_REQ', '{BR}/BBR/{FY}/{SEQ:5}', false, 'fy'],
  ['LIC_INVOICE', 'VIMS/{FY}/{SEQ:5}', true, 'fy'],
];

/**
 * Series written once per hospital with a null `branch_id`.
 *
 * Deliberately does **not** include `MRD`, whose comment above says "per
 * hospital" but whose row has always been written per branch. Adding it here
 * would emit two rows for a two-branch hospital, both claiming `branch_id IS
 * NULL` — a change to Phase-1 behaviour that has nothing to do with Phase 4.
 * The three keys here are all skipped for non-main branches below, so each one
 * produces exactly one row per hospital.
 */
const HOSPITAL_SCOPED = new Set(['LIC_INVOICE', 'ITEM', 'VEND']);

async function seedNumberingSeries(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const rows: SeedRow[] = [];
  for (const h of tenancy.hospitals) {
    for (const b of h.branches) {
      for (const [key, pattern, gapless, reset] of SERIES) {
        // The SaaS invoice series belongs to the vendor, not to a branch.
        if (key === 'LIC_INVOICE' && !b.isMain) continue;
        // Item and vendor codes are hospital-wide: the same item bought at two
        // campuses is one item, and a vendor supplying both is one vendor.
        if ((key === 'ITEM' || key === 'VEND') && !b.isMain) continue;
        rows.push({
          id: seedId('numbering-series', h.code, b.code, key),
          hospital_id: h.id,
          branch_id: HOSPITAL_SCOPED.has(key) ? null : b.id,
          key,
          pattern,
          scope: HOSPITAL_SCOPED.has(key) ? 'hospital' : 'branch',
          fy: reset === 'fy' ? '2026-27' : null,
          current_value: 0,
          gapless,
          reset_policy: reset,
          version: 1,
          effective_from: SEED_EPOCH,
          effective_to: null,
          locked_at: null,
          active: true,
          created_at: SEED_EPOCH,
          created_by: null,
          updated_at: SEED_EPOCH,
          updated_by: null,
        });
      }
    }
  }
  await ctx.write(
    { table: 'core.numbering_series', conflict: ['id'], immutable: ['current_value', 'locked_at'] },
    rows,
  );
}

/**
 * Effective settings at hospital scope.
 *
 * Only keys whose narrowest declared scope includes `hospital` are written, and
 * `secret` keys are skipped entirely — a secret's value belongs in the secret
 * store, and writing a placeholder into `core.settings.value` would put a
 * plausible-looking non-secret where the application expects a real one
 * (`EN-007 §5`). Everything else inherits from `setting_definitions.default_value`
 * at read time, so this is a small, deliberate set rather than all 46 keys.
 */
async function seedSettings(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const applicable = SETTING_DEFINITIONS.filter(
    (d) => d.sensitivity !== 'secret' && d.scopes.includes('hospital'),
  );

  const rows: SeedRow[] = [];
  for (const h of tenancy.hospitals) {
    for (const definition of applicable) {
      rows.push({
        id: seedId('setting', h.code, definition.key),
        hospital_id: h.id,
        branch_id: null,
        department_id: null,
        user_id: null,
        key: definition.key,
        value: jsonb(definition.defaultValue),
        value_encrypted: null,
        created_at: SEED_EPOCH,
        created_by: null,
        updated_at: SEED_EPOCH,
        updated_by: null,
        version: 0,
      });
    }
  }
  await ctx.write({ table: 'core.settings', conflict: ['id'] }, rows);
}

/**
 * `CLAUDE.md §4`: every module ships behind `module.<key>.enabled`.
 * `EN-007 §3.7`: a flag can never enable a module outside the licence — so the
 * seeded flags mirror the entitlement registry rather than being invented, and
 * a `clinical_safety_exempt` module is enabled unconditionally.
 */
async function seedFeatureFlags(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const moduleKeys = ENFORCEMENT_POINTS.filter((e) => e.family === 'feature' && e.key.startsWith('module.'));

  const rows: SeedRow[] = [];
  for (const h of tenancy.hospitals) {
    for (const point of moduleKeys) {
      rows.push({
        id: seedId('feature-flag', h.code, point.key),
        key: point.key,
        hospital_id: h.id,
        branch_id: null,
        role_key: null,
        user_id: null,
        enabled: true,
        rollout_pct: null,
        expires_at: null,
        note: point.clinicalSafetyExempt
          ? 'Clinical-safety exempt (EN-040 §5): this flag can never disable the module.'
          : 'Enabled for the demo tenant.',
        created_at: SEED_EPOCH,
        created_by: null,
        updated_at: SEED_EPOCH,
        updated_by: null,
      });
    }
  }
  await ctx.write({ table: 'core.feature_flags', conflict: ['id'] }, rows);
}

/** `EN-038 §5`: "SLA clocks use business calendars." */
async function seedBusinessCalendars(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const rows: SeedRow[] = [];
  for (const h of tenancy.hospitals) {
    const main = mainBranchOf(h);
    rows.push({
      id: seedId('wf-calendar', h.code, 'standard'),
      hospital_id: h.id,
      branch_id: null,
      name: 'Standard administrative hours',
      working_days: { mon: true, tue: true, wed: true, thu: true, fri: true, sat: true, sun: false },
      working_hours: { start: '09:00', end: '18:00' },
      holidays: [],
      timezone: 'Asia/Kolkata',
      is_default: true,
      created_at: SEED_EPOCH,
      created_by: null,
      updated_at: SEED_EPOCH,
      deleted_at: null,
    });
    rows.push({
      id: seedId('wf-calendar', h.code, 'roundtheclock'),
      hospital_id: h.id,
      branch_id: main.id,
      name: 'Round the clock (clinical)',
      working_days: { mon: true, tue: true, wed: true, thu: true, fri: true, sat: true, sun: true },
      working_hours: { start: '00:00', end: '24:00' },
      holidays: [],
      timezone: 'Asia/Kolkata',
      is_default: false,
      created_at: SEED_EPOCH,
      created_by: null,
      updated_at: SEED_EPOCH,
      deleted_at: null,
    });
  }
  await ctx.write({ table: 'core.wf_business_calendars', conflict: ['id'] }, rows);
}
