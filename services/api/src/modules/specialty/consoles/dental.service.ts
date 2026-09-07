import { Inject, Injectable } from '@nestjs/common';
import { ProblemType, newId } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { DatabaseService, type TransactionClient } from '../../../core/db/database.service.js';
import { NumberingService } from '../../../core/numbering/numbering.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { consoleEvent } from './consoles.events.js';
import type {
  DentalAcceptRequest,
  DentalPlanRequest,
  DentalPresentRequest,
  DentalSittingRequest,
  OpenQuery,
  ToothEventRequest,
} from './consoles.schemas.js';
import {
  ConsoleSupport,
  asJson,
  asNumber,
  asNumberArray,
  asNumberOrNull,
  asStringArray,
  asText,
  asTextOrNull,
} from './consoles.support.js';
import type {
  DentalChartDetail,
  DentalChartRow,
  DentalPlanItemRow,
  DentalPlanRow,
  DentalSittingRow,
  ToothEventRow,
} from './consoles.types.js';

/** Statuses at which a plan's prices are frozen. Mirrors §B.4.5. */
const PRICE_LOCKED = new Set(['accepted', 'partial', 'completed']);

/**
 * OP-026 — the dental console.
 *
 * ── Nothing here writes a chart ─────────────────────────────────────────────
 *
 * There is no `updateChart`, and there could not be one: `hms_app` holds no
 * INSERT, UPDATE or DELETE on `specialty.dental_charts` at all. The chart is
 * rebuilt by a SECURITY DEFINER trigger from the append-only log, so the only
 * way to change what a tooth looks like is `recordToothEvent`.
 *
 * ── Superseding is a new plan, not an edit ──────────────────────────────────
 *
 * `supersedePlan` cancels the accepted plan and copies its lines into a fresh
 * draft at the new prices, ready to be presented again. It does not — cannot —
 * reprice the accepted one: the trigger refuses, and the whole point is that
 * the document the patient signed still says what it said.
 *
 * ── The total is summed from the lines ──────────────────────────────────────
 *
 * A plan header's `total` is recomputed from its items on every write rather
 * than sent by the client, because a quotation whose header and lines disagree
 * is a quotation the patient and the cashier read differently.
 */
@Injectable()
export class DentalService extends ConsoleSupport {
  constructor(
    @Inject(DatabaseService) db: DatabaseService,
    @Inject(OutboxService) outbox: OutboxService,
    @Inject(AuditService) audit: AuditService,
    @Inject(NumberingService) private readonly numbering: NumberingService,
  ) {
    super(db, outbox, audit);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The chart
  // ═══════════════════════════════════════════════════════════════════════════

  async recordToothEvent(body: ToothEventRequest): Promise<DentalChartDetail> {
    return this.guard(async (tx) => {
      const id = newId();
      await tx.query(
        `INSERT INTO specialty.dental_tooth_events
           (id, hospital_id, branch_id, patient_id, encounter_id, tooth_fdi, surfaces,
            condition_code, status, plan_item_id, procedure_id, notes, recorded_at, recorded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7::text[],$8,$9::specialty."ToothEventStatus",
                 $10,$11,$12, now(), $13)`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.patientId,
          body.encounterId ?? null,
          body.toothFdi,
          body.surfaces,
          body.conditionCode,
          body.status,
          body.planItemId ?? null,
          body.procedureId ?? null,
          body.notes ?? null,
          this.actorId(),
        ],
      );

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'dental_tooth_event',
        rowId: id,
        businessKey: `${body.patientId}:${String(body.toothFdi)}`,
        dataClass: 'phi',
        patientId: body.patientId,
        encounterId: body.encounterId ?? null,
        before: null,
        after: { tooth: body.toothFdi, code: body.conditionCode, status: body.status },
      });

      return this.chartWithin(tx, body.patientId);
    });
  }

  async chart(patientId: string): Promise<DentalChartDetail> {
    return this.guard((tx) => this.chartWithin(tx, patientId));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The plan
  // ═══════════════════════════════════════════════════════════════════════════

  async createPlan(body: DentalPlanRequest): Promise<DentalPlanRow> {
    return this.guard(async (tx) => {
      const planId = newId();
      const alloc = await this.numbering.allocate(tx, {
        key: 'DENT_PLAN',
        branchId: this.branchId(),
        refType: 'dental_treatment_plan',
        refId: planId,
      });

      await tx.query(
        `INSERT INTO specialty.dental_treatment_plans
           (id, hospital_id, branch_id, patient_id, encounter_id, plan_no, status,
            created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,'draft',$7, now(), now())`,
        [
          planId,
          this.hospitalId(),
          this.branchId(),
          body.patientId,
          body.encounterId ?? null,
          alloc.formatted,
          this.actorId(),
        ],
      );

      let seq = 0;
      for (const item of body.items) {
        seq += 1;
        await tx.query(
          `INSERT INTO specialty.dental_plan_items
             (id, hospital_id, plan_id, seq, procedure_code, description, teeth, surfaces,
              phase, priority, quantity, sittings_planned, unit_price, discount, tax,
              alt_group, dentist_id, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7::int[],$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17, now(), now())`,
          [
            newId(),
            this.hospitalId(),
            planId,
            seq,
            item.procedureCode,
            item.description,
            item.teeth,
            JSON.stringify(item.surfaces),
            item.phase,
            item.priority,
            item.quantity,
            item.sittingsPlanned,
            item.unitPrice,
            item.discount,
            item.tax,
            item.altGroup ?? null,
            item.dentistId ?? null,
          ],
        );
      }

      await this.retotal(tx, planId);

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'dental_treatment_plan',
        rowId: planId,
        businessKey: alloc.formatted,
        dataClass: 'financial',
        patientId: body.patientId,
        encounterId: body.encounterId ?? null,
        before: null,
        after: { planNo: alloc.formatted, lines: body.items.length },
      });

      return this.planWithin(tx, planId);
    });
  }

  async presentPlan(planId: string, body: DentalPresentRequest): Promise<DentalPlanRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE specialty.dental_treatment_plans
            SET status = 'presented', presented_by = $3, presented_at = now(),
                consent_id = $4, instalment_schedule = $5::jsonb, updated_at = now()
          WHERE hospital_id = $1 AND id = $2 AND status = 'draft'
          RETURNING *`,
        [
          this.hospitalId(),
          planId,
          this.actorId(),
          body.consentId ?? null,
          JSON.stringify(body.instalmentSchedule),
        ],
      );
      if (rows[0] === undefined) {
        throw AppError.conflict('That plan does not exist, or it has already been presented.');
      }
      return this.planWithin(tx, planId);
    });
  }

  /**
   * The patient says yes, and the prices stop moving.
   *
   * `acceptedItemIds` narrows acceptance to the lines they agreed to; the rest
   * are declined rather than silently dropped, because a line that vanished is
   * a line nobody can explain the absence of when the patient asks why the
   * crown was not done.
   */
  async acceptPlan(planId: string, body: DentalAcceptRequest): Promise<DentalPlanRow> {
    return this.guard(async (tx) => {
      const chosen = body.acceptedItemIds;

      await tx.query(
        `UPDATE specialty.dental_plan_items
            SET status = CASE
                  WHEN $3::uuid[] = '{}'::uuid[] OR id = ANY($3::uuid[])
                    THEN 'accepted'::specialty."PlanItemStatus"
                  ELSE 'declined'::specialty."PlanItemStatus"
                END,
                updated_at = now()
          WHERE hospital_id = $1 AND plan_id = $2 AND status = 'proposed'`,
        [this.hospitalId(), planId, chosen],
      );

      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE specialty.dental_treatment_plans p
            SET status = CASE
                  WHEN EXISTS (SELECT 1 FROM specialty.dental_plan_items i
                                WHERE i.plan_id = p.id AND i.status = 'declined')
                    THEN 'partial'::specialty."PlanStatus"
                  ELSE 'accepted'::specialty."PlanStatus"
                END,
                accepted_at = now(),
                accepted_via = $3,
                accepted_total = coalesce((SELECT sum(i.unit_price * i.quantity - i.discount + i.tax)
                                             FROM specialty.dental_plan_items i
                                            WHERE i.plan_id = p.id AND i.status = 'accepted'), 0),
                updated_at = now()
          WHERE p.hospital_id = $1 AND p.id = $2 AND p.status = 'presented'
          RETURNING *`,
        [this.hospitalId(), planId, body.acceptedVia],
      );
      const plan = rows[0];
      if (plan === undefined) {
        throw AppError.conflict(
          'That plan is not in a state to be accepted. A plan is presented first, and acceptance records how the patient agreed.',
        );
      }

      const detail = await this.planWithin(tx, planId);

      await this.outbox.publish(
        tx,
        consoleEvent('dental.plan.accepted', planId, {
          planId,
          planNo: detail.planNo,
          patientId: asText(plan['patient_id']),
          acceptedTotal: String(detail.acceptedTotal),
          acceptedVia: body.acceptedVia,
          itemCount: detail.items.filter((i) => i.status === 'accepted').length,
        }),
      );

      await this.audit.write(tx, {
        action: 'update',
        entity: 'dental_treatment_plan',
        rowId: planId,
        businessKey: detail.planNo,
        dataClass: 'financial',
        patientId: asText(plan['patient_id']),
        encounterId: asTextOrNull(plan['encounter_id']),
        before: null,
        after: { acceptedVia: body.acceptedVia, acceptedTotal: detail.acceptedTotal },
      });

      return detail;
    });
  }

  /**
   * Re-price an accepted plan by superseding it.
   *
   * The database will not let an accepted line's price move, and this does not
   * try: it cancels the old plan and creates a new draft carrying the same
   * lines at whatever the new prices are, which then has to be presented and
   * accepted again. The patient's signed document survives intact, and the
   * reason for the change is on the cancelled one.
   */
  async supersedePlan(planId: string, body: DentalPlanRequest, reason: string): Promise<DentalPlanRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM specialty.dental_treatment_plans
          WHERE hospital_id = $1 AND id = $2`,
        [this.hospitalId(), planId],
      );
      const old = rows[0];
      if (old === undefined) throw AppError.notFound('That plan does not exist.');
      if (!PRICE_LOCKED.has(asText(old['status']))) {
        throw new AppError(
          ProblemType.VALIDATION_FAILED,
          'That plan has not been accepted, so its prices are not locked. Edit it instead of superseding it.',
        );
      }

      await tx.query(
        `UPDATE specialty.dental_treatment_plans
            SET status = 'cancelled', updated_at = now()
          WHERE hospital_id = $1 AND id = $2`,
        [this.hospitalId(), planId],
      );

      await this.audit.write(tx, {
        action: 'override',
        entity: 'dental_treatment_plan',
        rowId: planId,
        businessKey: asText(old['plan_no']),
        dataClass: 'financial',
        patientId: asText(old['patient_id']),
        encounterId: asTextOrNull(old['encounter_id']),
        reasonText: reason,
        before: { status: asText(old['status']), total: asNumber(old['accepted_total']) },
        after: { status: 'cancelled' },
      });

      // Deliberately a fresh draft rather than a version bump: it has to be
      // presented and consented to again, which is the whole point.
      return this.createPlanWithin(tx, { ...body, patientId: asText(old['patient_id']) });
    });
  }

  async listPlans(query: OpenQuery): Promise<readonly DentalPlanRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT id FROM specialty.dental_treatment_plans
          WHERE hospital_id = $1
            AND ($2::uuid IS NULL OR patient_id = $2::uuid)
            AND ($3::boolean IS NOT TRUE OR status NOT IN ('completed','cancelled','declined'))
          ORDER BY created_at DESC LIMIT $4`,
        [this.hospitalId(), query.patientId ?? null, query.openOnly, query.limit],
      );
      const out: DentalPlanRow[] = [];
      for (const r of rows) out.push(await this.planWithin(tx, asText(r['id'])));
      return out;
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The chair
  // ═══════════════════════════════════════════════════════════════════════════

  async recordSitting(body: DentalSittingRequest): Promise<DentalSittingRow> {
    return this.guard(async (tx) => {
      const id = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.dental_sittings
           (id, hospital_id, branch_id, patient_id, plan_id, encounter_id, procedure_id,
            items, la, materials, implant_udi, rct_detail, extraction_detail, ortho_detail,
            photos, next_visit_days, performed_at, performed_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,
                 $12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,$16, now(),$17, now(), now())
         RETURNING *`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.patientId,
          body.planId ?? null,
          body.encounterId ?? null,
          body.procedureId ?? null,
          JSON.stringify(body.items),
          JSON.stringify(body.la),
          JSON.stringify(body.materials),
          body.implantUdi ?? null,
          JSON.stringify(body.rctDetail),
          JSON.stringify(body.extractionDetail),
          JSON.stringify(body.orthoDetail),
          JSON.stringify(body.photos),
          body.nextVisitDays ?? null,
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The sitting was not recorded.');

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'dental_sitting',
        rowId: id,
        businessKey: body.patientId,
        dataClass: 'phi',
        patientId: body.patientId,
        encounterId: body.encounterId ?? null,
        before: null,
        after: { planId: body.planId ?? null, lines: body.items.length },
      });

      return {
        id: asText(row['id']),
        patientId: asText(row['patient_id']),
        planId: asTextOrNull(row['plan_id']),
        procedureId: asTextOrNull(row['procedure_id']),
        performedAt: asText(row['performed_at']),
        performedBy: asText(row['performed_by']),
        nextVisitDays: asNumberOrNull(row['next_visit_days']),
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Shaping
  // ═══════════════════════════════════════════════════════════════════════════

  private async createPlanWithin(tx: TransactionClient, body: DentalPlanRequest): Promise<DentalPlanRow> {
    const planId = newId();
    const alloc = await this.numbering.allocate(tx, {
      key: 'DENT_PLAN',
      branchId: this.branchId(),
      refType: 'dental_treatment_plan',
      refId: planId,
    });

    await tx.query(
      `INSERT INTO specialty.dental_treatment_plans
         (id, hospital_id, branch_id, patient_id, encounter_id, plan_no, status,
          created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'draft',$7, now(), now())`,
      [
        planId,
        this.hospitalId(),
        this.branchId(),
        body.patientId,
        body.encounterId ?? null,
        alloc.formatted,
        this.actorId(),
      ],
    );

    let seq = 0;
    for (const item of body.items) {
      seq += 1;
      await tx.query(
        `INSERT INTO specialty.dental_plan_items
           (id, hospital_id, plan_id, seq, procedure_code, description, teeth, surfaces,
            phase, priority, quantity, sittings_planned, unit_price, discount, tax,
            alt_group, dentist_id, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::int[],$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17, now(), now())`,
        [
          newId(),
          this.hospitalId(),
          planId,
          seq,
          item.procedureCode,
          item.description,
          item.teeth,
          JSON.stringify(item.surfaces),
          item.phase,
          item.priority,
          item.quantity,
          item.sittingsPlanned,
          item.unitPrice,
          item.discount,
          item.tax,
          item.altGroup ?? null,
          item.dentistId ?? null,
        ],
      );
    }

    await this.retotal(tx, planId);
    return this.planWithin(tx, planId);
  }

  private async retotal(tx: TransactionClient, planId: string): Promise<void> {
    await tx.query(
      `UPDATE specialty.dental_treatment_plans p
          SET total = coalesce((SELECT sum(i.unit_price * i.quantity - i.discount + i.tax)
                                  FROM specialty.dental_plan_items i
                                 WHERE i.plan_id = p.id
                                   AND i.status NOT IN ('declined','cancelled')), 0),
              updated_at = now()
        WHERE p.id = $1`,
      [planId],
    );
  }

  private async chartWithin(tx: TransactionClient, patientId: string): Promise<DentalChartDetail> {
    const [chart, events] = await Promise.all([
      tx.query<Record<string, unknown>>(
        `SELECT * FROM specialty.dental_charts WHERE hospital_id = $1 AND patient_id = $2`,
        [this.hospitalId(), patientId],
      ),
      tx.query<Record<string, unknown>>(
        `SELECT * FROM specialty.dental_tooth_events
          WHERE hospital_id = $1 AND patient_id = $2
          ORDER BY recorded_at DESC LIMIT 500`,
        [this.hospitalId(), patientId],
      ),
    ]);

    const row = chart.rows[0];
    return {
      chart: row === undefined ? null : this.toChart(row),
      events: events.rows.map((r) => this.toToothEvent(r)),
    };
  }

  private async planWithin(tx: TransactionClient, planId: string): Promise<DentalPlanRow> {
    const [plan, items] = await Promise.all([
      tx.query<Record<string, unknown>>(
        `SELECT * FROM specialty.dental_treatment_plans WHERE hospital_id = $1 AND id = $2`,
        [this.hospitalId(), planId],
      ),
      tx.query<Record<string, unknown>>(
        `SELECT * FROM specialty.dental_plan_items WHERE plan_id = $1 ORDER BY seq`,
        [planId],
      ),
    ]);

    const row = plan.rows[0];
    if (row === undefined) throw AppError.notFound('That treatment plan does not exist.');
    const status = asText(row['status']);

    return {
      id: asText(row['id']),
      planNo: asText(row['plan_no']),
      patientId: asText(row['patient_id']),
      status,
      total: asNumber(row['total']),
      acceptedTotal: asNumber(row['accepted_total']),
      acceptedVia: asTextOrNull(row['accepted_via']),
      acceptedAt: asTextOrNull(row['accepted_at']),
      presentedAt: asTextOrNull(row['presented_at']),
      version: asNumber(row['version']),
      priceLocked: PRICE_LOCKED.has(status),
      items: items.rows.map((i) => this.toItem(i)),
    };
  }

  private toChart(row: Record<string, unknown>): DentalChartRow {
    return {
      patientId: asText(row['patient_id']),
      dentition: asText(row['dentition']),
      state: asJson(row['state']),
      dmft: asNumberOrNull(row['dmft']),
      rebuiltAt: asText(row['rebuilt_at']),
    };
  }

  private toToothEvent(row: Record<string, unknown>): ToothEventRow {
    return {
      id: asText(row['id']),
      patientId: asText(row['patient_id']),
      toothFdi: asNumber(row['tooth_fdi']),
      surfaces: asStringArray(row['surfaces']),
      conditionCode: asText(row['condition_code']),
      status: asText(row['status']),
      notes: asTextOrNull(row['notes']),
      recordedAt: asText(row['recorded_at']),
      recordedBy: asText(row['recorded_by']),
    };
  }

  private toItem(row: Record<string, unknown>): DentalPlanItemRow {
    const unit = asNumber(row['unit_price']);
    const qty = asNumber(row['quantity']);
    const discount = asNumber(row['discount']);
    const tax = asNumber(row['tax']);
    return {
      id: asText(row['id']),
      seq: asNumber(row['seq']),
      procedureCode: asText(row['procedure_code']),
      description: asText(row['description']),
      teeth: asNumberArray(row['teeth']),
      quantity: qty,
      unitPrice: unit,
      discount,
      tax,
      lineTotal: unit * qty - discount + tax,
      sittingsPlanned: asNumber(row['sittings_planned']),
      sittingsDone: asNumber(row['sittings_done']),
      status: asText(row['status']),
      altGroup: asTextOrNull(row['alt_group']),
    };
  }
}
