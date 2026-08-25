import { Injectable } from '@nestjs/common';
import { ProblemType } from '@vims/contracts';
import type { TransactionClient } from '../../core/db/database.service.js';
import { AppError } from '../../core/problem/app-error.js';

/**
 * The conversion ladder — `phase-04 §Constraints`: "Every quantity has a UoM.
 * Any arithmetic mixing UoMs without conversion is a bug."
 *
 * The database already refuses a quantity whose UoM is absent from the item's
 * ladder, and re-derives `qty_base` from `qty_entered` and the item's own
 * factor before storing either (`inventory.enforce_qty_uom`). This service
 * exists so the *application* never has to guess what the database will
 * compute: it reads the same factor from the same table and produces the same
 * number, so a mismatch is impossible rather than merely unlikely.
 *
 * ── Why the arithmetic is integer arithmetic ────────────────────────────────
 *
 * `factor_to_base` is `numeric(20,8)` and `qty_entered` is `numeric(18,4)`.
 * Postgres multiplies them exactly and rounds the product to four places, half
 * away from zero. IEEE-754 does not: `0.1 * 3` is `0.30000000000000004`, and a
 * `qty_base` computed that way disagrees with the trigger's by one unit in the
 * fourth place — which is not a rounding curiosity, it is a refused insert on a
 * dispense that is otherwise correct, at a counter, with a patient waiting.
 *
 * So both operands are scaled to integers, multiplied as `bigint`, and rounded
 * half away from zero. The result is the same digits Postgres would produce,
 * for every input the columns can hold.
 */

/** The scale of every `qty_base` / `qty_entered` column in this phase. */
const QTY_SCALE = 4;
/** The scale of `inventory.item_uoms.factor_to_base`. */
const FACTOR_SCALE = 8;

function scaledInteger(value: string, scale: number, field: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (match === null) {
    throw new AppError(ProblemType.VALIDATION_FAILED, `${field} is not a decimal number.`);
  }
  const sign = match[1] === '-' ? -1n : 1n;
  const whole = match[2] ?? '0';
  const fraction = (match[3] ?? '').padEnd(scale, '0');
  if (fraction.length > scale) {
    throw new AppError(
      ProblemType.VALIDATION_FAILED,
      `${field} has more than ${scale} decimal places, which this system cannot store exactly.`,
    );
  }
  return sign * BigInt(whole + fraction);
}

/**
 * `round(entered * factor, 4)`, exactly, half away from zero.
 *
 * Both inputs arrive as strings so nothing has been through a float on the way
 * in. The output is a string for the same reason: it is bound straight into the
 * INSERT, and a `numeric` handed a JavaScript number is a `numeric` that has
 * already lost the argument.
 */
export function convertToBase(qtyEntered: string, factorToBase: string): string {
  const entered = scaledInteger(qtyEntered, QTY_SCALE, 'Quantity');
  const factor = scaledInteger(factorToBase, FACTOR_SCALE, 'The conversion factor');

  // entered(1e4) * factor(1e8) = product(1e12); we want 1e4, so divide by 1e8
  // with half-away-from-zero rounding.
  const product = entered * factor;
  const divisor = 10n ** BigInt(FACTOR_SCALE);
  const negative = product < 0n;
  const magnitude = negative ? -product : product;
  const quotient = magnitude / divisor;
  const remainder = magnitude % divisor;
  const rounded = remainder * 2n >= divisor ? quotient + 1n : quotient;
  const signed = negative ? -rounded : rounded;

  return formatScaled(signed, QTY_SCALE);
}

function formatScaled(value: bigint, scale: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale);
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

export interface ItemFacts {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly item_type: string;
  readonly tracking: string;
  readonly schedule: string;
  readonly is_narcotic: boolean;
  readonly is_high_alert: boolean;
  readonly base_uom_id: string;
  readonly dispense_uom_id: string | null;
  readonly issue_uom_id: string | null;
  readonly purchase_uom_id: string | null;
  readonly hsn_code: string | null;
  readonly is_billable: boolean;
  readonly is_returnable: boolean;
  readonly is_consignment_allowed: boolean;
  readonly min_shelf_life_days: number | null;
  readonly status: string;
  readonly drug_key: string | null;
  readonly generic_name: string | null;
}

export interface ConvertedQuantity {
  /** The quantity as typed, in `uomId`. */
  readonly qtyEntered: string;
  /** The same quantity in the item's base unit, to four places. */
  readonly qtyBase: string;
  readonly uomId: string;
  readonly factorToBase: string;
}

@Injectable()
export class UomService {
  /** The item master row every guard in this phase reads. */
  async item(tx: TransactionClient, itemId: string): Promise<ItemFacts> {
    const row = await tx.maybeOne<ItemFacts>(
      `SELECT i.id, i.code, i.name, i.item_type::text AS item_type, i.tracking::text AS tracking,
              i.schedule::text AS schedule, i.is_narcotic, i.is_high_alert, i.base_uom_id,
              i.dispense_uom_id, i.issue_uom_id, i.purchase_uom_id, i.hsn_code,
              i.is_billable, i.is_returnable, i.is_consignment_allowed, i.min_shelf_life_days,
              i.status::text AS status, i.drug_key, i.generic_name
         FROM inventory.items i
        WHERE i.id = $1 AND i.deleted_at IS NULL`,
      [itemId],
    );
    if (row === undefined) throw AppError.notFound('The item');
    return row;
  }

  /** Every item named in one request, in one round trip. */
  async items(tx: TransactionClient, itemIds: readonly string[]): Promise<Map<string, ItemFacts>> {
    if (itemIds.length === 0) return new Map();
    const rows = await tx.rows<ItemFacts>(
      `SELECT i.id, i.code, i.name, i.item_type::text AS item_type, i.tracking::text AS tracking,
              i.schedule::text AS schedule, i.is_narcotic, i.is_high_alert, i.base_uom_id,
              i.dispense_uom_id, i.issue_uom_id, i.purchase_uom_id, i.hsn_code,
              i.is_billable, i.is_returnable, i.is_consignment_allowed, i.min_shelf_life_days,
              i.status::text AS status, i.drug_key, i.generic_name
         FROM inventory.items i
        WHERE i.id = ANY($1::uuid[]) AND i.deleted_at IS NULL`,
      [[...itemIds]],
    );
    return new Map(rows.map((r) => [r.id, r]));
  }

  /** The rungs of one item's ladder, base first. */
  async ladder(
    tx: TransactionClient,
    itemId: string,
  ): Promise<
    readonly {
      readonly uom_id: string;
      readonly code: string;
      readonly name: string;
      readonly pack_level: string;
      readonly factor_to_base: string;
      readonly is_base: boolean;
      readonly gtin: string | null;
    }[]
  > {
    return tx.rows(
      `SELECT iu.uom_id, u.code, u.name, iu.pack_level::text AS pack_level,
              iu.factor_to_base::text AS factor_to_base, iu.is_base, iu.gtin
         FROM inventory.item_uoms iu
         JOIN mdm.mdm_uoms u ON u.id = iu.uom_id
        WHERE iu.item_id = $1 AND iu.active
        ORDER BY iu.is_base DESC, iu.factor_to_base ASC`,
      [itemId],
    );
  }

  /**
   * Converts a quantity typed in `uomId` into the item's base unit.
   *
   * A UoM absent from the ladder is refused **here**, with the item and the unit
   * named, rather than by the trigger four layers down. The trigger is still the
   * guarantee — this is the message.
   */
  async toBase(
    tx: TransactionClient,
    item: ItemFacts,
    uomId: string | undefined,
    qtyEntered: number | string,
  ): Promise<ConvertedQuantity> {
    const resolved = uomId ?? item.base_uom_id;
    const rung = await tx.maybeOne<{ factor_to_base: string }>(
      `SELECT factor_to_base::text AS factor_to_base
         FROM inventory.item_uoms
        WHERE item_id = $1 AND uom_id = $2 AND active`,
      [item.id, resolved],
    );
    if (rung === undefined) {
      throw new AppError(
        ProblemType.VALIDATION_FAILED,
        `That unit of measure is not on the conversion ladder of ${item.code} (${item.name}), so a quantity in it cannot be converted. An unconvertible quantity is not a quantity.`,
        { nextAction: 'Add the pack size to the item master, or enter the quantity in a listed unit.' },
      );
    }

    const entered = typeof qtyEntered === 'number' ? qtyEntered.toFixed(QTY_SCALE) : qtyEntered;
    return {
      qtyEntered: entered,
      qtyBase: convertToBase(entered, rung.factor_to_base),
      uomId: resolved,
      factorToBase: rung.factor_to_base,
    };
  }

  /**
   * The reverse trip: a base quantity expressed in a chosen unit.
   *
   * Used only for display and for a line whose `qty_entered` has to be
   * reconstructed (a partial fill computed in base units, say). It rounds to the
   * entered scale, so `toBase(fromBase(x))` is not guaranteed to be `x` — which
   * is why nothing stores the result without re-converting it.
   */
  async fromBase(
    tx: TransactionClient,
    itemId: string,
    uomId: string,
    qtyBase: string,
  ): Promise<string | null> {
    const rung = await tx.maybeOne<{ factor_to_base: string }>(
      `SELECT factor_to_base::text AS factor_to_base
         FROM inventory.item_uoms
        WHERE item_id = $1 AND uom_id = $2 AND active`,
      [itemId, uomId],
    );
    if (rung === undefined) return null;
    const base = scaledInteger(qtyBase, QTY_SCALE, 'Quantity');
    const factor = scaledInteger(rung.factor_to_base, FACTOR_SCALE, 'The conversion factor');
    if (factor === 0n) return null;
    // base(1e4) / factor(1e8) -> want 1e4, so scale the numerator by 1e8.
    const numerator = base * 10n ** BigInt(FACTOR_SCALE);
    const negative = numerator < 0n !== factor < 0n;
    const magnitude = (numerator < 0n ? -numerator : numerator) / (factor < 0n ? -factor : factor);
    const remainder = (numerator < 0n ? -numerator : numerator) % (factor < 0n ? -factor : factor);
    const rounded = remainder * 2n >= (factor < 0n ? -factor : factor) ? magnitude + 1n : magnitude;
    return formatScaled(negative ? -rounded : rounded, QTY_SCALE);
  }
}
