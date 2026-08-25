import { Inject, Injectable } from '@nestjs/common';
import { ProblemType, newId, type Page } from '@vims/contracts';
import { AuditService } from '../../core/audit/audit.service.js';
import { getContext } from '../../core/context/request-context.js';
import { DatabaseService, type TransactionClient } from '../../core/db/database.service.js';
import { NumberingService } from '../../core/numbering/numbering.service.js';
import { OutboxService } from '../../core/outbox/outbox.service.js';
import { CursorService } from '../../core/pagination/cursor.service.js';
import { AppError } from '../../core/problem/app-error.js';
import { currentTenantContext } from '../../core/tenancy/tenant-context.js';
import {
  binder,
  hospitalId,
  moneyString,
  quantityString,
  requireBranch,
} from '../inventory/inventory.common.js';
import { ItemsService } from '../inventory/items.service.js';
import { StockLedgerService } from '../inventory/stock-ledger.service.js';
import { UomService, type ItemFacts } from '../inventory/uom.service.js';
import { CdssService } from '../opd/prescribing/cdss.service.js';
import { PharmacyCoSignService } from './cosign.service.js';
import {
  DUAL_AUTH_SCHEDULES,
  PRESCRIPTION_ONLY,
  financialYear,
  pharmacyEvent,
  registerFor,
  withPharmacyErrors,
} from './pharmacy.common.js';
import type {
  AddDispenseItemRequest,
  CancelDispenseRequest,
  CompleteDispenseRequest,
  CreateDispenseRequest,
  DeclineDispenseItemRequest,
  DecideSubstitutionRequest,
  DispenseQuery,
  LabelRequest,
  RequestSubstitutionRequest,
  SecondAuthoriserRequest,
} from './pharmacy.schemas.js';
import type {
  DispenseAlertView,
  DispenseItemView,
  DispenseView,
  LabelView,
  SubstitutionView,
} from './pharmacy.types.js';
import { RxQueueService } from './queue.service.js';

/**
 * The CDSS families the **counter** is the second net for.
 *
 * `docs/04 §7` and `phase-04 §4.4` name exactly two: allergy and interaction.
 * The rest of EN-029's floor is prescriber-facing and fires on facts a
 * pharmacist cannot change — `schedule_guardrail`, for instance, hard-stops when
 * the *prescriber's* profile carries no registration number, or when the
 * statutory NDPS cap has not been loaded into the knowledge base. Blocking a
 * morphine dispense at the counter for either of those would stop a pain
 * patient's supply for an administrative reason, which is precisely the
 * behaviour `pharmacy.controlled_substance_limits`' own migration comment warns
 * against: India's morphine consumption fell ~92 % under a regime of exactly
 * that kind of friction.
 *
 * So every alert is evaluated, every alert is recorded on the line and visible
 * to the pharmacist, and these two families are the ones that refuse the
 * completion. The others already blocked the prescriber, which is where they
 * belong.
 */
const COUNTER_BLOCKING_FAMILIES: ReadonlySet<string> = new Set(['allergy', 'ddi']);

/**
 * OP-003 §3 — the dispensing counter, and the four refusals that make it safe.
 *
 * ── 1. Fail closed on the batch ─────────────────────────────────────────────
 *
 * `phase-04 §Constraints`: "never dispense without a successful batch validation
 * — fail closed on stock integrity." A line is refused here unless its batch
 * exists, is active, is not expired, is not under an open quarantine and has the
 * quantity on this counter's shelf. `pharmacy.enforce_dispense_line` refuses a
 * batch-tracked line with no batch at all, and
 * `inventory.enforce_ledger_preconditions` refuses the movement at completion —
 * so the same fact is checked three times, on purpose. The one in this file is
 * the one that produces a message a pharmacist can act on; the other two are
 * what make it true on every path.
 *
 * ── 2. The CDSS re-check is not skippable ───────────────────────────────────
 *
 * `docs/04 §7` calls the pharmacist the second safety net. `complete()`
 * **always** re-runs the EN-029 evaluation, inside the completing transaction,
 * against the facts as they are at that moment — not against a result the client
 * cached, and not conditionally on a flag. A hard stop with no recorded
 * acknowledgement refuses the completion. There is no request shape that skips
 * it: the only thing the client can send is the pharmacist's *reason*, which is
 * the one thing a re-run cannot produce.
 *
 * ── 3. Two pharmacists for a controlled drug ────────────────────────────────
 *
 * `pharmacy.narcotic.dispense` is `requiresSecondPerson` and therefore cannot
 * decorate a route. The second signature is taken by
 * `POST /dispenses/{id}/second-authoriser` — decorated with the precondition key
 * `pharmacy.narcotic.prepare`, asserting the real key inside
 * `PharmacyCoSignService` with the co-signer attached. It has to happen *before*
 * the controlled line is added, because `pharmacy.enforce_dispense_line` reads
 * `dispenses.second_auth_user_id` when the line is inserted. That ordering is
 * not an accident of the schema: it means the second pharmacist is standing
 * there when the drug is picked, rather than signing afterwards for something
 * they did not see.
 *
 * ── 4. Stock moves once, at completion ──────────────────────────────────────
 *
 * A draft dispense holds nothing and moves nothing; cancelling one is free. Every
 * line's ledger movement is written in the single transaction that marks the
 * dispense complete, so a counter that loses its network mid-basket leaves no
 * stock in limbo — and a retry of `complete` is refused by the status check
 * rather than dispensing twice.
 */
@Injectable()
export class DispenseService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(NumberingService) private readonly numbering: NumberingService,
    @Inject(CursorService) private readonly cursors: CursorService,
    @Inject(StockLedgerService) private readonly ledger: StockLedgerService,
    @Inject(UomService) private readonly uoms: UomService,
    @Inject(ItemsService) private readonly items: ItemsService,
    @Inject(CdssService) private readonly cdss: CdssService,
    @Inject(PharmacyCoSignService) private readonly cosign: PharmacyCoSignService,
    @Inject(RxQueueService) private readonly queue: RxQueueService,
  ) {}

  // ── create ───────────────────────────────────────────────────────────────

  async create(body: CreateDispenseRequest): Promise<DispenseView> {
    const ctx = getContext();
    const branchId = requireBranch();
    const id = newId();

    await withPharmacyErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const counter = await this.counter(tx, body.pharmacyStoreId);

        let patientId = body.patientId ?? null;
        let prescriberName = body.prescriberName ?? null;
        let prescriberRegNo = body.prescriberRegNo ?? null;
        let encounterId = body.encounterId ?? null;

        if (body.prescriptionId !== undefined) {
          const rx = await tx.maybeOne<{
            patient_id: string;
            encounter_id: string | null;
            status: string;
            signer_registration_no: string | null;
            doctor_name: string | null;
          }>(
            `SELECT p.patient_id, p.encounter_id, p.status::text AS status, p.signer_registration_no,
                    u.display_name AS doctor_name
               FROM clinical.prescriptions p
               LEFT JOIN core.users u ON u.id = p.doctor_user_id
              WHERE p.id = $1`,
            [body.prescriptionId],
          );
          if (rx === undefined) throw AppError.notFound('The prescription');
          if (!['signed', 'partially_dispensed'].includes(rx.status)) {
            throw new AppError(
              ProblemType.BUSINESS_RULE_VIOLATED,
              `That prescription is "${rx.status}" and cannot be dispensed against. Only a signed prescription can be filled.`,
            );
          }
          // Taken from the prescription, never from the request: a dispense that
          // could name a different patient from the prescription it cites is the
          // wrong-patient error with a paper trail that says it was right.
          patientId = rx.patient_id;
          encounterId = rx.encounter_id;
          prescriberName = rx.doctor_name;
          prescriberRegNo = rx.signer_registration_no;
        }

        const dispenseNo = (
          await this.numbering.allocate(tx, {
            key: 'DISP',
            branchId,
            refType: 'pharmacy.dispenses',
            refId: id,
          })
        ).formatted;

        await tx.query(
          `INSERT INTO pharmacy.dispenses
             (id, hospital_id, branch_id, pharmacy_store_id, store_id, dispense_no, dispense_type,
              prescription_id, rx_queue_id, patient_id, encounter_id, walk_in_name, walk_in_phone,
              prescriber_name, prescriber_reg_no, status, pharmacist_user_id, payer_type, notes,
              created_by, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::pharmacy."PhDispenseType",
                   $8, $9, $10, $11, $12, $13,
                   $14, $15, 'draft'::pharmacy."PhDispenseStatus", $16, $17, $18,
                   $16, $16, now())`,
          [
            id,
            ctx.hospitalId,
            branchId,
            body.pharmacyStoreId,
            counter.store_id,
            dispenseNo,
            body.dispenseType,
            body.prescriptionId ?? null,
            body.rxQueueId ?? null,
            patientId,
            encounterId,
            body.walkInName ?? null,
            body.walkInPhone ?? null,
            prescriberName,
            prescriberRegNo,
            ctx.userId,
            body.payerType,
            body.notes ?? null,
          ],
        );

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'pharmacy.dispenses',
          rowId: id,
          businessKey: dispenseNo,
          dataClass: 'phi',
          patientId,
          encounterId,
          before: null,
          after: {
            dispense_type: body.dispenseType,
            pharmacy_store_id: body.pharmacyStoreId,
            prescription_id: body.prescriptionId ?? null,
          },
        });
      }),
    );

    return this.get(id);
  }

  /**
   * The second pharmacist's signature, taken before a controlled line is added.
   *
   * Decorated with `pharmacy.narcotic.prepare` at the route; the real authority,
   * `pharmacy.narcotic.dispense`, is asserted here with the co-signer attached.
   */
  async addSecondAuthoriser(id: string, body: SecondAuthoriserRequest): Promise<DispenseView> {
    const secondId = await this.cosign.authorise('pharmacy.narcotic.dispense', body.coSigner);
    const ctx = getContext();

    await withPharmacyErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const header = await this.lock(tx, id);
        if (header.status !== 'draft') {
          throw new AppError(
            ProblemType.ALREADY_DECIDED,
            'This dispense is no longer a draft, so a second authoriser cannot be added to it.',
          );
        }
        if (header.pharmacist_user_id === secondId) {
          throw new AppError(
            ProblemType.SEGREGATION_OF_DUTIES,
            'The dispensing pharmacist cannot also be the authorising one.',
          );
        }

        await tx.query(
          `UPDATE pharmacy.dispenses
              SET second_auth_user_id = $2, updated_at = now(), updated_by = $3, version = version + 1
            WHERE id = $1`,
          [id, secondId, ctx.userId],
        );

        await this.audit.write(tx, {
          action: 'update',
          entity: 'pharmacy.dispenses',
          rowId: id,
          businessKey: header.dispense_no,
          dataClass: 'phi',
          patientId: header.patient_id,
          reasonText: body.note ?? 'Second pharmacist authorised a controlled-drug dispense',
          before: { second_auth_user_id: header.second_auth_user_id },
          after: { second_auth_user_id: secondId },
        });
      }),
    );

    return this.get(id);
  }

  // ── lines ────────────────────────────────────────────────────────────────

  /**
   * One scanned pack becomes one line — after the batch has been validated.
   *
   * The validation is the point of the method. Everything below the resolution
   * step exists so that a line cannot come into being for stock that is expired,
   * quarantined, recalled, on another counter's shelf, or simply not there.
   */
  async addItem(id: string, body: AddDispenseItemRequest): Promise<DispenseView> {
    const ctx = getContext();

    await withPharmacyErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const header = await this.lock(tx, id);
        if (header.status !== 'draft') {
          throw new AppError(
            ProblemType.ALREADY_DECIDED,
            'This dispense has already been completed or cancelled; nothing more can be added to it.',
          );
        }

        const resolved =
          body.scanned === undefined
            ? null
            : await this.items.resolveScan(body.scanned).catch((error: unknown) => {
                throw error;
              });
        const itemId = body.itemId ?? resolved?.itemId;
        if (itemId === undefined) throw AppError.notFound('The item');

        const item = await this.uoms.item(tx, itemId);
        this.assertDispensable(item, header.dispense_type);

        const batchId = body.batchId ?? resolved?.batchId ?? null;
        const validated = await this.validateBatch(tx, header.store_id, item, batchId, body);

        const converted = await this.uoms.toBase(
          tx,
          item,
          body.uomId ?? item.dispense_uom_id ?? undefined,
          body.qtyEntered,
        );
        if (Number(converted.qtyBase) > Number(validated.available)) {
          throw new AppError(
            ProblemType.BUSINESS_RULE_VIOLATED,
            `Batch ${validated.batchNo ?? ''} of ${item.code} has ${validated.available} base units available at this counter and this line asks for ${converted.qtyBase}. Split the line across batches, offer a partial fill, or report the stockout.`,
            { nextAction: 'Scan another batch, or record a partial fill with its reason.' },
          );
        }

        const pricing = await this.priceOf(tx, item, validated.batchId);
        const lineNo = await this.nextLineNo(tx, id);
        const qtyOrdered = body.qtyOrderedBase ?? Number(converted.qtyBase);
        const isPartial = qtyOrdered > Number(converted.qtyBase);
        if (isPartial && body.partialReason === undefined) {
          throw new AppError(
            ProblemType.VALIDATION_FAILED,
            'This line gives less than was prescribed, so it is a partial fill and needs a reason the prescriber can read.',
            { nextAction: 'Record why only part of the quantity is being given.' },
          );
        }

        const substitution =
          body.substitutionRequestId === undefined
            ? null
            : await this.approvedSubstitution(tx, body.substitutionRequestId, itemId);

        const net = pricing.sellingPrice * Number(converted.qtyEntered) - (body.discount ?? 0);
        const tax = net * (pricing.gstRate / 100);

        await tx.query(
          `INSERT INTO pharmacy.dispense_items
             (id, hospital_id, dispense_id, line_no, prescription_item_id, item_id, batch_id,
              uom_id, qty_ordered_base, qty_entered, qty_base, status, partial_reason,
              substituted_from_item_id, substitution_request_id, mrp, selling_price, discount,
              hsn_code, gst_rate, tax_amount, line_total, fefo_override, fefo_override_reason,
              scanned, created_by, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7,
                   $8, $9::numeric, $10::numeric, $11::numeric,
                   $12::pharmacy."PhDispenseItemStatus", $13,
                   $14, $15, $16::numeric, $17::numeric, $18::numeric,
                   $19, $20::numeric, $21::numeric, $22::numeric, $23, $24,
                   $25, $26, $26, now())`,
          [
            newId(),
            ctx.hospitalId,
            id,
            lineNo,
            body.prescriptionItemId ?? null,
            itemId,
            validated.batchId,
            converted.uomId,
            qtyOrdered.toFixed(4),
            converted.qtyEntered,
            converted.qtyBase,
            substitution === null ? (isPartial ? 'partial' : 'dispensed') : 'substituted',
            isPartial ? body.partialReason : null,
            substitution?.fromItemId ?? null,
            body.substitutionRequestId ?? null,
            pricing.mrp,
            pricing.sellingPrice,
            body.discount ?? 0,
            item.hsn_code,
            pricing.gstRate,
            tax.toFixed(2),
            (net + tax).toFixed(2),
            validated.fefoOverride,
            validated.fefoOverride ? (body.fefoOverrideReason ?? null) : null,
            body.scanned !== undefined,
            ctx.userId,
          ],
        );

        await this.retotal(tx, id);
      }),
    );

    return this.get(id);
  }

  /**
   * A line that will not be filled: out of stock, declined by the patient, or
   * referred outside. Recorded rather than omitted — `phase-04 §4.4`: the
   * prescriber has to know which drug the patient is walking out without.
   */
  async declineItem(id: string, body: DeclineDispenseItemRequest): Promise<DispenseView> {
    const ctx = getContext();

    await withPharmacyErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const header = await this.lock(tx, id);
        if (header.status !== 'draft') {
          throw new AppError(ProblemType.ALREADY_DECIDED, 'This dispense is no longer a draft.');
        }
        const item = await this.uoms.item(tx, body.itemId);
        const lineNo = await this.nextLineNo(tx, id);

        await tx.query(
          `INSERT INTO pharmacy.dispense_items
             (id, hospital_id, dispense_id, line_no, prescription_item_id, item_id, uom_id,
              qty_ordered_base, qty_entered, qty_base, status, partial_reason,
              created_by, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7,
                   $8::numeric, 0, 0, $9::pharmacy."PhDispenseItemStatus", $10, $11, $11, now())`,
          [
            newId(),
            ctx.hospitalId,
            id,
            lineNo,
            body.prescriptionItemId ?? null,
            body.itemId,
            body.uomId ?? item.base_uom_id,
            body.qtyOrderedBase.toFixed(4),
            body.status,
            body.reason,
            ctx.userId,
          ],
        );

        if (body.status === 'backordered' || body.status === 'external') {
          await this.outbox.publish(
            tx,
            pharmacyEvent('pharmacy.stockout.reported', item.id, {
              itemId: item.id,
              itemCode: item.code,
              pharmacyStoreId: header.pharmacy_store_id,
              prescriptionId: header.prescription_id,
              requestedQtyBase: quantityString(body.qtyOrderedBase),
              substituteOffered: false,
              reportedAt: new Date().toISOString(),
            }),
          );
        }

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'pharmacy.dispense_items',
          rowId: id,
          businessKey: header.dispense_no,
          dataClass: 'phi',
          patientId: header.patient_id,
          reasonText: body.reason,
          before: null,
          after: { item_code: item.code, status: body.status },
        });
      }),
    );

    return this.get(id);
  }

  // ── the CDSS re-check ────────────────────────────────────────────────────

  /**
   * EN-029 at the counter, on demand.
   *
   * Exposed so the pharmacist sees the alerts while there is still time to
   * telephone the prescriber, rather than at the moment they press complete.
   * Completion re-runs it regardless — this route is a convenience, never the
   * gate.
   */
  async check(id: string): Promise<DispenseView> {
    await withPharmacyErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const header = await this.lock(tx, id);
        await this.evaluate(tx, header);
      }),
    );
    return this.get(id);
  }

  // ── completion ───────────────────────────────────────────────────────────

  async complete(id: string, body: CompleteDispenseRequest): Promise<DispenseView> {
    const ctx = getContext();

    // The co-sign, if one is offered here rather than earlier, happens outside
    // the completing transaction because it authenticates a second user and
    // that read must not sit inside a transaction holding row locks on the
    // dispense.
    let lateCoSigner: string | null = null;
    if (body.coSigner !== undefined) {
      lateCoSigner = await this.cosign.authorise('pharmacy.narcotic.dispense', body.coSigner);
    }

    await withPharmacyErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const header = await this.lock(tx, id);
        if (header.status !== 'draft') {
          throw new AppError(
            ProblemType.ALREADY_DECIDED,
            `This dispense is "${header.status}". Only a draft can be completed — a repeated request has already been honoured.`,
          );
        }

        const lines = await this.lineRows(tx, id);
        if (lines.length === 0) {
          throw new AppError(
            ProblemType.VALIDATION_FAILED,
            'This dispense has no lines. There is nothing to give the patient.',
          );
        }

        if (lateCoSigner !== null && header.second_auth_user_id === null) {
          await tx.query(
            `UPDATE pharmacy.dispenses SET second_auth_user_id = $2, updated_at = now() WHERE id = $1`,
            [id, lateCoSigner],
          );
        }
        const secondAuth = header.second_auth_user_id ?? lateCoSigner;

        // Belt and braces with `pharmacy.enforce_dispense_line`, which already
        // refused the line at insert. Repeated here because a trigger dropped in
        // a future migration must not silently make this path single-signature.
        const controlled = lines.filter((l) => DUAL_AUTH_SCHEDULES.has(l.schedule));
        if (controlled.length > 0 && (secondAuth === null || secondAuth === header.pharmacist_user_id)) {
          throw new AppError(
            ProblemType.SECOND_PERSON_REQUIRED,
            'This dispense contains a narcotic or psychotropic drug and has no second authorising pharmacist. Two signatures from one person are one signature.',
            { nextAction: 'Ask a second authorised pharmacist to countersign on this screen.' },
          );
        }

        // ── the safety net, re-run now, against the facts as they are now ──
        const outcome = await this.evaluate(tx, header);
        const acknowledged = new Set(body.acknowledgements.map((a) => a.alertKey));
        const unresolved = outcome.blocking.filter((a) => !acknowledged.has(a.subjectCode));
        if (unresolved.length > 0) {
          throw new AppError(
            ProblemType.CLINICAL_HARD_STOP,
            `This prescription still has ${unresolved.length} unresolved safety alert(s) at the counter: ${unresolved
              .map((a) => a.title)
              .join('; ')}.`,
            {
              clinicalImpact:
                'The pharmacist is the second safety net for allergy and interaction. Dispensing over an unacknowledged hard stop is not permitted.',
              nextAction:
                'Telephone the prescriber. If the drug is still to be given, record the reason against each alert and complete again.',
            },
          );
        }

        for (const ack of body.acknowledgements) {
          await tx.query(
            `UPDATE pharmacy.dispense_items
                SET cdss_override_reason = $2, updated_at = now(), updated_by = $3
              WHERE id = $1 AND dispense_id = $4`,
            [ack.dispenseItemId, ack.reason, ctx.userId, id],
          );
        }

        // ── the stock, once ────────────────────────────────────────────────
        const movementType = header.dispense_type === 'otc' ? 'sale' : 'dispense';
        const eventLines: {
          dispenseItemId: string;
          itemId: string;
          batchId: string | null;
          batchNo: string | null;
          expiryDate: string | null;
          qtyBase: string;
          substituted: boolean;
        }[] = [];
        const unfilled: {
          dispenseItemId: string;
          itemId: string;
          status: 'partial' | 'backordered' | 'declined' | 'external';
          reason: string;
        }[] = [];

        for (const line of lines) {
          if (['declined', 'backordered', 'external', 'cancelled'].includes(line.status)) {
            unfilled.push({
              dispenseItemId: line.id,
              itemId: line.item_id,
              status: line.status as 'backordered' | 'declined' | 'external',
              reason: line.partial_reason ?? 'No reason recorded',
            });
            continue;
          }
          if (Number(line.qty_base) <= 0) continue;

          const posted = await this.ledger.post(tx, {
            storeId: header.store_id,
            branchId: header.branch_id,
            itemId: line.item_id,
            batchId: line.batch_id,
            movementType,
            qtyEntered: line.qty_entered,
            uomId: line.uom_id,
            unitCost: line.unit_cost === null ? null : Number(line.unit_cost),
            refType: 'dispense',
            refId: id,
            refLineId: line.id,
            patientId: header.patient_id,
            encounterId: header.encounter_id,
            ...(secondAuth === null ? {} : { secondActorId: secondAuth }),
          });

          await tx.query(`UPDATE pharmacy.dispense_items SET ledger_id = $2 WHERE id = $1`, [
            line.id,
            posted.ledgerId,
          ]);

          if (line.status === 'partial') {
            unfilled.push({
              dispenseItemId: line.id,
              itemId: line.item_id,
              status: 'partial',
              reason: line.partial_reason ?? 'Partial fill',
            });
          }

          eventLines.push({
            dispenseItemId: line.id,
            itemId: line.item_id,
            batchId: line.batch_id,
            batchNo: line.batch_no,
            expiryDate: line.expiry_date,
            qtyBase: quantityString(Number(line.qty_base)),
            substituted: line.status === 'substituted',
          });

          // ── the statutory register ───────────────────────────────────────
          const register = registerFor(line.schedule, line.is_narcotic);
          if (register !== null) {
            await this.writeRegisterEntry(tx, {
              registerType: register,
              storeId: header.store_id,
              branchId: header.branch_id,
              itemId: line.item_id,
              batchId: line.batch_id,
              uomId: line.uom_id,
              qtyOutBase: line.qty_base,
              patientId: header.patient_id,
              patientName: header.walk_in_name,
              prescriberName: header.prescriber_name,
              prescriberRegNo: header.prescriber_reg_no,
              rxRef: header.prescription_id,
              refType: 'dispense',
              refId: id,
              ledgerId: posted.ledgerId,
              firstAuthUserId: header.pharmacist_user_id,
              secondAuthUserId: secondAuth,
              remarks: null,
            });
          }
        }

        const totals = await this.retotal(tx, id);
        const status = unfilled.length > 0 ? 'partially_dispensed' : 'dispensed';

        await tx.query(
          `UPDATE pharmacy.dispenses
              SET status = $2::pharmacy."PhDispenseStatus", dispensed_at = now(),
                  counselling = $3::jsonb, updated_at = now(), updated_by = $4, version = version + 1
            WHERE id = $1`,
          [id, status, JSON.stringify(body.counselling ?? {}), ctx.userId],
        );

        if (header.prescription_id !== null) {
          await tx.query(
            `UPDATE clinical.prescriptions
                SET status = $2::clinical."PrescriptionStatus", updated_at = now(), updated_by = $3
              WHERE id = $1 AND status IN ('signed', 'partially_dispensed')`,
            [header.prescription_id, unfilled.length > 0 ? 'partially_dispensed' : 'dispensed', ctx.userId],
          );
        }
        if (header.rx_queue_id !== null) {
          await this.queue.markCompleted(
            tx,
            header.rx_queue_id,
            unfilled.length > 0 ? 'partial' : 'completed',
          );
        }

        await this.audit.write(tx, {
          action: 'update',
          entity: 'pharmacy.dispenses',
          rowId: id,
          businessKey: header.dispense_no,
          dataClass: 'phi',
          patientId: header.patient_id,
          encounterId: header.encounter_id,
          before: { status: header.status },
          after: {
            status,
            lines: lines.length,
            total_amount: totals.total,
            second_auth_user_id: secondAuth,
          },
        });

        if (header.patient_id !== null) {
          if (unfilled.length === 0) {
            await this.outbox.publish(
              tx,
              pharmacyEvent('rx.dispensed', id, {
                dispenseId: id,
                dispenseNo: header.dispense_no,
                prescriptionId: header.prescription_id,
                patientId: header.patient_id,
                pharmacyStoreId: header.pharmacy_store_id,
                pharmacistUserId: header.pharmacist_user_id,
                lines: eventLines,
                totalValue: moneyString(Number(totals.total)),
                currency: 'INR',
                dispensedAt: new Date().toISOString(),
              }),
            );
          } else {
            await this.outbox.publish(
              tx,
              pharmacyEvent('rx.partially_dispensed', id, {
                dispenseId: id,
                dispenseNo: header.dispense_no,
                prescriptionId: header.prescription_id,
                patientId: header.patient_id,
                pharmacyStoreId: header.pharmacy_store_id,
                dispensedLines: eventLines.length,
                unfilledLines: unfilled,
                dispensedAt: new Date().toISOString(),
              }),
            );
          }
        }
      }),
    );

    return this.get(id);
  }

  async cancel(id: string, body: CancelDispenseRequest): Promise<DispenseView> {
    const ctx = getContext();

    await withPharmacyErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const header = await this.lock(tx, id);
        if (header.status !== 'draft' && header.status !== 'awaiting_payment') {
          throw new AppError(
            ProblemType.ALREADY_DECIDED,
            'This dispense has already been completed. The medicine has left the counter, so the way back is a return, not a cancellation.',
            { nextAction: 'Record a sale return instead.' },
          );
        }

        await tx.query(
          `UPDATE pharmacy.dispenses
              SET status = 'cancelled'::pharmacy."PhDispenseStatus", cancel_reason = $2,
                  updated_at = now(), updated_by = $3, version = version + 1
            WHERE id = $1`,
          [id, body.reason, ctx.userId],
        );
        await tx.query(
          `UPDATE pharmacy.dispense_items
              SET status = 'cancelled'::pharmacy."PhDispenseItemStatus", updated_at = now()
            WHERE dispense_id = $1`,
          [id],
        );
        if (header.rx_queue_id !== null) await this.queue.markCompleted(tx, header.rx_queue_id, 'cancelled');

        await this.audit.write(tx, {
          action: 'update',
          entity: 'pharmacy.dispenses',
          rowId: id,
          businessKey: header.dispense_no,
          dataClass: 'phi',
          patientId: header.patient_id,
          reasonText: body.reason,
          before: { status: header.status },
          after: { status: 'cancelled' },
        });
      }),
    );

    return this.get(id);
  }

  // ── substitution ─────────────────────────────────────────────────────────

  /**
   * A substitution the prescriber has to approve, unless the substitute mapping
   * says otherwise.
   *
   * `item_substitutes.requires_prescriber_approval` defaults to true, and this
   * method honours it: a mapping marked as not requiring approval is a decision
   * the hospital's formulary committee made once, in writing, and it is the only
   * way a line changes drug without a prescriber saying so.
   */
  async requestSubstitution(dispenseId: string, body: RequestSubstitutionRequest): Promise<SubstitutionView> {
    const ctx = getContext();
    const id = newId();

    await withPharmacyErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const header = await this.lock(tx, dispenseId);
        const mapping = await tx.maybeOne<{ requires_prescriber_approval: boolean }>(
          `SELECT requires_prescriber_approval FROM inventory.item_substitutes
            WHERE item_id = $1 AND substitute_item_id = $2 AND active`,
          [body.fromItemId, body.toItemId],
        );
        if (mapping === undefined) {
          throw new AppError(
            ProblemType.BUSINESS_RULE_VIOLATED,
            'Those two items are not mapped as substitutes in the item master. A swap the formulary has not sanctioned is a different drug, not a substitution.',
            { nextAction: 'Ask the prescriber to change the prescription instead.' },
          );
        }

        const expiresAt = new Date(Date.now() + body.decisionMinutes * 60_000);
        const status = mapping.requires_prescriber_approval ? 'pending' : 'not_required';

        await tx.query(
          `INSERT INTO pharmacy.substitution_requests
             (id, hospital_id, prescription_item_id, dispense_id, patient_id, from_item_id,
              to_item_id, reason, requested_by, prescriber_user_id, status, expires_at,
              decided_by, decided_at, created_by, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6,
                   $7, $8, $9, $10, $11::pharmacy."PhSubstitutionStatus", $12::timestamptz,
                   CASE WHEN $11 = 'not_required' THEN $9 ELSE NULL END,
                   CASE WHEN $11 = 'not_required' THEN now() ELSE NULL END, $9, $9, now())`,
          [
            id,
            ctx.hospitalId,
            body.prescriptionItemId ?? null,
            dispenseId,
            header.patient_id,
            body.fromItemId,
            body.toItemId,
            body.reason,
            ctx.userId,
            body.prescriberUserId ?? null,
            status,
            expiresAt.toISOString(),
          ],
        );

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'pharmacy.substitution_requests',
          rowId: id,
          businessKey: header.dispense_no,
          dataClass: 'phi',
          patientId: header.patient_id,
          reasonText: body.reason,
          before: null,
          after: { from_item_id: body.fromItemId, to_item_id: body.toItemId, status },
        });

        if (status === 'pending' && header.patient_id !== null) {
          await this.outbox.publish(
            tx,
            pharmacyEvent('pharmacy.substitution.requested', id, {
              requestId: id,
              dispenseId,
              patientId: header.patient_id,
              prescribedItemId: body.fromItemId,
              proposedItemId: body.toItemId,
              reason: body.reason,
              prescriberUserId: body.prescriberUserId ?? null,
              requestedBy: ctx.userId ?? id,
              requestedAt: new Date().toISOString(),
              decisionDueAt: expiresAt.toISOString(),
            }),
          );
        }
      }),
    );

    return this.substitution(id);
  }

  async decideSubstitution(id: string, body: DecideSubstitutionRequest): Promise<SubstitutionView> {
    const ctx = getContext();

    await withPharmacyErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const row = await tx.maybeOne<{
          status: string;
          dispense_id: string | null;
          patient_id: string | null;
          to_item_id: string;
          requested_by: string;
        }>(
          `SELECT status::text AS status, dispense_id, patient_id, to_item_id, requested_by
             FROM pharmacy.substitution_requests WHERE id = $1 FOR UPDATE`,
          [id],
        );
        if (row === undefined) throw AppError.notFound('The substitution request');
        if (row.status !== 'pending') {
          throw new AppError(
            ProblemType.ALREADY_DECIDED,
            `This substitution request is "${row.status}" and has already been answered.`,
          );
        }
        if (row.requested_by === ctx.userId) {
          throw new AppError(
            ProblemType.SEGREGATION_OF_DUTIES,
            'The pharmacist who proposed a substitution cannot be the one who approves it. The approval is the prescriber’s.',
          );
        }

        await tx.query(
          `UPDATE pharmacy.substitution_requests
              SET status = $2::pharmacy."PhSubstitutionStatus", decided_by = $3, decided_at = now(),
                  decision_note = $4, updated_at = now(), updated_by = $3
            WHERE id = $1`,
          [id, body.decision, ctx.userId, body.note ?? null],
        );

        await this.audit.write(tx, {
          action: body.decision === 'approved' ? 'approve' : 'reject',
          entity: 'pharmacy.substitution_requests',
          rowId: id,
          businessKey: id,
          dataClass: 'phi',
          patientId: row.patient_id,
          reasonText: body.note ?? null,
          before: { status: row.status },
          after: { status: body.decision },
        });

        if (row.patient_id !== null && row.dispense_id !== null) {
          await this.outbox.publish(
            tx,
            body.decision === 'approved'
              ? pharmacyEvent('pharmacy.substitution.approved', id, {
                  requestId: id,
                  dispenseId: row.dispense_id,
                  patientId: row.patient_id,
                  approvedItemId: row.to_item_id,
                  approvedBy: ctx.userId ?? id,
                  approvedAt: new Date().toISOString(),
                })
              : pharmacyEvent('pharmacy.substitution.rejected', id, {
                  requestId: id,
                  dispenseId: row.dispense_id,
                  patientId: row.patient_id,
                  reason: body.note ?? 'The prescriber refused the substitution.',
                  rejectedBy: ctx.userId ?? id,
                  rejectedAt: new Date().toISOString(),
                }),
          );
        }
      }),
    );

    return this.substitution(id);
  }

  // ── labels ───────────────────────────────────────────────────────────────

  /**
   * `phase-04` exit gate 2 — "labels print in English + one Indian language".
   *
   * The label content is assembled here and rendered by
   * `packages/print-templates` downstream. The instruction text falls back to
   * English when the counselling checklist has no translation for the requested
   * locale: a label with no instruction at all is worse than one in a language
   * the patient may not read, because the strip goes home either way.
   */
  async labels(id: string, body: LabelRequest): Promise<{ readonly labels: readonly LabelView[] }> {
    const ctx = getContext();

    return withPharmacyErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const header = await this.lock(tx, id);
        const lines = await this.lineRows(tx, id);

        const patientName =
          header.patient_id === null
            ? (header.walk_in_name ?? 'Walk-in')
            : ((
                await tx.maybeOne<{ full_name: string }>(
                  `SELECT full_name FROM patient.patients WHERE id = $1`,
                  [header.patient_id],
                )
              )?.full_name ?? 'Patient');

        const labels: LabelView[] = [];
        for (const line of lines) {
          if (Number(line.qty_base) <= 0) continue;
          const checklist = await tx.maybeOne<{ items: unknown; translations: unknown }>(
            `SELECT items, translations FROM pharmacy.counselling_checklists
              WHERE active AND (item_id = $1 OR item_id IS NULL)
              ORDER BY item_id NULLS LAST LIMIT 1`,
            [line.item_id],
          );

          const instructions = await tx.maybeOne<{ instructions_text: string | null }>(
            line.prescription_item_id === null
              ? `SELECT NULL::text AS instructions_text WHERE false`
              : `SELECT instructions_text FROM clinical.prescription_items WHERE id = $1`,
            line.prescription_item_id === null ? [] : [line.prescription_item_id],
          );

          for (const locale of body.locales) {
            labels.push({
              dispenseItemId: line.id,
              itemName: line.item_name,
              batchNo: line.batch_no,
              expiryDate: line.expiry_date,
              qty: line.qty_entered,
              patientName,
              locale,
              instructions:
                translationFor(checklist?.translations, locale) ??
                instructions?.instructions_text ??
                'Take as directed by your doctor.',
              warnings: warningsFor(checklist?.items, line.schedule),
            });
          }

          await tx.query(
            `UPDATE pharmacy.dispense_items SET label_printed_at = now(), updated_at = now(),
                    updated_by = $2 WHERE id = $1`,
            [line.id, ctx.userId],
          );
        }

        await this.audit.write(tx, {
          action: 'print',
          entity: 'pharmacy.dispense_items',
          rowId: id,
          businessKey: header.dispense_no,
          dataClass: 'phi',
          patientId: header.patient_id,
          before: null,
          after: { labels: labels.length, locales: body.locales },
        });

        return { labels };
      }),
    );
  }

  // ── reads ────────────────────────────────────────────────────────────────

  async get(id: string): Promise<DispenseView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const header = await tx.maybeOne<DispenseHeaderRow>(DISPENSE_SQL, [id]);
      if (header === undefined) throw AppError.notFound('The dispense');
      const lines = await this.lineRows(tx, id);
      return toDispenseView(header, lines);
    });
  }

  async list(query: DispenseQuery): Promise<Page<DispenseView>> {
    const hospital = hospitalId();
    const resource = 'pharmacy.dispenses';
    const limit = this.cursors.pageSize(query.limit);
    const after = this.cursors.start(query.cursor, { hospitalId: hospital, resource });

    const ids = await this.db.withTenant(currentTenantContext(), async (tx) => {
      const values: unknown[] = [];
      const bind = binder(values);
      const clauses: string[] = [];
      if (query.patientId !== undefined) clauses.push(`d.patient_id = ${bind(query.patientId)}::uuid`);
      if (query.pharmacyStoreId !== undefined) {
        clauses.push(`d.pharmacy_store_id = ${bind(query.pharmacyStoreId)}::uuid`);
      }
      if (query.prescriptionId !== undefined) {
        clauses.push(`d.prescription_id = ${bind(query.prescriptionId)}::uuid`);
      }
      if (query.status !== undefined) clauses.push(`d.status::text = ${bind(query.status)}`);
      if (query.from !== undefined) clauses.push(`d.created_at >= ${bind(query.from)}::timestamptz`);
      if (after !== null) {
        clauses.push(`(d.created_at, d.id) < (${bind(after.k[0])}::timestamptz, ${bind(after.id)}::uuid)`);
      }
      const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;
      return tx.rows<{ id: string; cursor_key: string }>(
        `SELECT d.id, d.created_at::text AS cursor_key FROM pharmacy.dispenses d
         ${where} ORDER BY d.created_at DESC, d.id DESC LIMIT ${bind(limit + 1)}`,
        values,
      );
    });

    const page = this.cursors.keysetPage<{ id: string }>(ids, limit, {
      hospitalId: hospital,
      resource,
      direction: 'desc',
    });
    const items: DispenseView[] = [];
    for (const row of page.items) items.push(await this.get(row.id));
    return { items, nextCursor: page.nextCursor, hasMore: page.hasMore };
  }

  async substitution(id: string): Promise<SubstitutionView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const row = await tx.maybeOne<{
        id: string;
        dispense_id: string | null;
        prescription_item_id: string | null;
        patient_id: string | null;
        from_item_id: string;
        to_item_id: string;
        reason: string;
        status: string;
        requested_by: string;
        prescriber_user_id: string | null;
        decided_by: string | null;
        decided_at: string | null;
        decision_note: string | null;
        expires_at: string | null;
      }>(
        `SELECT id, dispense_id, prescription_item_id, patient_id, from_item_id, to_item_id, reason,
                status::text AS status, requested_by, prescriber_user_id, decided_by,
                decided_at::text AS decided_at, decision_note, expires_at::text AS expires_at
           FROM pharmacy.substitution_requests WHERE id = $1`,
        [id],
      );
      if (row === undefined) throw AppError.notFound('The substitution request');
      return {
        id: row.id,
        dispenseId: row.dispense_id,
        prescriptionItemId: row.prescription_item_id,
        patientId: row.patient_id,
        fromItemId: row.from_item_id,
        toItemId: row.to_item_id,
        reason: row.reason,
        status: row.status,
        requestedBy: row.requested_by,
        prescriberUserId: row.prescriber_user_id,
        decidedBy: row.decided_by,
        decidedAt: row.decided_at === null ? null : new Date(row.decided_at).toISOString(),
        decisionNote: row.decision_note,
        expiresAt: row.expires_at === null ? null : new Date(row.expires_at).toISOString(),
      };
    });
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** Shared with `PharmacyOpsService` so a register entry has one writer. */
  async writeRegisterEntry(
    tx: TransactionClient,
    entry: {
      readonly registerType: 'ndps' | 'schedule_x' | 'schedule_h1';
      readonly storeId: string;
      readonly branchId: string;
      readonly itemId: string;
      readonly batchId: string | null;
      readonly uomId: string;
      readonly qtyInBase?: string;
      readonly qtyOutBase?: string;
      readonly txnType?: string;
      readonly patientId: string | null;
      readonly patientName: string | null;
      readonly prescriberName: string | null;
      readonly prescriberRegNo: string | null;
      readonly rxRef: string | null;
      readonly refType: string;
      readonly refId: string;
      readonly ledgerId: string | null;
      readonly firstAuthUserId: string;
      readonly secondAuthUserId: string | null;
      readonly remarks: string | null;
    },
  ): Promise<string> {
    const ctx = getContext();
    const id = newId();
    const now = new Date();
    const serial = (
      await this.numbering.allocate(tx, {
        key: 'NARC_REG',
        branchId: entry.branchId,
        refType: 'pharmacy.controlled_drug_register',
        refId: id,
      })
    ).formatted;

    await tx.query(
      `INSERT INTO pharmacy.controlled_drug_register
         (id, hospital_id, branch_id, store_id, register_type, serial_no, fy, item_id, batch_id,
          txn_type, uom_id, qty_in_base, qty_out_base, balance_after_base, patient_id, patient_name,
          prescriber_name, prescriber_reg_no, rx_ref, first_auth_user_id, second_auth_user_id,
          ref_type, ref_id, ledger_id, remarks, entered_at, created_by)
       VALUES ($1, $2, $3, $4, $5::pharmacy."PhRegisterType", $6, $7, $8, $9,
               $10::pharmacy."PhRegisterTxnType", $11, $12::numeric, $13::numeric, 0, $14, $15,
               $16, $17, $18, $19, $20,
               $21, $22, $23, $24, now(), $25)`,
      [
        id,
        ctx.hospitalId,
        entry.branchId,
        entry.storeId,
        entry.registerType,
        serial,
        financialYear(now),
        entry.itemId,
        entry.batchId,
        entry.txnType ?? 'dispense',
        entry.uomId,
        entry.qtyInBase ?? '0',
        entry.qtyOutBase ?? '0',
        entry.patientId,
        entry.patientName,
        entry.prescriberName,
        entry.prescriberRegNo,
        entry.rxRef,
        entry.firstAuthUserId,
        entry.secondAuthUserId,
        entry.refType,
        entry.refId,
        entry.ledgerId,
        entry.remarks,
        ctx.userId,
      ],
    );

    const stored = await tx.one<{
      balance_after_base: string;
      item_code: string;
    }>(
      `SELECT r.balance_after_base::text AS balance_after_base, i.code AS item_code
         FROM pharmacy.controlled_drug_register r
         JOIN inventory.items i ON i.id = r.item_id
        WHERE r.id = $1`,
      [id],
    );

    await this.outbox.publish(
      tx,
      pharmacyEvent('pharmacy.narcotic.transaction', id, {
        entryId: id,
        registerType: entry.registerType,
        serialNo: serial,
        storeId: entry.storeId,
        itemId: entry.itemId,
        itemCode: stored.item_code,
        batchId: entry.batchId,
        txnType: entry.txnType ?? 'dispense',
        qtyInBase: quantityString(Number(entry.qtyInBase ?? '0')),
        qtyOutBase: quantityString(Number(entry.qtyOutBase ?? '0')),
        balanceAfterBase: quantityString(Number(stored.balance_after_base)),
        patientId: entry.patientId,
        prescriberRegNo: entry.prescriberRegNo,
        firstAuthUserId: entry.firstAuthUserId,
        secondAuthUserId: entry.secondAuthUserId,
        enteredAt: now.toISOString(),
      }),
    );

    return id;
  }

  /**
   * The EN-029 evaluation, run against the dispense's lines.
   *
   * The lines are turned into prescription-shaped requests keyed on the item's
   * `drug_key`, so the same rule set that fired for the prescriber fires for the
   * pharmacist. A line whose item has no drug key — a consumable, a device — is
   * not a medication and contributes nothing to the evaluation, which is
   * correct: an interaction between a syringe and a cephalosporin is not a
   * thing.
   */
  private async evaluate(
    tx: TransactionClient,
    header: DispenseHeaderRow,
  ): Promise<{ readonly blocking: readonly { subjectCode: string; title: string }[] }> {
    if (header.patient_id === null) {
      // A walk-in with no registered patient has no allergy list to check
      // against. The schedule guard is what stands here, and it is enforced by
      // `pharmacy.enforce_dispense_line` — a Schedule H drug cannot leave on an
      // OTC sale at all.
      return { blocking: [] };
    }

    const lines = await this.lineRows(tx, header.id);
    const medication = lines.filter((l) => l.drug_key !== null && Number(l.qty_base) > 0);
    if (medication.length === 0) return { blocking: [] };

    const patient = await this.cdss.loadPatientFacts(
      tx,
      header.patient_id,
      header.encounter_id,
      header.prescription_id,
    );

    const resolved = await this.cdss.resolveLines(
      tx,
      medication.map((l) => ({
        drugKey: l.drug_key ?? undefined,
        genericName: l.generic_name ?? l.item_name,
        doseBasis: 'flat' as const,
        refills: 0,
        isPrn: false,
        doNotSubstitute: false,
        externalOnly: false,
        overrides: [],
      })),
      patient,
    );

    const outcome = await this.cdss.evaluateAndRecord(tx, {
      patient,
      patientId: header.patient_id,
      encounterId: header.encounter_id,
      branchId: header.branch_id,
      lines: resolved,
      trigger: 'verify',
      persisted: false,
    });

    // The alerts are stamped on the lines so the counter screen and the audit
    // trail both show what the pharmacist was looking at.
    for (const [index, line] of medication.entries()) {
      const forLine = outcome.alerts.filter((a) => a.lineNo === index + 1);
      await tx.query(
        `UPDATE pharmacy.dispense_items SET cdss_alerts = $2::jsonb, updated_at = now() WHERE id = $1`,
        [
          line.id,
          JSON.stringify(
            forLine.map((a) => ({
              key: a.subjectCode,
              family: a.family,
              severity: a.severity,
              interruption: a.interruption,
              title: a.title,
              detail: a.detail,
            })),
          ),
        ],
      );
    }

    return {
      blocking: outcome.blocking
        .filter((a) => COUNTER_BLOCKING_FAMILIES.has(a.family))
        .map((a) => ({ subjectCode: a.subjectCode, title: a.title })),
    };
  }

  /**
   * The batch gate. Nothing reaches the ledger that has not been through here.
   *
   * FEFO is applied when the caller names no batch, and naming a later-expiring
   * batch than FEFO would choose is an override that needs a reason — the same
   * rule `pick_list_lines_override_documented` applies in the store, so the two
   * paths cannot disagree about what an override is.
   */
  private async validateBatch(
    tx: TransactionClient,
    storeId: string,
    item: ItemFacts,
    batchId: string | null,
    body: AddDispenseItemRequest,
  ): Promise<{
    readonly batchId: string | null;
    readonly batchNo: string | null;
    readonly available: string;
    readonly fefoOverride: boolean;
  }> {
    const tracked = ['batch', 'batch_expiry', 'udi'].includes(item.tracking);
    const fefo = await this.ledger.fefo(tx, storeId, item.id);
    const first = fefo[0];

    if (!tracked && batchId === null) {
      const balance = await this.ledger.balance(tx, storeId, item.id, null);
      return {
        batchId: null,
        batchNo: null,
        available: balance?.qty_on_hand ?? '0',
        fefoOverride: false,
      };
    }

    if (batchId === null) {
      if (first === undefined) {
        throw new AppError(
          ProblemType.BUSINESS_RULE_VIOLATED,
          `There is no issuable batch of ${item.code} at this counter — every batch is empty, expired or quarantined.`,
          { nextAction: 'Report the stockout, or offer a substitution.' },
        );
      }
      return {
        batchId: first.batch_id,
        batchNo: null,
        available: first.qty_available,
        fefoOverride: false,
      };
    }

    // Named explicitly: it must still be one FEFO would allow. `fefo_batches`
    // applies exactly the exclusions the ledger enforces, so a batch missing
    // from this list is one the ledger would refuse — and refusing it here says
    // *why*.
    const chosen = fefo.find((b) => b.batch_id === batchId);
    if (chosen === undefined) {
      const batch = await tx.maybeOne<{ batch_no: string; status: string; expiry_date: string | null }>(
        `SELECT batch_no, status::text AS status, expiry_date::text AS expiry_date
           FROM inventory.item_batches WHERE id = $1`,
        [batchId],
      );
      if (batch === undefined) throw AppError.notFound('The batch');
      const expired = batch.expiry_date !== null && new Date(batch.expiry_date) <= new Date();
      throw new AppError(
        ProblemType.CLINICAL_HARD_STOP,
        expired
          ? `Batch ${batch.batch_no} of ${item.code} expired on ${batch.expiry_date} and cannot be dispensed.`
          : `Batch ${batch.batch_no} of ${item.code} is "${batch.status}" or has nothing left at this counter, so it cannot be dispensed.`,
        { nextAction: 'Scan a different pack.' },
      );
    }

    const override = first !== undefined && first.batch_id !== batchId;
    if (override && body.fefoOverrideReason === undefined) {
      throw new AppError(
        ProblemType.VALIDATION_FAILED,
        `Another batch of ${item.code} expires sooner than the one scanned. Taking the later batch needs a reason — it is how the older one reaches its expiry date on the shelf.`,
        { nextAction: 'Scan the first-expiring pack, or record why this one is being used.' },
      );
    }

    const batch = await tx.maybeOne<{ batch_no: string }>(
      `SELECT batch_no FROM inventory.item_batches WHERE id = $1`,
      [batchId],
    );

    return {
      batchId,
      batchNo: batch?.batch_no ?? null,
      available: chosen.qty_available,
      fefoOverride: override,
    };
  }

  /** `phase-04` exit gate 3, second half: a Schedule H drug cannot leave OTC. */
  private assertDispensable(item: ItemFacts, dispenseType: string): void {
    if (item.status === 'blocked' || item.status === 'inactive') {
      throw new AppError(
        ProblemType.BUSINESS_RULE_VIOLATED,
        `${item.code} is "${item.status}" in the item master and cannot be dispensed.`,
      );
    }
    if (dispenseType === 'otc' && PRESCRIPTION_ONLY.has(item.schedule)) {
      throw new AppError(
        ProblemType.STATUTORY_LIMIT,
        `${item.name} is a Schedule ${item.schedule.toUpperCase()} drug and cannot be sold over the counter. Rule 65(9)(a) of the Drugs and Cosmetics Rules 1945 permits retail sale only against a registered practitioner’s prescription.`,
        { nextAction: 'Record the prescription on the dispense and dispense against it.' },
      );
    }
  }

  private async approvedSubstitution(
    tx: TransactionClient,
    requestId: string,
    toItemId: string,
  ): Promise<{ readonly fromItemId: string } | null> {
    const row = await tx.maybeOne<{ status: string; from_item_id: string; to_item_id: string }>(
      `SELECT status::text AS status, from_item_id, to_item_id
         FROM pharmacy.substitution_requests WHERE id = $1`,
      [requestId],
    );
    if (row === undefined) throw AppError.notFound('The substitution request');
    if (row.to_item_id !== toItemId) {
      throw new AppError(
        ProblemType.VALIDATION_FAILED,
        'The item being dispensed is not the one the substitution request names.',
      );
    }
    if (row.status !== 'approved' && row.status !== 'not_required') {
      throw new AppError(
        ProblemType.APPROVAL_REQUIRED,
        `The prescriber has not approved this substitution — it is "${row.status}". Dispensing a different drug without that approval is a prescribing decision made at a counter.`,
        { nextAction: 'Wait for the prescriber’s answer, or dispense the prescribed item.' },
      );
    }
    return { fromItemId: row.from_item_id };
  }

  private async counter(
    tx: TransactionClient,
    pharmacyStoreId: string,
  ): Promise<{ readonly store_id: string; readonly code: string }> {
    const row = await tx.maybeOne<{ store_id: string; code: string; active: boolean }>(
      `SELECT store_id, code, active FROM pharmacy.pharmacy_stores WHERE id = $1`,
      [pharmacyStoreId],
    );
    if (row === undefined) throw AppError.notFound('The pharmacy counter');
    if (!row.active) {
      throw new AppError(ProblemType.BUSINESS_RULE_VIOLATED, `Counter ${row.code} is not active.`);
    }
    return row;
  }

  private async priceOf(
    tx: TransactionClient,
    item: ItemFacts,
    batchId: string | null,
  ): Promise<{ readonly sellingPrice: number; readonly mrp: number | null; readonly gstRate: number }> {
    const price = await tx.maybeOne<{ unit_price: string }>(
      `SELECT unit_price::text AS unit_price FROM inventory.item_prices
        WHERE item_id = $1 AND price_kind = 'sale'
          AND effective_from <= current_date
          AND (effective_to IS NULL OR effective_to >= current_date)
        ORDER BY effective_from DESC LIMIT 1`,
      [item.id],
    );
    const batch =
      batchId === null
        ? undefined
        : await tx.maybeOne<{ mrp: string | null }>(
            `SELECT mrp::text AS mrp FROM inventory.item_batches WHERE id = $1`,
            [batchId],
          );
    const gst = await tx.maybeOne<{ rate: string }>(
      `SELECT (g.cgst_rate + g.sgst_rate)::text AS rate
         FROM mdm.mdm_gst_rates g
         JOIN mdm.mdm_hsn_codes h ON h.id = g.hsn_code_id
        WHERE h.code = $1 AND g.effective_from <= current_date
          AND (g.effective_to IS NULL OR g.effective_to >= current_date)
        ORDER BY g.effective_from DESC LIMIT 1`,
      [item.hsn_code],
    );

    const mrp = batch?.mrp === undefined || batch.mrp === null ? null : Number(batch.mrp);
    return {
      // The dated selling price wins; the pack's printed MRP is the fallback,
      // because a drug with no price row must not silently dispense at zero and
      // an MRP is a ceiling somebody has already agreed to.
      sellingPrice: price === undefined ? (mrp ?? 0) : Number(price.unit_price),
      mrp,
      gstRate: gst === undefined ? 0 : Number(gst.rate),
    };
  }

  private async nextLineNo(tx: TransactionClient, dispenseId: string): Promise<number> {
    const row = await tx.one<{ n: string }>(
      `SELECT COALESCE(max(line_no), 0)::text AS n FROM pharmacy.dispense_items WHERE dispense_id = $1`,
      [dispenseId],
    );
    return Number(row.n) + 1;
  }

  private async retotal(
    tx: TransactionClient,
    id: string,
  ): Promise<{ readonly total: string; readonly subtotal: string }> {
    const totals = await tx.one<{ subtotal: string; discount: string; tax: string; total: string }>(
      `SELECT COALESCE(sum(selling_price * qty_entered), 0)::text AS subtotal,
              COALESCE(sum(discount), 0)::text AS discount,
              COALESCE(sum(tax_amount), 0)::text AS tax,
              COALESCE(sum(line_total), 0)::text AS total
         FROM pharmacy.dispense_items
        WHERE dispense_id = $1 AND status NOT IN ('declined', 'backordered', 'external', 'cancelled')`,
      [id],
    );
    await tx.query(
      `UPDATE pharmacy.dispenses
          SET subtotal = $2::numeric, discount = $3::numeric, tax_amount = $4::numeric,
              total_amount = $5::numeric, updated_at = now()
        WHERE id = $1`,
      [id, totals.subtotal, totals.discount, totals.tax, totals.total],
    );
    return { total: totals.total, subtotal: totals.subtotal };
  }

  private async lock(tx: TransactionClient, id: string): Promise<DispenseHeaderRow> {
    const row = await tx.maybeOne<DispenseHeaderRow>(`${DISPENSE_SQL} FOR UPDATE`, [id]);
    if (row === undefined) throw AppError.notFound('The dispense');
    return row;
  }

  private async lineRows(tx: TransactionClient, id: string): Promise<readonly DispenseLineRow[]> {
    return tx.rows<DispenseLineRow>(
      `SELECT di.id, di.line_no, di.item_id, i.code AS item_code, i.name AS item_name,
              i.schedule::text AS schedule, i.is_narcotic, i.drug_key, i.generic_name,
              di.batch_id, b.batch_no, b.expiry_date::text AS expiry_date, b.unit_cost::text AS unit_cost,
              di.uom_id, di.qty_ordered_base::text AS qty_ordered_base,
              di.qty_entered::text AS qty_entered, di.qty_base::text AS qty_base,
              di.qty_returned_base::text AS qty_returned_base, di.status::text AS status,
              di.partial_reason, di.substituted_from_item_id, di.prescription_item_id,
              di.mrp::text AS mrp, di.selling_price::text AS selling_price,
              di.discount::text AS discount, di.gst_rate::text AS gst_rate,
              di.tax_amount::text AS tax_amount, di.line_total::text AS line_total,
              di.scanned, di.fefo_override, di.ledger_id, di.cdss_alerts, di.cdss_override_reason
         FROM pharmacy.dispense_items di
         JOIN inventory.items i ON i.id = di.item_id
         LEFT JOIN inventory.item_batches b ON b.id = di.batch_id
        WHERE di.dispense_id = $1
        ORDER BY di.line_no`,
      [id],
    );
  }
}

const DISPENSE_SQL = `SELECT d.id, d.dispense_no, d.dispense_type::text AS dispense_type,
        d.status::text AS status, d.pharmacy_store_id, d.store_id, d.branch_id, d.prescription_id,
        d.rx_queue_id, d.patient_id, d.encounter_id, d.walk_in_name, d.prescriber_name,
        d.prescriber_reg_no, d.pharmacist_user_id, d.second_auth_user_id, d.payer_type,
        d.subtotal::text AS subtotal, d.discount::text AS discount, d.tax_amount::text AS tax_amount,
        d.total_amount::text AS total_amount, d.currency, d.dispensed_at::text AS dispensed_at
   FROM pharmacy.dispenses d WHERE d.id = $1`;

interface DispenseHeaderRow {
  readonly id: string;
  readonly dispense_no: string;
  readonly dispense_type: string;
  readonly status: string;
  readonly pharmacy_store_id: string;
  readonly store_id: string;
  readonly branch_id: string;
  readonly prescription_id: string | null;
  readonly rx_queue_id: string | null;
  readonly patient_id: string | null;
  readonly encounter_id: string | null;
  readonly walk_in_name: string | null;
  readonly prescriber_name: string | null;
  readonly prescriber_reg_no: string | null;
  readonly pharmacist_user_id: string;
  readonly second_auth_user_id: string | null;
  readonly payer_type: string | null;
  readonly subtotal: string;
  readonly discount: string;
  readonly tax_amount: string;
  readonly total_amount: string;
  readonly currency: string;
  readonly dispensed_at: string | null;
}

interface DispenseLineRow {
  readonly id: string;
  readonly line_no: number;
  readonly item_id: string;
  readonly item_code: string;
  readonly item_name: string;
  readonly schedule: string;
  readonly is_narcotic: boolean;
  readonly drug_key: string | null;
  readonly generic_name: string | null;
  readonly batch_id: string | null;
  readonly batch_no: string | null;
  readonly expiry_date: string | null;
  readonly unit_cost: string | null;
  readonly uom_id: string;
  readonly qty_ordered_base: string;
  readonly qty_entered: string;
  readonly qty_base: string;
  readonly qty_returned_base: string;
  readonly status: string;
  readonly partial_reason: string | null;
  readonly substituted_from_item_id: string | null;
  readonly prescription_item_id: string | null;
  readonly mrp: string | null;
  readonly selling_price: string | null;
  readonly discount: string;
  readonly gst_rate: string;
  readonly tax_amount: string;
  readonly line_total: string;
  readonly scanned: boolean;
  readonly fefo_override: boolean;
  readonly ledger_id: string | null;
  readonly cdss_alerts: unknown;
  readonly cdss_override_reason: string | null;
}

function toDispenseView(header: DispenseHeaderRow, lines: readonly DispenseLineRow[]): DispenseView {
  const items = lines.map<DispenseItemView>((l) => ({
    id: l.id,
    lineNo: l.line_no,
    itemId: l.item_id,
    itemCode: l.item_code,
    itemName: l.item_name,
    schedule: l.schedule,
    batchId: l.batch_id,
    batchNo: l.batch_no,
    expiryDate: l.expiry_date,
    uomId: l.uom_id,
    qtyEntered: l.qty_entered,
    qtyBase: l.qty_base,
    qtyOrderedBase: l.qty_ordered_base,
    qtyReturnedBase: l.qty_returned_base,
    status: l.status,
    partialReason: l.partial_reason,
    substitutedFromItemId: l.substituted_from_item_id,
    mrp: l.mrp,
    sellingPrice: l.selling_price,
    discount: l.discount,
    gstRate: l.gst_rate,
    taxAmount: l.tax_amount,
    lineTotal: l.line_total,
    scanned: l.scanned,
    fefoOverride: l.fefo_override,
    ledgerId: l.ledger_id,
    alerts: alertsOf(l),
  }));

  return {
    id: header.id,
    dispenseNo: header.dispense_no,
    dispenseType: header.dispense_type,
    status: header.status,
    pharmacyStoreId: header.pharmacy_store_id,
    storeId: header.store_id,
    prescriptionId: header.prescription_id,
    rxQueueId: header.rx_queue_id,
    patientId: header.patient_id,
    walkInName: header.walk_in_name,
    encounterId: header.encounter_id,
    prescriberName: header.prescriber_name,
    prescriberRegNo: header.prescriber_reg_no,
    pharmacistUserId: header.pharmacist_user_id,
    secondAuthUserId: header.second_auth_user_id,
    payerType: header.payer_type,
    subtotal: header.subtotal,
    discount: header.discount,
    taxAmount: header.tax_amount,
    totalAmount: header.total_amount,
    currency: header.currency,
    dispensedAt: header.dispensed_at === null ? null : new Date(header.dispensed_at).toISOString(),
    items,
    blockingAlerts: items.flatMap((i) =>
      i.alerts.filter((a) => a.interruption === 'hard_stop' && !a.acknowledged),
    ),
  };
}

function alertsOf(line: DispenseLineRow): readonly DispenseAlertView[] {
  if (!Array.isArray(line.cdss_alerts)) return [];
  const acknowledged = line.cdss_override_reason !== null;
  const out: DispenseAlertView[] = [];
  for (const entry of line.cdss_alerts) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    out.push({
      key: typeof record.key === 'string' ? record.key : '',
      family: typeof record.family === 'string' ? record.family : '',
      severity: typeof record.severity === 'string' ? record.severity : '',
      interruption: typeof record.interruption === 'string' ? record.interruption : '',
      title: typeof record.title === 'string' ? record.title : '',
      detail: typeof record.detail === 'string' ? record.detail : '',
      acknowledged,
    });
  }
  return out;
}

function translationFor(translations: unknown, locale: string): string | null {
  if (typeof translations !== 'object' || translations === null) return null;
  const value = (translations as Record<string, unknown>)[locale];
  return typeof value === 'string' ? value : null;
}

function warningsFor(items: unknown, schedule: string): readonly string[] {
  const out: string[] = [];
  if (Array.isArray(items)) {
    for (const entry of items) if (typeof entry === 'string') out.push(entry);
  }
  if (schedule === 'h1' || schedule === 'x') {
    out.push(
      'Schedule H1/X drug — to be sold by retail on the prescription of a registered practitioner only.',
    );
  }
  if (schedule === 'ndps_narcotic' || schedule === 'ndps_psychotropic') {
    out.push('Controlled substance. Keep out of reach of children. Do not share.');
  }
  return out;
}
