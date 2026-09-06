import type { Route } from 'next';

/**
 * The Phase-5 revenue-cycle screens, declared once.
 *
 * Same contract as `features/inventory/screens.ts`: the left navigation, the
 * console home and the ⌘K palette read one list, because a screen added to one
 * surface and forgotten in another is how somebody reaches a page their
 * navigation deliberately hid.
 *
 * `module.rcm.enabled` is **not yet in** `packages/contracts`'s entitlement
 * catalogue — the same gap `features/inventory/screens.ts` records for
 * `module.inventory.enabled`. It is named here where the licence check will read
 * it, and reported as a gap rather than silently omitted.
 */
export interface RcmScreen {
  readonly key: string;
  readonly label: string;
  readonly href: Route;
  readonly area:
    | 'pricing'
    | 'billing'
    | 'payments'
    | 'packages'
    | 'insurance'
    | 'schemes'
    | 'estimates'
    | 'leakage'
    | 'payouts';
  /** The **API's** permission key, so the screen is offered when its list loads. */
  readonly permission: string;
  readonly summary: string;
  readonly deniedExplanation: string;
  readonly keywords: readonly string[];
  readonly entitlement: string | null;
}

export const RCM_SCREENS: readonly RcmScreen[] = [
  {
    key: 'rcm-payouts',
    label: 'Doctor payouts',
    href: '/rcm/payouts',
    area: 'payouts',
    // The statement list. A doctor holds this to read their own; finance and
    // the hospital admin hold it to work the run. Gating on the compute or
    // approve key would hide the screen from the person whose money it is.
    permission: 'payout.statement.list',
    summary:
      'What each doctor earned on work they performed, the section 194J deduction, and any dispute. A payment for a referral has no shape in this system, so the question never arises.',
    deniedExplanation:
      'Payouts are held by finance, the hospital admin and the doctors themselves. Computing a statement and releasing it for payment are two permissions on purpose \u2014 a payout is an outbound payment authorised on a calculation nobody else has checked.',
    keywords: [
      'payout',
      'doctor payout',
      'fee share',
      'retainer',
      'visiting',
      'tds',
      '194j',
      'statement',
      'dispute',
      'nmc',
      'referral',
      'kickback',
      'earnings',
    ],
    entitlement: 'module.rcm.enabled',
  },
  {
    key: 'rcm-leakage',
    label: 'Revenue leakage',
    href: '/rcm/leakage',
    area: 'leakage',
    // The worklist. Gating on `leak.finding.accept` would hide it from the
    // billing desk, who raise the charge once finance accepts a finding and so
    // are the people who most need to see it.
    permission: 'leak.finding.list',
    summary:
      'Things that were delivered and never charged: tests, dispensed drugs, implants, and discounts nobody approved. Every row is a proposal — nothing here bills anybody.',
    deniedExplanation:
      'The leakage worklist is held by finance and the billing desk. Agreeing a gap is real is finance\u2019s key: §5.7 says the audit never auto-posts, and that only means something if the person accepting is accountable for the charge that follows.',
    keywords: [
      'leakage',
      'missed charge',
      'unbilled',
      'reconciliation',
      'audit',
      'recovery',
      'discharge check',
      'implant',
      'consumable',
      'discount audit',
      'underbilled',
    ],
    entitlement: 'module.rcm.enabled',
  },
  {
    key: 'rcm-estimates',
    label: 'Cost estimates',
    href: '/rcm/estimates',
    area: 'estimates',
    // The quote list. Gating on `est.variance.read` would hide the screen from
    // the desk that writes the quotes, and gating on `est.issue` would hide it
    // from finance, who measure them and deliberately do not issue.
    permission: 'est.list',
    summary:
      'What a family was quoted, when they were told, and what the bill turned out to be. An issued estimate is fixed and is revised by superseding it, so both numbers survive the conversation at discharge.',
    deniedExplanation:
      'Estimates are held by the billing desk and finance. Writing a quote and measuring it against the bill it became are two permissions on purpose — a hospital does not learn that its quotes run light from the people writing them.',
    keywords: [
      'estimate',
      'quote',
      'cost',
      'estimator',
      'nabh',
      'transparency',
      'variance',
      'estimate vs actual',
      'package price',
      'room class',
      'co-pay',
      'advance',
      'enquiry',
    ],
    entitlement: 'module.rcm.enabled',
  },
  {
    key: 'rcm-schemes',
    label: 'Government schemes',
    href: '/rcm/schemes',
    area: 'schemes',
    // The claim list, which is what the desk works. Gating on
    // `scheme.cash.attempt.read` would have hidden the screen from anyone
    // without the audit key; gating on a write key would have hidden it from
    // finance, who hold the checker half deliberately and not the maker half.
    permission: 'scheme.claim.list',
    summary:
      'PMJAY, CGHS, ECHS, ESIC and state schemes: which claims are running out of window, what each authority short-paid, and every cash tender the system refused.',
    deniedExplanation:
      'Government schemes are held by the scheme desk and finance. Submitting a claim and recording what the authority paid are two permissions on purpose, and so are asking for a write-off and approving one.',
    keywords: [
      'scheme',
      'pmjay',
      'ayushman',
      'cghs',
      'echs',
      'esic',
      'hbp',
      'beneficiary',
      'entitlement',
      'claim',
      'shortfall',
      'write-off',
      'cash block',
      'government',
      'empanelment',
    ],
    entitlement: 'module.rcm.enabled',
  },
  {
    key: 'rcm-preauth',
    label: 'Pre-authorisation',
    href: '/rcm/preauth',
    area: 'insurance',
    permission: 'preauth.list',
    summary:
      'What each insurer has been asked for, what they have answered, and what is running out of time. A missed deadline turns a cashless admission into one the family funds themselves.',
    deniedExplanation:
      'Pre-authorisation is held by the insurance desk and finance. Submitting a request and recording the payer\u2019s answer are two permissions on purpose: an approval nobody received must not be typeable by the person waiting for it.',
    keywords: [
      'preauth',
      'pre-authorisation',
      'insurance',
      'tpa',
      'cashless',
      'payer',
      'approval',
      'query',
      'sla',
      'denial',
      'credit limit',
      'policy',
    ],
    entitlement: 'module.rcm.enabled',
  },
  {
    key: 'rcm-packages',
    label: 'Packages',
    href: '/rcm/packages',
    area: 'packages',
    // Reading the overrun queue, not raising one. Gating this on
    // `pkg.variance.request` locked finance out of the screen built for them:
    // the segregation rule means they hold `approve` and deliberately not
    // `request`. Both halves hold `pkg.activation.read`.
    permission: 'pkg.activation.read',
    summary:
      'Fixed-price promises and every charge that went past one. An overrun waits for a decision here — it is never billed to a family who was quoted a package price.',
    deniedExplanation:
      'Packages are held by the billing desk and finance. Asking to bill beyond a package and deciding who pays are two permissions on purpose: OP-023 §5 requires that approval before the excess reaches the bill.',
    keywords: [
      'package',
      'bundle',
      'fixed price',
      'variance',
      'overrun',
      'cap',
      'excess',
      'maternity',
      'surgery package',
      'health checkup',
      'activation',
    ],
    entitlement: 'module.rcm.enabled',
  },
  {
    key: 'rcm-payments',
    label: 'Payments',
    href: '/rcm/payments',
    area: 'payments',
    permission: 'pay.recon.read',
    summary:
      'What the gateway says, what the receipt book says and what the settlement file says — and every case where those three disagree, including money the hospital is holding that no bill claims.',
    deniedExplanation:
      'Payments and reconciliation are held by finance. Asking for a refund and approving one are two permissions on purpose: a refund goes back through the instrument it came from, so one person doing both is the largest fraud exposure in the payment path.',
    keywords: [
      'payment',
      'gateway',
      'razorpay',
      'upi',
      'webhook',
      'settlement',
      'reconciliation',
      'unapplied',
      'refund',
      'chargeback',
      'exception',
    ],
    entitlement: 'module.rcm.enabled',
  },
  {
    key: 'rcm-billing',
    label: 'Billing',
    href: '/rcm/billing',
    area: 'billing',
    permission: 'bill.list',
    summary:
      'Bills for every OP visit: what was charged, what tax applies, what is held for want of a rate, and the discounts waiting on somebody else to agree.',
    deniedExplanation:
      'Billing is held by the billing desk and finance. Asking for a discount and approving one are two different permissions on purpose — OP-005 §5 makes requester and approver different hands.',
    keywords: [
      'bill',
      'billing',
      'invoice',
      'gst',
      'tax invoice',
      'bill of supply',
      'discount',
      'credit note',
      'finalise',
      'collect',
      'balance',
    ],
    entitlement: 'module.rcm.enabled',
  },
  {
    key: 'rcm-tariff',
    label: 'Tariff',
    href: '/rcm/tariff',
    area: 'pricing',
    permission: 'tariff.plan.list',
    summary:
      'The pricing authority every bill line calls: rate plans, their effective-dated versions, the grid inside each one, and the rate checker that shows why a price is what it is.',
    deniedExplanation:
      'The tariff is held by finance. Building a revision, submitting it and publishing it are three different permissions on purpose — RC-003 §5 makes requester and approver different hands, and publishing reprices every bill from that instant.',
    keywords: [
      'tariff',
      'rate',
      'price',
      'plan',
      'version',
      'publish',
      'self pay',
      'corporate',
      'scheme',
      'cghs',
      'pmjay',
      'gst',
      'rate card',
    ],
    entitlement: 'module.rcm.enabled',
  },
  {
    key: 'rcm-missing-rates',
    label: 'Missing rates',
    href: '/rcm/missing-rates',
    area: 'pricing',
    permission: 'tariff.missing.read',
    summary:
      'Every service a bill could not price. Nothing here was billed at zero — the line was held, which is why this list is the first place to look for revenue leakage.',
    deniedExplanation:
      'The missing-rate worklist is held by the tariff desk and finance. Closing an entry — pricing it or waiving it — is a separate permission again.',
    keywords: ['missing rate', 'unpriced', 'leakage', 'worklist', 'blocked', 'hold', 'tariff gap'],
    entitlement: 'module.rcm.enabled',
  },
];

export function rcmScreen(key: string): RcmScreen {
  const screen = RCM_SCREENS.find((candidate) => candidate.key === key);
  if (screen === undefined) throw new Error(`Unknown RCM screen: ${key}`);
  return screen;
}

export function rcmScreensInArea(area: RcmScreen['area']): readonly RcmScreen[] {
  return RCM_SCREENS.filter((screen) => screen.area === area);
}

export const RCM_AREA_LABELS: Readonly<Record<RcmScreen['area'], string>> = {
  billing: 'Billing',
  estimates: 'Estimates',
  insurance: 'Insurance',
  leakage: 'Revenue leakage',
  schemes: 'Government schemes',
  packages: 'Packages',
  payments: 'Payments',
  payouts: 'Doctor payouts',
  pricing: 'Pricing',
};

export const RCM_ROUTES: readonly Route[] = RCM_SCREENS.map((screen) => screen.href);
