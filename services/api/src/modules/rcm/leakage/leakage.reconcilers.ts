import type { TransactionClient } from '../../../core/db/database.service.js';

/**
 * The four reconciliations, as SQL.
 *
 * ── Why these are code and not configuration ────────────────────────────────
 *
 * `docs/prompts/phase-05` calls for reconciling "orders vs charges, consumables
 * issued vs billed, doctor visits, procedure charges". Each is a join between
 * two schemas with its own notion of what "delivered" means — a lab order is
 * `completed`, a dispense is `dispensed`, an implant is `used` and specifically
 * not `wasted` or `reversed`. A settings screen cannot express that, and
 * pretending it could would mean a half-expressive rule language that gets one
 * of them subtly wrong.
 *
 * What *is* configuration lives in `leak_rules`: whether a reconciler runs, the
 * gap below which it stays quiet, and how far back it looks.
 *
 * ── Every one of them is deliberately conservative ──────────────────────────
 *
 * A false positive here becomes a charge on a family's bill for something they
 * did not receive — which is the failure mode the "never auto-post" rule exists
 * to catch, but the worklist should not be manufacturing them either. So each
 * query excludes the states where not billing is *correct*: a cancelled order, a
 * reversed implant, a dispense still awaiting payment, a bill that was voided.
 */

export interface ReconcilerRow {
  readonly source_ref_type: string;
  readonly source_ref_id: string;
  readonly patient_id: string | null;
  readonly encounter_id: string | null;
  readonly description: string;
  readonly service_name: string | null;
  readonly expected_amount: string;
  readonly billed_amount: string;
  readonly occurred_at: string | null;
}

export interface ReconcilerContext {
  readonly hospitalId: string;
  readonly branchId: string;
  readonly encounterId: string | null;
  readonly since: string;
  readonly minGap: string;
}

type Reconciler = (tx: TransactionClient, ctx: ReconcilerContext) => Promise<readonly ReconcilerRow[]>;

/**
 * A delivered order line with no charge against it.
 *
 * The classic missed test: the sample was taken, the result went on the chart,
 * and nobody raised the charge. Exit gate 9's scenario.
 *
 * `price_snapshot` is the expected amount rather than a live tariff lookup —
 * `clinical.order_items` records the price in force when the order was placed
 * precisely so a later revision cannot reprice history, and the gap should be
 * measured against what the charge would have been on the day.
 */
const ordersVsCharges: Reconciler = async (tx, ctx) => {
  const { rows } = await tx.query<ReconcilerRow>(
    `SELECT 'clinical.order_item'            AS source_ref_type,
            oi.id                            AS source_ref_id,
            o.patient_id                     AS patient_id,
            o.encounter_id                   AS encounter_id,
            'Delivered and not charged: ' || oi.service_name AS description,
            oi.service_name                  AS service_name,
            oi.price_snapshot::text          AS expected_amount,
            '0'::text                        AS billed_amount,
            oi.updated_at                    AS occurred_at
       FROM clinical.order_items oi
       JOIN clinical.orders o ON o.id = oi.order_id
      WHERE oi.hospital_id = $1
        AND oi.status = 'completed'
        AND oi.price_snapshot IS NOT NULL
        AND oi.price_snapshot >= $4::numeric
        AND oi.updated_at >= $3::timestamptz
        AND ($2::uuid IS NULL OR o.encounter_id = $2)
        AND NOT EXISTS (
          SELECT 1
            FROM billing.bill_items bi
            JOIN billing.bills b ON b.id = bi.bill_id
           WHERE bi.source_ref_id = oi.id
             AND b.status NOT IN ('cancelled', 'void')
        )`,
    [ctx.hospitalId, ctx.encounterId, ctx.since, ctx.minGap],
  );
  return rows;
};

/**
 * Drugs handed across the counter and never billed.
 *
 * `awaiting_payment` is excluded on purpose — that dispense is *waiting* to be
 * billed, and flagging it would fill the worklist with rows that resolve
 * themselves in the next few minutes.
 */
const dispenseVsCharges: Reconciler = async (tx, ctx) => {
  const { rows } = await tx.query<ReconcilerRow>(
    `SELECT 'pharmacy.dispense'              AS source_ref_type,
            d.id                             AS source_ref_id,
            d.patient_id                     AS patient_id,
            d.encounter_id                   AS encounter_id,
            'Dispensed and not charged: ' || d.dispense_no AS description,
            d.dispense_no                    AS service_name,
            d.total_amount::text             AS expected_amount,
            '0'::text                        AS billed_amount,
            d.dispensed_at                   AS occurred_at
       FROM pharmacy.dispenses d
      WHERE d.hospital_id = $1
        AND d.status IN ('dispensed', 'partially_dispensed')
        AND d.total_amount >= $4::numeric
        AND d.dispensed_at >= $3::timestamptz
        AND ($2::uuid IS NULL OR d.encounter_id = $2)
        AND d.bill_ref IS NULL
        AND NOT EXISTS (
          SELECT 1
            FROM billing.bill_items bi
            JOIN billing.bills b ON b.id = bi.bill_id
           WHERE bi.source_ref_id = d.id
             AND b.status NOT IN ('cancelled', 'void')
        )`,
    [ctx.hospitalId, ctx.encounterId, ctx.since, ctx.minGap],
  );
  return rows;
};

/**
 * An implant scanned into a patient and never charged.
 *
 * Individually the largest leak in most hospitals — a single unbilled cup or
 * plate is tens of thousands of rupees. `wasted` and `reversed` are excluded
 * because neither is billable to the patient: a wasted implant is a dispute with
 * the vendor and a reversed one never went in.
 */
const consignmentVsCharges: Reconciler = async (tx, ctx) => {
  const { rows } = await tx.query<ReconcilerRow>(
    `SELECT 'inventory.csn_usage'            AS source_ref_type,
            u.id                             AS source_ref_id,
            u.patient_id                     AS patient_id,
            u.encounter_id                   AS encounter_id,
            'Implant used and not charged: ' || u.usage_no AS description,
            u.usage_no                       AS service_name,
            COALESCE(u.billed_amount, u.vendor_price_snapshot)::text AS expected_amount,
            '0'::text                        AS billed_amount,
            u.scanned_at                     AS occurred_at
       FROM inventory.csn_usages u
      WHERE u.hospital_id = $1
        AND u.status = 'used'
        AND COALESCE(u.billed_amount, u.vendor_price_snapshot) IS NOT NULL
        AND COALESCE(u.billed_amount, u.vendor_price_snapshot) >= $4::numeric
        AND u.scanned_at >= $3::timestamptz
        AND ($2::uuid IS NULL OR u.encounter_id = $2)
        AND NOT EXISTS (
          SELECT 1
            FROM billing.bill_items bi
            JOIN billing.bills b ON b.id = bi.bill_id
           WHERE bi.source_ref_id = u.id
             AND b.status NOT IN ('cancelled', 'void')
        )`,
    [ctx.hospitalId, ctx.encounterId, ctx.since, ctx.minGap],
  );
  return rows;
};

/**
 * A discount on a bill with no approved request behind it.
 *
 * The other direction of leakage: not a charge that was missed but one that was
 * reduced without the approval OP-005 §5 requires. The gap is the discount
 * itself, because that is the amount that left without a second pair of hands.
 */
const discountWithoutApproval: Reconciler = async (tx, ctx) => {
  const { rows } = await tx.query<ReconcilerRow>(
    `SELECT 'billing.bill'                   AS source_ref_type,
            b.id                             AS source_ref_id,
            b.patient_id                     AS patient_id,
            b.visit_id                       AS encounter_id,
            'Discount with no approved request: ' || b.bill_no AS description,
            b.bill_no                        AS service_name,
            b.discount_amount::text           AS expected_amount,
            '0'::text                        AS billed_amount,
            b.created_at                     AS occurred_at
       FROM billing.bills b
      WHERE b.hospital_id = $1
        AND b.discount_amount > 0
        AND b.discount_amount >= $4::numeric
        AND b.status NOT IN ('cancelled', 'void')
        AND b.created_at >= $3::timestamptz
        AND ($2::uuid IS NULL OR b.visit_id = $2)
        AND NOT EXISTS (
          SELECT 1 FROM billing.discount_requests dr
           WHERE dr.bill_id = b.id AND dr.status = 'approved'
        )`,
    [ctx.hospitalId, ctx.encounterId, ctx.since, ctx.minGap],
  );
  return rows;
};

export const RECONCILERS: Readonly<Record<string, Reconciler>> = {
  orders_vs_charges: ordersVsCharges,
  dispense_vs_charges: dispenseVsCharges,
  consignment_vs_charges: consignmentVsCharges,
  discount_without_approval: discountWithoutApproval,
};
