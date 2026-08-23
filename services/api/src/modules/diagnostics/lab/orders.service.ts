import { Inject, Injectable } from '@nestjs/common';
import { ProblemType, newId, type Page } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService, type TransactionClient } from '../../../core/db/database.service.js';
import { NumberingService } from '../../../core/numbering/numbering.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { CursorService } from '../../../core/pagination/cursor.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import {
  actorId,
  assertPatientVisible,
  requireBranch,
  withLabErrors,
  writeOrderEvent,
} from './lab.common.js';
import { labEvent } from './lab.events.js';
import type {
  AddOnTestsRequest,
  CancelTestsRequest,
  CreateLabOrderRequest,
  LabOrderQuery,
  LabOrderTestRequest,
} from './lab.schemas.js';
import type { LabOrderTestView, LabOrderView, LabSampleView } from './lab.types.js';

/**
 * OP-004 §3.1 — the laboratory's own record of fulfilling one or more CPOE
 * lines.
 *
 * `lab.lab_orders` does not replace `clinical.orders`, and the distinction is
 * load-bearing. Phase 2 built CPOE and left `order_items.fulfilment_module` /
 * `fulfilment_ref` for exactly this: the doctor's request is one fact, and the
 * laboratory's undertaking to produce a number — with an accession, a specimen,
 * a turnaround clock and its own status vocabulary — is another. A walk-in with
 * an outside prescription has the second and not the first, which is why
 * `clinical_order_id` is nullable and not a data-quality failure.
 *
 * **Panels expand here, not in the client.** A "renal function test" is one
 * thing to order and three things to bill, cancel, reject and report; if the
 * expansion happened in the browser, a hospital that added an analyte to the
 * panel in April would find January's orders quietly containing it. The
 * membership is read effective-dated at the moment of ordering and snapshotted
 * onto the line, so a master edit cannot rewrite a printed report.
 */
@Injectable()
export class LabOrdersService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(NumberingService) private readonly numbering: NumberingService,
    @Inject(CursorService) private readonly cursors: CursorService,
  ) {}

  async create(body: CreateLabOrderRequest): Promise<LabOrderView> {
    const ctx = getContext();
    const branchId = requireBranch(body.branchId);

    // `lab_orders_episode`: an order belongs to a visit, an admission or an ER
    // attendance — unless it is one of the four sources that genuinely have
    // none. Checking it here turns a CHECK violation into a field error.
    if (
      body.visitId === undefined &&
      body.admissionId === undefined &&
      body.erVisitId === undefined &&
      !['walkin', 'referred_in', 'camp', 'home_collection'].includes(body.source)
    ) {
      throw AppError.validation([
        {
          path: 'visitId',
          code: 'episode_required',
          message:
            'A laboratory order belongs to a visit, an admission or an ER attendance. A walk-in, a referred-in specimen, a camp or a home collection is the exception, and it has to say so in `source`.',
        },
      ]);
    }
    if (body.isMlc && body.mlcRef === undefined) {
      throw AppError.validation([
        {
          path: 'mlcRef',
          code: 'mlc_ref_required',
          message: 'A medico-legal order names the MLC it belongs to; the specimen chain depends on it.',
        },
      ]);
    }

    const id = newId();

    const created = await withLabErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        await assertPatientVisible(tx, body.patientId);

        const lines = await this.expand(tx, body.tests, body.priority);

        // Allocated inside the caller's transaction, so an order that fails
        // validation gives its accession back rather than burning it.
        const accession = await this.numbering.allocate(tx, {
          key: 'LAB_ACC',
          branchId,
          refType: 'lab.lab_orders',
          refId: id,
        });

        await tx.query(
          `INSERT INTO lab.lab_orders (
             id, hospital_id, branch_id, accession_no, patient_id,
             visit_id, admission_id, er_visit_id, encounter_id, clinical_order_id,
             source, ordering_user_id, ordering_practitioner_key,
             referring_facility, referring_doctor_name,
             priority, status, billing_status, clinical_notes, is_mlc, mlc_ref,
             ordered_at, created_by, updated_by, updated_at
           ) VALUES (
             $1, $2, $3, $4, $5,
             $6, $7, $8, $9, $10,
             $11::lab."LabOrderSource", $12, $13,
             $14, $15,
             $16::lab."LabPriority", 'placed', 'pending', $17, $18, $19,
             now(), $20, $20, now()
           )`,
          [
            id,
            ctx.hospitalId,
            branchId,
            accession.formatted,
            body.patientId,
            body.visitId ?? null,
            body.admissionId ?? null,
            body.erVisitId ?? null,
            body.encounterId ?? null,
            body.clinicalOrderId ?? null,
            body.source,
            ctx.userId,
            body.orderingPractitionerKey ?? null,
            body.referringFacility ?? null,
            body.referringDoctorName ?? null,
            body.priority,
            body.clinicalNotes ?? null,
            body.isMlc,
            body.mlcRef ?? null,
            ctx.userId,
          ],
        );

        await this.insertLines(tx, id, lines, 0, { isAddon: false });
        await writeOrderEvent(tx, { orderId: id, to: 'placed' });

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'lab.lab_orders',
          rowId: id,
          businessKey: accession.formatted,
          dataClass: 'phi',
          patientId: body.patientId,
          encounterId: body.encounterId ?? null,
          before: null,
          after: {
            accession_no: accession.formatted,
            source: body.source,
            priority: body.priority,
            test_count: lines.length,
            is_mlc: body.isMlc,
          },
        });

        await this.outbox.publish(
          tx,
          labEvent('lab.order.created', id, {
            orderId: id,
            accessionNo: accession.formatted,
            patientId: body.patientId,
            visitId: body.visitId ?? null,
            encounterId: body.encounterId ?? null,
            orderingUserId: actorId(),
            priority: body.priority,
            testCount: lines.length,
            isOutsourced: lines.some((l) => l.isOutsourced),
            placedAt: new Date().toISOString(),
          }),
        );

        return id;
      }),
    );

    return this.get(created);
  }

  /**
   * `OP-004 §3.1.4` — a test added to an order whose specimen is already in the
   * laboratory. The stability window is reported rather than enforced: a
   * specimen outside it may still be usable for some analytes and the decision
   * belongs to the laboratory, but "we did not know" must not be an option, so
   * the answer travels on the event.
   */
  async addOn(orderId: string, body: AddOnTestsRequest): Promise<LabOrderView> {
    const before = await this.get(orderId);
    if (before.status === 'cancelled') {
      throw new AppError(ProblemType.ALREADY_DECIDED, 'This order is cancelled; nothing can be added to it.');
    }

    await withLabErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const lines = await this.expand(tx, body.tests, before.priority);
        const maxLine = await tx.one<{ n: number }>(
          `SELECT COALESCE(max(line_no), 0)::int AS n FROM lab.lab_order_tests WHERE order_id = $1`,
          [orderId],
        );

        const inserted = await this.insertLines(tx, orderId, lines, maxLine.n, { isAddon: true });

        // The specimen the add-on will run on, and whether it is still inside
        // the window the specimen master declares.
        const stability = await tx.maybeOne<{ sample_id: string; within: boolean }>(
          `SELECT s.id AS sample_id,
                  (s.collected_at IS NOT NULL
                    AND sp.stability_hours IS NOT NULL
                    AND s.collected_at + make_interval(hours => sp.stability_hours::int) > now()) AS within
             FROM lab.lab_samples s
             JOIN LATERAL (
               SELECT DISTINCT ON (t.record_key) t.stability_hours
                 FROM mdm.mdm_lab_specimen_types t
                WHERE t.record_key = s.specimen_type_key AND t.status = 'active'
                ORDER BY t.record_key, t.version DESC
             ) sp ON true
            WHERE s.order_id = $1 AND s.status NOT IN ('rejected', 'disposed')
            ORDER BY s.collected_at DESC NULLS LAST
            LIMIT 1`,
          [orderId],
        );

        for (const line of inserted) {
          await writeOrderEvent(tx, { orderId, orderTestId: line.id, to: 'pending', reason: 'add-on' });
        }

        await this.audit.write(tx, {
          action: 'update',
          entity: 'lab.lab_orders',
          rowId: orderId,
          businessKey: before.accession_no,
          dataClass: 'phi',
          patientId: before.patient_id,
          encounterId: before.encounter_id,
          before: { test_count: before.tests.length },
          after: { test_count: before.tests.length + inserted.length, added: inserted.map((l) => l.code) },
        });

        await this.outbox.publish(
          tx,
          labEvent('lab.order.addon', orderId, {
            orderId,
            patientId: before.patient_id,
            sampleId: stability?.sample_id ?? null,
            addedTestIds: inserted.map((l) => l.id),
            withinStabilityWindow: stability?.within ?? false,
            addedBy: actorId(),
            addedAt: new Date().toISOString(),
          }),
        );
      }),
    );

    return this.get(orderId);
  }

  /**
   * `OP-004 §5`: a cancellation before a result reverses the charge; after one
   * it does not. A line whose result already exists is therefore refused here
   * rather than cancelled quietly — the correction for a wrong result is an
   * amendment, not the disappearance of the line that produced it.
   */
  async cancelTests(orderId: string, body: CancelTestsRequest): Promise<LabOrderView> {
    const before = await this.get(orderId);
    if (before.status === 'cancelled') {
      throw new AppError(ProblemType.ALREADY_DECIDED, 'This order is already cancelled.');
    }

    const requested =
      body.orderTestIds.length === 0
        ? before.tests.filter((t) => t.status !== 'cancelled').map((t) => t.id)
        : body.orderTestIds;

    const unknown = requested.filter((id) => !before.tests.some((t) => t.id === id));
    if (unknown.length > 0) throw AppError.notFound('One of the test lines');

    await withLabErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const resulted = await tx.rows<{ order_test_id: string }>(
          `SELECT DISTINCT order_test_id FROM lab.lab_results WHERE order_test_id = ANY($1::uuid[])`,
          [requested],
        );
        if (resulted.length > 0) {
          throw new AppError(
            ProblemType.BUSINESS_RULE_VIOLATED,
            'One or more of these tests already has a result. A result is not withdrawn by cancelling the line it belongs to — amend or cancel the result itself, with a reason.',
          );
        }

        await tx.query(
          `UPDATE lab.lab_order_tests
              SET status = 'cancelled', cancel_reason = $2, updated_by = $3,
                  updated_at = now(), version = version + 1
            WHERE id = ANY($1::uuid[]) AND status <> 'cancelled'`,
          [requested, body.reason, getContext().userId],
        );

        const remaining = await tx.one<{ n: number }>(
          `SELECT count(*)::int AS n FROM lab.lab_order_tests
            WHERE order_id = $1 AND status <> 'cancelled'`,
          [orderId],
        );

        if (remaining.n === 0) {
          await tx.query(
            `UPDATE lab.lab_orders
                SET status = 'cancelled', cancelled_at = now(), cancel_reason = $2,
                    updated_by = $3, updated_at = now(), version = version + 1
              WHERE id = $1`,
            [orderId, body.reason, getContext().userId],
          );
        }

        for (const testId of requested) {
          await writeOrderEvent(tx, {
            orderId,
            orderTestId: testId,
            to: 'cancelled',
            reason: body.reason,
          });
        }

        await this.audit.write(tx, {
          action: 'delete',
          entity: 'lab.lab_orders',
          rowId: orderId,
          businessKey: before.accession_no,
          dataClass: 'phi',
          patientId: before.patient_id,
          encounterId: before.encounter_id,
          before: { status: before.status, cancelled_lines: 0 },
          after: {
            status: remaining.n === 0 ? 'cancelled' : before.status,
            cancelled_lines: requested.length,
          },
          reasonText: body.reason,
        });

        await this.outbox.publish(
          tx,
          labEvent('lab.order.cancelled', orderId, {
            orderId,
            orderTestIds: requested,
            patientId: before.patient_id,
            reason: body.reason,
            hasResults: false,
            cancelledBy: actorId(),
            cancelledAt: new Date().toISOString(),
          }),
        );
      }),
    );

    return this.get(orderId);
  }

  async get(id: string): Promise<LabOrderView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const header = await tx.maybeOne<OrderRow>(
        `SELECT id, accession_no, patient_id, branch_id, visit_id, encounter_id, clinical_order_id,
                source::text AS source, priority::text AS priority, status::text AS status,
                billing_status::text AS billing_status, clinical_notes, is_mlc,
                ordered_at::text AS ordered_at, cancel_reason
           FROM lab.lab_orders WHERE id = $1`,
        [id],
      );
      if (header === undefined) throw AppError.notFound('The laboratory order');

      const tests = await this.testsFor(tx, [id]);
      const samples = await this.samplesFor(tx, [id]);
      return toOrderView(header, tests, samples);
    });
  }

  async list(query: LabOrderQuery): Promise<Page<LabOrderView>> {
    const ctx = getContext();
    const hospitalId = ctx.hospitalId ?? '';
    const resource = 'lab.orders';
    const limit = this.cursors.pageSize(query.limit);
    const after = this.cursors.start(query.cursor, { hospitalId, resource });

    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const values: unknown[] = [];
      const bind = (value: unknown): string => `$${values.push(value)}`;
      const clauses: string[] = [];
      if (query.patientId !== undefined) clauses.push(`o.patient_id = ${bind(query.patientId)}::uuid`);
      if (query.status !== undefined) clauses.push(`o.status = ${bind(query.status)}::lab."LabOrderStatus"`);
      if (query.priority !== undefined)
        clauses.push(`o.priority = ${bind(query.priority)}::lab."LabPriority"`);
      if (after !== null) {
        clauses.push(`(o.ordered_at, o.id) < (${bind(after.k[0])}::timestamptz, ${bind(after.id)}::uuid)`);
      }
      const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;

      const rows = await tx.rows<OrderRow & { cursor_key: string }>(
        `SELECT o.id, o.accession_no, o.patient_id, o.branch_id, o.visit_id, o.encounter_id,
                o.clinical_order_id, o.source::text AS source, o.priority::text AS priority,
                o.status::text AS status, o.billing_status::text AS billing_status,
                o.clinical_notes, o.is_mlc, o.ordered_at::text AS ordered_at, o.cancel_reason,
                o.ordered_at::text AS cursor_key
           FROM lab.lab_orders o
           ${where}
          ORDER BY o.ordered_at DESC, o.id DESC
          LIMIT ${bind(limit + 1)}`,
        values,
      );

      const page = this.cursors.keysetPage<OrderRow>(rows, limit, {
        hospitalId,
        resource,
        direction: 'desc',
      });

      const ids = page.items.map((o) => o.id);
      const tests = ids.length === 0 ? [] : await this.testsFor(tx, ids);
      const samples = ids.length === 0 ? [] : await this.samplesFor(tx, ids);

      return {
        items: page.items.map((header) =>
          toOrderView(
            header,
            tests.filter((t) => t.order_id === header.id),
            samples.filter((s) => s.order_id === header.id),
          ),
        ),
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      };
    });
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private async testsFor(
    tx: TransactionClient,
    orderIds: readonly string[],
  ): Promise<(LabOrderTestView & { order_id: string })[]> {
    return tx.rows<LabOrderTestView & { order_id: string }>(
      `SELECT order_id, id, line_no, test_key, test_code, test_name, loinc_code,
              discipline::text AS discipline, sample_id, priority::text AS priority,
              status::text AS status, is_addon, is_reflex, is_chargeable, panel_key,
              recollection_of_order_test_id, tat_due_at::text AS tat_due_at, cancel_reason
         FROM lab.lab_order_tests
        WHERE order_id = ANY($1::uuid[])
        ORDER BY line_no`,
      [orderIds],
    );
  }

  private async samplesFor(
    tx: TransactionClient,
    orderIds: readonly string[],
  ): Promise<(LabSampleView & { order_id: string })[]> {
    return tx.rows<LabSampleView & { order_id: string }>(
      `SELECT order_id, id, sample_no, barcode, status::text AS status, specimen_type_name,
              container_name, cap_colour, collected_at::text AS collected_at,
              received_at::text AS received_at, accessioned_at::text AS accessioned_at,
              condition_on_receipt::text AS condition_on_receipt, rejection_reason_code,
              rejection_note, rejected_at::text AS rejected_at, recollection_of_sample_id,
              patient_scan_verified, container_scan_verified, identity_override_reason
         FROM lab.lab_samples
        WHERE order_id = ANY($1::uuid[])
        ORDER BY sample_no`,
      [orderIds],
    );
  }

  /**
   * Resolves each requested test against the live catalogue and expands a panel
   * into its members. The snapshot (code, name, LOINC, discipline) is taken here
   * because a master edit must not rewrite a printed report.
   */
  private async expand(
    tx: TransactionClient,
    requested: readonly LabOrderTestRequest[],
    orderPriority: string,
  ): Promise<ResolvedLine[]> {
    const keys = requested.map((t) => t.testKey);
    const tests = await tx.rows<CatalogueRow>(
      `SELECT DISTINCT ON (t.record_key)
              t.record_key, t.code, t.name, t.loinc_code, t.discipline::text AS discipline,
              t.is_panel, t.is_orderable, t.is_outsourced_default, t.referral_lab_key,
              t.tat_routine_minutes, t.tat_urgent_minutes, t.tat_stat_minutes
         FROM mdm.mdm_lab_tests t
        WHERE t.record_key = ANY($1::uuid[])
          AND t.status = 'active'
          AND t.effective_from <= now()
          AND (t.effective_to IS NULL OR t.effective_to > now())
        ORDER BY t.record_key, t.version DESC`,
      [keys],
    );

    const missing = keys.filter((k) => !tests.some((t) => t.record_key === k));
    if (missing.length > 0) {
      throw AppError.validation(
        missing.map((key) => ({
          path: 'tests',
          code: 'test_not_orderable',
          message: `Test ${key} is not an active, orderable test in this hospital right now.`,
        })),
      );
    }

    const notOrderable = tests.filter((t) => !t.is_orderable);
    if (notOrderable.length > 0) {
      throw AppError.validation(
        notOrderable.map((t) => ({
          path: 'tests',
          code: 'test_not_orderable',
          message: `${t.name} is currently suspended from ordering. EN-031 §5 keeps an accredited test off the menu until its validation, calibration, QC and competency evidence are all in place.`,
        })),
      );
    }

    const panelKeys = tests.filter((t) => t.is_panel).map((t) => t.record_key);
    const members =
      panelKeys.length === 0
        ? []
        : await tx.rows<{ panel_key: string; member_test_key: string; sequence: number }>(
            `SELECT DISTINCT ON (m.record_key) m.panel_key, m.member_test_key, m.sequence
               FROM mdm.mdm_lab_panel_members m
              WHERE m.panel_key = ANY($1::uuid[])
                AND m.status = 'active'
                AND m.effective_from <= now()
                AND (m.effective_to IS NULL OR m.effective_to > now())
              ORDER BY m.record_key, m.version DESC`,
            [panelKeys],
          );

    const memberKeys = [...new Set(members.map((m) => m.member_test_key))];
    const memberTests =
      memberKeys.length === 0
        ? []
        : await tx.rows<CatalogueRow>(
            `SELECT DISTINCT ON (t.record_key)
                    t.record_key, t.code, t.name, t.loinc_code, t.discipline::text AS discipline,
                    t.is_panel, t.is_orderable, t.is_outsourced_default, t.referral_lab_key,
                    t.tat_routine_minutes, t.tat_urgent_minutes, t.tat_stat_minutes
               FROM mdm.mdm_lab_tests t
              WHERE t.record_key = ANY($1::uuid[])
                AND t.status = 'active'
                AND t.effective_from <= now()
                AND (t.effective_to IS NULL OR t.effective_to > now())
              ORDER BY t.record_key, t.version DESC`,
            [memberKeys],
          );

    const lines: ResolvedLine[] = [];
    for (const request of requested) {
      const test = tests.find((t) => t.record_key === request.testKey);
      if (test === undefined) continue;
      const priority = request.priority ?? orderPriority;

      if (!test.is_panel) {
        lines.push(this.toLine(test, priority, null, request.orderItemId ?? null));
        continue;
      }

      const ordered = members
        .filter((m) => m.panel_key === test.record_key)
        .sort((a, b) => a.sequence - b.sequence);
      if (ordered.length === 0) {
        throw AppError.validation([
          {
            path: 'tests',
            code: 'empty_panel',
            message: `${test.name} is configured as a panel but has no members in force today. Ordering it would produce an order nobody can result.`,
          },
        ]);
      }
      for (const member of ordered) {
        const memberTest = memberTests.find((t) => t.record_key === member.member_test_key);
        if (memberTest === undefined) continue;
        lines.push(this.toLine(memberTest, priority, test.record_key, request.orderItemId ?? null));
      }
    }

    if (lines.length === 0) {
      throw AppError.validation([
        { path: 'tests', code: 'nothing_orderable', message: 'None of these tests can be ordered today.' },
      ]);
    }
    return lines;
  }

  private toLine(
    test: CatalogueRow,
    priority: string,
    panelKey: string | null,
    orderItemId: string | null,
  ): ResolvedLine {
    const minutes =
      priority === 'stat'
        ? test.tat_stat_minutes
        : priority === 'urgent'
          ? test.tat_urgent_minutes
          : test.tat_routine_minutes;

    return {
      testKey: test.record_key,
      code: test.code,
      name: test.name,
      loinc: test.loinc_code,
      discipline: test.discipline,
      priority,
      panelKey,
      orderItemId,
      isOutsourced: test.is_outsourced_default,
      referralLabKey: test.referral_lab_key,
      tatMinutes: minutes,
    };
  }

  private async insertLines(
    tx: TransactionClient,
    orderId: string,
    lines: readonly ResolvedLine[],
    startLineNo: number,
    options: { readonly isAddon: boolean },
  ): Promise<{ id: string; code: string }[]> {
    const ctx = getContext();
    const created: { id: string; code: string }[] = [];
    let lineNo = startLineNo;

    for (const line of lines) {
      lineNo += 1;
      const id = newId();

      // `OP-004 §5`: "STAT clock starts at order; routine at receipt
      // (configurable, NABL requires define)". The declared start is stored on
      // the row so an SLA report can be reproduced years later against the rule
      // that was actually in force, not the one in force when the report runs.
      const clockStartsAtOrder = line.priority === 'stat';

      await tx.query(
        `INSERT INTO lab.lab_order_tests (
           id, hospital_id, order_id, line_no, order_item_id, test_key, test_code, test_name,
           loinc_code, discipline, priority, status, is_addon, panel_key,
           is_outsourced, referral_lab_id, tat_clock_starts_at, tat_due_at,
           created_by, updated_by, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8,
           $9, $10::mdm."LabDiscipline", $11::lab."LabPriority", 'pending', $12, $13,
           $14, $15,
           CASE WHEN $16 THEN now() ELSE NULL END,
           CASE WHEN $16 AND $17::int IS NOT NULL THEN now() + make_interval(mins => $17::int) ELSE NULL END,
           $18, $18, now()
         )`,
        [
          id,
          ctx.hospitalId,
          orderId,
          lineNo,
          line.orderItemId,
          line.testKey,
          line.code,
          line.name,
          line.loinc,
          line.discipline,
          line.priority,
          options.isAddon,
          line.panelKey,
          line.isOutsourced,
          line.isOutsourced ? line.referralLabKey : null,
          clockStartsAtOrder,
          line.tatMinutes,
          ctx.userId,
        ],
      );
      created.push({ id, code: line.code });
    }

    return created;
  }
}

interface ResolvedLine {
  readonly testKey: string;
  readonly code: string;
  readonly name: string;
  readonly loinc: string | null;
  readonly discipline: string;
  readonly priority: string;
  readonly panelKey: string | null;
  readonly orderItemId: string | null;
  readonly isOutsourced: boolean;
  readonly referralLabKey: string | null;
  readonly tatMinutes: number | null;
}

interface CatalogueRow {
  readonly record_key: string;
  readonly code: string;
  readonly name: string;
  readonly loinc_code: string | null;
  readonly discipline: string;
  readonly is_panel: boolean;
  readonly is_orderable: boolean;
  readonly is_outsourced_default: boolean;
  readonly referral_lab_key: string | null;
  readonly tat_routine_minutes: number | null;
  readonly tat_urgent_minutes: number | null;
  readonly tat_stat_minutes: number | null;
}

interface OrderRow {
  readonly id: string;
  readonly accession_no: string;
  readonly patient_id: string;
  readonly branch_id: string;
  readonly visit_id: string | null;
  readonly encounter_id: string | null;
  readonly clinical_order_id: string | null;
  readonly source: string;
  readonly priority: string;
  readonly status: string;
  readonly billing_status: string;
  readonly clinical_notes: string | null;
  readonly is_mlc: boolean;
  readonly ordered_at: string;
  readonly cancel_reason: string | null;
}

function toOrderView(
  header: OrderRow,
  tests: readonly LabOrderTestView[],
  samples: readonly LabSampleView[],
): LabOrderView {
  return { ...header, tests, samples };
}
