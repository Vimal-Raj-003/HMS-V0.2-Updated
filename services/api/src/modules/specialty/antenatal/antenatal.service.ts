import { Injectable } from '@nestjs/common';
import { newId } from '@vims/contracts';
import type { TransactionClient } from '../../../core/db/database.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { consoleEvent } from '../consoles/consoles.events.js';
import {
  ConsoleSupport,
  asBoolOrNull,
  asJson,
  asNumber,
  asNumberOrNull,
  asStringArray,
  asText,
  asTextOrNull,
} from '../consoles/consoles.support.js';
import type {
  DeliveryPlanRequest,
  EddOverrideRequest,
  FormFRequest,
  FormFSignRequest,
  MtpPerformRequest,
  MtpQuery,
  MtpRequest,
  PncRequest,
  PregnancyQuery,
  PregnancyRequest,
  PregnancyUpdateRequest,
  ScheduleItemRequest,
  ScheduleQuery,
  ScheduleUpdateRequest,
  SonologistRequest,
  VisitRequest,
} from './antenatal.schemas.js';
import type {
  AncVisitRow,
  DeliveryPlanRow,
  FormFRow,
  MtpCaseRow,
  PncVisitRow,
  PregnancyDetail,
  PregnancyRow,
  ScheduleItemRow,
  SonologistRow,
} from './antenatal.types.js';

/**
 * The visit and investigation schedule a booking starts with.
 *
 * Stored as weeks rather than dates, so that correcting an estimated date of
 * delivery corrects the calendar rather than leaving eight appointments on the
 * old one. The weeks are the Indian national schedule; a hospital that runs a
 * different one edits this list, and the database moves the dates.
 */
const BOOKING_SCHEDULE: readonly {
  readonly kind: string;
  readonly code: string;
  readonly name: string;
  readonly weeks: number;
}[] = [
  { kind: 'visit', code: 'ANC1', name: 'First antenatal visit', weeks: 12 },
  { kind: 'lab', code: 'BOOKING_PANEL', name: 'Booking bloods', weeks: 12 },
  { kind: 'usg', code: 'NT_NB', name: 'Nuchal translucency and dual marker', weeks: 12 },
  { kind: 'vaccine', code: 'TD1', name: 'Td first dose', weeks: 16 },
  { kind: 'usg', code: 'TIFFA', name: 'Anomaly scan', weeks: 20 },
  { kind: 'visit', code: 'ANC2', name: 'Second antenatal visit', weeks: 20 },
  { kind: 'vaccine', code: 'TD2', name: 'Td second dose', weeks: 20 },
  { kind: 'lab', code: 'OGTT', name: 'Oral glucose tolerance test', weeks: 26 },
  { kind: 'visit', code: 'ANC3', name: 'Third antenatal visit', weeks: 26 },
  { kind: 'lab', code: 'HB_REPEAT', name: 'Haemoglobin', weeks: 28 },
  { kind: 'visit', code: 'ANC4', name: 'Fourth antenatal visit', weeks: 32 },
  { kind: 'usg', code: 'GROWTH', name: 'Growth scan', weeks: 32 },
  { kind: 'visit', code: 'ANC5', name: 'Fifth antenatal visit', weeks: 36 },
  { kind: 'usg', code: 'GROWTH_36', name: 'Growth and presentation scan', weeks: 36 },
  { kind: 'visit', code: 'ANC6', name: 'Term visit', weeks: 38 },
];

/**
 * OP-040 — the antenatal clinic.
 *
 * ── Nothing here computes a date, an age, a score or a serial ──────────────
 *
 * The estimated date of delivery, the gestational age at every visit, the
 * obstetric early warning score, the MTP category and the MTP serial are all
 * trigger outputs. A service that also computed them would be a second author
 * of the numbers every rule in this module is a line on.
 *
 * ── What it does is turn the rules round ───────────────────────────────────
 *
 * `antiDStatus`, `blockedBy`, `sfhFlag`, `daysOverdue`. Each is the same
 * arithmetic the database refuses on, read forwards: not "this is refused" but
 * "this is what will refuse it". In a module whose whole substance is a
 * calendar, that is the difference between a clinic and a filing cabinet.
 */
@Injectable()
export class AntenatalService extends ConsoleSupport {
  // ═══════════════════════════════════════════════════════════════════════════
  // The pregnancy
  // ═══════════════════════════════════════════════════════════════════════════

  async register(body: PregnancyRequest): Promise<PregnancyRow> {
    return this.guard(async (tx) => {
      const id = newId();
      // `working_edd`, `edd_lmp`, `edd_usg`, `edd_source` and `edd_rationale`
      // are all absent from the column list. The BEFORE trigger fills them, and
      // NOT NULL is checked after it runs — which is what makes "the date is
      // derived" a property of the schema rather than a convention.
      await tx.query(
        `INSERT INTO specialty.pregnancies
           (id, hospital_id, branch_id, patient_id, anc_no, lmp, lmp_certain, cycle_days,
            usg_dating, gravida, para, living, abortions, ectopic, obstetric_history,
            medical_history, booking_bmi, blood_group, rh_negative, rch_id, pmsma, scheme,
            created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15::jsonb,
                 $16::jsonb,$17,$18,$19,$20,$21,$22,$23,now(),now())`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.patientId,
          body.ancNo,
          body.lmp ?? null,
          body.lmpCertain,
          body.cycleDays,
          body.usgDating === undefined ? null : JSON.stringify(body.usgDating),
          body.gravida,
          body.para,
          body.living,
          body.abortions,
          body.ectopic,
          JSON.stringify(body.obstetricHistory),
          JSON.stringify(body.medicalHistory),
          body.bookingBmi ?? null,
          body.bloodGroup ?? null,
          body.rhNegative ?? null,
          body.rchId ?? null,
          body.pmsma,
          body.scheme,
          this.actorId(),
        ],
      );

      // The schedule is raised from the booking, in weeks. When the working date
      // moves, the database moves every one of these with it.
      for (const item of BOOKING_SCHEDULE) {
        await tx.query(
          `INSERT INTO specialty.anc_schedule_items
             (id, hospital_id, pregnancy_id, kind, code, name, due_ga_weeks, due_at,
              created_at, updated_at)
           SELECT $1, $2, $3, $4, $5, $6, $7, p.working_edd - (280 - $7 * 7), now(), now()
             FROM specialty.pregnancies p WHERE p.id = $3
           ON CONFLICT (pregnancy_id, kind, code) DO NOTHING`,
          [newId(), this.hospitalId(), id, item.kind, item.code, item.name, item.weeks],
        );
      }

      const pregnancy = await this.pregnancyWithin(tx, id);

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'pregnancy',
        rowId: id,
        businessKey: body.ancNo,
        dataClass: 'phi',
        patientId: body.patientId,
        encounterId: null,
        before: null,
        after: {
          workingEdd: pregnancy.workingEdd,
          eddSource: pregnancy.eddSource,
          gravida: body.gravida,
        },
      });

      await this.outbox.publish(
        tx,
        consoleEvent('obg.pregnancy.registered', id, {
          pregnancyId: id,
          patientId: body.patientId,
          ancNo: body.ancNo,
          workingEdd: pregnancy.workingEdd,
          eddSource: pregnancy.eddSource,
          gravida: body.gravida,
          rhNegative: pregnancy.rhNegative,
        }),
      );

      if (pregnancy.rhNegative === true) await this.announceAntiD(tx, pregnancy);

      return pregnancy;
    });
  }

  async update(id: string, body: PregnancyUpdateRequest): Promise<PregnancyRow> {
    return this.guard(async (tx) => {
      const before = await this.pregnancyWithin(tx, id);
      await tx.query(
        `UPDATE specialty.pregnancies
            SET lmp           = coalesce($2::date, lmp),
                lmp_certain   = coalesce($3, lmp_certain),
                cycle_days    = coalesce($4, cycle_days),
                usg_dating    = coalesce($5::jsonb, usg_dating),
                blood_group   = coalesce($6, blood_group),
                rh_negative   = coalesce($7, rh_negative),
                booking_bmi   = coalesce($8, booking_bmi),
                risk_category = coalesce($9::specialty."RiskCategory", risk_category),
                risk_flags    = coalesce($10::jsonb, risk_flags),
                status        = coalesce($11::specialty."PregnancyEpisodeStatus", status),
                outcome       = coalesce($12::jsonb, outcome),
                closed_at     = CASE WHEN $11::text IS NULL THEN closed_at
                                     WHEN $11::text = 'active' THEN NULL
                                     ELSE coalesce(closed_at, now()) END,
                updated_at    = now()
          WHERE id = $1 AND hospital_id = $13`,
        [
          id,
          body.lmp ?? null,
          body.lmpCertain ?? null,
          body.cycleDays ?? null,
          body.usgDating === undefined ? null : JSON.stringify(body.usgDating),
          body.bloodGroup ?? null,
          body.rhNegative ?? null,
          body.bookingBmi ?? null,
          body.riskCategory ?? null,
          body.riskFlags === undefined ? null : JSON.stringify(body.riskFlags),
          body.status ?? null,
          body.outcome === undefined ? null : JSON.stringify(body.outcome),
          this.hospitalId(),
        ],
      );

      const after = await this.pregnancyWithin(tx, id);

      await this.audit.write(tx, {
        action: 'update',
        entity: 'pregnancy',
        rowId: id,
        businessKey: after.ancNo,
        dataClass: 'phi',
        patientId: after.patientId,
        encounterId: null,
        before: { workingEdd: before.workingEdd, status: before.status },
        after: { workingEdd: after.workingEdd, status: after.status },
      });

      if (after.workingEdd !== before.workingEdd) await this.announceEddChange(tx, before, after);
      if (after.rhNegative === true && before.rhNegative !== true) await this.announceAntiD(tx, after);

      return after;
    });
  }

  /**
   * The documented way past the dating derivation.
   *
   * Two scans four weeks apart can genuinely disagree, and a clinician who has
   * looked at both is entitled to decide. The rationale goes on the record
   * rather than only into audit, because the next person to read this chart
   * needs to know the date is a judgement.
   */
  async overrideEdd(id: string, body: EddOverrideRequest): Promise<PregnancyRow> {
    return this.guard(async (tx) => {
      const before = await this.pregnancyWithin(tx, id);
      await tx.query(
        `UPDATE specialty.pregnancies
            SET working_edd = $2::date, edd_source = 'clinical', edd_rationale = $3, updated_at = now()
          WHERE id = $1 AND hospital_id = $4`,
        [id, body.workingEdd, body.rationale, this.hospitalId()],
      );
      const after = await this.pregnancyWithin(tx, id);

      await this.audit.write(tx, {
        action: 'override',
        entity: 'pregnancy',
        rowId: id,
        businessKey: after.ancNo,
        dataClass: 'phi',
        patientId: after.patientId,
        encounterId: null,
        reasonText: body.rationale,
        before: { workingEdd: before.workingEdd, eddSource: before.eddSource },
        after: { workingEdd: after.workingEdd, eddSource: 'clinical' },
      });

      if (after.workingEdd !== before.workingEdd) await this.announceEddChange(tx, before, after);
      return after;
    });
  }

  async list(query: PregnancyQuery): Promise<readonly PregnancyRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `${PREGNANCY_SELECT}
          WHERE p.hospital_id = $1
            AND ($2::uuid IS NULL OR p.patient_id = $2::uuid)
            AND ($3::boolean IS NOT TRUE OR p.status = 'active')
            AND ($4::boolean IS NOT TRUE OR p.risk_category = 'high')
            AND ($5::boolean IS NOT TRUE OR p.rh_negative IS TRUE)
            AND ($6::boolean IS NOT TRUE
                 OR p.working_edd BETWEEN current_date AND current_date + 7)
          ORDER BY p.working_edd
          LIMIT $7`,
        [
          this.hospitalId(),
          query.patientId ?? null,
          query.activeOnly,
          query.highRiskOnly,
          query.rhNegativeOnly,
          query.dueThisWeek,
          query.limit,
        ],
      );
      return rows.map((r) => this.toPregnancy(r));
    });
  }

  async detail(id: string): Promise<PregnancyDetail> {
    return this.guard(async (tx) => {
      const pregnancy = await this.pregnancyWithin(tx, id);
      const [visits, schedule, plans, pnc] = await Promise.all([
        tx.query<Record<string, unknown>>(
          `${VISIT_SELECT} WHERE v.pregnancy_id = $1 ORDER BY v.visit_no DESC`,
          [id],
        ),
        tx.query<Record<string, unknown>>(
          `${SCHEDULE_SELECT} WHERE i.pregnancy_id = $1 ORDER BY i.due_at, i.kind`,
          [id],
        ),
        tx.query<Record<string, unknown>>(
          `SELECT * FROM specialty.delivery_plans WHERE pregnancy_id = $1 ORDER BY version DESC`,
          [id],
        ),
        tx.query<Record<string, unknown>>(
          `SELECT * FROM specialty.pnc_visits WHERE pregnancy_id = $1 ORDER BY day_no`,
          [id],
        ),
      ]);
      return {
        pregnancy,
        visits: visits.rows.map((r) => this.toVisit(r)),
        schedule: schedule.rows.map((r) => this.toScheduleItem(r)),
        plans: plans.rows.map((r) => this.toPlan(r)),
        pnc: pnc.rows.map((r) => this.toPnc(r)),
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The visit
  // ═══════════════════════════════════════════════════════════════════════════

  async recordVisit(pregnancyId: string, body: VisitRequest): Promise<AncVisitRow> {
    return this.guard(async (tx) => {
      await this.requireParent(tx, 'specialty.pregnancies', pregnancyId, 'That pregnancy');
      const id = newId();
      // `ga_days`, `meows_score` and `meows_action` are absent from the column
      // list for the same reason the dating fields are.
      await tx.query(
        `INSERT INTO specialty.anc_visits
           (id, hospital_id, pregnancy_id, encounter_id, visit_no, visited_at, complaints,
            danger_signs, bp_sys, bp_dia, bp_sys_right, bp_dia_right, pulse, resp_rate,
            temperature_c, consciousness, weight_kg, pallor, oedema, urine_albumin, urine_sugar,
            sfh_cm, lie, presentation, engagement, fhr, fetal_movements, exam, supplements,
            immunisation, counselling, plan, next_visit_at, created_at, updated_at)
         SELECT $1, $2, $3, $4,
                coalesce((SELECT max(v.visit_no) FROM specialty.anc_visits v
                           WHERE v.pregnancy_id = $3::uuid), 0) + 1,
                coalesce($5::timestamptz, now()), $6::jsonb, $7::text[], $8, $9, $10, $11, $12,
                $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26,
                $27::jsonb, $28::jsonb, $29::jsonb, $30::text[], $31, $32::date, now(), now()`,
        [
          id,
          this.hospitalId(),
          pregnancyId,
          body.encounterId ?? null,
          body.visitedAt ?? null,
          JSON.stringify(body.complaints),
          body.dangerSigns,
          body.bpSys ?? null,
          body.bpDia ?? null,
          body.bpSysRight ?? null,
          body.bpDiaRight ?? null,
          body.pulse ?? null,
          body.respRate ?? null,
          body.temperatureC ?? null,
          body.consciousness ?? null,
          body.weightKg ?? null,
          body.pallor ?? null,
          body.oedema ?? null,
          body.urineAlbumin ?? null,
          body.urineSugar ?? null,
          body.sfhCm ?? null,
          body.lie ?? null,
          body.presentation ?? null,
          body.engagement ?? null,
          body.fhr ?? null,
          body.fetalMovements ?? null,
          JSON.stringify(body.exam),
          JSON.stringify(body.supplements),
          JSON.stringify(body.immunisation),
          body.counselling,
          body.plan ?? null,
          body.nextVisitAt ?? null,
        ],
      );

      const visit = await this.visitWithin(tx, id);

      // Bleeding, leaking, a headache with visual disturbance, reduced
      // movements: the presentations that go from an outpatient clinic to a
      // theatre in an afternoon.
      if (visit.dangerSigns.length > 0 || visit.meowsAction !== null) {
        const { rows } = await tx.query<Record<string, unknown>>(
          `SELECT patient_id FROM specialty.pregnancies WHERE id = $1`,
          [pregnancyId],
        );
        await this.outbox.publish(
          tx,
          consoleEvent('obg.visit.danger_sign', id, {
            visitId: id,
            pregnancyId,
            patientId: asText(this.one(rows).patient_id),
            gaDays: visit.gaDays ?? 0,
            dangerSigns: [...visit.dangerSigns],
            meowsScore: visit.meowsScore,
            action: visit.meowsAction,
          }),
        );
      }

      return visit;
    });
  }

  async signVisit(id: string): Promise<AncVisitRow> {
    return this.guard(async (tx) => {
      await tx.query(
        `UPDATE specialty.anc_visits SET signed_by = $2, signed_at = now(), updated_at = now()
          WHERE id = $1 AND hospital_id = $3`,
        [id, this.actorId(), this.hospitalId()],
      );
      const visit = await this.visitWithin(tx, id);

      await this.audit.write(tx, {
        action: 'sign',
        entity: 'anc_visit',
        rowId: id,
        businessKey: visit.pregnancyId,
        dataClass: 'phi',
        patientId: null,
        encounterId: null,
        before: null,
        after: { visitNo: visit.visitNo, gaDays: visit.gaDays },
      });

      return visit;
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The schedule
  // ═══════════════════════════════════════════════════════════════════════════

  async addScheduleItem(pregnancyId: string, body: ScheduleItemRequest): Promise<ScheduleItemRow> {
    return this.guard(async (tx) => {
      const id = newId();
      await tx.query(
        `INSERT INTO specialty.anc_schedule_items
           (id, hospital_id, pregnancy_id, kind, code, name, due_ga_weeks, due_at, created_at, updated_at)
         SELECT $1, $2, $3, $4, $5, $6, $7, p.working_edd - (280 - $7 * 7), now(), now()
           FROM specialty.pregnancies p WHERE p.id = $3
         ON CONFLICT (pregnancy_id, kind, code) DO NOTHING`,
        [id, this.hospitalId(), pregnancyId, body.kind, body.code, body.name, body.dueGaWeeks],
      );
      return this.scheduleItemWithin(tx, id);
    });
  }

  async updateScheduleItem(id: string, body: ScheduleUpdateRequest): Promise<ScheduleItemRow> {
    return this.guard(async (tx) => {
      await tx.query(
        `UPDATE specialty.anc_schedule_items
            SET status = $2, order_id = coalesce($3::uuid, order_id),
                result_summary = coalesce($4::jsonb, result_summary),
                waived_reason = coalesce($5, waived_reason), updated_at = now()
          WHERE id = $1 AND hospital_id = $6`,
        [
          id,
          body.status,
          body.orderId ?? null,
          body.resultSummary === undefined ? null : JSON.stringify(body.resultSummary),
          body.waivedReason ?? null,
          this.hospitalId(),
        ],
      );
      const item = await this.scheduleItemWithin(tx, id);

      // Waiving anti-D is a decision about the next pregnancy, so it is audited
      // with its reason even though the key is an ordinary one.
      if (item.kind === 'anti_d') {
        await this.audit.write(tx, {
          action: 'update',
          entity: 'anc_schedule_item',
          rowId: id,
          businessKey: item.pregnancyId,
          dataClass: 'phi',
          patientId: null,
          encounterId: null,
          ...(body.waivedReason === undefined ? {} : { reasonText: body.waivedReason }),
          before: null,
          after: { code: item.code, status: item.status },
        });
      }

      return item;
    });
  }

  async listSchedule(query: ScheduleQuery): Promise<readonly ScheduleItemRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `${SCHEDULE_SELECT}
          WHERE i.hospital_id = $1
            AND ($2::uuid IS NULL OR i.pregnancy_id = $2::uuid)
            AND ($3::boolean IS NOT TRUE
                 OR (i.due_at < current_date AND i.status NOT IN ('done', 'waived')))
            AND ($4::text IS NULL OR i.kind = $4::text)
          ORDER BY i.due_at
          LIMIT $5`,
        [this.hospitalId(), query.pregnancyId ?? null, query.overdueOnly, query.kind ?? null, query.limit],
      );
      return rows.map((r) => this.toScheduleItem(r));
    });
  }

  async writeDeliveryPlan(pregnancyId: string, body: DeliveryPlanRequest): Promise<DeliveryPlanRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.delivery_plans
           (id, hospital_id, pregnancy_id, version, planned_mode, indication, planned_date, place,
            pac_id, blood_request_id, admission_booking_id, consents, newborn_plan,
            birth_companion, transport, signed_by, signed_at, created_at, updated_at)
         SELECT $1, $2, $3, coalesce(max(d.version), 0) + 1, $4, $5, $6::date, $7, $8, $9, $10,
                $11::jsonb, $12::jsonb, $13, $14, $15, now(), now(), now()
           FROM specialty.delivery_plans d WHERE d.pregnancy_id = $3
         RETURNING *`,
        [
          newId(),
          this.hospitalId(),
          pregnancyId,
          body.plannedMode,
          body.indication ?? null,
          body.plannedDate ?? null,
          body.place ?? null,
          body.pacId ?? null,
          body.bloodRequestId ?? null,
          body.admissionBookingId ?? null,
          JSON.stringify(body.consents),
          JSON.stringify(body.newbornPlan),
          body.birthCompanion ?? null,
          body.transport ?? null,
          this.actorId(),
        ],
      );
      return this.toPlan(this.one(rows));
    });
  }

  async recordPnc(pregnancyId: string, body: PncRequest): Promise<PncVisitRow> {
    return this.guard(async (tx) => {
      // `epds_referral` is absent: it is the total *and* the tenth question,
      // and a screen that summed its own would eventually get the one that
      // matters wrong.
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.pnc_visits
           (id, hospital_id, pregnancy_id, day_no, visited_at, findings, bp_sys, bp_dia,
            epds_total, epds_item10, breastfeeding, contraception, referral, recorded_by,
            created_at, updated_at)
         VALUES ($1,$2,$3,$4,coalesce($5::timestamptz, now()),$6::jsonb,$7,$8,$9,$10,$11,
                 $12::jsonb,$13,$14,now(),now())
         RETURNING *`,
        [
          newId(),
          this.hospitalId(),
          pregnancyId,
          body.dayNo,
          body.visitedAt ?? null,
          JSON.stringify(body.findings),
          body.bpSys ?? null,
          body.bpDia ?? null,
          body.epdsTotal ?? null,
          body.epdsItem10 ?? null,
          body.breastfeeding ?? null,
          JSON.stringify(body.contraception),
          body.referral ?? null,
          this.actorId(),
        ],
      );
      return this.toPnc(this.one(rows));
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PC-PNDT
  // ═══════════════════════════════════════════════════════════════════════════

  async draftFormF(body: FormFRequest): Promise<FormFRow> {
    return this.guard(async (tx) => {
      const id = newId();
      await tx.query(
        `INSERT INTO specialty.pcpndt_form_f
           (id, hospital_id, branch_id, scan_order_id, patient_id, pregnancy_id, machine_id,
            centre_reg_no, sonologist_id, referring_doctor, indication_code, declaration,
            result_summary, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'{}'::jsonb,$12,$13,now(),now())`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.scanOrderId,
          body.patientId,
          body.pregnancyId ?? null,
          body.machineId,
          body.centreRegNo,
          body.sonologistId,
          body.referringDoctor,
          body.indicationCode,
          body.resultSummary ?? null,
          this.actorId(),
        ],
      );
      return this.formFWithin(tx, id);
    });
  }

  async signFormF(id: string, body: FormFSignRequest): Promise<FormFRow> {
    return this.guard(async (tx) => {
      await tx.query(
        `UPDATE specialty.pcpndt_form_f
            SET declaration = $2::jsonb,
                result_summary = coalesce($3, result_summary),
                signed_at = now(), updated_at = now()
          WHERE id = $1 AND hospital_id = $4`,
        [
          id,
          JSON.stringify({
            patientAttested: body.patientAttested,
            sonologistAttested: body.sonologistAttested,
            ...(body.patientSignatureRef === undefined
              ? {}
              : { patientSignatureRef: body.patientSignatureRef }),
            attestedAt: new Date().toISOString(),
          }),
          body.resultSummary ?? null,
          this.hospitalId(),
        ],
      );
      const form = await this.formFWithin(tx, id);

      await this.audit.write(tx, {
        action: 'sign',
        entity: 'pcpndt_form_f',
        rowId: id,
        businessKey: form.scanOrderId,
        dataClass: 'phi',
        patientId: form.patientId,
        encounterId: null,
        before: null,
        after: { centreRegNo: form.centreRegNo, indicationCode: form.indicationCode },
      });

      await this.outbox.publish(
        tx,
        consoleEvent('pcpndt.form_f.signed', id, {
          formFId: id,
          scanOrderId: form.scanOrderId,
          sonologistId: form.sonologistId,
          centreRegNo: form.centreRegNo,
          indicationCode: form.indicationCode,
          signedAt: form.signedAt ?? new Date().toISOString(),
        }),
      );

      return form;
    });
  }

  async listFormF(): Promise<readonly FormFRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `${FORM_F_SELECT} WHERE f.hospital_id = $1 ORDER BY f.created_at DESC LIMIT 200`,
        [this.hospitalId()],
      );
      return rows.map((r) => this.toFormF(r));
    });
  }

  async addSonologist(body: SonologistRequest): Promise<SonologistRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.pcpndt_sonologists
           (id, hospital_id, user_id, registration_no, qualification, valid_from, valid_to,
            created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6::date,$7::date,now(),now())
         RETURNING *`,
        [
          newId(),
          this.hospitalId(),
          body.userId,
          body.registrationNo,
          body.qualification,
          body.validFrom,
          body.validTo ?? null,
        ],
      );
      const row = this.one(rows);

      // Adding somebody to this list is what makes their signature lawful under
      // the Act, so it is audited as the sensitive grant it is.
      await this.audit.write(tx, {
        action: 'approve',
        entity: 'pcpndt_sonologist',
        rowId: asText(row.id),
        businessKey: body.registrationNo,
        dataClass: 'operational',
        patientId: null,
        encounterId: null,
        reasonText: body.reason,
        before: null,
        after: { userId: body.userId, registrationNo: body.registrationNo },
      });

      return this.toSonologist(row);
    });
  }

  async listSonologists(): Promise<readonly SonologistRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM specialty.pcpndt_sonologists WHERE hospital_id = $1
          ORDER BY valid_to NULLS FIRST, registration_no`,
        [this.hospitalId()],
      );
      return rows.map((r) => this.toSonologist(r));
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MTP
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * The serial and the category are both absent from the request, and both for
   * the same reason: a serial a caller can choose is a register with a hole in
   * it, and a category a caller can choose is a gate somebody walks round.
   */
  async recordMtp(body: MtpRequest): Promise<MtpCaseRow> {
    return this.guard(async (tx) => {
      const id = newId();
      await tx.query(
        `INSERT INTO specialty.mtp_cases
           (id, hospital_id, branch_id, patient_id, mtp_serial, pregnancy_id, ga_days_by_usg,
            category, grounds, minor, guardian_consent_id, opinion_ids, form_c_consent_id,
            medical_board_ref, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,0,$5,$6,'le20',$7,$8,$9,$10::uuid[],$11,$12,$13,now(),now())`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.patientId,
          body.pregnancyId ?? null,
          body.gaDaysByUsg,
          body.grounds ?? null,
          body.minor,
          body.guardianConsentId ?? null,
          body.opinionIds,
          body.formCConsentId,
          body.medicalBoardRef ?? null,
          this.actorId(),
        ],
      );
      const mtp = await this.mtpWithin(tx, id);

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'mtp_case',
        rowId: id,
        businessKey: String(mtp.mtpSerial),
        dataClass: 'phi',
        patientId: body.patientId,
        encounterId: null,
        reasonText: body.reason,
        before: null,
        after: { serial: mtp.mtpSerial, category: mtp.category, gaDays: mtp.gaDaysByUsg },
      });

      return mtp;
    });
  }

  async performMtp(id: string, body: MtpPerformRequest): Promise<MtpCaseRow> {
    return this.guard(async (tx) => {
      await tx.query(
        `UPDATE specialty.mtp_cases
            SET method = $2::specialty."MtpMethod", regimen = $3::jsonb,
                procedure_id = coalesce($4::uuid, procedure_id),
                performed_at = coalesce(performed_at, now()), performed_by = coalesce(performed_by, $5),
                complications = $6::jsonb, anti_d_given = $7, contraception = $8::jsonb,
                updated_at = now()
          WHERE id = $1 AND hospital_id = $9`,
        [
          id,
          body.method,
          JSON.stringify(body.regimen),
          body.procedureId ?? null,
          this.actorId(),
          JSON.stringify(body.complications),
          body.antiDGiven,
          JSON.stringify(body.contraception),
          this.hospitalId(),
        ],
      );
      return this.mtpWithin(tx, id);
    });
  }

  async listMtp(query: MtpQuery): Promise<readonly MtpCaseRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM specialty.mtp_cases
          WHERE hospital_id = $1
            AND ($2::text IS NULL OR to_char(performed_at, 'YYYY-MM') = $2::text)
          ORDER BY mtp_serial DESC
          LIMIT $3`,
        [this.hospitalId(), query.month ?? null, query.limit],
      );
      return rows.map((r) => this.toMtp(r));
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Shaping
  // ═══════════════════════════════════════════════════════════════════════════

  private one(rows: readonly Record<string, unknown>[]): Record<string, unknown> {
    const row = rows[0];
    if (row === undefined) throw AppError.notFound('That antenatal record was not found.');
    return row;
  }

  private async pregnancyWithin(tx: TransactionClient, id: string): Promise<PregnancyRow> {
    const { rows } = await tx.query<Record<string, unknown>>(`${PREGNANCY_SELECT} WHERE p.id = $1`, [id]);
    return this.toPregnancy(this.one(rows));
  }

  private async visitWithin(tx: TransactionClient, id: string): Promise<AncVisitRow> {
    const { rows } = await tx.query<Record<string, unknown>>(`${VISIT_SELECT} WHERE v.id = $1`, [id]);
    return this.toVisit(this.one(rows));
  }

  private async scheduleItemWithin(tx: TransactionClient, id: string): Promise<ScheduleItemRow> {
    const { rows } = await tx.query<Record<string, unknown>>(`${SCHEDULE_SELECT} WHERE i.id = $1`, [id]);
    return this.toScheduleItem(this.one(rows));
  }

  private async formFWithin(tx: TransactionClient, id: string): Promise<FormFRow> {
    const { rows } = await tx.query<Record<string, unknown>>(`${FORM_F_SELECT} WHERE f.id = $1`, [id]);
    return this.toFormF(this.one(rows));
  }

  private async mtpWithin(tx: TransactionClient, id: string): Promise<MtpCaseRow> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM specialty.mtp_cases WHERE id = $1`,
      [id],
    );
    return this.toMtp(this.one(rows));
  }

  private async announceEddChange(
    tx: TransactionClient,
    before: PregnancyRow,
    after: PregnancyRow,
  ): Promise<void> {
    await this.outbox.publish(
      tx,
      consoleEvent('obg.edd.changed', after.id, {
        pregnancyId: after.id,
        patientId: after.patientId,
        previousEdd: before.workingEdd,
        workingEdd: after.workingEdd,
        eddSource: after.eddSource,
        rationale: after.eddRationale ?? '',
      }),
    );
  }

  private async announceAntiD(tx: TransactionClient, pregnancy: PregnancyRow): Promise<void> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT id, due_at, due_ga_weeks FROM specialty.anc_schedule_items
        WHERE pregnancy_id = $1 AND kind = 'anti_d' AND status NOT IN ('done', 'waived')
        ORDER BY due_at LIMIT 1`,
      [pregnancy.id],
    );
    const item = rows[0];
    if (item === undefined) return;
    await this.outbox.publish(
      tx,
      consoleEvent('obg.anti_d.due', asText(item.id), {
        pregnancyId: pregnancy.id,
        patientId: pregnancy.patientId,
        itemId: asText(item.id),
        dueAt: asText(item.due_at),
        dueGaWeeks: asNumber(item.due_ga_weeks),
      }),
    );
  }

  private gaLabel(gaDays: number | null): string {
    if (gaDays === null) return '—';
    const weeks = Math.floor(gaDays / 7);
    const days = Math.abs(gaDays % 7);
    return `${String(weeks)}w${String(days)}d`;
  }

  private toPregnancy(r: Record<string, unknown>): PregnancyRow {
    const gaDays = asNumber(r.ga_days_today);
    const rhNegative = asBoolOrNull(r.rh_negative);
    const antiDOutstanding = asNumber(r.anti_d_outstanding);
    const antiDSettled = asNumber(r.anti_d_settled);

    return {
      id: asText(r.id),
      patientId: asText(r.patient_id),
      ancNo: asText(r.anc_no),
      lmp: asTextOrNull(r.lmp),
      lmpCertain: r.lmp_certain === true,
      cycleDays: asNumber(r.cycle_days),
      eddLmp: asTextOrNull(r.edd_lmp),
      eddUsg: asTextOrNull(r.edd_usg),
      usgDating: r.usg_dating === null || r.usg_dating === undefined ? null : asJson(r.usg_dating),
      workingEdd: asText(r.working_edd),
      eddSource: asText(r.edd_source),
      eddRationale: asTextOrNull(r.edd_rationale),
      gravida: asNumber(r.gravida),
      para: asNumber(r.para),
      living: asNumber(r.living),
      abortions: asNumber(r.abortions),
      ectopic: asNumber(r.ectopic),
      formula: `G${asText(r.gravida)} P${asText(r.para)} L${asText(r.living)} A${asText(r.abortions)}`,
      bookingBmi: asNumberOrNull(r.booking_bmi),
      bloodGroup: asTextOrNull(r.blood_group),
      rhNegative,
      riskCategory: asText(r.risk_category),
      riskFlags: Array.isArray(r.risk_flags) ? (r.risk_flags as Record<string, unknown>[]) : [],
      status: asText(r.status),
      closedAt: asTextOrNull(r.closed_at),
      gaDays,
      gaLabel: this.gaLabel(gaDays),
      trimester: gaDays < 98 ? 1 : gaDays < 196 ? 2 : 3,
      weeksToTerm: Math.max(Math.ceil((280 - gaDays) / 7), 0),
      dueItems: asNumber(r.due_items),
      overdueItems: asNumber(r.overdue_items),
      // The closing gate, read forwards. A Rhesus-positive woman has no anti-D
      // to settle, and saying so is more useful than an empty field.
      antiDStatus:
        rhNegative !== true
          ? 'not_applicable'
          : antiDOutstanding > 0
            ? asNumber(r.anti_d_overdue) > 0
              ? 'overdue'
              : 'due'
            : antiDSettled > 0
              ? asText(r.anti_d_state)
              : 'not_raised',
      lastVisitAt: asTextOrNull(r.last_visit_at),
      nextVisitAt: asTextOrNull(r.next_visit_at),
    };
  }

  private toVisit(r: Record<string, unknown>): AncVisitRow {
    const gaDays = asNumberOrNull(r.ga_days);
    const sfh = asNumberOrNull(r.sfh_cm);
    const dangerSigns = asStringArray(r.danger_signs);
    const plan = asTextOrNull(r.plan);

    // Symphysio-fundal height against gestation in weeks. The one measurement
    // that finds growth restriction and excess liquor in a clinic with no
    // scanner, and it is a subtraction nobody does at the bedside.
    let sfhDeviationCm: number | null = null;
    let sfhFlag: string | null = null;
    if (sfh !== null && gaDays !== null && gaDays >= 168) {
      sfhDeviationCm = Math.round((sfh - gaDays / 7) * 10) / 10;
      if (sfhDeviationCm <= -3) sfhFlag = 'small for dates — growth scan';
      else if (sfhDeviationCm >= 3) sfhFlag = 'large for dates — scan for liquor and growth';
    }

    const blockedBy: string[] = [];
    if (
      asTextOrNull(r.signed_at) === null &&
      dangerSigns.length > 0 &&
      (plan === null || plan.trim().length < 8)
    ) {
      blockedBy.push(
        `${dangerSigns.join(', ').replace(/_/gu, ' ')} was recorded, so the visit needs a plan before it can be signed`,
      );
    }

    return {
      id: asText(r.id),
      pregnancyId: asText(r.pregnancy_id),
      visitNo: asNumber(r.visit_no),
      visitedAt: asText(r.visited_at),
      gaDays,
      gaLabel: this.gaLabel(gaDays),
      complaints: asJson(r.complaints),
      dangerSigns,
      bpSys: asNumberOrNull(r.bp_sys),
      bpDia: asNumberOrNull(r.bp_dia),
      pulse: asNumberOrNull(r.pulse),
      respRate: asNumberOrNull(r.resp_rate),
      temperatureC: asNumberOrNull(r.temperature_c),
      consciousness: asTextOrNull(r.consciousness),
      weightKg: asNumberOrNull(r.weight_kg),
      urineAlbumin: asTextOrNull(r.urine_albumin),
      urineSugar: asTextOrNull(r.urine_sugar),
      sfhCm: sfh,
      lie: asTextOrNull(r.lie),
      presentation: asTextOrNull(r.presentation),
      fhr: asNumberOrNull(r.fhr),
      fetalMovements: asTextOrNull(r.fetal_movements),
      meowsScore: asNumberOrNull(r.meows_score),
      meowsAction: asTextOrNull(r.meows_action),
      sfhDeviationCm,
      sfhFlag,
      plan,
      nextVisitAt: asTextOrNull(r.next_visit_at),
      signedBy: asTextOrNull(r.signed_by),
      signedAt: asTextOrNull(r.signed_at),
      blockedBy,
    };
  }

  private toScheduleItem(r: Record<string, unknown>): ScheduleItemRow {
    const overdue = asNumberOrNull(r.days_overdue);
    return {
      id: asText(r.id),
      pregnancyId: asText(r.pregnancy_id),
      kind: asText(r.kind),
      code: asText(r.code),
      name: asText(r.name),
      dueGaWeeks: asNumber(r.due_ga_weeks),
      dueAt: asText(r.due_at),
      orderId: asTextOrNull(r.order_id),
      status: asText(r.status),
      waivedReason: asTextOrNull(r.waived_reason),
      daysOverdue: overdue !== null && overdue > 0 ? overdue : null,
    };
  }

  private toPlan(r: Record<string, unknown>): DeliveryPlanRow {
    return {
      id: asText(r.id),
      pregnancyId: asText(r.pregnancy_id),
      version: asNumber(r.version),
      plannedMode: asText(r.planned_mode),
      indication: asTextOrNull(r.indication),
      plannedDate: asTextOrNull(r.planned_date),
      place: asTextOrNull(r.place),
      consents: asJson(r.consents),
      newbornPlan: asJson(r.newborn_plan),
      signedBy: asTextOrNull(r.signed_by),
      signedAt: asTextOrNull(r.signed_at),
    };
  }

  private toFormF(r: Record<string, unknown>): FormFRow {
    return {
      id: asText(r.id),
      scanOrderId: asText(r.scan_order_id),
      patientId: asText(r.patient_id),
      pregnancyId: asTextOrNull(r.pregnancy_id),
      machineId: asText(r.machine_id),
      centreRegNo: asText(r.centre_reg_no),
      sonologistId: asText(r.sonologist_id),
      referringDoctor: asText(r.referring_doctor),
      indicationCode: asText(r.indication_code),
      declaration: asJson(r.declaration),
      resultSummary: asTextOrNull(r.result_summary),
      signedAt: asTextOrNull(r.signed_at),
      locked: r.locked === true,
      sonologistRegistered: r.sonologist_registered === true,
    };
  }

  private toSonologist(r: Record<string, unknown>): SonologistRow {
    const validTo = asTextOrNull(r.valid_to);
    const daysToExpiry =
      validTo === null ? null : Math.ceil((new Date(validTo).getTime() - Date.now()) / 86_400_000);
    return {
      id: asText(r.id),
      userId: asText(r.user_id),
      registrationNo: asText(r.registration_no),
      qualification: asText(r.qualification),
      validFrom: asText(r.valid_from),
      validTo,
      current: daysToExpiry === null || daysToExpiry >= 0,
      daysToExpiry,
    };
  }

  private toMtp(r: Record<string, unknown>): MtpCaseRow {
    const gaDays = asNumber(r.ga_days_by_usg);
    const category = asText(r.category);
    const opinionIds = asStringArray(r.opinion_ids);
    const grounds = asTextOrNull(r.grounds);
    const boardRef = asTextOrNull(r.medical_board_ref);
    const minor = r.minor === true;

    // The Act's gates, read forwards. What is still wanted, rather than what
    // was refused.
    const blockedBy: string[] = [];
    if (category === 'le20' && opinionIds.length < 1) {
      blockedBy.push('one registered medical practitioner’s opinion');
    }
    if (category === 'wk20_24') {
      if (opinionIds.length < 2) blockedBy.push('two practitioners’ opinions');
      else if (new Set(opinionIds).size < 2) blockedBy.push('a second, different practitioner');
      if (grounds === null) blockedBy.push('one of the grounds named in the Act');
    }
    if (category === 'gt24_board' && boardRef === null) blockedBy.push('a Medical Board reference');
    if (minor && asTextOrNull(r.guardian_consent_id) === null) blockedBy.push('the guardian’s consent');

    return {
      id: asText(r.id),
      patientId: asText(r.patient_id),
      mtpSerial: asNumber(r.mtp_serial),
      gaDaysByUsg: gaDays,
      gaLabel: this.gaLabel(gaDays),
      category,
      grounds,
      minor,
      opinionIds,
      medicalBoardRef: boardRef,
      method: asTextOrNull(r.method),
      performedAt: asTextOrNull(r.performed_at),
      antiDGiven: r.anti_d_given === true,
      registerLocked: r.register_locked === true,
      blockedBy,
    };
  }

  private toPnc(r: Record<string, unknown>): PncVisitRow {
    return {
      id: asText(r.id),
      pregnancyId: asText(r.pregnancy_id),
      dayNo: asNumber(r.day_no),
      visitedAt: asText(r.visited_at),
      bpSys: asNumberOrNull(r.bp_sys),
      bpDia: asNumberOrNull(r.bp_dia),
      epdsTotal: asNumberOrNull(r.epds_total),
      epdsItem10: asNumberOrNull(r.epds_item10),
      epdsReferral: r.epds_referral === true,
      breastfeeding: asTextOrNull(r.breastfeeding),
      referral: asTextOrNull(r.referral),
    };
  }
}

const PREGNANCY_SELECT = `
  SELECT p.*,
         (280 - (p.working_edd - current_date)) AS ga_days_today,
         (SELECT count(*) FROM specialty.anc_schedule_items i
           WHERE i.pregnancy_id = p.id AND i.status IN ('due','ordered')) AS due_items,
         (SELECT count(*) FROM specialty.anc_schedule_items i
           WHERE i.pregnancy_id = p.id AND i.status NOT IN ('done','waived')
             AND i.due_at < current_date) AS overdue_items,
         (SELECT count(*) FROM specialty.anc_schedule_items i
           WHERE i.pregnancy_id = p.id AND i.kind = 'anti_d'
             AND i.status NOT IN ('done','waived')) AS anti_d_outstanding,
         (SELECT count(*) FROM specialty.anc_schedule_items i
           WHERE i.pregnancy_id = p.id AND i.kind = 'anti_d'
             AND i.status NOT IN ('done','waived') AND i.due_at < current_date) AS anti_d_overdue,
         (SELECT count(*) FROM specialty.anc_schedule_items i
           WHERE i.pregnancy_id = p.id AND i.kind = 'anti_d'
             AND i.status IN ('done','waived')) AS anti_d_settled,
         (SELECT i.status FROM specialty.anc_schedule_items i
           WHERE i.pregnancy_id = p.id AND i.kind = 'anti_d'
           ORDER BY (i.status IN ('done','waived')) DESC, i.due_at LIMIT 1) AS anti_d_state,
         (SELECT max(v.visited_at) FROM specialty.anc_visits v WHERE v.pregnancy_id = p.id) AS last_visit_at,
         (SELECT v.next_visit_at FROM specialty.anc_visits v WHERE v.pregnancy_id = p.id
           ORDER BY v.visit_no DESC LIMIT 1) AS next_visit_at
    FROM specialty.pregnancies p`;

const VISIT_SELECT = `SELECT v.* FROM specialty.anc_visits v`;

const SCHEDULE_SELECT = `
  SELECT i.*,
         CASE WHEN i.status IN ('done','waived') THEN NULL
              ELSE (current_date - i.due_at) END AS days_overdue
    FROM specialty.anc_schedule_items i`;

const FORM_F_SELECT = `
  SELECT f.*,
         EXISTS (SELECT 1 FROM specialty.pcpndt_sonologists s
                  WHERE s.hospital_id = f.hospital_id AND s.user_id = f.sonologist_id
                    AND s.valid_from <= current_date
                    AND (s.valid_to IS NULL OR s.valid_to >= current_date)) AS sonologist_registered
    FROM specialty.pcpndt_form_f f`;
