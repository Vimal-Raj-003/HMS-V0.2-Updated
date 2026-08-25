import { Inject, Injectable } from '@nestjs/common';
import { ProblemType, newId } from '@vims/contracts';
import { getContext } from '../../core/context/request-context.js';
import type { TransactionClient } from '../../core/db/database.service.js';
import { OutboxService } from '../../core/outbox/outbox.service.js';
import { AppError } from '../../core/problem/app-error.js';
import { moneyString, quantityString, requireBranch } from './inventory.common.js';
import { inventoryEvent } from './inventory.events.js';
import { UomService, type ItemFacts } from './uom.service.js';

/**
 * NC-006 §3.3 — the append-only stock ledger, and the **only** way anything in
 * this application writes a movement.
 *
 * `phase-04 §Constraints`, in full: "The stock ledger never gets an UPDATE.
 * Corrections are new compensating entries with reason. Any code that mutates a
 * ledger row fails review."
 *
 * The database makes that true whatever this file says: `trg_stock_ledger_
 * append_only` raises on UPDATE and DELETE, and §D of the migration revokes both
 * privileges from `hms_app` so a dropped trigger is not enough to get past it.
 * So the guarantee is not this service's to keep. What *is* this service's to
 * keep is everything a caller could otherwise get subtly wrong on the way in:
 *
 *  1. **The sign.** Positive in, negative out, and `sum(qty_base)` is therefore
 *     the balance. Callers pass a magnitude and a movement type; the direction
 *     is derived from the type, from the same table the CHECK constraint uses.
 *     A caller cannot pass a negative receipt because there is nowhere to put
 *     the minus sign.
 *  2. **The conversion.** `qty_base` is computed from `qty_entered` and the
 *     item's own factor, by `UomService`, using the same arithmetic the trigger
 *     will use to re-derive it. A caller never supplies `qty_base`.
 *  3. **The consignment flag**, read from the batch rather than accepted from
 *     the caller. `inventory.enforce_consignment_flag` refuses a disagreement,
 *     and a disagreement books the vendor's implants as our asset.
 *  4. **The event.** One `inventory.stock.moved` per ledger row, in the same
 *     transaction, so no movement can exist without its announcement and no
 *     announcement without its movement.
 *  5. **The replenishment signal.** An outbound movement that crosses the
 *     reorder level or empties the shelf raises `inventory.stock.low` or
 *     `inventory.stock.out` — once, on the crossing, not on every subsequent
 *     movement below the line.
 *
 * There is no `update`, no `delete` and no `void` method. `correct()` is the
 * whole vocabulary for undoing something, and it writes a new row.
 */

/** The movement types that add stock, from `stock_ledger_sign_matches_movement`. */
const INBOUND = new Set([
  'opening',
  'grn',
  'purchase_free',
  'transfer_in',
  'issue_in',
  'return_in',
  'patient_return',
  'consignment_in',
  'repack_in',
  'adjustment_plus',
  'count_gain',
]);

/** The movement types that remove stock. */
const OUTBOUND = new Set([
  'issue_out',
  'transfer_out',
  'dispense',
  'consumption',
  'sale',
  'vendor_return',
  'expiry_writeoff',
  'damage_writeoff',
  'wastage',
  'consignment_used',
  'consignment_return',
  'repack_out',
  'adjustment_minus',
  'count_loss',
]);

export type MovementType =
  | 'opening'
  | 'grn'
  | 'purchase_free'
  | 'transfer_in'
  | 'issue_in'
  | 'return_in'
  | 'patient_return'
  | 'consignment_in'
  | 'repack_in'
  | 'adjustment_plus'
  | 'count_gain'
  | 'issue_out'
  | 'transfer_out'
  | 'dispense'
  | 'consumption'
  | 'sale'
  | 'vendor_return'
  | 'expiry_writeoff'
  | 'damage_writeoff'
  | 'wastage'
  | 'consignment_used'
  | 'consignment_return'
  | 'repack_out'
  | 'adjustment_minus'
  | 'count_loss'
  | 'correction';

export type MovementRefType =
  | 'opening'
  | 'grn'
  | 'purchase_return'
  | 'store_indent'
  | 'issue'
  | 'transfer'
  | 'dispense'
  | 'sale_return'
  | 'consumption'
  | 'adjustment'
  | 'count'
  | 'writeoff'
  | 'quarantine'
  | 'recall'
  | 'consignment_receipt'
  | 'consignment_usage'
  | 'consignment_return'
  | 'repack'
  | 'correction';

export interface MovementInput {
  readonly storeId: string;
  readonly branchId?: string | undefined;
  readonly locationId?: string | null | undefined;
  readonly itemId: string;
  readonly batchId?: string | null | undefined;
  readonly serialId?: string | null | undefined;
  readonly movementType: MovementType;
  /** A magnitude, never signed. The movement type decides the direction. */
  readonly qtyEntered: number | string;
  /** Defaults to the item's base unit. Must be a rung of its ladder. */
  readonly uomId?: string | undefined;
  readonly unitCost?: number | null | undefined;
  readonly refType: MovementRefType;
  readonly refId: string;
  readonly refLineId?: string | null | undefined;
  readonly counterStoreId?: string | null | undefined;
  readonly counterLedgerId?: string | null | undefined;
  readonly patientId?: string | null | undefined;
  readonly encounterId?: string | null | undefined;
  readonly costCentreId?: string | null | undefined;
  readonly reason?: string | null | undefined;
  readonly remarks?: string | null | undefined;
  /** The co-signer on a controlled movement. Recorded, never inferred. */
  readonly secondActorId?: string | null | undefined;
  readonly movedAt?: Date | undefined;
  /** Only for `movementType: 'correction'`, which may go either way. */
  readonly direction?: 'in' | 'out' | undefined;
  readonly correctsLedgerId?: string | null | undefined;
}

export interface PostedMovement {
  readonly ledgerId: string;
  readonly movedAt: string;
  readonly itemId: string;
  readonly itemCode: string;
  readonly storeId: string;
  readonly batchId: string | null;
  readonly batchNo: string | null;
  readonly expiryDate: string | null;
  readonly qtyBase: string;
  readonly signedQtyBase: string;
  readonly uomId: string;
  readonly unitCost: string | null;
  readonly value: string | null;
  readonly balanceAfterBase: string;
  readonly isConsignment: boolean;
}

interface BalanceRow {
  readonly qty_on_hand: string;
  readonly qty_reserved: string;
  readonly avg_cost: string;
}

@Injectable()
export class StockLedgerService {
  constructor(
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(UomService) private readonly uoms: UomService,
  ) {}

  /**
   * Writes one movement and returns what it did.
   *
   * Runs inside the caller's transaction, deliberately: the ledger row, the
   * document it belongs to, its audit row and its event either all land or none
   * of them do. A ledger row committed without its document is stock that moved
   * for no recorded reason, which is the state an auditor cannot be given.
   */
  async post(tx: TransactionClient, input: MovementInput): Promise<PostedMovement> {
    const [posted] = await this.postMany(tx, [input]);
    if (posted === undefined) throw new Error('postMany returned no movement for one input');
    return posted;
  }

  /** The same, for a document whose lines move together. */
  async postMany(
    tx: TransactionClient,
    inputs: readonly MovementInput[],
  ): Promise<readonly PostedMovement[]> {
    const results: PostedMovement[] = [];
    for (const input of inputs) {
      results.push(await this.write(tx, input));
    }
    return results;
  }

  /**
   * The compensating entry — `phase-04 §Constraints`' "corrections are new
   * entries with reason", as the only method that can produce one.
   *
   * It reads the movement being corrected rather than trusting the caller for
   * the store, item, batch and unit: a correction for a different position is
   * refused by the trigger, and reading them here means the caller cannot
   * accidentally compensate the wrong shelf.
   */
  async correct(
    tx: TransactionClient,
    correctsLedgerId: string,
    input: {
      readonly qtyEntered: number | string;
      readonly direction: 'in' | 'out';
      readonly reason: string;
      readonly remarks?: string | null;
    },
  ): Promise<PostedMovement> {
    const original = await tx.maybeOne<{
      id: string;
      store_id: string;
      branch_id: string;
      location_id: string | null;
      item_id: string;
      batch_id: string | null;
      uom_id: string;
      unit_cost: string | null;
      movement_type: string;
    }>(
      `SELECT id, store_id, branch_id, location_id, item_id, batch_id, uom_id,
              unit_cost::text AS unit_cost, movement_type::text AS movement_type
         FROM inventory.stock_ledger WHERE id = $1`,
      [correctsLedgerId],
    );
    if (original === undefined) throw AppError.notFound('The movement being corrected');
    if (original.movement_type === 'correction') {
      throw new AppError(
        ProblemType.BUSINESS_RULE_VIOLATED,
        'That movement is itself a correction. Correct the original movement — a chain of corrections is unreadable to whoever has to reconstruct what happened.',
      );
    }

    const posted = await this.write(tx, {
      storeId: original.store_id,
      branchId: original.branch_id,
      locationId: original.location_id,
      itemId: original.item_id,
      batchId: original.batch_id,
      movementType: 'correction',
      direction: input.direction,
      qtyEntered: input.qtyEntered,
      uomId: original.uom_id,
      unitCost: original.unit_cost === null ? null : Number(original.unit_cost),
      refType: 'correction',
      refId: correctsLedgerId,
      correctsLedgerId,
      reason: input.reason,
      remarks: input.remarks ?? null,
    });

    await this.outbox.publish(
      tx,
      inventoryEvent('inventory.stock.corrected', posted.ledgerId, {
        storeId: posted.storeId,
        itemId: posted.itemId,
        itemCode: posted.itemCode,
        batchId: posted.batchId,
        batchNo: posted.batchNo,
        expiryDate: posted.expiryDate,
        ledgerId: posted.ledgerId,
        correctsLedgerId,
        qtyBase: posted.qtyBase,
        reason: input.reason,
        actorId: getContext().userId,
        movedAt: posted.movedAt,
      }),
    );

    return posted;
  }

  // ── reads ────────────────────────────────────────────────────────────────

  /**
   * `inventory.fefo_batches` — the issuable batches of one item in one store,
   * soonest expiry first.
   *
   * Deliberately the database function rather than a query written here: it
   * applies exactly the three exclusions `enforce_ledger_preconditions()`
   * enforces (expired, non-active, quarantined), so a batch it suggests can
   * never be one the ledger would then refuse. A hand-written ORDER BY would
   * drift from those the first time one of them changed.
   */
  async fefo(
    tx: TransactionClient,
    storeId: string,
    itemId: string,
  ): Promise<
    readonly {
      readonly batch_id: string;
      readonly expiry_date: string | null;
      readonly qty_available: string;
      readonly unit_cost: string | null;
    }[]
  > {
    const ctx = getContext();
    return tx.rows(
      `SELECT batch_id, expiry_date::text AS expiry_date,
              qty_available::text AS qty_available, unit_cost::text AS unit_cost
         FROM inventory.fefo_batches($1::uuid, $2::uuid, $3::uuid)`,
      [ctx.hospitalId, storeId, itemId],
    );
  }

  /**
   * FEFO allocation: which batches, and how much from each, for a needed base
   * quantity.
   *
   * Returns short when the shelf cannot cover the request rather than throwing,
   * because the caller's answer differs — a dispense offers a partial fill and a
   * substitution, an issue short-supplies the ward, a transfer refuses. What is
   * *not* negotiable is that every allocation names a batch: `fail closed on
   * stock integrity` is a property of this method's output shape.
   */
  async allocateFefo(
    tx: TransactionClient,
    storeId: string,
    itemId: string,
    neededBase: string,
  ): Promise<{
    readonly picks: readonly { readonly batchId: string; readonly qtyBase: string }[];
    readonly shortBase: string;
  }> {
    const batches = await this.fefo(tx, storeId, itemId);
    let remaining = BigInt(scaled(neededBase));
    const picks: { batchId: string; qtyBase: string }[] = [];

    for (const batch of batches) {
      if (remaining <= 0n) break;
      const available = BigInt(scaled(batch.qty_available));
      if (available <= 0n) continue;
      const take = available < remaining ? available : remaining;
      picks.push({ batchId: batch.batch_id, qtyBase: unscaled(take) });
      remaining -= take;
    }

    return { picks, shortBase: unscaled(remaining < 0n ? 0n : remaining) };
  }

  /** The balance at one position. `undefined` means nothing has ever been there. */
  async balance(
    tx: TransactionClient,
    storeId: string,
    itemId: string,
    batchId: string | null,
  ): Promise<BalanceRow | undefined> {
    return tx.maybeOne<BalanceRow>(
      `SELECT sum(qty_on_hand)::text AS qty_on_hand,
              sum(qty_reserved)::text AS qty_reserved,
              max(avg_cost)::text AS avg_cost
         FROM inventory.stock_balances
        WHERE store_id = $1 AND item_id = $2 AND batch_id IS NOT DISTINCT FROM $3`,
      [storeId, itemId, batchId],
    );
  }

  // ── the writer ───────────────────────────────────────────────────────────

  private async write(tx: TransactionClient, input: MovementInput): Promise<PostedMovement> {
    const ctx = getContext();
    const branchId = requireBranch(input.branchId);
    const item = await this.uoms.item(tx, input.itemId);

    const converted = await this.uoms.toBase(tx, item, input.uomId, input.qtyEntered);
    if (Number(converted.qtyBase) <= 0) {
      throw new AppError(
        ProblemType.VALIDATION_FAILED,
        `A movement of ${item.code} must be a quantity greater than zero. Pass the magnitude; the movement type decides whether it goes on or off the shelf.`,
      );
    }

    const direction = this.directionOf(input);
    const signedBase = direction === 'out' ? `-${converted.qtyBase}` : converted.qtyBase;
    const signedEntered = direction === 'out' ? `-${converted.qtyEntered}` : converted.qtyEntered;

    // The consignment flag is the batch's, never the caller's. The trigger
    // refuses a disagreement; reading it here means there is nothing to disagree
    // with, and it is also how a batch's ownership reaches the balance row.
    const batch = await this.batchFacts(tx, input.batchId ?? null);
    const isConsignment = batch?.is_consignment ?? false;

    const unitCost = input.unitCost ?? null;
    const value = unitCost === null ? null : (Number(signedBase) * unitCost).toFixed(2);

    const id = newId();
    const movedAt = input.movedAt ?? new Date();

    const inserted = await tx.one<{ id: string; moved_at: string }>(
      `INSERT INTO inventory.stock_ledger (
         id, hospital_id, branch_id, store_id, location_id, item_id, batch_id, serial_id,
         movement_type, qty_base, qty_entered, uom_id, unit_cost, value, currency,
         ref_type, ref_id, ref_line_id, counter_store_id, counter_ledger_id,
         patient_id, encounter_id, cost_centre_id, is_consignment,
         corrects_ledger_id, reason, remarks, actor_id, second_actor_id, moved_at, created_by
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8,
         $9::inventory."InvMovementType", $10::numeric, $11::numeric, $12, $13::numeric, $14::numeric, 'INR',
         $15::inventory."InvRefType", $16, $17, $18, $19,
         $20, $21, $22, $23,
         $24, $25, $26, $27, $28, $29, $27
       )
       RETURNING id, moved_at::text AS moved_at`,
      [
        id,
        ctx.hospitalId,
        branchId,
        input.storeId,
        input.locationId ?? null,
        input.itemId,
        input.batchId ?? null,
        input.serialId ?? null,
        input.movementType,
        signedBase,
        signedEntered,
        converted.uomId,
        unitCost,
        value,
        input.refType,
        input.refId,
        input.refLineId ?? null,
        input.counterStoreId ?? null,
        input.counterLedgerId ?? null,
        input.patientId ?? null,
        input.encounterId ?? null,
        input.costCentreId ?? null,
        isConsignment,
        input.correctsLedgerId ?? null,
        input.reason ?? null,
        input.remarks ?? null,
        ctx.userId,
        input.secondActorId ?? null,
        movedAt,
      ],
    );

    // Read back rather than compute: `inventory.apply_ledger_to_balance` is the
    // only writer of `stock_balances`, and reading its answer is what makes the
    // event's `balanceAfterBase` the same number the next dispense will see.
    const after = await this.balance(tx, input.storeId, input.itemId, input.batchId ?? null);
    const balanceAfter = after?.qty_on_hand ?? signedBase;

    const posted: PostedMovement = {
      ledgerId: inserted.id,
      movedAt: new Date(inserted.moved_at).toISOString(),
      itemId: item.id,
      itemCode: item.code,
      storeId: input.storeId,
      batchId: input.batchId ?? null,
      batchNo: batch?.batch_no ?? null,
      expiryDate: batch?.expiry_date ?? null,
      qtyBase: converted.qtyBase,
      signedQtyBase: signedBase,
      uomId: converted.uomId,
      unitCost: unitCost === null ? null : unitCost.toFixed(4),
      value,
      balanceAfterBase: balanceAfter,
      isConsignment,
    };

    await this.outbox.publish(
      tx,
      inventoryEvent('inventory.stock.moved', posted.ledgerId, {
        storeId: posted.storeId,
        itemId: posted.itemId,
        itemCode: posted.itemCode,
        batchId: posted.batchId,
        batchNo: posted.batchNo,
        expiryDate: posted.expiryDate,
        ledgerId: posted.ledgerId,
        movementType: input.movementType,
        refType: input.refType,
        refId: input.refId,
        // `signedBase`, not `converted.qtyBase`. The ledger row for an
        // `issue_out` holds -10 while the entered quantity is 10, and it is the
        // sign that makes `sum(qty_base)` a balance. Publishing the unsigned
        // value gave every consumer of this event a running total that diverges
        // from the ledger the moment anything leaves a store — and it was
        // published that way because the contract's `quantity` pattern refused a
        // minus, which is now fixed rather than worked around.
        qtyBase: quantityString(Number(signedBase)),
        uomId: converted.uomId,
        unitCost: unitCost === null ? null : moneyString(unitCost),
        value: value === null ? null : moneyString(Number(value)),
        isConsignment,
        balanceAfterBase: quantityString(Number(balanceAfter)),
        movedAt: posted.movedAt,
        actorId: ctx.userId,
      }),
    );

    if (direction === 'out') await this.raiseReplenishmentSignal(tx, input.storeId, item, balanceAfter);

    return posted;
  }

  private directionOf(input: MovementInput): 'in' | 'out' {
    if (input.movementType === 'correction') {
      if (input.direction === undefined) {
        throw new AppError(
          ProblemType.VALIDATION_FAILED,
          'A correction must say whether it puts stock back or takes it away; it is the only movement type that can do either.',
        );
      }
      return input.direction;
    }
    if (INBOUND.has(input.movementType)) return 'in';
    if (OUTBOUND.has(input.movementType)) return 'out';
    // Unreachable while `MovementType` and the two sets agree; kept because the
    // sets are the application's copy of a database CHECK and the two could
    // drift, and the safe answer to "I do not know which way this goes" is to
    // refuse rather than to guess `in`.
    throw new AppError(
      ProblemType.VALIDATION_FAILED,
      `"${input.movementType}" is not a movement type this ledger knows how to sign.`,
    );
  }

  private async batchFacts(
    tx: TransactionClient,
    batchId: string | null,
  ): Promise<{
    readonly batch_no: string;
    readonly expiry_date: string | null;
    readonly is_consignment: boolean;
  } | null> {
    if (batchId === null) return null;
    const row = await tx.maybeOne<{
      batch_no: string;
      expiry_date: string | null;
      is_consignment: boolean;
    }>(
      `SELECT batch_no, expiry_date::text AS expiry_date, is_consignment
         FROM inventory.item_batches WHERE id = $1`,
      [batchId],
    );
    if (row === undefined) throw AppError.notFound('The batch');
    return row;
  }

  /**
   * `inventory.stock.low` / `inventory.stock.out`, raised on the crossing.
   *
   * Two events rather than one because the operational answer differs: a low
   * stock is a purchase decision and a stockout is a substitution or a transfer,
   * now. Raised only when the movement is the one that crossed the line —
   * otherwise every subsequent dispense from an already-low shelf would raise
   * another, and a channel that cries wolf on every sale is a channel nobody
   * reads.
   */
  private async raiseReplenishmentSignal(
    tx: TransactionClient,
    storeId: string,
    item: ItemFacts,
    balanceAfter: string,
  ): Promise<void> {
    const params = await tx.maybeOne<{
      reorder_level: string | null;
      safety_stock: string | null;
      ved_class: string;
    }>(
      `SELECT reorder_level::text AS reorder_level, safety_stock::text AS safety_stock,
              ved_class::text AS ved_class
         FROM inventory.item_store_params
        WHERE item_id = $1 AND store_id = $2`,
      [item.id, storeId],
    );

    const totals = await tx.maybeOne<{ available: string | null; last_movement_at: string | null }>(
      `SELECT sum(qty_on_hand - qty_reserved)::text AS available,
              max(last_movement_at)::text AS last_movement_at
         FROM inventory.stock_balances
        WHERE store_id = $1 AND item_id = $2`,
      [storeId, item.id],
    );
    const available = Number(totals?.available ?? balanceAfter);
    const vedClass = (params?.ved_class ?? 'unclassified') as
      'vital' | 'essential' | 'desirable' | 'unclassified';
    const now = new Date().toISOString();

    if (available <= 0) {
      await this.outbox.publish(
        tx,
        inventoryEvent('inventory.stock.out', item.id, {
          storeId,
          itemId: item.id,
          itemCode: item.code,
          vedClass,
          lastMovementAt:
            totals?.last_movement_at === null || totals?.last_movement_at === undefined
              ? null
              : new Date(totals.last_movement_at).toISOString(),
          detectedAt: now,
        }),
      );
      return;
    }

    const reorderLevel = params?.reorder_level === null ? null : (params?.reorder_level ?? null);
    if (reorderLevel === null) return;
    if (available > Number(reorderLevel)) return;

    await this.outbox.publish(
      tx,
      inventoryEvent('inventory.stock.low', item.id, {
        storeId,
        itemId: item.id,
        itemCode: item.code,
        availableBase: quantityString(available),
        reorderLevelBase: quantityString(Number(reorderLevel)),
        safetyStockBase:
          params?.safety_stock === null || params?.safety_stock === undefined
            ? null
            : quantityString(Number(params.safety_stock)),
        vedClass,
        detectedAt: now,
      }),
    );
  }
}

/** `"12.5"` → `125000` (scale 4), as a string a `BigInt` can take. */
function scaled(value: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (match === null) return '0';
  const sign = match[1] ?? '';
  const whole = match[2] ?? '0';
  const fraction = (match[3] ?? '').slice(0, 4).padEnd(4, '0');
  return `${sign}${whole}${fraction}`;
}

function unscaled(value: bigint): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(5, '0');
  return `${negative ? '-' : ''}${digits.slice(0, digits.length - 4)}.${digits.slice(digits.length - 4)}`;
}
