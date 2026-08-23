import { Inject, Injectable } from '@nestjs/common';
import { ProblemType, newId } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService, type TransactionClient } from '../../../core/db/database.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { PolicyService } from '../../../core/policy/policy.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import { actorId, toNumber, withLabErrors } from './lab.common.js';
import { labEvent } from './lab.events.js';
import type { QcActionRequest, QcRunRequest, QcStateQuery, QcUnlockRequest } from './lab.schemas.js';
import type { LabQcRunView, LabQcStateView } from './lab.types.js';
import { evaluateWestgard, type WestgardRuleConfig } from './westgard.js';

/**
 * EN-031 §3.1–§3.3 — internal quality control, and the release gate it drives.
 *
 * ── `never_evaluated` is not `passed` ───────────────────────────────────────
 *
 * `docs/prompts/phase-03 §Non-negotiables 3` puts it plainly, and the schema
 * makes it structural: `lab.labq_analyte_qc_state.state` defaults to
 * `never_evaluated`, `lab.qc_permits_release()` is an explicit whitelist that
 * answers false for it, and `lab.qc_state_for()` returns `never_evaluated` when
 * there is no row at all. There is no reading under which "we have no
 * information" becomes "it is fine".
 *
 * This service therefore never computes releasability. It records QC runs,
 * evaluates the Westgard rules the laboratory configured, and *moves the state* —
 * the gate itself is a database function, called by a database trigger, in one
 * place.
 *
 * ── The one lawful route past a closed gate ─────────────────────────────────
 *
 * `EN-031 §5` allows exactly one exception: a Lab Director records a
 * `labq_qc_actions` row with `patient_impact = released_with_authorisation`, an
 * authoriser and a written reason, and that row is named on the result version
 * being released. It is audited and reported to management monthly.
 *
 * It is surfaced as what it is — `labq.qc.release_override`, a `sensitiveGrant`
 * key with step-up and a mandatory reason — and never as a retry. A laboratory
 * that learns it can click again until the result goes out has no gate at all.
 */
@Injectable()
export class LabQcService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(PolicyService) private readonly policy: PolicyService,
  ) {}

  /**
   * The blocked-analyte dashboard. `permits_release` is computed by
   * `lab.qc_permits_release()` rather than re-derived here, so the screen and
   * the trigger can never disagree about what is releasable.
   */
  async state(query: QcStateQuery): Promise<{ readonly items: readonly LabQcStateView[] }> {
    const items = await this.db.withTenant(currentTenantContext(), async (tx) =>
      tx.rows<LabQcStateView>(
        `SELECT s.id, s.instrument_id, s.test_key, s.parameter_key, s.state::text AS state,
                lab.qc_permits_release(s.state) AS permits_release,
                s.last_evaluated_at::text AS last_evaluated_at,
                s.next_due_at::text AS next_due_at, s.reason, s.active_lockout_id
           FROM lab.labq_analyte_qc_state s
          WHERE ($1::uuid IS NULL OR s.instrument_id = $1::uuid)
            AND ($2::uuid IS NULL OR s.test_key = $2::uuid)
          ORDER BY s.state, s.last_evaluated_at DESC NULLS FIRST
          LIMIT $3`,
        [query.instrumentId ?? null, query.testKey ?? null, query.limit],
      ),
    );
    return { items };
  }

  /**
   * `EN-031 §3.1` — one control point, its Westgard evaluation, and whatever
   * that does to the analyte's state.
   *
   * A voided point stays on the chart but is not evidence, so the series this
   * reads excludes voided runs. `EN-031 §5` forbids deleting one entirely, and
   * §D revokes DELETE, so voiding is the only way out.
   */
  async recordRun(body: QcRunRequest): Promise<LabQcRunView> {
    const ctx = getContext();

    const runId = await withLabErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const instrument = await tx.maybeOne<{ id: string; branch_id: string; code: string }>(
          `SELECT id, branch_id, code FROM integration.lab_instruments WHERE id = $1`,
          [body.instrumentId],
        );
        if (instrument === undefined) throw AppError.notFound('The instrument');

        const material = await tx.maybeOne<{ id: string; lot_no: string; status: string }>(
          `SELECT id, lot_no, status FROM lab.labq_qc_materials WHERE id = $1`,
          [body.qcMaterialId],
        );
        if (material === undefined) throw AppError.notFound('The control material');
        if (material.status !== 'active') {
          throw new AppError(
            ProblemType.BUSINESS_RULE_VIOLATED,
            `That control lot is ${material.status}. A control that is expired, exhausted or quarantined is not a control, and a run against it proves nothing.`,
          );
        }

        // The target in force at this moment. `EN-031 §5` keeps targets
        // effective-dated and never edited in place, so a chart redrawn after a
        // target change still shows the z-scores that were computed.
        const target = await tx.maybeOne<{ id: string; mean: string; sd: string }>(
          `SELECT id, mean::text AS mean, sd::text AS sd
             FROM lab.labq_qc_targets
            WHERE qc_material_id = $1 AND test_key = $2
              AND parameter_key IS NOT DISTINCT FROM $3
              AND instrument_id = $4
              AND effective_from <= now()
              AND (effective_to IS NULL OR effective_to > now())
            ORDER BY effective_from DESC
            LIMIT 1`,
          [body.qcMaterialId, body.testKey, body.parameterKey ?? null, body.instrumentId],
        );
        if (target === undefined) {
          throw new AppError(
            ProblemType.BUSINESS_RULE_VIOLATED,
            'This analyte has no QC target in force for that lot and instrument. Without a mean and an SD there is no z-score, and without a z-score no Westgard rule can be evaluated — so the run would prove nothing while looking like it did.',
          );
        }

        const mean = Number(target.mean);
        const sd = Number(target.sd);
        const z = (body.value - mean) / sd;

        const rules = await this.rulesFor(tx, body.instrumentId, body.testKey, body.parameterKey ?? null);
        const series = await this.seriesFor(tx, body, z);
        const peers = await this.peersFor(tx, body);

        const outcome = evaluateWestgard({ rules, series, peers });
        const status = outcome.rejected ? 'out_of_control' : outcome.warned ? 'warning' : 'in_control';

        const id = newId();
        await tx.query(
          `INSERT INTO lab.labq_qc_runs (
             id, hospital_id, branch_id, instrument_id, test_key, parameter_key, qc_material_id,
             level, target_id, value, unit, z_score, target_mean, target_sd, run_no,
             operator_id, entry_mode, reagent_lot, status, violated_rules, has_rejection,
             comment, run_at, created_by
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7,
             $8::lab."LabQcLevel", $9, $10, $11, $12, $13, $14, $15,
             $16, 'manual', $17, $18::lab."LabQcRunStatus", $19::text[], $20,
             $21, now(), $16
           )`,
          [
            id,
            ctx.hospitalId,
            instrument.branch_id,
            body.instrumentId,
            body.testKey,
            body.parameterKey ?? null,
            body.qcMaterialId,
            body.level,
            target.id,
            body.value,
            body.unit ?? null,
            z,
            mean,
            sd,
            body.runNo ?? null,
            ctx.userId,
            body.reagentLot ?? null,
            status,
            outcome.violated,
            outcome.rejected,
            body.comment ?? null,
          ],
        );

        let lockoutId: string | null = null;
        if (outcome.rejected) {
          lockoutId = newId();
          await tx.query(
            `INSERT INTO lab.labq_qc_lockouts (
               id, hospital_id, branch_id, instrument_id, test_key, parameter_key,
               qc_run_id, violated_rules, reason, locked_at, locked_by,
               created_by, updated_by, updated_at
             ) VALUES (
               $1, $2, $3, $4, $5, $6,
               $7, $8::text[], $9, now(), $10,
               $10, $10, now()
             )`,
            [
              lockoutId,
              ctx.hospitalId,
              instrument.branch_id,
              body.instrumentId,
              body.testKey,
              body.parameterKey ?? null,
              id,
              outcome.violated,
              `Westgard ${outcome.violated.join(', ')} on ${instrument.code}`,
              ctx.userId,
            ],
          );
        }

        const nextState = outcome.rejected ? 'out_of_control' : outcome.warned ? 'warning' : 'in_control';
        await this.upsertState(tx, {
          branchId: instrument.branch_id,
          instrumentId: body.instrumentId,
          testKey: body.testKey,
          parameterKey: body.parameterKey ?? null,
          state: nextState,
          runId: id,
          lockoutId,
          reason: outcome.rejected ? `Westgard ${outcome.violated.join(', ')}` : null,
        });

        await this.audit.write(tx, {
          action: outcome.rejected ? 'reject' : 'insert',
          entity: 'lab.labq_qc_runs',
          rowId: id,
          businessKey: material.lot_no,
          dataClass: 'operational',
          before: null,
          after: {
            value: body.value,
            z_score: Number(z.toFixed(4)),
            status,
            violated_rules: outcome.violated,
            state: nextState,
          },
        });

        await this.outbox.publish(
          tx,
          labEvent('labq.qc.recorded', id, {
            runId: id,
            analyteKey: body.testKey,
            instrumentId: body.instrumentId,
            level: body.level,
            lotNo: material.lot_no,
            zScore: z.toFixed(4),
            recordedBy: actorId(),
            recordedAt: new Date().toISOString(),
          }),
        );

        if (outcome.violated.length > 0) {
          const firstRule = outcome.violated[0] ?? 'unknown';
          await this.outbox.publish(
            tx,
            labEvent('lab.qc.violation', id, {
              instrumentId: body.instrumentId,
              analyteKey: body.testKey,
              ruleKey: firstRule,
              level: body.level,
              lockout: outcome.rejected,
              detectedAt: new Date().toISOString(),
            }),
          );
        }

        if (outcome.rejected) {
          await this.outbox.publish(
            tx,
            labEvent('labq.qc.out_of_control', body.testKey, {
              analyteKey: body.testKey,
              instrumentId: body.instrumentId,
              ruleKey: outcome.violated[0] ?? 'unknown',
              // The window a corrective action has to assess: everything since
              // the last control point that was in control.
              windowFrom: await this.lastInControlAt(tx, body),
              detectedAt: new Date().toISOString(),
            }),
          );
        }

        return id;
      }),
    );

    return this.getRun(runId);
  }

  async getRun(id: string): Promise<LabQcRunView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const row = await tx.maybeOne<QcRunRow>(
        `SELECT r.id, r.instrument_id, r.test_key, r.level::text AS level, r.value::text AS value,
                r.z_score::text AS z_score, r.status::text AS status, r.violated_rules,
                r.has_rejection, r.run_at::text AS run_at,
                s.active_lockout_id AS lockout_id,
                COALESCE(s.state::text, 'never_evaluated') AS state,
                lab.qc_permits_release(COALESCE(s.state, 'never_evaluated'::lab."LabQcState")) AS permits_release
           FROM lab.labq_qc_runs r
           LEFT JOIN lab.labq_analyte_qc_state s
             ON s.instrument_id = r.instrument_id
            AND s.test_key = r.test_key
            AND s.parameter_key IS NOT DISTINCT FROM r.parameter_key
          WHERE r.id = $1`,
        [id],
      );
      if (row === undefined) throw AppError.notFound('The QC run');
      return {
        ...row,
        value: Number(row.value),
        z_score: toNumber(row.z_score),
      };
    });
  }

  /**
   * `EN-031 §3.3` — the root cause and the corrective action, and, on one arm
   * only, the Director's authorisation to release patient results anyway.
   */
  async recordAction(body: QcActionRequest): Promise<{ readonly actionId: string }> {
    const ctx = getContext();

    if (body.qcRunId === undefined && body.lockoutId === undefined) {
      throw AppError.validation([
        {
          path: 'qcRunId',
          code: 'subject_required',
          message:
            'A corrective action is about something: name the QC run that failed or the lockout it produced.',
        },
      ]);
    }

    const isOverride = body.patientImpact === 'released_with_authorisation';
    if (isOverride) {
      // Surfaced as what it is. `labq.qc.release_override` is `sensitiveGrant`
      // with step-up and a mandatory reason, held by the Lab Director — never as
      // a retry of the refused release.
      await this.policy.assert('labq.qc.release_override');
    }

    const actionId = newId();

    await withLabErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const instrument = await tx.maybeOne<{ branch_id: string }>(
          `SELECT branch_id FROM integration.lab_instruments WHERE id = $1`,
          [body.instrumentId],
        );
        if (instrument === undefined) throw AppError.notFound('The instrument');

        await tx.query(
          `INSERT INTO lab.labq_qc_actions (
             id, hospital_id, branch_id, qc_run_id, lockout_id, instrument_id, test_key,
             cause_code, cause_note, action_code, action_note, patient_impact,
             affected_result_count, authorised_by, authorised_at, authorisation_reason,
             created_by, updated_by, updated_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7,
             $8, $9, $10, $11, $12,
             $13, $14, $15, $16,
             $17, $17, now()
           )`,
          [
            actionId,
            ctx.hospitalId,
            instrument.branch_id,
            body.qcRunId ?? null,
            body.lockoutId ?? null,
            body.instrumentId,
            body.testKey,
            body.causeCode,
            body.causeNote ?? null,
            body.actionCode,
            body.actionNote ?? null,
            body.patientImpact,
            body.affectedResultCount,
            isOverride ? ctx.userId : null,
            isOverride ? new Date().toISOString() : null,
            isOverride ? (body.authorisationReason ?? null) : null,
            ctx.userId,
          ],
        );

        await this.audit.write(tx, {
          action: isOverride ? 'override' : 'update',
          entity: 'lab.labq_qc_actions',
          rowId: actionId,
          businessKey: body.causeCode,
          dataClass: isOverride ? 'phi' : 'operational',
          before: null,
          after: {
            cause_code: body.causeCode,
            action_code: body.actionCode,
            patient_impact: body.patientImpact,
            affected_result_count: body.affectedResultCount,
          },
          sensitivity: isOverride ? 'sensitive' : 'normal',
          ...(isOverride && body.authorisationReason !== undefined
            ? { reasonText: body.authorisationReason }
            : {}),
        });

        if (isOverride) {
          await this.outbox.publish(
            tx,
            labEvent('labq.qc.released_with_authorisation', actionId, {
              actionId,
              analyteKey: body.testKey,
              instrumentId: body.instrumentId,
              authorisedBy: actorId(),
              reason: body.authorisationReason ?? '',
              affectedResultCount: body.affectedResultCount,
              authorisedAt: new Date().toISOString(),
            }),
          );
        } else {
          await this.outbox.publish(
            tx,
            labEvent('labq.qc.corrective_action_recorded', actionId, {
              actionId,
              analyteKey: body.testKey,
              instrumentId: body.instrumentId,
              rootCause: body.causeCode,
              patientImpact: body.patientImpact,
              recordedBy: actorId(),
              recordedAt: new Date().toISOString(),
            }),
          );
        }
      }),
    );

    return { actionId };
  }

  /**
   * `EN-004 §5`: "unlock only after passing QC and corrective action note".
   * Three things at once — a person, a passing run and a documented action —
   * because two of the three is how a lockout gets cleared by clicking. The
   * CHECK enforces the same triple; this is where the passing run is actually
   * checked to have passed.
   */
  async unlock(lockoutId: string, body: QcUnlockRequest): Promise<{ readonly state: string }> {
    const ctx = getContext();

    const state = await withLabErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const lockout = await tx.maybeOne<{
          id: string;
          branch_id: string;
          instrument_id: string;
          test_key: string;
          parameter_key: string | null;
          unlocked_at: string | null;
        }>(
          `SELECT id, branch_id, instrument_id, test_key, parameter_key,
                  unlocked_at::text AS unlocked_at
             FROM lab.labq_qc_lockouts WHERE id = $1 FOR UPDATE`,
          [lockoutId],
        );
        if (lockout === undefined) throw AppError.notFound('The QC lockout');
        if (lockout.unlocked_at !== null) {
          throw new AppError(ProblemType.ALREADY_DECIDED, 'This lockout has already been lifted.');
        }

        const passing = await tx.maybeOne<{ status: string }>(
          `SELECT status::text AS status FROM lab.labq_qc_runs
            WHERE id = $1 AND instrument_id = $2 AND test_key = $3`,
          [body.unlockQcRunId, lockout.instrument_id, lockout.test_key],
        );
        if (passing === undefined) {
          throw AppError.validation([
            {
              path: 'unlockQcRunId',
              code: 'run_not_found',
              message: 'That QC run is not one of this analyte and instrument.',
            },
          ]);
        }
        if (passing.status !== 'in_control') {
          throw new AppError(
            ProblemType.BUSINESS_RULE_VIOLATED,
            `The run named here is ${passing.status}, so it does not re-establish control. Repeat the control and lift the lockout against a run that passed.`,
          );
        }

        const action = await tx.maybeOne<{ id: string }>(
          `SELECT id FROM lab.labq_qc_actions WHERE id = $1 AND instrument_id = $2 AND test_key = $3`,
          [body.correctiveActionId, lockout.instrument_id, lockout.test_key],
        );
        if (action === undefined) {
          throw AppError.validation([
            {
              path: 'correctiveActionId',
              code: 'action_not_found',
              message:
                'A lockout is lifted against a documented corrective action for this analyte and instrument.',
            },
          ]);
        }

        await tx.query(
          `UPDATE lab.labq_qc_lockouts
              SET unlocked_at = now(), unlocked_by = $2, unlock_qc_run_id = $3,
                  corrective_action_id = $4, updated_by = $2, updated_at = now()
            WHERE id = $1`,
          [lockoutId, ctx.userId, body.unlockQcRunId, body.correctiveActionId],
        );

        await this.upsertState(tx, {
          branchId: lockout.branch_id,
          instrumentId: lockout.instrument_id,
          testKey: lockout.test_key,
          parameterKey: lockout.parameter_key,
          state: 'in_control',
          runId: body.unlockQcRunId,
          lockoutId: null,
          reason: null,
        });

        await this.audit.write(tx, {
          action: 'approve',
          entity: 'lab.labq_qc_lockouts',
          rowId: lockoutId,
          businessKey: lockout.test_key,
          dataClass: 'operational',
          before: { unlocked_at: null },
          after: { unlocked_at: 'now', corrective_action_id: body.correctiveActionId },
          reasonText: body.reason,
        });

        await this.outbox.publish(
          tx,
          labEvent('lab.qc.released', lockout.instrument_id, {
            instrumentId: lockout.instrument_id,
            analyteKey: lockout.test_key,
            releasedBy: actorId(),
            correctiveActionId: body.correctiveActionId,
            releasedAt: new Date().toISOString(),
          }),
        );

        return 'in_control';
      }),
    );

    return { state };
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  /**
   * The rules in force, most specific scope first. A null `test_key` or
   * `instrument_id` on a configuration row means "every one" — the hospital-wide
   * default — so a laboratory that has not tuned an analyte still gets a rule
   * set rather than none.
   */
  private async rulesFor(
    tx: TransactionClient,
    instrumentId: string,
    testKey: string,
    parameterKey: string | null,
  ): Promise<WestgardRuleConfig[]> {
    const rows = await tx.rows<{ rule_code: string; action: string; enabled: boolean }>(
      `SELECT DISTINCT ON (c.rule_code) c.rule_code::text AS rule_code, c.action::text AS action, c.enabled
         FROM lab.labq_westgard_config c
        WHERE (c.test_key IS NULL OR c.test_key = $1)
          AND (c.parameter_key IS NULL OR c.parameter_key IS NOT DISTINCT FROM $2)
          AND (c.instrument_id IS NULL OR c.instrument_id = $3)
          AND c.effective_from <= now()
          AND (c.effective_to IS NULL OR c.effective_to > now())
        ORDER BY c.rule_code,
                 (c.test_key IS NULL), (c.instrument_id IS NULL), c.effective_from DESC`,
      [testKey, parameterKey, instrumentId],
    );

    return rows.map((r) => ({
      ruleCode: r.rule_code,
      action: r.action === 'reject' ? 'reject' : 'warning',
      enabled: r.enabled,
    }));
  }

  /** This level's z-scores, newest first, with the point just measured at the head. */
  private async seriesFor(tx: TransactionClient, body: QcRunRequest, z: number): Promise<number[]> {
    const rows = await tx.rows<{ z_score: string | null }>(
      `SELECT z_score::text AS z_score
         FROM lab.labq_qc_runs
        WHERE instrument_id = $1 AND test_key = $2
          AND parameter_key IS NOT DISTINCT FROM $3
          AND level = $4::lab."LabQcLevel"
          AND status <> 'void'
        ORDER BY run_at DESC
        LIMIT 20`,
      [body.instrumentId, body.testKey, body.parameterKey ?? null, body.level],
    );
    const history = rows.map((r) => toNumber(r.z_score)).filter((v): v is number => v !== null);
    return [z, ...history];
  }

  /**
   * The other control levels measured in the same run. R-4s and 2of3-2s are
   * within-run rules *across levels*; evaluating them against one level's own
   * history is the classic way to make them never fire.
   */
  private async peersFor(tx: TransactionClient, body: QcRunRequest): Promise<number[]> {
    const rows = await tx.rows<{ z_score: string | null }>(
      `SELECT DISTINCT ON (level) z_score::text AS z_score
         FROM lab.labq_qc_runs
        WHERE instrument_id = $1 AND test_key = $2
          AND parameter_key IS NOT DISTINCT FROM $3
          AND level <> $4::lab."LabQcLevel"
          AND status <> 'void'
          AND run_at > now() - interval '12 hours'
        ORDER BY level, run_at DESC`,
      [body.instrumentId, body.testKey, body.parameterKey ?? null, body.level],
    );
    return rows.map((r) => toNumber(r.z_score)).filter((v): v is number => v !== null);
  }

  private async lastInControlAt(tx: TransactionClient, body: QcRunRequest): Promise<string> {
    const row = await tx.maybeOne<{ at: string }>(
      `SELECT run_at::text AS at FROM lab.labq_qc_runs
        WHERE instrument_id = $1 AND test_key = $2
          AND parameter_key IS NOT DISTINCT FROM $3
          AND status = 'in_control'
        ORDER BY run_at DESC LIMIT 1`,
      [body.instrumentId, body.testKey, body.parameterKey ?? null],
    );
    // Postgres renders a timestamptz as `2026-08-22 10:00:00+00`, which is not
    // the RFC 3339 form the event registry validates. Normalising here rather
    // than at the call site keeps the conversion next to the reason for it.
    return row === undefined ? new Date().toISOString() : new Date(row.at).toISOString();
  }

  /**
   * The state row is upserted rather than inserted, and the uniqueness it
   * conflicts on is the hand-written `NULLS NOT DISTINCT` index — a plain unique
   * index would let a second "no parameter" row exist, and then "which state
   * gates this analyte" would depend on row order.
   *
   * `last_evaluated_at` is set on every arm because
   * `labq_analyte_qc_state_evaluated_pairing` ties it to the state in both
   * directions: a state claiming to have been evaluated always names when.
   */
  private async upsertState(
    tx: TransactionClient,
    input: {
      readonly branchId: string;
      readonly instrumentId: string;
      readonly testKey: string;
      readonly parameterKey: string | null;
      readonly state: string;
      readonly runId: string;
      readonly lockoutId: string | null;
      readonly reason: string | null;
    },
  ): Promise<void> {
    const ctx = getContext();
    await tx.query(
      `INSERT INTO lab.labq_analyte_qc_state (
         id, hospital_id, branch_id, instrument_id, test_key, parameter_key, state,
         last_evaluated_at, last_run_id, last_run_at, reason, active_lockout_id,
         created_by, updated_by, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7::lab."LabQcState",
         now(), $8, now(), $9, $10,
         $11, $11, now()
       )
       ON CONFLICT (hospital_id, instrument_id, test_key, parameter_key) DO UPDATE
          SET state = EXCLUDED.state,
              last_evaluated_at = EXCLUDED.last_evaluated_at,
              last_run_id = EXCLUDED.last_run_id,
              last_run_at = EXCLUDED.last_run_at,
              reason = EXCLUDED.reason,
              active_lockout_id = EXCLUDED.active_lockout_id,
              updated_by = EXCLUDED.updated_by,
              updated_at = now()`,
      [
        newId(),
        ctx.hospitalId,
        input.branchId,
        input.instrumentId,
        input.testKey,
        input.parameterKey,
        input.state,
        input.runId,
        input.reason,
        input.lockoutId,
        ctx.userId,
      ],
    );
  }
}

interface QcRunRow {
  readonly id: string;
  readonly instrument_id: string;
  readonly test_key: string;
  readonly level: string;
  readonly value: string;
  readonly z_score: string | null;
  readonly status: string;
  readonly violated_rules: string[];
  readonly has_rejection: boolean;
  readonly lockout_id: string | null;
  readonly state: string;
  readonly permits_release: boolean;
  readonly run_at: string;
}
