import { Inject, Injectable } from '@nestjs/common';
import { newId, type Page } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService, type TransactionClient } from '../../../core/db/database.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { CursorService } from '../../../core/pagination/cursor.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import { CareTeamService } from './care-team.service.js';
import { clinicalEvent } from './clinical.events.js';
import type { RecordAllergyRequest, TimelineQuery } from './encounter.schemas.js';

/**
 * OP-002 §3.6 — the patient timeline, and the three lists that hang off it.
 *
 * **Why a UNION of five bounded branches rather than one big join.** The
 * timeline is every visit, encounter, diagnosis, observation and document in
 * date order. A join would produce a cartesian mess and a single table cannot
 * hold them. Each branch here is an index-only descending scan on its own
 * `(hospital_id, patient_id, <time> DESC)` index, bounded by the same keyset
 * predicate and the same `LIMIT`, and the outer query merges the five sorted
 * streams. That is what keeps phase-02 exit gate 6 — five years of history in
 * under a second at p95 — a property of the plan rather than a hope.
 *
 * **The window is bounded by default.** `clinical.vitals` is partitioned
 * monthly and carries every ward and ICU observation in the group; an unbounded
 * timeline would touch every partition ever created. Five years is the default
 * because that is what the exit gate measures, and a caller who wants more says
 * so with `from`.
 *
 * **Access is care-team or break-glass.** OP-002 §14 AC-10: a doctor from
 * another department opening a patient who is not theirs gets a reason prompt,
 * and the act is recorded. See `CareTeamService`.
 */

const RESOURCE = 'opd.timeline';

/** Exit gate 6 measures five years. A caller who needs more passes `from`. */
const DEFAULT_WINDOW_YEARS = 5;

export interface TimelineItem {
  readonly id: string;
  readonly kind: string;
  readonly occurred_at: Date;
  readonly title: string;
  readonly detail: Record<string, unknown>;
}

export interface ProblemItem {
  readonly id: string;
  readonly code_system_key: string;
  readonly code: string;
  readonly description: string;
  readonly status: string;
  readonly onset_date: Date | null;
  readonly is_chronic: boolean;
  readonly source_encounter_id: string | null;
}

export interface MedicationItem {
  readonly id: string;
  readonly drug_key: string | null;
  readonly drug_text: string;
  readonly atc_code: string | null;
  readonly dose_text: string | null;
  readonly frequency_code: string | null;
  readonly route: string | null;
  readonly source: string;
  readonly status: string;
  readonly started_at: Date | null;
  readonly stopped_at: Date | null;
}

export interface AllergyItem {
  readonly id: string;
  readonly category: string;
  readonly substance_text: string;
  readonly substance_code: string | null;
  readonly reaction: readonly string[];
  readonly criticality: string;
  readonly severity: string;
  readonly status: string;
  readonly verification: string;
  readonly recorded_by: string;
  readonly recorded_at: Date;
}

/**
 * The clinical severity vocabulary (`allergy.recorded`, and what a clinician
 * says) mapped onto `patient.PatientAlertSeverity`, which the column stores and
 * the banner renders. One table, in one direction each, so the two never drift.
 */
const SEVERITY_TO_COLUMN: Readonly<Record<string, string>> = {
  mild: 'low',
  moderate: 'moderate',
  severe: 'high',
  anaphylaxis: 'critical',
};

const COLUMN_TO_SEVERITY: Readonly<Record<string, string>> = {
  info: 'mild',
  low: 'mild',
  moderate: 'moderate',
  high: 'severe',
  critical: 'anaphylaxis',
};

/** `patient.PatientAllergyCategory` → the event's narrower `substanceType`. */
const EVENT_SUBSTANCE_TYPE: Readonly<Record<string, string>> = {
  drug: 'drug',
  food: 'food',
  environment: 'environment',
  latex: 'other',
  biologic: 'other',
  other: 'other',
};

@Injectable()
export class TimelineService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(CursorService) private readonly cursors: CursorService,
    @Inject(CareTeamService) private readonly careTeam: CareTeamService,
  ) {}

  /** OP-002 §6 `GET /patients/{id}/timeline`. */
  async timeline(patientId: string, query: TimelineQuery): Promise<Page<TimelineItem>> {
    const ctx = getContext();
    const hospitalId = ctx.hospitalId ?? '';
    const resource = `${RESOURCE}.items`;
    const limit = this.cursors.pageSize(query.limit);
    const after = this.cursors.start(query.cursor, { hospitalId, resource });
    const types = new Set<string>(query.types ?? []);
    const wants = (kind: string): boolean => types.size === 0 || types.has(kind);

    return this.db.withTenant(currentTenantContext(), async (tx) => {
      await this.assertPatient(tx, patientId);
      await this.careTeam.authorise(tx, { patientId, entity: 'clinical.timeline' });

      const built = buildTimelineQuery({
        patientId,
        kinds: TIMELINE_KINDS.filter((kind) => wants(kind)),
        from: query.from ?? new Date(Date.now() - DEFAULT_WINDOW_YEARS * 365.25 * 86_400_000).toISOString(),
        to: query.to ?? null,
        cursor: after === null ? null : { at: String(after.k[0] ?? ''), id: after.id },
        limit: limit + 1,
      });

      if (built.sql === null) {
        return { items: [], nextCursor: null, hasMore: false };
      }

      const fetched = await tx.rows<TimelineItem & { cursor_key: string }>(built.sql, built.values);

      const page = this.cursors.keysetPage<TimelineItem>(fetched, limit, {
        hospitalId,
        resource,
        direction: 'desc',
      });

      await this.audit.write(tx, {
        action: 'read_phi',
        entity: 'clinical.timeline',
        rowId: patientId,
        businessKey: null,
        dataClass: 'phi',
        patientId,
        before: null,
        after: null,
        rowCount: page.items.length,
      });

      return page;
    });
  }

  /** OP-002 §6 `GET /patients/{id}/problems`. */
  async problems(patientId: string): Promise<readonly ProblemItem[]> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      await this.assertPatient(tx, patientId);
      await this.careTeam.authorise(tx, { patientId, entity: 'clinical.problems' });

      const rows = await tx.rows<ProblemItem>(
        `SELECT id, code_system_key, code, description, status::text AS status,
                onset_date, is_chronic, source_encounter_id
           FROM clinical.problems
          WHERE patient_id = $1
          ORDER BY status, created_at DESC`,
        [patientId],
      );

      await this.audit.write(tx, {
        action: 'read_phi',
        entity: 'clinical.problems',
        rowId: patientId,
        businessKey: null,
        dataClass: 'phi',
        patientId,
        before: null,
        after: null,
        rowCount: rows.length,
      });

      return rows;
    });
  }

  /**
   * OP-002 §6 `GET /patients/{id}/medications` — the reconciled list.
   *
   * Read-only here. The list is written by the prescribing module when an Rx is
   * signed and by the reconciliation step of the nursing pre-consult; a bare
   * POST on this route would let a medication appear on the list that no
   * prescription and no reconciliation accounts for, and the interaction check
   * would then fire on a drug nobody can explain.
   */
  async medications(patientId: string): Promise<readonly MedicationItem[]> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      await this.assertPatient(tx, patientId);
      await this.careTeam.authorise(tx, { patientId, entity: 'clinical.medications' });

      const rows = await tx.rows<MedicationItem>(
        `SELECT id, drug_key, drug_text, atc_code, dose_text, frequency_code,
                route::text AS route, source::text AS source, status::text AS status,
                started_at, stopped_at
           FROM clinical.medications
          WHERE patient_id = $1
          ORDER BY status, created_at DESC`,
        [patientId],
      );

      await this.audit.write(tx, {
        action: 'read_phi',
        entity: 'clinical.medications',
        rowId: patientId,
        businessKey: null,
        dataClass: 'phi',
        patientId,
        before: null,
        after: null,
        rowCount: rows.length,
      });

      return rows;
    });
  }

  /** OP-002 §6 `GET /patients/{id}/allergies`. */
  async allergies(patientId: string): Promise<readonly AllergyItem[]> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      await this.assertPatient(tx, patientId);
      await this.careTeam.authorise(tx, { patientId, entity: 'patient.allergies' });
      const rows = await this.loadAllergies(tx, patientId);

      await this.audit.write(tx, {
        action: 'read_phi',
        entity: 'patient.allergies',
        rowId: patientId,
        businessKey: null,
        dataClass: 'phi',
        patientId,
        before: null,
        after: null,
        rowCount: rows.length,
      });

      return rows;
    });
  }

  /**
   * OP-002 §6 `POST /patients/{id}/allergies` — the fact the hard stop
   * evaluates against.
   *
   * `patient.allergies.recorded_by` is NOT NULL and a trigger promotes the
   * patient's four-arm `allergy_statement` to `known`, so recording one here is
   * what turns "nobody has asked" into "asked, and here is what they said". The
   * permission is `clinicalSafetyExempt` in the catalogue: a hospital with an
   * unpaid invoice can still record an allergy (EN-040 §5).
   */
  async recordAllergy(patientId: string, body: RecordAllergyRequest): Promise<AllergyItem> {
    const ctx = getContext();
    const actor = ctx.userId;
    if (actor === null) {
      throw new Error('TimelineService reached without an authenticated user; a guarded route cannot.');
    }
    const id = newId();

    await this.db.withTenant(currentTenantContext(), async (tx) => {
      const patient = await this.assertPatient(tx, patientId);

      await tx.query(
        `INSERT INTO patient.allergies (
           id, hospital_id, patient_id, category, code_system_key, substance_code, substance_text,
           reaction, reaction_text, criticality, severity, status, informant, verification,
           onset_on, recorded_by, recorded_at, notes, created_by, updated_by, updated_at
         ) VALUES (
           $1, $2, $3, $4::patient."PatientAllergyCategory", $5, $6, $7,
           $8, $9, $10::patient."PatientAllergyCriticality", $11::patient."PatientAlertSeverity",
           'active', $12, $13,
           $14::date, $15, now(), $16, $15, $15, now()
         )`,
        [
          id,
          ctx.hospitalId,
          patientId,
          body.category,
          body.codeSystemKey ?? null,
          body.substanceCode ?? null,
          body.substanceText,
          body.reaction,
          body.reactionText ?? null,
          body.criticality,
          SEVERITY_TO_COLUMN[body.severity] ?? 'moderate',
          body.informant,
          body.verification,
          body.onsetOn ?? null,
          actor,
          body.notes ?? null,
        ],
      );

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'patient.allergies',
        rowId: id,
        businessKey: patient.uhid,
        dataClass: 'phi',
        patientId,
        before: null,
        after: {
          category: body.category,
          substance_text: body.substanceText,
          substance_code: body.substanceCode ?? null,
          severity: body.severity,
          criticality: body.criticality,
          verification: body.verification,
        },
      });

      await this.outbox.publish(
        tx,
        clinicalEvent('allergy.recorded', id, {
          allergyId: id,
          patientId,
          substanceType: EVENT_SUBSTANCE_TYPE[body.category] ?? 'other',
          substanceCode: body.substanceCode ?? null,
          substanceText: body.substanceText,
          severity: body.severity,
          status: 'active',
          recordedBy: actor,
          recordedAt: new Date().toISOString(),
        }),
      );
    });

    const rows = await this.db.withTenant(currentTenantContext(), async (tx) =>
      this.loadAllergies(tx, patientId),
    );
    const created = rows.find((row) => row.id === id);
    if (created === undefined) throw AppError.notFound('The allergy');
    return created;
  }

  private async loadAllergies(tx: TransactionClient, patientId: string): Promise<readonly AllergyItem[]> {
    const rows = await tx.rows<AllergyItem & { severity: string }>(
      `SELECT id, category::text AS category, substance_text, substance_code, reaction,
              criticality::text AS criticality, severity::text AS severity, status::text AS status,
              verification, recorded_by, recorded_at
         FROM patient.allergies
        WHERE patient_id = $1
        ORDER BY status, recorded_at DESC`,
      [patientId],
    );

    // The stored column is the generic alert severity; the clinical vocabulary
    // is what a prescriber reads and what the event carries, so it is what
    // leaves the API.
    return rows.map((row) => ({ ...row, severity: COLUMN_TO_SEVERITY[row.severity] ?? row.severity }));
  }

  private async assertPatient(
    tx: TransactionClient,
    patientId: string,
  ): Promise<{ readonly id: string; readonly uhid: string }> {
    const row = await tx.maybeOne<{ id: string; uhid: string }>(
      `SELECT id, uhid FROM patient.patients WHERE id = $1 AND deleted_at IS NULL`,
      [patientId],
    );
    if (row === undefined) throw AppError.notFound('The patient');
    return row;
  }
}

/**
 * The timeline's sources, in one list so the request filter, the query builder
 * and the plan test cannot disagree about what a timeline contains.
 */
export const TIMELINE_KINDS = [
  'visit',
  'encounter',
  'diagnosis',
  'vitals',
  'document',
  'problem',
  'allergy',
] as const;

export type TimelineKind = (typeof TIMELINE_KINDS)[number];

export interface TimelineQueryInput {
  readonly patientId: string;
  readonly kinds: readonly string[];
  /** ISO instant; the lower bound of the window and the partition-pruning key. */
  readonly from: string;
  readonly to: string | null;
  readonly cursor: { readonly at: string; readonly id: string } | null;
  /** Already `pageSize + 1`: the extra row is how `hasMore` is known. */
  readonly limit: number;
}

/**
 * Builds the timeline query.
 *
 * Exported, and pure, because the *plan* is the deliverable here — phase-02
 * exit gate 6 is a latency budget, not a feature — and a plan can only be
 * asserted on by a test that runs the very same SQL the service runs.
 * `timeline.plan.integration.spec.ts` does exactly that against five years of
 * synthetic history.
 *
 * Shape, and why: one bounded, individually-ordered branch per source, merged
 * by an outer `ORDER BY … LIMIT`. Each branch is a descending index scan on its
 * own `(hospital_id, patient_id, <time> DESC)` index with the same window, the
 * same keyset predicate and the same limit, so no branch can read more rows
 * than the page needs. The alternative — one query with `OR`ed sources or a
 * join — has no index it can use for the sort and degrades linearly with the
 * length of the record, which is the one thing a timeline must not do.
 */
export function buildTimelineQuery(input: TimelineQueryInput): {
  readonly sql: string | null;
  readonly values: readonly unknown[];
} {
  const values: unknown[] = [input.patientId];
  const bind = (value: unknown): string => `$${values.push(value)}`;

  const from = bind(input.from);
  const to = input.to === null ? null : bind(input.to);
  const cursorAt = input.cursor === null ? null : bind(input.cursor.at);
  const cursorId = input.cursor === null ? null : bind(input.cursor.id);
  const limit = bind(input.limit);

  /** The window, the keyset and the per-branch limit, identical on every branch. */
  const bounds = (time: string, id: string): string =>
    [
      `${time} >= ${from}::timestamptz`,
      to === null ? null : `${time} <= ${to}::timestamptz`,
      cursorAt === null ? null : `(${time}, ${id}) < (${cursorAt}::timestamptz, ${cursorId}::uuid)`,
    ]
      .filter((clause): clause is string => clause !== null)
      .join(' AND ');

  const wanted = new Set(input.kinds);
  const branches: string[] = [];

  if (wanted.has('visit')) {
    branches.push(`(
      SELECT 'visit' AS kind, v.id, v.checked_in_at AS occurred_at,
             v.visit_no AS title,
             jsonb_build_object(
               'visit_type', v.visit_type, 'status', v.status,
               'practitioner_key', v.practitioner_key, 'department_key', v.department_key,
               'token', v.token_display
             ) AS detail
        FROM clinical.op_visits v
       WHERE v.patient_id = $1 AND ${bounds('v.checked_in_at', 'v.id')}
       ORDER BY v.checked_in_at DESC, v.id DESC
       LIMIT ${limit}
    )`);
  }

  if (wanted.has('encounter')) {
    branches.push(`(
      SELECT 'encounter' AS kind, e.id, e.started_at AS occurred_at,
             COALESCE(NULLIF(left(e.chief_complaint_text, 120), ''), 'Consultation') AS title,
             jsonb_build_object(
               'status', e.status, 'type', e.type, 'visit_id', e.visit_id,
               'doctor_user_id', e.doctor_user_id, 'completed_at', e.completed_at,
               'signed_document_id', e.signed_document_id
             ) AS detail
        FROM clinical.encounters e
       WHERE e.patient_id = $1 AND ${bounds('e.started_at', 'e.id')}
       ORDER BY e.started_at DESC, e.id DESC
       LIMIT ${limit}
    )`);
  }

  if (wanted.has('diagnosis')) {
    branches.push(`(
      SELECT 'diagnosis' AS kind, d.id, d.created_at AS occurred_at,
             d.description AS title,
             jsonb_build_object(
               'code', d.code, 'code_system', d.code_system_key, 'rank', d.rank,
               'certainty', d.certainty, 'encounter_id', d.encounter_id,
               'is_notifiable', d.is_notifiable
             ) AS detail
        FROM clinical.encounter_diagnoses d
       WHERE d.patient_id = $1 AND ${bounds('d.created_at', 'd.id')}
       ORDER BY d.created_at DESC, d.id DESC
       LIMIT ${limit}
    )`);
  }

  if (wanted.has('vitals')) {
    branches.push(`(
      SELECT 'vitals' AS kind, w.id, w.recorded_at AS occurred_at,
             w.overall_flag::text AS title,
             jsonb_build_object(
               'systolic', w.systolic, 'diastolic', w.diastolic, 'pulse', w.pulse,
               'spo2', w.spo2, 'temperature_c', w.temperature_c, 'resp_rate', w.resp_rate,
               'weight_kg', w.weight_kg, 'bmi', w.bmi,
               'news2_score', w.news2_score, 'news2_band', w.news2_band,
               'flags', w.flags, 'context', w.context
             ) AS detail
        FROM clinical.vitals w
       WHERE w.patient_id = $1 AND ${bounds('w.recorded_at', 'w.id')}
       ORDER BY w.recorded_at DESC, w.id DESC
       LIMIT ${limit}
    )`);
  }

  if (wanted.has('document')) {
    branches.push(`(
      SELECT 'document' AS kind, doc.id, doc.created_at AS occurred_at,
             doc.title AS title,
             jsonb_build_object(
               'type', doc.type, 'current_version', doc.current_version,
               'current_status', doc.current_status, 'encounter_id', doc.encounter_id
             ) AS detail
        FROM clinical.documents doc
       WHERE doc.patient_id = $1 AND ${bounds('doc.created_at', 'doc.id')}
       ORDER BY doc.created_at DESC, doc.id DESC
       LIMIT ${limit}
    )`);
  }

  if (wanted.has('problem')) {
    branches.push(`(
      SELECT 'problem' AS kind, pr.id, pr.created_at AS occurred_at,
             pr.description AS title,
             jsonb_build_object('code', pr.code, 'status', pr.status, 'is_chronic', pr.is_chronic) AS detail
        FROM clinical.problems pr
       WHERE pr.patient_id = $1 AND ${bounds('pr.created_at', 'pr.id')}
       ORDER BY pr.created_at DESC, pr.id DESC
       LIMIT ${limit}
    )`);
  }

  if (wanted.has('allergy')) {
    branches.push(`(
      SELECT 'allergy' AS kind, al.id, al.recorded_at AS occurred_at,
             al.substance_text AS title,
             jsonb_build_object(
               'category', al.category, 'severity', al.severity, 'criticality', al.criticality,
               'status', al.status, 'reaction', al.reaction
             ) AS detail
        FROM patient.allergies al
       WHERE al.patient_id = $1 AND ${bounds('al.recorded_at', 'al.id')}
       ORDER BY al.recorded_at DESC, al.id DESC
       LIMIT ${limit}
    )`);
  }

  if (branches.length === 0) return { sql: null, values: [] };

  return {
    sql: `SELECT kind, id, occurred_at, title, detail, occurred_at::text AS cursor_key
            FROM (${branches.join(' UNION ALL ')}) AS timeline
           ORDER BY occurred_at DESC, id DESC
           LIMIT ${limit}`,
    values,
  };
}
