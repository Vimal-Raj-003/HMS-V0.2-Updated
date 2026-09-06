import type { Route } from 'next';

/**
 * The Phase-4 stores, purchase and vendor screens, declared once.
 *
 * The same contract as `features/pharmacy/screens.ts` and
 * `features/diagnostics/screens.ts`: the left navigation, the console home and
 * the ⌘K palette are three navigation surfaces reading one list, because a
 * screen added to one and forgotten in another is how somebody ends up reaching
 * a page their navigation deliberately hid.
 *
 * ── Nothing here is licence-exempt ──────────────────────────────────────────
 *
 * Unlike the pharmacy counter, none of these screens is on the path a medicine
 * takes to a patient, so all of them carry `module.inventory.enabled`. A
 * hospital in arrears still dispenses; it does not still raise purchase orders.
 * The one place that reasoning could go wrong is the stock console — a
 * pharmacist who cannot see stock cannot dispense — and it does not, because the
 * counter reads `GET /pharmacy/stock` on the ungated pharmacy side rather than
 * this console.
 *
 * `module.inventory.enabled` is **not yet in** `packages/contracts`'s
 * entitlement catalogue; see the note in `features/pharmacy/screens.ts`. It is
 * named here where the licence check will read it, and reported as a gap.
 */
export interface InventoryScreen {
  readonly key: string;
  readonly label: string;
  readonly href: Route;
  readonly area: 'stores' | 'movements' | 'purchase' | 'consignment';
  /** The **API's** permission key, so the screen is offered when its list would load. */
  readonly permission: string;
  readonly summary: string;
  readonly deniedExplanation: string;
  readonly keywords: readonly string[];
  readonly entitlement: string | null;
}

export const INVENTORY_SCREENS: readonly InventoryScreen[] = [
  {
    key: 'inventory-items',
    label: 'Item master',
    href: '/inventory/items',
    area: 'stores',
    // `GET /inventory/items` is gated on this exact key.
    permission: 'inventory.item.list',
    summary:
      'Search the master by name, code or barcode: the UoM ladder, the schedule flags, the HSN code and the storage condition that decides which fridge it lives in.',
    deniedExplanation:
      'The item master is held by stores, pharmacy and purchase staff. Creating and editing items are separate permissions again, because a UoM factor typed wrong is every quantity of that item wrong.',
    keywords: ['item', 'master', 'drug', 'consumable', 'implant', 'barcode', 'gtin', 'hsn', 'uom', 'search'],
    entitlement: 'module.inventory.enabled',
  },
  {
    key: 'inventory-stock',
    label: 'Stock & ledger',
    href: '/inventory/stock',
    area: 'stores',
    permission: 'inventory.stock.list',
    summary:
      'What is on which shelf, by batch and expiry; where an item is available across stores; the append-only ledger behind every figure; and the integrity check that proves they agree.',
    deniedExplanation:
      'Reading stock balances is held by stores, pharmacy and clinical staff who need to know whether something is available. Moving stock is a different permission for every kind of movement.',
    keywords: [
      'stock',
      'balance',
      'on hand',
      'availability',
      'batch',
      'expiry',
      'ledger',
      'movement',
      'fefo',
      'integrity',
      'trace',
    ],
    entitlement: 'module.inventory.enabled',
  },
  {
    key: 'inventory-indents',
    label: 'Indents & issues',
    href: '/inventory/indents',
    area: 'movements',
    permission: 'inventory.store_indent.list',
    summary:
      'A ward or sub-store asks, the holding store approves a quantity, FEFO proposes the batches, and the receiving end confirms what actually arrived.',
    deniedExplanation:
      'Raising an indent is held by every department that draws stock. Approving one is held by the store that gives it away, and the two are deliberately different hands.',
    keywords: ['indent', 'issue', 'ward stock', 'pick list', 'requisition', 'sub-store', 'receive'],
    entitlement: 'module.inventory.enabled',
  },
  {
    key: 'inventory-transfers',
    label: 'Transfers',
    href: '/inventory/transfers',
    area: 'movements',
    permission: 'inventory.transfer.list',
    summary:
      'Stock moving between stores, with the in-transit state made visible: between dispatch and receipt it belongs to neither shelf, and neither store may issue it.',
    deniedExplanation:
      'Transfers are held by store keepers. Approving, dispatching and receiving one are three further permissions, because a transfer nobody checked is a transfer that never arrived.',
    keywords: ['transfer', 'in transit', 'dispatch', 'gate pass', 'inter-store', 'receive', 'eway'],
    entitlement: 'module.inventory.enabled',
  },
  {
    key: 'inventory-adjustments',
    label: 'Adjustments & counts',
    href: '/inventory/adjustments',
    area: 'movements',
    permission: 'inventory.adjustment.list',
    summary:
      'Corrections and cycle counts. Nothing here edits a ledger row — an adjustment is a new compensating entry with a reason, approved by somebody other than the person who raised it.',
    deniedExplanation:
      'Raising an adjustment is a store keeper’s permission; approving one is the store manager’s, and the database refuses the same person doing both.',
    keywords: [
      'adjustment',
      'write off',
      'writeoff',
      'damage',
      'count',
      'cycle count',
      'variance',
      'stock take',
      'physical',
    ],
    entitlement: 'module.inventory.enabled',
  },
  {
    key: 'inventory-purchase',
    label: 'Purchase orders',
    href: '/inventory/purchase',
    area: 'purchase',
    permission: 'inventory.po.list',
    summary:
      'Purchase indent to approved order, through the RFQ and the comparative statement that compares landed cost per base unit rather than headline price.',
    deniedExplanation:
      'Raising a purchase order is held by the purchase department. Approving one is held by whoever the approval matrix names, and never by the person who raised it.',
    keywords: ['purchase', 'po', 'order', 'indent', 'rfq', 'quotation', 'comparative', 'l1', 'tender'],
    entitlement: 'module.inventory.enabled',
  },
  {
    key: 'inventory-grn',
    label: 'Goods receipt',
    href: '/inventory/grn',
    area: 'purchase',
    permission: 'inventory.grn.list',
    summary:
      'Receive against an order with batch, expiry and MRP captured at the door — the only moment those facts are cheap to get right — then quality-check and post it into stock.',
    deniedExplanation:
      'Receiving goods is held by the stores gate. Posting a receipt into stock is a further permission, because that is the moment the quantity becomes real.',
    keywords: ['grn', 'goods receipt', 'receive', 'batch', 'expiry', 'mrp', 'qc', 'delivery', 'invoice'],
    entitlement: 'module.inventory.enabled',
  },
  {
    key: 'inventory-invoices',
    label: 'Three-way match',
    href: '/inventory/invoices',
    area: 'purchase',
    permission: 'inventory.invoice.list',
    summary:
      'The exception queue: every vendor invoice that disagrees with its purchase order or its goods receipt, with the difference named line by line.',
    deniedExplanation:
      'The match queue is held by accounts payable and the purchase department. Passing an invoice for payment and disputing one are separate permissions again.',
    keywords: ['invoice', 'three way', '3-way', 'match', 'exception', 'payable', 'dispute', 'tolerance'],
    entitlement: 'module.inventory.enabled',
  },
  {
    key: 'inventory-vendors',
    label: 'Vendors',
    href: '/inventory/vendors',
    area: 'purchase',
    permission: 'vendor.master.list',
    summary:
      'The supplier master with its GSTIN, drug licence validity and rate contracts — and the maker-checker approval the database refuses to let one person do alone.',
    deniedExplanation:
      'The vendor master is held by the purchase department. Approving a vendor is a different key from creating one, and the service refuses the specific person who created the record.',
    keywords: [
      'vendor',
      'supplier',
      'gstin',
      'pan',
      'drug licence',
      'rate contract',
      'blacklist',
      'lead time',
    ],
    entitlement: 'module.inventory.enabled',
  },
  {
    key: 'inventory-consignment',
    label: 'Consignment',
    href: '/inventory/consignment',
    area: 'consignment',
    permission: 'inventory.consignment.agreement.list',
    summary:
      'Stock on our shelves that is not ours: the vendor agreements behind it, what the theatre used, and the monthly reconciliation both sides sign before an invoice is raised.',
    deniedExplanation:
      'Consignment is held by stores, theatre and the purchase department. Recording a usage, approving an agreement and signing a reconciliation are four different permissions, because the usage is what creates the liability to pay.',
    keywords: [
      'consignment',
      'implant',
      'agreement',
      'vendor stock',
      'usage',
      'reconciliation',
      'auto po',
      'replenishment',
      'udi',
      'theatre',
    ],
    entitlement: 'module.inventory.enabled',
  },
  {
    key: 'inventory-consumption',
    label: 'Consumption entry',
    href: '/inventory/consumption',
    area: 'consignment',
    permission: 'inventory.consumption.list',
    summary:
      'What each ward, theatre and department actually took off the shelf. Entries are reversed with a reason, never edited — the ledger behind them is append-only.',
    deniedExplanation:
      'Consumption entry is held by the ward or department that draws the stock. Reversing an entry is a separate permission, because a reversal moves a quantity back.',
    keywords: [
      'consumption',
      'cost centre',
      'cost center',
      'department',
      'ward',
      'expense',
      'issue',
      'usage',
      'roll-up',
      'period',
    ],
    entitlement: 'module.inventory.enabled',
  },
  {
    key: 'inventory-cost-centres',
    label: 'Cost centres',
    href: '/inventory/cost-centres',
    area: 'consignment',
    // A finance key, not a stores one. The consumption console next door is
    // gated on `inventory.consumption.list`, which finance does not hold — the
    // two halves of NC-008 are two screens for exactly that reason.
    permission: 'finance.costcentre.read',
    summary:
      'What each ward, theatre and department consumed in a period, and the cost-centre master behind the attribution — including the consumption nobody costed.',
    deniedExplanation:
      'The cost-centre roll-up is held by accounts and department heads. It is a finance permission rather than a stores one, so holding the consumption list does not grant it.',
    keywords: [
      'cost centre',
      'cost center',
      'roll-up',
      'rollup',
      'period',
      'expense',
      'department',
      'allocation',
      'finance',
      'month end',
    ],
    entitlement: 'module.inventory.enabled',
  },
];

export function inventoryScreen(key: string): InventoryScreen {
  const screen = INVENTORY_SCREENS.find((candidate) => candidate.key === key);
  if (screen === undefined) throw new Error(`Unknown inventory screen: ${key}`);
  return screen;
}

export function inventoryScreensInArea(area: InventoryScreen['area']): readonly InventoryScreen[] {
  return INVENTORY_SCREENS.filter((screen) => screen.area === area);
}

export const INVENTORY_AREA_LABELS: Readonly<Record<InventoryScreen['area'], string>> = {
  stores: 'Masters & stock',
  movements: 'Stock movements',
  purchase: 'Purchase to pay',
  consignment: 'Consignment & consumption',
};

/** The hub. No permission of its own — it renders only the tiles you can open. */
export const INVENTORY_HOME: Route = '/inventory';

export const INVENTORY_ROUTES: readonly Route[] = [
  INVENTORY_HOME,
  ...INVENTORY_SCREENS.map((screen) => screen.href),
];
