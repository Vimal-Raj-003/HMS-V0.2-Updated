import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ProblemType, newId } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import type { TransactionClient } from '../../../core/db/database.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { PolicyService } from '../../../core/policy/policy.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import {
  FLOOR_KEYS,
  NEVER_DEGRADING_FAMILIES,
  evaluate,
  hardStops,
  type CandidateLine,
  type CdssAlert,
  type CdssFamily,
  type CdssInterruption,
  type CdssTuning,
  type CrossMapEntry,
  type DoseBand,
  type DrugFacts,
  type InteractionFact,
  type LocalKnowledge,
  type PatientFacts,
  type VendorKnowledge,
} from './cdss.engine.js';
import { prescribingEvent } from './prescribing.events.js';
import type { OverrideRequest, PrescriptionLineRequest } from './prescribing.schemas.js';

/**
 * EN-029 — the engine's boundary with the database.
 *
 * `cdss.engine.ts` decides *what fires*; this file decides *what may be trusted*
 * and *what is written down*. Three decisions in it carry the whole of D-9, and
 * each one is the opposite of the obvious implementation:
 *
 * **1. There is no `catch` around the safety floor.** The floor's inputs — the
 * patient's allergy list, the shipped cross-sensitivity map, the encounter's
 * dosing weight, the drug master — are read before anything else, outside every
 * `try`. If one of those reads fails, the request fails: `docs/04` §7's "never
 * swallow an exception in a clinical path" and D-9's "if the allergy list itself
 * cannot be read, signing is blocked instead". A prescription is never allowed
 * through because a query threw.
 *
 * **2. The knowledge base has two halves, and only one of them may degrade.**
 * The `local_formulary` release is content the product ships: it carries the
 * contraindicated interaction pairs and the absolute dose ceilings, so those
 * checks survive a licence lapsing. A *vendor* release adds severity grading,
 * management text and the wider pair set. When a vendor release is configured
 * but unusable, that — and only that — is recorded as `cdss_degraded` with the
 * families named. When the **local** half cannot be read, prescribing stops.
 * `NEVER_DEGRADING_FAMILIES` mirrors the database CHECK that enforces the same
 * thing, so the two cannot drift.
 *
 * **3. The evidence is committed before the refusal is raised.** An alert is
 * append-only medico-legal evidence (EN-029 §5); "the system blocked this order"
 * is a fact that must survive the 422 that reports it. So evaluation runs in its
 * own transaction, commits its `cdss_alert_events` rows and their outbox events,
 * and only then does the caller throw. The alternative — one transaction for the
 * evaluation and the refusal — rolls the evidence back with the refusal, which
 * is how a hard stop becomes something nobody can prove ever happened.
 */

// ─────────────────────────────────────────────────────────────────────────────

/** The published tenant rule an alert in a tunable family belongs to. */
interface RuleRef {
  readonly ruleId: string;
  readonly ruleVersionId: string;
}

export interface FloorEntry {
  readonly key: string;
  readonly family: string;
  readonly countersignRole: string | null;
}

/** A request line with its master data resolved: what the engine actually reads. */
export interface ResolvedLine {
  readonly request: PrescriptionLineRequest;
  readonly candidate: CandidateLine;
  /** Pre-minted so an alert can name the row it will belong to. */
  readonly prescriptionItemId: string;
  readonly drugKey: string | null;
  readonly brandKey: string | null;
  readonly brandName: string | null;
  readonly strengthText: string | null;
  readonly form: string | null;
  readonly weightUsedKg: number | null;
  readonly bsaUsedM2: number | null;
  readonly computedDoseQty: number | null;
  readonly timesPerDay: number | null;
  readonly durationDays: number | null;
}

export interface StoredAlert extends CdssAlert {
  readonly alertEventId: string;
  /** ISO-8601 with millisecond precision. Round-tripped as text, per D-31. */
  readonly firedAt: string;
  /** True when a countersigned clearance already exists for this exact hard stop. */
  readonly cleared: boolean;
}

export interface EvaluationOutcome {
  readonly alerts: readonly StoredAlert[];
  /** Hard stops with no countersigned clearance: the action must not proceed. */
  readonly blocking: readonly StoredAlert[];
  /** Soft stops for which the request carried no coded reason. */
  readonly unresolved: readonly StoredAlert[];
  readonly degraded: boolean;
  readonly degradedFamilies: readonly string[];
  readonly snapshotDigest: string;
  /** Server-side evaluation latency: context load + rules, in milliseconds. */
  readonly latencyMs: number;
  /** The rules-only portion, which is the figure `docs/07 §2.1` budgets. */
  readonly ruleLatencyMs: number;
}

export interface EvaluationRequest {
  /**
   * The evaluation context, loaded by the caller.
   *
   * Passed in rather than re-read here so that the facts the lines were resolved
   * against and the facts the rules run against are the *same* facts. When this
   * method loaded its own copy, a caller that had deliberately narrowed the
   * context — an amendment excluding the prescription it supersedes from the
   * patient's medication list — silently got the unnarrowed one back, and every
   * amendment duplicated its own previous revision.
   */
  readonly patient: PatientFacts;
  readonly patientId: string;
  readonly encounterId: string | null;
  readonly branchId: string | null;
  readonly lines: readonly ResolvedLine[];
  readonly trigger: 'order_entry' | 'verify' | 'manual' | 'sync_revalidation';
  /** When false, the alerts are recorded but no `prescription_item_id` is stamped. */
  readonly persisted: boolean;
}

interface DrugRow {
  readonly record_key: string;
  readonly generic_name: string;
  readonly molecules: string[] | null;
  readonly atc_code: string | null;
  readonly route: string | null;
  readonly form: string | null;
  readonly strength_text: string | null;
  readonly schedule: string;
  readonly pregnancy_category: string;
  readonly is_weight_based: boolean;
  readonly beers_listed: boolean;
}

const CONTROLLED_SCHEDULES = new Set(['x', 'ndps_narcotic', 'ndps_psychotropic']);

@Injectable()
export class CdssService {
  private readonly logger = new Logger(CdssService.name);

  constructor(
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(PolicyService) private readonly policy: PolicyService,
  ) {}

  // ── the floor ─────────────────────────────────────────────────────────────

  /**
   * Reads `clinical.cdss_safety_floor`.
   *
   * A missing row is treated as a broken installation, not as "one fewer rule":
   * the table is code-owned, seeded by the migration, and `hms_app` holds no
   * INSERT/UPDATE/DELETE on it, so the only ways to see fewer than six entries
   * are a failed migration or a tampered database — and in both cases the safe
   * answer is to stop prescribing, loudly.
   */
  async loadFloor(tx: TransactionClient): Promise<readonly FloorEntry[]> {
    const rows = await tx.rows<{ key: string; family: string; countersign_role: string | null }>(
      `SELECT key, family::text AS family, countersign_role
         FROM clinical.cdss_safety_floor
        ORDER BY sort_order`,
    );
    const entries = rows.map<FloorEntry>((r) => ({
      key: r.key,
      family: r.family,
      countersignRole: r.countersign_role,
    }));

    const present = new Set(entries.map((e) => e.key));
    const missing = FLOOR_KEYS.filter((key) => !present.has(key));
    if (missing.length > 0) {
      throw new AppError(
        ProblemType.DEPENDENCY_UNAVAILABLE,
        'The product safety floor could not be read in full, so prescribing is blocked.',
        {
          clinicalImpact:
            'Allergy, pregnancy and dose hard stops cannot be guaranteed, so no prescription may be written.',
          nextAction: 'Contact IT immediately: the clinical safety configuration is incomplete.',
        },
      );
    }
    return entries;
  }

  // ── line resolution ───────────────────────────────────────────────────────

  /**
   * Turns request lines into evaluable ones by reading the drug master, the
   * frequency master and the encounter's dosing weight.
   *
   * The weight is read from the encounter, never accepted from the request. A
   * client that could supply the weight the dose was computed from could supply
   * a convenient one, and `prescription_items.weight_used_kg` is the column the
   * paediatric floor and the pharmacist both rely on.
   */
  async resolveLines(
    tx: TransactionClient,
    items: readonly PrescriptionLineRequest[],
    patient: PatientFacts,
    /**
     * The ids of the rows these lines already occupy, when they have some. A
     * re-evaluation at signing must stamp its alerts with the *existing*
     * `prescription_item_id`, or "the alerts on this line" stops joining.
     */
    existingItemIds: readonly (string | undefined)[] = [],
  ): Promise<readonly ResolvedLine[]> {
    const drugKeys = items.map((i) => i.drugKey).filter((k): k is string => k !== undefined);
    const drugs = new Map<string, DrugRow>();
    if (drugKeys.length > 0) {
      const rows = await tx.rows<DrugRow>(
        `SELECT d.record_key, d.generic_name, d.molecules, d.atc_code,
                d.route::text AS route, d.form::text AS form, d.strength_text,
                d.schedule::text AS schedule, d.pregnancy_category::text AS pregnancy_category,
                d.is_weight_based, d.beers_listed
           FROM mdm.mdm_drugs d
          WHERE d.record_key = ANY($1::uuid[])
            AND d.status = 'active'
            AND d.effective_from <= now()
            AND (d.effective_to IS NULL OR d.effective_to > now())`,
        [drugKeys],
      );
      for (const row of rows) drugs.set(row.record_key, row);
    }

    const brandKeys = items.map((i) => i.brandKey).filter((k): k is string => k !== undefined);
    const brands = new Map<string, string>();
    if (brandKeys.length > 0) {
      const rows = await tx.rows<{ record_key: string; brand_name: string }>(
        `SELECT b.record_key, b.brand_name
           FROM mdm.mdm_drug_brands b
          WHERE b.record_key = ANY($1::uuid[])
            AND b.status = 'active'
            AND b.effective_from <= now()
            AND (b.effective_to IS NULL OR b.effective_to > now())`,
        [brandKeys],
      );
      for (const row of rows) brands.set(row.record_key, row.brand_name);
    }

    const freqCodes = items.map((i) => i.frequencyCode).filter((c): c is string => c !== undefined);
    const frequencies = new Map<string, number | null>();
    if (freqCodes.length > 0) {
      const rows = await tx.rows<{ code: string; times_per_day: string | null }>(
        `SELECT code, times_per_day::text AS times_per_day
           FROM mdm.mdm_dose_frequencies
          WHERE code = ANY($1::text[]) AND active`,
        [freqCodes],
      );
      for (const row of rows) {
        frequencies.set(row.code, row.times_per_day === null ? null : Number(row.times_per_day));
      }
    }

    return items.map((item, index) => {
      const drug = item.drugKey === undefined ? undefined : drugs.get(item.drugKey);
      if (item.drugKey !== undefined && drug === undefined) {
        throw AppError.validation([
          {
            path: `items/${index}/drugKey`,
            code: 'drug_not_in_formulary',
            message: 'That drug is not an active entry in the formulary.',
          },
        ]);
      }
      const genericName = drug?.generic_name ?? item.genericName;
      if (genericName === undefined) {
        throw AppError.validation([
          {
            path: `items/${index}/genericName`,
            code: 'generic_required',
            message: 'A prescription line needs a drug from the formulary or a generic name.',
          },
        ]);
      }

      const facts: DrugFacts = {
        drugKey: item.drugKey ?? null,
        genericName,
        brandName: item.brandKey === undefined ? null : (brands.get(item.brandKey) ?? null),
        atcCode: drug?.atc_code ?? null,
        molecules: drug?.molecules ?? [],
        route: drug?.route ?? null,
        schedule: (drug?.schedule ?? 'h') as DrugFacts['schedule'],
        pregnancyCategory: (drug?.pregnancy_category ?? 'unknown') as DrugFacts['pregnancyCategory'],
        isWeightBased: drug?.is_weight_based ?? false,
        beersListed: drug?.beers_listed ?? false,
      };

      const timesPerDay =
        item.frequencyCode === undefined ? null : (frequencies.get(item.frequencyCode) ?? null);
      const durationDays = durationInDays(item.durationValue, item.durationUnit);
      const doseQty = item.doseQty ?? null;
      const weight = patient.weightKg;

      const candidate: CandidateLine = {
        lineNo: index + 1,
        drug: facts,
        doseQty,
        doseUnit: item.doseUnit ?? null,
        doseBasis: item.doseBasis,
        timesPerDay,
        durationDays,
        isPrn: item.isPrn,
      };

      return {
        request: item,
        candidate,
        prescriptionItemId: existingItemIds[index] ?? newId(),
        drugKey: item.drugKey ?? null,
        brandKey: item.brandKey ?? null,
        brandName: facts.brandName,
        strengthText: drug?.strength_text ?? null,
        form: drug?.form ?? null,
        // Stored only for the basis that requires it, so the CHECK and the row agree.
        weightUsedKg: item.doseBasis === 'per_kg' ? weight : null,
        bsaUsedM2: item.doseBasis === 'per_m2' ? patient.bsaM2 : null,
        computedDoseQty:
          doseQty === null
            ? null
            : item.doseBasis === 'per_kg' && weight !== null
              ? Number((doseQty * weight).toFixed(4))
              : item.doseBasis === 'per_m2' && patient.bsaM2 !== null
                ? Number((doseQty * patient.bsaM2).toFixed(4))
                : doseQty,
        timesPerDay,
        durationDays,
      };
    });
  }

  /**
   * `rx.schedule_x.prescribe` for any controlled line.
   *
   * Asserted through the policy engine rather than re-implemented, so the
   * catalogue's own conditions apply — and the catalogue makes this key
   * `requiresReason`, `requiresStepUp`, `requiresSecondPerson` and
   * `sensitiveGrant`. Nothing here softens any of them.
   */
  async assertControlledAuthority(lines: readonly ResolvedLine[]): Promise<void> {
    const controlled = lines.some((line) => CONTROLLED_SCHEDULES.has(line.candidate.drug.schedule));
    if (!controlled) return;
    await this.policy.assert('rx.schedule_x.prescribe');
  }

  // ── the evaluation ────────────────────────────────────────────────────────

  /**
   * Runs the rules and writes the evidence. The caller decides what to do with
   * `blocking` and `unresolved`; this method never decides to let something
   * through.
   */
  async evaluateAndRecord(tx: TransactionClient, request: EvaluationRequest): Promise<EvaluationOutcome> {
    const startedAt = Date.now();
    await this.loadFloor(tx);

    const patient = request.patient;
    // The cross-sensitivity map is patient-local data (D-9), so it is loaded
    // with the patient and is not part of the degradable knowledge base.
    const crossMap = await this.loadCrossMap(tx);

    const local = await this.loadLocalKnowledge(tx, crossMap);
    const vendor = await this.loadVendorKnowledge(tx);
    const { tuning, rules } = await this.loadTuning(tx, request.encounterId);

    const lines = request.lines.map((l) => l.candidate);
    const ruleStart = Date.now();
    const evaluated = evaluate(
      { patient, lines, knowledge: local.knowledge, vendor: vendor.knowledge },
      tuning,
    );
    const ruleLatencyMs = Date.now() - ruleStart;

    // EN-029 §5, first bullet: "No rule fires without an active, effective-dated
    // version." The product floor is the stated exception — it fires from
    // `cdss_safety_floor` whether or not anybody authored a rule, which is the
    // entire point of it — and the database says the same thing with
    // `cdss_alert_events_provenance`: an alert names a rule version or a floor
    // entry, never neither.
    //
    // So a tunable family with no published rule in this tenant is silent. That
    // is the asymmetry the whole module is built around: a hospital chooses how
    // loudly to speak about a major interaction, and cannot choose at all about
    // an anaphylactic allergy.
    const alerts = evaluated.filter((a) => a.floorKey !== null || rules.has(a.family));

    // A knowledge-base failure is only survivable once the floor has spoken.
    // If the local half could not be read and nothing hard-stopped, we do not
    // know whether something should have — so we refuse.
    const blockedByFloor = hardStops(alerts).length > 0;
    if (local.unavailable && !blockedByFloor) {
      this.logger.error(
        { patientId: 'redacted', reason: local.reason },
        'CDSS local knowledge base unreadable — prescribing refused',
      );
      throw new AppError(
        ProblemType.DEPENDENCY_UNAVAILABLE,
        'The medication safety checks could not run, so this prescription cannot be saved.',
        {
          clinicalImpact:
            'Interaction and dose-ceiling checks are unavailable. Prescribing without them is not permitted.',
          nextAction: 'Retry in a moment. If it persists, contact IT — do not work around this.',
        },
      );
    }

    const digest = snapshotDigest(patient, lines, tuning);
    const latencyMs = Date.now() - startedAt;

    const stored = await this.recordAlerts(tx, request, alerts, {
      digest,
      latencyMs: ruleLatencyMs,
      degraded: vendor.degraded,
      rules,
    });

    const blocking = stored.filter((a) => a.interruption === 'hard_stop' && !a.cleared);
    const unresolved = await this.resolveSoftStops(tx, request, stored);

    return {
      alerts: stored,
      blocking,
      unresolved,
      degraded: vendor.degraded,
      degradedFamilies: vendor.degradedFamilies,
      snapshotDigest: digest,
      latencyMs,
      ruleLatencyMs,
    };
  }

  // ── context loading ───────────────────────────────────────────────────────

  /**
   * The evaluation context (EN-029 §3.2 step 2).
   *
   * Every read here is wrapped so that a failure becomes an explicit refusal
   * rather than an anonymous 500 — but it is still a refusal. There is no arm of
   * this method that returns a context with the allergies missing.
   */
  async loadPatientFacts(
    tx: TransactionClient,
    patientId: string,
    encounterId: string | null,
    /**
     * The prescription being re-evaluated, whose own lines must not count as
     * the patient's other medication. Without it, signing or amending a
     * prescription would find every one of its own drugs duplicated against
     * itself — a false alert that teaches prescribers to click through alerts,
     * which is the failure mode EN-029 §3.7 exists to prevent.
     */
    excludePrescriptionId: string | null = null,
  ): Promise<PatientFacts> {
    const patient = await tx.maybeOne<{
      id: string;
      age_years: string | null;
      allergy_statement: string;
      is_pregnant: boolean;
    }>(
      `SELECT p.id,
              extract(epoch FROM age(now(), p.dob)) / 31557600 AS age_years,
              p.allergy_statement::text AS allergy_statement,
              p.is_pregnant
         FROM patient.patients p
        WHERE p.id = $1 AND p.deleted_at IS NULL AND p.merged_into_id IS NULL`,
      [patientId],
    );
    // A cross-tenant patient is indistinguishable from a missing one: RLS filters
    // the row and the API must not confirm another hospital's record (docs/09 §3.1).
    if (patient === undefined) throw AppError.notFound('The patient');

    const allergyRows = await tx.rows<{
      id: string;
      category: string;
      substance_code: string | null;
      substance_text: string;
      criticality: string;
      severity: string;
      reaction: string[] | null;
      reaction_text: string | null;
    }>(
      `SELECT a.id, a.category::text AS category, a.substance_code, a.substance_text,
              a.criticality::text AS criticality, a.severity::text AS severity,
              a.reaction, a.reaction_text
         FROM patient.allergies a
        WHERE a.patient_id = $1
          AND a.status = 'active'
          AND a.verification <> 'refuted'`,
      [patientId],
    );

    const encounter =
      encounterId === null
        ? undefined
        : await tx.maybeOne<{
            dosing_weight_kg: string | null;
            bsa_m2: string | null;
            egfr: string | null;
          }>(
            `SELECT e.dosing_weight_kg::text AS dosing_weight_kg,
                    e.bsa_m2::text AS bsa_m2,
                    e.egfr::text AS egfr
               FROM clinical.encounters e
              WHERE e.id = $1`,
            [encounterId],
          );

    const meds = await tx.rows<{ drug_text: string; atc_code: string | null; source: string }>(
      `SELECT m.drug_text, m.atc_code, m.source::text AS source
         FROM clinical.medications m
        WHERE m.patient_id = $1 AND m.status = 'active'
        UNION ALL
       SELECT i.generic_name AS drug_text, i.atc_code, 'rx' AS source
         FROM clinical.prescription_items i
         JOIN clinical.prescriptions r ON r.id = i.prescription_id
        WHERE r.patient_id = $1
          AND i.status = 'active'
          AND r.status IN ('signed', 'partially_dispensed', 'dispensed')
          AND ($2::uuid IS NULL OR r.id <> $2::uuid)`,
      [patientId, excludePrescriptionId],
    );

    const ctx = getContext();
    const registration = await tx.maybeOne<{ registration_number: string | null }>(
      `SELECT p.registration_number
         FROM mdm.mdm_practitioners p
        WHERE p.user_id = $1
          AND p.status = 'active'
          AND p.effective_from <= now()
          AND (p.effective_to IS NULL OR p.effective_to > now())
        LIMIT 1`,
      [ctx.userId],
    );

    return {
      patientId,
      ageYears: patient.age_years === null ? null : Number(patient.age_years),
      allergyStatement: patient.allergy_statement as PatientFacts['allergyStatement'],
      allergies: allergyRows.map((row) => ({
        allergyId: row.id,
        category: row.category,
        substanceCode: row.substance_code,
        substanceText: row.substance_text,
        criticality: row.criticality as 'low' | 'high' | 'unable_to_assess',
        severity: row.severity as PatientFacts['allergies'][number]['severity'],
        reactions: [...(row.reaction ?? []), ...(row.reaction_text === null ? [] : [row.reaction_text])],
      })),
      activeMedications: meds.map((m) => ({ display: m.drug_text, atcCode: m.atc_code, source: m.source })),
      pregnancyConfirmed: patient.is_pregnant,
      weightKg: numeric(encounter?.dosing_weight_kg),
      bsaM2: numeric(encounter?.bsa_m2),
      egfr: numeric(encounter?.egfr),
      prescriberRegistrationNo: registration?.registration_number ?? null,
    };
  }

  private async loadCrossMap(tx: TransactionClient): Promise<readonly CrossMapEntry[]> {
    const rows = await tx.rows<{
      allergen_class: string;
      member_substance: string;
      member_display: string | null;
      cross_classes: string[] | null;
    }>(
      `SELECT allergen_class, member_substance, member_display, cross_classes
         FROM clinical.cdss_allergy_cross_map
        WHERE active`,
    );
    return rows.map((r) => ({
      allergenClass: r.allergen_class,
      memberSubstance: r.member_substance,
      memberDisplay: r.member_display,
      crossClasses: r.cross_classes ?? [],
    }));
  }

  /**
   * The licence-free core: contraindicated pairs and absolute dose ceilings from
   * an active `local_formulary` release.
   *
   * `unavailable` is returned rather than thrown so the caller can run the floor
   * first and still block afterwards. Nothing downstream treats `unavailable`
   * as permission to proceed.
   */
  private async loadLocalKnowledge(
    tx: TransactionClient,
    crossMap: readonly CrossMapEntry[],
  ): Promise<{
    readonly knowledge: LocalKnowledge;
    readonly unavailable: boolean;
    readonly reason: string | null;
  }> {
    // A failed statement poisons the whole transaction, and this one has alert
    // evidence still to write. The savepoint is what lets a "permission denied"
    // or a dropped table become a degraded evaluation rather than a lost
    // transaction — the recovery D-9 needs in order to still record the block.
    await tx.query('SAVEPOINT cdss_local_kb');
    try {
      const interactions = await tx.rows<InteractionRow>(
        `SELECT i.subject_a_kind, i.subject_a_code, i.subject_a_display,
                i.subject_b_kind, i.subject_b_code, i.subject_b_display,
                i.severity::text AS severity, i.management_md
           FROM clinical.cdss_kb_interactions i
           JOIN clinical.cdss_kb_releases r ON r.id = i.kb_release_id
          WHERE r.provider = 'local_formulary'
            AND r.status = 'active'
            AND (r.expires_at IS NULL OR r.expires_at > now())`,
      );
      const bands = await tx.rows<DoseBandRow>(
        `SELECT d.drug_key, d.drug_key_kind, d.route::text AS route, d.population::text AS population,
                d.basis::text AS basis, d.min_dose::text AS min_dose, d.max_dose::text AS max_dose,
                d.unit, d.max_daily::text AS max_daily, d.absolute_ceiling::text AS absolute_ceiling,
                d.max_course_days
           FROM clinical.cdss_kb_dose_rules d
           JOIN clinical.cdss_kb_releases r ON r.id = d.kb_release_id
          WHERE r.provider = 'local_formulary'
            AND r.status = 'active'
            AND (r.expires_at IS NULL OR r.expires_at > now())`,
      );

      await tx.query('RELEASE SAVEPOINT cdss_local_kb');

      if (interactions.length === 0 && bands.length === 0) {
        return {
          knowledge: { crossMap, interactions: [], doseBands: [] },
          unavailable: true,
          reason: 'no active local_formulary knowledge-base release',
        };
      }

      return {
        knowledge: {
          crossMap,
          interactions: interactions.map(toInteraction),
          doseBands: bands.map(toDoseBand),
        },
        unavailable: false,
        reason: null,
      };
    } catch (error) {
      await tx.query('ROLLBACK TO SAVEPOINT cdss_local_kb');
      // Deliberately not rethrown here: the floor still has to run, and the
      // caller refuses immediately afterwards unless the floor itself blocked.
      this.logger.error({ err: String(error) }, 'CDSS local knowledge base read failed');
      return {
        knowledge: { crossMap, interactions: [], doseBands: [] },
        unavailable: true,
        reason: 'local knowledge base unreadable',
      };
    }
  }

  /**
   * The licensed half. A tenant with no vendor release configured is a supported
   * configuration (EN-029 §3.5, O-1), not a degradation — so `degraded` is true
   * only when a release **is** configured and cannot be used.
   */
  private async loadVendorKnowledge(tx: TransactionClient): Promise<{
    readonly knowledge: VendorKnowledge;
    readonly degraded: boolean;
    readonly degradedFamilies: readonly string[];
  }> {
    const none = { knowledge: { interactions: [] }, degraded: false, degradedFamilies: [] };
    await tx.query('SAVEPOINT cdss_vendor_kb');
    try {
      const configured = await tx.rows<{ usable: boolean }>(
        `SELECT (r.status = 'active' AND (r.expires_at IS NULL OR r.expires_at > now())) AS usable
           FROM clinical.cdss_kb_releases r
          WHERE r.provider <> 'local_formulary'`,
      );
      if (configured.length === 0) {
        await tx.query('RELEASE SAVEPOINT cdss_vendor_kb');
        return none;
      }
      if (!configured.some((r) => r.usable)) {
        await tx.query('RELEASE SAVEPOINT cdss_vendor_kb');
        return { knowledge: { interactions: [] }, degraded: true, degradedFamilies: DEGRADABLE_FAMILIES };
      }

      const rows = await tx.rows<InteractionRow>(
        `SELECT i.subject_a_kind, i.subject_a_code, i.subject_a_display,
                i.subject_b_kind, i.subject_b_code, i.subject_b_display,
                i.severity::text AS severity, i.management_md
           FROM clinical.cdss_kb_interactions i
           JOIN clinical.cdss_kb_releases r ON r.id = i.kb_release_id
          WHERE r.provider <> 'local_formulary'
            AND r.status = 'active'
            AND (r.expires_at IS NULL OR r.expires_at > now())`,
      );
      await tx.query('RELEASE SAVEPOINT cdss_vendor_kb');
      return { knowledge: { interactions: rows.map(toInteraction) }, degraded: false, degradedFamilies: [] };
    } catch (error) {
      await tx.query('ROLLBACK TO SAVEPOINT cdss_vendor_kb');
      this.logger.warn({ err: String(error) }, 'CDSS vendor knowledge base unavailable — degrading');
      return { knowledge: { interactions: [] }, degraded: true, degradedFamilies: DEGRADABLE_FAMILIES };
    }
  }

  /**
   * The tenant's tuning: what its own published rule versions say about the
   * families that are *not* the product floor.
   *
   * The query filters `enforces_floor_key IS NULL` because a rule that declares
   * a floor key is locked to `hard_stop` by trigger anyway; reading it here
   * would be a second, weaker copy of a guarantee the database already holds.
   * Nothing this method returns can reach a floor alert — `applyTuning` throws
   * if one ever does.
   */
  private async loadTuning(
    tx: TransactionClient,
    encounterId: string | null,
  ): Promise<{ readonly tuning: CdssTuning; readonly rules: ReadonlyMap<string, RuleRef> }> {
    const rows = await tx.rows<{
      family: string;
      interruption: string | null;
      status: string;
      rule_id: string;
      rule_version_id: string | null;
    }>(
      `SELECT r.family::text AS family, v.interruption::text AS interruption, r.status::text AS status,
              r.id AS rule_id, v.id AS rule_version_id
         FROM clinical.cdss_rules r
         LEFT JOIN clinical.cdss_rule_versions v
                ON v.rule_id = r.id
               AND v.version = r.current_version
               AND v.effective_from <= now()
               AND (v.effective_to IS NULL OR v.effective_to > now())
        WHERE r.enforces_floor_key IS NULL`,
    );

    const familyInterruption: Partial<Record<CdssFamily, CdssInterruption>> = {};
    const activeFamilies = new Set<string>();
    const inactiveFamilies = new Set<string>();
    const rules = new Map<string, RuleRef>();
    for (const row of rows) {
      if (row.status === 'active' && row.interruption !== null && row.rule_version_id !== null) {
        activeFamilies.add(row.family);
        const family = row.family as CdssFamily;
        const current = familyInterruption[family];
        const next = row.interruption as CdssInterruption;
        familyInterruption[family] = louder(current, next);
        // The loudest published version of the family is the one whose id the
        // alert stores, so "what was this clinician shown" reconstructs exactly.
        if (familyInterruption[family] === next || !rules.has(row.family)) {
          rules.set(row.family, { ruleId: row.rule_id, ruleVersionId: row.rule_version_id });
        }
      } else if (row.status === 'disabled' || row.status === 'shadow' || row.status === 'retired') {
        inactiveFamilies.add(row.family);
      }
    }

    const disabledFamilies = [...inactiveFamilies]
      .filter((family) => !activeFamilies.has(family))
      .map((family) => family as CdssFamily);

    const emergency =
      encounterId === null
        ? undefined
        : await tx.maybeOne<{ id: string }>(
            `SELECT id FROM clinical.cdss_emergency_modes
              WHERE encounter_id = $1 AND expires_at > now() AND reviewed_at IS NULL
              LIMIT 1`,
            [encounterId],
          );

    return {
      tuning: { familyInterruption, disabledFamilies, emergencyModeOpen: emergency !== undefined },
      rules,
    };
  }

  // ── writing the evidence ──────────────────────────────────────────────────

  private async recordAlerts(
    tx: TransactionClient,
    request: EvaluationRequest,
    alerts: readonly CdssAlert[],
    meta: {
      readonly digest: string;
      readonly latencyMs: number;
      readonly degraded: boolean;
      readonly rules: ReadonlyMap<string, RuleRef>;
    },
  ): Promise<readonly StoredAlert[]> {
    const ctx = getContext();
    const stored: StoredAlert[] = [];

    for (const alert of alerts) {
      const line = request.lines.find((l) => l.candidate.lineNo === alert.lineNo);
      const cleared =
        alert.interruption === 'hard_stop' ? await this.hasClearance(tx, request, alert) : false;

      const alertEventId = newId();
      // Millisecond precision, as text: the composite primary key is
      // `(id, fired_at)` and a JavaScript `Date` round trip must be exact (D-31).
      const firedAt = new Date().toISOString();
      const outcome =
        alert.interruption === 'hard_stop'
          ? cleared
            ? 'shown_interrupting'
            : 'hard_stop_blocked'
          : alert.interruption === 'soft_stop'
            ? 'shown_interrupting'
            : 'shown_passive';

      const rule = alert.floorKey === null ? meta.rules.get(alert.family) : undefined;
      await tx.query(
        `INSERT INTO clinical.cdss_alert_events (
           id, hospital_id, branch_id, patient_id, encounter_id,
           rule_id, rule_version_id,
           safety_floor_key, family, severity, interruption, trigger,
           context_ref, prescription_item_id, fired_at,
           displayed, displayed_at, latency_ms, outcome,
           actor_user_id, actor_role, snapshot_digest, degraded, title
         ) VALUES (
           $1, $2, $3, $4, $5,
           $20, $21,
           $6, $7::clinical."CdssFamily", $8::clinical."CdssSeverity",
           $9::clinical."CdssInterruption", $10::clinical."CdssTrigger",
           $11::jsonb, $12, $13::timestamptz,
           true, now(), $14, $15::clinical."CdssAlertOutcome",
           $16, $17, $18, false, $19
         )`,
        [
          alertEventId,
          ctx.hospitalId,
          request.branchId,
          request.patientId,
          request.encounterId,
          alert.floorKey,
          alert.family,
          alert.severity,
          alert.interruption,
          request.trigger,
          JSON.stringify({
            lineNo: alert.lineNo,
            subjectCode: alert.subjectCode,
            drugKey: line?.drugKey ?? null,
            genericName: line?.candidate.drug.genericName ?? null,
            atcCode: line?.candidate.drug.atcCode ?? null,
            suggestedAction: alert.suggestedAction,
            evidence: alert.evidence,
          }),
          request.persisted && alert.interruption !== 'hard_stop' ? (line?.prescriptionItemId ?? null) : null,
          firedAt,
          meta.latencyMs,
          outcome,
          ctx.userId,
          ctx.roleKeys[0] ?? null,
          meta.digest,
          alert.title.slice(0, 300),
          rule?.ruleId ?? null,
          rule?.ruleVersionId ?? null,
        ],
      );

      stored.push({ ...alert, alertEventId, firedAt, cleared });

      if (alert.interruption === 'hard_stop' || alert.interruption === 'soft_stop') {
        await this.outbox.publish(
          tx,
          prescribingEvent('cdss.alert.fired', alertEventId, {
            alertEventId,
            firedAt,
            patientId: request.patientId,
            encounterId: request.encounterId,
            ruleId: rule?.ruleId ?? null,
            ruleVersionId: rule?.ruleVersionId ?? null,
            safetyFloorKey: alert.floorKey,
            family: alert.family,
            severity: alert.severity,
            interruption: alert.interruption,
            trigger: request.trigger,
            prescriptionItemId: null,
            orderItemId: null,
            snapshotDigest: meta.digest,
            latencyMs: meta.latencyMs,
            degraded: false,
          }),
        );
      }

      if (alert.interruption === 'hard_stop' && !cleared) {
        await this.outbox.publish(
          tx,
          prescribingEvent('cdss.hardstop.blocked', alertEventId, {
            alertEventId,
            alertFiredAt: firedAt,
            patientId: request.patientId,
            encounterId: request.encounterId,
            safetyFloorKey: alert.floorKey,
            ruleId: null,
            family: alert.family,
            actorUserId: ctx.userId ?? '',
            at: firedAt,
          }),
        );
        await this.audit.write(tx, {
          action: 'override',
          entity: 'clinical.cdss_alert_events',
          rowId: alertEventId,
          businessKey: alert.floorKey,
          dataClass: 'phi',
          patientId: request.patientId,
          encounterId: request.encounterId,
          before: null,
          after: { family: alert.family, interruption: 'hard_stop', outcome, title: alert.title },
          result: 'denied',
          denialReason: alert.floorKey ?? alert.family,
          reasonText: 'Clinical hard stop: the action was refused.',
        });
      }
    }

    return stored;
  }

  /**
   * Has this exact hard stop already been countersigned for this patient?
   *
   * Matched on the patient, the floor entry and the subject the alert was about
   * (the drug, or the interacting pair), inside a four-hour window and — where
   * there is one — the same encounter. A clearance is therefore specific: it
   * does not carry over to a different drug, a different floor family, tomorrow's
   * visit, or another patient.
   */
  private async hasClearance(
    tx: TransactionClient,
    request: EvaluationRequest,
    alert: CdssAlert,
  ): Promise<boolean> {
    if (alert.floorKey === null) return false;
    const row = await tx.maybeOne<{ id: string }>(
      `SELECT a.id
         FROM clinical.cdss_alert_actions a
         JOIN clinical.cdss_alert_events e
           ON e.id = a.alert_event_id AND e.fired_at = a.alert_fired_at
        WHERE e.patient_id = $1
          AND e.safety_floor_key = $2
          AND e.context_ref->>'subjectCode' = $3
          AND a.kind = 'overridden'
          AND a.countersigned_by IS NOT NULL
          AND e.fired_at > now() - interval '4 hours'
          AND ($4::uuid IS NULL OR e.encounter_id = $4::uuid)
        LIMIT 1`,
      [request.patientId, alert.floorKey, alert.subjectCode, request.encounterId],
    );
    return row !== undefined;
  }

  /**
   * Matches each soft stop against the coded reason the request carried for it,
   * and records the override.
   *
   * Anything unmatched is returned to the caller, which refuses the whole
   * request. A soft stop is not advisory: EN-029 §5 requires a coded reason
   * before the order proceeds, and "the client did not send one" is not a reason.
   */
  private async resolveSoftStops(
    tx: TransactionClient,
    request: EvaluationRequest,
    alerts: readonly StoredAlert[],
  ): Promise<readonly StoredAlert[]> {
    const unresolved: StoredAlert[] = [];
    for (const alert of alerts.filter((a) => a.interruption === 'soft_stop')) {
      const line = request.lines.find((l) => l.candidate.lineNo === alert.lineNo);
      const override = line?.request.overrides.find((o: OverrideRequest) => o.family === alert.family);
      if (override === undefined) {
        unresolved.push(alert);
        continue;
      }
      await this.recordOverride(tx, {
        alertEventId: alert.alertEventId,
        firedAt: alert.firedAt,
        patientId: request.patientId,
        reasonCode: override.reasonCode,
        note: override.note ?? null,
        countersignedBy: null,
        actorUserId: getContext().userId,
      });
    }
    return unresolved;
  }

  /**
   * Writes one `cdss_alert_actions` override row.
   *
   * The reason is resolved against `clinical.cdss_override_reasons` **before**
   * the insert so an unknown code, or a code whose free-text minimum is not met,
   * is a field error the prescriber can fix rather than a constraint violation
   * surfacing as a 500. The database checks it again regardless — the CHECK and
   * the trigger are the guarantee, this is the courtesy.
   */
  async recordOverride(
    tx: TransactionClient,
    input: {
      readonly alertEventId: string;
      readonly firedAt: string;
      readonly patientId: string;
      readonly reasonCode: string;
      readonly note: string | null;
      readonly countersignedBy: string | null;
      readonly actorUserId: string | null;
    },
  ): Promise<string> {
    const ctx = getContext();
    const reason = await tx.maybeOne<{
      id: string;
      code: string;
      label: string;
      requires_free_text: boolean;
      min_free_text_length: number;
    }>(
      `SELECT id, code, label, requires_free_text, min_free_text_length
         FROM clinical.cdss_override_reasons
        WHERE code = $1 AND active
        ORDER BY hospital_id NULLS LAST
        LIMIT 1`,
      [input.reasonCode],
    );
    if (reason === undefined) {
      throw AppError.validation([
        {
          path: 'reasonCode',
          code: 'unknown_override_reason',
          message: `"${input.reasonCode}" is not one of the coded override reasons.`,
        },
      ]);
    }
    const noteLength = (input.note ?? '').trim().length;
    if (reason.requires_free_text && noteLength < reason.min_free_text_length) {
      throw AppError.validation([
        {
          path: 'note',
          code: 'override_note_too_short',
          message: `"${reason.label}" needs at least ${reason.min_free_text_length} characters of explanation.`,
        },
      ]);
    }

    const actionId = newId();
    await tx.query(
      `INSERT INTO clinical.cdss_alert_actions (
         id, hospital_id, alert_event_id, alert_fired_at, kind,
         override_reason_id, override_reason_code, override_note,
         actor_user_id, actor_role, countersigned_by, countersigned_at, time_to_action_ms
       ) VALUES (
         $1, $2, $3, $4::timestamptz, 'overridden',
         $5, $6, $7,
         $8, $9, $10, $11, 0
       )`,
      [
        actionId,
        ctx.hospitalId,
        input.alertEventId,
        input.firedAt,
        reason.id,
        reason.code,
        input.note,
        input.actorUserId ?? ctx.userId,
        ctx.roleKeys[0] ?? null,
        input.countersignedBy,
        input.countersignedBy === null ? null : new Date(),
      ],
    );

    await this.audit.write(tx, {
      action: 'override',
      entity: 'clinical.cdss_alert_actions',
      rowId: actionId,
      businessKey: reason.code,
      dataClass: 'phi',
      patientId: input.patientId,
      before: null,
      after: {
        alert_event_id: input.alertEventId,
        override_reason_code: reason.code,
        countersigned: input.countersignedBy !== null,
      },
      reasonCode: reason.code,
      reasonText: input.note ?? reason.label,
    });

    return actionId;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Row shapes and small conversions
// ─────────────────────────────────────────────────────────────────────────────

interface InteractionRow {
  readonly subject_a_kind: string;
  readonly subject_a_code: string;
  readonly subject_a_display: string | null;
  readonly subject_b_kind: string;
  readonly subject_b_code: string;
  readonly subject_b_display: string | null;
  readonly severity: string;
  readonly management_md: string | null;
}

interface DoseBandRow {
  readonly drug_key: string;
  readonly drug_key_kind: string;
  readonly route: string | null;
  readonly population: string;
  readonly basis: string;
  readonly min_dose: string | null;
  readonly max_dose: string | null;
  readonly unit: string;
  readonly max_daily: string | null;
  readonly absolute_ceiling: string | null;
  readonly max_course_days: number | null;
}

/**
 * The families whose *grading* comes from a licensed release.
 *
 * Deliberately checked against `NEVER_DEGRADING_FAMILIES` at module load: the
 * database CHECK `prescriptions_degraded_excludes_floor` refuses to store an
 * Rx that claims allergy, paediatric-weight, pregnancy or schedule checking
 * degraded, and a list that drifted from it would turn every degraded sign into
 * a constraint violation at the worst possible moment.
 */
const DEGRADABLE_FAMILIES: readonly string[] = Object.freeze(['ddi', 'dose_range', 'drug_disease']);

for (const family of DEGRADABLE_FAMILIES) {
  if (NEVER_DEGRADING_FAMILIES.includes(family as CdssFamily)) {
    throw new Error(
      `CDSS: "${family}" is listed as degradable but D-9 and the database CHECK forbid it from degrading.`,
    );
  }
}

function toInteraction(row: InteractionRow): InteractionFact {
  return {
    subjectAKind: row.subject_a_kind,
    subjectACode: row.subject_a_code,
    subjectADisplay: row.subject_a_display,
    subjectBKind: row.subject_b_kind,
    subjectBCode: row.subject_b_code,
    subjectBDisplay: row.subject_b_display,
    severity: row.severity as InteractionFact['severity'],
    managementMd: row.management_md,
  };
}

function toDoseBand(row: DoseBandRow): DoseBand {
  return {
    drugKey: row.drug_key,
    drugKeyKind: row.drug_key_kind,
    route: row.route,
    population: row.population as DoseBand['population'],
    basis: row.basis as DoseBand['basis'],
    minDose: numeric(row.min_dose),
    maxDose: numeric(row.max_dose),
    unit: row.unit,
    maxDaily: numeric(row.max_daily),
    absoluteCeiling: numeric(row.absolute_ceiling),
    maxCourseDays: row.max_course_days,
  };
}

function numeric(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const LOUDNESS: readonly CdssInterruption[] = ['shadow', 'passive', 'soft_stop', 'hard_stop'];

/** EN-029 §3.8: when two rules disagree, the more interrupting one wins. */
function louder(a: CdssInterruption | undefined, b: CdssInterruption): CdssInterruption {
  if (a === undefined) return b;
  return LOUDNESS.indexOf(b) > LOUDNESS.indexOf(a) ? b : a;
}

function durationInDays(value: number | undefined, unit: string | undefined): number | null {
  if (value === undefined) return null;
  if (unit === 'weeks') return value * 7;
  if (unit === 'months') return value * 30;
  // `continuous` has no end, so there is no course length to check a cap against.
  if (unit === 'continuous') return null;
  return value;
}

/**
 * The reproducibility key (EN-029 §5).
 *
 * A sha256 over the canonical evaluation inputs. `POST /cdss/replay` — and a
 * medico-legal review three years from now — reproduces an alert from this plus
 * the rule version, so the digest must cover everything the engine read and
 * nothing that varies between two identical evaluations (no timestamps, no ids
 * that are minted per request).
 */
export function snapshotDigest(
  patient: PatientFacts,
  lines: readonly CandidateLine[],
  tuning: CdssTuning,
): string {
  const canonical = JSON.stringify({
    patient: {
      ageYears: patient.ageYears,
      allergyStatement: patient.allergyStatement,
      allergies: patient.allergies.map((a) => [a.substanceCode, a.substanceText, a.criticality]).sort(),
      medications: patient.activeMedications.map((m) => [m.atcCode, m.display]).sort(),
      pregnancyConfirmed: patient.pregnancyConfirmed,
      weightKg: patient.weightKg,
      bsaM2: patient.bsaM2,
      egfr: patient.egfr,
    },
    lines: lines.map((l) => [
      l.lineNo,
      l.drug.atcCode,
      l.drug.genericName,
      l.doseQty,
      l.doseBasis,
      l.timesPerDay,
      l.durationDays,
    ]),
    tuning,
  });
  return createHash('sha256').update(canonical).digest('hex');
}
