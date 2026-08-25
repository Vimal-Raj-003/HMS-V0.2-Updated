import { Inject, Injectable } from '@nestjs/common';
import { ProblemType, newId, type Page } from '@vims/contracts';
import { AuditService } from '../../core/audit/audit.service.js';
import { getContext } from '../../core/context/request-context.js';
import { DatabaseService } from '../../core/db/database.service.js';
import { OutboxService } from '../../core/outbox/outbox.service.js';
import { CursorService } from '../../core/pagination/cursor.service.js';
import { AppError } from '../../core/problem/app-error.js';
import { currentTenantContext } from '../../core/tenancy/tenant-context.js';
import { binder, hospitalId, quantityString, requireBranch } from '../inventory/inventory.common.js';
import { StockLedgerService } from '../inventory/stock-ledger.service.js';
import { UomService } from '../inventory/uom.service.js';
import { PharmacyCoSignService } from './cosign.service.js';
import { DispenseService } from './dispense.service.js';
import { pharmacyEvent, registerFor, withPharmacyErrors } from './pharmacy.common.js';
import type {
  CustodyCheckRequest,
  DestructionRequest,
  RegisterEntryRequest,
  RegisterQuery,
} from './pharmacy.schemas.js';
import type { CustodyCheckView, RegisterEntryView } from './pharmacy.types.js';

/**
 * The statutory controlled-drug registers — `docs/04 §1` (NDPS Act, Drugs &
 * Cosmetics Rules) and `phase-04` exit gate 4.
 *
 * ── Why every write here is co-signed, and none of the routes says so ───────
 *
 * `pharmacy.narcotic.issue`, `.custody` and `.destroy` are all
 * `requiresSecondPerson`, so none of them can decorate a route: `PolicyGuard`
 * evaluates without a co-signer and the route would deny every user, including
 * the hospital administrator, while looking correct in review. The routes
 * therefore carry `pharmacy.narcotic.prepare` — the single-signature "open a
 * controlled-drug transaction" authority — and the real key is asserted inside
 * this service, through the same engine, with the co-signer attached.
 *
 * ── Why the register and the ledger move together ──────────────────────────
 *
 * A register that says one thing and a shelf that says another is not a
 * register. Every receipt into and issue from the controlled safe writes **both**
 * a `controlled_drug_register` row and an `inventory.stock_ledger` row, in one
 * transaction, with the register row naming the ledger row it belongs to. The
 * balance on the register page is then the same number the ledger holds, and
 * `pharmacy.compute_register_balance` derives it under a per-register advisory
 * lock so two pharmacists at one safe cannot both write "page 47".
 *
 * ── Why `adjustment` is not a transaction type on this API ─────────────────
 *
 * `phase-04` exit gate 4: "a deliberate mismatch raises an alert and **cannot be
 * silently adjusted**." An adjustment to a controlled balance is a stock
 * adjustment first — maker, checker, a reason and a ledger row — and it reaches
 * the register through `resolveCustodyVariance()`, which requires the inventory
 * adjustment to already be posted. There is no route that lets one person type a
 * new balance.
 */
@Injectable()
export class NarcoticsService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(CursorService) private readonly cursors: CursorService,
    @Inject(StockLedgerService) private readonly ledger: StockLedgerService,
    @Inject(UomService) private readonly uoms: UomService,
    @Inject(PharmacyCoSignService) private readonly cosign: PharmacyCoSignService,
    @Inject(DispenseService) private readonly dispenses: DispenseService,
  ) {}

  /**
   * A receipt into, or an issue from, the controlled safe.
   *
   * Route key: `pharmacy.narcotic.prepare`. Real authority:
   * `pharmacy.narcotic.issue`, asserted here with the second pharmacist attached.
   */
  async recordEntry(body: RegisterEntryRequest): Promise<RegisterEntryView> {
    const secondId = await this.cosign.authorise('pharmacy.narcotic.issue', body.coSigner);
    const ctx = getContext();
    const branchId = requireBranch();

    const entryId = await withPharmacyErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const item = await this.uoms.item(tx, body.itemId);
        const register = registerFor(item.schedule, item.is_narcotic);
        if (register === null) {
          throw new AppError(
            ProblemType.VALIDATION_FAILED,
            `${item.code} is not a controlled drug, so it does not belong in a statutory register.`,
          );
        }

        const converted = await this.uoms.toBase(tx, item, body.uomId, body.qtyEntered);
        const inbound = body.txnType === 'receipt' || body.txnType === 'return_in';

        // The ledger first, so the register row can name the movement it
        // documents. A register entry with no movement behind it is a page that
        // says stock arrived and a shelf that disagrees.
        const posted = await this.ledger.post(tx, {
          storeId: body.storeId,
          branchId,
          itemId: body.itemId,
          batchId: body.batchId ?? null,
          movementType: inbound ? (body.txnType === 'receipt' ? 'issue_in' : 'patient_return') : 'issue_out',
          qtyEntered: converted.qtyEntered,
          uomId: converted.uomId,
          refType: 'issue',
          refId: newId(),
          patientId: body.patientId ?? null,
          secondActorId: secondId,
          reason: body.remarks ?? `Controlled-drug ${body.txnType}`,
        });

        const id = await this.dispenses.writeRegisterEntry(tx, {
          registerType: register,
          storeId: body.storeId,
          branchId,
          itemId: body.itemId,
          batchId: body.batchId ?? null,
          uomId: converted.uomId,
          ...(inbound ? { qtyInBase: converted.qtyBase } : { qtyOutBase: converted.qtyBase }),
          txnType: body.txnType,
          patientId: body.patientId ?? null,
          patientName: body.patientName ?? null,
          prescriberName: body.prescriberName ?? null,
          prescriberRegNo: body.prescriberRegNo ?? null,
          rxRef: body.rxRef ?? null,
          refType: 'issue',
          refId: posted.ledgerId,
          ledgerId: posted.ledgerId,
          firstAuthUserId: ctx.userId ?? '',
          secondAuthUserId: secondId,
          remarks: body.remarks ?? null,
        });

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'pharmacy.controlled_drug_register',
          rowId: id,
          businessKey: `${register}/${item.code}`,
          dataClass: 'phi',
          patientId: body.patientId ?? null,
          reasonText: body.remarks ?? null,
          before: null,
          after: {
            txn_type: body.txnType,
            qty_base: converted.qtyBase,
            second_auth_user_id: secondId,
          },
        });

        return id;
      }),
    );

    return this.entry(entryId);
  }

  /**
   * The shift count of the controlled safe — `phase-04` exit gate 4.
   *
   * The system balance is read from the register itself, not supplied. The
   * variance is derived. `narcotic_custody_variance_escalated` then makes a
   * non-zero variance **unstorable** without an incident reference and an
   * explanation, so the only way to record a discrepancy is to escalate it —
   * and `pharmacy.enforce_day_close_preconditions` refuses to close the shift
   * while one is unresolved.
   */
  async custodyCheck(body: CustodyCheckRequest): Promise<CustodyCheckView> {
    const secondId = await this.cosign.authorise('pharmacy.narcotic.custody', body.coSigner);
    const ctx = getContext();
    const id = newId();

    await withPharmacyErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const item = await this.uoms.item(tx, body.itemId);
        const register = registerFor(item.schedule, item.is_narcotic);
        if (register === null) {
          throw new AppError(
            ProblemType.VALIDATION_FAILED,
            `${item.code} is not a controlled drug, so it is counted in the ordinary stock count rather than the safe.`,
          );
        }

        const converted = await this.uoms.toBase(tx, item, body.uomId, body.physicalCountEntered);
        const balance = await tx.maybeOne<{ balance_after_base: string }>(
          `SELECT balance_after_base::text AS balance_after_base
             FROM pharmacy.controlled_drug_register
            WHERE store_id = $1 AND register_type = $2::pharmacy."PhRegisterType"
              AND item_id = $3 AND batch_id IS NOT DISTINCT FROM $4
            ORDER BY entered_at DESC, id DESC LIMIT 1`,
          [body.storeId, register, body.itemId, body.batchId ?? null],
        );
        const systemBalance = Number(balance?.balance_after_base ?? 0);
        const variance = Number(converted.qtyBase) - systemBalance;

        if (
          variance !== 0 &&
          (body.incidentRef === undefined ||
            body.explanation === undefined ||
            body.adjustmentId === undefined)
        ) {
          throw new AppError(
            ProblemType.BUSINESS_RULE_VIOLATED,
            `The safe holds ${converted.qtyBase} and the register says ${systemBalance.toFixed(4)}. A controlled-drug discrepancy cannot be filed without an incident reference, an explanation and the posted stock adjustment that reconciles it — the only way to record it is to escalate it.`,
            {
              nextAction:
                'Raise an incident, have the stores post an approved adjustment for the difference, then file the count citing both.',
            },
          );
        }

        // The adjustment has to exist and be posted before the count cites it.
        // `narcotic_custody_checks` has UPDATE revoked, so the link cannot be
        // added later — and a row filed without one would block that business
        // date's close for ever.
        let adjustmentNo: string | null = null;
        if (body.adjustmentId !== undefined) {
          const adjustment = await tx.maybeOne<{
            status: string;
            store_id: string;
            adjustment_no: string;
            requested_by: string | null;
            approved_by: string | null;
          }>(
            `SELECT status::text AS status, store_id, adjustment_no, requested_by, approved_by
               FROM inventory.adjustments WHERE id = $1`,
            [body.adjustmentId],
          );
          if (adjustment === undefined) throw AppError.notFound('The adjustment');
          if (adjustment.status !== 'posted') {
            throw new AppError(
              ProblemType.BUSINESS_RULE_VIOLATED,
              `Adjustment ${adjustment.adjustment_no} is "${adjustment.status}". A controlled-drug variance is closed by a posted, approved adjustment — not by one that is still waiting for a second signature.`,
            );
          }
          if (adjustment.store_id !== body.storeId) {
            throw new AppError(
              ProblemType.VALIDATION_FAILED,
              'That adjustment is for a different store from the safe that was counted.',
            );
          }
          adjustmentNo = adjustment.adjustment_no;
        }

        await tx.query(
          `INSERT INTO pharmacy.narcotic_custody_checks
             (id, hospital_id, store_id, item_id, batch_id, shift_label, uom_id,
              system_balance_base, physical_count_base, variance_base, checked_by_1, checked_by_2,
              incident_ref, explanation, adjustment_id, checked_at, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7,
                   $8::numeric, $9::numeric, $10::numeric, $11, $12,
                   $13, $14, $15, now(), $11)`,
          [
            id,
            ctx.hospitalId,
            body.storeId,
            body.itemId,
            body.batchId ?? null,
            body.shiftLabel,
            converted.uomId,
            systemBalance.toFixed(4),
            converted.qtyBase,
            variance.toFixed(4),
            ctx.userId,
            secondId,
            body.incidentRef ?? null,
            body.explanation ?? null,
            body.adjustmentId ?? null,
          ],
        );

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'pharmacy.narcotic_custody_checks',
          rowId: id,
          businessKey: `${body.shiftLabel}/${item.code}`,
          dataClass: 'phi',
          reasonText: body.explanation ?? null,
          before: null,
          after: {
            system_balance_base: systemBalance.toFixed(4),
            physical_count_base: converted.qtyBase,
            variance_base: variance.toFixed(4),
            checked_by_2: secondId,
            adjustment_no: adjustmentNo,
          },
        });

        // The register follows the shelf. Without this the stock adjustment and
        // the statutory page would disagree from the moment the variance was
        // reconciled, and the next count would find the same difference again.
        if (variance !== 0 && body.adjustmentId !== undefined) {
          await this.dispenses.writeRegisterEntry(tx, {
            registerType: register,
            storeId: body.storeId,
            branchId: requireBranch(),
            itemId: body.itemId,
            batchId: body.batchId ?? null,
            uomId: converted.uomId,
            ...(variance > 0
              ? { qtyInBase: variance.toFixed(4) }
              : { qtyOutBase: Math.abs(variance).toFixed(4) }),
            txnType: 'adjustment',
            patientId: null,
            patientName: null,
            prescriberName: null,
            prescriberRegNo: null,
            rxRef: null,
            refType: 'adjustment',
            refId: body.adjustmentId,
            ledgerId: null,
            firstAuthUserId: ctx.userId ?? '',
            secondAuthUserId: secondId,
            remarks: `Custody variance reconciled by adjustment ${adjustmentNo ?? ''} (${body.incidentRef ?? ''}).`,
          });
        }

        if (variance !== 0) {
          await this.outbox.publish(
            tx,
            pharmacyEvent('pharmacy.custody.variance', id, {
              checkId: id,
              storeId: body.storeId,
              itemId: body.itemId,
              itemCode: item.code,
              batchId: body.batchId ?? null,
              systemBalanceBase: quantityString(systemBalance),
              physicalCountBase: quantityString(Number(converted.qtyBase)),
              varianceBase: quantityString(variance),
              incidentRef: body.incidentRef ?? '',
              explanation: body.explanation ?? '',
              checkedBy1: ctx.userId ?? id,
              checkedBy2: secondId,
              checkedAt: new Date().toISOString(),
            }),
          );
        }
      }),
    );

    return this.custody(id);
  }

  /*
   * There is deliberately no "resolve this variance later" method.
   *
   * `pharmacy.narcotic_custody_checks` has UPDATE revoked, so `adjustment_id`
   * cannot be written after the row exists — and
   * `pharmacy.enforce_day_close_preconditions` refuses to close a business date
   * while a variance on it has none. A row filed without an adjustment would
   * therefore block that date's close permanently, with no lawful way back. So
   * the adjustment is cited when the count is filed, and `custodyCheck()` above
   * refuses the row otherwise.
   */

  /**
   * Witnessed destruction of controlled stock or wastage.
   *
   * Route key: `pharmacy.narcotic.prepare`. Real authority:
   * `pharmacy.narcotic.destroy`, which is also `requiresReason` — so the request
   * must carry an `x-reason` header as well as a co-signer, and the policy engine
   * refuses it otherwise.
   */
  async destroy(body: DestructionRequest): Promise<RegisterEntryView> {
    const secondId = await this.cosign.authorise('pharmacy.narcotic.destroy', body.coSigner);
    const ctx = getContext();
    const branchId = requireBranch();

    const entryId = await withPharmacyErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const item = await this.uoms.item(tx, body.itemId);
        const register = registerFor(item.schedule, item.is_narcotic);
        if (register === null) {
          throw new AppError(
            ProblemType.VALIDATION_FAILED,
            `${item.code} is not a controlled drug. Destroy it through an expiry or damage write-off instead.`,
          );
        }

        const converted = await this.uoms.toBase(tx, item, body.uomId, body.qtyEntered);

        const posted = await this.ledger.post(tx, {
          storeId: body.storeId,
          branchId,
          itemId: body.itemId,
          batchId: body.batchId,
          movementType: 'wastage',
          qtyEntered: converted.qtyEntered,
          uomId: converted.uomId,
          refType: 'writeoff',
          refId: newId(),
          reason: body.reason,
          remarks: body.bmwRecordRef ?? null,
          secondActorId: secondId,
        });

        const id = await this.dispenses.writeRegisterEntry(tx, {
          registerType: register,
          storeId: body.storeId,
          branchId,
          itemId: body.itemId,
          batchId: body.batchId,
          uomId: converted.uomId,
          qtyOutBase: converted.qtyBase,
          txnType: 'destruction',
          patientId: null,
          patientName: null,
          prescriberName: null,
          prescriberRegNo: null,
          rxRef: null,
          refType: 'writeoff',
          refId: posted.ledgerId,
          ledgerId: posted.ledgerId,
          firstAuthUserId: ctx.userId ?? '',
          secondAuthUserId: secondId,
          remarks: `${body.reason}${body.bmwRecordRef === undefined ? '' : ` (BMW ${body.bmwRecordRef})`}`,
        });

        await this.audit.write(tx, {
          action: 'delete',
          entity: 'pharmacy.controlled_drug_register',
          rowId: id,
          businessKey: `${register}/${item.code}`,
          dataClass: 'phi',
          reasonText: body.reason,
          before: null,
          after: {
            txn_type: 'destruction',
            qty_base: converted.qtyBase,
            witnessed_by: secondId,
            bmw_record_ref: body.bmwRecordRef ?? null,
          },
        });

        return id;
      }),
    );

    return this.entry(entryId);
  }

  // ── reads ────────────────────────────────────────────────────────────────

  async entry(id: string): Promise<RegisterEntryView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const row = await tx.maybeOne<RegisterRow>(`${REGISTER_SQL} WHERE r.id = $1`, [id]);
      if (row === undefined) throw AppError.notFound('The register entry');
      return toRegisterView(row);
    });
  }

  async list(query: RegisterQuery): Promise<Page<RegisterEntryView>> {
    const hospital = hospitalId();
    const resource = 'pharmacy.controlled_drug_register';
    const limit = this.cursors.pageSize(query.limit);
    const after = this.cursors.start(query.cursor, { hospitalId: hospital, resource });

    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const values: unknown[] = [];
      const bind = binder(values);
      const clauses: string[] = [];
      if (query.storeId !== undefined) clauses.push(`r.store_id = ${bind(query.storeId)}::uuid`);
      if (query.registerType !== undefined) {
        clauses.push(`r.register_type = ${bind(query.registerType)}::pharmacy."PhRegisterType"`);
      }
      if (query.itemId !== undefined) clauses.push(`r.item_id = ${bind(query.itemId)}::uuid`);
      if (query.from !== undefined) clauses.push(`r.entered_at >= ${bind(query.from)}::timestamptz`);
      if (after !== null) {
        clauses.push(`(r.entered_at, r.id) < (${bind(after.k[0])}::timestamptz, ${bind(after.id)}::uuid)`);
      }
      const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;

      const rows = await tx.rows<RegisterRow & { cursor_key: string }>(
        `${REGISTER_SQL} ${where}
          ORDER BY r.entered_at DESC, r.id DESC LIMIT ${bind(limit + 1)}`,
        values,
      );
      const page = this.cursors.keysetPage<RegisterRow>(rows, limit, {
        hospitalId: hospital,
        resource,
        direction: 'desc',
      });
      return { items: page.items.map(toRegisterView), nextCursor: page.nextCursor, hasMore: page.hasMore };
    });
  }

  async custody(id: string): Promise<CustodyCheckView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const row = await tx.maybeOne<{
        id: string;
        store_id: string;
        item_id: string;
        batch_id: string | null;
        shift_label: string;
        system_balance_base: string;
        physical_count_base: string;
        variance_base: string;
        checked_by_1: string;
        checked_by_2: string;
        incident_ref: string | null;
        explanation: string | null;
        checked_at: string;
      }>(
        `SELECT id, store_id, item_id, batch_id, shift_label,
                system_balance_base::text AS system_balance_base,
                physical_count_base::text AS physical_count_base,
                variance_base::text AS variance_base, checked_by_1, checked_by_2,
                incident_ref, explanation, checked_at::text AS checked_at
           FROM pharmacy.narcotic_custody_checks WHERE id = $1`,
        [id],
      );
      if (row === undefined) throw AppError.notFound('The custody check');
      return {
        id: row.id,
        storeId: row.store_id,
        itemId: row.item_id,
        batchId: row.batch_id,
        shiftLabel: row.shift_label,
        systemBalanceBase: row.system_balance_base,
        physicalCountBase: row.physical_count_base,
        varianceBase: row.variance_base,
        checkedBy1: row.checked_by_1,
        checkedBy2: row.checked_by_2,
        incidentRef: row.incident_ref,
        explanation: row.explanation,
        checkedAt: new Date(row.checked_at).toISOString(),
      };
    });
  }
}

const REGISTER_SQL = `SELECT r.id, r.register_type::text AS register_type, r.serial_no, r.fy, r.store_id,
        r.item_id, i.code AS item_code, r.batch_id, r.txn_type::text AS txn_type,
        r.qty_in_base::text AS qty_in_base, r.qty_out_base::text AS qty_out_base,
        r.balance_after_base::text AS balance_after_base, r.patient_id, r.patient_name,
        r.prescriber_name, r.prescriber_reg_no, r.first_auth_user_id, r.second_auth_user_id,
        r.remarks, r.entered_at::text AS entered_at, r.entered_at::text AS cursor_key
   FROM pharmacy.controlled_drug_register r
   JOIN inventory.items i ON i.id = r.item_id`;

interface RegisterRow {
  readonly id: string;
  readonly register_type: string;
  readonly serial_no: string;
  readonly fy: string;
  readonly store_id: string;
  readonly item_id: string;
  readonly item_code: string;
  readonly batch_id: string | null;
  readonly txn_type: string;
  readonly qty_in_base: string;
  readonly qty_out_base: string;
  readonly balance_after_base: string;
  readonly patient_id: string | null;
  readonly patient_name: string | null;
  readonly prescriber_name: string | null;
  readonly prescriber_reg_no: string | null;
  readonly first_auth_user_id: string;
  readonly second_auth_user_id: string | null;
  readonly remarks: string | null;
  readonly entered_at: string;
}

function toRegisterView(row: RegisterRow): RegisterEntryView {
  return {
    id: row.id,
    registerType: row.register_type,
    serialNo: row.serial_no,
    fy: row.fy,
    storeId: row.store_id,
    itemId: row.item_id,
    itemCode: row.item_code,
    batchId: row.batch_id,
    txnType: row.txn_type,
    qtyInBase: row.qty_in_base,
    qtyOutBase: row.qty_out_base,
    balanceAfterBase: row.balance_after_base,
    patientId: row.patient_id,
    patientName: row.patient_name,
    prescriberName: row.prescriber_name,
    prescriberRegNo: row.prescriber_reg_no,
    firstAuthUserId: row.first_auth_user_id,
    secondAuthUserId: row.second_auth_user_id,
    remarks: row.remarks,
    enteredAt: new Date(row.entered_at).toISOString(),
  };
}
