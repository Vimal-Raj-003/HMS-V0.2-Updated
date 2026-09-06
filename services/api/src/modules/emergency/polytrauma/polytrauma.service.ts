import { Inject, Injectable } from '@nestjs/common';
import { ProblemType, newId, type Page } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService, type TransactionClient } from '../../../core/db/database.service.js';
import { NumberingService } from '../../../core/numbering/numbering.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import { withPolytraumaErrors } from './polytrauma.errors.js';
import { polytraumaEvent } from './polytrauma.events.js';
import {
  CONSULT_SLA_MINUTES,
  type BloodRequest,
  type BloodUpdateRequest,
  type BoardQuery,
  type CloseCaseRequest,
  type ConsentRequest,
  type ConsultRequestBody,
  type ConsultResponseRequest,
  type EscalateRequest,
  type FamilyUpdateRequest,
  type HuddleRequest,
  type OpenCaseRequest,
  type PlanProcedureRequest,
  type ProcedureStateRequest,
  type SequenceRequest,
  type TaskCompleteRequest,
  type TaskRequest,
  type TeamRequest,
  type WaiverRequest,
} from './polytrauma.schemas.js';
import type {
  BloodView,
  BoardCardView,
  BoardDetailView,
  ConsultView,
  FamilyUpdateView,
  HuddleView,
  ProcedureView,
  TaskView,
  TeamMemberView,
} from './polytrauma.types.js';

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
function asNumberOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : asNumber(v);
}
function asBool(v: unknown): boolean {
  return v === true || v === 't' || v === 'true';
}
function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map(asText) : [];
}

/** Reads the same way the ordering trigger ranks. */
const PRIORITY_LABEL: Readonly<Record<string, string>> = {
  life_saving: 'life-saving',
  limb_saving: 'limb-saving',
  definitive: 'definitive',
  adjunct: 'adjunct',
};

/**
 * TR-007 — the polytrauma coordination board.
 *
 * ── The board's job is to say what is stopping the next thing ───────────────
 *
 * Every read model here computes `blockedBy`: one sentence naming the consent
 * that is not settled, or the four units that are cross-matched and not
 * reserved, or the neurosurgical consult nobody has answered. It is computed
 * once, in the service, so the card, the detail screen and the huddle note all
 * say the same thing — a board where two views disagree about why theatre is
 * waiting is worse than no board.
 *
 * ── The ordering rule is the database's ─────────────────────────────────────
 *
 * `resequence` sends the whole arrangement and lets the deferred constraint
 * trigger judge it at COMMIT. This service does not pre-check it: a second
 * implementation of the one rule that must not have two implementations is how
 * they come to disagree, and the disagreement would be silent.
 */
@Injectable()
export class PolytraumaService {
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
    if (value === null || value.trim().length < 12) {
      throw new AppError(
        ProblemType.VALIDATION_FAILED,
        `${what} needs grounds of at least twelve characters, sent in the \`x-reason\` header.`,
      );
    }
    return value.trim();
  }
  private guard<T>(fn: (tx: TransactionClient) => Promise<T>): Promise<T> {
    return withPolytraumaErrors(() => this.db.withTenant(currentTenantContext(), fn));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Read models
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * The one sentence saying why this procedure cannot go.
   *
   * Ordered by what a theatre coordinator would act on first: an unsettled
   * consent needs a conversation, missing blood needs a phone call to the bank,
   * and being behind something in the queue needs neither — it just needs the
   * thing in front to finish.
   */
  private blockedBy(r: Record<string, unknown>): string | null {
    const state = asText(r['state']);
    if (state === 'done' || state === 'abandoned' || state === 'in_theatre') return null;
    if (state === 'deferred') {
      const why = asTextOrNull(r['defer_reason']);
      return why === null ? 'Deferred.' : `Deferred: ${why}`;
    }

    const consent = asText(r['consent_state'] ?? 'not_sought');
    if (consent === 'not_sought') return 'Consent has not been sought.';
    if (consent === 'sought') return 'Consent has been sought and not yet answered.';
    if (consent === 'refused') return 'Consent was refused.';
    if (consent === 'withdrawn') return 'Consent was withdrawn.';
    const priority = asText(r['priority']);
    if (consent === 'emergency_waiver' && priority !== 'life_saving') {
      return `An emergency waiver does not cover a ${PRIORITY_LABEL[priority] ?? priority} procedure — somebody has to be asked.`;
    }

    const required = asNumber(r['blood_required'] ?? 0);
    const reserved = asNumber(r['blood_reserved'] ?? 0);
    if (required > reserved) {
      return `${String(required - reserved)} of ${String(required)} units still to be reserved — cross-matched is not the same as in the fridge.`;
    }

    return null;
  }

  private toProcedure(r: Record<string, unknown>): ProcedureView {
    return {
      id: asText(r['id']),
      caseId: asText(r['case_id']),
      name: asText(r['name']),
      specialty: asText(r['specialty']),
      fractureId: asTextOrNull(r['fracture_id']),
      side: asTextOrNull(r['side']),
      priority: asText(r['priority']),
      sequence: asNumber(r['sequence']),
      state: asText(r['state']),
      surgeonId: asTextOrNull(r['surgeon_id']),
      plannedFor: asTextOrNull(r['planned_for']),
      startedAt: asTextOrNull(r['started_at']),
      finishedAt: asTextOrNull(r['finished_at']),
      estimatedMinutes: asNumberOrNull(r['estimated_minutes']),
      rationale: asTextOrNull(r['rationale']),
      deferReason: asTextOrNull(r['defer_reason']),
      consentState: asText(r['consent_state'] ?? 'not_sought'),
      consentSignedBy: asTextOrNull(r['consent_signed_by']),
      bloodRequired: asNumber(r['blood_required'] ?? 0),
      bloodReserved: asNumber(r['blood_reserved'] ?? 0),
      blockedBy: this.blockedBy(r),
    };
  }

  private toConsult(r: Record<string, unknown>): ConsultView {
    const state = asText(r['state']);
    const dueAt = asText(r['due_at']);
    const open = state === 'requested' || state === 'acknowledged';
    const minutesRemaining = Math.round((new Date(dueAt).getTime() - Date.now()) / 60_000);
    return {
      id: asText(r['id']),
      caseId: asText(r['case_id']),
      specialty: asText(r['specialty']),
      question: asText(r['question']),
      urgency: asText(r['urgency']),
      slaMinutes: asNumber(r['sla_minutes']),
      requestedAt: asText(r['requested_at']),
      requestedBy: asTextOrNull(r['requested_by']),
      dueAt,
      state,
      acknowledgedAt: asTextOrNull(r['acknowledged_at']),
      seenAt: asTextOrNull(r['seen_at']),
      seenBy: asTextOrNull(r['seen_by']),
      advice: asTextOrNull(r['advice']),
      escalatedAt: asTextOrNull(r['escalated_at']),
      escalatedTo: asTextOrNull(r['escalated_to']),
      escalationNote: asTextOrNull(r['escalation_note']),
      declineReason: asTextOrNull(r['decline_reason']),
      breached: open && minutesRemaining < 0,
      minutesRemaining,
    };
  }

  private toBlood(r: Record<string, unknown>): BloodView {
    const required = asNumber(r['units_required']);
    const reserved = asNumber(r['units_reserved']);
    return {
      id: asText(r['id']),
      caseId: asText(r['case_id']),
      procedureId: asTextOrNull(r['procedure_id']),
      component: asText(r['component']),
      unitsRequired: required,
      unitsReserved: reserved,
      unitsIssued: asNumber(r['units_issued']),
      mtpActivated: asBool(r['mtp_activated']),
      crossmatchRef: asTextOrNull(r['crossmatch_ref']),
      neededBy: asTextOrNull(r['needed_by']),
      notes: asTextOrNull(r['notes']),
      shortBy: Math.max(0, required - reserved),
    };
  }

  private toCard(r: Record<string, unknown>): BoardCardView {
    const openedAt = asText(r['opened_at']);
    const closedAt = asTextOrNull(r['closed_at']);
    const until = closedAt === null ? Date.now() : new Date(closedAt).getTime();
    return {
      id: asText(r['id']),
      caseNo: asText(r['case_no']),
      patientId: asText(r['patient_id']),
      erVisitId: asTextOrNull(r['er_visit_id']),
      leadClinicianId: asTextOrNull(r['lead_clinician_id']),
      state: asText(r['state']),
      openedAt,
      closedAt,
      outcome: asTextOrNull(r['outcome']),
      issAtOpen: asNumberOrNull(r['iss_at_open']),
      nissAtOpen: asNumberOrNull(r['niss_at_open']),
      trissAtOpen: asTextOrNull(r['triss_at_open']),
      nextProcedure: asTextOrNull(r['next_procedure']),
      nextPriority: asTextOrNull(r['next_priority']),
      proceduresOutstanding: asNumber(r['procedures_outstanding'] ?? 0),
      consultsOpen: asNumber(r['consults_open'] ?? 0),
      consultsBreached: asNumber(r['consults_breached'] ?? 0),
      bloodShort: asNumber(r['blood_short'] ?? 0),
      blockingTasks: asNumber(r['blocking_tasks'] ?? 0),
      hoursOpen: Math.max(0, Math.round((until - new Date(openedAt).getTime()) / 3_600_000)),
    };
  }

  /** The card query. Every count the board renders, computed in one pass. */
  private readonly cardSelect = `
    SELECT c.*,
           (SELECT p.name FROM clinical.pt_procedures p
             WHERE p.case_id = c.id AND p.state IN ('planned','ready','in_theatre')
             ORDER BY p.sequence LIMIT 1) AS next_procedure,
           (SELECT p.priority::text FROM clinical.pt_procedures p
             WHERE p.case_id = c.id AND p.state IN ('planned','ready','in_theatre')
             ORDER BY p.sequence LIMIT 1) AS next_priority,
           (SELECT count(*) FROM clinical.pt_procedures p
             WHERE p.case_id = c.id AND p.state IN ('planned','ready','in_theatre')) AS procedures_outstanding,
           (SELECT count(*) FROM clinical.pt_consults k
             WHERE k.case_id = c.id AND k.state IN ('requested','acknowledged')) AS consults_open,
           (SELECT count(*) FROM clinical.pt_consults k
             WHERE k.case_id = c.id AND k.state IN ('requested','acknowledged') AND k.due_at < now()) AS consults_breached,
           (SELECT COALESCE(sum(GREATEST(b.units_required - b.units_reserved, 0)), 0)
              FROM clinical.pt_blood_requirements b WHERE b.case_id = c.id) AS blood_short,
           (SELECT count(*) FROM clinical.pt_tasks t
             WHERE t.case_id = c.id AND t.blocking AND t.completed_at IS NULL) AS blocking_tasks
      FROM clinical.pt_cases c`;

  private readonly procedureSelect = `
    SELECT p.*,
           COALESCE(s.state::text, 'not_sought') AS consent_state,
           s.signed_by AS consent_signed_by,
           COALESCE((SELECT sum(b.units_required) FROM clinical.pt_blood_requirements b
                      WHERE b.procedure_id = p.id), 0) AS blood_required,
           COALESCE((SELECT sum(b.units_reserved) FROM clinical.pt_blood_requirements b
                      WHERE b.procedure_id = p.id), 0) AS blood_reserved
      FROM clinical.pt_procedures p
      LEFT JOIN clinical.pt_consents s ON s.procedure_id = p.id`;

  // ═══════════════════════════════════════════════════════════════════════════
  // The board
  // ═══════════════════════════════════════════════════════════════════════════

  async listBoards(query: BoardQuery): Promise<Page<BoardCardView>> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `${this.cardSelect}
          WHERE c.hospital_id = $1 AND c.branch_id = $2
            AND ($3::text IS NULL OR c.state::text = $3)
            AND ($4::uuid IS NULL OR c.patient_id = $4)
          ORDER BY c.state = 'active' DESC, c.opened_at DESC
          LIMIT $5`,
        [this.hospitalId(), this.branchId(), query.state ?? null, query.patientId ?? null, query.limit],
      );
      return { items: rows.map((r) => this.toCard(r)), nextCursor: null, hasMore: false };
    });
  }

  private async loadBoard(tx: TransactionClient, id: string): Promise<BoardDetailView> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `${this.cardSelect} WHERE c.id = $1 AND c.hospital_id = $2`,
      [id, this.hospitalId()],
    );
    const row = rows[0];
    if (row === undefined) throw AppError.notFound('That board is not on this hospital’s record.');

    const [procedures, consults, blood, team, tasks, huddles, updates] = await Promise.all([
      tx.query<Record<string, unknown>>(`${this.procedureSelect} WHERE p.case_id = $1 ORDER BY p.sequence`, [
        id,
      ]),
      tx.query<Record<string, unknown>>(
        `SELECT * FROM clinical.pt_consults WHERE case_id = $1
          ORDER BY state IN ('requested','acknowledged') DESC, due_at`,
        [id],
      ),
      tx.query<Record<string, unknown>>(
        `SELECT * FROM clinical.pt_blood_requirements WHERE case_id = $1 ORDER BY component`,
        [id],
      ),
      tx.query<Record<string, unknown>>(
        `SELECT * FROM clinical.pt_team_members WHERE case_id = $1 ORDER BY is_lead DESC, role`,
        [id],
      ),
      tx.query<Record<string, unknown>>(
        `SELECT * FROM clinical.pt_tasks WHERE case_id = $1
          ORDER BY completed_at IS NOT NULL, blocking DESC, due_at NULLS LAST`,
        [id],
      ),
      tx.query<Record<string, unknown>>(
        `SELECT * FROM clinical.pt_huddles WHERE case_id = $1 ORDER BY held_at DESC LIMIT 20`,
        [id],
      ),
      tx.query<Record<string, unknown>>(
        `SELECT * FROM clinical.pt_family_updates WHERE case_id = $1 ORDER BY at DESC LIMIT 20`,
        [id],
      ),
    ]);

    return {
      ...this.toCard(row),
      notes: asTextOrNull(row['notes']),
      closureNotes: asTextOrNull(row['closure_notes']),
      procedures: procedures.rows.map((p) => this.toProcedure(p)),
      consults: consults.rows.map((c) => this.toConsult(c)),
      blood: blood.rows.map((b) => this.toBlood(b)),
      team: team.rows.map((t): TeamMemberView => ({
        id: asText(t['id']),
        userId: asText(t['user_id']),
        role: asText(t['role']),
        specialty: asTextOrNull(t['specialty']),
        isLead: asBool(t['is_lead']),
        joinedAt: asText(t['joined_at']),
        leftAt: asTextOrNull(t['left_at']),
      })),
      tasks: tasks.rows.map((t): TaskView => {
        const due = asTextOrNull(t['due_at']);
        const done = asTextOrNull(t['completed_at']);
        return {
          id: asText(t['id']),
          title: asText(t['title']),
          detail: asTextOrNull(t['detail']),
          ownerId: asTextOrNull(t['owner_id']),
          procedureId: asTextOrNull(t['procedure_id']),
          dueAt: due,
          completedAt: done,
          completedBy: asTextOrNull(t['completed_by']),
          blocking: asBool(t['blocking']),
          overdue: done === null && due !== null && new Date(due).getTime() < Date.now(),
        };
      }),
      huddles: huddles.rows.map((h): HuddleView => ({
        id: asText(h['id']),
        heldAt: asText(h['held_at']),
        chairId: asTextOrNull(h['chair_id']),
        specialties: asStringArray(h['specialties']),
        attendees: asStringArray(h['attendees']),
        decisions: asText(h['decisions']),
        concerns: asTextOrNull(h['concerns']),
      })),
      familyUpdates: updates.rows.map((u): FamilyUpdateView => ({
        id: asText(u['id']),
        at: asText(u['at']),
        byId: asTextOrNull(u['by_id']),
        spokeTo: asText(u['spoke_to']),
        relationship: asTextOrNull(u['relationship']),
        locale: asTextOrNull(u['locale']),
        summary: asText(u['summary']),
        prognosisDiscussed: asBool(u['prognosis_discussed']),
      })),
    };
  }

  async getBoard(id: string): Promise<BoardDetailView> {
    return this.guard((tx) => this.loadBoard(tx, id));
  }

  async openBoard(body: OpenCaseRequest): Promise<BoardDetailView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();
      const branch = this.branchId();
      const id = newId();

      const alloc = await this.numbering.allocate(tx, {
        key: 'POLYTRAUMA',
        branchId: branch,
        refType: 'polytrauma_case',
        refId: id,
      });

      // The scores are copied, not joined. "ISS 34" written on a huddle note has
      // to mean the same thing tomorrow as it did when it was written, and a
      // live join would change the card under the reader whenever somebody
      // amended a score.
      const { rows: scored } = await tx.query<Record<string, unknown>>(
        `SELECT iss, niss, triss FROM clinical.trauma_scores
          WHERE hospital_id = $1 AND er_visit_id = $2 AND status = 'locked'
          ORDER BY version_no DESC LIMIT 1`,
        [hospital, body.erVisitId ?? null],
      );
      const score = scored[0];

      await tx.query(
        `INSERT INTO clinical.pt_cases (
           id, hospital_id, branch_id, patient_id, er_visit_id, activation_id, admission_id,
           case_no, lead_clinician_id, state, opened_at, opened_by,
           iss_at_open, niss_at_open, triss_at_open, notes, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',now(),$10,$11,$12,$13,$14,now(),now())`,
        [
          id,
          hospital,
          branch,
          body.patientId,
          body.erVisitId ?? null,
          body.activationId ?? null,
          body.admissionId ?? null,
          alloc.formatted,
          body.leadClinicianId ?? this.actorId(),
          this.actorId(),
          score === undefined ? null : asNumberOrNull(score['iss']),
          score === undefined ? null : asNumberOrNull(score['niss']),
          score === undefined
            ? null
            : score['triss'] === null || score['triss'] === undefined
              ? null
              : `${(Number(asText(score['triss'])) * 100).toFixed(1)}%`,
          body.notes ?? null,
        ],
      );

      await tx.query(
        `INSERT INTO clinical.pt_team_members (id, hospital_id, case_id, user_id, role, is_lead, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'trauma_lead', true, now(), now())`,
        [newId(), hospital, id, body.leadClinicianId ?? this.actorId()],
      );

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'polytrauma_case',
        rowId: id,
        businessKey: alloc.formatted,
        dataClass: 'phi',
        before: null,
        after: { patientId: body.patientId, erVisitId: body.erVisitId ?? null },
      });

      await this.outbox.publish(
        tx,
        polytraumaEvent('polytrauma.case.opened', id, {
          caseId: id,
          caseNo: alloc.formatted,
          patientId: body.patientId,
          erVisitId: body.erVisitId ?? null,
          leadClinicianId: body.leadClinicianId ?? this.actorId(),
          iss: score === undefined ? null : asNumberOrNull(score['iss']),
        }),
      );

      return this.loadBoard(tx, id);
    });
  }

  /**
   * Close the board.
   *
   * The "no unfinished work" rule is a trigger and this method does not
   * pre-check it. Asking twice would mean two answers, and the trigger's is the
   * one that is true at commit.
   */
  async closeBoard(id: string, body: CloseCaseRequest): Promise<BoardDetailView> {
    return this.guard(async (tx) => {
      const before = await this.loadBoard(tx, id);

      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.pt_cases
            SET closed_at = now(), closed_by = $3, state = 'closed', outcome = $4,
                closure_notes = $5, updated_at = now()
          WHERE id = $1 AND hospital_id = $2 AND closed_at IS NULL
          RETURNING case_no, opened_at, closed_at`,
        [id, this.hospitalId(), this.actorId(), body.outcome, body.notes ?? null],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('That board is not open on this hospital’s record.');

      const deferred = before.procedures.filter(
        (p) => p.state === 'deferred' || p.state === 'abandoned',
      ).length;

      await this.audit.write(tx, {
        action: 'update',
        entity: 'polytrauma_case',
        rowId: id,
        businessKey: asText(row['case_no']),
        dataClass: 'phi',
        before: { closedAt: null },
        after: { closedAt: asText(row['closed_at']), outcome: body.outcome, deferred },
      });

      await this.outbox.publish(
        tx,
        polytraumaEvent('polytrauma.case.closed', id, {
          caseId: id,
          caseNo: asText(row['case_no']),
          outcome: body.outcome,
          procedures: before.procedures.length,
          deferred,
          hoursOpen: Math.max(
            0,
            Math.round(
              (new Date(asText(row['closed_at'])).getTime() - new Date(asText(row['opened_at'])).getTime()) /
                3_600_000,
            ),
          ),
        }),
      );

      return this.loadBoard(tx, id);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The queue
  // ═══════════════════════════════════════════════════════════════════════════

  async planProcedure(caseId: string, body: PlanProcedureRequest): Promise<BoardDetailView> {
    return this.guard(async (tx) => {
      const id = newId();

      // Placed at the back of its own urgency class, not at the end of the list.
      //
      // Appending would make the obvious thing impossible: a board with a
      // definitive nail on it, then somebody adds the laparotomy — the append
      // lands behind the nail and the ordering trigger refuses it, so adding a
      // life-saving procedure would require a separate reorder to become legal.
      // Where a class sits is not a surgical judgement, so the queue arranges
      // that itself. What *is* a judgement — which of two laparotomies goes
      // first — is what `resequence` is for.
      const { rows: slot } = await tx.query<Record<string, unknown>>(
        `SELECT COALESCE(max(sequence), 0) AS at
           FROM clinical.pt_procedures
          WHERE case_id = $1
            AND CASE priority
                  WHEN 'life_saving' THEN 1 WHEN 'limb_saving' THEN 2
                  WHEN 'definitive'  THEN 3 ELSE 4 END
              <= CASE $2::text
                  WHEN 'life_saving' THEN 1 WHEN 'limb_saving' THEN 2
                  WHEN 'definitive'  THEN 3 ELSE 4 END`,
        [caseId, body.priority],
      );
      const at = asNumber(slot[0]?.['at'] ?? 0) + 1;

      // Everything at or after that position moves down one. Done in a single
      // statement in descending order so the unique index never sees a clash.
      await tx.query(
        `UPDATE clinical.pt_procedures SET sequence = sequence + 1, updated_at = now()
          WHERE case_id = $1 AND sequence >= $2`,
        [caseId, at],
      );

      await tx.query(
        `INSERT INTO clinical.pt_procedures (
           id, hospital_id, case_id, name, specialty, fracture_id, injury_id, side,
           priority, sequence, state, surgeon_id, planned_for, estimated_minutes, rationale,
           created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::clinical."ProcedurePriority",$10,'planned',$11,$12,$13,$14,now(),now())`,
        [
          id,
          this.hospitalId(),
          caseId,
          body.name,
          body.specialty,
          body.fractureId ?? null,
          body.injuryId ?? null,
          body.side ?? null,
          body.priority,
          at,
          body.surgeonId ?? null,
          body.plannedFor ?? null,
          body.estimatedMinutes ?? null,
          body.rationale ?? null,
        ],
      );

      await tx.query(
        `INSERT INTO clinical.pt_consents (id, hospital_id, procedure_id, state, created_at, updated_at)
         VALUES ($1, $2, $3, 'not_sought', now(), now())`,
        [newId(), this.hospitalId(), id],
      );

      return this.loadBoard(tx, caseId);
    });
  }

  /**
   * Reorder the queue.
   *
   * The whole arrangement, in one transaction, judged by the deferred trigger at
   * COMMIT. Every position is moved out of the way first, because the unique
   * index on `(case_id, sequence)` would otherwise refuse a straight swap — and
   * the intermediate state is legitimately out of order, which is exactly why
   * the ordering check is deferred.
   */
  async resequence(caseId: string, body: SequenceRequest): Promise<BoardDetailView> {
    return this.guard(async (tx) => {
      const reason = this.reason('Reordering the surgical queue');
      const before = await this.loadBoard(tx, caseId);

      await tx.query(
        `UPDATE clinical.pt_procedures SET sequence = sequence + 100 WHERE case_id = $1 AND hospital_id = $2`,
        [caseId, this.hospitalId()],
      );

      for (const move of body.order) {
        const { rowCount } = await tx.query(
          `UPDATE clinical.pt_procedures SET sequence = $3, updated_at = now()
            WHERE id = $1 AND case_id = $2`,
          [move.procedureId, caseId, move.sequence],
        );
        if (rowCount === 0) {
          throw AppError.notFound('One of those procedures is not on this board.');
        }
      }

      // Anything the caller left out keeps a position after everything they
      // named, rather than staying at +100 where a later insert would collide.
      await tx.query(
        `WITH leftovers AS (
           SELECT id, row_number() OVER (ORDER BY sequence) AS n
             FROM clinical.pt_procedures
            WHERE case_id = $1 AND sequence > 100
         )
         UPDATE clinical.pt_procedures p
            SET sequence = $2 + leftovers.n, updated_at = now()
           FROM leftovers WHERE leftovers.id = p.id`,
        [caseId, body.order.length],
      );

      const after = await this.loadBoard(tx, caseId);

      await this.audit.write(tx, {
        action: 'update',
        entity: 'polytrauma_case',
        rowId: caseId,
        businessKey: after.caseNo,
        dataClass: 'phi',
        before: { queue: before.procedures.map((p) => `${String(p.sequence)}:${p.name}`) },
        after: { queue: after.procedures.map((p) => `${String(p.sequence)}:${p.name}`), reason },
      });

      // The whole arrangement, not the one row that moved. A position is
      // meaningless without the positions around it.
      await this.outbox.publish(
        tx,
        polytraumaEvent('polytrauma.sequence.changed', caseId, {
          caseId,
          changedBy: this.actorId(),
          reason,
          queue: after.procedures.map((p) => ({
            procedureId: p.id,
            name: p.name,
            priority: p.priority,
            sequence: p.sequence,
            state: p.state,
          })),
        }),
      );

      return after;
    });
  }

  async setProcedureState(
    caseId: string,
    procedureId: string,
    body: ProcedureStateRequest,
  ): Promise<BoardDetailView> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.pt_procedures
            SET state = $4::clinical."ProcedureState",
                surgeon_id = COALESCE($5::uuid, surgeon_id),
                started_at = CASE WHEN $4::text = 'in_theatre' THEN COALESCE($6::timestamptz, now()) ELSE started_at END,
                finished_at = CASE WHEN $4::text = 'done' THEN COALESCE($6::timestamptz, now()) ELSE finished_at END,
                defer_reason = COALESCE($7, defer_reason),
                updated_at = now()
          WHERE id = $1 AND case_id = $2 AND hospital_id = $3
          RETURNING name, priority::text AS priority, surgeon_id`,
        [
          procedureId,
          caseId,
          this.hospitalId(),
          body.state,
          body.surgeonId ?? null,
          body.at ?? null,
          body.reason ?? null,
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.notFound('That procedure is not on this board.');

      if (body.state === 'in_theatre') {
        const { rows: consent } = await tx.query<Record<string, unknown>>(
          `SELECT state::text AS state FROM clinical.pt_consents WHERE procedure_id = $1`,
          [procedureId],
        );
        await this.outbox.publish(
          tx,
          polytraumaEvent('polytrauma.procedure.entered_theatre', procedureId, {
            caseId,
            procedureId,
            name: asText(row['name']),
            priority: asText(row['priority']),
            surgeonId: asTextOrNull(row['surgeon_id']),
            consentState: asText(consent[0]?.['state'] ?? 'not_sought'),
          }),
        );
      }

      return this.loadBoard(tx, caseId);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Consent
  // ═══════════════════════════════════════════════════════════════════════════

  async recordConsent(caseId: string, procedureId: string, body: ConsentRequest): Promise<BoardDetailView> {
    return this.write(caseId, procedureId, { ...body, waiver: false, reason: body.reason ?? null });
  }

  /**
   * Record an emergency waiver.
   *
   * A separate method behind a separate route and a separate key, rather than a
   * `state` the ordinary consent route would accept. A narrow permission that
   * can be reached by sending a different field to the wide route is not a
   * permission — and this is the one that says nobody could be asked.
   */
  async recordWaiver(caseId: string, procedureId: string, body: WaiverRequest): Promise<BoardDetailView> {
    // Asked for twice on purpose: the header reason is the audit trail's, and
    // `body.reason` is the clinical record's, sitting on the row a court reads.
    this.reason('An emergency consent waiver');
    return this.write(caseId, procedureId, {
      state: 'emergency_waiver',
      risksDiscussed: body.risksDiscussed,
      ...(body.witnessName === undefined ? {} : { witnessName: body.witnessName }),
      ...(body.documentRef === undefined ? {} : { documentRef: body.documentRef }),
      waiver: true,
      reason: body.reason,
    });
  }

  private async write(
    caseId: string,
    procedureId: string,
    body: Omit<ConsentRequest, 'state' | 'reason'> & {
      readonly state: string;
      readonly waiver: boolean;
      readonly reason: string | null;
    },
  ): Promise<BoardDetailView> {
    return this.guard(async (tx) => {
      const waiver = body.waiver;
      const reason = body.reason;

      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.pt_consents
            SET state = $3::clinical."ConsentState",
                signed_by = COALESCE($4, signed_by),
                relationship = COALESCE($5, relationship),
                explained_locale = COALESCE($6, explained_locale),
                explained_by = $7,
                risks_discussed = CASE WHEN cardinality($8::text[]) > 0 THEN $8::text[] ELSE risks_discussed END,
                sought_at = COALESCE(sought_at, now()),
                decided_at = CASE WHEN $3::text IN ('not_sought','sought') THEN NULL ELSE now() END,
                reason = COALESCE($9, reason),
                witness_name = COALESCE($10, witness_name),
                document_ref = COALESCE($11, document_ref),
                updated_at = now()
          WHERE procedure_id = $1 AND hospital_id = $2
          RETURNING id`,
        [
          procedureId,
          this.hospitalId(),
          body.state,
          body.signedBy ?? null,
          body.relationship ?? null,
          body.explainedLocale ?? null,
          this.actorId(),
          body.risksDiscussed,
          reason,
          body.witnessName ?? null,
          body.documentRef ?? null,
        ],
      );
      if (rows[0] === undefined)
        throw AppError.notFound('That procedure has no consent record on this board.');

      await this.audit.write(tx, {
        action: waiver ? 'override' : 'update',
        entity: 'polytrauma_consent',
        rowId: procedureId,
        businessKey: procedureId,
        dataClass: 'phi',
        before: null,
        after: { state: body.state, signedBy: body.signedBy ?? null, reason },
      });

      if (waiver && reason !== null) {
        await this.outbox.publish(
          tx,
          polytraumaEvent('polytrauma.consent.waived', procedureId, {
            caseId,
            procedureId,
            recordedBy: this.actorId(),
            reason,
          }),
        );
      }

      return this.loadBoard(tx, caseId);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Blood
  // ═══════════════════════════════════════════════════════════════════════════

  async planBlood(caseId: string, body: BloodRequest): Promise<BoardDetailView> {
    return this.guard(async (tx) => {
      const id = newId();
      await tx.query(
        `INSERT INTO clinical.pt_blood_requirements (
           id, hospital_id, case_id, procedure_id, component, units_required, units_reserved,
           mtp_activated, mtp_activated_at, crossmatch_ref, needed_by, notes, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CASE WHEN $8::boolean THEN now() ELSE NULL END, $9,$10::timestamptz,$11,now(),now())`,
        [
          id,
          this.hospitalId(),
          caseId,
          body.procedureId ?? null,
          body.component,
          body.unitsRequired,
          body.unitsReserved,
          body.mtpActivated,
          body.crossmatchRef ?? null,
          body.neededBy ?? null,
          body.notes ?? null,
        ],
      );

      // Emitted when the shortfall is written, not when theatre discovers it.
      // The blood bank should be told at the moment somebody realises six units
      // are needed, which is hours before the knife.
      if (body.unitsReserved < body.unitsRequired) {
        await this.outbox.publish(
          tx,
          polytraumaEvent('polytrauma.blood.short', id, {
            caseId,
            procedureId: body.procedureId ?? null,
            component: body.component,
            unitsRequired: body.unitsRequired,
            unitsReserved: body.unitsReserved,
            neededBy: body.neededBy ?? null,
          }),
        );
      }

      return this.loadBoard(tx, caseId);
    });
  }

  async updateBlood(caseId: string, bloodId: string, body: BloodUpdateRequest): Promise<BoardDetailView> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.pt_blood_requirements
            SET units_reserved = COALESCE($4, units_reserved),
                units_issued = COALESCE($5, units_issued),
                crossmatch_ref = COALESCE($6, crossmatch_ref),
                mtp_activated = COALESCE($7, mtp_activated),
                mtp_activated_at = CASE WHEN COALESCE($7, mtp_activated) AND mtp_activated_at IS NULL
                                        THEN now() ELSE mtp_activated_at END,
                updated_at = now()
          WHERE id = $1 AND case_id = $2 AND hospital_id = $3
          RETURNING id`,
        [
          bloodId,
          caseId,
          this.hospitalId(),
          body.unitsReserved ?? null,
          body.unitsIssued ?? null,
          body.crossmatchRef ?? null,
          body.mtpActivated ?? null,
        ],
      );
      if (rows[0] === undefined) throw AppError.notFound('That blood requirement is not on this board.');
      return this.loadBoard(tx, caseId);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Consults
  // ═══════════════════════════════════════════════════════════════════════════

  async requestConsult(caseId: string, body: ConsultRequestBody): Promise<BoardDetailView> {
    return this.guard(async (tx) => {
      const id = newId();
      const sla = body.slaMinutes ?? CONSULT_SLA_MINUTES[body.urgency] ?? 60;

      // `due_at` is written by a trigger; the placeholder below is overwritten
      // before the row lands. Sending it at all is a NOT NULL formality, and
      // computing it here would be the second implementation of the arithmetic.
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO clinical.pt_consults (
           id, hospital_id, case_id, specialty, question, urgency, sla_minutes,
           requested_at, requested_by, due_at, state, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7, now(), $8, now(), 'requested', now(), now())
         RETURNING due_at`,
        [id, this.hospitalId(), caseId, body.specialty, body.question, body.urgency, sla, this.actorId()],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The consult was not requested.');

      await this.outbox.publish(
        tx,
        polytraumaEvent('polytrauma.consult.requested', id, {
          caseId,
          consultId: id,
          specialty: body.specialty,
          urgency: body.urgency,
          slaMinutes: sla,
          dueAt: asText(row['due_at']),
        }),
      );

      return this.loadBoard(tx, caseId);
    });
  }

  async respondToConsult(
    caseId: string,
    consultId: string,
    body: ConsultResponseRequest,
  ): Promise<BoardDetailView> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.pt_consults
            SET state = $4::clinical."ConsultState",
                acknowledged_at = CASE WHEN acknowledged_at IS NULL THEN now() ELSE acknowledged_at END,
                acknowledged_by = COALESCE(acknowledged_by, $5),
                seen_at = CASE WHEN $4::text IN ('seen','advised') THEN COALESCE(seen_at, now()) ELSE seen_at END,
                seen_by = CASE WHEN $4::text IN ('seen','advised') THEN COALESCE(seen_by, $5) ELSE seen_by END,
                advice = COALESCE($6, advice),
                decline_reason = COALESCE($7, decline_reason),
                updated_at = now()
          WHERE id = $1 AND case_id = $2 AND hospital_id = $3
          RETURNING id`,
        [
          consultId,
          caseId,
          this.hospitalId(),
          body.state,
          this.actorId(),
          body.advice ?? null,
          body.declineReason ?? null,
        ],
      );
      if (rows[0] === undefined) throw AppError.notFound('That consult is not on this board.');
      return this.loadBoard(tx, caseId);
    });
  }

  /**
   * Escalate a consult to a named person.
   *
   * The note is required only when the target has not been passed, and the
   * database enforces that. Reading `due_at` here is to decide whether to
   * demand the note *before* the round trip fails, not to make the decision —
   * the trigger makes it.
   */
  async escalateConsult(caseId: string, consultId: string, body: EscalateRequest): Promise<BoardDetailView> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.pt_consults
            SET escalated_at = now(), escalated_to = $4, escalation_note = $5, updated_at = now()
          WHERE id = $1 AND case_id = $2 AND hospital_id = $3 AND escalated_at IS NULL
          RETURNING specialty, due_at, requested_at`,
        [consultId, caseId, this.hospitalId(), body.escalatedTo, body.note ?? null],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict('That consult is not on this board, or it has already been escalated.');
      }

      const waiting = Math.max(
        0,
        Math.round((Date.now() - new Date(asText(row['requested_at'])).getTime()) / 60_000),
      );

      await this.audit.write(tx, {
        action: 'update',
        entity: 'polytrauma_consult',
        rowId: consultId,
        businessKey: asText(row['specialty']),
        dataClass: 'phi',
        before: null,
        after: { escalatedTo: body.escalatedTo, minutesWaiting: waiting, note: body.note ?? null },
      });

      await this.outbox.publish(
        tx,
        polytraumaEvent('polytrauma.consult.escalated', consultId, {
          caseId,
          consultId,
          specialty: asText(row['specialty']),
          escalatedTo: body.escalatedTo,
          breached: Date.now() > new Date(asText(row['due_at'])).getTime(),
          minutesWaiting: waiting,
          note: body.note ?? null,
        }),
      );

      return this.loadBoard(tx, caseId);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Team, tasks, huddles, family
  // ═══════════════════════════════════════════════════════════════════════════

  async assignTeam(caseId: string, body: TeamRequest): Promise<BoardDetailView> {
    return this.guard(async (tx) => {
      // A board with two leads has none, and the partial unique index says so.
      // Standing the old one down here rather than refusing means "make this
      // person lead" does what it says.
      if (body.isLead) {
        await tx.query(
          `UPDATE clinical.pt_team_members SET is_lead = false, updated_at = now()
            WHERE case_id = $1 AND hospital_id = $2 AND is_lead AND left_at IS NULL`,
          [caseId, this.hospitalId()],
        );
        await tx.query(
          `UPDATE clinical.pt_cases SET lead_clinician_id = $3, updated_at = now()
            WHERE id = $1 AND hospital_id = $2`,
          [caseId, this.hospitalId(), body.userId],
        );
      }

      await tx.query(
        `INSERT INTO clinical.pt_team_members
           (id, hospital_id, case_id, user_id, role, specialty, is_lead, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now(),now())`,
        [newId(), this.hospitalId(), caseId, body.userId, body.role, body.specialty ?? null, body.isLead],
      );

      return this.loadBoard(tx, caseId);
    });
  }

  async addTask(caseId: string, body: TaskRequest): Promise<BoardDetailView> {
    return this.guard(async (tx) => {
      await tx.query(
        `INSERT INTO clinical.pt_tasks
           (id, hospital_id, case_id, title, detail, owner_id, procedure_id, due_at, blocking, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9,now(),now())`,
        [
          newId(),
          this.hospitalId(),
          caseId,
          body.title,
          body.detail ?? null,
          body.ownerId ?? null,
          body.procedureId ?? null,
          body.dueAt ?? null,
          body.blocking,
        ],
      );
      return this.loadBoard(tx, caseId);
    });
  }

  async completeTask(caseId: string, taskId: string, body: TaskCompleteRequest): Promise<BoardDetailView> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.pt_tasks
            SET completed_at = now(), completed_by = $4,
                detail = COALESCE($5, detail), updated_at = now()
          WHERE id = $1 AND case_id = $2 AND hospital_id = $3 AND completed_at IS NULL
          RETURNING id`,
        [taskId, caseId, this.hospitalId(), this.actorId(), body.notes ?? null],
      );
      if (rows[0] === undefined) throw AppError.conflict('That task is not open on this board.');
      return this.loadBoard(tx, caseId);
    });
  }

  async recordHuddle(caseId: string, body: HuddleRequest): Promise<BoardDetailView> {
    return this.guard(async (tx) => {
      await tx.query(
        `INSERT INTO clinical.pt_huddles
           (id, hospital_id, case_id, held_at, chair_id, specialties, attendees, decisions, concerns, created_at)
         VALUES ($1,$2,$3,now(),$4,$5::text[],$6::uuid[],$7,$8,now())`,
        [
          newId(),
          this.hospitalId(),
          caseId,
          this.actorId(),
          body.specialties,
          body.attendees,
          body.decisions,
          body.concerns ?? null,
        ],
      );
      return this.loadBoard(tx, caseId);
    });
  }

  async recordFamilyUpdate(caseId: string, body: FamilyUpdateRequest): Promise<BoardDetailView> {
    return this.guard(async (tx) => {
      await tx.query(
        `INSERT INTO clinical.pt_family_updates
           (id, hospital_id, case_id, at, by_id, spoke_to, relationship, locale, summary, prognosis_discussed, created_at)
         VALUES ($1,$2,$3,now(),$4,$5,$6,$7,$8,$9,now())`,
        [
          newId(),
          this.hospitalId(),
          caseId,
          this.actorId(),
          body.spokeTo,
          body.relationship ?? null,
          body.locale ?? null,
          body.summary,
          body.prognosisDiscussed,
        ],
      );
      return this.loadBoard(tx, caseId);
    });
  }
}
