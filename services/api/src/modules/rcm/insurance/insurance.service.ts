import { Inject, Injectable } from '@nestjs/common';
import { newId, type Page } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService, type TransactionClient } from '../../../core/db/database.service.js';
import { NumberingService } from '../../../core/numbering/numbering.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import { insuranceEvent } from './insurance.events.js';
import type {
  CapturePolicyRequest,
  CaseQuery,
  CreatePayerRequest,
  CreatePreauthRequest,
  OpenCaseRequest,
  PayerQuery,
  PreauthListQuery,
  RaiseQueryRequest,
  RecordDecisionRequest,
  ReplyQueryRequest,
  SubmitPreauthRequest,
  WithdrawPreauthRequest,
} from './insurance.schemas.js';
import type {
  InsCaseView,
  PayerView,
  PolicyView,
  PreauthDetailView,
  PreauthQueryView,
  PreauthView,
} from './insurance.types.js';

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
function asDay(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString().slice(0, 10) : asText(v);
}

/**
 * EN-002 + RC-002 — insurance, TPA and pre-authorisation.
 *
 * ── Two people, never one ───────────────────────────────────────────────────
 *
 * `submit` and `recordDecision` are separate keys held by separate roles with a
 * `block` rule between them. The reason is specific rather than procedural: a
 * recorded approval immediately becomes a credit limit that billing honours and
 * a ward acts on. If the person waiting for the payer could also type in what
 * the payer said, an approval that never arrived would be indistinguishable from
 * one that did — until the claim is refused, months later, with the patient long
 * discharged and the money unrecoverable.
 *
 * ── The clock is the product ────────────────────────────────────────────────
 *
 * `submit` writes a `preauth_sla_events` row with the decision deadline, and a
 * payer query stops our clock and starts theirs. A missed deadline is not a
 * report somebody runs; it raises `preauth.sla.breached`, because the moment it
 * passes is the moment a cashless admission quietly becomes a reimbursement one
 * the family has to fund themselves.
 *
 * ── Every transition is written down, and cannot be rewritten ───────────────
 *
 * `preauth_status_history` is append-only at the database level. When a payer
 * disputes what was sent and when — routine in this business — that table is the
 * hospital's evidence, and evidence that could have been edited is not evidence.
 */
@Injectable()
export class InsuranceService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(NumberingService) private readonly numbering: NumberingService,
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

  /** Every transition, append-only. The hospital's evidence in a payer dispute. */
  private async recordTransition(
    tx: TransactionClient,
    requestId: string,
    from: string | null,
    to: string,
    reason: string | null,
    actorType: 'staff' | 'payer' | 'system' = 'staff',
  ): Promise<void> {
    await tx.query(
      `INSERT INTO billing.preauth_status_history
         (id, hospital_id, request_id, from_status, to_status, actor_id, actor_type, at, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now(),$8)`,
      [newId(), this.hospitalId(), requestId, from, to, this.actorId(), actorType, reason],
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Masters
  // ═══════════════════════════════════════════════════════════════════════════

  async listPayers(query: PayerQuery): Promise<Page<PayerView>> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM billing.ins_payers
          WHERE hospital_id = $1 AND ($2::text IS NULL OR payer_type::text = $2)
          ORDER BY name LIMIT $3`,
        [this.hospitalId(), query.payerType ?? null, query.limit + 1],
      );
      const page = rows.slice(0, query.limit);
      return {
        items: page.map((r) => ({
          id: asText(r['id']),
          code: asText(r['code']),
          name: asText(r['name']),
          payerType: asText(r['payer_type']),
          irdaiRegNo: asTextOrNull(r['irdai_reg_no']),
          portalUrl: asTextOrNull(r['portal_url']),
          active: Boolean(r['active']),
        })),
        nextCursor: null,
        hasMore: rows.length > query.limit,
      };
    });
  }

  async createPayer(body: CreatePayerRequest): Promise<PayerView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const id = newId();
      await tx.query(
        `INSERT INTO billing.ins_payers
           (id, hospital_id, code, name, payer_type, irdai_reg_no, portal_url,
            created_at, created_by, updated_at, updated_by)
         VALUES ($1,$2,$3,$4,$5::"billing"."InsPayerType",$6,$7, now(),$8, now(),$8)`,
        [
          id,
          this.hospitalId(),
          body.code,
          body.name,
          body.payerType,
          body.irdaiRegNo ?? null,
          body.portalUrl ?? null,
          this.actorId(),
        ],
      );
      return {
        id,
        code: body.code,
        name: body.name,
        payerType: body.payerType,
        irdaiRegNo: body.irdaiRegNo ?? null,
        portalUrl: body.portalUrl ?? null,
        active: true,
      };
    });
  }

  async capturePolicy(body: CapturePolicyRequest): Promise<PolicyView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const id = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO billing.ins_patient_policies
           (id, hospital_id, patient_id, payer_id, tpa_id, plan_id, policy_no, member_id,
            holder_name, relationship, sum_insured, remaining_si, valid_from, valid_to,
            created_at, created_by, updated_at, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12::date,$13::date, now(),$14, now(),$14)
         RETURNING *`,
        [
          id,
          this.hospitalId(),
          body.patientId,
          body.payerId,
          body.tpaId ?? null,
          body.planId ?? null,
          body.policyNo,
          body.memberId ?? null,
          body.holderName ?? null,
          body.relationship ?? null,
          body.sumInsured === undefined ? null : body.sumInsured.toFixed(2),
          body.validFrom ?? null,
          body.validTo ?? null,
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The policy could not be captured.');
      return this.toPolicy(row);
    });
  }

  private toPolicy(r: Record<string, unknown>): PolicyView {
    return {
      id: asText(r['id']),
      patientId: asText(r['patient_id']),
      payerId: asText(r['payer_id']),
      policyNo: asText(r['policy_no']),
      memberId: asTextOrNull(r['member_id']),
      holderName: asTextOrNull(r['holder_name']),
      sumInsured: asTextOrNull(r['sum_insured']),
      remainingSi: asTextOrNull(r['remaining_si']),
      validFrom: asDay(r['valid_from']),
      validTo: asDay(r['valid_to']),
      verifiedStatus: asTextOrNull(r['verified_status']),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Cases
  // ═══════════════════════════════════════════════════════════════════════════

  async openCase(body: OpenCaseRequest): Promise<InsCaseView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const id = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO billing.ins_cases
           (id, hospital_id, branch_id, encounter_id, admission_id, patient_id,
            policy_id, payer_id, tpa_id, mode, priority, status,
            created_at, created_by, updated_at, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::"billing"."InsCaseMode",$11,'open',
                 now(),$12, now(),$12)
         RETURNING *, (SELECT name FROM billing.ins_payers WHERE id = $8) AS payer_name`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.encounterId ?? null,
          body.admissionId ?? null,
          body.patientId,
          body.policyId ?? null,
          body.payerId,
          body.tpaId ?? null,
          body.mode,
          body.priority,
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The case could not be opened.');

      await this.outbox.publish(
        tx,
        insuranceEvent('insurance.case.opened', id, {
          caseId: id,
          patientId: body.patientId,
          payerId: body.payerId,
          mode: body.mode,
          encounterId: body.encounterId ?? null,
        }),
      );
      return this.toCase(row);
    });
  }

  private toCase(r: Record<string, unknown>): InsCaseView {
    return {
      id: asText(r['id']),
      patientId: asText(r['patient_id']),
      payerId: asText(r['payer_id']),
      payerName: asTextOrNull(r['payer_name']),
      policyId: asTextOrNull(r['policy_id']),
      mode: asText(r['mode']),
      status: asText(r['status']),
      priority: asNumber(r['priority']),
      approvedAmountTotal: asText(r['approved_amount_total']),
      createdAt: asText(r['created_at']),
    };
  }

  async listCases(query: CaseQuery): Promise<Page<InsCaseView>> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT c.*, p.name AS payer_name
           FROM billing.ins_cases c
           LEFT JOIN billing.ins_payers p ON p.id = c.payer_id
          WHERE c.hospital_id = $1
            AND ($2::text IS NULL OR c.status::text = $2)
            AND ($3::uuid IS NULL OR c.patient_id = $3)
          ORDER BY c.priority DESC, c.created_at DESC LIMIT $4`,
        [this.hospitalId(), query.status ?? null, query.patientId ?? null, query.limit + 1],
      );
      const page = rows.slice(0, query.limit);
      return {
        items: page.map((r) => this.toCase(r)),
        nextCursor: null,
        hasMore: rows.length > query.limit,
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Pre-authorisation
  // ═══════════════════════════════════════════════════════════════════════════

  async createPreauth(body: CreatePreauthRequest): Promise<PreauthView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const hospital = this.hospitalId();
      const branch = this.branchId();

      const { rows: cases } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM billing.ins_cases WHERE id = $1 AND hospital_id = $2`,
        [body.caseId, hospital],
      );
      const insCase = cases[0];
      if (insCase === undefined) throw AppError.notFound('Insurance case');

      const id = newId();
      const allocation = await this.numbering.allocate(tx, {
        key: 'BILL_OP',
        branchId: branch,
        refType: 'preauth',
        refId: id,
      });

      const { rows: seq } = await tx.query<{ n: string }>(
        `SELECT COALESCE(max(sequence_no), 0) + 1 AS n FROM billing.preauth_requests WHERE case_id = $1`,
        [body.caseId],
      );

      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO billing.preauth_requests
           (id, hospital_id, branch_id, case_id, encounter_id, patient_id, payer_id, tpa_id,
            policy_id, preauth_no, type, sequence_no, parent_request_id, status, is_emergency,
            diagnosis_codes, procedure_codes, requested_amount, channel, doctor_id,
            created_at, created_by, updated_at, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,
                 $9,$10,$11::"billing"."PreauthType",$12,$13,'draft',$14,
                 $15,$16,$17,$18::"billing"."PreauthChannel",$19,
                 now(),$20, now(),$20)
         RETURNING *`,
        [
          id,
          hospital,
          branch,
          body.caseId,
          insCase['encounter_id'] ?? null,
          asText(insCase['patient_id']),
          asText(insCase['payer_id']),
          insCase['tpa_id'] ?? null,
          insCase['policy_id'] ?? null,
          allocation.formatted,
          body.type,
          asNumber(seq[0]?.n ?? 1),
          body.parentRequestId ?? null,
          body.isEmergency,
          body.diagnosisCodes,
          body.procedureCodes,
          body.requestedAmount.toFixed(2),
          body.channel,
          body.doctorId ?? null,
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The pre-authorisation could not be created.');

      await this.recordTransition(tx, id, null, 'draft', 'Request assembled');
      return this.toPreauth(row, 0);
    });
  }

  private toPreauth(r: Record<string, unknown>, openQueries: number): PreauthView {
    return {
      id: asText(r['id']),
      preauthNo: asText(r['preauth_no']),
      caseId: asText(r['case_id']),
      patientId: asText(r['patient_id']),
      type: asText(r['type']),
      status: asText(r['status']),
      isEmergency: Boolean(r['is_emergency']),
      requestedAmount: asText(r['requested_amount']),
      approvedAmount: asTextOrNull(r['approved_amount']),
      approvedLosDays: r['approved_los_days'] === null ? null : asNumber(r['approved_los_days']),
      validTill: asDay(r['valid_till']),
      payerRefNo: asTextOrNull(r['payer_ref_no']),
      denialReasonCode: asTextOrNull(r['denial_reason_code']),
      channel: asText(r['channel']),
      submittedAt: asTextOrNull(r['submitted_at']),
      decidedAt: asTextOrNull(r['decided_at']),
      decisionDueAt: asTextOrNull(r['decision_due_at']),
      slaBreached: Boolean(r['sla_breached']),
      openQueries,
    };
  }

  /**
   * Submit, and start the decision clock.
   *
   * The SLA row is written here rather than by a scheduler, so a request that
   * was submitted always has a deadline attached to it — a clock that only
   * exists if a background job ran is a clock that silently does not exist.
   */
  async submitPreauth(id: string, body: SubmitPreauthRequest): Promise<PreauthView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const hospital = this.hospitalId();
      const dueAt = new Date(Date.now() + body.decisionHours * 3_600_000).toISOString();

      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE billing.preauth_requests
            SET status = 'submitted', submitted_at = now(), decision_due_at = $3::timestamptz,
                updated_at = now(), updated_by = $4
          WHERE id = $1 AND hospital_id = $2 AND status IN ('draft','ready','pending_signature')
          RETURNING *`,
        [id, hospital, dueAt, this.actorId()],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict('Only a draft or ready pre-authorisation can be submitted.');
      }

      await tx.query(
        `INSERT INTO billing.preauth_sla_events (id, hospital_id, request_id, stage, due_at, created_at)
         VALUES ($1,$2,$3,'decision',$4::timestamptz, now())
         ON CONFLICT (request_id, stage) DO UPDATE SET due_at = EXCLUDED.due_at`,
        [newId(), hospital, id, dueAt],
      );

      await tx.query(
        `INSERT INTO billing.preauth_transmissions
           (id, hospital_id, request_id, attempt_no, channel, status, sent_at)
         VALUES ($1,$2,$3,
                 (SELECT COALESCE(max(attempt_no),0)+1 FROM billing.preauth_transmissions WHERE request_id = $3),
                 $4::"billing"."PreauthChannel",'sent', now())`,
        [newId(), hospital, id, asText(row['channel'])],
      );

      await this.recordTransition(tx, id, 'draft', 'submitted', body.reason);
      await this.outbox.publish(
        tx,
        insuranceEvent('preauth.submitted', id, {
          requestId: id,
          preauthNo: asText(row['preauth_no']),
          caseId: asText(row['case_id']),
          patientId: asText(row['patient_id']),
          requestedAmount: asText(row['requested_amount']),
          channel: asText(row['channel']),
          decisionDueAt: dueAt,
        }),
      );
      await tx.query(
        `UPDATE billing.ins_cases SET status = 'preauth_pending', updated_at = now() WHERE id = $1`,
        [asText(row['case_id'])],
      );

      return this.toPreauth(row, 0);
    });
  }

  /**
   * Record what the payer decided.
   *
   * A different key from `submit`, held by a different role — see the class
   * note. On an approval this also propagates the credit limit, because an
   * approval billing never heard about is one the ward acts on and the biller
   * does not.
   */
  async recordDecision(id: string, body: RecordDecisionRequest): Promise<PreauthView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const hospital = this.hospitalId();

      const { rows: before } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM billing.preauth_requests WHERE id = $1 AND hospital_id = $2 FOR UPDATE`,
        [id, hospital],
      );
      const prior = before[0];
      if (prior === undefined) throw AppError.notFound('Pre-authorisation');
      const fromStatus = asText(prior['status']);
      if (!['submitted', 'query_raised', 'query_replied'].includes(fromStatus)) {
        throw AppError.conflict(`A pre-authorisation in status "${fromStatus}" has no decision outstanding.`);
      }

      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE billing.preauth_requests
            SET status = $3::"billing"."PreauthStatus",
                -- Both casts are explicit: reusing $4 in a bare assignment and
                -- inside COALESCE makes Postgres deduce numeric from one and
                -- integer from the other, and it refuses the statement.
                approved_amount = $4::numeric,
                approved_amount_total = COALESCE($4::numeric, 0),
                approved_room_class_id = $5,
                approved_los_days = $6,
                valid_from = $7::date,
                valid_till = $8::date,
                payer_ref_no = $9,
                denial_reason_code = $10,
                decided_at = now(), updated_at = now(), updated_by = $11
          WHERE id = $1 AND hospital_id = $2
          RETURNING *`,
        [
          id,
          hospital,
          body.status,
          body.approvedAmount === undefined ? null : body.approvedAmount.toFixed(2),
          body.approvedRoomClassId ?? null,
          body.approvedLosDays ?? null,
          body.validFrom ?? null,
          body.validTill ?? null,
          body.payerRefNo ?? null,
          body.denialReasonCode ?? null,
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The decision could not be recorded.');

      // `payer` on the transition: this is what the insurer said, not what we
      // decided, and an audit must be able to tell those apart.
      await this.recordTransition(tx, id, fromStatus, body.status, body.reason, 'payer');

      if (body.status !== 'denied' && body.approvedAmount !== undefined) {
        await tx.query(
          `INSERT INTO billing.preauth_credit_limits
             (id, hospital_id, request_id, admission_id, approved_amount, valid_till,
              room_class_id, propagated_at)
           VALUES ($1,$2,$3,$4,$5,$6::date,$7, now())`,
          [
            newId(),
            hospital,
            id,
            prior['admission_id'] ?? null,
            body.approvedAmount.toFixed(2),
            body.validTill ?? null,
            body.approvedRoomClassId ?? null,
          ],
        );
        await this.outbox.publish(
          tx,
          insuranceEvent('preauth.credit_limit.propagated', id, {
            requestId: id,
            admissionId: asTextOrNull(prior['admission_id']),
            approvedAmount: body.approvedAmount.toFixed(2),
            validTill: body.validTill ?? null,
          }),
        );
        await tx.query(
          `UPDATE billing.ins_cases
              SET status = 'preauth_approved',
                  approved_amount_total = approved_amount_total + $2,
                  updated_at = now()
            WHERE id = $1`,
          [asText(row['case_id']), body.approvedAmount.toFixed(2)],
        );
      } else {
        await tx.query(
          `UPDATE billing.ins_cases SET status = 'preauth_denied', updated_at = now() WHERE id = $1`,
          [asText(row['case_id'])],
        );
      }

      await this.outbox.publish(
        tx,
        insuranceEvent('preauth.decided', id, {
          requestId: id,
          preauthNo: asText(row['preauth_no']),
          caseId: asText(row['case_id']),
          status: body.status,
          approvedAmount: body.approvedAmount === undefined ? null : body.approvedAmount.toFixed(2),
          approvedRoomClassId: body.approvedRoomClassId ?? null,
          validTill: body.validTill ?? null,
          denialReasonCode: body.denialReasonCode ?? null,
        }),
      );
      await this.audit.write(tx, {
        action: 'update',
        entity: 'billing.preauth_requests',
        rowId: id,
        businessKey: asText(row['preauth_no']),
        dataClass: 'financial',
        reasonText: body.reason,
        before: { status: fromStatus },
        after: { status: body.status, approved_amount: body.approvedAmount ?? null },
      });

      return this.toPreauth(row, 0);
    });
  }

  /** A payer query stops our clock and starts theirs. */
  async raiseQuery(requestId: string, body: RaiseQueryRequest): Promise<PreauthQueryView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const hospital = this.hospitalId();
      const id = newId();
      const slaDueAt = new Date(Date.now() + body.slaHours * 3_600_000).toISOString();

      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO billing.preauth_queries
           (id, hospital_id, request_id, query_no, direction, category, text,
            sla_due_at, is_open, created_at, updated_at)
         VALUES ($1,$2,$3,
                 (SELECT COALESCE(max(query_no),0)+1 FROM billing.preauth_queries WHERE request_id = $3),
                 'inbound',$4,$5,$6::timestamptz,true, now(), now())
         RETURNING *`,
        [id, hospital, requestId, body.category, body.text, slaDueAt],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The query could not be recorded.');

      await tx.query(
        `UPDATE billing.preauth_requests SET status = 'query_raised', updated_at = now() WHERE id = $1`,
        [requestId],
      );
      await this.recordTransition(tx, requestId, 'submitted', 'query_raised', body.text, 'payer');

      await this.outbox.publish(
        tx,
        insuranceEvent('preauth.query.raised', id, {
          queryId: id,
          requestId,
          queryNo: asNumber(row['query_no']),
          category: body.category,
          slaDueAt,
        }),
      );
      return this.toQuery(row);
    });
  }

  async replyQuery(id: string, body: ReplyQueryRequest): Promise<PreauthQueryView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE billing.preauth_queries
            SET reply_text = $3, replied_at = now(), replied_by = $4, is_open = false, updated_at = now()
          WHERE id = $1 AND hospital_id = $2 AND is_open = true
          RETURNING *`,
        [id, this.hospitalId(), body.replyText, this.actorId()],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('Only an open query can be answered.');

      const requestId = asText(row['request_id']);
      await tx.query(
        `UPDATE billing.preauth_requests SET status = 'query_replied', updated_at = now() WHERE id = $1`,
        [requestId],
      );
      await this.recordTransition(tx, requestId, 'query_raised', 'query_replied', body.replyText);
      return this.toQuery(row);
    });
  }

  private toQuery(r: Record<string, unknown>): PreauthQueryView {
    return {
      id: asText(r['id']),
      queryNo: asNumber(r['query_no']),
      category: asText(r['category']),
      text: asText(r['text']),
      raisedAt: asText(r['raised_at']),
      slaDueAt: asTextOrNull(r['sla_due_at']),
      repliedAt: asTextOrNull(r['replied_at']),
      replyText: asTextOrNull(r['reply_text']),
      isOpen: Boolean(r['is_open']),
    };
  }

  async listPreauths(query: PreauthListQuery): Promise<Page<PreauthView>> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT r.*,
                (SELECT count(*) FROM billing.preauth_queries q
                  WHERE q.request_id = r.id AND q.is_open) AS open_queries,
                (r.decision_due_at IS NOT NULL AND r.decided_at IS NULL AND r.decision_due_at < now())
                  AS clock_expired
           FROM billing.preauth_requests r
          WHERE r.hospital_id = $1
            AND ($2::text IS NULL OR r.status::text = $2)
            AND ($3::uuid IS NULL OR r.case_id = $3)
          ORDER BY r.decision_due_at NULLS LAST, r.created_at DESC
          LIMIT $4`,
        [this.hospitalId(), query.status ?? null, query.caseId ?? null, query.limit + 1],
      );
      const page = rows.slice(0, query.limit);
      return {
        items: page.map((r) => ({
          ...this.toPreauth(r, asNumber(r['open_queries'] ?? 0)),
          // Computed rather than stored: the clock expires with the passage of
          // time, and a stored flag is only true after something ran.
          slaBreached: Boolean(r['clock_expired']) || Boolean(r['sla_breached']),
        })),
        nextCursor: null,
        hasMore: rows.length > query.limit,
      };
    });
  }

  async getPreauth(id: string): Promise<PreauthDetailView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT r.*,
                (r.decision_due_at IS NOT NULL AND r.decided_at IS NULL AND r.decision_due_at < now())
                  AS clock_expired
           FROM billing.preauth_requests r WHERE r.id = $1 AND r.hospital_id = $2`,
        [id, this.hospitalId()],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.notFound('Pre-authorisation');

      const { rows: queries } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM billing.preauth_queries WHERE request_id = $1 ORDER BY query_no`,
        [id],
      );
      const { rows: history } = await tx.query<Record<string, unknown>>(
        `SELECT to_status, actor_type, at, reason FROM billing.preauth_status_history
          WHERE request_id = $1 ORDER BY at`,
        [id],
      );

      return {
        ...this.toPreauth(row, queries.filter((q) => Boolean(q['is_open'])).length),
        slaBreached: Boolean(row['clock_expired']) || Boolean(row['sla_breached']),
        queries: queries.map((q) => this.toQuery(q)),
        history: history.map((h) => ({
          toStatus: asText(h['to_status']),
          actorType: asText(h['actor_type']),
          at: asText(h['at']),
          reason: asTextOrNull(h['reason']),
        })),
      };
    });
  }

  async withdrawPreauth(id: string, body: WithdrawPreauthRequest): Promise<PreauthView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE billing.preauth_requests
            SET status = 'withdrawn', updated_at = now(), updated_by = $3
          WHERE id = $1 AND hospital_id = $2
            AND status IN ('submitted','query_raised','query_replied','draft','ready')
          RETURNING *`,
        [id, this.hospitalId(), this.actorId()],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict('Only an undecided pre-authorisation can be withdrawn.');
      }
      await this.recordTransition(tx, id, null, 'withdrawn', body.reason);
      return this.toPreauth(row, 0);
    });
  }
}
