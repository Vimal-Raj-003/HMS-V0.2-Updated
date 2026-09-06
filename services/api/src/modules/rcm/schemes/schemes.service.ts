import { Inject, Injectable } from '@nestjs/common';
import { newId, type Page } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService, type TransactionClient } from '../../../core/db/database.service.js';
import { NumberingService } from '../../../core/numbering/numbering.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import { schemeEvent } from './schemes.events.js';
import { withSchemeErrors } from './schemes.errors.js';
import type {
  AddCasePackageRequest,
  AppealShortfallRequest,
  ApproveWriteOffRequest,
  AssembleClaimRequest,
  AttachDocumentRequest,
  CashAttemptQuery,
  CashCheckRequest,
  CaptureBeneficiaryRequest,
  ClaimQuery,
  CloseSchemeCaseRequest,
  CreateSchemeRequest,
  OpenSchemeCaseRequest,
  PackageQuery,
  RecordClaimDecisionRequest,
  SchemeCaseQuery,
  SchemeQuery,
  ShortfallQuery,
  SubmitClaimRequest,
  UpdateSchemeCaseRequest,
  VerifyBeneficiaryRequest,
} from './schemes.schemas.js';
import type {
  BeneficiaryView,
  CasePackageView,
  CashAttemptView,
  CashCheckView,
  ClaimDetailView,
  ClaimDocumentView,
  ClaimLineView,
  ClaimView,
  SchemeCaseDetailView,
  SchemeCaseView,
  SchemePackageView,
  SchemeView,
  ShortfallView,
} from './schemes.types.js';

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
 * A scheme card number is an identifier the authority treats as sensitive and
 * `docs/04` keeps out of anything a support engineer reads. The desk needs to
 * confirm it against the card in the patient's hand, and the last four digits do
 * that without the payload carrying the whole number.
 */
function maskMemberId(raw: string): string {
  if (raw.length <= 4) return '•'.repeat(raw.length);
  return `${'•'.repeat(Math.min(raw.length - 4, 12))}${raw.slice(-4)}`;
}

function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 86_400_000);
}

/**
 * RC-007 — government schemes.
 *
 * ── The module is one rule with a claim pipeline attached ───────────────────
 *
 * The rule is that a scheme beneficiary tenders no cash, and it is enforced by a
 * trigger on `billing.payment_lines` rather than by anything in this file — see
 * the migration header for why. What this service adds is the half a trigger
 * cannot do: it *records the attempt* before the tender is refused, so the
 * hospital can answer an NHA audit with a count and a list rather than an
 * assurance. A raised exception takes its transaction with it, which is exactly
 * why the evidence has to be written by somebody who is still standing.
 *
 * `checkCash` is therefore the method every collection point calls first. It is
 * not the control — the trigger is — it is the control's voice and its memory.
 *
 * ── Two people, twice ───────────────────────────────────────────────────────
 *
 * `submitClaim` / `recordDecision` and `appealShortfall` /
 * `approveWriteOff` are two `block` pairs. The first stops an invented
 * settlement closing a case nobody then chases; the second stops the person who
 * worked a claim quietly deciding that the money it lost is not worth pursuing.
 *
 * ── The rate is copied, never joined ────────────────────────────────────────
 *
 * `scheme_case_packages` snapshots the HBP rate at selection. The NHA revises
 * the master mid-year, and a claim settles at the rate in force on the day of
 * admission; reading it live would re-price a submitted claim and make our own
 * edit look like the authority short-paying us.
 */
@Injectable()
export class SchemesService {
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

  /**
   * One transaction, and one place where a refusal from the database becomes a
   * refusal the caller can read.
   *
   * Every rule in this module is enforced below the application — the cash
   * block, the immutable rate list, the claim checklist, the write-off's second
   * pair of hands. Without the translation, all of them surface as "something
   * went wrong on our side", which is both untrue and useless to the cashier
   * standing in front of the family.
   */
  private guard<T>(fn: (tx: TransactionClient) => Promise<T>): Promise<T> {
    return withSchemeErrors(() => this.db.withTenant(currentTenantContext(), fn));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Masters
  // ═══════════════════════════════════════════════════════════════════════════

  async listSchemes(query: SchemeQuery): Promise<Page<SchemeView>> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT m.*,
                (SELECT count(*) FROM billing.scheme_packages p
                   JOIN billing.scheme_package_versions v ON v.id = p.version_id
                  WHERE v.scheme_id = m.id AND v.status = 'published' AND p.is_active) AS package_count
           FROM billing.scheme_masters m
          WHERE m.hospital_id = $1
            AND ($2::text IS NULL OR m.type::text = $2)
            AND (NOT $3::boolean OR m.is_active)
          ORDER BY m.code
          LIMIT $4`,
        [this.hospitalId(), query.type ?? null, query.activeOnly, query.limit + 1],
      );
      const page = rows.slice(0, query.limit);
      return {
        items: page.map((r) => this.toScheme(r)),
        nextCursor: null,
        hasMore: rows.length > query.limit,
      };
    });
  }

  private toScheme(r: Record<string, unknown>): SchemeView {
    return {
      id: asText(r['id']),
      code: asText(r['code']),
      name: asText(r['name']),
      type: asText(r['type']),
      authority: asTextOrNull(r['authority']),
      empanelmentNo: asTextOrNull(r['empanelment_no']),
      cashBlockScope: asText(r['cash_block_scope']),
      requiresPreauth: Boolean(r['requires_preauth']),
      claimFormat: asText(r['claim_format']),
      claimWindowDays: asNumber(r['claim_window_days']),
      isActive: Boolean(r['is_active']),
      packageCount: asNumber(r['package_count'] ?? 0),
    };
  }

  async createScheme(body: CreateSchemeRequest): Promise<SchemeView> {
    return this.guard(async (tx) => {
      const id = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO billing.scheme_masters
           (id, hospital_id, code, name, type, authority, state_code, empanelment_no,
            cash_block_scope, requires_preauth, claim_format, claim_window_days,
            effective_from, created_at, created_by, updated_at, updated_by)
         VALUES ($1,$2,$3,$4,$5::"billing"."SchemeType",$6,$7,$8,
                 $9::"billing"."SchemeCashBlockScope",$10,$11::"billing"."SchemeClaimFormat",$12,
                 $13::date, now(),$14, now(),$14)
         ON CONFLICT ("hospital_id","code") DO NOTHING
         RETURNING *`,
        [
          id,
          this.hospitalId(),
          body.code,
          body.name,
          body.type,
          body.authority ?? null,
          body.stateCode ?? null,
          body.empanelmentNo ?? null,
          body.cashBlockScope,
          body.requiresPreauth,
          body.claimFormat,
          body.claimWindowDays,
          body.effectiveFrom,
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict(`A scheme with code "${body.code}" already exists.`);

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'scheme_master',
        rowId: id,
        businessKey: body.code,
        dataClass: 'financial',
        before: null,
        after: { code: body.code, cashBlockScope: body.cashBlockScope },
      });
      return this.toScheme({ ...row, package_count: 0 });
    });
  }

  async listPackages(query: PackageQuery): Promise<Page<SchemePackageView>> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT p.*, m.id AS scheme_id, m.code AS scheme_code
           FROM billing.scheme_packages p
           JOIN billing.scheme_package_versions v ON v.id = p.version_id
           JOIN billing.scheme_masters m ON m.id = v.scheme_id
          WHERE p.hospital_id = $1
            AND v.status = 'published'
            AND p.is_active
            AND ($2::uuid IS NULL OR m.id = $2)
            AND ($3::text IS NULL OR p.package_code ILIKE '%'||$3||'%' OR p.name ILIKE '%'||$3||'%')
          ORDER BY m.code, p.package_code
          LIMIT $4`,
        [this.hospitalId(), query.schemeId ?? null, query.search ?? null, query.limit + 1],
      );
      const page = rows.slice(0, query.limit);
      return {
        items: page.map((r) => ({
          id: asText(r['id']),
          schemeId: asText(r['scheme_id']),
          schemeCode: asText(r['scheme_code']),
          packageCode: asText(r['package_code']),
          name: asText(r['name']),
          specialty: asTextOrNull(r['specialty']),
          procedureType: asText(r['procedure_type']),
          baseRate: asText(r['base_rate']),
          implantAllowed: Boolean(r['implant_allowed']),
          implantCap: asTextOrNull(r['implant_cap']),
          preAuthRequired: Boolean(r['pre_auth_required']),
          losDays: r['los_days'] === null ? null : asNumber(r['los_days']),
        })),
        nextCursor: null,
        hasMore: rows.length > query.limit,
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Beneficiaries
  // ═══════════════════════════════════════════════════════════════════════════

  async listBeneficiaries(patientId: string): Promise<Page<BeneficiaryView>> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT b.*, m.code AS scheme_code, m.name AS scheme_name, m.cash_block_scope, m.is_active AS scheme_active,
                EXISTS (SELECT 1 FROM billing.scheme_cases c
                         WHERE c.beneficiary_id = b.id AND c.status NOT IN ('closed','rejected')) AS has_open_case
           FROM billing.scheme_beneficiaries b
           JOIN billing.scheme_masters m ON m.id = b.scheme_id
          WHERE b.hospital_id = $1 AND b.patient_id = $2
          ORDER BY m.code`,
        [this.hospitalId(), patientId],
      );
      return { items: rows.map((r) => this.toBeneficiary(r)), nextCursor: null, hasMore: false };
    });
  }

  private toBeneficiary(r: Record<string, unknown>): BeneficiaryView {
    const scope = asText(r['cash_block_scope']);
    const status = asText(r['status']);
    const validTill = asDay(r['valid_till']);
    const validFrom = asDay(r['valid_from']);
    const today = new Date().toISOString().slice(0, 10);
    const inDate = (validFrom === null || validFrom <= today) && (validTill === null || validTill >= today);
    // Mirrors the trigger's predicate exactly. Two different answers to "is this
    // patient blocked?" would be worse than none: the screen would say one thing
    // and the counter would do another.
    const blocksCash =
      Boolean(r['scheme_active']) &&
      status === 'verified' &&
      inDate &&
      (scope === 'always' || (scope === 'active_case' && Boolean(r['has_open_case'])));

    return {
      id: asText(r['id']),
      patientId: asText(r['patient_id']),
      schemeId: asText(r['scheme_id']),
      schemeCode: asText(r['scheme_code']),
      schemeName: asText(r['scheme_name']),
      memberIdMasked: maskMemberId(asText(r['member_id'])),
      nameOnCard: asTextOrNull(r['name_on_card']),
      relation: asText(r['relation']),
      entitlementAmount: asText(r['entitlement_amount']),
      entitlementBalance: asText(r['entitlement_balance']),
      validFrom,
      validTill,
      status,
      verifiedAt: asTextOrNull(r['verified_at']),
      verificationMethod: asTextOrNull(r['verification_method']),
      blocksCash,
    };
  }

  async captureBeneficiary(body: CaptureBeneficiaryRequest): Promise<BeneficiaryView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();
      const id = newId();

      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO billing.scheme_beneficiaries
           (id, hospital_id, scheme_id, patient_id, member_id, family_id, name_on_card, relation,
            valid_from, valid_till, status, created_at, created_by, updated_at, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10::date,'unverified', now(),$11, now(),$11)
         RETURNING *`,
        [
          id,
          hospital,
          body.schemeId,
          body.patientId,
          body.memberId,
          body.familyId ?? null,
          body.nameOnCard ?? null,
          body.relation,
          body.validFrom ?? null,
          body.validTill ?? null,
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The scheme card could not be recorded.');

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'scheme_beneficiary',
        rowId: id,
        businessKey: maskMemberId(body.memberId),
        dataClass: 'phi',
        before: null,
        after: { schemeId: body.schemeId, status: 'unverified' },
      });

      return this.loadBeneficiary(tx, id);
    });
  }

  private async loadBeneficiary(tx: TransactionClient, id: string): Promise<BeneficiaryView> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT b.*, m.code AS scheme_code, m.name AS scheme_name, m.cash_block_scope, m.is_active AS scheme_active,
              EXISTS (SELECT 1 FROM billing.scheme_cases c
                       WHERE c.beneficiary_id = b.id AND c.status NOT IN ('closed','rejected')) AS has_open_case
         FROM billing.scheme_beneficiaries b
         JOIN billing.scheme_masters m ON m.id = b.scheme_id
        WHERE b.id = $1 AND b.hospital_id = $2`,
      [id, this.hospitalId()],
    );
    const row = rows[0];
    if (row === undefined) throw AppError.notFound('Scheme beneficiary');
    return this.toBeneficiary(row);
  }

  /**
   * Record what the authority said.
   *
   * A `verified` outcome is the moment the cash block turns on for this patient,
   * so it writes the entitlement, the validity window and an append-only
   * verification row in one transaction. Anything else marks the entitlement
   * unusable and says so loudly — a family told at discharge that their card was
   * never valid is the failure this exists to prevent.
   */
  async verifyBeneficiary(id: string, body: VerifyBeneficiaryRequest): Promise<BeneficiaryView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();

      const { rows: before } = await tx.query<Record<string, unknown>>(
        `SELECT b.*, m.code AS scheme_code FROM billing.scheme_beneficiaries b
           JOIN billing.scheme_masters m ON m.id = b.scheme_id
          WHERE b.id = $1 AND b.hospital_id = $2 FOR UPDATE OF b`,
        [id, hospital],
      );
      const prior = before[0];
      if (prior === undefined) throw AppError.notFound('Scheme beneficiary');

      const verified = body.outcome === 'verified';
      const status = verified
        ? 'verified'
        : body.outcome === 'expired'
          ? 'expired'
          : body.outcome === 'mismatch'
            ? 'mismatch'
            : 'rejected';

      await tx.query(
        `UPDATE billing.scheme_beneficiaries
            SET status = $3::"billing"."SchemeBeneficiaryStatus",
                entitlement_amount = COALESCE($4::numeric, entitlement_amount),
                entitlement_balance = COALESCE($5::numeric, entitlement_balance),
                valid_from = COALESCE($6::date, valid_from),
                valid_till = COALESCE($7::date, valid_till),
                verified_at = CASE WHEN $8::boolean THEN now() ELSE NULL END,
                verified_by = CASE WHEN $8::boolean THEN $9::uuid ELSE NULL END,
                verification_method = CASE WHEN $8::boolean THEN $10::"billing"."SchemeVerificationMethod" ELSE NULL END,
                verification_ref = $11,
                updated_at = now(), updated_by = $9
          WHERE id = $1 AND hospital_id = $2`,
        [
          id,
          hospital,
          status,
          body.entitlementAmount === undefined ? null : body.entitlementAmount.toFixed(2),
          body.entitlementBalance === undefined ? null : body.entitlementBalance.toFixed(2),
          body.validFrom ?? null,
          body.validTill ?? null,
          verified,
          this.actorId(),
          body.method,
          body.verificationRef ?? null,
        ],
      );

      await tx.query(
        `INSERT INTO billing.scheme_verifications
           (id, hospital_id, beneficiary_id, method, outcome, request_ref, response, message,
            balance_reported, at, by_id)
         VALUES ($1,$2,$3,$4::"billing"."SchemeVerificationMethod",$5::"billing"."SchemeVerificationOutcome",
                 $6,'{}'::jsonb,$7,$8::numeric, now(),$9)`,
        [
          newId(),
          hospital,
          id,
          body.method,
          body.outcome,
          body.verificationRef ?? null,
          body.message ?? null,
          body.entitlementBalance === undefined ? null : body.entitlementBalance.toFixed(2),
          this.actorId(),
        ],
      );

      const view = await this.loadBeneficiary(tx, id);

      await this.audit.write(tx, {
        action: 'update',
        entity: 'scheme_beneficiary',
        rowId: id,
        businessKey: view.memberIdMasked,
        dataClass: 'phi',
        before: { status: asText(prior['status']) },
        after: { status, outcome: body.outcome },
      });

      await this.outbox.publish(
        tx,
        verified
          ? schemeEvent('scheme.beneficiary.verified', id, {
              beneficiaryId: id,
              patientId: view.patientId,
              schemeId: view.schemeId,
              schemeCode: view.schemeCode,
              entitlementBalance: view.entitlementBalance,
              method: body.method,
            })
          : schemeEvent('scheme.beneficiary.rejected', id, {
              beneficiaryId: id,
              patientId: view.patientId,
              schemeCode: view.schemeCode,
              outcome: body.outcome,
            }),
      );

      return view;
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Cases
  // ═══════════════════════════════════════════════════════════════════════════

  async listCases(query: SchemeCaseQuery): Promise<Page<SchemeCaseView>> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT c.*, m.code AS scheme_code
           FROM billing.scheme_cases c
           JOIN billing.scheme_masters m ON m.id = c.scheme_id
          WHERE c.hospital_id = $1
            AND ($2::text IS NULL OR c.status::text = $2)
            AND ($3::uuid IS NULL OR c.patient_id = $3)
            AND ($4::uuid IS NULL OR c.scheme_id = $4)
          ORDER BY c.created_at DESC
          LIMIT $5`,
        [
          this.hospitalId(),
          query.status ?? null,
          query.patientId ?? null,
          query.schemeId ?? null,
          query.limit + 1,
        ],
      );
      const page = rows.slice(0, query.limit);
      return {
        items: page.map((r) => this.toCase(r)),
        nextCursor: null,
        hasMore: rows.length > query.limit,
      };
    });
  }

  private toCase(r: Record<string, unknown>): SchemeCaseView {
    return {
      id: asText(r['id']),
      caseNo: asText(r['case_no']),
      schemeId: asText(r['scheme_id']),
      schemeCode: asText(r['scheme_code'] ?? ''),
      patientId: asText(r['patient_id']),
      beneficiaryId: asText(r['beneficiary_id']),
      encounterId: asTextOrNull(r['encounter_id']),
      status: asText(r['status']),
      authorityCaseNo: asTextOrNull(r['authority_case_no']),
      admittedAt: asTextOrNull(r['admitted_at']),
      dischargedAt: asTextOrNull(r['discharged_at']),
      packageAmount: asText(r['package_amount']),
      claimedAmount: asText(r['claimed_amount']),
      settledAmount: asText(r['settled_amount']),
      shortfallAmount: asText(r['shortfall_amount']),
      createdAt: asText(r['created_at']),
    };
  }

  /**
   * Open a case, which is the moment the cash block starts for this patient.
   *
   * Refused unless the entitlement is verified. Opening a case on an unverified
   * card would stop the counters taking money from somebody who may turn out not
   * to be covered at all, and the family would be sent away rather than simply
   * asked to pay.
   */
  async openCase(body: OpenSchemeCaseRequest): Promise<SchemeCaseView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();
      const branch = this.branchId();

      const { rows: bens } = await tx.query<Record<string, unknown>>(
        `SELECT b.*, m.code AS scheme_code, m.name AS scheme_name
           FROM billing.scheme_beneficiaries b
           JOIN billing.scheme_masters m ON m.id = b.scheme_id
          WHERE b.id = $1 AND b.hospital_id = $2 AND b.scheme_id = $3`,
        [body.beneficiaryId, hospital, body.schemeId],
      );
      const ben = bens[0];
      if (ben === undefined) throw AppError.notFound('Scheme beneficiary');
      if (asText(ben['status']) !== 'verified') {
        throw AppError.conflict(
          'This scheme card has not been verified with the authority. Verify it before opening a case — an unverified card that turns out to be invalid leaves the family with a bill nobody warned them about.',
        );
      }

      const id = newId();
      const allocation = await this.numbering.allocate(tx, {
        key: 'SCHEME_CASE',
        branchId: branch,
        refType: 'scheme_case',
        refId: id,
      });

      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO billing.scheme_cases
           (id, hospital_id, branch_id, case_no, scheme_id, beneficiary_id, patient_id,
            encounter_id, admission_id, status, admitted_at, created_at, created_by, updated_at, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'open',$10::timestamptz, now(),$11, now(),$11)
         RETURNING *`,
        [
          id,
          hospital,
          branch,
          allocation.formatted,
          body.schemeId,
          body.beneficiaryId,
          asText(ben['patient_id']),
          body.encounterId ?? null,
          body.admissionId ?? null,
          body.admittedAt ?? null,
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The scheme case could not be opened.');

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'scheme_case',
        rowId: id,
        businessKey: allocation.formatted,
        dataClass: 'financial',
        before: null,
        after: { schemeCode: asText(ben['scheme_code']), status: 'open' },
      });

      await this.outbox.publish(
        tx,
        schemeEvent('scheme.case.opened', id, {
          caseId: id,
          caseNo: allocation.formatted,
          patientId: asText(ben['patient_id']),
          schemeId: body.schemeId,
          schemeCode: asText(ben['scheme_code']),
          encounterId: body.encounterId ?? null,
        }),
      );

      return this.toCase({ ...row, scheme_code: asText(ben['scheme_code']) });
    });
  }

  async getCase(id: string): Promise<SchemeCaseDetailView> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT c.*, m.code AS scheme_code
           FROM billing.scheme_cases c
           JOIN billing.scheme_masters m ON m.id = c.scheme_id
          WHERE c.id = $1 AND c.hospital_id = $2`,
        [id, this.hospitalId()],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.notFound('Scheme case');

      const { rows: pkgs } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM billing.scheme_case_packages WHERE case_id = $1 ORDER BY is_primary DESC, package_code`,
        [id],
      );
      const { rows: claims } = await tx.query<Record<string, unknown>>(
        `SELECT cl.*, c.case_no, m.code AS scheme_code
           FROM billing.scheme_claims cl
           JOIN billing.scheme_cases c ON c.id = cl.case_id
           JOIN billing.scheme_masters m ON m.id = c.scheme_id
          WHERE cl.case_id = $1 ORDER BY cl.created_at DESC`,
        [id],
      );

      return {
        ...this.toCase(row),
        packages: pkgs.map((p) => this.toCasePackage(p)),
        claims: claims.map((c) => this.toClaim(c)),
      };
    });
  }

  private toCasePackage(r: Record<string, unknown>): CasePackageView {
    return {
      id: asText(r['id']),
      packageCode: asText(r['package_code']),
      packageName: asText(r['package_name']),
      rate: asText(r['rate']),
      quantity: asNumber(r['quantity']),
      amount: asText(r['amount']),
      implantAmount: asText(r['implant_amount']),
      isPrimary: Boolean(r['is_primary']),
      approved: Boolean(r['approved']),
    };
  }

  /** Snapshots the rate. See the class comment for why it is copied, not joined. */
  async addCasePackage(caseId: string, body: AddCasePackageRequest): Promise<CasePackageView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();

      const { rows: cases } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM billing.scheme_cases WHERE id = $1 AND hospital_id = $2 FOR UPDATE`,
        [caseId, hospital],
      );
      const kase = cases[0];
      if (kase === undefined) throw AppError.notFound('Scheme case');
      if (['closed', 'rejected', 'settled'].includes(asText(kase['status']))) {
        throw AppError.conflict('This case is finished. Packages cannot be added to it.');
      }

      const { rows: pkgs } = await tx.query<Record<string, unknown>>(
        `SELECT p.* FROM billing.scheme_packages p
           JOIN billing.scheme_package_versions v ON v.id = p.version_id
          WHERE p.id = $1 AND p.hospital_id = $2 AND v.status = 'published' AND p.is_active`,
        [body.packageId, hospital],
      );
      const pkg = pkgs[0];
      if (pkg === undefined) throw AppError.notFound('Scheme package');

      const rate = asText(pkg['base_rate']);
      const amount = (Number(rate) * body.quantity).toFixed(2);
      const id = newId();

      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO billing.scheme_case_packages
           (id, hospital_id, case_id, package_id, package_code, package_name,
            rate, quantity, amount, implant_amount, is_primary, created_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7::numeric,$8,$9::numeric,$10::numeric,$11, now(),$12)
         RETURNING *`,
        [
          id,
          hospital,
          caseId,
          body.packageId,
          asText(pkg['package_code']),
          asText(pkg['name']),
          rate,
          body.quantity,
          amount,
          body.implantAmount.toFixed(2),
          body.isPrimary,
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The package could not be added.');

      await tx.query(
        `UPDATE billing.scheme_cases
            SET package_amount = (SELECT COALESCE(sum(amount + implant_amount), 0)
                                    FROM billing.scheme_case_packages WHERE case_id = $1),
                updated_at = now(), updated_by = $2
          WHERE id = $1`,
        [caseId, this.actorId()],
      );

      return this.toCasePackage(row);
    });
  }

  async updateCase(id: string, body: UpdateSchemeCaseRequest): Promise<SchemeCaseView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();
      if (body.status === 'closed') {
        throw AppError.conflict(
          'Closing a case lifts the cash block, so it has its own endpoint and its own permission.',
        );
      }

      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE billing.scheme_cases
            SET status = COALESCE($3::"billing"."SchemeCaseStatus", status),
                authority_case_no = COALESCE($4, authority_case_no),
                admitted_at = COALESCE($5::timestamptz, admitted_at),
                discharged_at = COALESCE($6::timestamptz, discharged_at),
                updated_at = now(), updated_by = $7
          WHERE id = $1 AND hospital_id = $2 AND status NOT IN ('closed','rejected')
          RETURNING *`,
        [
          id,
          hospital,
          body.status ?? null,
          body.authorityCaseNo ?? null,
          body.admittedAt ?? null,
          body.dischargedAt ?? null,
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('Only an open scheme case can be updated.');
      return this.toCase(row);
    });
  }

  /**
   * Close the case.
   *
   * This lifts the cash block, so it is its own permission and it refuses while
   * a claim is still in flight: a case closed with an unsettled claim is money
   * nobody is chasing and a patient who can now be charged for an episode the
   * scheme may still pay for.
   */
  async closeCase(id: string, body: CloseSchemeCaseRequest): Promise<SchemeCaseView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();

      // "Unsettled" means *with the authority*, not "not finished". A draft is
      // our own paperwork and nobody is waiting on it, so counting drafts here
      // would leave a case that can never be closed: a draft cannot be submitted
      // without its documents and cannot be decided at all. Discard it instead.
      const { rows: open } = await tx.query<{ n: string }>(
        `SELECT count(*) AS n FROM billing.scheme_claims
          WHERE case_id = $1 AND status IN ('submitted','queried','approved','partially_approved')`,
        [id],
      );
      if (asNumber(open[0]?.n ?? 0) > 0) {
        throw AppError.conflict(
          'A claim on this case is still with the authority. Closing the case now would lift the cash block on an episode the scheme may still pay for.',
        );
      }

      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE billing.scheme_cases
            SET status = 'closed', closed_at = now(), updated_at = now(), updated_by = $3
          WHERE id = $1 AND hospital_id = $2 AND status NOT IN ('closed','rejected')
          RETURNING *`,
        [id, hospital, this.actorId()],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('This case is already closed.');

      await this.audit.write(tx, {
        action: 'update',
        entity: 'scheme_case',
        rowId: id,
        businessKey: asText(row['case_no']),
        dataClass: 'financial',
        before: { status: 'open' },
        after: { status: 'closed' },
        reasonText: body.reason,
      });

      await this.outbox.publish(
        tx,
        schemeEvent('scheme.case.closed', id, {
          caseId: id,
          caseNo: asText(row['case_no']),
          patientId: asText(row['patient_id']),
          settledAmount: asText(row['settled_amount']),
          shortfallAmount: asText(row['shortfall_amount']),
        }),
      );

      return this.toCase(row);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The cash block — exit gate 6
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Ask whether this patient may tender cash, and remember the answer.
   *
   * Called by every collection point *before* the drawer opens. The database
   * trigger on `payment_lines` is the actual guarantee; this method exists
   * because a raised exception rolls back its own transaction and so cannot
   * write the evidence. Two things follow from that:
   *
   *   1. The refusal is recorded here, in its own transaction, and survives
   *      whatever the caller does next.
   *   2. The blocking predicate below must match the trigger's exactly. A screen
   *      that says "allowed" and a counter that then refuses is worse than
   *      either answer alone, so the two are kept deliberately identical — the
   *      trigger is in the migration's §B.1 and this is its mirror.
   *
   * The query is deliberately wider than the trigger's, matching any live
   * entitlement including a scheme whose scope is `off`. `off` means the scheme
   * permits a co-payment, and the tender goes through — but it is still a scheme
   * patient handing over money, so the attempt is logged as `allowed_advisory`.
   * Without that row `off` would be indistinguishable from having no scheme at
   * all, and the setting would buy the hospital nothing.
   */
  async checkCash(body: CashCheckRequest): Promise<CashCheckView> {
    const physical = body.mode === 'cash' || body.mode === 'forex';

    return this.guard(async (tx) => {
      const hospital = this.hospitalId();

      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT m.id AS scheme_id, m.code AS scheme_code, m.name AS scheme_name,
                m.cash_block_scope,
                (m.cash_block_scope = 'always'
                 OR (m.cash_block_scope = 'active_case'
                     AND EXISTS (SELECT 1 FROM billing.scheme_cases c
                                  WHERE c.beneficiary_id = b.id
                                    AND c.status NOT IN ('closed','rejected')))) AS blocks,
                (SELECT c.case_no FROM billing.scheme_cases c
                  WHERE c.beneficiary_id = b.id AND c.status NOT IN ('closed','rejected')
                  ORDER BY c.created_at DESC LIMIT 1) AS case_no,
                (SELECT c.id FROM billing.scheme_cases c
                  WHERE c.beneficiary_id = b.id AND c.status NOT IN ('closed','rejected')
                  ORDER BY c.created_at DESC LIMIT 1) AS case_id
           FROM billing.scheme_beneficiaries b
           JOIN billing.scheme_masters m ON m.id = b.scheme_id
          WHERE b.patient_id = $1
            AND b.hospital_id = $2
            AND b.status = 'verified'
            AND (b.valid_from IS NULL OR b.valid_from <= CURRENT_DATE)
            AND (b.valid_till IS NULL OR b.valid_till >= CURRENT_DATE)
            AND m.is_active
          ORDER BY (m.cash_block_scope <> 'off') DESC
          LIMIT 1`,
        [body.patientId, hospital],
      );
      const hit = rows[0];

      if (hit === undefined || !physical) {
        return {
          allowed: true,
          schemeCode: null,
          schemeName: null,
          caseNo: null,
          reason: physical
            ? 'No scheme is paying for this patient today.'
            : `A ${body.mode} tender is not cash; a scheme case does not block it.`,
          attemptId: null,
        };
      }

      const blocks = Boolean(hit['blocks']);
      const schemeCode = asText(hit['scheme_code']);
      const schemeName = asText(hit['scheme_name']);
      const caseNo = asTextOrNull(hit['case_no']);

      // A live card whose scheme does not block: no case open under an
      // `active_case` scheme, and nothing to record.
      if (!blocks && asText(hit['cash_block_scope']) !== 'off') {
        return {
          allowed: true,
          schemeCode: null,
          schemeName: null,
          caseNo: null,
          reason: 'No scheme is paying for this patient today.',
          attemptId: null,
        };
      }

      const attemptId = newId();
      const reason = blocks
        ? `${schemeName} is paying for this episode${
            caseNo === null ? '' : ` (case ${caseNo})`
          }. A scheme patient tenders no cash.`
        : `${schemeName} permits a co-payment, so this tender was allowed. It is recorded because a scheme patient still handed over money.`;

      await tx.query(
        `INSERT INTO billing.scheme_cash_attempts
           (id, hospital_id, branch_id, patient_id, scheme_id, case_id,
            collection_point, mode, amount, outcome, reason, attempted_at, attempted_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::numeric,$10,$11, now(),$12)`,
        [
          attemptId,
          hospital,
          this.branchId(),
          body.patientId,
          asText(hit['scheme_id']),
          hit['case_id'] ?? null,
          body.collectionPoint,
          body.mode,
          body.amount.toFixed(2),
          blocks ? 'blocked' : 'allowed_advisory',
          reason,
          this.actorId(),
        ],
      );

      // Only a refusal is an event. An advisory row is a note in the log, not a
      // fact other modules need to react to.
      if (blocks) {
        await this.outbox.publish(
          tx,
          schemeEvent('scheme.cash.refused', attemptId, {
            attemptId,
            patientId: body.patientId,
            schemeCode,
            collectionPoint: body.collectionPoint,
            mode: body.mode,
            amount: body.amount.toFixed(2),
          }),
        );
      }

      return { allowed: !blocks, schemeCode, schemeName, caseNo, reason, attemptId };
    });
  }

  async listCashAttempts(query: CashAttemptQuery): Promise<Page<CashAttemptView>> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT a.*, m.code AS scheme_code
           FROM billing.scheme_cash_attempts a
           JOIN billing.scheme_masters m ON m.id = a.scheme_id
          WHERE a.hospital_id = $1
            AND ($2::uuid IS NULL OR a.patient_id = $2)
            AND ($3::uuid IS NULL OR a.scheme_id = $3)
          ORDER BY a.attempted_at DESC
          LIMIT $4`,
        [this.hospitalId(), query.patientId ?? null, query.schemeId ?? null, query.limit + 1],
      );
      const page = rows.slice(0, query.limit);
      return {
        items: page.map((r) => ({
          id: asText(r['id']),
          patientId: asText(r['patient_id']),
          schemeId: asText(r['scheme_id']),
          schemeCode: asText(r['scheme_code']),
          collectionPoint: asText(r['collection_point']),
          mode: asText(r['mode']),
          amount: asText(r['amount']),
          outcome: asText(r['outcome']),
          reason: asText(r['reason']),
          attemptedAt: asText(r['attempted_at']),
        })),
        nextCursor: null,
        hasMore: rows.length > query.limit,
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Claims
  // ═══════════════════════════════════════════════════════════════════════════

  async listClaims(query: ClaimQuery): Promise<Page<ClaimView>> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT cl.*, c.case_no, m.code AS scheme_code
           FROM billing.scheme_claims cl
           JOIN billing.scheme_cases c ON c.id = cl.case_id
           JOIN billing.scheme_masters m ON m.id = c.scheme_id
          WHERE cl.hospital_id = $1
            AND ($2::text IS NULL OR cl.status::text = $2)
            AND ($3::uuid IS NULL OR cl.case_id = $3)
          ORDER BY cl.created_at DESC
          LIMIT $4`,
        [this.hospitalId(), query.status ?? null, query.caseId ?? null, query.limit + 1],
      );
      const page = rows.slice(0, query.limit);
      return {
        items: page.map((r) => this.toClaim(r)),
        nextCursor: null,
        hasMore: rows.length > query.limit,
      };
    });
  }

  private toClaim(r: Record<string, unknown>): ClaimView {
    const closesOn = asDay(r['window_closes_on']);
    return {
      id: asText(r['id']),
      claimNo: asText(r['claim_no']),
      caseId: asText(r['case_id']),
      caseNo: asTextOrNull(r['case_no']),
      schemeCode: asTextOrNull(r['scheme_code']),
      format: asText(r['format']),
      status: asText(r['status']),
      claimedAmount: asText(r['claimed_amount']),
      approvedAmount: asText(r['approved_amount']),
      paidAmount: asText(r['paid_amount']),
      shortfallAmount: asText(r['shortfall_amount']),
      windowClosesOn: closesOn,
      daysLeftInWindow: closesOn === null ? null : daysBetween(new Date(), new Date(closesOn)),
      submittedAt: asTextOrNull(r['submitted_at']),
      paidAt: asTextOrNull(r['paid_at']),
      authorityClaimNo: asTextOrNull(r['authority_claim_no']),
      utr: asTextOrNull(r['utr']),
    };
  }

  /**
   * Build the claim from the case, one line per package, plus the checklist.
   *
   * The checklist rows are created empty on purpose: the database refuses
   * submission while any mandatory one has no file, so the incomplete claim is
   * visible as a list of gaps from the moment it is assembled rather than as a
   * rejection thirty days later.
   */
  async assembleClaim(body: AssembleClaimRequest): Promise<ClaimDetailView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();
      const branch = this.branchId();

      const { rows: cases } = await tx.query<Record<string, unknown>>(
        `SELECT c.*, m.claim_format, m.claim_window_days, m.code AS scheme_code
           FROM billing.scheme_cases c
           JOIN billing.scheme_masters m ON m.id = c.scheme_id
          WHERE c.id = $1 AND c.hospital_id = $2 FOR UPDATE OF c`,
        [body.caseId, hospital],
      );
      const kase = cases[0];
      if (kase === undefined) throw AppError.notFound('Scheme case');

      const { rows: pkgs } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM billing.scheme_case_packages WHERE case_id = $1 ORDER BY is_primary DESC, package_code`,
        [body.caseId],
      );
      if (pkgs.length === 0) {
        throw AppError.conflict('This case has no packages, so there is nothing to claim.');
      }

      const id = newId();
      const allocation = await this.numbering.allocate(tx, {
        key: 'SCHEME_CLAIM',
        branchId: branch,
        refType: 'scheme_claim',
        refId: id,
      });

      const claimed = pkgs
        .reduce((sum, p) => sum + Number(asText(p['amount'])) + Number(asText(p['implant_amount'])), 0)
        .toFixed(2);

      // The window runs from discharge; a case still in treatment has no
      // discharge date yet, so the deadline appears when the patient leaves.
      const discharged = asTextOrNull(kase['discharged_at']);
      const windowCloses =
        discharged === null
          ? null
          : new Date(new Date(discharged).getTime() + asNumber(kase['claim_window_days']) * 86_400_000)
              .toISOString()
              .slice(0, 10);

      await tx.query(
        `INSERT INTO billing.scheme_claims
           (id, hospital_id, branch_id, claim_no, case_id, format, status, claimed_amount,
            window_closes_on, created_at, created_by, updated_at, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6::"billing"."SchemeClaimFormat",'draft',$7::numeric,$8::date,
                 now(),$9, now(),$9)`,
        [
          id,
          hospital,
          branch,
          allocation.formatted,
          body.caseId,
          asText(kase['claim_format']),
          claimed,
          windowCloses,
          this.actorId(),
        ],
      );

      for (const p of pkgs) {
        const base = Number(asText(p['amount']));
        const implant = Number(asText(p['implant_amount']));
        await tx.query(
          `INSERT INTO billing.scheme_claim_lines
             (id, hospital_id, claim_id, package_code, description, quantity, rate, claimed_amount, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7::numeric,$8::numeric, now())`,
          [
            newId(),
            hospital,
            id,
            asText(p['package_code']),
            asText(p['package_name']),
            asNumber(p['quantity']),
            asText(p['rate']),
            base.toFixed(2),
          ],
        );
        // The implant is its own line. The authority disallows implants on their
        // own terms, and a deduction against a combined line cannot be appealed
        // without first arguing about which half it came out of.
        if (implant > 0) {
          await tx.query(
            `INSERT INTO billing.scheme_claim_lines
               (id, hospital_id, claim_id, package_code, description, quantity, rate, claimed_amount, created_at)
             VALUES ($1,$2,$3,$4,$5,1,$6::numeric,$6::numeric, now())`,
            [
              newId(),
              hospital,
              id,
              `${asText(p['package_code'])}-IMPL`,
              `Implant — ${asText(p['package_name'])}`,
              implant.toFixed(2),
            ],
          );
        }
      }

      for (const docType of body.requiredDocuments) {
        await tx.query(
          `INSERT INTO billing.scheme_claim_documents
             (id, hospital_id, claim_id, doc_type, is_mandatory, created_at)
           VALUES ($1,$2,$3,$4,true, now())
           ON CONFLICT ("claim_id","doc_type") DO NOTHING`,
          [newId(), hospital, id, docType],
        );
      }

      await tx.query(
        `UPDATE billing.scheme_cases SET claimed_amount = $2::numeric, updated_at = now() WHERE id = $1`,
        [body.caseId, claimed],
      );

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'scheme_claim',
        rowId: id,
        businessKey: allocation.formatted,
        dataClass: 'financial',
        before: null,
        after: { caseNo: asText(kase['case_no']), claimedAmount: claimed },
      });

      return this.getClaimIn(tx, id);
    });
  }

  async attachDocument(claimId: string, body: AttachDocumentRequest): Promise<ClaimDetailView> {
    return this.guard(async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE billing.scheme_claim_documents
            SET file_id = $3, uploaded_at = now(), uploaded_by = $4
          WHERE claim_id = $1 AND doc_type = $2 AND hospital_id = $5`,
        [claimId, body.docType, body.fileId, this.actorId(), this.hospitalId()],
      );
      if (rowCount === 0) {
        throw AppError.notFound('Claim document');
      }
      return this.getClaimIn(tx, claimId);
    });
  }

  async getClaim(id: string): Promise<ClaimDetailView> {
    return this.guard((tx) => this.getClaimIn(tx, id));
  }

  private async getClaimIn(tx: TransactionClient, id: string): Promise<ClaimDetailView> {
    const hospital = this.hospitalId();
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT cl.*, c.case_no, m.code AS scheme_code
         FROM billing.scheme_claims cl
         JOIN billing.scheme_cases c ON c.id = cl.case_id
         JOIN billing.scheme_masters m ON m.id = c.scheme_id
        WHERE cl.id = $1 AND cl.hospital_id = $2`,
      [id, hospital],
    );
    const row = rows[0];
    if (row === undefined) throw AppError.notFound('Scheme claim');

    const { rows: lines } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM billing.scheme_claim_lines WHERE claim_id = $1 ORDER BY package_code`,
      [id],
    );
    const { rows: docs } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM billing.scheme_claim_documents WHERE claim_id = $1 ORDER BY doc_type`,
      [id],
    );
    const { rows: shorts } = await tx.query<Record<string, unknown>>(
      `SELECT s.*, cl.claim_no FROM billing.scheme_shortfalls s
         JOIN billing.scheme_claims cl ON cl.id = s.claim_id
        WHERE s.claim_id = $1 ORDER BY s.created_at DESC`,
      [id],
    );

    const documents: ClaimDocumentView[] = docs.map((d) => ({
      id: asText(d['id']),
      docType: asText(d['doc_type']),
      isMandatory: Boolean(d['is_mandatory']),
      attached: d['file_id'] !== null && d['file_id'] !== undefined,
      uploadedAt: asTextOrNull(d['uploaded_at']),
    }));

    return {
      ...this.toClaim(row),
      lines: lines.map((l) => this.toClaimLine(l)),
      documents,
      shortfalls: shorts.map((s) => this.toShortfall(s)),
      missingDocuments: documents.filter((d) => d.isMandatory && !d.attached).map((d) => d.docType),
    };
  }

  private toClaimLine(r: Record<string, unknown>): ClaimLineView {
    return {
      id: asText(r['id']),
      packageCode: asText(r['package_code']),
      description: asText(r['description']),
      quantity: asNumber(r['quantity']),
      rate: asText(r['rate']),
      claimedAmount: asText(r['claimed_amount']),
      approvedAmount: asText(r['approved_amount']),
      disallowedAmount: asText(r['disallowed_amount']),
      disallowReason: asTextOrNull(r['disallow_reason']),
      decidedAt: asTextOrNull(r['decided_at']),
    };
  }

  async submitClaim(id: string, body: SubmitClaimRequest): Promise<ClaimDetailView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();

      const { rows: before } = await tx.query<Record<string, unknown>>(
        `SELECT cl.*, c.case_no, m.code AS scheme_code
           FROM billing.scheme_claims cl
           JOIN billing.scheme_cases c ON c.id = cl.case_id
           JOIN billing.scheme_masters m ON m.id = c.scheme_id
          WHERE cl.id = $1 AND cl.hospital_id = $2 FOR UPDATE OF cl`,
        [id, hospital],
      );
      const prior = before[0];
      if (prior === undefined) throw AppError.notFound('Scheme claim');
      if (!['draft', 'assembled'].includes(asText(prior['status']))) {
        throw AppError.conflict('This claim has already been submitted.');
      }

      // The database refuses this anyway (§B.10). Checking first turns a raw
      // constraint error into a list of what is actually missing.
      const { rows: missing } = await tx.query<{ doc_type: string }>(
        `SELECT doc_type FROM billing.scheme_claim_documents
          WHERE claim_id = $1 AND is_mandatory AND file_id IS NULL ORDER BY doc_type`,
        [id],
      );
      if (missing.length > 0) {
        throw AppError.conflict(
          `This claim is missing ${missing.map((m) => m.doc_type).join(', ')}. The authority rejects an incomplete pack, and a rejection can cost the whole claim window.`,
        );
      }

      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE billing.scheme_claims
            SET status = 'submitted', submitted_at = now(), submitted_by = $3,
                updated_at = now(), updated_by = $3
          WHERE id = $1 AND hospital_id = $2
          RETURNING *`,
        [id, hospital, this.actorId()],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The claim could not be submitted.');

      await tx.query(
        `UPDATE billing.scheme_cases SET status = 'claim_submitted', updated_at = now()
          WHERE id = $1 AND status NOT IN ('closed','rejected')`,
        [asText(prior['case_id'])],
      );

      await this.audit.write(tx, {
        action: 'update',
        entity: 'scheme_claim',
        rowId: id,
        businessKey: asText(prior['claim_no']),
        dataClass: 'financial',
        before: { status: asText(prior['status']) },
        after: { status: 'submitted' },
        reasonText: body.reason,
      });

      await this.outbox.publish(
        tx,
        schemeEvent('scheme.claim.submitted', id, {
          claimId: id,
          claimNo: asText(prior['claim_no']),
          caseId: asText(prior['case_id']),
          schemeCode: asText(prior['scheme_code']),
          claimedAmount: asText(prior['claimed_amount']),
          format: asText(prior['format']),
        }),
      );

      return this.getClaimIn(tx, id);
    });
  }

  /**
   * Discard a claim that was never sent.
   *
   * A draft cannot be submitted without its documents and cannot be decided at
   * all, so without this a mistaken claim would pin its case open forever. It
   * moves to `closed` rather than being deleted: `scheme_claims` has DELETE
   * revoked, and a claim number that was allocated and then vanished is a gap in
   * a gapless series somebody will later have to explain.
   */
  async discardClaim(id: string, body: SubmitClaimRequest): Promise<ClaimDetailView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();

      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE billing.scheme_claims
            SET status = 'closed', remarks = $3, updated_at = now(), updated_by = $4
          WHERE id = $1 AND hospital_id = $2 AND status IN ('draft','assembled')
          RETURNING *`,
        [id, hospital, body.reason, this.actorId()],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict('Only a claim that was never submitted can be discarded.');
      }

      await this.audit.write(tx, {
        action: 'update',
        entity: 'scheme_claim',
        rowId: id,
        businessKey: asText(row['claim_no']),
        dataClass: 'financial',
        before: { status: 'draft' },
        after: { status: 'closed', discarded: true },
        reasonText: body.reason,
      });

      return this.getClaimIn(tx, id);
    });
  }

  /**
   * Record what the authority decided and paid.
   *
   * Held by finance, never by the desk that submitted: an invented settlement
   * closes a case and stops anybody chasing money that never arrived. Any
   * shortfall becomes its own row with a category and a reason code, because a
   * lump-sum deduction with nothing behind it cannot be appealed — and an appeal
   * is the only way that money comes back.
   */
  async recordDecision(id: string, body: RecordClaimDecisionRequest): Promise<ClaimDetailView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();

      const { rows: before } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM billing.scheme_claims WHERE id = $1 AND hospital_id = $2 FOR UPDATE`,
        [id, hospital],
      );
      const prior = before[0];
      if (prior === undefined) throw AppError.notFound('Scheme claim');
      if (!['submitted', 'queried', 'approved', 'partially_approved'].includes(asText(prior['status']))) {
        throw AppError.conflict(
          `A claim in status "${asText(prior['status'])}" has no decision outstanding.`,
        );
      }

      const claimed = Number(asText(prior['claimed_amount']));
      if (body.approvedAmount > claimed) {
        throw AppError.conflict(
          `The authority cannot approve ₹${body.approvedAmount.toFixed(2)} against a claim of ₹${claimed.toFixed(2)}.`,
        );
      }
      const shortfall = (claimed - body.approvedAmount).toFixed(2);

      for (const line of body.lineDecisions) {
        const { rows: ls } = await tx.query<Record<string, unknown>>(
          `SELECT claimed_amount FROM billing.scheme_claim_lines WHERE id = $1 AND claim_id = $2`,
          [line.lineId, id],
        );
        const l = ls[0];
        if (l === undefined) throw AppError.notFound('Claim line');
        const lineClaimed = Number(asText(l['claimed_amount']));
        const disallowed = lineClaimed - line.approvedAmount;
        if (disallowed < 0) {
          throw AppError.conflict('A line cannot be approved for more than it claimed.');
        }
        await tx.query(
          `UPDATE billing.scheme_claim_lines
              SET approved_amount = $2::numeric, disallowed_amount = $3::numeric,
                  disallow_reason = $4, decided_at = now()
            WHERE id = $1`,
          [
            line.lineId,
            line.approvedAmount.toFixed(2),
            disallowed.toFixed(2),
            disallowed > 0 ? (line.disallowReason ?? 'Disallowed by the authority, no reason given') : null,
          ],
        );
      }

      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE billing.scheme_claims
            SET status = $3::"billing"."SchemeClaimStatus",
                approved_amount = $4::numeric,
                paid_amount = COALESCE($5::numeric, paid_amount),
                shortfall_amount = $6::numeric,
                paid_at = CASE WHEN $3 = 'paid' THEN now() ELSE paid_at END,
                decided_at = now(),
                utr = COALESCE($7, utr),
                authority_claim_no = COALESCE($8, authority_claim_no),
                remarks = COALESCE($9, remarks),
                updated_at = now(), updated_by = $10
          WHERE id = $1 AND hospital_id = $2
          RETURNING *`,
        [
          id,
          hospital,
          body.status,
          body.approvedAmount.toFixed(2),
          body.paidAmount === undefined ? null : body.paidAmount.toFixed(2),
          shortfall,
          body.utr ?? null,
          body.authorityClaimNo ?? null,
          body.remarks ?? null,
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The decision could not be recorded.');

      if (Number(shortfall) > 0) {
        await tx.query(
          `INSERT INTO billing.scheme_shortfalls
             (id, hospital_id, claim_id, amount, category, reason_code, narrative, status,
              created_at, created_by, updated_at, updated_by)
           VALUES ($1,$2,$3,$4::numeric,$5,$6,$7,'open', now(),$8, now(),$8)`,
          [
            newId(),
            hospital,
            id,
            shortfall,
            body.shortfallCategory ?? 'deduction',
            body.shortfallReasonCode ?? 'UNSPECIFIED',
            body.remarks ?? null,
            this.actorId(),
          ],
        );
        await this.outbox.publish(
          tx,
          schemeEvent('scheme.shortfall.raised', id, {
            shortfallId: id,
            claimId: id,
            amount: shortfall,
            category: body.shortfallCategory ?? 'deduction',
            reasonCode: body.shortfallReasonCode ?? 'UNSPECIFIED',
          }),
        );
      }

      await tx.query(
        `UPDATE billing.scheme_cases
            SET settled_amount = $2::numeric, shortfall_amount = $3::numeric,
                status = CASE WHEN $4 = 'paid' THEN 'settled'::"billing"."SchemeCaseStatus" ELSE status END,
                updated_at = now()
          WHERE id = $1`,
        [asText(prior['case_id']), (body.paidAmount ?? 0).toFixed(2), shortfall, body.status],
      );

      await this.audit.write(tx, {
        action: 'update',
        entity: 'scheme_claim',
        rowId: id,
        businessKey: asText(prior['claim_no']),
        dataClass: 'financial',
        before: { status: asText(prior['status']), approvedAmount: asText(prior['approved_amount']) },
        after: { status: body.status, approvedAmount: body.approvedAmount.toFixed(2), shortfall },
        reasonText: body.reason,
      });

      await this.outbox.publish(
        tx,
        schemeEvent('scheme.claim.decided', id, {
          claimId: id,
          claimNo: asText(prior['claim_no']),
          status: body.status,
          claimedAmount: claimed.toFixed(2),
          approvedAmount: body.approvedAmount.toFixed(2),
          shortfallAmount: shortfall,
        }),
      );

      if (body.status === 'paid') {
        await this.outbox.publish(
          tx,
          schemeEvent('scheme.claim.paid', id, {
            claimId: id,
            claimNo: asText(prior['claim_no']),
            paidAmount: (body.paidAmount ?? 0).toFixed(2),
            utr: body.utr ?? null,
          }),
        );
      }

      return this.getClaimIn(tx, id);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Shortfalls
  // ═══════════════════════════════════════════════════════════════════════════

  async listShortfalls(query: ShortfallQuery): Promise<Page<ShortfallView>> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT s.*, cl.claim_no FROM billing.scheme_shortfalls s
           JOIN billing.scheme_claims cl ON cl.id = s.claim_id
          WHERE s.hospital_id = $1 AND ($2::text IS NULL OR s.status::text = $2)
          ORDER BY s.created_at DESC
          LIMIT $3`,
        [this.hospitalId(), query.status ?? null, query.limit + 1],
      );
      const page = rows.slice(0, query.limit);
      return {
        items: page.map((r) => this.toShortfall(r)),
        nextCursor: null,
        hasMore: rows.length > query.limit,
      };
    });
  }

  private toShortfall(r: Record<string, unknown>): ShortfallView {
    return {
      id: asText(r['id']),
      claimId: asText(r['claim_id']),
      claimNo: asTextOrNull(r['claim_no']),
      amount: asText(r['amount']),
      category: asText(r['category']),
      reasonCode: asText(r['reason_code']),
      narrative: asTextOrNull(r['narrative']),
      status: asText(r['status']),
      appealRef: asTextOrNull(r['appeal_ref']),
      recoveredAmount: asText(r['recovered_amount']),
      writeOffRequestedBy: asTextOrNull(r['write_off_requested_by']),
      writeOffApprovedBy: asTextOrNull(r['write_off_approved_by']),
      createdAt: asText(r['created_at']),
    };
  }

  async appealShortfall(id: string, body: AppealShortfallRequest): Promise<ShortfallView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();
      const appealing = body.action === 'appeal';

      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE billing.scheme_shortfalls
            SET status = CASE WHEN $3::boolean THEN 'appealed'::"billing"."SchemeShortfallStatus" ELSE status END,
                appeal_ref = COALESCE($4, appeal_ref),
                appealed_at = CASE WHEN $3::boolean THEN now() ELSE appealed_at END,
                write_off_requested_by = CASE WHEN $3::boolean THEN write_off_requested_by ELSE $5::uuid END,
                write_off_requested_at = CASE WHEN $3::boolean THEN write_off_requested_at ELSE now() END,
                narrative = $6,
                updated_at = now(), updated_by = $5
          WHERE id = $1 AND hospital_id = $2 AND status IN ('open','appealed')
          RETURNING *`,
        [
          id,
          hospital,
          appealing,
          appealing ? (body.appealRef ?? 'APPEAL-PENDING') : null,
          this.actorId(),
          body.reason,
        ],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict('Only an open or appealed shortfall can be worked.');
      }

      await this.audit.write(tx, {
        action: 'update',
        entity: 'scheme_shortfall',
        rowId: id,
        businessKey: asText(row['reason_code']),
        dataClass: 'financial',
        before: { status: 'open' },
        after: { action: body.action },
        reasonText: body.reason,
      });

      const { rows: joined } = await tx.query<Record<string, unknown>>(
        `SELECT s.*, cl.claim_no FROM billing.scheme_shortfalls s
           JOIN billing.scheme_claims cl ON cl.id = s.claim_id WHERE s.id = $1`,
        [id],
      );
      return this.toShortfall(joined[0] ?? row);
    });
  }

  /**
   * The second pair of hands on a write-off.
   *
   * The database refuses `approved_by = requested_by`, so this cannot be a
   * formality even if the two keys ever landed on one role by accident.
   */
  async approveWriteOff(id: string, body: ApproveWriteOffRequest): Promise<ShortfallView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();

      const { rows: before } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM billing.scheme_shortfalls WHERE id = $1 AND hospital_id = $2 FOR UPDATE`,
        [id, hospital],
      );
      const prior = before[0];
      if (prior === undefined) throw AppError.notFound('Shortfall');
      const requestedBy = asTextOrNull(prior['write_off_requested_by']);
      if (requestedBy === null) {
        throw AppError.conflict('Nobody has asked for this shortfall to be written off.');
      }
      if (requestedBy === this.actorId()) {
        throw AppError.conflict(
          'A write-off needs a second pair of hands: the person who asked for it cannot also approve it.',
        );
      }

      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE billing.scheme_shortfalls
            SET status = 'written_off', write_off_approved_by = $3,
                write_off_approved_at = now(), write_off_reason = $4,
                updated_at = now(), updated_by = $3
          WHERE id = $1 AND hospital_id = $2 AND status <> 'written_off'
          RETURNING *`,
        [id, hospital, this.actorId(), body.reason],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('This shortfall is already written off.');

      await this.audit.write(tx, {
        action: 'approve',
        entity: 'scheme_shortfall',
        rowId: id,
        businessKey: asText(row['reason_code']),
        dataClass: 'financial',
        before: { status: asText(prior['status']) },
        after: { status: 'written_off', amount: asText(row['amount']) },
        reasonText: body.reason,
      });

      await this.outbox.publish(
        tx,
        schemeEvent('scheme.shortfall.written_off', id, {
          shortfallId: id,
          claimId: asText(row['claim_id']),
          amount: asText(row['amount']),
          requestedBy,
          approvedBy: this.actorId(),
        }),
      );

      const { rows: joined } = await tx.query<Record<string, unknown>>(
        `SELECT s.*, cl.claim_no FROM billing.scheme_shortfalls s
           JOIN billing.scheme_claims cl ON cl.id = s.claim_id WHERE s.id = $1`,
        [id],
      );
      return this.toShortfall(joined[0] ?? row);
    });
  }
}
