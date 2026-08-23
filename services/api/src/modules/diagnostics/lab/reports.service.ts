import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ProblemType, newId } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService, type TransactionClient } from '../../../core/db/database.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import { withLabErrors, writeOrderEvent } from './lab.common.js';
import { labEvent } from './lab.events.js';
import type { GenerateReportRequest } from './lab.schemas.js';
import type { LabReportView } from './lab.types.js';

/**
 * OP-004 §3.6 — the report.
 *
 * ── What this service produces, and what it does not ────────────────────────
 *
 * It produces the *record* of a report: which order lines it covers, which
 * version it is, whether the NABL logo may lawfully be printed on it, whether it
 * is confidential, and the token behind the QR verification block. The PDF
 * itself is rendered by `services/worker` from `packages/print-templates` —
 * `CLAUDE.md §2` puts Playwright in the worker, and a request thread that blocks
 * on Chromium is a request thread that will time out under load. `pdf_file_id`
 * is therefore null until the render lands.
 *
 * ── Two rules that are easy to get subtly wrong ─────────────────────────────
 *
 * **The NABL logo is computed once and stored.** `OP-004 §5`: the logo prints
 * only when every test on the report is in accredited scope. Scope changes, and
 * a reprint must look like the original — so the answer is frozen onto the
 * version rather than recomputed at print time.
 *
 * **An order does not close over an open critical.** `OP-004 §5` keeps the order
 * out of `reported` while any critical alert on it is unacknowledged, and
 * `lab.enforce_order_close_criticals()` refuses the transition. The report is
 * still issued and still delivered — what stays open is the follow-up. So this
 * service checks first and leaves the order in `partially_reported` rather than
 * provoking the trigger, because the refusal belongs to the order's status and
 * never to the patient's result.
 */
@Injectable()
export class LabReportsService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  async generate(orderId: string, body: GenerateReportRequest): Promise<LabReportView> {
    const ctx = getContext();

    const reportId = await withLabErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const order = await tx.maybeOne<{
          id: string;
          branch_id: string;
          patient_id: string;
          accession_no: string;
          status: string;
        }>(
          `SELECT id, branch_id, patient_id, accession_no, status::text AS status
             FROM lab.lab_orders WHERE id = $1 FOR UPDATE`,
          [orderId],
        );
        if (order === undefined) throw AppError.notFound('The laboratory order');

        const lines = await tx.rows<{
          id: string;
          test_key: string;
          discipline: string;
          is_outsourced: boolean;
          is_nabl_scope: boolean;
          is_sensitive: boolean;
        }>(
          `SELECT ot.id, ot.test_key, ot.discipline::text AS discipline, ot.is_outsourced,
                  COALESCE(t.is_nabl_scope, false) AS is_nabl_scope,
                  COALESCE(t.is_sensitive, false) AS is_sensitive
             FROM lab.lab_order_tests ot
             LEFT JOIN LATERAL (
               SELECT DISTINCT ON (x.record_key) x.is_nabl_scope, x.is_sensitive
                 FROM mdm.mdm_lab_tests x
                WHERE x.record_key = ot.test_key AND x.status = 'active'
                ORDER BY x.record_key, x.version DESC
             ) t ON true
            WHERE ot.order_id = $1
              AND ot.status = 'authorised'
              AND ($2::text IS NULL OR ot.discipline = $2::mdm."LabDiscipline")`,
          [orderId, body.discipline ?? null],
        );

        if (lines.length === 0) {
          throw new AppError(
            ProblemType.BUSINESS_RULE_VIOLATED,
            'Nothing on this order has been authorised yet. A report is what a signatory has released, and there is nothing released to print.',
          );
        }

        const existing = await tx.maybeOne<{
          id: string;
          report_no: string;
          current_version: number;
        }>(
          `SELECT id, report_no, current_version
             FROM lab.lab_reports
            WHERE order_id = $1 AND discipline IS NOT DISTINCT FROM $2::mdm."LabDiscipline"
            FOR UPDATE`,
          [orderId, body.discipline ?? null],
        );

        if (existing !== undefined && body.amendmentReason === undefined) {
          throw AppError.validation([
            {
              path: 'amendmentReason',
              code: 'amendment_reason_required',
              message:
                'This order already has a report. A second one supersedes the first, and `OP-004 §3.4.3` prints "Amended — supersedes report dated …", so it has to say why.',
            },
          ]);
        }

        const nablLogo = lines.every((l) => l.is_nabl_scope);
        const sensitive = lines.some((l) => l.is_sensitive);
        const outsourced = lines.some((l) => l.is_outsourced);
        const version = (existing?.current_version ?? 0) + 1;
        const type = existing === undefined ? body.type : 'amended';

        let id: string;
        if (existing === undefined) {
          id = newId();
          const suffix = body.discipline === undefined ? 'R' : body.discipline.slice(0, 3).toUpperCase();
          await tx.query(
            `INSERT INTO lab.lab_reports (
               id, hospital_id, branch_id, order_id, patient_id, report_no, type, discipline,
               current_version, current_status, nabl_logo_printed, is_sensitive, contains_outsourced,
               created_by, updated_by, updated_at
             ) VALUES (
               $1, $2, $3, $4, $5, $6, $7::lab."LabReportType", $8::mdm."LabDiscipline",
               $9, 'issued', $10, $11, $12,
               $13, $13, now()
             )`,
            [
              id,
              ctx.hospitalId,
              order.branch_id,
              orderId,
              order.patient_id,
              `${order.accession_no}/${suffix}`,
              type,
              body.discipline ?? null,
              version,
              nablLogo,
              sensitive,
              outsourced,
              ctx.userId,
            ],
          );
        } else {
          id = existing.id;
          await tx.query(
            `UPDATE lab.lab_reports
                SET current_version = $2, current_status = 'issued', type = 'amended',
                    nabl_logo_printed = $3, is_sensitive = $4, contains_outsourced = $5,
                    updated_by = $6, updated_at = now()
              WHERE id = $1`,
            [id, version, nablLogo, sensitive, outsourced, ctx.userId],
          );
          await tx.query(
            `UPDATE lab.lab_report_versions
                SET status = 'superseded'
              WHERE report_id = $1 AND status = 'issued'`,
            [id],
          );
        }

        const signatory = await tx.maybeOne<{ display_name: string; registration_number: string | null }>(
          `SELECT u.display_name,
                  (SELECT p.registration_number
                     FROM mdm.mdm_practitioners p
                    WHERE p.user_id = u.id AND p.status = 'active'
                    ORDER BY p.version DESC LIMIT 1) AS registration_number
             FROM core.users u WHERE u.id = $1`,
          [ctx.userId],
        );

        // The QR verification token is unguessable by construction: a patient
        // holding a printed report should be verifiable, and a stranger holding
        // an accession number should not be able to guess somebody else's.
        const verifyToken = randomBytes(24).toString('base64url');

        await tx.query(
          `INSERT INTO lab.lab_report_versions (
             id, hospital_id, report_id, version, status, verify_token,
             signed_by, signatory_names, signatory_registration_nos, sign_method,
             issued_at, amendment_reason, supersedes_version, order_test_ids, created_by
           ) VALUES (
             $1, $2, $3, $4, 'issued', $5,
             $6::uuid[], $7::text[], $8::text[], 'system'::clinical."SignMethod",
             now(), $9, $10, $11::uuid[], $12
           )`,
          [
            newId(),
            ctx.hospitalId,
            id,
            version,
            verifyToken,
            ctx.userId === null ? [] : [ctx.userId],
            signatory === undefined ? [] : [signatory.display_name],
            signatory?.registration_number == null ? [] : [signatory.registration_number],
            body.amendmentReason ?? null,
            existing === undefined ? null : existing.current_version,
            lines.map((l) => l.id),
            ctx.userId,
          ],
        );

        await this.closeOrder(tx, orderId, order.status);
        await writeOrderEvent(tx, { orderId, to: `report_v${version}` });

        await this.audit.write(tx, {
          action: 'sign',
          entity: 'lab.lab_reports',
          rowId: id,
          businessKey: order.accession_no,
          dataClass: 'phi',
          patientId: order.patient_id,
          before: existing === undefined ? null : { version: existing.current_version },
          after: { version, nabl_logo_printed: nablLogo, is_sensitive: sensitive, lines: lines.length },
          sensitivity: sensitive ? 'sensitive' : 'normal',
          ...(body.amendmentReason === undefined ? {} : { reasonText: body.amendmentReason }),
        });

        await this.outbox.publish(
          tx,
          labEvent('lab.report.generated', id, {
            reportId: id,
            orderId,
            patientId: order.patient_id,
            version,
            accreditedScope: nablLogo,
            generatedAt: new Date().toISOString(),
          }),
        );

        return id;
      }),
    );

    return this.get(reportId);
  }

  async get(id: string): Promise<LabReportView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const row = await tx.maybeOne<LabReportView>(
        `SELECT r.id, r.order_id, r.patient_id, r.report_no, r.type::text AS type,
                r.discipline::text AS discipline, r.current_version,
                r.current_status::text AS current_status, r.nabl_logo_printed,
                r.is_sensitive, r.contains_outsourced,
                v.order_test_ids, v.verify_token, v.amendment_reason, v.issued_at::text AS issued_at
           FROM lab.lab_reports r
           JOIN lab.lab_report_versions v ON v.report_id = r.id AND v.version = r.current_version
          WHERE r.id = $1`,
        [id],
      );
      if (row === undefined) throw AppError.notFound('The report');
      return row;
    });
  }

  /**
   * `OP-004 §5` — the order reaches `reported` only when every live line is
   * authorised **and** no critical alert on it is still outstanding.
   *
   * The second half is also a database trigger, and it would raise. Checking
   * here means the ordinary case — a report issued while somebody is still
   * trying to reach the ward — leaves the order in `partially_reported` and the
   * report on the patient's file, rather than failing the whole request. The
   * trigger stays as the backstop for anything that reaches the table another
   * way.
   */
  private async closeOrder(tx: TransactionClient, orderId: string, currentStatus: string): Promise<void> {
    if (['cancelled', 'reported'].includes(currentStatus)) return;

    const counts = await tx.one<{ outstanding_lines: number; open_criticals: number }>(
      `SELECT
         (SELECT count(*)::int FROM lab.lab_order_tests ot
           WHERE ot.order_id = $1 AND ot.status NOT IN ('authorised', 'cancelled')) AS outstanding_lines,
         (SELECT count(*)::int FROM lab.lab_critical_value_alerts a
           WHERE a.order_id = $1 AND a.status IN ('open', 'communicated', 'escalated')) AS open_criticals`,
      [orderId],
    );

    const next =
      counts.outstanding_lines === 0 && counts.open_criticals === 0 ? 'reported' : 'partially_reported';

    await tx.query(
      `UPDATE lab.lab_orders
          SET status = $2::lab."LabOrderStatus",
              first_reported_at = COALESCE(first_reported_at, now()),
              final_reported_at = CASE WHEN $2 = 'reported' THEN now() ELSE final_reported_at END,
              updated_at = now(), version = version + 1
        WHERE id = $1`,
      [orderId, next],
    );
  }
}
