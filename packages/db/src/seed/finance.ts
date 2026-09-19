import type { SeedContext } from './context.js';
import { seedId } from './ids.js';
import type { SeededTenancy } from './tenancy.js';
import type { SeedRow } from './upsert.js';

/**
 * NC-009 — a book, a calendar, an Indian hospital chart of accounts, and the
 * rules that turn domain events into journals.
 *
 * ── Why this is seeded rather than left to the hospital ───────────────────
 *
 * Because an empty chart of accounts is not a blank slate, it is a broken
 * install: the posting engine has nowhere to put a receipt, so every bill
 * finalised on day one lands in an exception queue nobody has been trained to
 * read. A hospital renames and extends these; what it should not have to do is
 * invent double entry from scratch before it can take its first payment.
 *
 * The codes follow the shape Indian hospital accountants and their Tally
 * installations already use — 1000s assets, 2000s liabilities, 3000s equity,
 * 4000s income, 5000s expense — so an export maps without a translation table.
 */

interface AccountSpec {
  readonly code: string;
  readonly name: string;
  readonly type: 'asset' | 'liability' | 'equity' | 'income' | 'expense';
  readonly group?: boolean;
  readonly parent?: string;
  readonly bankOrCash?: boolean;
}

const CHART: readonly AccountSpec[] = [
  { code: '1000', name: 'Assets', type: 'asset', group: true },
  { code: '1100', name: 'Cash in hand', type: 'asset', parent: '1000', bankOrCash: true },
  { code: '1110', name: 'Bank accounts', type: 'asset', parent: '1000', bankOrCash: true },
  { code: '1200', name: 'Accounts receivable — patients', type: 'asset', parent: '1000' },
  { code: '1210', name: 'Accounts receivable — corporate', type: 'asset', parent: '1000' },
  { code: '1220', name: 'Accounts receivable — TPA and insurers', type: 'asset', parent: '1000' },
  { code: '1300', name: 'Inventory — pharmacy', type: 'asset', parent: '1000' },
  { code: '1310', name: 'Inventory — consumables', type: 'asset', parent: '1000' },
  { code: '1400', name: 'Input GST credit', type: 'asset', parent: '1000' },

  { code: '2000', name: 'Liabilities', type: 'liability', group: true },
  // A deposit is the patient's money held by the hospital. Booking it as
  // income on receipt overstates revenue and understates what is owed back —
  // the single commonest error in hospital books.
  { code: '2100', name: 'Patient deposits (refundable)', type: 'liability', parent: '2000' },
  { code: '2200', name: 'Accounts payable — vendors', type: 'liability', parent: '2000' },
  // Three, not one. CGST, SGST and IGST are separately reported in GSTR-3B and
  // separately set off against input credit; a single "output GST" account
  // makes the return a manual reconstruction every month.
  { code: '2300', name: 'Output CGST payable', type: 'liability', parent: '2000' },
  { code: '2301', name: 'Output SGST payable', type: 'liability', parent: '2000' },
  { code: '2302', name: 'Output IGST payable', type: 'liability', parent: '2000' },
  { code: '2310', name: 'TDS payable', type: 'liability', parent: '2000' },
  { code: '2400', name: 'Salaries payable', type: 'liability', parent: '2000' },

  { code: '3000', name: 'Equity', type: 'equity', group: true },
  { code: '3100', name: 'Share capital', type: 'equity', parent: '3000' },
  { code: '3200', name: 'Retained earnings', type: 'equity', parent: '3000' },

  { code: '4000', name: 'Income', type: 'income', group: true },
  { code: '4100', name: 'Consultation income', type: 'income', parent: '4000' },
  { code: '4110', name: 'Inpatient room and nursing income', type: 'income', parent: '4000' },
  { code: '4120', name: 'Theatre and procedure income', type: 'income', parent: '4000' },
  { code: '4130', name: 'Laboratory income', type: 'income', parent: '4000' },
  { code: '4140', name: 'Radiology income', type: 'income', parent: '4000' },
  { code: '4150', name: 'Pharmacy sales', type: 'income', parent: '4000' },
  { code: '4900', name: 'Other operating income', type: 'income', parent: '4000' },
  // Contra-income, not an expense: a discount reduces what was earned, and
  // booking it as a cost overstates both revenue and expenditure.
  { code: '4950', name: 'Discounts allowed (contra-income)', type: 'income', parent: '4000' },

  { code: '5000', name: 'Expenses', type: 'expense', group: true },
  { code: '5100', name: 'Salaries and wages', type: 'expense', parent: '5000' },
  { code: '5200', name: 'Pharmacy and consumables consumed', type: 'expense', parent: '5000' },
  { code: '5300', name: 'Doctor fees and payouts', type: 'expense', parent: '5000' },
  { code: '5400', name: 'Utilities', type: 'expense', parent: '5000' },
  { code: '5500', name: 'Repairs and maintenance', type: 'expense', parent: '5000' },
  { code: '5600', name: 'Depreciation', type: 'expense', parent: '5000' },
  { code: '5900', name: 'Bad debts written off', type: 'expense', parent: '5000' },
];

/**
 * Event → journal.
 *
 * Only the three money events the product actually publishes today have rules.
 * Seeding a rule for an event nothing emits would produce a posting engine that
 * looks configured and posts nothing — worse than an obviously empty one,
 * because the gap is invisible until a close does not tie out.
 *
 * `amountKey` names the payload field each leg is measured from; the poster
 * refuses a key the event does not carry rather than silently posting zero.
 */
interface RuleSpec {
  readonly event: string;
  readonly legs: readonly {
    readonly side: 'DR' | 'CR';
    readonly account: string;
    readonly amountKey: string;
    readonly narration: string;
  }[];
}

const RULES: readonly RuleSpec[] = [
  {
    // A finalised bill earns revenue and creates a receivable. Cash has not
    // moved yet — that is `receipt.issued`.
    //
    // The keys are the ones `bill.finalized` actually carries. The first draft
    // of this file invented `grossAmount` and `taxAmount`; the real payload has
    // `netAmount`, `taxableAmount` and the three GST components, and the poster
    // would have refused every event rather than posting a zero — which is the
    // behaviour we want, but it would have meant a ledger that silently
    // received nothing.
    //
    // Income is `netOfTax`, a derived key, and not `taxableAmount`: most
    // clinical services are GST-exempt in India, so a bill's net is the exempt
    // portion **plus** the taxable portion plus tax. Crediting `taxableAmount`
    // would book ₹100 of income on a ₹693 bill.
    event: 'bill.finalized',
    legs: [
      { side: 'DR', account: '1200', amountKey: 'netAmount', narration: 'Patient receivable' },
      { side: 'CR', account: '4900', amountKey: 'netOfTax', narration: 'Operating income' },
      { side: 'CR', account: '2300', amountKey: 'cgst', narration: 'Output CGST' },
      { side: 'CR', account: '2301', amountKey: 'sgst', narration: 'Output SGST' },
      { side: 'CR', account: '2302', amountKey: 'igst', narration: 'Output IGST' },
    ],
  },
  {
    // Cash arriving clears the receivable. It is not income: the income was
    // recognised when the bill was finalised, and booking it again here is how
    // revenue gets counted twice.
    event: 'receipt.issued',
    legs: [
      { side: 'DR', account: '1100', amountKey: 'amount', narration: 'Cash or bank received' },
      { side: 'CR', account: '1200', amountKey: 'amount', narration: 'Patient receivable cleared' },
    ],
  },
  {
    event: 'refund.issued',
    legs: [
      { side: 'DR', account: '1200', amountKey: 'amount', narration: 'Receivable restored' },
      { side: 'CR', account: '1100', amountKey: 'amount', narration: 'Cash or bank refunded' },
    ],
  },
];

/** April–March, the Indian financial year. */
function fiscalYearOf(today: Date): { code: string; startsOn: string; endsOn: string } {
  const year = today.getUTCFullYear();
  const startYear = today.getUTCMonth() >= 3 ? year : year - 1;
  return {
    code: `FY${String(startYear + 1).slice(2)}`,
    startsOn: `${String(startYear)}-04-01`,
    endsOn: `${String(startYear + 1)}-03-31`,
  };
}

function monthEnd(year: number, monthIndex0: number): string {
  const d = new Date(Date.UTC(year, monthIndex0 + 1, 0));
  return d.toISOString().slice(0, 10);
}

export async function seedFinance(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const now = new Date();
  const fy = fiscalYearOf(now);

  const entities: SeedRow[] = [];
  const books: SeedRow[] = [];
  const years: SeedRow[] = [];
  const periods: SeedRow[] = [];
  const accounts: SeedRow[] = [];
  const rules: SeedRow[] = [];

  for (const hospital of tenancy.hospitals) {
    const entityId = seedId('fin-entity', hospital.code);
    const bookId = seedId('fin-book', hospital.code);
    const yearId = seedId('fin-fy', hospital.code, fy.code);

    entities.push({
      id: entityId,
      hospital_id: hospital.id,
      code: 'MAIN',
      name: hospital.legalName,
      gstin: hospital.gstin,
      state_code: hospital.stateCode,
      base_currency: 'INR',
      active: true,
      updated_at: now,
    });

    books.push({
      id: bookId,
      hospital_id: hospital.id,
      branch_id: null,
      legal_entity_id: entityId,
      code: 'MAIN',
      name: `${hospital.displayName} — main book`,
      mode: 'full_ledger',
      base_currency: 'INR',
      active: true,
      updated_at: now,
    });

    years.push({
      id: yearId,
      hospital_id: hospital.id,
      book_id: bookId,
      code: fy.code,
      starts_on: fy.startsOn,
      ends_on: fy.endsOn,
      status: 'open',
      updated_at: now,
    });

    // Twelve months, all open. A hospital closes them as it goes; seeding them
    // closed would mean a fresh install cannot post its first receipt.
    const startYear = Number(fy.startsOn.slice(0, 4));
    for (let i = 0; i < 12; i += 1) {
      const monthIndex0 = (3 + i) % 12;
      const calendarYear = startYear + (3 + i >= 12 ? 1 : 0);
      const from = `${String(calendarYear)}-${String(monthIndex0 + 1).padStart(2, '0')}-01`;
      periods.push({
        id: seedId('fin-period', hospital.code, fy.code, String(i + 1)),
        hospital_id: hospital.id,
        book_id: bookId,
        fiscal_year_id: yearId,
        period_no: i + 1,
        starts_on: from,
        ends_on: monthEnd(calendarYear, monthIndex0),
        status: 'open',
        closed_by: null,
        closed_at: null,
        updated_at: now,
      });
    }

    for (const spec of CHART) {
      accounts.push({
        id: seedId('fin-account', hospital.code, spec.code),
        hospital_id: hospital.id,
        book_id: bookId,
        parent_id: spec.parent === undefined ? null : seedId('fin-account', hospital.code, spec.parent),
        code: spec.code,
        name: spec.name,
        account_type: spec.type,
        // `normal_balance` is omitted on purpose: a trigger derives it from
        // `account_type`, and a seeded value would be a second opinion.
        is_group: spec.group === true,
        is_bank_or_cash: spec.bankOrCash === true,
        requires_cost_centre: false,
        active: true,
        updated_at: now,
      });
    }

    for (const rule of RULES) {
      let legNo = 0;
      for (const leg of rule.legs) {
        legNo += 1;
        rules.push({
          id: seedId('fin-rule', hospital.code, rule.event, String(legNo)),
          hospital_id: hospital.id,
          book_id: bookId,
          event_type: rule.event,
          leg_no: legNo,
          side: leg.side,
          account_id: seedId('fin-account', hospital.code, leg.account),
          amount_key: leg.amountKey,
          narration_template: leg.narration,
          active: true,
          effective_from: fy.startsOn,
          effective_to: null,
          updated_at: now,
        });
      }
    }
  }

  await ctx.write({ table: 'finance.legal_entities', conflict: ['id'] }, entities);
  await ctx.write({ table: 'finance.books', conflict: ['id'] }, books);
  await ctx.write({ table: 'finance.fiscal_years', conflict: ['id'] }, years);
  await ctx.write({ table: 'finance.fiscal_periods', conflict: ['id'] }, periods);
  // Parents before children: `accounts_parent_id_fkey` is RESTRICT, and the
  // chart above is ordered so a group always precedes its members.
  await ctx.write({ table: 'finance.accounts', conflict: ['id'] }, accounts);
  await ctx.write({ table: 'finance.posting_rules', conflict: ['id'] }, rules);
}
