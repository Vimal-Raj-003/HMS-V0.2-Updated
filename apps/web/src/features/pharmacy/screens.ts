import type { Route } from 'next';

/**
 * The Phase-4 pharmacy screens, declared once.
 *
 * The same reason `features/diagnostics/screens.ts` exists: the left navigation,
 * the console home and the ⌘K palette are three navigation surfaces, and
 * `docs/06` §4.1 — "never render an item the user cannot use" — applies to all
 * three identically. Declaring the list three times is how a screen ends up
 * reachable from the palette by somebody whose menu correctly hid it.
 *
 * ── On `entitlement: null` ──────────────────────────────────────────────────
 *
 * Three screens carry no licence gate, and that is `EN-040 §5` rather than an
 * oversight. The permission catalogue marks `pharmacy.queue.read`,
 * `pharmacy.queue.list`, `pharmacy.dispense.create`, `pharmacy.dispense.complete`,
 * `pharmacy.narcotic.prepare`, `pharmacy.recall.manage` and `pharmacy.recall.trace`
 * `clinicalSafetyExempt`, so the policy engine's licence check can never refuse
 * them. A hospital in arrears still gets its patients their medicines, still
 * gets its controlled drugs to the people who need them, and still gets a recall
 * out. A gate a lapsed subscription could switch off is not a gate.
 *
 * ── On the two entitlement keys that are named here ─────────────────────────
 *
 * `module.pharmacy.enabled` and `module.inventory.enabled` are **not yet in**
 * `packages/contracts`'s entitlement catalogue — which today holds only the
 * Phase-0 platform keys. Naming them here is the same thing
 * `features/diagnostics/screens.ts` does with `module.lab.enabled`: it declares
 * the intent where the licence check will read it. Adding them is a
 * `packages/contracts` change and those are outside this change's remit, so it
 * is reported as a gap rather than smuggled in. Nothing in this application
 * currently *enforces* an entitlement, so no screen is hidden by the omission.
 *
 * ── On i18n ─────────────────────────────────────────────────────────────────
 *
 * `CLAUDE.md` §4 requires every user-visible string to come from a `next-intl`
 * key. `next-intl` is a declared dependency of `apps/web` and the catalogues
 * exist in `packages/i18n/src/messages/*.json`, but **no screen in this
 * application uses it**: there is no `NextIntlClientProvider` in the tree, no
 * `i18n/request.ts`, and every string in `features/admin`, `features/frontoffice`,
 * `features/clinical` and `features/diagnostics` is an English literal. This
 * feature follows the pattern that exists rather than introducing a second one,
 * because a single feature reading from a provider nothing mounts would render
 * every label as its own key. It is reported as a gap, unchanged from Phase 3.
 *
 * The one place a language is genuinely user-facing here is the **medicine
 * label**, and that is not a UI string: `phase-04` exit gate 2's second language
 * comes from the API's own translation table via `POST /dispenses/{id}/labels`,
 * so it works today whether or not `next-intl` is ever mounted.
 */
export interface PharmacyScreen {
  readonly key: string;
  readonly label: string;
  readonly href: Route;
  /** Which console this belongs to, for grouping in the nav and the hub. */
  readonly area: 'counter' | 'stock' | 'registers';
  /** The **API's** permission key, so the screen is offered when its work would succeed. */
  readonly permission: string;
  /** One line for the hub tile and the palette's secondary text. */
  readonly summary: string;
  /** Shown on the permission-denied state, in plain words (`docs/06` §6.7). */
  readonly deniedExplanation: string;
  /** ⌘K keywords beyond the label — what a user would actually type. */
  readonly keywords: readonly string[];
  /** Licence entitlement key, or `null` where clinical safety forbids gating. */
  readonly entitlement: string | null;
}

export const PHARMACY_SCREENS: readonly PharmacyScreen[] = [
  {
    key: 'pharmacy-queue',
    label: 'Prescription queue',
    href: '/pharmacy/queue',
    area: 'counter',
    // `GET /pharmacy/queue` is gated on this exact key.
    permission: 'pharmacy.queue.list',
    summary:
      'Every prescription waiting at this counter, loudest first, with the identity check that has to happen before a bag is opened.',
    deniedExplanation:
      'The prescription queue is held by pharmacy counter staff. Doctors write prescriptions; the people at the counter see the queue they make.',
    keywords: ['queue', 'rx', 'prescription', 'waiting', 'counter', 'pharmacy', 'token', 'arrived'],
    // EN-040 §5: `pharmacy.queue.list` and `.read` are `clinicalSafetyExempt`.
    // A queue a counter cannot see is a counter that has stopped.
    entitlement: null,
  },
  {
    key: 'pharmacy-counter',
    label: 'Dispensing counter',
    href: '/pharmacy/counter',
    area: 'counter',
    permission: 'pharmacy.dispense.create',
    summary:
      'Scan the patient, scan each pack. Batch and expiry are validated at the scan, allergy and interaction are hard stops, and a narcotic needs a second pharmacist at the counter.',
    deniedExplanation:
      'Opening a dispense is a pharmacist’s permission. Completing one is a further key again, and it needs a registered pharmacist profile.',
    keywords: [
      'dispense',
      'dispensing',
      'counter',
      'scan',
      'barcode',
      'batch',
      'fefo',
      'label',
      'substitute',
      'partial',
      'narcotic',
      'allergy',
    ],
    // `pharmacy.dispense.create` and `.complete` are both `clinicalSafetyExempt`.
    // This is medicine reaching a patient; an invoice does not get a vote.
    entitlement: null,
  },
  {
    key: 'pharmacy-sales',
    label: 'Counter sales',
    href: '/pharmacy/sales',
    area: 'counter',
    /**
     * Gated on the key that names what the screen is *for* rather than on the
     * key of its first request (`pharmacy.stock.list`), which is the rule
     * `features/diagnostics` follows. The deviation is deliberate: the stock
     * list is held by every storekeeper in the building, and offering them a
     * till they may not operate is worse than the alternative. The screen checks
     * `pharmacy.stock.list` and `pharmacy.dispense.create` separately and says
     * which one is missing.
     */
    permission: 'pharmacy.otc.sell',
    summary:
      'Over-the-counter sale with the Schedule H refusal built in: a prescription-only medicine cannot leave on a walk-in sale, and the screen says which rule refuses it.',
    deniedExplanation:
      'Selling over the counter is a pharmacist’s permission. It is separate from dispensing against a prescription because the rules that govern it are different ones.',
    keywords: ['otc', 'counter sale', 'walk-in', 'sale', 'schedule h', 'till', 'cash'],
    entitlement: 'module.pharmacy.enabled',
  },
  {
    key: 'pharmacy-returns',
    label: 'Returns desk',
    href: '/pharmacy/returns',
    area: 'counter',
    permission: 'pharmacy.return.create',
    summary:
      'A patient return against its original dispense, line by line, with the disposition that decides whether the units go back on the shelf or into quarantine.',
    deniedExplanation:
      'Raising a return is a counter permission. Approving one is a different key held by the pharmacy in-charge, because approval is what moves the stock.',
    keywords: ['return', 'refund', 'credit note', 'restock', 'quarantine', 'patient return'],
    entitlement: 'module.pharmacy.enabled',
  },
  {
    key: 'pharmacy-expiry',
    label: 'Expiry & near-expiry',
    href: '/pharmacy/expiry',
    area: 'stock',
    permission: 'pharmacy.expiry.read',
    summary:
      'What is about to expire on this counter, what it is worth, and the six things that may lawfully be done about it — each with a reason and a value at cost.',
    deniedExplanation:
      'The expiry board is held by pharmacy staff. Deciding what happens to near-expiry stock is a further permission, and every decision records a reason.',
    keywords: ['expiry', 'near expiry', 'expired', 'write off', 'writeoff', 'disposal', 'quarantine', 'bmw'],
    entitlement: 'module.pharmacy.enabled',
  },
  {
    key: 'pharmacy-recalls',
    label: 'Recall console',
    href: '/pharmacy/recalls',
    area: 'stock',
    permission: 'pharmacy.recall.read',
    summary:
      'Raise a batch recall — which quarantines it everywhere before anybody produces a list — then trace the patients who received some of it.',
    deniedExplanation:
      'Reading the recall register is held by pharmacy and quality staff. Producing the list of affected patients is a further permission again, because that list is patient data.',
    keywords: ['recall', 'batch', 'cdsco', 'quarantine', 'trace', 'affected patients', 'nppa'],
    // `pharmacy.recall.manage` and `.trace` are `clinicalSafetyExempt`: a recall
    // does not wait for an invoice.
    entitlement: null,
  },
  {
    key: 'pharmacy-controlled',
    label: 'Controlled-drug register',
    href: '/pharmacy/controlled',
    area: 'registers',
    permission: 'pharmacy.narcotic.list',
    summary:
      'The NDPS, Schedule X and Schedule H1 registers with their running balances, and the shift custody check — both of which take two pharmacists, each with their own password.',
    deniedExplanation:
      'The controlled-drug register names patients and prescribers, so it is a PHI read behind fresh strong authentication and is held by pharmacists and the pharmacy in-charge. Making an entry needs a second authorised pharmacist as well as you.',
    keywords: [
      'narcotic',
      'ndps',
      'controlled',
      'register',
      'schedule x',
      'h1',
      'custody',
      'balance',
      'dual authorisation',
      'morphine',
    ],
    entitlement: 'module.pharmacy.enabled',
  },
  {
    key: 'pharmacy-day-close',
    label: 'Day close',
    href: '/pharmacy/day-close',
    area: 'registers',
    permission: 'pharmacy.day_close.list',
    summary:
      'Cash, credit and stock reconciled for a business date — refused while a controlled-drug variance on that date is still open.',
    deniedExplanation:
      'The day close is held by the pharmacy in-charge and the cashier. It is the record a shift is signed off against, so it is not a counter permission.',
    keywords: ['day close', 'shift', 'reconcile', 'cash', 'variance', 'end of day', 'closing'],
    entitlement: 'module.pharmacy.enabled',
  },
];

export function pharmacyScreen(key: string): PharmacyScreen {
  const screen = PHARMACY_SCREENS.find((candidate) => candidate.key === key);
  if (screen === undefined) throw new Error(`Unknown pharmacy screen: ${key}`);
  return screen;
}

export function pharmacyScreensInArea(area: PharmacyScreen['area']): readonly PharmacyScreen[] {
  return PHARMACY_SCREENS.filter((screen) => screen.area === area);
}

export const PHARMACY_AREA_LABELS: Readonly<Record<PharmacyScreen['area'], string>> = {
  counter: 'The counter',
  stock: 'Stock on the counter',
  registers: 'Registers & close',
};

/**
 * The hub route. It carries no permission of its own: it renders only the tiles
 * the session can open, and says so when that is none. Gating the hub would turn
 * "you hold one of these eight keys" into a 403 for everybody who holds seven.
 */
export const PHARMACY_HOME: Route = '/pharmacy';

export const PHARMACY_ROUTES: readonly Route[] = [
  PHARMACY_HOME,
  ...PHARMACY_SCREENS.map((screen) => screen.href),
];
