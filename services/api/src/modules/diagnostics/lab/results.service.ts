import { Inject, Injectable } from '@nestjs/common';
import { ProblemType, newId, type Page } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService, type TransactionClient } from '../../../core/db/database.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { CursorService } from '../../../core/pagination/cursor.service.js';
import { PolicyService } from '../../../core/policy/policy.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import { actorId, toNumber, withLabErrors, writeOrderEvent } from './lab.common.js';
import { labEvent } from './lab.events.js';
import type {
  AmendResultRequest,
  BenchWorklistQuery,
  EnterResultsRequest,
  PatientResultsQuery,
  ReleaseResultsRequest,
  ResultEntryRequest,
} from './lab.schemas.js';
import type { LabResultChainLink, LabResultView, LabWorklistItem } from './lab.types.js';
import {
  NO_INTERVAL,
  deltaBreached,
  flagCoded,
  flagNumeric,
  isAbsurd,
  isCriticalFlag,
  toEventFlag,
  type ReferenceInterval,
  type ResultFlag,
} from './result-flags.js';

/**
 * OP-004 §3.3–§3.4 — the analytical and post-analytical phases.
 *
 * ── What this service does not decide ───────────────────────────────────────
 *
 * Almost every safety property here belongs to the database, and that is
 * deliberate rather than lazy:
 *
 *   * the digest and the chain link are computed by `lab.seal_result_version()`,
 *     so a caller cannot present a hash that does not describe what it stored;
 *   * the measured value is frozen from INSERT by
 *     `lab.enforce_result_version_immutability()`, not from signature;
 *   * a rejected specimen cannot produce a result, by trigger;
 *   * the QC gate is `lab.qc_permits_release()`, a whitelist in which
 *     `never_evaluated` is false;
 *   * a critical value raises its alert in the same transaction that stores it,
 *     by trigger, whether or not this service remembers to.
 *
 * What this service does is the part a trigger cannot: interpret the value
 * against the reference interval that was in force, run the delta check, decide
 * which queue the result lands in, and — for the critical path — surface the
 * obligation that the database has already created.
 *
 * ── D-10, from this side ────────────────────────────────────────────────────
 *
 * `enter()` never withholds. A critical potassium is stored, flagged, projected
 * onto `lab_results.current_flag`, announced on `lab.result.critical` and
 * visible on every read, with no ceremony and no precondition. The only thing
 * that waits for the call-back is `authorise()`, and it waits because the
 * database refuses the signature — not because this code checked.
 */
@Injectable()
export class LabResultsService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(CursorService) private readonly cursors: CursorService,
    @Inject(PolicyService) private readonly policy: PolicyService,
  ) {}

  async enter(body: EnterResultsRequest): Promise<{ readonly results: readonly LabResultView[] }> {
    const ctx = getContext();

    const ids = await withLabErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const written: string[] = [];

        for (const entry of body.results) {
          const line = await this.loadLine(tx, entry.orderTestId);

          // `EN-004 §5` and `phase-03 §Constraints`: never let a result exist
          // without a patient identity check. The identity check is the
          // specimen — it is what was scanned against a wristband — so a line
          // with no specimen has no result, and the registered
          // `lab.result.entered` event says the same thing by making `sampleId`
          // non-nullable.
          if (line.sample_id === null) {
            throw new AppError(
              ProblemType.BUSINESS_RULE_VIOLATED,
              'This test has no specimen yet. A result belongs to a container that was drawn from an identified patient; entering one before that is a value attached to nobody.',
            );
          }
          if (line.sample_status === 'rejected') {
            throw new AppError(
              ProblemType.BUSINESS_RULE_VIOLATED,
              'That specimen was rejected, so it cannot carry a result. The recollection is what produces the value.',
            );
          }
          if (['cancelled', 'authorised'].includes(line.status)) {
            throw new AppError(
              ProblemType.ALREADY_DECIDED,
              `This test line is ${line.status}. A further measurement is an amendment of the result, not a new one.`,
            );
          }

          const analyte = await this.loadAnalyte(tx, line.test_key, entry.parameterKey ?? null);
          const interval = await this.loadInterval(
            tx,
            line.test_key,
            entry.parameterKey ?? null,
            line.patient_id,
          );

          const flag = this.interpret(entry, interval, analyte.name);
          const delta = await this.checkDelta(tx, line, entry, analyte.name);
          const qc = await this.qcAtEntry(
            tx,
            entry.instrumentId ?? null,
            line.test_key,
            entry.parameterKey ?? null,
          );

          const status = qc.holds ? 'qc_hold' : delta.holds ? 'delta_hold' : 'unverified';
          const resultId = await this.upsertResult(tx, line, entry, analyte);
          const versionId = await this.insertVersion(tx, {
            resultId,
            line,
            entry,
            analyte,
            interval,
            flag,
            status,
            delta,
            qcState: qc.state,
            version: 1,
            amendmentReason: null,
          });

          await tx.query(
            `UPDATE lab.lab_order_tests
                SET status = 'resulted', resulted_at = COALESCE(resulted_at, now()),
                    updated_by = $2, updated_at = now(), version = version + 1
              WHERE id = $1 AND status IN ('pending', 'collected', 'received', 'in_progress')`,
            [line.id, ctx.userId],
          );
          await writeOrderEvent(tx, {
            orderId: line.order_id,
            orderTestId: line.id,
            sampleId: line.sample_id,
            to: 'resulted',
          });

          await this.audit.write(tx, {
            action: 'insert',
            entity: 'lab.lab_results',
            rowId: resultId,
            businessKey: line.accession_no,
            dataClass: 'phi',
            patientId: line.patient_id,
            before: null,
            after: {
              analyte: analyte.name,
              flag,
              status,
              source: entry.instrumentId === undefined ? 'manual' : 'analyzer',
            },
          });

          await this.outbox.publish(
            tx,
            labEvent('lab.result.entered', resultId, {
              resultId,
              orderTestId: line.id,
              sampleId: line.sample_id,
              patientId: line.patient_id,
              testKey: line.test_key,
              enteredBy: actorId(),
              source: entry.instrumentId === undefined ? 'manual' : 'instrument',
              enteredAt: new Date().toISOString(),
            }),
          );

          // The alert already exists — `lab.raise_critical_value_alert()` wrote
          // it in this transaction, before this line ran. Announcing it is all
          // that is left, and it happens whatever the authorisation state is.
          if (isCriticalFlag(flag)) {
            await this.announceCritical(tx, versionId, line, entry, flag);
          }

          written.push(resultId);
        }

        return written;
      }),
    );

    const results = await Promise.all(ids.map(async (id) => this.read(id)));
    return { results };
  }

  /** `OP-004 §3.4.1` — level 1, technical verification. */
  async verify(body: ReleaseResultsRequest): Promise<{ readonly results: readonly LabResultView[] }> {
    return this.release(body, 'verified');
  }

  /**
   * `OP-004 §3.4.2` — level 2, medical authorisation, which is what releases the
   * result to a report.
   *
   * For a critical result this is the *only* step D-10 gates, and the gate is
   * `lab.enforce_critical_authorisation()`: it refuses the signature until a
   * call-back exists. The value was already stored, already flagged and already
   * announced by `enter()`.
   */
  async authorise(body: ReleaseResultsRequest): Promise<{ readonly results: readonly LabResultView[] }> {
    return this.release(body, 'authorised');
  }

  private async release(
    body: ReleaseResultsRequest,
    to: 'verified' | 'authorised',
  ): Promise<{ readonly results: readonly LabResultView[] }> {
    const ctx = getContext();

    await withLabErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        for (const resultId of body.resultIds) {
          const head = await this.loadHead(tx, resultId);

          if (to === 'verified' && !['unverified', 'qc_hold', 'delta_hold'].includes(head.status)) {
            throw new AppError(
              ProblemType.ALREADY_DECIDED,
              `This result is ${head.status} and has already been through technical verification.`,
            );
          }
          if (to === 'authorised' && head.status !== 'verified') {
            throw new AppError(
              ProblemType.BUSINESS_RULE_VIOLATED,
              head.status === 'authorised'
                ? 'This result is already authorised. A change to it is an amendment.'
                : 'A result is authorised after it has been technically verified. OP-004 §3.4 is two levels, and skipping the first is not one of them.',
            );
          }
          // `OP-004 §5`: enterer ≠ verifier for manual results. The CHECK says
          // the same; saying it here names the person rather than the constraint.
          if (
            to === 'verified' &&
            head.source === 'manual' &&
            head.entered_by !== null &&
            head.entered_by === ctx.userId
          ) {
            throw new AppError(
              ProblemType.SEGREGATION_OF_DUTIES,
              'You entered this result, so you cannot be the one who verifies it (OP-004 §5, segregation of duty).',
            );
          }

          if (to === 'verified') {
            await tx.query(
              `UPDATE lab.lab_result_versions
                  SET status = 'verified', verified_by = $2, verified_at = now(),
                      qc_override_action_id = COALESCE($3, qc_override_action_id)
                WHERE id = $1`,
              [head.version_id, ctx.userId, body.qcOverrideActionId ?? null],
            );
            await tx.query(
              `UPDATE lab.lab_order_tests
                  SET status = 'verified', verified_at = now(), updated_by = $2,
                      updated_at = now(), version = version + 1
                WHERE id = $1 AND status = 'resulted'`,
              [head.order_test_id, ctx.userId],
            );
          } else {
            await tx.query(
              `UPDATE lab.lab_result_versions
                  SET status = 'authorised', authorised_by = $2, authorised_at = now(),
                      sign_method = $3::clinical."SignMethod",
                      qc_override_action_id = COALESCE($4, qc_override_action_id)
                WHERE id = $1`,
              [head.version_id, ctx.userId, body.signMethod, body.qcOverrideActionId ?? null],
            );
            await tx.query(
              `UPDATE lab.lab_order_tests
                  SET status = 'authorised', authorised_at = now(), updated_by = $2,
                      updated_at = now(), version = version + 1
                WHERE id = $1 AND status IN ('resulted', 'verified')`,
              [head.order_test_id, ctx.userId],
            );
          }

          await writeOrderEvent(tx, {
            orderId: head.order_id,
            orderTestId: head.order_test_id,
            to,
            reason: body.qcOverrideActionId === undefined ? null : 'released under QC authorisation',
          });

          await this.audit.write(tx, {
            action: to === 'verified' ? 'approve' : 'sign',
            entity: 'lab.lab_result_versions',
            rowId: head.version_id,
            businessKey: head.accession_no,
            dataClass: 'phi',
            patientId: head.patient_id,
            before: { status: head.status },
            after: {
              status: to,
              qc_override_action_id: body.qcOverrideActionId ?? null,
              flag: head.flag,
            },
            sensitivity: head.is_critical ? 'sensitive' : 'normal',
          });

          if (to === 'verified') {
            await this.outbox.publish(
              tx,
              labEvent('lab.result.verified', resultId, {
                resultId,
                orderTestId: head.order_test_id,
                patientId: head.patient_id,
                verifiedBy: actorId(),
                autoVerified: false,
                verifiedAt: new Date().toISOString(),
              }),
            );
          } else {
            await this.outbox.publish(
              tx,
              labEvent('lab.result.final', resultId, {
                resultId,
                orderTestId: head.order_test_id,
                orderId: head.order_id,
                patientId: head.patient_id,
                testKey: head.test_key,
                loincCode: head.loinc_code,
                abnormalFlag: toEventFlag(head.flag as ResultFlag),
                status: head.version === 1 ? 'final' : 'amended',
                authorisedBy: actorId(),
                autoValidated: false,
                authorisedAt: new Date().toISOString(),
              }),
            );
          }
        }
      }),
    );

    const results = await Promise.all(body.resultIds.map(async (id) => this.read(id)));
    return { results };
  }

  /**
   * `phase-03 §Non-negotiables 5` — an amendment is the next version with a
   * reason. The original stays, the chain still verifies, and everyone already
   * notified is re-notified.
   */
  async amend(resultId: string, body: AmendResultRequest): Promise<LabResultView> {
    const ctx = getContext();

    await withLabErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const head = await this.loadHead(tx, resultId);
        if (!['verified', 'authorised'].includes(head.status)) {
          throw new AppError(
            ProblemType.BUSINESS_RULE_VIOLATED,
            'Only a released result is amended. One that has not been verified yet is corrected by re-entering it.',
          );
        }

        const line = await this.loadLine(tx, head.order_test_id);
        const analyte = await this.loadAnalyte(tx, head.test_key, head.parameter_key);
        const interval = await this.loadInterval(tx, head.test_key, head.parameter_key, head.patient_id);

        const entry: ResultEntryRequest = {
          orderTestId: head.order_test_id,
          resultType: body.resultType,
          valueMulti: body.valueMulti,
          instrumentFlags: [],
          ...(body.valueNumeric === undefined ? {} : { valueNumeric: body.valueNumeric }),
          ...(body.valueOperator === undefined ? {} : { valueOperator: body.valueOperator }),
          ...(body.valueCoded === undefined ? {} : { valueCoded: body.valueCoded }),
          ...(body.valueText === undefined ? {} : { valueText: body.valueText }),
          ...(body.unit === undefined ? {} : { unit: body.unit }),
          ...(body.comment === undefined ? {} : { comment: body.comment }),
        };

        const flag = this.interpret(entry, interval, analyte.name);
        const nextVersion = head.version + 1;

        const versionId = await this.insertVersion(tx, {
          resultId,
          line,
          entry,
          analyte,
          interval,
          flag,
          status: 'unverified',
          delta: { holds: false, flagged: false, previousValue: null, previousAt: null, ruleId: null },
          qcState: null,
          version: nextVersion,
          amendmentReason: body.reason,
        });

        // The superseded version is stamped, never rewritten: the immutability
        // trigger permits exactly `authorised → amended` and nothing else.
        await tx.query(
          `UPDATE lab.lab_result_versions
              SET status = CASE WHEN status = 'authorised' THEN 'amended'::lab."LabResultStatus" ELSE status END,
                  superseded_by_version = $2, superseded_at = now()
            WHERE id = $1`,
          [head.version_id, nextVersion],
        );

        await tx.query(
          `UPDATE lab.lab_order_tests
              SET status = 'resulted', updated_by = $2, updated_at = now(), version = version + 1
            WHERE id = $1`,
          [head.order_test_id, ctx.userId],
        );

        await writeOrderEvent(tx, {
          orderId: head.order_id,
          orderTestId: head.order_test_id,
          from: head.status,
          to: 'amended',
          reason: body.reason,
        });

        await this.audit.write(tx, {
          action: 'update',
          entity: 'lab.lab_result_versions',
          rowId: versionId,
          businessKey: head.accession_no,
          dataClass: 'phi',
          patientId: head.patient_id,
          before: { version: head.version, flag: head.flag },
          after: { version: nextVersion, flag },
          reasonText: body.reason,
          sensitivity: 'sensitive',
        });

        await this.outbox.publish(
          tx,
          labEvent('lab.result.amended', resultId, {
            resultId,
            orderTestId: head.order_test_id,
            patientId: head.patient_id,
            version: nextVersion,
            reason: body.reason,
            amendedBy: actorId(),
            amendedAt: new Date().toISOString(),
          }),
        );

        if (isCriticalFlag(flag)) {
          await this.announceCritical(tx, versionId, line, entry, flag);
        }
      }),
    );

    return this.read(resultId);
  }

  /**
   * `docs/07 §2.1` class B, 150 ms p95. Served by
   * `idx_lab_order_tests_pending` / `idx_lab_order_tests_awaiting_release`,
   * both partial on the exact status sets below — which is why the status list
   * here is written out rather than parameterised: a bound array would not match
   * the index predicate and the plan would fall back to a sequential scan of
   * every order line in the hospital.
   *
   * ── What the plan actually does, measured ───────────────────────────────
   *
   * `EXPLAIN (ANALYZE, BUFFERS)` as `hms_app` with a full tenant context
   * (`app.hospital_id` **and** `app.branch_ids`; as the schema owner RLS is
   * bypassed by ownership and the plan is for a query the application never
   * runs), against 100 000 open lines in one hospital and one discipline:
   *
   *   Bitmap Index Scan on idx_lab_order_tests_pending  (rows=100030)
   *   → Parallel Bitmap Heap Scan, Hash Join, top-N heapsort
   *   Execution Time: 24.8 ms
   *
   * So the partial index is doing its job as a *filter* and not as an
   * *ordering*: the generated RLS predicate is `hospital_id = ANY(<array>)`,
   * and an array scan on the index's leading column cannot produce sorted
   * output, so the top-N sort is unavoidable and the cost grows with the size
   * of the open worklist rather than with the page. At the ~100 000 open lines
   * of that measurement it is 25 ms — inside the budget with room, and a real
   * bench worklist for one sub-department is hundreds of rows, not a hundred
   * thousand. Worth revisiting only if a measurement says so.
   */
  async worklist(query: BenchWorklistQuery): Promise<Page<LabWorklistItem>> {
    const ctx = getContext();
    const hospitalId = ctx.hospitalId ?? '';
    const resource = `lab.worklist.${query.stage}`;
    const limit = this.cursors.pageSize(query.limit);
    const after = this.cursors.start(query.cursor, { hospitalId, resource });

    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const values: unknown[] = [query.discipline];
      const bind = (value: unknown): string => `$${values.push(value)}`;

      const statusFilter =
        query.stage === 'pending'
          ? `ot.status IN ('pending', 'collected', 'received', 'in_progress')`
          : `ot.status IN ('resulted', 'verified')`;
      const sortColumn = query.stage === 'pending' ? 'ot.tat_due_at' : 'ot.resulted_at';

      const cursorClause =
        after === null
          ? ''
          : ` AND (COALESCE(${sortColumn}, 'infinity'::timestamptz), ot.id) > (${bind(after.k[0])}::timestamptz, ${bind(after.id)}::uuid)`;

      // The ORDER BY is on the bare column, not on the COALESCE. A btree's
      // default ascending order already puts NULLs last, so this is the same
      // ordering — but wrapping the column in an expression would make it
      // un-orderable by `idx_lab_order_tests_pending` and turn every worklist
      // load into a sort of every open line in the hospital. The COALESCE stays
      // in the *cursor* comparison and in the emitted key, where a total order
      // is what makes keyset pagination reach the rows with no target time.

      const rows = await tx.rows<LabWorklistItem & { cursor_key: string }>(
        `SELECT ot.id, ot.id AS order_test_id, ot.order_id, o.accession_no, o.patient_id,
                ot.test_code, ot.test_name, ot.discipline::text AS discipline,
                ot.priority::text AS priority, ot.status::text AS status,
                ot.sample_id, s.sample_no, s.barcode,
                ot.tat_due_at::text AS tat_due_at, s.received_at::text AS received_at,
                COALESCE(${sortColumn}, 'infinity'::timestamptz)::text AS cursor_key
           FROM lab.lab_order_tests ot
           JOIN lab.lab_orders o ON o.id = ot.order_id
           LEFT JOIN lab.lab_samples s ON s.id = ot.sample_id
          WHERE ot.discipline = $1::mdm."LabDiscipline"
            AND ${statusFilter}${cursorClause}
          ORDER BY ${sortColumn}, ot.id
          LIMIT ${bind(limit + 1)}`,
        values,
      );

      const page = this.cursors.keysetPage<LabWorklistItem>(rows, limit, {
        hospitalId,
        resource,
        direction: 'asc',
      });
      return { items: page.items, nextCursor: page.nextCursor, hasMore: page.hasMore };
    });
  }

  /** `docs/07 §2.1` class C, 250 ms p95. */
  async get(id: string): Promise<LabResultView> {
    const row = await this.load(id);
    await this.assertSensitiveReadPermitted(row.test_key, row.patient_id);
    return toResultView(row);
  }

  /**
   * The same projection, **without** the confidential-analyte gate, for the echo
   * a mutation returns.
   *
   * `OP-004 §5` restricts *reading* a confidential result — an HIV or a genetic
   * test is not browsable by whoever happens to have `lab.result.read`. It does
   * not, and cannot, restrict the technician who is typing the value in, the
   * senior who is verifying it, or the pathologist who is signing it: each of
   * them is holding the number already, and refusing to echo it back would
   * protect nothing while making the analyte unrecordable. So the gate lives on
   * `get()` and `forPatient()`, which are the two ways somebody reads a result
   * they did not produce.
   */
  private async read(id: string): Promise<LabResultView> {
    return toResultView(await this.load(id));
  }

  private async load(id: string): Promise<ResultRow> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const found = await tx.maybeOne<ResultRow>(`${resultSelect('')} WHERE r.id = $1`, [id]);
      if (found === undefined) throw AppError.notFound('The result');
      return found;
    });
  }

  /** `OP-004 §3.6.1` — the cumulative view, across visits and across partitions. */
  async forPatient(patientId: string, query: PatientResultsQuery): Promise<Page<LabResultView>> {
    const ctx = getContext();
    const hospitalId = ctx.hospitalId ?? '';
    const resource = 'lab.results.cumulative';
    const limit = this.cursors.pageSize(query.limit);
    const after = this.cursors.start(query.cursor, { hospitalId, resource });

    // A cumulative read of a sensitive analyte needs the sensitive key even
    // when the caller did not ask for that analyte by name, so the check is on
    // what comes back rather than on what was asked for.
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const values: unknown[] = [patientId];
      const bind = (value: unknown): string => `$${values.push(value)}`;
      const clauses = [`r.patient_id = $1`];
      if (query.testKey !== undefined) clauses.push(`r.test_key = ${bind(query.testKey)}::uuid`);
      if (after !== null) {
        clauses.push(`(r.created_at, r.id) < (${bind(after.k[0])}::timestamptz, ${bind(after.id)}::uuid)`);
      }

      const rows = await tx.rows<ResultRow & { cursor_key: string }>(
        `${resultSelect(', r.created_at::text AS cursor_key')}
          WHERE ${clauses.join(' AND ')}
          ORDER BY r.created_at DESC, r.id DESC
          LIMIT ${bind(limit + 1)}`,
        values,
      );

      const page = this.cursors.keysetPage<ResultRow>(rows, limit, {
        hospitalId,
        resource,
        direction: 'desc',
      });

      const sensitiveKeys = await this.sensitiveTestKeys(
        tx,
        page.items.map((r) => r.test_key),
      );
      if (sensitiveKeys.size > 0) {
        await this.policy.assert('lab.result.sensitive.read', { patientId });
      }

      return {
        items: page.items.map(toResultView),
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      };
    });
  }

  /** The verifier a NABL assessor asks for, re-derived by the database. */
  async chain(id: string): Promise<{ readonly links: readonly LabResultChainLink[] }> {
    const links = await this.db.withTenant(currentTenantContext(), async (tx) => {
      const exists = await tx.maybeOne<{ id: string }>(`SELECT id FROM lab.lab_results WHERE id = $1`, [id]);
      if (exists === undefined) throw AppError.notFound('The result');
      return tx.rows<LabResultChainLink>(
        `SELECT version, status, hash_matches, link_matches FROM lab.verify_result_chain($1)`,
        [id],
      );
    });
    return { links };
  }

  // ── interpretation ────────────────────────────────────────────────────────

  private interpret(
    entry: Pick<
      ResultEntryRequest,
      'resultType' | 'valueNumeric' | 'valueCoded' | 'valueText' | 'valueMulti'
    >,
    interval: ReferenceInterval,
    analyteName: string,
  ): ResultFlag {
    switch (entry.resultType) {
      case 'numeric':
      case 'calculated':
      case 'semi_quantitative': {
        if (entry.valueNumeric === undefined) {
          if (entry.valueCoded !== undefined) return flagCoded(entry.valueCoded, interval);
          throw AppError.validation([
            {
              path: 'valueNumeric',
              code: 'value_required',
              message: `${analyteName} is a numeric result. A number stored as text cannot be compared against a panic limit.`,
            },
          ]);
        }
        return flagNumeric(entry.valueNumeric, interval);
      }
      case 'qualitative':
      case 'coded': {
        if (entry.valueCoded === undefined) {
          throw AppError.validation([
            { path: 'valueCoded', code: 'value_required', message: `${analyteName} needs a coded answer.` },
          ]);
        }
        return flagCoded(entry.valueCoded, interval);
      }
      case 'multiselect':
        if (entry.valueMulti.length === 0) {
          throw AppError.validation([
            {
              path: 'valueMulti',
              code: 'value_required',
              message: `${analyteName} needs at least one finding.`,
            },
          ]);
        }
        return 'normal';
      case 'text':
        if (entry.valueText === undefined) {
          throw AppError.validation([
            { path: 'valueText', code: 'value_required', message: `${analyteName} needs a narrative.` },
          ]);
        }
        return 'normal';
      default:
        return 'indeterminate';
    }
  }

  private async loadLine(tx: TransactionClient, orderTestId: string): Promise<LineRow> {
    const row = await tx.maybeOne<LineRow>(
      `SELECT ot.id, ot.order_id, ot.test_key, ot.test_code, ot.test_name, ot.loinc_code,
              ot.status::text AS status, ot.sample_id, o.patient_id, o.branch_id, o.accession_no,
              o.ordering_user_id, s.status::text AS sample_status
         FROM lab.lab_order_tests ot
         JOIN lab.lab_orders o ON o.id = ot.order_id
         LEFT JOIN lab.lab_samples s ON s.id = ot.sample_id
        WHERE ot.id = $1`,
      [orderTestId],
    );
    if (row === undefined) throw AppError.notFound('The test line');
    return row;
  }

  private async loadAnalyte(
    tx: TransactionClient,
    testKey: string,
    parameterKey: string | null,
  ): Promise<AnalyteRow> {
    if (parameterKey !== null) {
      const parameter = await tx.maybeOne<AnalyteRow>(
        `SELECT DISTINCT ON (p.record_key) p.name, p.loinc_code, p.unit,
                p.absurd_low::text AS absurd_low, p.absurd_high::text AS absurd_high
           FROM mdm.mdm_lab_test_parameters p
          WHERE p.record_key = $1 AND p.test_key = $2 AND p.status = 'active'
          ORDER BY p.record_key, p.version DESC`,
        [parameterKey, testKey],
      );
      if (parameter === undefined) {
        throw AppError.validation([
          {
            path: 'parameterKey',
            code: 'analyte_not_found',
            message: 'That analyte does not belong to this test in the catalogue in force today.',
          },
        ]);
      }
      return parameter;
    }

    const test = await tx.maybeOne<AnalyteRow>(
      `SELECT DISTINCT ON (t.record_key) t.name, t.loinc_code, t.unit,
              t.absurd_low::text AS absurd_low, t.absurd_high::text AS absurd_high
         FROM mdm.mdm_lab_tests t
        WHERE t.record_key = $1 AND t.status = 'active'
        ORDER BY t.record_key, t.version DESC`,
      [testKey],
    );
    if (test === undefined) throw AppError.notFound('The test in the catalogue');
    return test;
  }

  /**
   * `OP-004 §5`: "report prints the range used at that time; changing master
   * does not alter historical reports". The interval is resolved here and
   * snapshotted onto the version, so it can never be re-derived later against a
   * master that has since moved.
   *
   * The most specific match wins: a sex-specific band before `any`.
   */
  private async loadInterval(
    tx: TransactionClient,
    testKey: string,
    parameterKey: string | null,
    patientId: string,
  ): Promise<ReferenceInterval & { readonly id: string | null }> {
    const patient = await tx.maybeOne<{ gender: string; age_days: number }>(
      `SELECT gender::text AS gender,
              GREATEST(0, (CURRENT_DATE - dob))::int AS age_days
         FROM patient.patients WHERE id = $1`,
      [patientId],
    );

    const row = await tx.maybeOne<IntervalRow>(
      `SELECT live.id, live.low::text AS low, live.high::text AS high,
              live.critical_low::text AS critical_low, live.critical_high::text AS critical_high,
              live.text_normal, live.critical_coded_values
         FROM (
           SELECT DISTINCT ON (r.record_key) r.*
             FROM lab.lab_reference_ranges r
            WHERE r.test_key = $1
              AND r.parameter_key IS NOT DISTINCT FROM $2
              AND (r.sex = 'any' OR r.sex = $3)
              AND $4 BETWEEN r.age_min_days AND r.age_max_days
              AND r.status = 'active'
              AND r.effective_from <= now()
              AND (r.effective_to IS NULL OR r.effective_to > now())
            ORDER BY r.record_key, r.version DESC
         ) live
        ORDER BY (live.sex = 'any'), live.age_max_days - live.age_min_days
        LIMIT 1`,
      [testKey, parameterKey, patient?.gender ?? 'unknown', patient?.age_days ?? 0],
    );

    if (row === undefined) return { ...NO_INTERVAL, id: null };

    return {
      id: row.id,
      low: toNumber(row.low),
      high: toNumber(row.high),
      criticalLow: toNumber(row.critical_low),
      criticalHigh: toNumber(row.critical_high),
      textNormal: row.text_normal,
      criticalCodedValues: row.critical_coded_values,
    };
  }

  private async checkDelta(
    tx: TransactionClient,
    line: LineRow,
    entry: ResultEntryRequest,
    analyteName: string,
  ): Promise<DeltaOutcome> {
    const none: DeltaOutcome = {
      holds: false,
      flagged: false,
      previousValue: null,
      previousAt: null,
      ruleId: null,
    };
    if (entry.valueNumeric === undefined) return none;

    const rule = await tx.maybeOne<{
      id: string;
      mode: string;
      threshold: string;
      window_hours: string;
      action: string;
    }>(
      `SELECT DISTINCT ON (d.record_key) d.id, d.mode, d.threshold::text AS threshold,
              d.window_hours::text AS window_hours, d.action
         FROM lab.lab_delta_check_rules d
        WHERE d.test_key = $1
          AND d.parameter_key IS NOT DISTINCT FROM $2
          AND d.status = 'active'
          AND d.effective_from <= now()
          AND (d.effective_to IS NULL OR d.effective_to > now())
        ORDER BY d.record_key, d.version DESC`,
      [line.test_key, entry.parameterKey ?? null],
    );
    if (rule === undefined) return none;

    const previous = await tx.maybeOne<{ value_numeric: string; recorded_at: string; hours_ago: string }>(
      `SELECT v.value_numeric::text AS value_numeric, v.recorded_at::text AS recorded_at,
              (EXTRACT(EPOCH FROM (now() - v.recorded_at)) / 3600)::text AS hours_ago
         FROM lab.lab_result_versions v
         JOIN lab.lab_results r ON r.id = v.result_id
        WHERE r.patient_id = $1
          AND r.test_key = $2
          AND r.parameter_key IS NOT DISTINCT FROM $3
          AND v.status IN ('verified', 'authorised', 'amended')
          AND v.value_numeric IS NOT NULL
          AND v.recorded_at >= now() - make_interval(mins => ($4::numeric * 60)::int)
        ORDER BY v.recorded_at DESC
        LIMIT 1`,
      [line.patient_id, line.test_key, entry.parameterKey ?? null, rule.window_hours],
    );
    if (previous === undefined) return none;

    const breached = deltaBreached(
      entry.valueNumeric,
      { value: Number(previous.value_numeric), hoursAgo: Number(previous.hours_ago) },
      { mode: rule.mode, threshold: Number(rule.threshold), action: rule.action },
    );
    if (!breached) return none;

    // `hold` puts it in `delta_hold` until a human looks; `flag` lets it
    // through marked. Neither drops it — a delta check that silently discards a
    // value is worse than no delta check, and `analyteName` is in the message so
    // the bench knows which one to look at.
    return {
      holds: rule.action === 'hold',
      flagged: true,
      previousValue: Number(previous.value_numeric),
      previousAt: previous.recorded_at,
      ruleId: rule.id,
      note: `${analyteName} changed beyond the configured delta`,
    };
  }

  /**
   * The QC state at the moment of entry. Resolved by the database's own
   * functions — `lab.qc_gate_applies()` and `lab.qc_permits_release()` — rather
   * than re-implemented here, because a second implementation of "may this
   * analyte be released" is a second answer.
   */
  private async qcAtEntry(
    tx: TransactionClient,
    instrumentId: string | null,
    testKey: string,
    parameterKey: string | null,
  ): Promise<{ readonly state: string | null; readonly holds: boolean }> {
    const ctx = getContext();
    const row = await tx.one<{ applies: boolean; state: string; permits: boolean }>(
      `SELECT lab.qc_gate_applies($1, $2, $3, $4) AS applies,
              lab.qc_state_for($1, $2, $3, $4)::text AS state,
              lab.qc_permits_release(lab.qc_state_for($1, $2, $3, $4)) AS permits`,
      [ctx.hospitalId, instrumentId, testKey, parameterKey],
    );
    if (!row.applies) return { state: null, holds: false };
    return { state: row.state, holds: !row.permits };
  }

  // ── writers ───────────────────────────────────────────────────────────────

  private async upsertResult(
    tx: TransactionClient,
    line: LineRow,
    entry: ResultEntryRequest,
    analyte: AnalyteRow,
  ): Promise<string> {
    const ctx = getContext();
    const existing = await tx.maybeOne<{ id: string }>(
      `SELECT id FROM lab.lab_results
        WHERE order_test_id = $1 AND parameter_key IS NOT DISTINCT FROM $2`,
      [line.id, entry.parameterKey ?? null],
    );
    if (existing !== undefined) {
      throw new AppError(
        ProblemType.CONFLICT,
        'This order line already has a result for that analyte. A repeat measurement is an amendment of it, not a second result.',
      );
    }

    const id = newId();
    await tx.query(
      `INSERT INTO lab.lab_results (
         id, hospital_id, branch_id, order_id, order_test_id, patient_id,
         test_key, parameter_key, loinc_code, analyte_name, result_type,
         created_by, updated_by, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10, $11::mdm."LabResultType",
         $12, $12, now()
       )`,
      [
        id,
        ctx.hospitalId,
        line.branch_id,
        line.order_id,
        line.id,
        line.patient_id,
        line.test_key,
        entry.parameterKey ?? null,
        analyte.loinc_code ?? line.loinc_code,
        analyte.name,
        entry.resultType,
        ctx.userId,
      ],
    );
    return id;
  }

  private async insertVersion(tx: TransactionClient, input: InsertVersionInput): Promise<string> {
    const ctx = getContext();
    const { entry, interval, analyte } = input;

    if (entry.valueNumeric !== undefined) {
      const bounds = {
        absurdLow: toNumber(analyte.absurd_low),
        absurdHigh: toNumber(analyte.absurd_high),
      };
      if (isAbsurd(entry.valueNumeric, bounds)) {
        throw AppError.validation([
          {
            path: 'valueNumeric',
            code: 'absurd_value',
            message: `${entry.valueNumeric} is outside anything physically possible for ${analyte.name}. An absurd value is a typing error, not an abnormal result — check the decimal point and re-enter it.`,
          },
        ]);
      }
    }

    const id = newId();
    const unit = entry.valueNumeric === undefined ? null : (entry.unit ?? analyte.unit ?? null);

    await tx.query(
      `INSERT INTO lab.lab_result_versions (
         id, hospital_id, branch_id, result_id, order_test_id, patient_id, version, status, source,
         result_type, value_numeric, value_coded, value_coded_system, value_multi, value_text,
         value_operator, unit,
         flag, ref_range_id, ref_low, ref_high, ref_critical_low, ref_critical_high,
         is_critical, delta_flagged, delta_prev_value, delta_prev_at, delta_rule_id,
         instrument_id, run_id, instrument_flags, dilution_factor,
         entered_by, entered_at, qc_state_at_release, amendment_reason, comment, created_by
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8::lab."LabResultStatus", $9::lab."LabResultSource",
         $10::mdm."LabResultType", $11, $12, $13, $14::text[], $15,
         $16, $17,
         $18::lab."LabResultFlag", $19, $20, $21, $22, $23,
         $24, $25, $26, $27, $28,
         $29, $30, $31::text[], $32,
         $33, now(), COALESCE($34::lab."LabQcState", 'never_evaluated'), $35, $36, $33
       )`,
      [
        id,
        ctx.hospitalId,
        input.line.branch_id,
        input.resultId,
        input.line.id,
        input.line.patient_id,
        input.version,
        input.status,
        entry.instrumentId === undefined ? 'manual' : 'analyzer',
        entry.resultType,
        entry.valueNumeric ?? null,
        entry.valueCoded ?? null,
        entry.valueCodedSystem ?? null,
        entry.valueMulti,
        entry.valueText ?? null,
        entry.valueOperator ?? null,
        unit,
        input.flag,
        interval.id,
        interval.low,
        interval.high,
        interval.criticalLow,
        interval.criticalHigh,
        isCriticalFlag(input.flag),
        input.delta.flagged,
        input.delta.previousValue,
        input.delta.previousAt,
        input.delta.ruleId,
        entry.instrumentId ?? null,
        entry.runId ?? null,
        entry.instrumentFlags,
        entry.dilutionFactor ?? null,
        ctx.userId,
        input.qcState,
        input.amendmentReason,
        entry.comment ?? null,
      ],
    );

    return id;
  }

  /**
   * The alert already exists: `lab.raise_critical_value_alert()` created it in
   * this transaction, from the row itself. All that is left is to announce it,
   * so EN-037's ladder starts — and the announcement is unconditional, because
   * `docs/DECISIONS.md D-10` puts the condition on the signature and never on
   * the value.
   */
  private async announceCritical(
    tx: TransactionClient,
    versionId: string,
    line: LineRow,
    entry: ResultEntryRequest,
    flag: ResultFlag,
  ): Promise<void> {
    const alert = await tx.maybeOne<{ id: string; value_display: string; unit: string | null }>(
      `SELECT id, value_display, unit FROM lab.lab_critical_value_alerts WHERE result_version_id = $1`,
      [versionId],
    );
    if (alert === undefined) {
      // The trigger is what raises it, so an absent alert means the trigger has
      // been dropped. Failing loudly is the only honest response: a critical
      // value with no obligation attached to it is the exact defect this phase
      // exists to prevent.
      throw new AppError(
        ProblemType.INTERNAL_ERROR,
        'This result is critical but no alert was raised for it. The laboratory should telephone the ordering clinician now and report this reference to IT.',
      );
    }

    const version = await tx.one<{ result_id: string }>(
      `SELECT result_id FROM lab.lab_result_versions WHERE id = $1`,
      [versionId],
    );

    await this.outbox.publish(
      tx,
      labEvent('lab.result.critical', alert.id, {
        alertId: alert.id,
        resultId: version.result_id,
        orderId: line.order_id,
        patientId: line.patient_id,
        orderingDoctorUserId: line.ordering_user_id,
        testKey: line.test_key,
        value: alert.value_display,
        unit: alert.unit ?? entry.unit ?? null,
        limitBreached: flag === 'critical_low' ? 'critical_low' : 'critical_high',
        detectedAt: new Date().toISOString(),
      }),
    );
  }

  // ── reads ─────────────────────────────────────────────────────────────────

  private async loadHead(tx: TransactionClient, resultId: string): Promise<HeadRow> {
    const row = await tx.maybeOne<HeadRow>(
      `SELECT v.id AS version_id, v.version, v.status::text AS status, v.source::text AS source,
              v.entered_by, v.flag::text AS flag, v.is_critical,
              r.id AS result_id, r.order_id, r.order_test_id, r.patient_id, r.test_key,
              r.parameter_key, r.loinc_code, o.accession_no
         FROM lab.lab_results r
         JOIN lab.lab_result_versions v
           ON v.result_id = r.id AND v.version = r.current_version
         JOIN lab.lab_orders o ON o.id = r.order_id
        WHERE r.id = $1
        FOR UPDATE OF v`,
      [resultId],
    );
    if (row === undefined) throw AppError.notFound('The result');
    return row;
  }

  /**
   * `OP-004 §5`: HIV, genetic and other confidential results are readable only
   * with `lab.result.sensitive.read`, which is a `sensitiveGrant` key carrying
   * step-up and a reason. The check is on the *analyte*, from the master, so a
   * hospital adding a test to the confidential list does not need a code change.
   */
  private async assertSensitiveReadPermitted(testKey: string, patientId: string): Promise<void> {
    const sensitive = await this.db.withTenant(currentTenantContext(), async (tx) =>
      this.sensitiveTestKeys(tx, [testKey]),
    );
    if (sensitive.size === 0) return;
    await this.policy.assert('lab.result.sensitive.read', { patientId });
  }

  private async sensitiveTestKeys(tx: TransactionClient, testKeys: readonly string[]): Promise<Set<string>> {
    if (testKeys.length === 0) return new Set();
    const rows = await tx.rows<{ record_key: string }>(
      `SELECT DISTINCT ON (t.record_key) t.record_key
         FROM mdm.mdm_lab_tests t
        WHERE t.record_key = ANY($1::uuid[]) AND t.status = 'active' AND t.is_sensitive
        ORDER BY t.record_key, t.version DESC`,
      [[...new Set(testKeys)]],
    );
    return new Set(rows.map((r) => r.record_key));
  }
}

/**
 * The head-version projection every result read uses.
 *
 * A function rather than a constant because a cursor page needs its sort key in
 * the select list and a single read does not — and appending a column after the
 * FROM clause is the kind of string surgery that produces a syntax error at
 * 3 a.m. rather than at build time.
 */
function resultSelect(extraColumns: string): string {
  return `
  SELECT r.id, r.order_id, r.order_test_id, r.patient_id, r.test_key, r.parameter_key,
         r.analyte_name, r.loinc_code, r.result_type::text AS result_type,
         r.current_version, r.current_status::text AS current_status,
         r.current_flag::text AS current_flag, r.ever_critical,
         v.value_numeric::text AS value_numeric, v.value_operator, v.value_coded,
         v.value_multi, v.value_text, v.unit,
         v.ref_low::text AS ref_low, v.ref_high::text AS ref_high,
         v.ref_critical_low::text AS ref_critical_low, v.ref_critical_high::text AS ref_critical_high,
         v.delta_flagged, v.qc_state_at_release::text AS qc_state_at_release,
         v.amendment_reason, v.comment, v.entered_by, v.verified_by, v.authorised_by,
         v.recorded_at::text AS recorded_at${extraColumns}
    FROM lab.lab_results r
    JOIN lab.lab_result_versions v ON v.result_id = r.id AND v.version = r.current_version`;
}

interface ResultRow {
  readonly id: string;
  readonly order_id: string;
  readonly order_test_id: string;
  readonly patient_id: string;
  readonly test_key: string;
  readonly parameter_key: string | null;
  readonly analyte_name: string;
  readonly loinc_code: string | null;
  readonly result_type: string;
  readonly current_version: number;
  readonly current_status: string;
  readonly current_flag: string | null;
  readonly ever_critical: boolean;
  readonly value_numeric: string | null;
  readonly value_operator: string | null;
  readonly value_coded: string | null;
  readonly value_multi: string[];
  readonly value_text: string | null;
  readonly unit: string | null;
  readonly ref_low: string | null;
  readonly ref_high: string | null;
  readonly ref_critical_low: string | null;
  readonly ref_critical_high: string | null;
  readonly delta_flagged: boolean;
  readonly qc_state_at_release: string;
  readonly amendment_reason: string | null;
  readonly comment: string | null;
  readonly entered_by: string | null;
  readonly verified_by: string | null;
  readonly authorised_by: string | null;
  readonly recorded_at: string;
}

function toResultView(row: ResultRow): LabResultView {
  return {
    ...row,
    value_numeric: toNumber(row.value_numeric),
    ref_low: toNumber(row.ref_low),
    ref_high: toNumber(row.ref_high),
    ref_critical_low: toNumber(row.ref_critical_low),
    ref_critical_high: toNumber(row.ref_critical_high),
  };
}

interface LineRow {
  readonly id: string;
  readonly order_id: string;
  readonly test_key: string;
  readonly test_code: string;
  readonly test_name: string;
  readonly loinc_code: string | null;
  readonly status: string;
  readonly sample_id: string | null;
  readonly sample_status: string | null;
  readonly patient_id: string;
  readonly branch_id: string;
  readonly accession_no: string;
  readonly ordering_user_id: string | null;
}

interface AnalyteRow {
  readonly name: string;
  readonly loinc_code: string | null;
  readonly unit: string | null;
  readonly absurd_low: string | null;
  readonly absurd_high: string | null;
}

interface IntervalRow {
  readonly id: string;
  readonly low: string | null;
  readonly high: string | null;
  readonly critical_low: string | null;
  readonly critical_high: string | null;
  readonly text_normal: string | null;
  readonly critical_coded_values: string[];
}

interface DeltaOutcome {
  readonly holds: boolean;
  readonly flagged: boolean;
  readonly previousValue: number | null;
  readonly previousAt: string | null;
  readonly ruleId: string | null;
  readonly note?: string;
}

interface InsertVersionInput {
  readonly resultId: string;
  readonly line: LineRow;
  readonly entry: ResultEntryRequest;
  readonly analyte: AnalyteRow;
  readonly interval: ReferenceInterval & { readonly id: string | null };
  readonly flag: ResultFlag;
  readonly status: string;
  readonly delta: DeltaOutcome;
  readonly qcState: string | null;
  readonly version: number;
  readonly amendmentReason: string | null;
}

interface HeadRow {
  readonly version_id: string;
  readonly version: number;
  readonly status: string;
  readonly source: string;
  readonly entered_by: string | null;
  readonly flag: string;
  readonly is_critical: boolean;
  readonly result_id: string;
  readonly order_id: string;
  readonly order_test_id: string;
  readonly patient_id: string;
  readonly test_key: string;
  readonly parameter_key: string | null;
  readonly loinc_code: string | null;
  readonly accession_no: string;
}
