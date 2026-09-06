import { Inject, Injectable } from '@nestjs/common';
import { newId, type Page } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService } from '../../../core/db/database.service.js';
import { NumberingService } from '../../../core/numbering/numbering.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import { packageEvent } from './packages.events.js';
import type {
  ActivateRequest,
  BookRequest,
  CloseActivationRequest,
  CreatePackageRequest,
  DecideVarianceRequest,
  EvaluateChargeRequest,
  PackageQuery,
  PublishVersionRequest,
  RequestVarianceRequest,
} from './packages.schemas.js';
import type {
  ChargeEvaluationView,
  PackageActivationView,
  PackageBookingView,
  PackageView,
  VarianceRequestView,
} from './packages.types.js';

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
function round2(v: number): number {
  return (Math.sign(v) * Math.round(Math.abs(v) * 100)) / 100;
}

/** The thresholds §5.4 asks for. Crossing one raises an event, not a blocker. */
const CAP_ALERT_THRESHOLDS = [80, 100] as const;

/**
 * OP-023 — packages.
 *
 * ── `evaluateCharge` is the module ──────────────────────────────────────────
 *
 * Everything else configures or reports. This is the method that decides, for
 * one charge, whether the package covers it — and records that decision
 * permanently, because "why is this on my bill when I bought a package?" is
 * asked at the discharge counter with the family standing there.
 *
 * The four outcomes are deliberately distinct:
 *
 *   covered         inside a component and inside its cap — the patient owes nothing
 *   capped          the component exists but its cap is reached; the balance is
 *                   the patient's, and the split is recorded so it can be shown
 *   excluded        the package explicitly says it does not cover this
 *   excess_pending  over the cap and awaiting a decision — **held off the bill**
 *
 * `excess_pending` is the one that matters. §5.4: "excess-charge approval before
 * billing beyond the package". Billing it and letting the family find out is the
 * most common complaint against package pricing in Indian hospitals, so the
 * charge waits for `pkg.variance.approve` — a different key, held by finance
 * rather than by the desk that sold the package.
 *
 * ── Nothing is absorbed silently ────────────────────────────────────────────
 *
 * An unmatched component resolves to `excluded`, never to `covered`. A package
 * that quietly swallowed anything it did not recognise would report a margin it
 * does not have, and the error surfaces months later as a profitability figure
 * nobody can reconcile.
 */
@Injectable()
export class PackagesService {
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

  // ═══════════════════════════════════════════════════════════════════════════
  // Catalogue
  // ═══════════════════════════════════════════════════════════════════════════

  async listPackages(query: PackageQuery): Promise<Page<PackageView>> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT p.*,
                (SELECT pr.price FROM billing.package_prices pr
                   JOIN billing.package_versions v ON v.id = pr.package_version_id
                  WHERE v.package_id = p.id
                    AND v.effective_from <= current_date
                    AND (v.effective_to IS NULL OR v.effective_to > current_date)
                  ORDER BY pr.effective_from DESC LIMIT 1) AS live_price
           FROM billing.packages p
          WHERE p.hospital_id = $1
            AND ($2::text IS NULL OR p.kind::text = $2)
            AND ($3::text IS NULL OR p.status::text = $3)
          ORDER BY p.name
          LIMIT $4`,
        [this.hospitalId(), query.kind ?? null, query.status ?? null, query.limit + 1],
      );
      const page = rows.slice(0, query.limit);
      return {
        items: page.map((r) => ({
          id: asText(r['id']),
          code: asText(r['code']),
          name: asText(r['name']),
          kind: asText(r['kind']),
          scope: asText(r['scope']),
          status: asText(r['status']),
          currentVersion: asNumber(r['current_version']),
          validityDays: asNumber(r['validity_days']),
          maxUnits: r['max_units'] === null ? null : asNumber(r['max_units']),
          isPublic: Boolean(r['is_public']),
          livePrice: asTextOrNull(r['live_price']),
        })),
        nextCursor: null,
        hasMore: rows.length > query.limit,
      };
    });
  }

  async createPackage(body: CreatePackageRequest): Promise<PackageView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const id = newId();
      await tx.query(
        `INSERT INTO billing.packages
           (id, hospital_id, code, name, kind, scope, department_id, los_days_included,
            validity_days, max_units, description, is_public, status,
            created_at, created_by, updated_at, updated_by)
         VALUES ($1,$2,$3,$4,$5::"billing"."PackageKind",$6::"billing"."PackageScope",$7,$8,
                 $9,$10,$11,$12,'draft', now(),$13, now(),$13)`,
        [
          id,
          this.hospitalId(),
          body.code,
          body.name,
          body.kind,
          body.scope,
          body.departmentId ?? null,
          body.losDaysIncluded ?? null,
          body.validityDays,
          body.maxUnits ?? null,
          body.description ?? null,
          body.isPublic,
          this.actorId(),
        ],
      );
      return {
        id,
        code: body.code,
        name: body.name,
        kind: body.kind,
        scope: body.scope,
        status: 'draft',
        currentVersion: 0,
        validityDays: body.validityDays,
        maxUnits: body.maxUnits ?? null,
        isPublic: body.isPublic,
        livePrice: null,
      };
    });
  }

  /**
   * Publish a version and its price in one transaction.
   *
   * The exclusion constraint refuses an overlapping window, and the previous
   * open-ended version is closed first so a normal succession is not mistaken
   * for a conflict — the same shape RC-003's publish uses, for the same reason.
   */
  async publishVersion(
    packageId: string,
    body: PublishVersionRequest,
  ): Promise<{ readonly versionId: string; readonly version: number }> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const hospital = this.hospitalId();
      const actor = this.actorId();

      const { rows: next } = await tx.query<{ n: string }>(
        `SELECT COALESCE(max(version), 0) + 1 AS n FROM billing.package_versions WHERE package_id = $1`,
        [packageId],
      );
      const version = asNumber(next[0]?.n ?? 1);
      const versionId = newId();

      await tx.query(
        `UPDATE billing.package_versions
            SET effective_to = $2::date, updated_at = now()
          WHERE package_id = $1 AND effective_to IS NULL AND effective_from < $2::date`,
        [packageId, body.effectiveFrom],
      );

      await tx.query(
        `INSERT INTO billing.package_versions
           (id, hospital_id, package_id, version, effective_from, effective_to,
            components, exclusions, rules, a_la_carte_total, approved_by, approved_at,
            created_at, created_by, updated_at)
         VALUES ($1,$2,$3,$4,$5::date,$6::date,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11, now(),
                 now(),$11, now())`,
        [
          versionId,
          hospital,
          packageId,
          version,
          body.effectiveFrom,
          body.effectiveTo ?? null,
          JSON.stringify(body.components),
          JSON.stringify(body.exclusions),
          JSON.stringify(body.rules),
          body.aLaCarteTotal === undefined ? null : body.aLaCarteTotal.toFixed(2),
          actor,
        ],
      );

      const savings =
        body.aLaCarteTotal === undefined ? null : round2(body.aLaCarteTotal - body.price).toFixed(2);

      await tx.query(
        `INSERT INTO billing.package_prices
           (id, hospital_id, package_version_id, payer_plan_id, price, savings,
            effective_from, effective_to, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8::date, now(), now())`,
        [
          newId(),
          hospital,
          versionId,
          body.payerPlanId ?? null,
          body.price.toFixed(2),
          savings,
          body.effectiveFrom,
          body.effectiveTo ?? null,
        ],
      );

      await tx.query(
        `UPDATE billing.packages SET current_version = $2, status = 'active', updated_at = now(), updated_by = $3
          WHERE id = $1`,
        [packageId, version, actor],
      );

      await this.outbox.publish(
        tx,
        packageEvent('package.defined', versionId, {
          packageId,
          versionId,
          version,
          effectiveFrom: body.effectiveFrom,
        }),
      );
      await this.audit.write(tx, {
        action: 'insert',
        entity: 'billing.package_versions',
        rowId: versionId,
        businessKey: `${packageId}:v${String(version)}`,
        dataClass: 'financial',
        reasonText: body.reason,
        before: null,
        after: { version, price: body.price.toFixed(2) },
      });

      return { versionId, version };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Booking and activation
  // ═══════════════════════════════════════════════════════════════════════════

  async book(body: BookRequest): Promise<PackageBookingView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const id = newId();
      const branch = this.branchId();
      const allocation = await this.numbering.allocate(tx, {
        key: 'BILL_OP',
        branchId: branch,
        refType: 'package_booking',
        refId: id,
      });

      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO billing.package_bookings
           (id, hospital_id, branch_id, booking_no, patient_id, package_version_id,
            payer_plan_id, doctor_id, planned_date, advance_required, status,
            created_at, created_by, updated_at, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10,'booked', now(),$11, now(),$11)
         RETURNING *`,
        [
          id,
          this.hospitalId(),
          branch,
          allocation.formatted,
          body.patientId,
          body.packageVersionId,
          body.payerPlanId ?? null,
          body.doctorId ?? null,
          body.plannedDate ?? null,
          body.advanceRequired.toFixed(2),
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The booking could not be created.');

      await this.outbox.publish(
        tx,
        packageEvent('package.booked', id, {
          bookingId: id,
          bookingNo: allocation.formatted,
          patientId: body.patientId,
          packageVersionId: body.packageVersionId,
          advanceRequired: body.advanceRequired.toFixed(2),
        }),
      );
      return this.toBooking(row);
    });
  }

  private toBooking(r: Record<string, unknown>): PackageBookingView {
    return {
      id: asText(r['id']),
      bookingNo: asText(r['booking_no']),
      patientId: asText(r['patient_id']),
      packageVersionId: asText(r['package_version_id']),
      status: asText(r['status']),
      advanceRequired: asText(r['advance_required']),
      advancePaid: asText(r['advance_paid']),
      plannedDate: asTextOrNull(r['planned_date']),
      createdAt: asText(r['created_at']),
    };
  }

  async activate(body: ActivateRequest): Promise<PackageActivationView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const id = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO billing.package_activations
           (id, hospital_id, booking_id, package_version_id, patient_id,
            encounter_id, admission_id, activated_at, activated_by, status, units_total,
            created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, now(),$8,'active',$9, now(), now())
         RETURNING *`,
        [
          id,
          this.hospitalId(),
          body.bookingId ?? null,
          body.packageVersionId,
          body.patientId,
          body.encounterId ?? null,
          body.admissionId ?? null,
          this.actorId(),
          body.unitsTotal,
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The package could not be activated.');

      if (body.bookingId !== undefined) {
        await tx.query(
          `UPDATE billing.package_bookings SET status = 'activated', updated_at = now() WHERE id = $1`,
          [body.bookingId],
        );
      }

      await this.outbox.publish(
        tx,
        packageEvent('package.activated', id, {
          activationId: id,
          bookingId: body.bookingId ?? null,
          patientId: body.patientId,
          packageVersionId: body.packageVersionId,
          unitsTotal: body.unitsTotal,
        }),
      );
      return this.toActivation(row);
    });
  }

  private toActivation(r: Record<string, unknown>): PackageActivationView {
    return {
      id: asText(r['id']),
      bookingId: asTextOrNull(r['booking_id']),
      packageVersionId: asText(r['package_version_id']),
      patientId: asText(r['patient_id']),
      status: asText(r['status']),
      unitsTotal: asNumber(r['units_total']),
      unitsUsed: asNumber(r['units_used']),
      coveredAmount: asText(r['covered_amount']),
      excessAmount: asText(r['excess_amount']),
      exclusionsAmount: asText(r['exclusions_amount']),
      activatedAt: asText(r['activated_at']),
      closedAt: asTextOrNull(r['closed_at']),
    };
  }

  async getActivation(id: string): Promise<PackageActivationView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM billing.package_activations WHERE id = $1 AND hospital_id = $2`,
        [id, this.hospitalId()],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.notFound('Package activation');
      return this.toActivation(row);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The decision that matters
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Decide what the package does to one charge, and record it.
   *
   * Reads the version's `components` and `exclusions` and matches the charge
   * against them. An unmatched component is `excluded`, never `covered` — see
   * the class note. Crossing a cap threshold raises `package.cap.threshold` so
   * the overrun is visible before it is billed.
   */
  async evaluateCharge(activationId: string, body: EvaluateChargeRequest): Promise<ChargeEvaluationView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const hospital = this.hospitalId();

      const { rows: found } = await tx.query<Record<string, unknown>>(
        `SELECT a.*, v.components, v.exclusions
           FROM billing.package_activations a
           JOIN billing.package_versions v ON v.id = a.package_version_id
          WHERE a.id = $1 AND a.hospital_id = $2
          FOR UPDATE OF a`,
        [activationId, hospital],
      );
      const act = found[0];
      if (act === undefined) throw AppError.notFound('Package activation');
      if (asText(act['status']) !== 'active') {
        throw AppError.conflict('This activation is closed. Charges no longer consume it.');
      }

      const components =
        (act['components'] as { type?: string; ref_id?: string; cap_amount?: string }[] | null) ?? [];
      const exclusions = (act['exclusions'] as { ref_id?: string }[] | null) ?? [];

      const isExcluded = exclusions.some((e) => e.ref_id === body.serviceId);
      const component = components.find((c) => c.ref_id === body.serviceId || c.type === body.componentType);

      const alreadyCovered = asNumber(act['covered_amount']);
      const capAmount = component?.cap_amount === undefined ? null : Number(component.cap_amount);

      let decision: string;
      let covered = 0;
      let patient = 0;
      let ruleRef: string | null = null;

      if (isExcluded) {
        decision = 'excluded';
        patient = body.amount;
        ruleRef = 'exclusions';
      } else if (component === undefined) {
        // Never silently absorbed — see the class note.
        decision = 'excluded';
        patient = body.amount;
        ruleRef = 'no matching component';
      } else if (capAmount === null) {
        decision = 'covered';
        covered = body.amount;
        ruleRef = `component:${component.type ?? 'service'}`;
      } else {
        const headroom = Math.max(0, capAmount - alreadyCovered);
        covered = round2(Math.min(body.amount, headroom));
        patient = round2(body.amount - covered);
        // Over the cap: held off the bill until somebody decides who pays.
        decision = patient > 0 ? (headroom > 0 ? 'capped' : 'excess_pending') : 'covered';
        ruleRef = `cap:${capAmount.toFixed(2)}`;
      }

      const id = newId();
      await tx.query(
        `INSERT INTO billing.package_charge_evaluations
           (id, hospital_id, activation_id, charge_event_id, service_id, amount,
            decision, covered_amount, patient_amount, rule_ref, evaluated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::"billing"."PackageChargeDecision",$8,$9,$10, now())`,
        [
          id,
          hospital,
          activationId,
          body.chargeEventId ?? null,
          body.serviceId ?? null,
          body.amount.toFixed(2),
          decision,
          covered.toFixed(2),
          patient.toFixed(2),
          ruleRef,
        ],
      );

      await tx.query(
        `UPDATE billing.package_activations
            SET covered_amount = covered_amount + $2,
                excess_amount = excess_amount + $3,
                exclusions_amount = exclusions_amount + $4,
                updated_at = now()
          WHERE id = $1`,
        [
          activationId,
          covered.toFixed(2),
          decision === 'excess_pending' || decision === 'capped' ? patient.toFixed(2) : '0',
          decision === 'excluded' ? patient.toFixed(2) : '0',
        ],
      );

      if (capAmount !== null && capAmount > 0) {
        const pctUsed = round2(((alreadyCovered + covered) / capAmount) * 100);
        const crossed = CAP_ALERT_THRESHOLDS.filter(
          (t) => pctUsed >= t && (alreadyCovered / capAmount) * 100 < t,
        );
        for (const threshold of crossed) {
          await this.outbox.publish(
            tx,
            packageEvent('package.cap.threshold', activationId, {
              activationId,
              capName: ruleRef ?? 'cap',
              pctUsed,
              threshold,
            }),
          );
        }
      }

      return {
        id,
        decision,
        amount: body.amount.toFixed(2),
        coveredAmount: covered.toFixed(2),
        patientAmount: patient.toFixed(2),
        ruleRef,
        evaluatedAt: new Date().toISOString(),
      };
    });
  }

  async requestVariance(activationId: string, body: RequestVarianceRequest): Promise<VarianceRequestView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const id = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO billing.package_variance_requests
           (id, hospital_id, activation_id, item_ref, amount, reason_code, justification,
            requested_by, status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6::"billing"."PackageVarianceReason",$7,$8,'pending', now(), now())
         RETURNING *`,
        [
          id,
          this.hospitalId(),
          activationId,
          body.itemRef ?? null,
          body.amount.toFixed(2),
          body.reasonCode,
          body.justification ?? null,
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The variance request could not be raised.');

      await this.outbox.publish(
        tx,
        packageEvent('package.variance.requested', id, {
          requestId: id,
          activationId,
          amount: body.amount.toFixed(2),
          reasonCode: body.reasonCode,
          requestedBy: this.actorId(),
        }),
      );
      return this.toVariance(row);
    });
  }

  /** The database refuses `decision_by = requested_by`, and a decision with no bill action. */
  async decideVariance(id: string, body: DecideVarianceRequest): Promise<VarianceRequestView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE billing.package_variance_requests
            SET status = $3::"billing"."PackageVarianceStatus", decision_by = $4, decided_at = now(),
                bill_action = $5::"billing"."PackageBillAction", updated_at = now()
          WHERE id = $1 AND hospital_id = $2 AND status = 'pending'
          RETURNING *`,
        [id, this.hospitalId(), body.decision, this.actorId(), body.billAction],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict(
          'Only a pending variance can be decided, and never by the person who raised it.',
        );
      }
      await this.outbox.publish(
        tx,
        packageEvent('package.variance.decided', id, {
          requestId: id,
          activationId: asText(row['activation_id']),
          decision: body.decision,
          billAction: body.billAction,
          decisionBy: this.actorId(),
        }),
      );
      await this.audit.write(tx, {
        action: 'update',
        entity: 'billing.package_variance_requests',
        rowId: id,
        businessKey: asText(row['reason_code']),
        dataClass: 'financial',
        reasonText: body.reason,
        before: { status: 'pending' },
        after: { status: body.decision, bill_action: body.billAction },
      });
      return this.toVariance(row);
    });
  }

  private toVariance(r: Record<string, unknown>): VarianceRequestView {
    return {
      id: asText(r['id']),
      activationId: asText(r['activation_id']),
      amount: asText(r['amount']),
      reasonCode: asText(r['reason_code']),
      justification: asTextOrNull(r['justification']),
      status: asText(r['status']),
      requestedBy: asText(r['requested_by']),
      decisionBy: asTextOrNull(r['decision_by']),
      billAction: asTextOrNull(r['bill_action']),
      decidedAt: asTextOrNull(r['decided_at']),
    };
  }

  async listVariances(activationId: string): Promise<Page<VarianceRequestView>> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM billing.package_variance_requests
          WHERE hospital_id = $1 AND ($2::uuid IS NULL OR activation_id = $2)
          ORDER BY created_at DESC LIMIT 100`,
        [this.hospitalId(), activationId === 'all' ? null : activationId],
      );
      return { items: rows.map((r) => this.toVariance(r)), nextCursor: null, hasMore: false };
    });
  }

  /** Settle the difference between what was promised and what was delivered. */
  async closeActivation(id: string, body: CloseActivationRequest): Promise<PackageActivationView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const { rows: pending } = await tx.query<{ n: string }>(
        `SELECT count(*) AS n FROM billing.package_variance_requests
          WHERE activation_id = $1 AND status = 'pending'`,
        [id],
      );
      if (asNumber(pending[0]?.n ?? 0) > 0) {
        throw AppError.conflict(
          `${asText(pending[0]?.n)} variance request(s) are still undecided. Closing now would bill an overrun nobody approved (OP-023 §5).`,
        );
      }

      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE billing.package_activations
            SET status = 'closed', closed_at = now(), updated_at = now()
          WHERE id = $1 AND hospital_id = $2 AND status = 'active'
          RETURNING *`,
        [id, this.hospitalId()],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('Only an active package can be closed.');

      await this.outbox.publish(
        tx,
        packageEvent('package.closed', id, {
          activationId: id,
          coveredAmount: asText(row['covered_amount']),
          excessAmount: asText(row['excess_amount']),
          exclusionsAmount: asText(row['exclusions_amount']),
          closureBillId: asTextOrNull(row['closure_bill_id']),
        }),
      );
      await this.audit.write(tx, {
        action: 'update',
        entity: 'billing.package_activations',
        rowId: id,
        businessKey: id,
        dataClass: 'financial',
        reasonText: body.reason,
        before: { status: 'active' },
        after: { status: 'closed' },
      });
      return this.toActivation(row);
    });
  }
}
