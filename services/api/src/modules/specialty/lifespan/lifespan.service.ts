import { Injectable } from '@nestjs/common';
import { newId } from '@vims/contracts';
import type { TransactionClient } from '../../../core/db/database.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { consoleEvent } from '../consoles/consoles.events.js';
import {
  ConsoleSupport,
  asJson,
  asNumber,
  asNumberOrNull,
  asText,
  asTextOrNull,
} from '../consoles/consoles.support.js';
import type {
  GeriAssessmentRequest,
  GeriQuery,
  GrowthQuery,
  GrowthRequest,
  MedicationReviewRequest,
  NicuAdmissionRequest,
  NicuFluidRequest,
  NicuQuery,
  PaedDoseRequest,
} from './lifespan.schemas.js';
import type {
  GeriAssessmentRow,
  GrowthRow,
  MedicationReviewRow,
  NicuAdmissionRow,
  NicuFluidRow,
  PaedDoseRow,
} from './lifespan.types.js';

/** Above this the burden causes the falls it is being taken alongside. */
const ACB_THRESHOLD = 3;
/** Where the word polypharmacy starts. */
const POLYPHARMACY_AT = 5;

/**
 * A standard first-week neonatal fluid schedule, in millilitres per kilogram
 * per day. Shown beside what was actually prescribed rather than enforced —
 * a growth-restricted baby, one on phototherapy and one with a patent ductus
 * all belong off this curve, and a rule would be wrong for each of them.
 */
const EXPECTED_ML_PER_KG: readonly number[] = [60, 80, 100, 120, 140, 150, 150];

/**
 * OP-033, IP-015 and OP-034 — the two ends of life.
 *
 * ── Nothing here multiplies a weight by anything ───────────────────────────
 *
 * The dose after the adult ceiling, the centile, the day of life, the volume,
 * the burden and the bands are all trigger outputs. What this adds is the
 * comparison: grams gained a day, the standard fluid schedule beside the
 * prescribed one, and whether the burden has passed the point where it matters.
 */
@Injectable()
export class LifespanService extends ConsoleSupport {
  // ── Growth ────────────────────────────────────────────────────────────────

  async recordGrowth(body: GrowthRequest): Promise<GrowthRow> {
    return this.guard(async (tx) => {
      const id = newId();
      await tx.query(
        `INSERT INTO specialty.paed_growth_records
           (id, hospital_id, patient_id, measured_at, age_days, sex, weight_g, length_cm, hc_cm,
            recorded_by, created_at, updated_at)
         VALUES ($1,$2,$3,coalesce($4::timestamptz, now()),$5,$6,$7,$8,$9,$10,now(),now())`,
        [
          id,
          this.hospitalId(),
          body.patientId,
          body.measuredAt ?? null,
          body.ageDays,
          body.sex,
          body.weightG ?? null,
          body.lengthCm ?? null,
          body.hcCm ?? null,
          this.actorId(),
        ],
      );
      const row = await this.growthWithin(tx, id);

      // Growth faltering is a nutrition referral and sometimes a safeguarding
      // one, and neither happens from a chart nobody re-reads.
      if (row.nutritionBand === 'underweight' || row.nutritionBand === 'severe_underweight') {
        await this.outbox.publish(
          tx,
          consoleEvent('paed.growth.faltering', id, {
            recordId: id,
            patientId: body.patientId,
            ageDays: body.ageDays,
            weightG: row.weightG ?? 0,
            weightForAgeZ: String(row.weightForAgeZ ?? 0),
            nutritionBand: row.nutritionBand,
          }),
        );
      }

      return row;
    });
  }

  async listGrowth(query: GrowthQuery): Promise<readonly GrowthRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `${GROWTH_SELECT}
          WHERE g.hospital_id = $1
            AND ($2::uuid IS NULL OR g.patient_id = $2::uuid)
            AND ($3::boolean IS NOT TRUE
                 OR g.nutrition_band IN ('underweight', 'severe_underweight'))
          ORDER BY g.measured_at DESC
          LIMIT $4`,
        [this.hospitalId(), query.patientId ?? null, query.falteringOnly, query.limit],
      );
      return rows.map((r) => this.toGrowth(r));
    });
  }

  // ── The dose ──────────────────────────────────────────────────────────────

  async calculateDose(body: PaedDoseRequest): Promise<PaedDoseRow> {
    return this.guard(async (tx) => {
      // The dose fields are absent from the column list. The ceiling is the
      // adult dose and there is no way to send past it.
      const id = newId();
      await tx.query(
        `INSERT INTO specialty.paed_doses
           (id, hospital_id, patient_id, encounter_id, drug_key, drug_name, weight_g, age_days,
            dose_mg_per_kg, frequency, route, adult_max_single_mg, adult_max_daily_mg,
            doses_per_day, prescribed_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now(),now())`,
        [
          id,
          this.hospitalId(),
          body.patientId,
          body.encounterId ?? null,
          body.drugKey,
          body.drugName,
          body.weightG,
          body.ageDays,
          body.doseMgPerKg,
          body.frequency,
          body.route,
          body.adultMaxSingleMg ?? null,
          body.adultMaxDailyMg ?? null,
          body.dosesPerDay,
          this.actorId(),
        ],
      );
      const dose = await this.doseWithin(tx, id);

      // Not an error — the rule working — but it means the child is being dosed
      // as an adult, which the prescriber and the pharmacist both need to know.
      if (dose.capApplied) {
        await this.outbox.publish(
          tx,
          consoleEvent('paed.dose.capped', id, {
            doseId: id,
            patientId: body.patientId,
            drugName: body.drugName,
            weightG: body.weightG,
            calcSingleMg: String(dose.calcSingleMg ?? 0),
            finalSingleMg: String(dose.finalSingleMg ?? 0),
          }),
        );
      }

      return dose;
    });
  }

  // ── The neonatal unit ─────────────────────────────────────────────────────

  async admitNicu(body: NicuAdmissionRequest): Promise<NicuAdmissionRow> {
    return this.guard(async (tx) => {
      const id = newId();
      await tx.query(
        `INSERT INTO specialty.nicu_admissions
           (id, hospital_id, branch_id, patient_id, admission_id, newborn_id, birth_at,
            ga_weeks_at_birth, ga_days_at_birth, birth_weight_g, admitted_at,
            created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,$8,$9,$10,
                 coalesce($11::timestamptz, now()),$12,now(),now())`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.patientId,
          body.admissionId ?? null,
          body.newbornId ?? null,
          body.birthAt,
          body.gaWeeksAtBirth,
          body.gaDaysAtBirth,
          body.birthWeightG,
          body.admittedAt ?? null,
          this.actorId(),
        ],
      );
      return this.nicuWithin(tx, id);
    });
  }

  async listNicu(query: NicuQuery): Promise<readonly NicuAdmissionRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `${NICU_SELECT}
          WHERE a.hospital_id = $1
            AND ($2::boolean IS NOT TRUE OR a.discharged_at IS NULL)
          ORDER BY a.admitted_at DESC
          LIMIT $3`,
        [this.hospitalId(), query.currentOnly, query.limit],
      );
      return rows.map((r) => this.toNicu(r));
    });
  }

  async prescribeFluids(admissionId: string, body: NicuFluidRequest): Promise<NicuFluidRow> {
    return this.guard(async (tx) => {
      // `day_of_life`, `total_ml_per_day`, `iv_ml_per_day` and `ml_per_hour`
      // are absent: the day comes from the birth, and the volume from the
      // weight in grams.
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.nicu_fluid_orders
           (id, hospital_id, nicu_admission_id, for_date, day_of_life, weight_g,
            ml_per_kg_per_day, fluid, additives, enteral_ml, prescribed_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4::date,0,$5,$6,$7,$8::jsonb,$9,$10,now(),now())
         ON CONFLICT (nicu_admission_id, for_date) DO UPDATE
           SET weight_g = excluded.weight_g,
               ml_per_kg_per_day = excluded.ml_per_kg_per_day,
               fluid = excluded.fluid,
               additives = excluded.additives,
               enteral_ml = excluded.enteral_ml,
               updated_at = now()
         RETURNING *`,
        [
          newId(),
          this.hospitalId(),
          admissionId,
          body.forDate,
          body.weightG,
          body.mlPerKgPerDay,
          body.fluid,
          JSON.stringify(body.additives),
          body.enteralMl,
          this.actorId(),
        ],
      );
      return this.toFluid(this.one(rows));
    });
  }

  async listFluids(admissionId: string): Promise<readonly NicuFluidRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM specialty.nicu_fluid_orders WHERE nicu_admission_id = $1
          ORDER BY for_date DESC LIMIT 60`,
        [admissionId],
      );
      return rows.map((r) => this.toFluid(r));
    });
  }

  // ── The other end ─────────────────────────────────────────────────────────

  async recordAssessment(body: GeriAssessmentRequest): Promise<GeriAssessmentRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.geri_assessments
           (id, hospital_id, patient_id, encounter_id, assessed_at, assessed_by, age_years,
            fried_items, falls_last_year, falls_injury, adl_barthel, cognition, mood,
            continence, social, created_at, updated_at)
         VALUES ($1,$2,$3,$4,now(),$5,$6,$7::jsonb,$8,$9,$10,$11::jsonb,$12::jsonb,
                 $13::jsonb,$14::jsonb,now(),now())
         RETURNING *`,
        [
          newId(),
          this.hospitalId(),
          body.patientId,
          body.encounterId ?? null,
          this.actorId(),
          body.ageYears,
          JSON.stringify(body.friedItems),
          body.fallsLastYear,
          body.fallsInjury,
          body.adlBarthel ?? null,
          JSON.stringify(body.cognition),
          JSON.stringify(body.mood),
          JSON.stringify(body.continence),
          JSON.stringify(body.social),
        ],
      );
      return this.toAssessment(this.one(rows));
    });
  }

  async reviewMedications(body: MedicationReviewRequest): Promise<MedicationReviewRow> {
    return this.guard(async (tx) => {
      // The burden and the flags are absent: they are a lookup against
      // published criteria, and a clinician who types them has remembered
      // rather than looked.
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.geri_medication_reviews
           (id, hospital_id, patient_id, assessment_id, reviewed_at, reviewed_by, age_years,
            medications, actions, justifications, created_at, updated_at)
         VALUES ($1,$2,$3,$4,now(),$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,now(),now())
         RETURNING *`,
        [
          newId(),
          this.hospitalId(),
          body.patientId,
          body.assessmentId ?? null,
          this.actorId(),
          body.ageYears,
          JSON.stringify(body.medications),
          JSON.stringify(body.actions),
          JSON.stringify(body.justifications),
        ],
      );
      const review = this.toReview(this.one(rows));

      // Above three the drugs cause the falls and the confusion they are being
      // taken alongside, so it leaves for a pharmacist-led review.
      if (review.burdenHigh) {
        await this.outbox.publish(
          tx,
          consoleEvent('geri.burden.high', review.id, {
            reviewId: review.id,
            patientId: body.patientId,
            ageYears: body.ageYears,
            acbScore: review.acbScore ?? 0,
            drugCount: review.drugCount ?? 0,
            beersCount: review.beersCount ?? 0,
          }),
        );
      }

      return review;
    });
  }

  async listReviews(query: GeriQuery): Promise<readonly MedicationReviewRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM specialty.geri_medication_reviews
          WHERE hospital_id = $1
            AND ($2::uuid IS NULL OR patient_id = $2::uuid)
            AND ($3::boolean IS NOT TRUE OR coalesce(acb_score, 0) >= $4)
          ORDER BY reviewed_at DESC
          LIMIT $5`,
        [this.hospitalId(), query.patientId ?? null, query.highBurdenOnly, ACB_THRESHOLD, query.limit],
      );
      return rows.map((r) => this.toReview(r));
    });
  }

  // ── Shaping ───────────────────────────────────────────────────────────────

  private one(rows: readonly Record<string, unknown>[]): Record<string, unknown> {
    const row = rows[0];
    if (row === undefined) throw AppError.notFound('That record was not found.');
    return row;
  }

  private async growthWithin(tx: TransactionClient, id: string): Promise<GrowthRow> {
    const { rows } = await tx.query<Record<string, unknown>>(`${GROWTH_SELECT} WHERE g.id = $1`, [id]);
    return this.toGrowth(this.one(rows));
  }

  private async doseWithin(tx: TransactionClient, id: string): Promise<PaedDoseRow> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM specialty.paed_doses WHERE id = $1`,
      [id],
    );
    return this.toDose(this.one(rows));
  }

  private async nicuWithin(tx: TransactionClient, id: string): Promise<NicuAdmissionRow> {
    const { rows } = await tx.query<Record<string, unknown>>(`${NICU_SELECT} WHERE a.id = $1`, [id]);
    return this.toNicu(this.one(rows));
  }

  private toGrowth(r: Record<string, unknown>): GrowthRow {
    const weightG = asNumberOrNull(r.weight_g);
    const prevG = asNumberOrNull(r.prev_weight_g);
    const prevDays = asNumberOrNull(r.prev_age_days);
    const ageDays = asNumber(r.age_days);

    // Grams a day. The figure a paediatrician actually uses, and one nobody
    // works out from two rows on a chart.
    const gain =
      weightG === null || prevG === null || prevDays === null || ageDays <= prevDays
        ? null
        : Math.round(((weightG - prevG) / (ageDays - prevDays)) * 10) / 10;

    return {
      id: asText(r.id),
      patientId: asText(r.patient_id),
      measuredAt: asText(r.measured_at),
      ageDays,
      sex: asText(r.sex),
      weightG,
      lengthCm: asNumberOrNull(r.length_cm),
      hcCm: asNumberOrNull(r.hc_cm),
      weightForAgeZ: asNumberOrNull(r.weight_for_age_z),
      weightCentile: asNumberOrNull(r.weight_centile),
      nutritionBand: asTextOrNull(r.nutrition_band),
      gainGPerDay: gain,
    };
  }

  private toDose(r: Record<string, unknown>): PaedDoseRow {
    const weightG = asNumber(r.weight_g);
    const perKg = asNumber(r.dose_mg_per_kg);
    const calc = asNumberOrNull(r.calc_single_mg);
    const capped = asNumberOrNull(r.cap_applied) === 1;
    const kg = Math.round((weightG / 1000) * 100) / 100;

    return {
      id: asText(r.id),
      patientId: asText(r.patient_id),
      drugName: asText(r.drug_name),
      weightG,
      ageDays: asNumber(r.age_days),
      doseMgPerKg: perKg,
      frequency: asText(r.frequency),
      route: asText(r.route),
      dosesPerDay: asNumber(r.doses_per_day),
      calcSingleMg: calc,
      finalSingleMg: asNumberOrNull(r.final_single_mg),
      finalDailyMg: asNumberOrNull(r.final_daily_mg),
      adultMaxSingleMg: asNumberOrNull(r.adult_max_single_mg),
      adultMaxDailyMg: asNumberOrNull(r.adult_max_daily_mg),
      capApplied: capped,
      // Spelled out so it can be checked rather than trusted.
      workingOut: capped
        ? `${String(perKg)} mg/kg × ${String(kg)} kg = ${String(calc ?? 0)} mg, held at the adult dose`
        : `${String(perKg)} mg/kg × ${String(kg)} kg = ${String(calc ?? 0)} mg`,
    };
  }

  private toNicu(r: Record<string, unknown>): NicuAdmissionRow {
    const birthAt = asText(r.birth_at);
    const dayOfLife = Math.floor((Date.now() - new Date(birthAt).getTime()) / 86_400_000) + 1;
    const gaWeeks = asNumber(r.ga_weeks_at_birth);
    return {
      id: asText(r.id),
      patientId: asText(r.patient_id),
      birthAt,
      gaWeeksAtBirth: gaWeeks,
      gaDaysAtBirth: asNumber(r.ga_days_at_birth),
      birthWeightG: asNumber(r.birth_weight_g),
      gestationBand: asTextOrNull(r.gestation_band),
      birthWeightBand: asTextOrNull(r.birth_weight_band),
      admittedAt: asText(r.admitted_at),
      dischargedAt: asTextOrNull(r.discharged_at),
      dayOfLife,
      // Corrected gestation: what a preterm baby's development is measured
      // against for the first two years, and a figure everybody recomputes.
      correctedGaWeeks: gaWeeks + Math.floor((dayOfLife - 1) / 7),
      latestWeightG: asNumberOrNull(r.latest_weight_g),
    };
  }

  private toFluid(r: Record<string, unknown>): NicuFluidRow {
    const day = asNumber(r.day_of_life);
    return {
      id: asText(r.id),
      nicuAdmissionId: asText(r.nicu_admission_id),
      forDate: asText(r.for_date),
      dayOfLife: day,
      weightG: asNumber(r.weight_g),
      mlPerKgPerDay: asNumber(r.ml_per_kg_per_day),
      totalMlPerDay: asNumberOrNull(r.total_ml_per_day),
      enteralMl: asNumber(r.enteral_ml),
      ivMlPerDay: asNumberOrNull(r.iv_ml_per_day),
      mlPerHour: asNumberOrNull(r.ml_per_hour),
      fluid: asText(r.fluid),
      // Shown beside the prescription rather than enforced: a growth-restricted
      // baby, one under lights and one with a patent ductus all belong off this
      // curve, and a rule would be wrong for each of them.
      expectedMlPerKg: EXPECTED_ML_PER_KG[Math.min(day, EXPECTED_ML_PER_KG.length) - 1] ?? 150,
    };
  }

  private toAssessment(r: Record<string, unknown>): GeriAssessmentRow {
    return {
      id: asText(r.id),
      patientId: asText(r.patient_id),
      assessedAt: asText(r.assessed_at),
      ageYears: asNumber(r.age_years),
      friedItems: asJson(r.fried_items),
      friedScore: asNumberOrNull(r.fried_score),
      frailtyBand: asTextOrNull(r.frailty_band),
      fallsLastYear: asNumber(r.falls_last_year),
      fallsInjury: r.falls_injury === true,
      fallsRisk: asTextOrNull(r.falls_risk),
      adlBarthel: asNumberOrNull(r.adl_barthel),
    };
  }

  private toReview(r: Record<string, unknown>): MedicationReviewRow {
    const acb = asNumberOrNull(r.acb_score);
    const count = asNumberOrNull(r.drug_count);
    return {
      id: asText(r.id),
      patientId: asText(r.patient_id),
      reviewedAt: asText(r.reviewed_at),
      ageYears: asNumber(r.age_years),
      medications: Array.isArray(r.medications) ? (r.medications as Record<string, unknown>[]) : [],
      drugCount: count,
      acbScore: acb,
      acbDrugs: Array.isArray(r.acb_drugs) ? (r.acb_drugs as Record<string, unknown>[]) : [],
      beersFlags: Array.isArray(r.beers_flags) ? (r.beers_flags as Record<string, unknown>[]) : [],
      beersCount: asNumberOrNull(r.beers_count),
      burdenHigh: (acb ?? 0) >= ACB_THRESHOLD,
      polypharmacy: (count ?? 0) >= POLYPHARMACY_AT,
    };
  }
}

const GROWTH_SELECT = `
  SELECT g.*, prev.weight_g AS prev_weight_g, prev.age_days AS prev_age_days
    FROM specialty.paed_growth_records g
    LEFT JOIN LATERAL (
      SELECT p.weight_g, p.age_days FROM specialty.paed_growth_records p
       WHERE p.patient_id = g.patient_id AND p.measured_at < g.measured_at
         AND p.weight_g IS NOT NULL
       ORDER BY p.measured_at DESC LIMIT 1
    ) prev ON true`;

const NICU_SELECT = `
  SELECT a.*,
         (SELECT f.weight_g FROM specialty.nicu_fluid_orders f
           WHERE f.nicu_admission_id = a.id ORDER BY f.for_date DESC LIMIT 1) AS latest_weight_g
    FROM specialty.nicu_admissions a`;
