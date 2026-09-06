import { Inject, Injectable } from '@nestjs/common';
import { newId, type Page } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService, type TransactionClient } from '../../../core/db/database.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import { leakageEvent } from './leakage.events.js';
import { withLeakageErrors } from './leakage.errors.js';
import { RECONCILERS, type ReconcilerRow } from './leakage.reconcilers.js';
import type {
  AcceptFindingRequest,
  DischargeCheckRequest,
  DismissFindingRequest,
  FindingQuery,
  OverrideDischargeRequest,
  RecordRecoveryRequest,
  RuleQuery,
  RunScanRequest,
  ScanQuery,
  UpsertRuleRequest,
} from './leakage.schemas.js';
import type {
  DischargeCheckView,
  LeakDashboardView,
  LeakFindingDetailView,
  LeakFindingView,
  LeakRuleView,
  LeakScanResultView,
  LeakScanView,
} from './leakage.types.js';

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
function money(n: number): string {
  return n.toFixed(2);
}

/**
 * RC-006 — revenue leakage audit.
 *
 * ── Everything here is a proposal ───────────────────────────────────────────
 *
 * `phase-05` §5.7: "Never auto-post — propose to a human." This service finds
 * gaps and writes them to a worklist. It does not raise a charge, adjust a bill
 * or touch a rupee, and the database refuses to let a finding reach `recovered`
 * without an `accepted` action carrying somebody's user id.
 *
 * The reason is not process hygiene. A reconciliation that bills what it thinks
 * it found will eventually bill a family for a test that was cancelled, an
 * implant that was wasted, or a visit the consultant waived — and the person who
 * has to argue about it at the counter has no way to know which. Being right 95%
 * of the time is not good enough when the other 5% lands on people who cannot
 * challenge a receipt.
 *
 * ── Exit gate 9 is `dischargeCheck` ─────────────────────────────────────────
 *
 * It runs the reconcilers over one encounter, *synchronously*, at the moment
 * somebody asks whether the patient can leave. Before, not after: a missed
 * charge found the next morning is a phone call to a family who has gone home
 * and a debt they never agreed to. Clearing a check with a gap still open is a
 * separate call on a separate permission, and it writes the overrider's name.
 */
@Injectable()
export class LeakageService {
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

  private guard<T>(fn: (tx: TransactionClient) => Promise<T>): Promise<T> {
    return withLeakageErrors(() => this.db.withTenant(currentTenantContext(), fn));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Rules
  // ═══════════════════════════════════════════════════════════════════════════

  async listRules(query: RuleQuery): Promise<Page<LeakRuleView>> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM billing.leak_rules WHERE hospital_id = $1 ORDER BY reconciler LIMIT $2`,
        [this.hospitalId(), query.limit],
      );
      return { items: rows.map((r) => this.toRule(r)), nextCursor: null, hasMore: false };
    });
  }

  private toRule(r: Record<string, unknown>): LeakRuleView {
    return {
      id: asText(r['id']),
      reconciler: asText(r['reconciler']),
      name: asText(r['name']),
      minGapAmount: asText(r['min_gap_amount']),
      severity: asText(r['severity']),
      lookbackDays: asNumber(r['lookback_days']),
      isActive: Boolean(r['is_active']),
      notes: asTextOrNull(r['notes']),
    };
  }

  async upsertRule(body: UpsertRuleRequest): Promise<LeakRuleView> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO billing.leak_rules
           (id, hospital_id, reconciler, name, min_gap_amount, severity, lookback_days, is_active, notes,
            created_at, created_by, updated_at, updated_by)
         VALUES ($1,$2,$3::"billing"."LeakReconciler",$4,$5::numeric,$6::"billing"."LeakSeverity",$7,$8,$9,
                 now(),$10, now(),$10)
         ON CONFLICT ("hospital_id","reconciler") DO UPDATE
           SET name = EXCLUDED.name, min_gap_amount = EXCLUDED.min_gap_amount,
               severity = EXCLUDED.severity, lookback_days = EXCLUDED.lookback_days,
               is_active = EXCLUDED.is_active, notes = EXCLUDED.notes,
               updated_at = now(), updated_by = EXCLUDED.updated_by
         RETURNING *`,
        [
          newId(),
          this.hospitalId(),
          body.reconciler,
          body.name,
          body.minGapAmount.toFixed(2),
          body.severity,
          body.lookbackDays,
          body.isActive,
          body.notes ?? null,
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The rule could not be saved.');
      return this.toRule(row);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Scanning
  // ═══════════════════════════════════════════════════════════════════════════

  async runScan(body: RunScanRequest): Promise<LeakScanResultView> {
    return this.guard((tx) => this.scanIn(tx, body));
  }

  /**
   * Run the enabled reconcilers and write what they find.
   *
   * Findings are upserted on `(reconciler, source_ref_id)` while still live, so
   * the nightly sweep and an on-demand check converge on one row rather than
   * producing a pile of duplicates — the partial unique index in the migration's
   * §B.3 makes that a guarantee rather than a convention.
   */
  private async scanIn(tx: TransactionClient, body: RunScanRequest): Promise<LeakScanResultView> {
    const hospital = this.hospitalId();
    const branch = this.branchId();
    const scanId = newId();

    const { rows: rules } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM billing.leak_rules
        WHERE hospital_id = $1 AND is_active
          AND (cardinality($2::text[]) = 0 OR reconciler::text = ANY($2::text[]))
        ORDER BY reconciler`,
      [hospital, body.reconcilers],
    );

    await tx.query(
      `INSERT INTO billing.leak_scans
         (id, hospital_id, branch_id, trigger, encounter_id, window_from, window_to, status, started_at, started_by)
       VALUES ($1,$2,$3,$4,$5,$6::date,$7::date,'running', now(),$8)`,
      [
        scanId,
        hospital,
        branch,
        body.trigger,
        body.encounterId ?? null,
        body.windowFrom ?? null,
        body.windowTo ?? null,
        this.actorId(),
      ],
    );

    let examined = 0;
    let created = 0;
    const findingIds: string[] = [];

    for (const rule of rules) {
      const reconciler = asText(rule['reconciler']);
      const run = RECONCILERS[reconciler];
      if (run === undefined) continue;

      const lookback = asNumber(rule['lookback_days']);
      const since =
        body.windowFrom ?? new Date(Date.now() - lookback * 86_400_000).toISOString().slice(0, 10);

      const found: readonly ReconcilerRow[] = await run(tx, {
        hospitalId: hospital,
        branchId: branch,
        encounterId: body.encounterId ?? null,
        since,
        minGap: asText(rule['min_gap_amount']),
      });
      examined += found.length;

      for (const f of found) {
        const expected = Number(f.expected_amount);
        const billed = Number(f.billed_amount);
        const gap = Math.round((expected - billed) * 100) / 100;
        if (gap <= 0) continue;

        const id = newId();
        const { rows: inserted } = await tx.query<{ id: string }>(
          `INSERT INTO billing.leak_findings
             (id, hospital_id, branch_id, scan_id, rule_id, reconciler, severity,
              patient_id, encounter_id, source_ref_type, source_ref_id, description, service_name,
              expected_amount, billed_amount, gap_amount, occurred_at, status, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6::"billing"."LeakReconciler",$7::"billing"."LeakSeverity",
                   $8,$9,$10,$11,$12,$13,
                   $14::numeric,$15::numeric,$16::numeric,$17::timestamptz,'open', now(), now())
           ON CONFLICT ("hospital_id","reconciler","source_ref_id")
             WHERE status IN ('open','accepted')
             DO NOTHING
           RETURNING id`,
          [
            id,
            hospital,
            branch,
            scanId,
            asText(rule['id']),
            reconciler,
            asText(rule['severity']),
            f.patient_id,
            f.encounter_id,
            f.source_ref_type,
            f.source_ref_id,
            f.description,
            f.service_name,
            money(expected),
            money(billed),
            money(gap),
            f.occurred_at,
          ],
        );

        const newRow = inserted[0];
        if (newRow === undefined) continue; // already on the worklist
        created += 1;
        findingIds.push(id);

        await tx.query(
          `INSERT INTO billing.leak_finding_actions (id, hospital_id, finding_id, kind, at, by_id)
           VALUES ($1,$2,$3,'proposed', now(),$4)`,
          [newId(), hospital, id, this.actorId()],
        );

        await this.outbox.publish(
          tx,
          leakageEvent('leakage.finding.raised', id, {
            findingId: id,
            reconciler,
            severity: asText(rule['severity']),
            encounterId: f.encounter_id,
            gapAmount: money(gap),
            description: f.description,
          }),
        );
      }
    }

    // Everything still open in the scope this scan covered, not only what it
    // created — the discharge desk needs the standing total, not tonight's delta.
    const { rows: totals } = await tx.query<{ n: string; gap: string }>(
      `SELECT count(*) AS n, COALESCE(sum(gap_amount), 0) AS gap
         FROM billing.leak_findings
        WHERE hospital_id = $1 AND status IN ('open','accepted')
          AND ($2::uuid IS NULL OR encounter_id = $2)`,
      [hospital, body.encounterId ?? null],
    );
    const totalCount = asNumber(totals[0]?.n ?? 0);
    const totalGap = asText(totals[0]?.gap ?? '0');

    const { rows: scan } = await tx.query<Record<string, unknown>>(
      `UPDATE billing.leak_scans
          SET status = 'complete', finished_at = now(), rules_run = $2, rows_examined = $3,
              findings_new = $4, findings_total = $5, gap_total = $6::numeric
        WHERE id = $1
        RETURNING *`,
      [scanId, rules.length, examined, created, totalCount, totalGap],
    );
    const scanRow = scan[0];
    if (scanRow === undefined) throw AppError.conflict('The scan could not be completed.');

    await this.outbox.publish(
      tx,
      leakageEvent('leakage.scan.completed', scanId, {
        scanId,
        trigger: body.trigger,
        rulesRun: rules.length,
        findingsNew: created,
        findingsTotal: totalCount,
        gapTotal: totalGap,
      }),
    );

    const { rows: found } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM billing.leak_findings
        WHERE hospital_id = $1 AND status IN ('open','accepted')
          AND ($2::uuid IS NULL OR encounter_id = $2)
        ORDER BY gap_amount DESC
        LIMIT 200`,
      [hospital, body.encounterId ?? null],
    );

    return { ...this.toScan(scanRow), findings: found.map((r) => this.toFinding(r)) };
  }

  private toScan(r: Record<string, unknown>): LeakScanView {
    return {
      id: asText(r['id']),
      trigger: asText(r['trigger']),
      encounterId: asTextOrNull(r['encounter_id']),
      windowFrom: asDay(r['window_from']),
      windowTo: asDay(r['window_to']),
      status: asText(r['status']),
      rulesRun: asNumber(r['rules_run']),
      rowsExamined: asNumber(r['rows_examined']),
      findingsNew: asNumber(r['findings_new']),
      findingsTotal: asNumber(r['findings_total']),
      gapTotal: asText(r['gap_total']),
      error: asTextOrNull(r['error']),
      startedAt: asText(r['started_at']),
      finishedAt: asTextOrNull(r['finished_at']),
    };
  }

  private toFinding(r: Record<string, unknown>): LeakFindingView {
    return {
      id: asText(r['id']),
      reconciler: asText(r['reconciler']),
      severity: asText(r['severity']),
      patientId: asTextOrNull(r['patient_id']),
      encounterId: asTextOrNull(r['encounter_id']),
      sourceRefType: asText(r['source_ref_type']),
      sourceRefId: asText(r['source_ref_id']),
      description: asText(r['description']),
      serviceName: asTextOrNull(r['service_name']),
      expectedAmount: asText(r['expected_amount']),
      billedAmount: asText(r['billed_amount']),
      gapAmount: asText(r['gap_amount']),
      occurredAt: asTextOrNull(r['occurred_at']),
      status: asText(r['status']),
      acceptedBy: asTextOrNull(r['accepted_by']),
      dismissReason: asTextOrNull(r['dismiss_reason']),
      recoveredAmount: asText(r['recovered_amount']),
      createdAt: asText(r['created_at']),
    };
  }

  async listScans(query: ScanQuery): Promise<Page<LeakScanView>> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM billing.leak_scans
          WHERE hospital_id = $1 AND ($2::uuid IS NULL OR encounter_id = $2)
          ORDER BY started_at DESC LIMIT $3`,
        [this.hospitalId(), query.encounterId ?? null, query.limit],
      );
      return { items: rows.map((r) => this.toScan(r)), nextCursor: null, hasMore: false };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The worklist
  // ═══════════════════════════════════════════════════════════════════════════

  async listFindings(query: FindingQuery): Promise<Page<LeakFindingView>> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM billing.leak_findings
          WHERE hospital_id = $1
            AND ($2::text IS NULL OR status::text = $2)
            AND ($3::text IS NULL OR reconciler::text = $3)
            AND ($4::uuid IS NULL OR encounter_id = $4)
          ORDER BY gap_amount DESC, created_at DESC
          LIMIT $5`,
        [
          this.hospitalId(),
          query.status ?? null,
          query.reconciler ?? null,
          query.encounterId ?? null,
          query.limit + 1,
        ],
      );
      const page = rows.slice(0, query.limit);
      return {
        items: page.map((r) => this.toFinding(r)),
        nextCursor: null,
        hasMore: rows.length > query.limit,
      };
    });
  }

  async getFinding(id: string): Promise<LeakFindingDetailView> {
    return this.guard((tx) => this.loadFinding(tx, id));
  }

  private async loadFinding(tx: TransactionClient, id: string): Promise<LeakFindingDetailView> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM billing.leak_findings WHERE id = $1 AND hospital_id = $2`,
      [id, this.hospitalId()],
    );
    const row = rows[0];
    if (row === undefined) throw AppError.notFound('Leakage finding');

    const { rows: actions } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM billing.leak_finding_actions WHERE finding_id = $1 ORDER BY at`,
      [id],
    );

    return {
      ...this.toFinding(row),
      actions: actions.map((a) => ({
        id: asText(a['id']),
        kind: asText(a['kind']),
        reason: asTextOrNull(a['reason']),
        amount: asTextOrNull(a['amount']),
        at: asText(a['at']),
      })),
    };
  }

  /**
   * Agree the gap is real.
   *
   * This is the permission to bill it, not the billing. Nothing moves until
   * somebody raises the charge and records the recovery — which is deliberate:
   * a single click that both agrees and bills is the auto-post §5.7 forbids,
   * wearing a person's name.
   */
  async acceptFinding(id: string, body: AcceptFindingRequest): Promise<LeakFindingDetailView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();
      const actor = this.actorId();

      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE billing.leak_findings
            SET status = 'accepted', accepted_by = $3, accepted_at = now(),
                updated_at = now(), updated_by = $3
          WHERE id = $1 AND hospital_id = $2 AND status = 'open'
          RETURNING *`,
        [id, hospital, actor],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('Only an open finding can be accepted.');

      await tx.query(
        `INSERT INTO billing.leak_finding_actions (id, hospital_id, finding_id, kind, reason, at, by_id)
         VALUES ($1,$2,$3,'accepted',$4, now(),$5)`,
        [newId(), hospital, id, body.reason, actor],
      );

      await this.audit.write(tx, {
        action: 'approve',
        entity: 'leak_finding',
        rowId: id,
        businessKey: asText(row['source_ref_id']),
        dataClass: 'financial',
        before: { status: 'open' },
        after: { status: 'accepted', gapAmount: asText(row['gap_amount']) },
        reasonText: body.reason,
      });

      await this.outbox.publish(
        tx,
        leakageEvent('leakage.finding.accepted', id, {
          findingId: id,
          gapAmount: asText(row['gap_amount']),
          acceptedBy: actor,
          reason: body.reason,
        }),
      );

      return this.loadFinding(tx, id);
    });
  }

  async dismissFinding(id: string, body: DismissFindingRequest): Promise<LeakFindingDetailView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();
      const actor = this.actorId();

      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE billing.leak_findings
            SET status = 'dismissed', dismissed_by = $3, dismissed_at = now(), dismiss_reason = $4,
                updated_at = now(), updated_by = $3
          WHERE id = $1 AND hospital_id = $2 AND status IN ('open','accepted')
          RETURNING *`,
        [id, hospital, actor, body.reason],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('This finding has already been settled.');

      await tx.query(
        `INSERT INTO billing.leak_finding_actions (id, hospital_id, finding_id, kind, reason, at, by_id)
         VALUES ($1,$2,$3,'dismissed',$4, now(),$5)`,
        [newId(), hospital, id, body.reason, actor],
      );

      await this.audit.write(tx, {
        action: 'reject',
        entity: 'leak_finding',
        rowId: id,
        businessKey: asText(row['source_ref_id']),
        dataClass: 'financial',
        before: { status: 'open' },
        after: { status: 'dismissed' },
        reasonText: body.reason,
      });

      await this.outbox.publish(
        tx,
        leakageEvent('leakage.finding.dismissed', id, {
          findingId: id,
          reconciler: asText(row['reconciler']),
          gapAmount: asText(row['gap_amount']),
          reason: body.reason,
        }),
      );

      return this.loadFinding(tx, id);
    });
  }

  /**
   * Record that an accepted gap was billed and the money came back.
   *
   * Recording a recovery does **not** make the charge exist. If the desk never
   * actually raises the bill line, the next scan finds the same unbilled row and
   * raises it again — the reconciler checks the ledger, not the claim. That is
   * deliberate and worth keeping: it means this audit cannot be closed out by
   * asserting the money was recovered, only by the charge actually being there.
   */
  async recordRecovery(id: string, body: RecordRecoveryRequest): Promise<LeakFindingDetailView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();
      const actor = this.actorId();

      const { rows: before } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM billing.leak_findings WHERE id = $1 AND hospital_id = $2 FOR UPDATE`,
        [id, hospital],
      );
      const prior = before[0];
      if (prior === undefined) throw AppError.notFound('Leakage finding');
      if (asText(prior['status']) !== 'accepted') {
        throw AppError.conflict(
          'Only an accepted finding can be recovered. Nothing the audit finds is billed until somebody agrees it is a real gap.',
        );
      }

      const already = asNumber(prior['recovered_amount']);
      const gap = asNumber(prior['gap_amount']);
      const total = Math.round((already + body.amount) * 100) / 100;
      if (total > gap) {
        throw AppError.conflict(
          `Recovering ₹${body.amount.toFixed(2)} would take the total past the ₹${gap.toFixed(2)} that was missing.`,
        );
      }

      const recoveryId = newId();
      await tx.query(
        `INSERT INTO billing.leak_recoveries
           (id, hospital_id, finding_id, bill_id, amount, route, note, recovered_at, recovered_by)
         VALUES ($1,$2,$3,$4,$5::numeric,$6,$7, now(),$8)`,
        [
          recoveryId,
          hospital,
          id,
          body.billId ?? null,
          body.amount.toFixed(2),
          body.route,
          body.reason,
          actor,
        ],
      );

      await tx.query(
        `INSERT INTO billing.leak_finding_actions
           (id, hospital_id, finding_id, kind, reason, bill_id, amount, at, by_id)
         VALUES ($1,$2,$3,'recovered',$4,$5,$6::numeric, now(),$7)`,
        [newId(), hospital, id, body.reason, body.billId ?? null, body.amount.toFixed(2), actor],
      );

      // Fully recovered closes it; a part recovery leaves it accepted so the
      // rest stays on somebody's list rather than disappearing.
      await tx.query(
        `UPDATE billing.leak_findings
            SET recovered_amount = $2::numeric,
                status = CASE WHEN $2::numeric >= gap_amount
                              THEN 'recovered'::"billing"."LeakFindingStatus" ELSE status END,
                updated_at = now(), updated_by = $3
          WHERE id = $1`,
        [id, money(total), actor],
      );

      await this.outbox.publish(
        tx,
        leakageEvent('leakage.recovered', recoveryId, {
          recoveryId,
          findingId: id,
          amount: body.amount.toFixed(2),
          route: body.route,
        }),
      );

      return this.loadFinding(tx, id);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Exit gate 9 — the pre-discharge check
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Run the reconcilers over one encounter and record what was open.
   *
   * Synchronous and narrow. The moment before a patient leaves is the last one
   * at which a missed charge can be settled with the family present, so this
   * runs the scan rather than reading yesterday's.
   */
  async dischargeCheck(body: DischargeCheckRequest): Promise<DischargeCheckView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();
      const branch = this.branchId();

      const scan = await this.scanIn(tx, {
        encounterId: body.encounterId,
        trigger: 'pre_discharge',
        reconcilers: [],
      });

      const open = scan.findings.filter((f) => f.status === 'open' || f.status === 'accepted');
      const gapTotal = open.reduce((sum, f) => sum + Number(f.gapAmount), 0);
      const clean = open.length === 0;
      const checkId = newId();

      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO billing.leak_discharge_checks
           (id, hospital_id, branch_id, encounter_id, patient_id, scan_id, open_findings, gap_total,
            cleared, cleared_at, cleared_by, checked_at, checked_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::numeric,
                 $9, CASE WHEN $9::boolean THEN now() ELSE NULL END,
                 CASE WHEN $9::boolean THEN $10::uuid ELSE NULL END, now(),$10)
         RETURNING *`,
        [
          checkId,
          hospital,
          branch,
          body.encounterId,
          body.patientId ?? null,
          scan.id,
          open.length,
          money(gapTotal),
          clean,
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The discharge check could not be recorded.');

      if (!clean) {
        await this.outbox.publish(
          tx,
          leakageEvent('leakage.discharge.blocked', checkId, {
            checkId,
            encounterId: body.encounterId,
            patientId: body.patientId ?? null,
            openFindings: open.length,
            gapTotal: money(gapTotal),
          }),
        );
      }

      return {
        id: checkId,
        encounterId: body.encounterId,
        openFindings: open.length,
        gapTotal: money(gapTotal),
        cleared: clean,
        overrideReason: null,
        checkedAt: asText(row['checked_at']),
        findings: open,
      };
    });
  }

  /**
   * Let the patient go with a gap still open.
   *
   * A separate permission from running the check, because this is the hospital
   * deciding to lose the money — and a decision like that should have a name and
   * a sentence attached rather than being the same button as "all clear".
   */
  async overrideDischarge(id: string, body: OverrideDischargeRequest): Promise<DischargeCheckView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();
      const actor = this.actorId();

      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE billing.leak_discharge_checks
            SET cleared = true, cleared_at = now(), cleared_by = $3, override_reason = $4
          WHERE id = $1 AND hospital_id = $2 AND NOT cleared
          RETURNING *`,
        [id, hospital, actor, body.reason],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('This discharge check is already cleared.');

      await this.audit.write(tx, {
        action: 'override',
        entity: 'leak_discharge_check',
        rowId: id,
        businessKey: asText(row['encounter_id']),
        dataClass: 'financial',
        before: { cleared: false, gapTotal: asText(row['gap_total']) },
        after: { cleared: true },
        reasonText: body.reason,
      });

      await this.outbox.publish(
        tx,
        leakageEvent('leakage.discharge.overridden', id, {
          checkId: id,
          encounterId: asText(row['encounter_id']),
          openFindings: asNumber(row['open_findings']),
          gapTotal: asText(row['gap_total']),
          clearedBy: actor,
          reason: body.reason,
        }),
      );

      const { rows: findings } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM billing.leak_findings
          WHERE hospital_id = $1 AND encounter_id = $2 AND status IN ('open','accepted')
          ORDER BY gap_amount DESC`,
        [hospital, asText(row['encounter_id'])],
      );

      return {
        id,
        encounterId: asText(row['encounter_id']),
        openFindings: asNumber(row['open_findings']),
        gapTotal: asText(row['gap_total']),
        cleared: true,
        overrideReason: body.reason,
        checkedAt: asText(row['checked_at']),
        findings: findings.map((f) => this.toFinding(f)),
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The recovered-amount dashboard
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * What the audit found and what came back.
   *
   * The acceptance rate per reconciler is the number worth watching: one that is
   * dismissed most of the time is not finding leakage, it is manufacturing work,
   * and the fix is the query rather than the worklist.
   */
  async dashboard(): Promise<LeakDashboardView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();

      const { rows: totals } = await tx.query<Record<string, unknown>>(
        `SELECT
           count(*) FILTER (WHERE status = 'open')                        AS open_count,
           COALESCE(sum(gap_amount) FILTER (WHERE status = 'open'), 0)    AS open_gap,
           count(*) FILTER (WHERE status = 'accepted')                    AS accepted_count,
           COALESCE(sum(gap_amount) FILTER (WHERE status = 'accepted'), 0) AS accepted_gap,
           count(*) FILTER (WHERE status = 'recovered')                   AS recovered_count,
           COALESCE(sum(recovered_amount), 0)                             AS recovered_amount,
           count(*) FILTER (WHERE status = 'dismissed')                   AS dismissed_count,
           COALESCE(sum(gap_amount) FILTER (WHERE status = 'dismissed'), 0) AS dismissed_gap
         FROM billing.leak_findings WHERE hospital_id = $1`,
        [hospital],
      );
      const t = totals[0] ?? {};

      const { rows: byRec } = await tx.query<Record<string, unknown>>(
        `SELECT reconciler::text AS reconciler,
                count(*) FILTER (WHERE status = 'open')                     AS open_count,
                COALESCE(sum(gap_amount) FILTER (WHERE status = 'open'), 0) AS open_gap,
                COALESCE(sum(recovered_amount), 0)                          AS recovered_amount,
                round(100.0 * count(*) FILTER (WHERE status IN ('accepted','recovered'))
                      / NULLIF(count(*) FILTER (WHERE status <> 'open'), 0), 2) AS acceptance_pct
           FROM billing.leak_findings
          WHERE hospital_id = $1
          GROUP BY reconciler
          ORDER BY COALESCE(sum(gap_amount) FILTER (WHERE status = 'open'), 0) DESC`,
        [hospital],
      );

      return {
        openCount: asNumber(t['open_count'] ?? 0),
        openGap: asText(t['open_gap'] ?? '0'),
        acceptedCount: asNumber(t['accepted_count'] ?? 0),
        acceptedGap: asText(t['accepted_gap'] ?? '0'),
        recoveredCount: asNumber(t['recovered_count'] ?? 0),
        recoveredAmount: asText(t['recovered_amount'] ?? '0'),
        dismissedCount: asNumber(t['dismissed_count'] ?? 0),
        dismissedGap: asText(t['dismissed_gap'] ?? '0'),
        byReconciler: byRec.map((r) => ({
          reconciler: asText(r['reconciler']),
          openCount: asNumber(r['open_count']),
          openGap: asText(r['open_gap']),
          recoveredAmount: asText(r['recovered_amount']),
          acceptanceRatePct: r['acceptance_pct'] === null ? 'n/a' : asText(r['acceptance_pct']),
        })),
      };
    });
  }
}
