import { Inject, Injectable } from '@nestjs/common';
import { ProblemType, newId, type Page } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService, type TransactionClient } from '../../../core/db/database.service.js';
import { NumberingService } from '../../../core/numbering/numbering.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import { withMlcErrors } from './mlc.errors.js';
import { mlcEvent } from './mlc.events.js';
import type {
  AcknowledgeRequest,
  AddendumRequest,
  AnswerRequestRequest,
  CustodyRequest,
  DeathRequest,
  DispatchRequest,
  DyingDeclarationRequest,
  EvidenceRequest,
  HandoverRequest,
  InjuryRequest,
  IntimationRequest,
  OpenCaseRequest,
  RegisterQuery,
  ReportRequest,
  RequestRequest,
  SexualAssaultRequest,
  SignReportRequest,
  UpdateCaseRequest,
  WorklistQuery,
} from './mlc.schemas.js';
import { SENSITIVE_CATEGORIES } from './mlc.schemas.js';
import type {
  MlcCaseDetailView,
  MlcCaseView,
  MlcCustodyEntryView,
  MlcDeathView,
  MlcDischargeGateView,
  MlcDyingDeclarationView,
  MlcEvidenceView,
  MlcInjuryView,
  MlcIntimationView,
  MlcReportView,
  MlcRequestView,
  MlcSexualAssaultView,
  MlcWorklistRow,
} from './mlc.types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Row coercion
// ─────────────────────────────────────────────────────────────────────────────

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
function asBool(v: unknown): boolean {
  return v === true || v === 't' || v === 'true';
}
function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map(asText) : [];
}
function minutesBetween(from: unknown, to: unknown): number | null {
  const a = asTextOrNull(from);
  const b = asTextOrNull(to);
  if (a === null || b === null) return null;
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60_000);
}
function json(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

/**
 * The intimation target, in minutes from the case opening.
 *
 * TR-008 §5 makes it a KPI rather than a hard stop, and that is the right shape:
 * a hospital that cannot reach the station at 3 a.m. must still be able to open
 * the case. What is not optional is that the clock is visible.
 */
const INTIMATION_TARGET_MINUTES = 60;

/**
 * TR-008 — the medico-legal record.
 *
 * ── Nothing in this service can gate treatment ──────────────────────────────
 *
 * By construction, the same way OP-006 has no payment column: nothing here
 * references an order, a prescription, a procedure or a bill. The only gate is
 * `dischargeGate`, and its enforcement is a trigger on `er_dispositions` — the
 * way *out* of the department. *Parmanand Katara v. Union of India* (1989)
 * makes emergency treatment a duty that cannot be conditioned on formalities,
 * and the strongest way to honour that is to leave nowhere for a formality to
 * be attached.
 *
 * ── The custody hash is not computed here ───────────────────────────────────
 *
 * `recordCustody` sends the transfer and the database computes `seq`,
 * `prev_hash` and `hash` from the row it is actually storing. That is the
 * difference between a chain that proves the evidence was not tampered with and
 * one that proves this service was internally consistent — which is not the
 * question anybody asks in court. The service *verifies* the chain on read
 * instead, which is the half that is worth doing in application code.
 *
 * ── Sensitive cases ─────────────────────────────────────────────────────────
 *
 * Sexual-assault, POCSO, dowry and custodial cases are filtered out of every
 * list and refused on every read unless the caller holds `mlc.sensitive.read`.
 * That is a second check on top of the permission decorator, because the
 * decorator protects the route and this protects the row — and the row is what
 * leaks when somebody adds a convenient "search all cases" endpoint later.
 */
@Injectable()
export class MlcService {
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
  private reason(what: string): string {
    const value = getContext().reason;
    if (value === null || value.trim().length < 8) {
      throw new AppError(
        ProblemType.VALIDATION_FAILED,
        `${what} needs a reason of at least eight characters, sent in the \`x-reason\` header.`,
      );
    }
    return value.trim();
  }
  private guard<T>(fn: (tx: TransactionClient) => Promise<T>): Promise<T> {
    return withMlcErrors(() => this.db.withTenant(currentTenantContext(), fn));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The register
  // ═══════════════════════════════════════════════════════════════════════════

  async openCase(body: OpenCaseRequest): Promise<MlcCaseDetailView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();
      const branch = this.branchId();
      const actor = this.actorId();

      const id = newId();
      const alloc = await this.numbering.allocate(tx, {
        key: 'MLC',
        branchId: branch,
        refType: 'mlc_case',
        refId: id,
      });

      // The category decides sensitivity, not the caller. A CHECK backs this up,
      // so a request that says otherwise is refused rather than quietly honoured.
      const isSensitive = (SENSITIVE_CATEGORIES as readonly string[]).includes(body.category);

      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO clinical.mlc_cases (
           id, hospital_id, branch_id, mlc_no, category, sub_category,
           er_visit_id, admission_id, patient_id, temp_tag_id,
           opened_at, opened_by, suggested_from,
           brought_by, informant, history_as_stated, identification_marks,
           alleged_incident_at, incident_place, consent,
           is_sensitive, status, mo_id, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5::clinical."MlcCategory", $6,
           $7, $8, $9, $10,
           now(), $11, $12,
           $13::jsonb, $14::jsonb, $15, $16,
           $17::timestamptz, $18, $19::jsonb,
           $20, 'open', $21, now(), now()
         ) RETURNING *`,
        [
          id,
          hospital,
          branch,
          alloc.formatted,
          body.category,
          body.subCategory ?? null,
          body.erVisitId ?? null,
          body.admissionId ?? null,
          body.patientId ?? null,
          body.tempTagId ?? null,
          actor,
          body.suggestedFrom ?? null,
          json(body.broughtBy),
          json(body.informant),
          body.historyAsStated ?? null,
          body.identificationMarks,
          body.allegedIncidentAt ?? null,
          body.incidentPlace ?? null,
          json(body.consent),
          isSensitive,
          body.moId ?? null,
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The MLC case was not opened.');

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'mlc_case',
        rowId: id,
        businessKey: alloc.formatted,
        dataClass: 'phi',
        before: null,
        after: { category: body.category, isSensitive, erVisitId: body.erVisitId ?? null },
      });

      await this.outbox.publish(
        tx,
        mlcEvent('mlc.case.opened', id, {
          caseId: id,
          mlcNo: alloc.formatted,
          category: body.category,
          patientId: body.patientId ?? null,
          tempTagId: body.tempTagId ?? null,
          erVisitId: body.erVisitId ?? null,
          isSensitive,
        }),
      );

      return this.loadCase(tx, id);
    });
  }

  async updateCase(id: string, body: UpdateCaseRequest): Promise<MlcCaseDetailView> {
    return this.guard(async (tx) => {
      // COALESCE throughout: this form is filled in over hours by several
      // people, and a PATCH that blanked the history because somebody was
      // recording the informant's phone number would destroy the record.
      const { rowCount } = await tx.query(
        `UPDATE clinical.mlc_cases SET
           sub_category           = COALESCE($2, sub_category),
           patient_id             = COALESCE($3::uuid, patient_id),
           temp_tag_id            = COALESCE($4, temp_tag_id),
           brought_by             = COALESCE($5::jsonb, brought_by),
           informant              = COALESCE($6::jsonb, informant),
           history_as_stated      = COALESCE($7, history_as_stated),
           identification_marks   = CASE WHEN $8::text[] IS NULL OR cardinality($8::text[]) = 0
                                         THEN identification_marks ELSE $8::text[] END,
           alleged_incident_at    = COALESCE($9::timestamptz, alleged_incident_at),
           incident_place         = COALESCE($10, incident_place),
           consent                = COALESCE($11::jsonb, consent),
           intoxication_assessment= COALESCE($12::jsonb, intoxication_assessment),
           mo_id                  = COALESCE($13::uuid, mo_id),
           updated_at             = now()
         WHERE id = $1 AND hospital_id = $14`,
        [
          id,
          body.subCategory ?? null,
          body.patientId ?? null,
          body.tempTagId ?? null,
          json(body.broughtBy),
          json(body.informant),
          body.historyAsStated ?? null,
          body.identificationMarks ?? null,
          body.allegedIncidentAt ?? null,
          body.incidentPlace ?? null,
          json(body.consent),
          json(body.intoxicationAssessment),
          body.moId ?? null,
          this.hospitalId(),
        ],
      );
      if (rowCount === 0) throw AppError.notFound('That MLC case does not exist.');
      return this.loadCase(tx, id);
    });
  }

  /**
   * Cancel a case that should not have been opened.
   *
   * The Medical Superintendent's key, a reason, and the number stays burnt. The
   * database refuses to reopen it afterwards and refuses to cancel one that
   * already has a final report — an opinion that reached a court is corrected
   * by addendum, not by the case ceasing to exist.
   */
  async cancelCase(id: string): Promise<MlcCaseDetailView> {
    return this.guard(async (tx) => {
      const reason = this.reason('Cancelling a medico-legal case');
      const actor = this.actorId();

      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.mlc_cases
            SET status = 'cancelled'::clinical."MlcStatus",
                unflag_reason = $2, unflagged_by = $3, unflagged_at = now(), updated_at = now()
          WHERE id = $1 AND hospital_id = $4 AND status <> 'cancelled'
          RETURNING *`,
        [id, reason, actor, this.hospitalId()],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict('That case is already cancelled, or does not exist.');
      }

      await this.audit.write(tx, {
        action: 'update',
        entity: 'mlc_case',
        rowId: id,
        businessKey: asText(row['mlc_no']),
        dataClass: 'phi',
        before: { status: 'open' },
        after: { status: 'cancelled', reason },
      });

      await this.outbox.publish(
        tx,
        mlcEvent('mlc.case.cancelled', id, {
          caseId: id,
          mlcNo: asText(row['mlc_no']),
          reason,
          cancelledBy: actor,
        }),
      );

      return this.loadCase(tx, id);
    });
  }

  async register(query: RegisterQuery, mayReadSensitive: boolean): Promise<Page<MlcCaseView>> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT c.*, v.er_no, v.display_name,
                (SELECT count(*) FROM clinical.mlc_police_intimations i WHERE i.case_id = c.id) AS intimation_count,
                (SELECT count(*) FROM clinical.mlc_injuries j WHERE j.case_id = c.id) AS injury_count,
                (SELECT count(*) FROM clinical.mlc_evidence e WHERE e.case_id = c.id) AS evidence_count,
                (SELECT count(*) FROM clinical.mlc_reports r WHERE r.case_id = c.id) AS report_count,
                (SELECT min(i.dispatched_at) FROM clinical.mlc_police_intimations i
                  WHERE i.case_id = c.id AND i.dispatched_at IS NOT NULL) AS first_dispatch_at
           FROM clinical.mlc_cases c
           LEFT JOIN clinical.er_visits v ON v.id = c.er_visit_id
          WHERE c.hospital_id = $1 AND c.branch_id = $2
            AND ($3::int IS NULL OR EXTRACT(YEAR FROM c.opened_at) = $3)
            AND ($4::text IS NULL OR c.status::text = $4)
            AND ($5::text IS NULL OR c.category::text = $5)
            -- A sensitive case is invisible without the key, even to a caller
            -- who asked for it. The filter is here as well as on the route
            -- because the row is what leaks, not the route.
            AND ($6::boolean OR NOT c.is_sensitive)
          ORDER BY c.opened_at DESC
          LIMIT $7`,
        [
          this.hospitalId(),
          this.branchId(),
          query.year ?? null,
          query.status ?? null,
          query.category ?? null,
          mayReadSensitive && query.includeSensitive,
          query.limit,
        ],
      );
      return { items: rows.map((r) => this.toCase(r)), nextCursor: null, hasMore: false };
    });
  }

  async getCase(id: string, mayReadSensitive: boolean): Promise<MlcCaseDetailView> {
    return this.guard(async (tx) => {
      const detail = await this.loadCase(tx, id);
      if (detail.mlcCase.isSensitive && !mayReadSensitive) {
        // Deliberately the same refusal a missing case gets: telling a caller
        // that a sexual-assault case exists for this patient is itself the leak.
        throw AppError.notFound('That MLC case does not exist.');
      }
      return mayReadSensitive ? detail : { ...detail, sexualAssault: null };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Police intimation
  // ═══════════════════════════════════════════════════════════════════════════

  async createIntimation(caseId: string, body: IntimationRequest): Promise<MlcCaseDetailView> {
    return this.guard(async (tx) => {
      const mlcCase = await this.requireCase(tx, caseId);
      const id = newId();

      await tx.query(
        `INSERT INTO clinical.mlc_police_intimations (
           id, hospital_id, case_id, type, ps_name, jurisdiction, addressed_to,
           generated_at, generated_by, status, ack_due_at, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4::clinical."MlcIntimationType", $5, $6, $7,
           now(), $8, 'generated',
           $9::timestamptz + make_interval(mins => $10), now(), now()
         )`,
        [
          id,
          this.hospitalId(),
          caseId,
          body.type,
          body.psName,
          body.jurisdiction ?? null,
          body.addressedTo ?? null,
          this.actorId(),
          asText(mlcCase['opened_at']),
          INTIMATION_TARGET_MINUTES,
        ],
      );

      return this.loadCase(tx, caseId);
    });
  }

  async dispatchIntimation(id: string, body: DispatchRequest): Promise<MlcCaseDetailView> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.mlc_police_intimations
            SET status = 'dispatched'::clinical."MlcIntimationStatus",
                dispatched_at = COALESCE(dispatched_at, now()),
                channels = $2::jsonb,
                updated_at = now()
          WHERE id = $1 AND hospital_id = $3 AND status = 'generated'
          RETURNING *`,
        [
          id,
          JSON.stringify(body.channels.map((c) => ({ ...c, sentAt: new Date().toISOString() }))),
          this.hospitalId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict('That intimation has already been dispatched, or does not exist.');
      }

      const caseId = asText(row['case_id']);
      const mlcCase = await this.requireCase(tx, caseId);

      await this.outbox.publish(
        tx,
        mlcEvent('mlc.police.intimated', id, {
          intimationId: id,
          caseId,
          mlcNo: asText(mlcCase['mlc_no']),
          type: asText(row['type']),
          psName: asText(row['ps_name']),
          minutesFromOpening: minutesBetween(mlcCase['opened_at'], row['dispatched_at']) ?? 0,
        }),
      );

      return this.loadCase(tx, caseId);
    });
  }

  async acknowledgeIntimation(id: string, body: AcknowledgeRequest): Promise<MlcCaseDetailView> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.mlc_police_intimations
            SET status = 'acknowledged'::clinical."MlcIntimationStatus",
                ack_officer_name = $2, ack_officer_badge = $3, ack_signature_ref = $4,
                ack_at = now(), updated_at = now()
          WHERE id = $1 AND hospital_id = $5 AND status IN ('dispatched', 'generated')
          RETURNING *`,
        [id, body.officerName, body.officerBadge ?? null, body.signatureRef ?? null, this.hospitalId()],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict('That intimation has already been acknowledged, or does not exist.');
      }

      const caseId = asText(row['case_id']);
      await this.outbox.publish(
        tx,
        mlcEvent('mlc.police.acknowledged', id, {
          intimationId: id,
          caseId,
          officerName: body.officerName,
          officerBadge: body.officerBadge ?? null,
          minutesToAcknowledge: minutesBetween(row['dispatched_at'], row['ack_at']) ?? 0,
        }),
      );

      return this.loadCase(tx, caseId);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The body map
  // ═══════════════════════════════════════════════════════════════════════════

  async recordInjury(caseId: string, body: InjuryRequest): Promise<MlcCaseDetailView> {
    return this.guard(async (tx) => {
      await this.requireCase(tx, caseId);

      const { rows: seqRows } = await tx.query<Record<string, unknown>>(
        `SELECT COALESCE(max(seq), 0) + 1 AS next FROM clinical.mlc_injuries WHERE case_id = $1`,
        [caseId],
      );
      const seq = asNumber(seqRows[0]?.['next'] ?? 1);
      const id = newId();

      await tx.query(
        `INSERT INTO clinical.mlc_injuries (
           id, hospital_id, case_id, seq, trauma_injury_id, kind, body_view, x_pct, y_pct, side,
           site_description, length_cm, breadth_cm, depth_cm, shape, edges, direction,
           colour_stage, age_estimate, foreign_body, firearm_features,
           bns_class, grievous_reason, weapon_opinion, consistent_with_history,
           recorded_at, recorded_by
         ) VALUES (
           $1, $2, $3, $4, $5, $6::clinical."InjuryKind", $7, $8, $9, $10,
           $11, $12, $13, $14, $15, $16, $17,
           $18, $19, $20, $21::jsonb,
           $22::clinical."BnsInjuryClass", $23, $24::clinical."WeaponOpinion", $25,
           now(), $26
         )`,
        [
          id,
          this.hospitalId(),
          caseId,
          seq,
          body.traumaInjuryId ?? null,
          body.kind,
          body.bodyView,
          body.xPct,
          body.yPct,
          body.side ?? null,
          body.siteDescription,
          body.lengthCm ?? null,
          body.breadthCm ?? null,
          body.depthCm ?? null,
          body.shape ?? null,
          body.edges ?? null,
          body.direction ?? null,
          body.colourStage ?? null,
          body.ageEstimate ?? null,
          body.foreignBody ?? null,
          json(body.firearmFeatures),
          body.bnsClass,
          body.grievousGround ?? null,
          body.weaponOpinion,
          body.consistentWithHistory,
          this.actorId(),
        ],
      );

      await this.outbox.publish(
        tx,
        mlcEvent('mlc.injury.recorded', id, {
          injuryId: id,
          caseId,
          seq,
          kind: body.kind,
          bnsClass: body.bnsClass,
          traumaInjuryId: body.traumaInjuryId ?? null,
        }),
      );

      return this.loadCase(tx, caseId);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Evidence and custody
  // ═══════════════════════════════════════════════════════════════════════════

  async captureEvidence(caseId: string, body: EvidenceRequest): Promise<MlcEvidenceView> {
    return this.guard(async (tx) => {
      await this.requireCase(tx, caseId);
      const hospital = this.hospitalId();
      const actor = this.actorId();

      const { rows: seqRows } = await tx.query<Record<string, unknown>>(
        `SELECT COALESCE(max(item_no), 0) + 1 AS next FROM clinical.mlc_evidence WHERE case_id = $1`,
        [caseId],
      );
      const itemNo = asNumber(seqRows[0]?.['next'] ?? 1);
      const id = newId();

      await tx.query(
        `INSERT INTO clinical.mlc_evidence (
           id, hospital_id, case_id, item_no, kind, description,
           collected_at, collected_by, consent_ref, seal_no, bag_label_ref, sample_id,
           file_ref, sha256, device_id, exif,
           current_custodian_id, current_location, status, notes, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5::clinical."EvidenceKind", $6,
           now(), $7, $8, $9, $10, $11,
           $12, $13, $14, $15::jsonb,
           $7, 'er', $16::clinical."EvidenceStatus", $17, now(), now()
         )`,
        [
          id,
          hospital,
          caseId,
          itemNo,
          body.kind,
          body.description,
          actor,
          body.consentRef ?? null,
          body.sealNo ?? null,
          body.bagLabelRef ?? null,
          body.sampleId ?? null,
          body.fileRef ?? null,
          body.sha256 ?? null,
          body.deviceId ?? null,
          json(body.exif),
          body.sealNo === undefined ? 'collected' : 'sealed',
          body.notes ?? null,
        ],
      );

      // The genesis custody entry. Without it the item exists with nobody
      // holding it, which is the state a chain is supposed to make impossible.
      await tx.query(
        `INSERT INTO clinical.mlc_custody_log (
           id, hospital_id, evidence_id, seq, prev_hash, hash,
           from_user_id, to_user_id, location_from, location_to, purpose, seal_intact
         ) VALUES ($1, $2, $3, 0, '', '', $4, $4, 'er', 'er', $5, true)`,
        [newId(), hospital, id, actor, `Collected: ${body.description.slice(0, 120)}`],
      );

      await this.outbox.publish(
        tx,
        mlcEvent('mlc.evidence.captured', id, {
          evidenceId: id,
          caseId,
          itemNo,
          kind: body.kind,
          sealNo: body.sealNo ?? null,
          sha256: body.sha256 ?? null,
        }),
      );

      return this.loadEvidence(tx, id);
    });
  }

  /**
   * Record a custody transfer.
   *
   * `seq`, `prev_hash` and `hash` are sent as placeholders and overwritten by
   * the database. They are in the INSERT only because the columns are NOT NULL;
   * what this service sends is never what is stored, and that is the point.
   */
  async recordCustody(evidenceId: string, body: CustodyRequest): Promise<MlcEvidenceView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();
      const { rows: itemRows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM clinical.mlc_evidence WHERE id = $1 AND hospital_id = $2 FOR UPDATE`,
        [evidenceId, hospital],
      );
      const item = itemRows[0];
      if (item === undefined) throw AppError.notFound('That evidence item does not exist.');

      if (body.toUserId === undefined && body.toExternal === undefined) {
        throw new AppError(
          ProblemType.VALIDATION_FAILED,
          'A custody transfer names who took the item — a colleague, or a named officer. An item that moved with nobody on the receiving end is an item nobody is answerable for.',
        );
      }

      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO clinical.mlc_custody_log (
           id, hospital_id, evidence_id, seq, prev_hash, hash,
           from_user_id, to_user_id, to_external, location_from, location_to,
           purpose, seal_intact, witness_user_id, condition_notes, temperature_c
         ) VALUES (
           $1, $2, $3, 0, '', '',
           $4, $5, $6::jsonb, $7::clinical."EvidenceLocation", $8::clinical."EvidenceLocation",
           $9, $10, $11, $12, $13
         ) RETURNING seq, hash`,
        [
          newId(),
          hospital,
          evidenceId,
          this.actorId(),
          body.toUserId ?? null,
          json(body.toExternal),
          asText(item['current_location']),
          body.locationTo,
          body.purpose,
          body.sealIntact,
          body.witnessUserId ?? null,
          body.conditionNotes ?? null,
          body.temperatureC ?? null,
        ],
      );
      const entry = rows[0];
      if (entry === undefined) throw AppError.conflict('The custody entry was not written.');

      await tx.query(
        `UPDATE clinical.mlc_evidence
            SET current_location = $2::clinical."EvidenceLocation",
                current_custodian_id = $3,
                status = CASE WHEN $2 IN ('police', 'court') THEN 'handed_over'::clinical."EvidenceStatus"
                              WHEN $2 = 'lab' THEN 'in_lab'::clinical."EvidenceStatus"
                              ELSE status END,
                updated_at = now()
          WHERE id = $1`,
        [evidenceId, body.locationTo, body.toUserId ?? null],
      );

      await this.outbox.publish(
        tx,
        mlcEvent('mlc.evidence.custody_transferred', evidenceId, {
          evidenceId,
          caseId: asText(item['case_id']),
          seq: asNumber(entry['seq']),
          locationFrom: asText(item['current_location']),
          locationTo: body.locationTo,
          sealIntact: body.sealIntact,
          hash: asText(entry['hash']),
        }),
      );

      return this.loadEvidence(tx, evidenceId);
    });
  }

  async listEvidence(caseId: string): Promise<Page<MlcEvidenceView>> {
    return this.guard(async (tx) => {
      const items = await this.loadEvidenceForCase(tx, caseId);
      return { items, nextCursor: null, hasMore: false };
    });
  }

  async handOver(caseId: string, body: HandoverRequest): Promise<MlcCaseDetailView> {
    return this.guard(async (tx) => {
      const reason = this.reason('Handing evidence to the police');
      const mlcCase = await this.requireCase(tx, caseId);
      const hospital = this.hospitalId();
      const actor = this.actorId();

      // Every item named has to belong to this case. A handover that quietly
      // took an item from another case is exactly the error a memo exists to
      // make impossible.
      const { rows: owned } = await tx.query<Record<string, unknown>>(
        `SELECT id FROM clinical.mlc_evidence
          WHERE id = ANY($1::uuid[]) AND case_id = $2 AND hospital_id = $3`,
        [body.itemIds, caseId, hospital],
      );
      if (owned.length !== body.itemIds.length) {
        throw AppError.conflict(
          'One or more of those items does not belong to this case. Nothing was handed over.',
        );
      }

      const id = newId();
      await tx.query(
        `INSERT INTO clinical.mlc_handovers (
           id, hospital_id, case_id, to_external, item_ids,
           signed_by_hospital, witness_id, signed_at, bsa63_certificate_ref, created_at
         ) VALUES ($1, $2, $3, $4::jsonb, $5::uuid[], $6, $7, now(), $8, now())`,
        [
          id,
          hospital,
          caseId,
          JSON.stringify(body.toExternal),
          body.itemIds,
          actor,
          body.witnessId ?? null,
          body.bsa63CertificateRef ?? null,
        ],
      );

      // Each item moves through its own chain. One memo, several links.
      for (const itemId of body.itemIds) {
        const { rows: itemRows } = await tx.query<Record<string, unknown>>(
          `SELECT current_location FROM clinical.mlc_evidence WHERE id = $1`,
          [itemId],
        );
        await tx.query(
          `INSERT INTO clinical.mlc_custody_log (
             id, hospital_id, evidence_id, seq, prev_hash, hash,
             from_user_id, to_external, location_from, location_to, purpose, seal_intact, witness_user_id
           ) VALUES ($1, $2, $3, 0, '', '', $4, $5::jsonb, $6::clinical."EvidenceLocation", 'police', $7, true, $8)`,
          [
            newId(),
            hospital,
            itemId,
            actor,
            JSON.stringify(body.toExternal),
            asText(itemRows[0]?.['current_location'] ?? 'evidence_locker'),
            `Handed over against ${body.toExternal.requisitionRef}: ${reason}`,
            body.witnessId ?? null,
          ],
        );
        await tx.query(
          `UPDATE clinical.mlc_evidence
              SET current_location = 'police', status = 'handed_over', current_custodian_id = NULL, updated_at = now()
            WHERE id = $1`,
          [itemId],
        );
      }

      await this.audit.write(tx, {
        action: 'update',
        entity: 'mlc_evidence',
        rowId: id,
        businessKey: asText(mlcCase['mlc_no']),
        dataClass: 'phi',
        before: null,
        after: { itemCount: body.itemIds.length, officer: body.toExternal.officer, reason },
      });

      await this.outbox.publish(
        tx,
        mlcEvent('mlc.evidence.handed_over', id, {
          handoverId: id,
          caseId,
          mlcNo: asText(mlcCase['mlc_no']),
          itemCount: body.itemIds.length,
          officer: body.toExternal.officer,
          psName: body.toExternal.ps,
        }),
      );

      return this.loadCase(tx, caseId);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Reports
  // ═══════════════════════════════════════════════════════════════════════════

  async createReport(caseId: string, body: ReportRequest): Promise<MlcCaseDetailView> {
    return this.guard(async (tx) => {
      await this.requireCase(tx, caseId);
      await this.insertReport(tx, caseId, body, null);
      return this.loadCase(tx, caseId);
    });
  }

  async addendum(caseId: string, body: AddendumRequest): Promise<MlcCaseDetailView> {
    return this.guard(async (tx) => {
      const reason = this.reason('Recording an addendum to a signed report');
      await this.requireCase(tx, caseId);

      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT id, status FROM clinical.mlc_reports WHERE id = $1 AND case_id = $2 AND hospital_id = $3`,
        [body.addendumOf, caseId, this.hospitalId()],
      );
      const previous = rows[0];
      if (previous === undefined) throw AppError.notFound('That report does not exist on this case.');
      if (!['final', 'final_wet_signed'].includes(asText(previous['status']))) {
        throw AppError.conflict('Only a signed report is corrected by addendum. A draft is simply edited.');
      }

      await this.insertReport(tx, caseId, body, { addendumOf: body.addendumOf, reason });
      return this.loadCase(tx, caseId);
    });
  }

  private async insertReport(
    tx: TransactionClient,
    caseId: string,
    body: ReportRequest,
    addendum: { readonly addendumOf: string; readonly reason: string } | null,
  ): Promise<string> {
    const { rows: seqRows } = await tx.query<Record<string, unknown>>(
      `SELECT COALESCE(max(version_no), 0) + 1 AS next
         FROM clinical.mlc_reports WHERE case_id = $1 AND kind = $2::clinical."MlcReportKind"`,
      [caseId, body.kind],
    );
    const versionNo = asNumber(seqRows[0]?.['next'] ?? 1);
    const id = newId();

    await tx.query(
      `INSERT INTO clinical.mlc_reports (
         id, hospital_id, case_id, kind, version_no, status, template_ref, content,
         addendum_of, addendum_reason, created_at, created_by, updated_at
       ) VALUES (
         $1, $2, $3, $4::clinical."MlcReportKind", $5,
         CASE WHEN $9::uuid IS NULL THEN 'draft' ELSE 'addendum' END::clinical."MlcReportStatus",
         $6, $7::jsonb, $8, $9, now(), $10, now()
       )`,
      [
        id,
        this.hospitalId(),
        caseId,
        body.kind,
        versionNo,
        body.templateRef ?? null,
        JSON.stringify(body.content),
        addendum?.addendumOf ?? null,
        addendum?.addendumOf ?? null,
        this.actorId(),
      ],
    );

    if (addendum !== null) {
      await tx.query(`UPDATE clinical.mlc_reports SET addendum_reason = $2 WHERE id = $1`, [
        id,
        addendum.reason,
      ]);
    }
    return id;
  }

  /**
   * Sign a report.
   *
   * With a DSC reference it becomes `final`; without one it becomes
   * `final_wet_signed`. Two states rather than one, because "the DSC token was
   * not working so we printed and signed it" is a real and lawful thing that
   * happens, and pretending it was digitally signed would be the lie.
   */
  async signReport(id: string, body: SignReportRequest): Promise<MlcCaseDetailView> {
    return this.guard(async (tx) => {
      const status = body.dscRef === undefined ? 'final_wet_signed' : 'final';

      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.mlc_reports
            SET status = $2::clinical."MlcReportStatus",
                document_ref = $3, sha256 = $4, dsc_ref = $5,
                signed_by = $6, signed_at = now(), updated_at = now()
          WHERE id = $1 AND hospital_id = $7 AND status IN ('draft', 'addendum')
          RETURNING *`,
        [id, status, body.documentRef, body.sha256, body.dscRef ?? null, this.actorId(), this.hospitalId()],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict('That report is already signed, or does not exist. Corrections are addenda.');
      }

      const caseId = asText(row['case_id']);
      const mlcCase = await this.requireCase(tx, caseId);

      // A signed report moves the case on: it is no longer just open.
      await tx.query(
        `UPDATE clinical.mlc_cases
            SET status = CASE WHEN status = 'open' THEN 'report_final'::clinical."MlcStatus" ELSE status END,
                updated_at = now()
          WHERE id = $1`,
        [caseId],
      );

      await this.audit.write(tx, {
        action: 'sign',
        entity: 'mlc_report',
        rowId: id,
        businessKey: `${asText(mlcCase['mlc_no'])}/${asText(row['kind'])}`,
        dataClass: 'phi',
        before: { status: 'draft' },
        after: { status, sha256: body.sha256 },
      });

      await this.outbox.publish(
        tx,
        mlcEvent('mlc.report.finalised', id, {
          reportId: id,
          caseId,
          mlcNo: asText(mlcCase['mlc_no']),
          kind: asText(row['kind']),
          versionNo: asNumber(row['version_no']),
          wetSigned: status === 'final_wet_signed',
        }),
      );

      return this.loadCase(tx, caseId);
    });
  }

  /** Issue a certified copy into the numbered copy register. */
  async issueCertifiedCopy(id: string): Promise<MlcCaseDetailView> {
    return this.guard(async (tx) => {
      const reason = this.reason('Issuing a certified copy');
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM clinical.mlc_reports WHERE id = $1 AND hospital_id = $2`,
        [id, this.hospitalId()],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.notFound('That report does not exist.');
      if (!['final', 'final_wet_signed'].includes(asText(row['status']))) {
        throw AppError.conflict('Only a signed report is issued as a certified copy.');
      }

      const alloc = await this.numbering.allocate(tx, {
        key: 'MLC_COPY',
        branchId: this.branchId(),
        refType: 'mlc_report',
        refId: id,
      });

      // `dispatches` grows after signing; the immutability trigger allows that
      // one column precisely because sending a copy is not editing the document.
      await tx.query(
        `UPDATE clinical.mlc_reports
            SET copy_register_no = COALESCE(copy_register_no, $2),
                dispatches = dispatches || $3::jsonb,
                updated_at = now()
          WHERE id = $1`,
        [
          id,
          alloc.formatted,
          JSON.stringify([{ at: new Date().toISOString(), copyNo: alloc.formatted, reason }]),
        ],
      );

      await this.audit.write(tx, {
        action: 'export',
        entity: 'mlc_report',
        rowId: id,
        businessKey: alloc.formatted,
        dataClass: 'phi',
        before: null,
        after: { copyRegisterNo: alloc.formatted, reason },
      });

      return this.loadCase(tx, asText(row['case_id']));
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Requests, declarations, the protocol and death
  // ═══════════════════════════════════════════════════════════════════════════

  async registerRequest(caseId: string, body: RequestRequest): Promise<MlcCaseDetailView> {
    return this.guard(async (tx) => {
      await this.requireCase(tx, caseId);
      await tx.query(
        `INSERT INTO clinical.mlc_requests
           (id, hospital_id, case_id, requester, kind, authority_ref, received_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, $5::clinical."MlcRequestKind", $6, now(), now(), now())`,
        [
          newId(),
          this.hospitalId(),
          caseId,
          JSON.stringify(body.requester),
          body.kind,
          body.authorityRef ?? null,
        ],
      );
      return this.loadCase(tx, caseId);
    });
  }

  async answerRequest(id: string, body: AnswerRequestRequest): Promise<MlcCaseDetailView> {
    return this.guard(async (tx) => {
      const reason = this.reason('Answering a police or court request');
      const denied = body.deniedReason !== undefined;

      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.mlc_requests
            SET approved_by = $2, approved_at = now(),
                provided_at = CASE WHEN $3::boolean THEN NULL ELSE now() END,
                provided_doc_refs = CASE WHEN $3::boolean THEN provided_doc_refs ELSE $4::text[] END,
                denied_reason = $5,
                updated_at = now()
          WHERE id = $1 AND hospital_id = $6 AND provided_at IS NULL AND denied_reason IS NULL
          RETURNING *`,
        [id, this.actorId(), denied, body.providedDocRefs, body.deniedReason ?? null, this.hospitalId()],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('That request has already been answered.');

      await this.audit.write(tx, {
        action: 'export',
        entity: 'mlc_request',
        rowId: id,
        businessKey: asText(row['kind']),
        dataClass: 'phi',
        before: null,
        after: { denied, docs: body.providedDocRefs.length, reason },
      });

      return this.loadCase(tx, asText(row['case_id']));
    });
  }

  async recordDyingDeclaration(caseId: string, body: DyingDeclarationRequest): Promise<MlcCaseDetailView> {
    return this.guard(async (tx) => {
      await this.requireCase(tx, caseId);
      await tx.query(
        `INSERT INTO clinical.mlc_dying_declarations (
           id, hospital_id, case_id, requested_at, requested_by, magistrate,
           fitness_certified_by, fitness_at, fitness_opinion, vitals_snapshot,
           recorded_by_external, created_at
         ) VALUES (
           $1, $2, $3, now(), $4, $5::jsonb,
           CASE WHEN $6::text IS NULL THEN NULL ELSE $4 END,
           CASE WHEN $6::text IS NULL THEN NULL ELSE now() END,
           $6, $7::jsonb, $8, now()
         )`,
        [
          newId(),
          this.hospitalId(),
          caseId,
          this.actorId(),
          json(body.magistrate),
          body.fitnessOpinion ?? null,
          json(body.vitalsSnapshot),
          body.recordedByExternal ?? null,
        ],
      );
      return this.loadCase(tx, caseId);
    });
  }

  async recordSexualAssault(caseId: string, body: SexualAssaultRequest): Promise<MlcCaseDetailView> {
    return this.guard(async (tx) => {
      const mlcCase = await this.requireCase(tx, caseId);
      const hospital = this.hospitalId();

      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO clinical.mlc_sexual_assault_exams (
           id, hospital_id, case_id, survivor_age_band, is_pocso, consent_matrix, chaperone_id,
           exam_proforma, safe_kit_checklist, prophylaxis, pregnancy_test, referrals,
           police_informed, sjpu_cwc_intimation, treatment_waived, waiver_recorded_at,
           created_at, created_by, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6::jsonb, $7,
           $8::jsonb, $9::jsonb, $10::jsonb, $11, $12::jsonb,
           $13::clinical."PoliceInformedBasis", $14::jsonb, true, now(),
           now(), $15, now()
         )
         ON CONFLICT (case_id) DO UPDATE SET
           exam_proforma      = COALESCE(EXCLUDED.exam_proforma, clinical.mlc_sexual_assault_exams.exam_proforma),
           safe_kit_checklist = COALESCE(EXCLUDED.safe_kit_checklist, clinical.mlc_sexual_assault_exams.safe_kit_checklist),
           prophylaxis        = COALESCE(EXCLUDED.prophylaxis, clinical.mlc_sexual_assault_exams.prophylaxis),
           pregnancy_test     = COALESCE(EXCLUDED.pregnancy_test, clinical.mlc_sexual_assault_exams.pregnancy_test),
           referrals          = COALESCE(EXCLUDED.referrals, clinical.mlc_sexual_assault_exams.referrals),
           sjpu_cwc_intimation= COALESCE(EXCLUDED.sjpu_cwc_intimation, clinical.mlc_sexual_assault_exams.sjpu_cwc_intimation),
           updated_at         = now()
         RETURNING (xmax = 0) AS inserted`,
        [
          newId(),
          hospital,
          caseId,
          body.survivorAgeBand,
          body.isPocso,
          JSON.stringify(body.consentMatrix),
          body.chaperoneId ?? null,
          json(body.examProforma),
          json(body.safeKitChecklist),
          json(body.prophylaxis),
          body.pregnancyTest ?? null,
          json(body.referrals),
          body.policeInformed,
          json(body.sjpuCwcIntimation),
          this.actorId(),
        ],
      );

      // Billing hears about the case once, on the first record. BNSS §397 makes
      // the treatment free, and the waiver arrives as an event rather than as a
      // biller remembering.
      if (asBool(rows[0]?.['inserted'])) {
        await this.outbox.publish(
          tx,
          mlcEvent('mlc.sexual_assault.case_opened', caseId, {
            caseId,
            mlcNo: asText(mlcCase['mlc_no']),
            isPocso: body.isPocso,
            policeInformed: body.policeInformed,
          }),
        );
      }

      return this.loadCase(tx, caseId);
    });
  }

  async recordDeath(caseId: string, body: DeathRequest): Promise<MlcCaseDetailView> {
    return this.guard(async (tx) => {
      const mlcCase = await this.requireCase(tx, caseId);

      await tx.query(
        `INSERT INTO clinical.mlc_deaths (
           id, hospital_id, case_id, kind, declared_at, declared_by,
           provisional_cause, manner_suspected, pm_required, body_custody, noc_no,
           mortuary_case_id, mccd_status, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4::clinical."MlcDeathKind", $5::timestamptz, $6,
           $7, $8::clinical."MannerOfDeath", $9, $10::clinical."BodyCustody", $11,
           $12, 'blocked', now(), now()
         )
         ON CONFLICT (case_id) DO UPDATE SET
           provisional_cause = COALESCE(EXCLUDED.provisional_cause, clinical.mlc_deaths.provisional_cause),
           manner_suspected  = EXCLUDED.manner_suspected,
           pm_required       = EXCLUDED.pm_required,
           body_custody      = EXCLUDED.body_custody,
           noc_no            = COALESCE(EXCLUDED.noc_no, clinical.mlc_deaths.noc_no),
           mortuary_case_id  = COALESCE(EXCLUDED.mortuary_case_id, clinical.mlc_deaths.mortuary_case_id),
           updated_at        = now()`,
        [
          newId(),
          this.hospitalId(),
          caseId,
          body.kind,
          body.declaredAt,
          this.actorId(),
          body.provisionalCause ?? null,
          body.mannerSuspected,
          body.pmRequired,
          body.bodyCustody,
          body.nocNo ?? null,
          body.mortuaryCaseId ?? null,
        ],
      );

      await this.outbox.publish(
        tx,
        mlcEvent('mlc.death.recorded', caseId, {
          caseId,
          mlcNo: asText(mlcCase['mlc_no']),
          kind: body.kind,
          mannerSuspected: body.mannerSuspected,
          pmRequired: body.pmRequired,
          bodyCustody: body.bodyCustody,
        }),
      );

      return this.loadCase(tx, caseId);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The discharge gate
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Let a patient leave with the medico-legal set incomplete.
   *
   * The Medical Superintendent's key and a reason. The reason lands on the case
   * rather than only in an audit row, so the next person to open the register
   * sees it without going looking — which is the difference between an override
   * that is on the record and one that is merely recorded.
   */
  async overrideGate(caseId: string): Promise<MlcCaseDetailView> {
    return this.guard(async (tx) => {
      const reason = this.reason('Overriding the medico-legal discharge gate');
      const actor = this.actorId();
      const outstanding = await this.outstandingFor(tx, caseId);

      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.mlc_cases
            SET gate_override_by = $2, gate_override_reason = $3, gate_overridden_at = now(), updated_at = now()
          WHERE id = $1 AND hospital_id = $4
          RETURNING mlc_no`,
        [caseId, actor, reason, this.hospitalId()],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.notFound('That MLC case does not exist.');

      await this.audit.write(tx, {
        action: 'update',
        entity: 'mlc_case',
        rowId: caseId,
        businessKey: asText(row['mlc_no']),
        dataClass: 'phi',
        before: { gateOverridden: false },
        after: { gateOverridden: true, reason, outstanding },
      });

      await this.outbox.publish(
        tx,
        mlcEvent('mlc.discharge_gate.overridden', caseId, {
          caseId,
          mlcNo: asText(row['mlc_no']),
          reason,
          overriddenBy: actor,
          outstanding,
        }),
      );

      return this.loadCase(tx, caseId);
    });
  }

  async dischargeGateFor(erVisitId: string): Promise<MlcDischargeGateView | null> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT id FROM clinical.mlc_cases
          WHERE er_visit_id = $1 AND hospital_id = $2 AND status <> 'cancelled'
          ORDER BY opened_at LIMIT 1`,
        [erVisitId, this.hospitalId()],
      );
      const caseId = asTextOrNull(rows[0]?.['id']);
      if (caseId === null) return null;
      return this.gateFor(tx, caseId);
    });
  }

  /**
   * The same three conditions the trigger checks, read rather than enforced.
   *
   * Duplicating the logic is deliberate and the duplication is one-directional:
   * the trigger decides, this only explains. If they ever drift, the patient is
   * refused at the door with a message that does not match this list — annoying,
   * and infinitely better than the reverse.
   */
  private async outstandingFor(tx: TransactionClient, caseId: string): Promise<string[]> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT
         NOT EXISTS (SELECT 1 FROM clinical.mlc_injuries i WHERE i.case_id = $1) AS no_injuries,
         NOT EXISTS (SELECT 1 FROM clinical.mlc_police_intimations p
                      WHERE p.case_id = $1 AND p.status IN ('dispatched','acknowledged')) AS no_intimation,
         EXISTS (SELECT 1 FROM clinical.mlc_evidence e
                  WHERE e.case_id = $1 AND e.status = 'collected') AS unsealed_items`,
      [caseId],
    );
    const row = rows[0] ?? {};
    const outstanding: string[] = [];
    if (asBool(row['no_injuries'])) {
      outstanding.push('the injuries documented (record "no external injury" if that is the finding)');
    }
    if (asBool(row['no_intimation'])) outstanding.push('the police intimation dispatched');
    if (asBool(row['unsealed_items'])) outstanding.push('every collected item sealed');
    return outstanding;
  }

  private async gateFor(tx: TransactionClient, caseId: string): Promise<MlcDischargeGateView> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT mlc_no, gate_override_by, gate_override_reason, gate_overridden_at
         FROM clinical.mlc_cases WHERE id = $1`,
      [caseId],
    );
    const row = rows[0] ?? {};
    const outstanding = await this.outstandingFor(tx, caseId);
    const overriddenBy = asTextOrNull(row['gate_override_by']);
    return {
      caseId,
      mlcNo: asText(row['mlc_no']),
      blocked: overriddenBy === null && outstanding.length > 0,
      outstanding,
      overriddenBy,
      overrideReason: asTextOrNull(row['gate_override_reason']),
      overriddenAt: asTextOrNull(row['gate_overridden_at']),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Worklists
  // ═══════════════════════════════════════════════════════════════════════════

  async worklist(query: WorklistQuery): Promise<Page<MlcWorklistRow>> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();
      const branch = this.branchId();

      if (query.kind === 'intimation_due') {
        const { rows } = await tx.query<Record<string, unknown>>(
          `SELECT c.id, c.mlc_no, c.category::text AS category, c.opened_at,
                  EXTRACT(EPOCH FROM (now() - (c.opened_at + make_interval(mins => $4))))/60 AS overdue
             FROM clinical.mlc_cases c
            WHERE c.hospital_id = $1 AND c.branch_id = $2
              AND c.status NOT IN ('cancelled','closed') AND NOT c.is_sensitive
              AND NOT EXISTS (SELECT 1 FROM clinical.mlc_police_intimations p
                               WHERE p.case_id = c.id AND p.status IN ('dispatched','acknowledged'))
            ORDER BY c.opened_at
            LIMIT $3`,
          [hospital, branch, query.limit, INTIMATION_TARGET_MINUTES],
        );
        return {
          items: rows.map((r) => ({
            caseId: asText(r['id']),
            mlcNo: asText(r['mlc_no']),
            category: asText(r['category']),
            openedAt: asText(r['opened_at']),
            detail: 'No intimation dispatched',
            minutesOverdue: Math.round(asNumber(r['overdue'])),
          })),
          nextCursor: null,
          hasMore: false,
        };
      }

      if (query.kind === 'reports_pending') {
        const { rows } = await tx.query<Record<string, unknown>>(
          `SELECT c.id, c.mlc_no, c.category::text AS category, c.opened_at
             FROM clinical.mlc_cases c
            WHERE c.hospital_id = $1 AND c.branch_id = $2
              AND c.status IN ('open','report_pending') AND NOT c.is_sensitive
              AND NOT EXISTS (SELECT 1 FROM clinical.mlc_reports r
                               WHERE r.case_id = c.id AND r.status IN ('final','final_wet_signed'))
            ORDER BY c.opened_at
            LIMIT $3`,
          [hospital, branch, query.limit],
        );
        return {
          items: rows.map((r) => ({
            caseId: asText(r['id']),
            mlcNo: asText(r['mlc_no']),
            category: asText(r['category']),
            openedAt: asText(r['opened_at']),
            detail: 'No signed report',
            minutesOverdue: minutesBetween(r['opened_at'], new Date().toISOString()),
          })),
          nextCursor: null,
          hasMore: false,
        };
      }

      if (query.kind === 'evidence_awaiting_police') {
        const { rows } = await tx.query<Record<string, unknown>>(
          `SELECT c.id, c.mlc_no, c.category::text AS category, c.opened_at,
                  count(e.id) AS items, min(e.collected_at) AS oldest
             FROM clinical.mlc_cases c
             JOIN clinical.mlc_evidence e ON e.case_id = c.id
            WHERE c.hospital_id = $1 AND c.branch_id = $2 AND NOT c.is_sensitive
              AND e.status IN ('collected','sealed') AND e.current_location <> 'police'
            GROUP BY c.id, c.mlc_no, c.category, c.opened_at
            ORDER BY min(e.collected_at)
            LIMIT $3`,
          [hospital, branch, query.limit],
        );
        return {
          items: rows.map((r) => ({
            caseId: asText(r['id']),
            mlcNo: asText(r['mlc_no']),
            category: asText(r['category']),
            openedAt: asText(r['opened_at']),
            detail: `${asText(r['items'])} item(s) held`,
            minutesOverdue: minutesBetween(r['oldest'], new Date().toISOString()),
          })),
          nextCursor: null,
          hasMore: false,
        };
      }

      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT c.id, c.mlc_no, c.category::text AS category, c.opened_at,
                m.court, m.next_hearing_at
           FROM clinical.mlc_court_matters m
           JOIN clinical.mlc_cases c ON c.id = m.case_id
          WHERE m.hospital_id = $1 AND c.branch_id = $2 AND m.next_hearing_at IS NOT NULL
          ORDER BY m.next_hearing_at
          LIMIT $3`,
        [hospital, branch, query.limit],
      );
      return {
        items: rows.map((r) => ({
          caseId: asText(r['id']),
          mlcNo: asText(r['mlc_no']),
          category: asText(r['category']),
          openedAt: asText(r['opened_at']),
          detail: `${asText(r['court'])} on ${asText(r['next_hearing_at']).slice(0, 10)}`,
          minutesOverdue: null,
        })),
        nextCursor: null,
        hasMore: false,
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Loading
  // ═══════════════════════════════════════════════════════════════════════════

  private async requireCase(tx: TransactionClient, caseId: string): Promise<Record<string, unknown>> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM clinical.mlc_cases WHERE id = $1 AND hospital_id = $2`,
      [caseId, this.hospitalId()],
    );
    const row = rows[0];
    if (row === undefined) throw AppError.notFound('That MLC case does not exist.');
    if (asText(row['status']) === 'cancelled') {
      throw AppError.conflict(
        `MLC ${asText(row['mlc_no'])} was cancelled. Open a new case rather than adding to this one.`,
      );
    }
    return row;
  }

  private async loadCase(tx: TransactionClient, caseId: string): Promise<MlcCaseDetailView> {
    const hospital = this.hospitalId();

    const { rows: caseRows } = await tx.query<Record<string, unknown>>(
      `SELECT c.*, v.er_no, v.display_name,
              (SELECT count(*) FROM clinical.mlc_police_intimations i WHERE i.case_id = c.id) AS intimation_count,
              (SELECT count(*) FROM clinical.mlc_injuries j WHERE j.case_id = c.id) AS injury_count,
              (SELECT count(*) FROM clinical.mlc_evidence e WHERE e.case_id = c.id) AS evidence_count,
              (SELECT count(*) FROM clinical.mlc_reports r WHERE r.case_id = c.id) AS report_count,
              (SELECT min(i.dispatched_at) FROM clinical.mlc_police_intimations i
                WHERE i.case_id = c.id AND i.dispatched_at IS NOT NULL) AS first_dispatch_at
         FROM clinical.mlc_cases c
         LEFT JOIN clinical.er_visits v ON v.id = c.er_visit_id
        WHERE c.id = $1 AND c.hospital_id = $2`,
      [caseId, hospital],
    );
    const caseRow = caseRows[0];
    if (caseRow === undefined) throw AppError.notFound('That MLC case does not exist.');

    const [intimations, injuries, evidence, reports, requests, declarations, death, sexualAssault, gate] =
      await Promise.all([
        this.loadIntimations(tx, caseId, asText(caseRow['opened_at'])),
        this.loadInjuries(tx, caseId),
        this.loadEvidenceForCase(tx, caseId),
        this.loadReports(tx, caseId),
        this.loadRequests(tx, caseId),
        this.loadDeclarations(tx, caseId),
        this.loadDeath(tx, caseId),
        this.loadSexualAssault(tx, caseId),
        this.gateFor(tx, caseId),
      ]);

    return {
      mlcCase: this.toCase(caseRow),
      intimations,
      injuries,
      evidence,
      reports,
      requests,
      dyingDeclarations: declarations,
      death,
      sexualAssault,
      gate,
    };
  }

  private toCase(row: Record<string, unknown>): MlcCaseView {
    return {
      id: asText(row['id']),
      mlcNo: asText(row['mlc_no']),
      category: asText(row['category']),
      subCategory: asTextOrNull(row['sub_category']),
      status: asText(row['status']),
      erVisitId: asTextOrNull(row['er_visit_id']),
      admissionId: asTextOrNull(row['admission_id']),
      patientId: asTextOrNull(row['patient_id']),
      tempTagId: asTextOrNull(row['temp_tag_id']),
      erNo: asTextOrNull(row['er_no']),
      displayName: asTextOrNull(row['display_name']),
      openedAt: asText(row['opened_at']),
      openedBy: asTextOrNull(row['opened_by']),
      suggestedFrom: asTextOrNull(row['suggested_from']),
      broughtBy: row['brought_by'] ?? null,
      informant: row['informant'] ?? null,
      historyAsStated: asTextOrNull(row['history_as_stated']),
      identificationMarks: asStringArray(row['identification_marks']),
      allegedIncidentAt: asTextOrNull(row['alleged_incident_at']),
      incidentPlace: asTextOrNull(row['incident_place']),
      consent: row['consent'] ?? null,
      intoxicationAssessment: row['intoxication_assessment'] ?? null,
      isSensitive: asBool(row['is_sensitive']),
      unflagReason: asTextOrNull(row['unflag_reason']),
      unflaggedBy: asTextOrNull(row['unflagged_by']),
      unflaggedAt: asTextOrNull(row['unflagged_at']),
      moId: asTextOrNull(row['mo_id']),
      closedAt: asTextOrNull(row['closed_at']),
      gateOverrideBy: asTextOrNull(row['gate_override_by']),
      gateOverrideReason: asTextOrNull(row['gate_override_reason']),
      gateOverriddenAt: asTextOrNull(row['gate_overridden_at']),
      minutesToIntimation: minutesBetween(row['opened_at'], row['first_dispatch_at']),
      intimationCount: asNumber(row['intimation_count'] ?? 0),
      injuryCount: asNumber(row['injury_count'] ?? 0),
      evidenceCount: asNumber(row['evidence_count'] ?? 0),
      reportCount: asNumber(row['report_count'] ?? 0),
    };
  }

  private async loadIntimations(
    tx: TransactionClient,
    caseId: string,
    openedAt: string,
  ): Promise<MlcIntimationView[]> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM clinical.mlc_police_intimations
        WHERE case_id = $1 AND hospital_id = $2 ORDER BY generated_at`,
      [caseId, this.hospitalId()],
    );
    const now = new Date().toISOString();
    return rows.map((r) => {
      const dispatched = asTextOrNull(r['dispatched_at']);
      const elapsed = minutesBetween(openedAt, dispatched ?? now) ?? 0;
      return {
        id: asText(r['id']),
        caseId,
        type: asText(r['type']),
        psName: asText(r['ps_name']),
        jurisdiction: asTextOrNull(r['jurisdiction']),
        addressedTo: asTextOrNull(r['addressed_to']),
        status: asText(r['status']),
        generatedAt: asText(r['generated_at']),
        dispatchedAt: dispatched,
        channels: r['channels'] ?? [],
        ackOfficerName: asTextOrNull(r['ack_officer_name']),
        ackOfficerBadge: asTextOrNull(r['ack_officer_badge']),
        ackAt: asTextOrNull(r['ack_at']),
        ackDueAt: asTextOrNull(r['ack_due_at']),
        failureReason: asTextOrNull(r['failure_reason']),
        minutesOverdue: elapsed - INTIMATION_TARGET_MINUTES,
      };
    });
  }

  private async loadInjuries(tx: TransactionClient, caseId: string): Promise<MlcInjuryView[]> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM clinical.mlc_injuries WHERE case_id = $1 AND hospital_id = $2 ORDER BY seq`,
      [caseId, this.hospitalId()],
    );
    return rows.map((r) => ({
      id: asText(r['id']),
      caseId,
      seq: asNumber(r['seq']),
      kind: asText(r['kind']),
      bodyView: asText(r['body_view']),
      xPct: asText(r['x_pct']),
      yPct: asText(r['y_pct']),
      side: asTextOrNull(r['side']),
      siteDescription: asText(r['site_description']),
      lengthCm: asTextOrNull(r['length_cm']),
      breadthCm: asTextOrNull(r['breadth_cm']),
      depthCm: asTextOrNull(r['depth_cm']),
      shape: asTextOrNull(r['shape']),
      edges: asTextOrNull(r['edges']),
      direction: asTextOrNull(r['direction']),
      colourStage: asTextOrNull(r['colour_stage']),
      ageEstimate: asTextOrNull(r['age_estimate']),
      foreignBody: asTextOrNull(r['foreign_body']),
      firearmFeatures: r['firearm_features'] ?? null,
      bnsClass: asText(r['bns_class']),
      grievousReason: asTextOrNull(r['grievous_reason']),
      weaponOpinion: asText(r['weapon_opinion']),
      consistentWithHistory: asText(r['consistent_with_history']),
      traumaInjuryId: asTextOrNull(r['trauma_injury_id']),
      recordedAt: asText(r['recorded_at']),
      recordedBy: asTextOrNull(r['recorded_by']),
    }));
  }

  private async loadEvidence(tx: TransactionClient, id: string): Promise<MlcEvidenceView> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM clinical.mlc_evidence WHERE id = $1 AND hospital_id = $2`,
      [id, this.hospitalId()],
    );
    const row = rows[0];
    if (row === undefined) throw AppError.notFound('That evidence item does not exist.');
    const custody = await this.loadCustody(tx, id);
    return this.toEvidence(row, custody);
  }

  private async loadEvidenceForCase(tx: TransactionClient, caseId: string): Promise<MlcEvidenceView[]> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM clinical.mlc_evidence WHERE case_id = $1 AND hospital_id = $2 ORDER BY item_no`,
      [caseId, this.hospitalId()],
    );
    const out: MlcEvidenceView[] = [];
    for (const row of rows) {
      out.push(this.toEvidence(row, await this.loadCustody(tx, asText(row['id']))));
    }
    return out;
  }

  /**
   * Read the chain, and check it.
   *
   * The genesis link is recomputed from the item id and every later link is
   * compared against its predecessor's hash. Returning the chain without
   * verifying it would be returning a list of rows and calling it a chain.
   */
  private async loadCustody(tx: TransactionClient, evidenceId: string): Promise<MlcCustodyEntryView[]> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT l.*,
              CASE WHEN l.seq = 1
                   THEN l.prev_hash = encode(ext.digest('mlc-custody-genesis:' || l.evidence_id::text, 'sha256'), 'hex')
                   ELSE l.prev_hash = lag(l.hash) OVER (PARTITION BY l.evidence_id ORDER BY l.seq)
              END AS link_intact
         FROM clinical.mlc_custody_log l
        WHERE l.evidence_id = $1 AND l.hospital_id = $2
        ORDER BY l.seq`,
      [evidenceId, this.hospitalId()],
    );
    return rows.map((r) => ({
      seq: asNumber(r['seq']),
      at: asText(r['at']),
      fromUserId: asTextOrNull(r['from_user_id']),
      toUserId: asTextOrNull(r['to_user_id']),
      toExternal: r['to_external'] ?? null,
      locationFrom: asText(r['location_from']),
      locationTo: asText(r['location_to']),
      purpose: asText(r['purpose']),
      sealIntact: asBool(r['seal_intact']),
      witnessUserId: asTextOrNull(r['witness_user_id']),
      conditionNotes: asTextOrNull(r['condition_notes']),
      temperatureC: asTextOrNull(r['temperature_c']),
      prevHash: asText(r['prev_hash']),
      hash: asText(r['hash']),
      linkIntact: asBool(r['link_intact']),
    }));
  }

  private toEvidence(row: Record<string, unknown>, custody: readonly MlcCustodyEntryView[]): MlcEvidenceView {
    return {
      id: asText(row['id']),
      caseId: asText(row['case_id']),
      itemNo: asNumber(row['item_no']),
      kind: asText(row['kind']),
      description: asText(row['description']),
      collectedAt: asText(row['collected_at']),
      collectedBy: asTextOrNull(row['collected_by']),
      sealNo: asTextOrNull(row['seal_no']),
      bagLabelRef: asTextOrNull(row['bag_label_ref']),
      sampleId: asTextOrNull(row['sample_id']),
      fileRef: asTextOrNull(row['file_ref']),
      sha256: asTextOrNull(row['sha256']),
      deviceId: asTextOrNull(row['device_id']),
      currentCustodianId: asTextOrNull(row['current_custodian_id']),
      currentLocation: asText(row['current_location']),
      status: asText(row['status']),
      notes: asTextOrNull(row['notes']),
      custody,
      chainIntact: custody.every((entry) => entry.linkIntact),
    };
  }

  private async loadReports(tx: TransactionClient, caseId: string): Promise<MlcReportView[]> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM clinical.mlc_reports WHERE case_id = $1 AND hospital_id = $2
        ORDER BY created_at DESC`,
      [caseId, this.hospitalId()],
    );
    return rows.map((r) => ({
      id: asText(r['id']),
      caseId,
      kind: asText(r['kind']),
      versionNo: asNumber(r['version_no']),
      status: asText(r['status']),
      templateRef: asTextOrNull(r['template_ref']),
      documentRef: asTextOrNull(r['document_ref']),
      sha256: asTextOrNull(r['sha256']),
      content: r['content'] ?? null,
      signedBy: asTextOrNull(r['signed_by']),
      dscRef: asTextOrNull(r['dsc_ref']),
      signedAt: asTextOrNull(r['signed_at']),
      addendumOf: asTextOrNull(r['addendum_of']),
      addendumReason: asTextOrNull(r['addendum_reason']),
      dispatches: r['dispatches'] ?? [],
      copyRegisterNo: asTextOrNull(r['copy_register_no']),
      createdAt: asText(r['created_at']),
    }));
  }

  private async loadRequests(tx: TransactionClient, caseId: string): Promise<MlcRequestView[]> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM clinical.mlc_requests WHERE case_id = $1 AND hospital_id = $2
        ORDER BY received_at DESC`,
      [caseId, this.hospitalId()],
    );
    return rows.map((r) => ({
      id: asText(r['id']),
      caseId,
      kind: asText(r['kind']),
      requester: r['requester'] ?? null,
      authorityRef: asTextOrNull(r['authority_ref']),
      receivedAt: asText(r['received_at']),
      approvedBy: asTextOrNull(r['approved_by']),
      approvedAt: asTextOrNull(r['approved_at']),
      providedAt: asTextOrNull(r['provided_at']),
      providedDocRefs: asStringArray(r['provided_doc_refs']),
      deniedReason: asTextOrNull(r['denied_reason']),
    }));
  }

  private async loadDeclarations(tx: TransactionClient, caseId: string): Promise<MlcDyingDeclarationView[]> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM clinical.mlc_dying_declarations WHERE case_id = $1 AND hospital_id = $2
        ORDER BY requested_at`,
      [caseId, this.hospitalId()],
    );
    return rows.map((r) => ({
      id: asText(r['id']),
      caseId,
      requestedAt: asText(r['requested_at']),
      magistrate: r['magistrate'] ?? null,
      fitnessCertifiedBy: asTextOrNull(r['fitness_certified_by']),
      fitnessAt: asTextOrNull(r['fitness_at']),
      fitnessOpinion: asTextOrNull(r['fitness_opinion']),
      recordedAt: asTextOrNull(r['recorded_at']),
      recordedByExternal: asTextOrNull(r['recorded_by_external']),
    }));
  }

  private async loadDeath(tx: TransactionClient, caseId: string): Promise<MlcDeathView | null> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM clinical.mlc_deaths WHERE case_id = $1 AND hospital_id = $2`,
      [caseId, this.hospitalId()],
    );
    const r = rows[0];
    if (r === undefined) return null;
    return {
      id: asText(r['id']),
      caseId,
      kind: asText(r['kind']),
      declaredAt: asText(r['declared_at']),
      declaredBy: asTextOrNull(r['declared_by']),
      provisionalCause: asTextOrNull(r['provisional_cause']),
      mannerSuspected: asText(r['manner_suspected']),
      pmRequired: asText(r['pm_required']),
      bodyCustody: asText(r['body_custody']),
      nocNo: asTextOrNull(r['noc_no']),
      mortuaryCaseId: asTextOrNull(r['mortuary_case_id']),
      mccdStatus: asText(r['mccd_status']),
    };
  }

  private async loadSexualAssault(
    tx: TransactionClient,
    caseId: string,
  ): Promise<MlcSexualAssaultView | null> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM clinical.mlc_sexual_assault_exams WHERE case_id = $1 AND hospital_id = $2`,
      [caseId, this.hospitalId()],
    );
    const r = rows[0];
    if (r === undefined) return null;
    return {
      id: asText(r['id']),
      caseId,
      survivorAgeBand: asText(r['survivor_age_band']),
      isPocso: asBool(r['is_pocso']),
      consentMatrix: r['consent_matrix'] ?? null,
      chaperoneId: asTextOrNull(r['chaperone_id']),
      examProforma: r['exam_proforma'] ?? null,
      safeKitChecklist: r['safe_kit_checklist'] ?? null,
      prophylaxis: r['prophylaxis'] ?? null,
      pregnancyTest: asTextOrNull(r['pregnancy_test']),
      referrals: r['referrals'] ?? null,
      followups: r['followups'] ?? null,
      policeInformed: asText(r['police_informed']),
      sjpuCwcIntimation: r['sjpu_cwc_intimation'] ?? null,
      treatmentWaived: asBool(r['treatment_waived']),
      createdAt: asText(r['created_at']),
    };
  }
}
