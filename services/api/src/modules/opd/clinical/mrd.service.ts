import { Inject, Injectable } from '@nestjs/common';
import { newId } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import type { TransactionClient } from '../../../core/db/database.service.js';
import { NumberingService } from '../../../core/numbering/numbering.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { clinicalEvent } from './clinical.events.js';

/**
 * NC-003, the Phase-2 foundation (phase-02 §2.7).
 *
 * > "Every encounter creates a medical record entry; … deficiency checks
 * > (missing diagnosis, unsigned notes)."
 *
 * Three decisions worth stating.
 *
 * **One record per encounter, not per visit.** `mrd_records` is unique on
 * `(encounter_kind, encounter_ref)`, and a single OP visit can carry a
 * cross-consult second encounter — so keying the record on the visit would make
 * the second consultation of the day a constraint violation. `encounter_ref` is
 * therefore the encounter id, and `encounter_id` carries it too so the join is
 * declared rather than inferred.
 *
 * **What counts as complete is configuration, not code.** The checks come from
 * `clinical.mrd_deficiency_rules`, which a hospital edits to add "pain score
 * recorded" for a NABH audit without a release. This service is an interpreter
 * for the four check types the seeded rules use; a rule with a check type it
 * does not implement is **skipped and reported**, never silently passed — a
 * deficiency check that quietly returns "compliant" is worse than none.
 *
 * **The record is not closed here.** A consultation ending does not make a
 * record complete: coding has not happened yet, so `CODED` is legitimately
 * outstanding. The record moves to `deficient` or `pending_completion`, and
 * closure stays with MRD, where NC-003 puts it.
 */
/**
 * `clinical.MrdEncounterKind` → the `mrd.record.opened` event's narrower enum.
 *
 * The table has `op`, `mlc_op`, `dialysis` and `chemo`; the registry has `opd`,
 * `day_care` and `health_checkup`. Neither is a superset of the other, so the
 * arms that do not correspond map to `other` rather than being guessed at, and
 * the record itself keeps its exact kind. Reported as a contract gap.
 */
const EVENT_ENCOUNTER_KIND: Readonly<Record<string, string>> = {
  op: 'opd',
  mlc_op: 'opd',
  ip: 'ip',
  er: 'er',
  daycare: 'day_care',
  dialysis: 'day_care',
  chemo: 'day_care',
  other: 'other',
};

@Injectable()
export class MrdService {
  constructor(
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(NumberingService) private readonly numbering: NumberingService,
  ) {}

  /**
   * Opens the medical record for a new encounter.
   *
   * The `MRD` numbering series is optional on purpose: a hospital that files by
   * UHID has no MRD number, and allocating a fake one would put an identifier
   * into the register that nothing else in the system can resolve.
   */
  async openRecord(
    tx: TransactionClient,
    input: {
      readonly branchId: string;
      readonly patientId: string;
      readonly encounterId: string;
      readonly encounterKind: string;
      readonly uhid: string;
    },
  ): Promise<string> {
    const ctx = getContext();
    const recordId = newId();
    const mrdNo = await this.allocateMrdNumber(tx, input.branchId, recordId);

    await tx.query(
      `INSERT INTO clinical.mrd_records (
         id, hospital_id, branch_id, patient_id, mrd_no,
         encounter_kind, encounter_ref, encounter_id,
         created_by, updated_by, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6::clinical."MrdEncounterKind", $7, $7, $8, $8, now())`,
      [
        recordId,
        ctx.hospitalId,
        input.branchId,
        input.patientId,
        mrdNo,
        input.encounterKind,
        input.encounterId,
        ctx.userId,
      ],
    );

    await this.audit.write(tx, {
      action: 'insert',
      entity: 'clinical.mrd_records',
      rowId: recordId,
      businessKey: mrdNo ?? input.uhid,
      dataClass: 'phi',
      patientId: input.patientId,
      encounterId: input.encounterId,
      before: null,
      after: { encounter_kind: input.encounterKind, mrd_no: mrdNo },
    });

    await this.outbox.publish(
      tx,
      clinicalEvent('mrd.record.opened', recordId, {
        recordId,
        mrdNo,
        patientId: input.patientId,
        encounterKind: EVENT_ENCOUNTER_KIND[input.encounterKind] ?? 'other',
        encounterRef: input.encounterId,
        openedAt: new Date().toISOString(),
      }),
    );

    return recordId;
  }

  /**
   * Files a signed document version into the record's index.
   *
   * The **version** is pinned, not the document: a record assembled from
   * "whatever the current version is" would silently change after an amendment,
   * and the whole point of the index is that it says what the record contained
   * when it was assembled.
   */
  async fileDocument(
    tx: TransactionClient,
    input: {
      readonly recordId: string;
      readonly documentId: string;
      readonly documentVersion: number;
      readonly section: string;
      readonly source?: string;
      readonly lateEntryReason?: string | null;
    },
  ): Promise<void> {
    const ctx = getContext();

    await tx.query(
      `INSERT INTO clinical.mrd_record_documents (
         id, hospital_id, record_id, section, document_id, document_version,
         source, late_entry_reason, added_by
       ) VALUES ($1, $2, $3, $4::clinical."MrdSection", $5, $6, $7::clinical."MrdDocumentSource", $8, $9)
       ON CONFLICT (record_id, document_id, document_version) DO NOTHING`,
      [
        newId(),
        ctx.hospitalId,
        input.recordId,
        input.section,
        input.documentId,
        input.documentVersion,
        input.source ?? 'auto',
        input.lateEntryReason ?? null,
        ctx.userId,
      ],
    );
  }

  /**
   * Runs the configured deficiency checks and raises what is outstanding.
   *
   * Idempotent by construction: `mrd_deficiencies` is unique on
   * `(record_id, rule_id)`, so re-running after an amendment adds only what is
   * newly outstanding and events fire only for genuinely new rows.
   */
  async evaluateDeficiencies(
    tx: TransactionClient,
    input: {
      readonly recordId: string;
      readonly branchId: string;
      readonly patientId: string;
      readonly encounterId: string;
      readonly visitId: string | null;
      readonly encounterKind: string;
    },
  ): Promise<DeficiencySummary> {
    const ctx = getContext();
    const rules = await tx.rows<RuleRow>(
      `SELECT id, code, description, check_type::text AS check_type, params,
              responsible_role, due_hours
         FROM clinical.mrd_deficiency_rules
        WHERE encounter_kind = $1::clinical."MrdEncounterKind" AND active`,
      [input.encounterKind],
    );

    const facts = await this.gatherFacts(tx, input);
    const raised: string[] = [];
    const skipped: string[] = [];
    let evaluated = 0;

    for (const rule of rules) {
      const verdict = this.evaluate(rule, facts);
      if (verdict === 'skipped') {
        skipped.push(rule.code);
        continue;
      }
      evaluated += 1;
      if (verdict === 'satisfied') continue;

      const deficiencyId = newId();
      const inserted = await tx.rows<{ id: string; due_at: Date }>(
        `INSERT INTO clinical.mrd_deficiencies (
           id, hospital_id, branch_id, record_id, rule_id, responsible_user_id, responsible_role,
           detail, due_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + ($9 || ' hours')::interval, now())
         ON CONFLICT (record_id, rule_id) DO NOTHING
         RETURNING id, due_at`,
        [
          deficiencyId,
          ctx.hospitalId,
          input.branchId,
          input.recordId,
          rule.id,
          ctx.userId,
          rule.responsible_role,
          rule.description,
          String(rule.due_hours),
        ],
      );

      const row = inserted[0];
      if (row === undefined) continue;
      raised.push(rule.code);

      await this.outbox.publish(
        tx,
        clinicalEvent('mrd.deficiency.raised', row.id, {
          deficiencyId: row.id,
          recordId: input.recordId,
          patientId: input.patientId,
          ruleId: rule.id,
          responsibleUserId: ctx.userId,
          responsibleRole: rule.responsible_role,
          detail: rule.description,
          dueAt: row.due_at.toISOString(),
          raisedAt: new Date().toISOString(),
        }),
      );
    }

    const openCount = await this.openDeficiencyCount(tx, input.recordId);
    const completeness =
      evaluated === 0 ? 100 : Math.round(((evaluated - openCount) / evaluated) * 10000) / 100;

    await tx.query(
      `UPDATE clinical.mrd_records
          SET status = $2::clinical."MrdRecordStatus", completeness_pct = $3,
              updated_at = now(), updated_by = $4, version = version + 1
        WHERE id = $1`,
      [input.recordId, openCount > 0 ? 'deficient' : 'pending_completion', completeness, ctx.userId],
    );

    await this.audit.write(tx, {
      action: 'update',
      entity: 'clinical.mrd_records',
      rowId: input.recordId,
      businessKey: null,
      dataClass: 'phi',
      patientId: input.patientId,
      encounterId: input.encounterId,
      before: null,
      after: {
        completeness_pct: completeness,
        open_deficiencies: openCount,
        raised,
        // A rule whose check type this interpreter does not implement is named
        // rather than counted as compliant.
        skipped_rules: skipped,
      },
    });

    return { evaluated, raised, skipped, openCount, completeness };
  }

  private async allocateMrdNumber(
    tx: TransactionClient,
    branchId: string,
    recordId: string,
  ): Promise<string | null> {
    const series = await tx.maybeOne<{ id: string }>(
      `SELECT id FROM core.numbering_series WHERE key = 'MRD' AND active LIMIT 1`,
    );
    if (series === undefined) return null;

    const allocation = await this.numbering.allocate(tx, {
      key: 'MRD',
      branchId,
      refType: 'clinical.mrd_records',
      refId: recordId,
    });
    return allocation.formatted;
  }

  private async openDeficiencyCount(tx: TransactionClient, recordId: string): Promise<number> {
    const row = await tx.one<{ count: string }>(
      `SELECT count(*)::text AS count FROM clinical.mrd_deficiencies
        WHERE record_id = $1 AND status IN ('open', 'escalated')`,
      [recordId],
    );
    return Number(row.count);
  }

  /** Everything the four implemented check types need, in one round trip each. */
  private async gatherFacts(
    tx: TransactionClient,
    input: {
      readonly recordId: string;
      readonly encounterId: string;
      readonly visitId: string | null;
    },
  ): Promise<RecordFacts> {
    const row = await tx.one<{
      has_diagnosis: boolean;
      has_no_diagnosis_reason: boolean;
      has_vitals: boolean;
      has_vitals_not_done_reason: boolean;
      coding_status: string;
      has_ml_source_ref: boolean;
    }>(
      `SELECT
         EXISTS (SELECT 1 FROM clinical.encounter_diagnoses d WHERE d.encounter_id = $1) AS has_diagnosis,
         EXISTS (
           SELECT 1 FROM clinical.encounters e
            WHERE e.id = $1 AND e.no_diagnosis_reason IS NOT NULL
         ) AS has_no_diagnosis_reason,
         EXISTS (
           SELECT 1 FROM clinical.vitals v
            WHERE v.encounter_id = $1 OR ($2::uuid IS NOT NULL AND v.visit_id = $2::uuid)
         ) AS has_vitals,
         EXISTS (
           SELECT 1 FROM clinical.nursing_pre_consult_assessments a
            WHERE ($2::uuid IS NOT NULL AND a.visit_id = $2::uuid) AND a.not_done_reason IS NOT NULL
         ) AS has_vitals_not_done_reason,
         (SELECT r.coding_status::text FROM clinical.mrd_records r WHERE r.id = $3) AS coding_status,
         EXISTS (
           SELECT 1 FROM clinical.mrd_records r WHERE r.id = $3 AND r.ml_source_ref IS NOT NULL
         ) AS has_ml_source_ref`,
      [input.encounterId, input.visitId, input.recordId],
    );

    const unsigned = await tx.rows<{ type: string }>(
      `SELECT type::text AS type
         FROM clinical.documents
        WHERE encounter_id = $1 AND current_status NOT IN ('final', 'amended')`,
      [input.encounterId],
    );

    return {
      hasDiagnosis: row.has_diagnosis,
      hasNoDiagnosisReason: row.has_no_diagnosis_reason,
      hasVitals: row.has_vitals,
      hasVitalsNotDoneReason: row.has_vitals_not_done_reason,
      codingStatus: row.coding_status,
      hasMlSourceRef: row.has_ml_source_ref,
      unsignedDocumentTypes: new Set(unsigned.map((d) => d.type)),
    };
  }

  private evaluate(rule: RuleRow, facts: RecordFacts): 'satisfied' | 'deficient' | 'skipped' {
    const params = rule.params;

    switch (rule.check_type) {
      case 'field_present': {
        const table = typeof params['table'] === 'string' ? params['table'] : null;
        const field = typeof params['field'] === 'string' ? params['field'] : null;

        if (table === 'clinical.encounter_diagnoses') {
          return facts.hasDiagnosis || facts.hasNoDiagnosisReason ? 'satisfied' : 'deficient';
        }
        if (table === 'clinical.vitals') {
          return facts.hasVitals || facts.hasVitalsNotDoneReason ? 'satisfied' : 'deficient';
        }
        if (field === 'ml_source_ref') {
          return facts.hasMlSourceRef ? 'satisfied' : 'deficient';
        }
        return 'skipped';
      }

      case 'document_signed': {
        const documentType = typeof params['documentType'] === 'string' ? params['documentType'] : null;
        if (documentType === null) return 'skipped';
        // Vacuously satisfied when no document of that type exists: an OPD
        // consultation with no prescription is complete, not deficient. The
        // consultation note itself is created and signed by the completion
        // path, so "no note" is not a state this check has to invent.
        return facts.unsignedDocumentTypes.has(documentType) ? 'deficient' : 'satisfied';
      }

      case 'coded':
        return facts.codingStatus === 'coded' ||
          facts.codingStatus === 'qa_passed' ||
          facts.codingStatus === 'not_required'
          ? 'satisfied'
          : 'deficient';

      // `within_hours_of` is a discharge-summary timeliness check; no seeded OP
      // rule uses it and inventing an interpretation would make a check that
      // reports compliance it never measured.
      default:
        return 'skipped';
    }
  }
}

interface RuleRow {
  readonly id: string;
  readonly code: string;
  readonly description: string;
  readonly check_type: string;
  readonly params: Record<string, unknown>;
  readonly responsible_role: string | null;
  readonly due_hours: number;
}

interface RecordFacts {
  readonly hasDiagnosis: boolean;
  readonly hasNoDiagnosisReason: boolean;
  readonly hasVitals: boolean;
  readonly hasVitalsNotDoneReason: boolean;
  readonly codingStatus: string;
  readonly hasMlSourceRef: boolean;
  readonly unsignedDocumentTypes: ReadonlySet<string>;
}

export interface DeficiencySummary {
  readonly evaluated: number;
  readonly raised: readonly string[];
  readonly skipped: readonly string[];
  readonly openCount: number;
  readonly completeness: number;
}
