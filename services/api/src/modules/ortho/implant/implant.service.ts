import { Inject, Injectable } from '@nestjs/common';
import { ProblemType, newId, type Page } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService, type TransactionClient } from '../../../core/db/database.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import { withImplantErrors } from './implant.errors.js';
import { implantEvent } from './implant.events.js';
import type {
  AdjustStockRequest,
  CastApplyRequest,
  CastCheckRequest,
  CastQuery,
  CastRemoveRequest,
  CastRequestBody,
  CatalogueQuery,
  CatalogueRequest,
  ExplantRequest,
  PinCareRequest,
  PinSiteRequest,
  RecallContactRequest,
  RecallRequest,
  ReceiveStockRequest,
  RecordUsageRequest,
  StockQuery,
  TraceQuery,
} from './implant.schemas.js';
import type {
  CastApplicationView,
  CastCheckView,
  CastDetailView,
  CastRequestView,
  CatalogueView,
  PinSiteView,
  RecallCaseView,
  RecallDetailView,
  RecallView,
  StockView,
  TraceResult,
  TraceRow,
  UsageView,
} from './implant.types.js';

function asText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString();
  return '';
}
function asTextOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : asText(v);
}
function asNumber(v: unknown): number {
  return typeof v === 'number' ? v : Number(asText(v));
}
function asNumberOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : asNumber(v);
}
function asBool(v: unknown): boolean {
  return v === true || v === 't' || v === 'true';
}
function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map(asText) : [];
}
function json(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

/**
 * TR-003 + TR-005 — implant traceability, and plaster.
 *
 * ── The module exists for one query ─────────────────────────────────────────
 *
 * `trace()` answers: given a UDI or a lot number, exactly which patients are
 * carrying that device. Every other method in this file exists to make that
 * query's answer complete. Booking in a device without a serial or a lot is
 * refused, recording one without a scan needs stated grounds, and a device that
 * has been used cannot go back on the shelf — each of those is a way the trace
 * comes back short, and a hip-stem recall with a short list is people still
 * walking on a withdrawn device.
 *
 * ── The rules are the database's, and are not repeated here ─────────────────
 *
 * Laterality, the red flag, the permanence of an implant record and the
 * "everybody accounted for" gate on closing a recall are all triggers and
 * CHECKs. This service arranges the transaction and explains the refusal; it
 * does not decide. Two implementations of the same clinical rule is how they
 * come to disagree.
 */
@Injectable()
export class ImplantService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private hospitalId(): string {
    const id = getContext().hospitalId;
    if (id === null) throw AppError.unauthenticated();
    return id;
  }
  private branchId(): string {
    const id = getContext().branchId;
    if (id === null || id === undefined) {
      throw AppError.conflict('This action needs a branch. Choose one and try again.');
    }
    return id;
  }
  private actorId(): string {
    const id = getContext().userId;
    if (id === null) throw AppError.unauthenticated();
    return id;
  }
  private reason(what: string): string {
    const value = getContext().reason;
    if (value === null || value.trim().length < 12) {
      throw new AppError(
        ProblemType.VALIDATION_FAILED,
        `${what} needs grounds of at least twelve characters, sent in the \`x-reason\` header.`,
      );
    }
    return value.trim();
  }
  private guard<T>(fn: (tx: TransactionClient) => Promise<T>): Promise<T> {
    return withImplantErrors(() => this.db.withTenant(currentTenantContext(), fn));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The catalogue
  // ═══════════════════════════════════════════════════════════════════════════

  private toCatalogue(r: Record<string, unknown>): CatalogueView {
    return {
      id: asText(r['id']),
      udiDi: asTextOrNull(r['udi_di']),
      gtin: asTextOrNull(r['gtin']),
      catalogueNo: asTextOrNull(r['catalogue_no']),
      manufacturer: asText(r['manufacturer']),
      brand: asTextOrNull(r['brand']),
      kind: asText(r['kind']),
      description: asText(r['description']),
      sizeLabel: asTextOrNull(r['size_label']),
      laterality: asText(r['laterality']),
      material: asTextOrNull(r['material']),
      mriConditionality: asText(r['mri_conditionality']),
      mriConditions: r['mri_conditions'] ?? null,
      shelfLifeMonths: asNumberOrNull(r['shelf_life_months']),
      ownership: asText(r['ownership']),
      consignmentPrice: asNumberOrNull(r['consignment_price']),
      isActive: asBool(r['is_active']),
      available: asNumber(r['available'] ?? 0),
    };
  }

  async searchCatalogue(query: CatalogueQuery): Promise<Page<CatalogueView>> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT c.*,
                (SELECT count(*) FROM clinical.implant_stock s
                  WHERE s.catalogue_id = c.id AND s.status = 'available') AS available
           FROM clinical.implant_catalogue c
          WHERE c.hospital_id = $1
            AND ($2::text IS NULL OR c.kind::text = $2)
            AND ($3::text IS NULL OR c.description ILIKE '%' || $3 || '%'
                                  OR c.manufacturer ILIKE '%' || $3 || '%'
                                  OR c.brand ILIKE '%' || $3 || '%'
                                  OR c.catalogue_no ILIKE '%' || $3 || '%'
                                  OR c.udi_di = $3)
          ORDER BY c.manufacturer, c.description
          LIMIT $4`,
        [this.hospitalId(), query.kind ?? null, query.q ?? null, query.limit],
      );
      return { items: rows.map((r) => this.toCatalogue(r)), nextCursor: null, hasMore: false };
    });
  }

  async upsertCatalogue(body: CatalogueRequest): Promise<CatalogueView> {
    return this.guard(async (tx) => {
      const id = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO clinical.implant_catalogue (
           id, hospital_id, udi_di, gtin, catalogue_no, manufacturer, brand, kind, description,
           size_label, laterality, material, mri_conditionality, mri_conditions, shelf_life_months,
           ownership, vendor_id, consignment_price, is_active, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8::clinical."ImplantKind", $9,
           $10, $11, $12, $13::clinical."MriConditionality", $14::jsonb, $15,
           $16::clinical."ImplantOwnership", $17, $18, true, now(), now()
         )
         ON CONFLICT (hospital_id, udi_di) WHERE udi_di IS NOT NULL DO UPDATE SET
           description = EXCLUDED.description,
           brand = EXCLUDED.brand,
           size_label = EXCLUDED.size_label,
           material = EXCLUDED.material,
           mri_conditionality = EXCLUDED.mri_conditionality,
           mri_conditions = EXCLUDED.mri_conditions,
           shelf_life_months = EXCLUDED.shelf_life_months,
           ownership = EXCLUDED.ownership,
           vendor_id = EXCLUDED.vendor_id,
           consignment_price = EXCLUDED.consignment_price,
           updated_at = now()
         RETURNING *, 0::bigint AS available`,
        [
          id,
          this.hospitalId(),
          body.udiDi ?? null,
          body.gtin ?? null,
          body.catalogueNo ?? null,
          body.manufacturer,
          body.brand ?? null,
          body.kind,
          body.description,
          body.sizeLabel ?? null,
          body.laterality,
          body.material ?? null,
          body.mriConditionality,
          json(body.mriConditions),
          body.shelfLifeMonths ?? null,
          body.ownership,
          body.vendorId ?? null,
          body.consignmentPrice ?? null,
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The catalogue entry was not written.');

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'implant_catalogue',
        rowId: asText(row['id']),
        businessKey: body.udiDi ?? body.catalogueNo ?? body.description,
        dataClass: 'operational',
        before: null,
        after: { manufacturer: body.manufacturer, description: body.description, kind: body.kind },
      });

      return this.toCatalogue(row);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The shelf
  // ═══════════════════════════════════════════════════════════════════════════

  private toStock(r: Record<string, unknown>): StockView {
    return {
      id: asText(r['id']),
      catalogueId: asText(r['catalogue_id']),
      description: asText(r['description']),
      manufacturer: asText(r['manufacturer']),
      udiDi: asTextOrNull(r['udi_di']),
      serialNo: asTextOrNull(r['serial_no']),
      lotNo: asTextOrNull(r['lot_no']),
      udiPi: asTextOrNull(r['udi_pi']),
      expiryOn: asTextOrNull(r['expiry_on']),
      status: asText(r['status']),
      location: asTextOrNull(r['location']),
      grnRef: asTextOrNull(r['grn_ref']),
      receivedAt: asTextOrNull(r['received_at']),
      daysToExpiry: asNumberOrNull(r['days_to_expiry']),
    };
  }

  async listStock(query: StockQuery): Promise<Page<StockView>> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT s.*, c.description, c.manufacturer, c.udi_di,
                (s.expiry_on - CURRENT_DATE) AS days_to_expiry
           FROM clinical.implant_stock s
           JOIN clinical.implant_catalogue c ON c.id = s.catalogue_id
          WHERE s.hospital_id = $1 AND s.branch_id = $2
            AND ($3::uuid IS NULL OR s.catalogue_id = $3)
            AND ($4::text IS NULL OR s.status::text = $4)
            AND ($5::text IS NULL OR s.lot_no = $5)
            AND ($6::int IS NULL OR (s.expiry_on IS NOT NULL AND s.expiry_on <= CURRENT_DATE + $6))
          ORDER BY s.expiry_on NULLS LAST, c.description
          LIMIT $7`,
        [
          this.hospitalId(),
          this.branchId(),
          query.catalogueId ?? null,
          query.status ?? null,
          query.lotNo ?? null,
          query.expiringWithinDays ?? null,
          query.limit,
        ],
      );
      return { items: rows.map((r) => this.toStock(r)), nextCursor: null, hasMore: false };
    });
  }

  async receiveStock(body: ReceiveStockRequest): Promise<readonly StockView[]> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();
      const branch = this.branchId();
      const ids = Array.from({ length: body.quantity }, () => newId());

      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO clinical.implant_stock (
           id, hospital_id, branch_id, catalogue_id, serial_no, lot_no, udi_pi,
           expiry_on, status, location, received_at, grn_ref, created_at, updated_at
         )
         SELECT unnest($1::uuid[]), $2, $3, $4, $5, $6, $7, $8::date, 'available', $9, now(), $10, now(), now()
         RETURNING *`,
        [
          ids,
          hospital,
          branch,
          body.catalogueId,
          body.serialNo ?? null,
          body.lotNo ?? null,
          body.udiPi ?? null,
          body.expiryOn ?? null,
          body.location ?? null,
          body.grnRef ?? null,
        ],
      );

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'implant_stock',
        rowId: ids[0] ?? body.catalogueId,
        businessKey: body.serialNo ?? body.lotNo ?? body.catalogueId,
        dataClass: 'operational',
        before: null,
        after: { quantity: body.quantity, lotNo: body.lotNo ?? null, grnRef: body.grnRef ?? null },
      });

      const { rows: enriched } = await tx.query<Record<string, unknown>>(
        `SELECT s.*, c.description, c.manufacturer, c.udi_di, (s.expiry_on - CURRENT_DATE) AS days_to_expiry
           FROM clinical.implant_stock s JOIN clinical.implant_catalogue c ON c.id = s.catalogue_id
          WHERE s.id = ANY($1::uuid[]) ORDER BY s.serial_no NULLS LAST`,
        [rows.map((r) => asText(r['id']))],
      );
      return enriched.map((r) => this.toStock(r));
    });
  }

  async adjustStock(id: string, body: AdjustStockRequest): Promise<StockView> {
    return this.guard(async (tx) => {
      const { rows: before } = await tx.query<Record<string, unknown>>(
        `SELECT status, location FROM clinical.implant_stock WHERE id = $1 AND hospital_id = $2`,
        [id, this.hospitalId()],
      );
      const prior = before[0];
      if (prior === undefined) throw AppError.notFound('That device is not on this hospital’s shelf.');

      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.implant_stock
            SET status = $3::clinical."ImplantStockStatus",
                location = COALESCE($4, location),
                reserved_for_case_id = CASE WHEN $3::text = 'reserved' THEN $5::uuid ELSE NULL END,
                updated_at = now()
          WHERE id = $1 AND hospital_id = $2
          RETURNING *`,
        [id, this.hospitalId(), body.status, body.location ?? null, body.reservedForCaseId ?? null],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The device was not adjusted.');

      await this.audit.write(tx, {
        action: 'update',
        entity: 'implant_stock',
        rowId: id,
        businessKey: asTextOrNull(row['serial_no']) ?? asTextOrNull(row['lot_no']) ?? id,
        dataClass: 'operational',
        before: { status: asText(prior['status']), location: asTextOrNull(prior['location']) },
        after: { status: body.status, location: asTextOrNull(row['location']) },
      });

      const { rows: enriched } = await tx.query<Record<string, unknown>>(
        `SELECT s.*, c.description, c.manufacturer, c.udi_di, (s.expiry_on - CURRENT_DATE) AS days_to_expiry
           FROM clinical.implant_stock s JOIN clinical.implant_catalogue c ON c.id = s.catalogue_id
          WHERE s.id = $1`,
        [id],
      );
      const view = enriched[0];
      if (view === undefined) throw AppError.conflict('The device was not adjusted.');
      return this.toStock(view);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Into the patient
  // ═══════════════════════════════════════════════════════════════════════════

  private toUsage(r: Record<string, unknown>): UsageView {
    return {
      id: asText(r['id']),
      stockItemId: asText(r['stock_item_id']),
      patientId: asText(r['patient_id']),
      fractureId: asTextOrNull(r['fracture_id']),
      procedureName: asText(r['procedure_name']),
      side: asTextOrNull(r['side']),
      surgeonId: asText(r['surgeon_id']),
      implantedAt: asText(r['implanted_at']),
      scanned: asBool(r['scanned']),
      manualReason: asTextOrNull(r['manual_reason']),
      chargedPrice: asNumberOrNull(r['charged_price']),
      explantedAt: asTextOrNull(r['explanted_at']),
      explantReason: asTextOrNull(r['explant_reason']),
      serialNo: asTextOrNull(r['serial_no']),
      lotNo: asTextOrNull(r['lot_no']),
      udiDi: asTextOrNull(r['udi_di']),
      description: asText(r['description']),
      manufacturer: asText(r['manufacturer']),
      kind: asText(r['kind']),
      mriConditionality: asText(r['mri_conditionality']),
      mriConditions: r['mri_conditions'] ?? null,
      recalled: asBool(r['recalled']),
    };
  }

  /**
   * The usage read model, with the MRI conditionality and the recall flag joined on.
   *
   * Both are joined rather than fetched separately because both are asked at a
   * door — the scanner's, and the clinic's — by somebody who will not go and
   * look them up in a second screen.
   */
  private usageSelect(where: string): string {
    return `SELECT u.*, s.serial_no, s.lot_no, c.udi_di, c.description, c.manufacturer,
                   c.kind, c.mri_conditionality, c.mri_conditions,
                   EXISTS (
                     SELECT 1 FROM clinical.implant_recalls r
                      WHERE r.hospital_id = u.hospital_id AND r.closed_at IS NULL
                        AND (r.catalogue_id = c.id
                             OR (r.udi_di IS NOT NULL AND r.udi_di = c.udi_di)
                             OR (s.lot_no IS NOT NULL AND s.lot_no = ANY(r.lot_nos)))
                   ) AS recalled
              FROM clinical.implant_usages u
              JOIN clinical.implant_stock s ON s.id = u.stock_item_id
              JOIN clinical.implant_catalogue c ON c.id = s.catalogue_id
             WHERE ${where}`;
  }

  async recordUsage(body: RecordUsageRequest): Promise<UsageView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();
      const id = newId();

      // The manual reason comes from the body rather than `x-reason`: it is part
      // of the clinical record of that device in that patient, not a
      // justification for an HTTP call, and it has to be readable years later
      // beside the row it explains.
      const manualReason = body.scanned ? null : (body.manualReason ?? null);

      await tx.query(
        `INSERT INTO clinical.implant_usages (
           id, hospital_id, branch_id, stock_item_id, patient_id, fracture_id, ot_case_id, admission_id,
           procedure_code, procedure_name, side, surgeon_id, implanted_at,
           scanned, scan_payload, manual_reason, manual_by, charged_price, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8,
           $9, $10, $11, $12, COALESCE($13::timestamptz, now()),
           $14, $15, $16, $17, $18, now(), now()
         )`,
        [
          id,
          hospital,
          this.branchId(),
          body.stockItemId,
          body.patientId,
          body.fractureId ?? null,
          body.otCaseId ?? null,
          body.admissionId ?? null,
          body.procedureCode ?? null,
          body.procedureName,
          body.side,
          body.surgeonId,
          body.implantedAt ?? null,
          body.scanned,
          body.scanned ? (body.scanPayload ?? null) : null,
          manualReason,
          body.scanned ? null : this.actorId(),
          body.chargedPrice ?? null,
        ],
      );

      const { rows } = await tx.query<Record<string, unknown>>(this.usageSelect('u.id = $1'), [id]);
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The device was not recorded.');

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'implant_usage',
        rowId: id,
        businessKey: asTextOrNull(row['serial_no']) ?? asTextOrNull(row['lot_no']) ?? id,
        dataClass: 'phi',
        before: null,
        after: {
          patientId: body.patientId,
          scanned: body.scanned,
          manualReason,
          udiDi: asTextOrNull(row['udi_di']),
        },
      });

      await this.outbox.publish(
        tx,
        implantEvent('implant.recorded', id, {
          usageId: id,
          patientId: body.patientId,
          stockItemId: body.stockItemId,
          udiDi: asTextOrNull(row['udi_di']),
          serialNo: asTextOrNull(row['serial_no']),
          lotNo: asTextOrNull(row['lot_no']),
          side: body.side,
          scanned: body.scanned,
          mriConditionality: asText(row['mri_conditionality']),
        }),
      );

      // A second event, not a flag on the first. The unscanned population is the
      // one a recall will struggle to match, and it should be countable without
      // anybody having to parse a boolean out of a payload.
      if (!body.scanned && manualReason !== null) {
        await this.outbox.publish(
          tx,
          implantEvent('implant.recorded.unscanned', id, {
            usageId: id,
            patientId: body.patientId,
            reason: manualReason,
            enteredBy: this.actorId(),
          }),
        );
      }

      return this.toUsage(row);
    });
  }

  async listUsagesForPatient(patientId: string): Promise<Page<UsageView>> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `${this.usageSelect('u.hospital_id = $1 AND u.patient_id = $2')} ORDER BY u.implanted_at DESC`,
        [this.hospitalId(), patientId],
      );
      return { items: rows.map((r) => this.toUsage(r)), nextCursor: null, hasMore: false };
    });
  }

  async explant(id: string, body: ExplantRequest): Promise<UsageView> {
    return this.guard(async (tx) => {
      const { rows: updated } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.implant_usages
            SET explanted_at = COALESCE($3::timestamptz, now()), explant_reason = $4, updated_at = now()
          WHERE id = $1 AND hospital_id = $2 AND explanted_at IS NULL
          RETURNING patient_id, implanted_at, explanted_at`,
        [id, this.hospitalId(), body.explantedAt ?? null, body.reason],
      );
      const changed = updated[0];
      if (changed === undefined) {
        throw AppError.conflict(
          'That device is not recorded as being in this patient, or it is already out.',
        );
      }

      const { rows } = await tx.query<Record<string, unknown>>(this.usageSelect('u.id = $1'), [id]);
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The explant was not recorded.');

      const dwellMs =
        new Date(asText(changed['explanted_at'])).getTime() -
        new Date(asText(changed['implanted_at'])).getTime();

      await this.audit.write(tx, {
        action: 'update',
        entity: 'implant_usage',
        rowId: id,
        businessKey: asTextOrNull(row['serial_no']) ?? id,
        dataClass: 'phi',
        before: { explantedAt: null },
        after: { explantedAt: asText(changed['explanted_at']), reason: body.reason },
      });

      await this.outbox.publish(
        tx,
        implantEvent('implant.explanted', id, {
          usageId: id,
          patientId: asText(changed['patient_id']),
          reason: body.reason,
          dwellDays: Number.isFinite(dwellMs) ? Math.round(dwellMs / 86_400_000) : null,
        }),
      );

      return this.toUsage(row);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The recall — what the whole module is for
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Given a UDI, a lot or a catalogue entry, exactly who is carrying it.
   *
   * `phase-06` calls this the single most important query in the deliverable.
   * Explanted devices are included by default: a patient who had a recalled
   * device taken out last year is still someone the notice concerns, and a list
   * that silently drops them is a list that looks complete and is not.
   */
  async trace(query: TraceQuery): Promise<TraceResult> {
    return this.guard(async (tx) => {
      const reason = this.reason('Running the implant trace');

      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT u.id AS usage_id, u.patient_id, u.surgeon_id, u.implanted_at, u.explanted_at,
                u.side, u.procedure_name, u.scanned,
                s.serial_no, s.lot_no, c.udi_di, c.description, c.manufacturer
           FROM clinical.implant_usages u
           JOIN clinical.implant_stock s ON s.id = u.stock_item_id
           JOIN clinical.implant_catalogue c ON c.id = s.catalogue_id
          WHERE u.hospital_id = $1
            AND ($2::text IS NULL OR c.udi_di = $2)
            AND ($3::text IS NULL OR s.lot_no = $3)
            AND ($4::uuid IS NULL OR c.id = $4)
            AND (NOT $5::boolean OR u.explanted_at IS NULL)
          ORDER BY u.implanted_at DESC`,
        [
          this.hospitalId(),
          query.udiDi ?? null,
          query.lotNo ?? null,
          query.catalogueId ?? null,
          query.inSituOnly,
        ],
      );

      const traced: TraceRow[] = rows.map((r) => ({
        usageId: asText(r['usage_id']),
        patientId: asText(r['patient_id']),
        surgeonId: asText(r['surgeon_id']),
        implantedAt: asText(r['implanted_at']),
        explantedAt: asTextOrNull(r['explanted_at']),
        side: asTextOrNull(r['side']),
        procedureName: asText(r['procedure_name']),
        serialNo: asTextOrNull(r['serial_no']),
        lotNo: asTextOrNull(r['lot_no']),
        udiDi: asTextOrNull(r['udi_di']),
        description: asText(r['description']),
        manufacturer: asText(r['manufacturer']),
        scanned: asBool(r['scanned']),
      }));

      // Audited every time, with the filter and the count. This is a list of
      // patient names produced by a device identifier; who ran it and what they
      // asked for is part of the record.
      await this.audit.write(tx, {
        action: 'export',
        entity: 'implant_usage',
        rowId: query.catalogueId ?? this.hospitalId(),
        businessKey: query.udiDi ?? query.lotNo ?? query.catalogueId ?? 'trace',
        dataClass: 'phi',
        before: null,
        after: {
          udiDi: query.udiDi ?? null,
          lotNo: query.lotNo ?? null,
          catalogueId: query.catalogueId ?? null,
          inSituOnly: query.inSituOnly,
          matched: traced.length,
          reason,
        },
      });

      return {
        rows: traced,
        total: traced.length,
        manualEntries: traced.filter((r) => !r.scanned).length,
        inSitu: traced.filter((r) => r.explantedAt === null).length,
      };
    });
  }

  private toRecall(r: Record<string, unknown>): RecallView {
    return {
      id: asText(r['id']),
      reference: asText(r['reference']),
      catalogueId: asTextOrNull(r['catalogue_id']),
      udiDi: asTextOrNull(r['udi_di']),
      lotNos: asStringArray(r['lot_nos']),
      manufacturer: asText(r['manufacturer']),
      kind: asText(r['kind']),
      severity: asText(r['severity']),
      summary: asText(r['summary']),
      actionRequired: asText(r['action_required']),
      issuedOn: asText(r['issued_on']),
      receivedAt: asTextOrNull(r['received_at']),
      patientsIdentifiedAt: asTextOrNull(r['patients_identified_at']),
      closedAt: asTextOrNull(r['closed_at']),
      patients: asNumber(r['patients'] ?? 0),
      pending: asNumber(r['pending'] ?? 0),
      unreachable: asNumber(r['unreachable'] ?? 0),
    };
  }

  private toRecallCase(r: Record<string, unknown>): RecallCaseView {
    return {
      id: asText(r['id']),
      recallId: asText(r['recall_id']),
      usageId: asText(r['usage_id']),
      patientId: asText(r['patient_id']),
      surgeonId: asTextOrNull(r['surgeon_id']),
      notifiedPatientAt: asTextOrNull(r['notified_patient_at']),
      notifiedSurgeonAt: asTextOrNull(r['notified_surgeon_at']),
      response: asText(r['response']),
      responseAt: asTextOrNull(r['response_at']),
      contactAttempts: asNumber(r['contact_attempts'] ?? 0),
      notes: asTextOrNull(r['notes']),
      serialNo: asTextOrNull(r['serial_no']),
      lotNo: asTextOrNull(r['lot_no']),
      implantedAt: asText(r['implanted_at']),
      explantedAt: asTextOrNull(r['explanted_at']),
    };
  }

  private readonly recallSelect = `
    SELECT r.*,
           (SELECT count(*) FROM clinical.implant_recall_cases k WHERE k.recall_id = r.id) AS patients,
           (SELECT count(*) FROM clinical.implant_recall_cases k WHERE k.recall_id = r.id AND k.response = 'pending') AS pending,
           (SELECT count(*) FROM clinical.implant_recall_cases k WHERE k.recall_id = r.id AND k.response = 'unreachable') AS unreachable
      FROM clinical.implant_recalls r`;

  async listRecalls(): Promise<Page<RecallView>> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `${this.recallSelect} WHERE r.hospital_id = $1 ORDER BY r.closed_at NULLS FIRST, r.issued_on DESC LIMIT 100`,
        [this.hospitalId()],
      );
      return { items: rows.map((r) => this.toRecall(r)), nextCursor: null, hasMore: false };
    });
  }

  /**
   * Open a notice, and identify its patients in the same transaction.
   *
   * The identification is not a later step. A recall row that exists without
   * its patient list is a recall somebody has to remember to run, and the
   * count is stamped on the event at the moment of opening so it cannot be
   * quietly revised downward afterwards.
   */
  async openRecall(body: RecallRequest): Promise<RecallDetailView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();
      const id = newId();

      await tx.query(
        `INSERT INTO clinical.implant_recalls (
           id, hospital_id, reference, catalogue_id, udi_di, lot_nos, manufacturer, kind, severity,
           summary, action_required, issued_on, received_at, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8, $9, $10, $11, $12::date, now(), now(), now())`,
        [
          id,
          hospital,
          body.reference,
          body.catalogueId ?? null,
          body.udiDi ?? null,
          body.lotNos,
          body.manufacturer,
          body.kind,
          body.severity,
          body.summary,
          body.actionRequired,
          body.issuedOn,
        ],
      );

      const { rows: identified } = await tx.query<Record<string, unknown>>(
        `INSERT INTO clinical.implant_recall_cases
           (id, hospital_id, recall_id, usage_id, patient_id, surgeon_id, created_at, updated_at)
         SELECT gen_random_uuid(), $1, $2, u.id, u.patient_id, u.surgeon_id, now(), now()
           FROM clinical.implant_usages u
           JOIN clinical.implant_stock s ON s.id = u.stock_item_id
           JOIN clinical.implant_catalogue c ON c.id = s.catalogue_id
          WHERE u.hospital_id = $1
            AND ($3::uuid IS NULL OR c.id = $3)
            AND ($4::text IS NULL OR c.udi_di = $4)
            AND (cardinality($5::text[]) = 0 OR s.lot_no = ANY($5::text[]))
         RETURNING id`,
        [hospital, id, body.catalogueId ?? null, body.udiDi ?? null, body.lotNos],
      );

      await tx.query(`UPDATE clinical.implant_recalls SET patients_identified_at = now() WHERE id = $1`, [
        id,
      ]);

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'implant_recall',
        rowId: id,
        businessKey: body.reference,
        dataClass: 'phi',
        before: null,
        after: { reference: body.reference, severity: body.severity, patientsIdentified: identified.length },
      });

      await this.outbox.publish(
        tx,
        implantEvent('implant.recall.opened', id, {
          recallId: id,
          reference: body.reference,
          manufacturer: body.manufacturer,
          severity: body.severity,
          lotNos: body.lotNos,
          udiDi: body.udiDi ?? null,
          patientsIdentified: identified.length,
        }),
      );

      return this.loadRecall(tx, id);
    });
  }

  private async loadRecall(tx: TransactionClient, id: string): Promise<RecallDetailView> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `${this.recallSelect} WHERE r.id = $1 AND r.hospital_id = $2`,
      [id, this.hospitalId()],
    );
    const row = rows[0];
    if (row === undefined) throw AppError.notFound('That recall is not on this hospital’s register.');

    const { rows: cases } = await tx.query<Record<string, unknown>>(
      `SELECT k.*, s.serial_no, s.lot_no, u.implanted_at, u.explanted_at
         FROM clinical.implant_recall_cases k
         JOIN clinical.implant_usages u ON u.id = k.usage_id
         JOIN clinical.implant_stock s ON s.id = u.stock_item_id
        WHERE k.recall_id = $1
        ORDER BY k.response = 'pending' DESC, u.implanted_at DESC`,
      [id],
    );

    return { ...this.toRecall(row), cases: cases.map((c) => this.toRecallCase(c)) };
  }

  async getRecall(id: string): Promise<RecallDetailView> {
    return this.guard((tx) => this.loadRecall(tx, id));
  }

  async recordContact(
    recallId: string,
    caseId: string,
    body: RecallContactRequest,
  ): Promise<RecallDetailView> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.implant_recall_cases
            SET response = $3::text,
                response_at = CASE WHEN $3::text = 'pending' THEN NULL ELSE now() END,
                contact_attempts = contact_attempts + 1,
                notified_patient_at = CASE WHEN $4::boolean THEN COALESCE(notified_patient_at, now()) ELSE notified_patient_at END,
                notified_surgeon_at = CASE WHEN $5::boolean THEN COALESCE(notified_surgeon_at, now()) ELSE notified_surgeon_at END,
                notes = COALESCE($6, notes),
                updated_at = now()
          WHERE id = $1 AND recall_id = $2 AND hospital_id = $7
          RETURNING patient_id, contact_attempts`,
        [
          caseId,
          recallId,
          body.response,
          body.notifiedPatient,
          body.notifiedSurgeon,
          body.notes ?? null,
          this.hospitalId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.notFound('That patient is not on this recall.');

      await this.outbox.publish(
        tx,
        implantEvent('implant.recall.patient_contacted', recallId, {
          recallId,
          caseId,
          patientId: asText(row['patient_id']),
          response: body.response,
          attempt: asNumber(row['contact_attempts']),
        }),
      );

      return this.loadRecall(tx, recallId);
    });
  }

  /**
   * Close a notice.
   *
   * The "everybody accounted for" rule is a trigger, and this method does not
   * check it first. Asking twice would mean two answers, and the trigger's is
   * the one that is true at commit time.
   */
  async closeRecall(id: string): Promise<RecallDetailView> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.implant_recalls SET closed_at = now(), updated_at = now()
          WHERE id = $1 AND hospital_id = $2 AND closed_at IS NULL
          RETURNING reference, issued_on`,
        [id, this.hospitalId()],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('That recall is not open on this register.');

      const detail = await this.loadRecall(tx, id);
      const daysOpen = Math.max(
        0,
        Math.round((Date.now() - new Date(asText(row['issued_on'])).getTime()) / 86_400_000),
      );

      await this.audit.write(tx, {
        action: 'update',
        entity: 'implant_recall',
        rowId: id,
        businessKey: asText(row['reference']),
        dataClass: 'phi',
        before: { closedAt: null },
        after: { closedAt: detail.closedAt, patients: detail.patients, unreachable: detail.unreachable },
      });

      await this.outbox.publish(
        tx,
        implantEvent('implant.recall.closed', id, {
          recallId: id,
          reference: asText(row['reference']),
          patients: detail.patients,
          unreachable: detail.unreachable,
          daysOpen,
        }),
      );

      return detail;
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TR-005 — the plaster room
  // ═══════════════════════════════════════════════════════════════════════════

  private toCastRequest(r: Record<string, unknown>): CastRequestView {
    return {
      id: asText(r['id']),
      patientId: asText(r['patient_id']),
      fractureId: asTextOrNull(r['fracture_id']),
      kind: asText(r['kind']),
      side: asText(r['side']),
      bodyRegion: asText(r['body_region']),
      position: asTextOrNull(r['position']),
      material: asTextOrNull(r['material']),
      weightBearing: asTextOrNull(r['weight_bearing']),
      urgency: asText(r['urgency']),
      instructions: asTextOrNull(r['instructions']),
      status: asText(r['status']),
      requestedAt: asText(r['requested_at']),
      requestedBy: asTextOrNull(r['requested_by']),
    };
  }

  private toApplication(r: Record<string, unknown>): CastApplicationView {
    const due = asTextOrNull(r['next_check_due_at']);
    return {
      id: asText(r['id']),
      requestId: asText(r['request_id']),
      patientId: asText(r['patient_id']),
      kind: asText(r['kind']),
      side: asText(r['side']),
      material: asText(r['material']),
      position: asTextOrNull(r['position']),
      padding: asTextOrNull(r['padding']),
      appliedIn: asText(r['applied_in']),
      appliedAt: asTextOrNull(r['applied_at']),
      appliedBy: asTextOrNull(r['applied_by']),
      nextCheckDueAt: due,
      plannedRemovalAt: asTextOrNull(r['planned_removal_at']),
      removedAt: asTextOrNull(r['removed_at']),
      removedBy: asTextOrNull(r['removed_by']),
      removalNotes: asTextOrNull(r['removal_notes']),
      bodyRegion: asText(r['body_region']),
      fractureId: asTextOrNull(r['fracture_id']),
      weightBearing: asTextOrNull(r['weight_bearing']),
      checkDue: asBool(r['check_due']),
      lastCheckRedFlag: asBool(r['last_check_red_flag']),
    };
  }

  private toCheck(r: Record<string, unknown>): CastCheckView {
    return {
      id: asText(r['id']),
      applicationId: asText(r['application_id']),
      at: asText(r['at']),
      byId: asTextOrNull(r['by_id']),
      kind: asTextOrNull(r['kind']),
      painOutOfProportion: asBool(r['pain_out_of_proportion']),
      painOnPassiveStretch: asBool(r['pain_on_passive_stretch']),
      paraesthesia: asBool(r['paraesthesia']),
      pallor: asBool(r['pallor']),
      pulselessness: asBool(r['pulselessness']),
      otherFindings: asStringArray(r['other_findings']),
      capillaryRefillSec: asNumberOrNull(r['capillary_refill_sec']),
      skinIntact: asBool(r['skin_intact']),
      castIntact: asBool(r['cast_intact']),
      neurovascularIntact: asBool(r['neurovascular_intact']),
      redFlag: asBool(r['red_flag']),
      actionTaken: asTextOrNull(r['action_taken']),
      escalatedTo: asTextOrNull(r['escalated_to']),
      notes: asTextOrNull(r['notes']),
    };
  }

  private toPinSite(r: Record<string, unknown>): PinSiteView {
    const next = asText(r['next_due_at']);
    return {
      id: asText(r['id']),
      applicationId: asText(r['application_id']),
      pinLabel: asText(r['pin_label']),
      intervalDays: asNumber(r['interval_days']),
      lastCareAt: asTextOrNull(r['last_care_at']),
      nextDueAt: next,
      infectionGrade: asNumberOrNull(r['infection_grade']),
      notes: asTextOrNull(r['notes']),
      isActive: asBool(r['is_active']),
      overdue: asBool(r['is_active']) && new Date(next).getTime() < Date.now(),
    };
  }

  private readonly applicationSelect = `
    SELECT a.*, q.patient_id, q.body_region, q.fracture_id, q.weight_bearing,
           (a.removed_at IS NULL AND a.next_check_due_at IS NOT NULL AND a.next_check_due_at <= now()) AS check_due,
           COALESCE((SELECT k.red_flag FROM clinical.cast_checks k
                      WHERE k.application_id = a.id ORDER BY k.at DESC LIMIT 1), false) AS last_check_red_flag
      FROM clinical.cast_applications a
      JOIN clinical.cast_requests q ON q.id = a.request_id`;

  async createCastRequest(body: CastRequestBody): Promise<CastRequestView> {
    return this.guard(async (tx) => {
      const id = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO clinical.cast_requests (
           id, hospital_id, branch_id, patient_id, fracture_id, er_visit_id, admission_id,
           kind, side, body_region, position, material, weight_bearing,
           requested_at, requested_by, urgency, instructions, status, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7,
           $8::clinical."ImmobilisationKind", $9, $10, $11, $12, $13::clinical."WeightBearing",
           now(), $14, $15, $16, 'requested', now(), now()
         ) RETURNING *`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.patientId,
          body.fractureId ?? null,
          body.erVisitId ?? null,
          body.admissionId ?? null,
          body.kind,
          body.side,
          body.bodyRegion,
          body.position ?? null,
          body.material ?? null,
          body.weightBearing ?? null,
          this.actorId(),
          body.urgency,
          body.instructions ?? null,
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The request was not created.');
      return this.toCastRequest(row);
    });
  }

  async listCasts(query: CastQuery): Promise<Page<CastApplicationView>> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `${this.applicationSelect}
          WHERE a.hospital_id = $1
            AND ($2::uuid IS NULL OR q.patient_id = $2)
            AND ($3::text IS NULL OR q.status::text = $3)
            AND (NOT $4::boolean OR (a.removed_at IS NULL AND a.next_check_due_at IS NOT NULL AND a.next_check_due_at <= now()))
          ORDER BY a.next_check_due_at NULLS LAST, a.applied_at DESC
          LIMIT $5`,
        [this.hospitalId(), query.patientId ?? null, query.status ?? null, query.dueOnly, query.limit],
      );
      return { items: rows.map((r) => this.toApplication(r)), nextCursor: null, hasMore: false };
    });
  }

  private async loadCast(tx: TransactionClient, id: string): Promise<CastDetailView> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `${this.applicationSelect} WHERE a.id = $1 AND a.hospital_id = $2`,
      [id, this.hospitalId()],
    );
    const row = rows[0];
    if (row === undefined) throw AppError.notFound('That cast is not on this hospital’s record.');

    const { rows: request } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM clinical.cast_requests WHERE id = $1`,
      [asText(row['request_id'])],
    );
    const req = request[0];
    if (req === undefined) throw AppError.notFound('The request behind that cast is missing.');

    const { rows: checks } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM clinical.cast_checks WHERE application_id = $1 ORDER BY at DESC LIMIT 50`,
      [id],
    );
    const { rows: pins } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM clinical.pin_site_schedules WHERE application_id = $1 ORDER BY pin_label`,
      [id],
    );

    return {
      ...this.toApplication(row),
      request: this.toCastRequest(req),
      checks: checks.map((c) => this.toCheck(c)),
      pinSites: pins.map((p) => this.toPinSite(p)),
    };
  }

  async getCast(id: string): Promise<CastDetailView> {
    return this.guard((tx) => this.loadCast(tx, id));
  }

  async applyCast(body: CastApplyRequest): Promise<CastDetailView> {
    return this.guard(async (tx) => {
      const id = newId();
      await tx.query(
        `INSERT INTO clinical.cast_applications (
           id, hospital_id, request_id, kind, side, material, position, padding, applied_in,
           applied_at, applied_by, instructions_given_locale, instructions_given_at,
           next_check_due_at, planned_removal_at, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4::clinical."ImmobilisationKind", $5, $6, $7, $8, $9,
           COALESCE($10::timestamptz, now()), $11, $12::text,
           CASE WHEN $12::text IS NULL THEN NULL ELSE now() END,
           COALESCE($10::timestamptz, now()) + make_interval(hours => $13::int),
           $14::timestamptz, now(), now()
         )`,
        [
          id,
          this.hospitalId(),
          body.requestId,
          body.kind,
          body.side,
          body.material,
          body.position ?? null,
          body.padding ?? null,
          body.appliedIn,
          body.appliedAt ?? null,
          this.actorId(),
          body.instructionsGivenLocale ?? null,
          body.firstCheckHours,
          body.plannedRemovalAt ?? null,
        ],
      );

      await tx.query(
        `UPDATE clinical.cast_requests SET status = 'applied', updated_at = now() WHERE id = $1 AND hospital_id = $2`,
        [body.requestId, this.hospitalId()],
      );

      const detail = await this.loadCast(tx, id);

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'cast_application',
        rowId: id,
        businessKey: `${detail.kind} ${detail.side} ${detail.bodyRegion}`,
        dataClass: 'phi',
        before: null,
        after: { kind: body.kind, side: body.side, material: body.material },
      });

      await this.outbox.publish(
        tx,
        implantEvent('cast.applied', id, {
          applicationId: id,
          requestId: body.requestId,
          patientId: detail.patientId,
          kind: body.kind,
          side: body.side,
          nextCheckDueAt: detail.nextCheckDueAt,
        }),
      );

      return detail;
    });
  }

  /**
   * Record a neurovascular check.
   *
   * `red_flag` is not sent. The database computes it from the findings and
   * refuses a check that found one and records no action — so a busy ward at
   * 2 a.m. cannot decide that pain on passive stretch is not a red flag today.
   */
  async recordCheck(applicationId: string, body: CastCheckRequest): Promise<CastDetailView> {
    return this.guard(async (tx) => {
      const id = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO clinical.cast_checks (
           id, hospital_id, application_id, at, by_id, kind,
           pain_out_of_proportion, pain_on_passive_stretch, paraesthesia, pallor, pulselessness,
           other_findings, capillary_refill_sec, skin_intact, cast_intact, neurovascular_intact,
           action_taken, escalated_to, photo_ref, notes, created_at
         ) VALUES (
           $1, $2, $3, now(), $4, $5,
           $6, $7, $8, $9, $10,
           $11::text[], $12, $13, $14, $15,
           $16, $17, $18, $19, now()
         ) RETURNING red_flag`,
        [
          id,
          this.hospitalId(),
          applicationId,
          this.actorId(),
          body.kind,
          body.painOutOfProportion,
          body.painOnPassiveStretch,
          body.paraesthesia,
          body.pallor,
          body.pulselessness,
          body.otherFindings,
          body.capillaryRefillSec ?? null,
          body.skinIntact,
          body.castIntact,
          body.neurovascularIntact,
          body.actionTaken ?? null,
          body.escalatedTo ?? null,
          body.photoRef ?? null,
          body.notes ?? null,
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The check was not recorded.');

      // A clean check buys twenty-four hours. A red flag buys one: the action
      // taken — splitting the cast, releasing the padding — is a measure whose
      // effect has to be looked at again while there is still time to act, and
      // an evolving compartment syndrome declares itself in hours. Leaving the
      // limb on tomorrow's list after bivalving it is how the second look does
      // not happen.
      const redFlag = asBool(row['red_flag']);
      await tx.query(
        `UPDATE clinical.cast_applications
            SET next_check_due_at = now() + CASE WHEN $3::boolean THEN interval '1 hour' ELSE interval '24 hours' END,
                updated_at = now()
          WHERE id = $1 AND hospital_id = $2 AND removed_at IS NULL`,
        [applicationId, this.hospitalId(), redFlag],
      );

      const detail = await this.loadCast(tx, applicationId);

      if (redFlag) {
        const findings: string[] = [];
        if (body.painOutOfProportion) findings.push('pain out of proportion');
        if (body.painOnPassiveStretch) findings.push('pain on passive stretch');
        if (body.paraesthesia) findings.push('paraesthesia');
        if (body.pallor) findings.push('pallor');
        if (body.pulselessness) findings.push('pulselessness');
        if (!body.neurovascularIntact) findings.push('neurovascular deficit');
        if (!body.skinIntact) findings.push('skin not intact');
        if (body.capillaryRefillSec !== undefined && body.capillaryRefillSec > 3) {
          findings.push(`capillary refill ${String(body.capillaryRefillSec)}s`);
        }
        findings.push(...body.otherFindings);

        await this.outbox.publish(
          tx,
          implantEvent('cast.check.red_flag', id, {
            checkId: id,
            applicationId,
            patientId: detail.patientId,
            findings,
            actionTaken: body.actionTaken ?? '',
            escalatedTo: body.escalatedTo ?? null,
          }),
        );
      }

      return detail;
    });
  }

  /**
   * Take a cast off.
   *
   * `cast.remove` carries `requiresReason`, so the grounds are already in the
   * context. They matter most when the removal is early: a cast off three weeks
   * before the plan is a fracture that can still displace, and the event says
   * so explicitly rather than leaving a date subtraction to a reader.
   */
  async removeCast(id: string, body: CastRemoveRequest): Promise<CastDetailView> {
    return this.guard(async (tx) => {
      const reason = this.reason('Removing a cast');

      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.cast_applications
            SET removed_at = COALESCE($3::timestamptz, now()), removed_by = $4,
                removal_notes = $5, updated_at = now()
          WHERE id = $1 AND hospital_id = $2 AND removed_at IS NULL
          RETURNING applied_at, removed_at, planned_removal_at, request_id`,
        [id, this.hospitalId(), body.removedAt ?? null, this.actorId(), body.notes ?? reason],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('That cast is not in place, or it is already off.');

      await tx.query(
        `UPDATE clinical.cast_requests SET status = 'removed', updated_at = now() WHERE id = $1`,
        [asText(row['request_id'])],
      );

      const removedAt = new Date(asText(row['removed_at'])).getTime();
      const planned = asTextOrNull(row['planned_removal_at']);
      const early = planned !== null && removedAt < new Date(planned).getTime();
      const daysInPlace = Math.max(
        0,
        Math.round((removedAt - new Date(asText(row['applied_at'])).getTime()) / 86_400_000),
      );

      const detail = await this.loadCast(tx, id);

      await this.audit.write(tx, {
        action: 'update',
        entity: 'cast_application',
        rowId: id,
        businessKey: `${detail.kind} ${detail.side} ${detail.bodyRegion}`,
        dataClass: 'phi',
        before: { removedAt: null },
        after: { removedAt: detail.removedAt, early, daysInPlace, reason },
      });

      await this.outbox.publish(
        tx,
        implantEvent('cast.removed', id, {
          applicationId: id,
          patientId: detail.patientId,
          daysInPlace,
          early,
          reason,
        }),
      );

      return detail;
    });
  }

  async addPinSite(applicationId: string, body: PinSiteRequest): Promise<CastDetailView> {
    return this.guard(async (tx) => {
      await tx.query(
        `INSERT INTO clinical.pin_site_schedules (
           id, hospital_id, application_id, pin_label, interval_days, next_due_at, notes, is_active, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $5::int), $6, true, now(), now())`,
        [newId(), this.hospitalId(), applicationId, body.pinLabel, body.intervalDays, body.notes ?? null],
      );
      return this.loadCast(tx, applicationId);
    });
  }

  async recordPinCare(applicationId: string, pinId: string, body: PinCareRequest): Promise<CastDetailView> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.pin_site_schedules
            SET last_care_at = now(),
                next_due_at = now() + make_interval(days => interval_days),
                infection_grade = COALESCE($3, infection_grade),
                notes = COALESCE($4, notes),
                is_active = COALESCE($5, is_active),
                updated_at = now()
          WHERE id = $1 AND application_id = $2 AND hospital_id = $6
          RETURNING id`,
        [
          pinId,
          applicationId,
          body.infectionGrade ?? null,
          body.notes ?? null,
          body.isActive ?? null,
          this.hospitalId(),
        ],
      );
      if (rows[0] === undefined) throw AppError.notFound('That pin site is not on this cast.');
      return this.loadCast(tx, applicationId);
    });
  }
}
