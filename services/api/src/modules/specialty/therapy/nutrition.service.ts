import { Injectable } from '@nestjs/common';
import { newId } from '@vims/contracts';
import { AppError } from '../../../core/problem/app-error.js';
import {
  ConsoleSupport,
  asJson,
  asNumber,
  asNumberOrNull,
  asStringArray,
  asText,
  asTextOrNull,
} from '../consoles/consoles.support.js';
import type { DietPlanRequest, NutritionAssessmentRequest, PatientQuery } from './therapy.schemas.js';
import type { DietPlanRow, NutritionAssessmentRow } from './therapy.types.js';

/**
 * OP-011 — dietetics and nutrition.
 *
 * ── Nothing here adds up a meal ────────────────────────────────────────────
 *
 * The totals are summed in the database from `food_items.per_100g` and the
 * quantities, and the restriction check happens in the same trigger. What this
 * service adds is `kcalVariancePct`, which is the distance between what the
 * plan *contains* and what it *aimed at* — a number nobody can act on until
 * they can see it, and one a dietician usually discovers when a patient loses
 * weight they were meant to gain.
 *
 * ── Activating a plan supersedes the last one ──────────────────────────────
 *
 * One active plan per patient, by index. The service supersedes before it
 * activates so the transition is atomic: a kitchen reading between two writes
 * would otherwise see a patient with no plan at all.
 */
@Injectable()
export class NutritionService extends ConsoleSupport {
  async recordAssessment(body: NutritionAssessmentRequest): Promise<NutritionAssessmentRow> {
    return this.guard(async (tx) => {
      const id = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.nutrition_assessments
           (id, hospital_id, branch_id, patient_id, episode_id, encounter_id, admission_id,
            dietician_id, anthropometry, bmi, weight_loss_pct_3m, bmr, tdee, requirements,
            recall_24h, intake_totals, malnutrition_class, sga, nrs2002, pes_statement,
            preferences, food_allergies, form_response_id, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14::jsonb,
                 $15::jsonb,$16::jsonb,$17::specialty."MalnutritionClass",$18,$19,$20,
                 $21::jsonb,$22::text[],$23, now(), now())
         RETURNING *`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.patientId,
          body.episodeId ?? null,
          body.encounterId ?? null,
          body.admissionId ?? null,
          this.actorId(),
          JSON.stringify(body.anthropometry),
          body.bmi ?? null,
          body.weightLossPct3m ?? null,
          body.bmr ?? null,
          body.tdee ?? null,
          JSON.stringify(body.requirements),
          JSON.stringify(body.recall24h),
          JSON.stringify(body.intakeTotals),
          body.malnutritionClass,
          body.sga ?? null,
          body.nrs2002 ?? null,
          body.pesStatement ?? null,
          JSON.stringify(body.preferences),
          body.foodAllergies,
          body.formResponseId ?? null,
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The assessment was not recorded.');

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'nutrition_assessment',
        rowId: id,
        businessKey: body.patientId,
        dataClass: 'phi',
        patientId: body.patientId,
        encounterId: body.encounterId ?? null,
        before: null,
        after: { malnutritionClass: body.malnutritionClass, sga: body.sga ?? null },
      });

      return this.toAssessment(row);
    });
  }

  async signAssessment(id: string): Promise<NutritionAssessmentRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE specialty.nutrition_assessments
            SET signed_by = $3, signed_at = now(), updated_at = now()
          WHERE hospital_id = $1 AND id = $2 AND signed_at IS NULL
          RETURNING *`,
        [this.hospitalId(), id, this.actorId()],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict('That assessment does not exist, or it is already signed.');
      }
      return this.toAssessment(row);
    });
  }

  /**
   * Draft a plan.
   *
   * The totals come back computed, so the dietician sees what the meals
   * actually contain before signing rather than after the kitchen queries it.
   */
  async draftPlan(body: DietPlanRequest): Promise<DietPlanRow> {
    return this.guard(async (tx) => {
      const id = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.diet_plans
           (id, hospital_id, branch_id, patient_id, assessment_id, name, meals,
            kcal_target, macro_targets, restrictions, supplements, instructions,
            cost_per_day, valid_from, valid_to, status, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,
                 $14::date,$15::date,'draft',$16, now(), now())
         RETURNING *`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.patientId,
          body.assessmentId,
          body.name,
          JSON.stringify(body.meals),
          body.kcalTarget ?? null,
          JSON.stringify(body.macroTargets),
          JSON.stringify(body.restrictions),
          JSON.stringify(body.supplements),
          body.instructions ?? null,
          body.costPerDay ?? null,
          body.validFrom,
          body.validTo ?? null,
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The plan was not saved.');
      return this.toPlan(row);
    });
  }

  async activatePlan(id: string): Promise<DietPlanRow> {
    return this.guard(async (tx) => {
      const { rows: target } = await tx.query<Record<string, unknown>>(
        `SELECT patient_id FROM specialty.diet_plans WHERE hospital_id = $1 AND id = $2`,
        [this.hospitalId(), id],
      );
      const patient = target[0];
      if (patient === undefined) throw AppError.notFound('That diet plan does not exist.');

      // Supersede first, in the same transaction: a kitchen reading between two
      // writes would otherwise see a patient with no plan at all.
      await tx.query(
        // A plan superseded before it began ends on the day it would have begun.
        // `current_date` alone would put its end before its start, which is a
        // period that never existed and a CHECK that refuses it.
        `UPDATE specialty.diet_plans
            SET status = 'superseded',
                valid_to = coalesce(valid_to, greatest(valid_from, current_date)),
                updated_at = now()
          WHERE hospital_id = $1 AND patient_id = $2 AND status = 'active' AND id <> $3`,
        [this.hospitalId(), asText(patient['patient_id']), id],
      );

      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE specialty.diet_plans
            SET status = 'active', signed_by = $3, signed_at = now(), updated_at = now()
          WHERE hospital_id = $1 AND id = $2 AND status = 'draft'
          RETURNING *`,
        [this.hospitalId(), id, this.actorId()],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict('That plan does not exist, or it is not a draft.');
      }

      await this.audit.write(tx, {
        action: 'sign',
        entity: 'diet_plan',
        rowId: id,
        businessKey: asText(row['patient_id']),
        dataClass: 'phi',
        patientId: asText(row['patient_id']),
        encounterId: null,
        before: null,
        // The totals are the database's; the audit records what was actually
        // prescribed rather than what was aimed at.
        after: { totals: asJson(row['totals']), restrictions: asJson(row['restrictions']) },
      });

      return this.toPlan(row);
    });
  }

  async listPlans(query: PatientQuery): Promise<readonly DietPlanRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM specialty.diet_plans
          WHERE hospital_id = $1 AND ($2::uuid IS NULL OR patient_id = $2::uuid)
          ORDER BY valid_from DESC, created_at DESC LIMIT $3`,
        [this.hospitalId(), query.patientId ?? null, query.limit],
      );
      return rows.map((r) => this.toPlan(r));
    });
  }

  async listAssessments(query: PatientQuery): Promise<readonly NutritionAssessmentRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM specialty.nutrition_assessments
          WHERE hospital_id = $1 AND ($2::uuid IS NULL OR patient_id = $2::uuid)
          ORDER BY created_at DESC LIMIT $3`,
        [this.hospitalId(), query.patientId ?? null, query.limit],
      );
      return rows.map((r) => this.toAssessment(r));
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Shaping
  // ═══════════════════════════════════════════════════════════════════════════

  private toAssessment(row: Record<string, unknown>): NutritionAssessmentRow {
    return {
      id: asText(row['id']),
      patientId: asText(row['patient_id']),
      bmi: asNumberOrNull(row['bmi']),
      bmr: asNumberOrNull(row['bmr']),
      tdee: asNumberOrNull(row['tdee']),
      malnutritionClass: asText(row['malnutrition_class']),
      sga: asTextOrNull(row['sga']),
      nrs2002: asNumberOrNull(row['nrs2002']),
      pesStatement: asTextOrNull(row['pes_statement']),
      foodAllergies: asStringArray(row['food_allergies']),
      signedBy: asTextOrNull(row['signed_by']),
      signedAt: asTextOrNull(row['signed_at']),
      createdAt: asText(row['created_at']),
    };
  }

  private toPlan(row: Record<string, unknown>): DietPlanRow {
    const meals = row['meals'];
    const totals = asJson(row['totals']);
    const target = asNumberOrNull(row['kcal_target']);
    const kcal = totals['kcal'];

    // How far the plan sits from its own target. The dietician's usual way of
    // finding this out is a patient who lost weight they were meant to gain.
    let variance: number | null = null;
    if (target !== null && target > 0 && kcal !== undefined && kcal !== null) {
      variance = Math.round(((asNumber(kcal) - target) / target) * 1000) / 10;
    }

    return {
      id: asText(row['id']),
      patientId: asText(row['patient_id']),
      assessmentId: asText(row['assessment_id']),
      name: asText(row['name']),
      meals: Array.isArray(meals) ? (meals as Record<string, unknown>[]) : [],
      totals,
      kcalTarget: target,
      restrictions: asJson(row['restrictions']),
      costPerDay: asNumberOrNull(row['cost_per_day']),
      validFrom: asText(row['valid_from']),
      validTo: asTextOrNull(row['valid_to']),
      status: asText(row['status']),
      signedBy: asTextOrNull(row['signed_by']),
      signedAt: asTextOrNull(row['signed_at']),
      kcalVariancePct: variance,
    };
  }
}
