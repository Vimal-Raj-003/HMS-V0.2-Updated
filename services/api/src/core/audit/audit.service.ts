import { Injectable } from '@nestjs/common';
import { newId, type AuditWriteInput } from '@vims/contracts';
import { getContext } from '../context/request-context.js';
import type { TransactionClient } from '../db/database.service.js';

/**
 * The audit writer — part of step 8, inside the caller's transaction.
 *
 * `EN-024` §5 makes an audit failure roll back the clinical mutation it
 * describes. That is why `write` takes the *caller's* transaction client rather
 * than opening its own: a separate connection could commit the change and fail
 * the audit, leaving a clinical record altered with nobody attached to it. In a
 * medico-legal enquiry that is indistinguishable from tampering.
 *
 * `seq`, `prev_hash` and `row_hash` are left NULL here deliberately. The chain is
 * sealed asynchronously by `core.seal_audit_chain()` (decision D-16): assigning a
 * gapless per-hospital sequence inline needs a row lock held until commit, so one
 * slow clinical transaction would block every other audit write for that hospital
 * — which, because an audit failure rolls back the mutation, becomes a nurse
 * unable to chart.
 *
 * The input type is `AuditWriteInput` from `packages/contracts` rather than a
 * shape invented here, so the API, the workers and the integration hub all
 * produce rows the same investigator can read.
 */
@Injectable()
export class AuditService {
  async write(tx: TransactionClient, entry: AuditWriteInput): Promise<string> {
    const ctx = getContext();
    const id = newId();

    await tx.query(
      `INSERT INTO core.audit_log (
         id, hospital_id, branch_id, occurred_at, recorded_at,
         actor_user_id, actor_type, actor_role, impersonator_user_id,
         session_id, request_id, trace_id, ip, user_agent,
         entity, row_id, business_key, action,
         patient_id, encounter_id,
         before, after,
         reason_code, reason_text,
         data_class, sensitivity, result, denial_reason,
         api_route, row_count, artifact_sha256
       ) VALUES (
         $1, $2, $3, now(), now(),
         $4, $5, $6, $7,
         $8, $9, $10, $11::inet, $12,
         $13, $14, $15, $16::core."AuditActionType",
         $17, $18,
         $19::jsonb, $20::jsonb,
         $21, $22,
         $23::core."AuditDataClass", $24::core."AuditSensitivity", $25::core."AuditResult", $26,
         $27, $28, $29
       )`,
      [
        id,
        ctx.hospitalId,
        ctx.branchId,
        ctx.userId,
        ctx.userId === null ? 'system' : 'user',
        ctx.roleKeys[0] ?? null,
        ctx.impersonatorUserId,
        ctx.sessionId,
        ctx.requestId,
        ctx.traceId,
        ctx.ip,
        ctx.userAgent,
        entry.entity,
        entry.rowId,
        entry.businessKey,
        entry.action,
        entry.patientId ?? null,
        entry.encounterId ?? null,
        entry.before === null ? null : JSON.stringify(entry.before),
        entry.after === null ? null : JSON.stringify(entry.after),
        entry.reasonCode ?? null,
        entry.reasonText ?? ctx.reason,
        entry.dataClass,
        entry.sensitivity ?? 'normal',
        entry.result ?? 'success',
        entry.denialReason ?? null,
        ctx.route,
        entry.rowCount ?? null,
        entry.artifactSha256 ?? null,
      ],
    );

    return id;
  }
}
