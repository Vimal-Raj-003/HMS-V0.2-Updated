import { Injectable } from '@nestjs/common';
import { newId } from '@vims/contracts';
import type { TransactionClient } from '../../../core/db/database.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { consoleEvent } from '../consoles/consoles.events.js';
import {
  ConsoleSupport,
  asBool,
  asJson,
  asNumber,
  asStringArray,
  asText,
  asTextOrNull,
} from '../consoles/consoles.support.js';
import type {
  ConsultQuery,
  ConsultRequest,
  ConsultSignRequest,
  ConsultUpdateRequest,
  CourseQuery,
  CourseRequest,
  CourseUpdateRequest,
  MedicineQuery,
  MedicineRequest,
  PrescriptionRequest,
  RegistrationQuery,
  RegistrationRequest,
  SessionLogRequest,
  SessionReviewRequest,
  SessionScheduleRequest,
  SessionSkipRequest,
} from './ayush.schemas.js';
import type {
  AyushConsultRow,
  AyushCourseRow,
  AyushMedicineRow,
  AyushPrescriptionLineRow,
  AyushProcedureRow,
  AyushRegistrationRow,
  AyushSessionRow,
} from './ayush.types.js';

/**
 * OP-037 — the AYUSH consoles.
 *
 * ── Nothing here decides what a practitioner may practise ──────────────────
 *
 * The council registration does, and a trigger reads it. What this service
 * adds is saying so before the consultation is opened: `/registrations` with
 * `liveOnly` is the same rule read forwards, and the answer to "why can I not
 * open a homoeopathy consultation" should be on the screen rather than in a
 * 409.
 *
 * ── Nor whether a pradhana karma may proceed ───────────────────────────────
 *
 * `readyForPradhana` and `blockedBy` are computed from the same facts the
 * trigger checks — a completed purvakarma session with samyak lakshana, a
 * consent, no unreviewed adverse event — because a therapist who learns at the
 * door has already brought the patient in and undressed them.
 *
 * ── Nor how long a Bhasma may be prescribed for ────────────────────────────
 *
 * `specialty.rasa_max_days()` and `specialty.rasa_monitoring_after_days()` do,
 * and the formulary endpoint returns both so the composer can show the ceiling
 * rather than discover it.
 */
@Injectable()
export class AyushService extends ConsoleSupport {
  // ── Registrations ─────────────────────────────────────────────────────────

  async recordRegistration(body: RegistrationRequest): Promise<AyushRegistrationRow> {
    return this.guard(async (tx) => {
      const id = newId();
      await tx.query(
        `INSERT INTO specialty.ayush_registrations
           (id, hospital_id, branch_id, practitioner_id, system, council, registration_no,
            valid_from, valid_to, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5::specialty."AyushSystem",$6::specialty."AyushCouncil",$7,
                 $8::date,$9::date,$10,now(),now())
         ON CONFLICT (hospital_id, practitioner_id, system) DO UPDATE
            SET council = EXCLUDED.council, registration_no = EXCLUDED.registration_no,
                valid_from = EXCLUDED.valid_from, valid_to = EXCLUDED.valid_to,
                updated_at = now()`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.practitionerId,
          body.system,
          body.council,
          body.registrationNo,
          body.validFrom,
          body.validTo ?? null,
          this.actorId(),
        ],
      );

      const row = await this.registrationWithin(tx, body.practitionerId, body.system);

      // The one act in this module that could put a patient in front of an
      // unregistered practitioner.
      await this.audit.write(tx, {
        action: 'config_change',
        entity: 'ayush_registration',
        rowId: row.id,
        businessKey: body.registrationNo,
        dataClass: 'operational',
        patientId: null,
        encounterId: null,
        reasonText: body.reason,
        before: null,
        after: { system: body.system, council: body.council, validTo: body.validTo ?? null },
      });

      return row;
    });
  }

  async listRegistrations(query: RegistrationQuery): Promise<readonly AyushRegistrationRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM specialty.ayush_registrations r
          WHERE r.hospital_id = $1
            AND ($2::uuid IS NULL OR r.practitioner_id = $2::uuid)
            AND ($3::text IS NULL OR r.system::text = $3::text)
            AND ($4::boolean IS NOT TRUE
                 OR (r.valid_from <= current_date
                     AND (r.valid_to IS NULL OR r.valid_to >= current_date)))
          ORDER BY r.system, r.valid_from DESC
          LIMIT $5`,
        [this.hospitalId(), query.practitionerId ?? null, query.system ?? null, query.liveOnly, query.limit],
      );
      return rows.map((x) => this.toRegistration(x));
    });
  }

  // ── Consultations ─────────────────────────────────────────────────────────

  async openConsult(body: ConsultRequest): Promise<AyushConsultRow> {
    return this.guard(async (tx) => {
      const id = newId();
      await tx.query(
        `INSERT INTO specialty.ayush_consults
           (id, hospital_id, branch_id, patient_id, encounter_id, practitioner_id, system,
            assessment, plan, pathya_apathya, lifestyle, notes, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::specialty."AyushSystem",
                 $8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,now(),now())`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.patientId,
          body.encounterId ?? null,
          body.practitionerId,
          body.system,
          JSON.stringify(body.assessment),
          JSON.stringify(body.plan),
          JSON.stringify(body.pathyaApathya),
          JSON.stringify(body.lifestyle),
          body.notes ?? null,
          this.actorId(),
        ],
      );
      return this.consultWithin(tx, id);
    });
  }

  async updateConsult(id: string, body: ConsultUpdateRequest): Promise<AyushConsultRow> {
    return this.guard(async (tx) => {
      await tx.query(
        `UPDATE specialty.ayush_consults
            SET assessment     = coalesce($2::jsonb, assessment),
                diagnoses      = coalesce($3::jsonb, diagnoses),
                plan           = coalesce($4::jsonb, plan),
                pathya_apathya = coalesce($5::jsonb, pathya_apathya),
                lifestyle      = coalesce($6::jsonb, lifestyle),
                notes          = coalesce($7, notes),
                updated_at     = now()
          WHERE id = $1 AND hospital_id = $8 AND signed_at IS NULL`,
        [
          id,
          body.assessment === undefined ? null : JSON.stringify(body.assessment),
          body.diagnoses === undefined ? null : JSON.stringify(body.diagnoses),
          body.plan === undefined ? null : JSON.stringify(body.plan),
          body.pathyaApathya === undefined ? null : JSON.stringify(body.pathyaApathya),
          body.lifestyle === undefined ? null : JSON.stringify(body.lifestyle),
          body.notes ?? null,
          this.hospitalId(),
        ],
      );
      return this.consultWithin(tx, id);
    });
  }

  async signConsult(id: string, body: ConsultSignRequest): Promise<AyushConsultRow> {
    return this.guard(async (tx) => {
      await tx.query(
        `UPDATE specialty.ayush_consults
            SET diagnoses = $2::jsonb, signed_by = $3, signed_at = now(), updated_at = now()
          WHERE id = $1 AND hospital_id = $4`,
        [id, JSON.stringify(body.diagnoses), this.actorId(), this.hospitalId()],
      );
      const consult = await this.consultWithin(tx, id);

      await this.audit.write(tx, {
        action: 'sign',
        entity: 'ayush_consult',
        rowId: id,
        businessKey: consult.system,
        dataClass: 'phi',
        patientId: consult.patientId,
        encounterId: consult.encounterId,
        reasonText: null,
        before: null,
        after: { diagnoses: body.diagnoses.map((d) => d.namasteCode) },
      });

      return consult;
    });
  }

  async listConsults(query: ConsultQuery): Promise<readonly AyushConsultRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `${CONSULT_SELECT}
          WHERE c.hospital_id = $1
            AND ($2::uuid IS NULL OR c.patient_id = $2::uuid)
            AND ($3::text IS NULL OR c.system::text = $3::text)
            AND ($4::boolean IS NOT TRUE OR c.signed_at IS NULL)
          ORDER BY c.created_at DESC
          LIMIT $5`,
        [this.hospitalId(), query.patientId ?? null, query.system ?? null, query.unsignedOnly, query.limit],
      );
      return rows.map((x) => this.toConsult(x));
    });
  }

  // ── Prescribing ───────────────────────────────────────────────────────────

  async prescribe(consultId: string, body: PrescriptionRequest): Promise<AyushPrescriptionLineRow> {
    return this.guard(async (tx) => {
      const id = newId();
      await tx.query(
        `INSERT INTO specialty.ayush_prescription_lines
           (id, hospital_id, consult_id, medicine_id, dose, unit, anupana, kala,
            potency, scale, repetition, duration_days, monitoring_order_id, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now(),now())`,
        [
          id,
          this.hospitalId(),
          consultId,
          body.medicineId,
          body.dose,
          body.unit,
          body.anupana ?? null,
          body.kala ?? null,
          body.potency ?? null,
          body.scale ?? null,
          body.repetition ?? null,
          body.durationDays,
          body.monitoringOrderId ?? null,
        ],
      );
      const line = await this.lineWithin(tx, id);

      // The Drugs and Cosmetics Rules make the dispensing register a statutory
      // document kept by the pharmacy. A register assembled from the console at
      // month end is a register nobody wrote.
      if (line.scheduleE1) {
        await this.outbox.publish(
          tx,
          consoleEvent('ayush.schedule_e1.prescribed', id, {
            lineId: id,
            consultId,
            medicineId: line.medicineId,
            medicineName: line.medicineName,
            durationDays: line.durationDays,
            heavyMetal: line.heavyMetal,
          }),
        );
      }

      if (line.heavyMetal && line.monitoringDueAt !== null) {
        const consult = await this.consultWithin(tx, consultId);
        await this.outbox.publish(
          tx,
          consoleEvent('ayush.monitoring.due', id, {
            lineId: id,
            patientId: consult.patientId,
            medicineName: line.medicineName,
            monitoringDueAt: line.monitoringDueAt,
            monitoringOrderId: line.monitoringOrderId,
          }),
        );
      }

      return line;
    });
  }

  async listPrescriptions(consultId: string): Promise<readonly AyushPrescriptionLineRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `${LINE_SELECT} WHERE l.consult_id = $1 AND l.hospital_id = $2 ORDER BY l.created_at`,
        [consultId, this.hospitalId()],
      );
      return rows.map((x) => this.toLine(x));
    });
  }

  async addMedicine(body: MedicineRequest): Promise<AyushMedicineRow> {
    return this.guard(async (tx) => {
      const id = newId();
      await tx.query(
        `INSERT INTO mdm.ayush_medicines
           (id, hospital_id, system, code, name, type, classical_ref, form, manufacturer,
            licence_no, schedule_e1, heavy_metal, contraindications, interactions,
            created_at, updated_at)
         VALUES ($1,$2,$3::specialty."AyushSystem",$4,$5,$6::mdm."AyushMedicineType",
                 $7::jsonb,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,now(),now())`,
        [
          id,
          this.hospitalId(),
          body.system,
          body.code,
          body.name,
          body.type,
          body.classicalRef === undefined ? null : JSON.stringify(body.classicalRef),
          body.form ?? null,
          body.manufacturer ?? null,
          body.licenceNo ?? null,
          body.scheduleE1,
          body.heavyMetal,
          JSON.stringify(body.contraindications),
          JSON.stringify(body.interactions),
        ],
      );
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM mdm.ayush_medicines WHERE id = $1`,
        [id],
      );
      return this.toMedicine(this.one(rows), null);
    });
  }

  /**
   * The formulary, read against one consultation.
   *
   * A medicine from another system is returned marked unreachable rather than
   * filtered out, for the same reason the telemedicine catalogue shows the
   * prohibited list: a formulary that quietly omits it teaches a vaidya the
   * remedy does not exist, and one that refuses it teaches the register
   * boundary they are actually bound by.
   */
  async listMedicines(query: MedicineQuery): Promise<readonly AyushMedicineRow[]> {
    return this.guard(async (tx) => {
      const consultSystem =
        query.consultId === undefined ? null : (await this.consultWithin(tx, query.consultId)).system;

      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM mdm.ayush_medicines m
          WHERE (m.hospital_id IS NULL OR m.hospital_id = $1)
            AND m.active
            AND ($2::text IS NULL OR m.system::text = $2::text)
            AND ($3::text IS NULL OR m.name ILIKE '%' || $3::text || '%')
          ORDER BY m.system, m.name
          LIMIT $4`,
        [this.hospitalId(), query.system ?? null, query.q ?? null, query.limit],
      );
      return rows.map((x) => this.toMedicine(x, consultSystem));
    });
  }

  /** The two numbers the composer needs to show a ceiling rather than hit one. */
  async heavyMetalLimits(): Promise<{ readonly maxDays: number; readonly monitoringAfterDays: number }> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT specialty.rasa_max_days() AS max_days,
                specialty.rasa_monitoring_after_days() AS monitoring_after_days`,
      );
      const row = this.one(rows);
      return { maxDays: asNumber(row.max_days), monitoringAfterDays: asNumber(row.monitoring_after_days) };
    });
  }

  // ── Courses and therapy ───────────────────────────────────────────────────

  async listProcedures(system: string | undefined): Promise<readonly AyushProcedureRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM mdm.ayush_procedures p
          WHERE (p.hospital_id IS NULL OR p.hospital_id = $1)
            AND p.active
            AND ($2::text IS NULL OR p.system::text = $2::text)
          ORDER BY p.system, p.phase, p.name`,
        [this.hospitalId(), system ?? null],
      );
      return rows.map((r) => ({
        code: asText(r.code),
        system: asText(r.system),
        name: asText(r.name),
        phase: asText(r.phase),
        defaultDurationMin: asNumber(r.default_duration_min),
        roomType: asText(r.room_type),
        requiresConsent: asBool(r.requires_consent),
        genderMatchRequired: asBool(r.gender_match_required),
        invasive: asBool(r.invasive),
        contraindications: Array.isArray(r.contraindications) ? r.contraindications : [],
      }));
    });
  }

  async planCourse(body: CourseRequest): Promise<AyushCourseRow> {
    return this.guard(async (tx) => {
      const id = newId();
      await tx.query(
        `INSERT INTO specialty.ayush_courses
           (id, hospital_id, branch_id, patient_id, consult_id, admission_id, system, name,
            plan_days, start_date, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::specialty."AyushSystem",$8,$9::jsonb,$10::date,$11,now(),now())`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.patientId,
          body.consultId,
          body.admissionId ?? null,
          body.system,
          body.name,
          JSON.stringify(body.planDays),
          body.startDate,
          this.actorId(),
        ],
      );

      // The plan becomes scheduled sessions in the same transaction, because a
      // plan that has to be transcribed into a worklist by hand is a plan the
      // worklist eventually disagrees with.
      for (const day of body.planDays) {
        await tx.query(
          `INSERT INTO specialty.ayush_therapy_sessions
             (id, hospital_id, course_id, day_no, procedure_code, status, recorded_by,
              created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,'scheduled',$6,now(),now())
           ON CONFLICT (course_id, day_no, procedure_code) DO NOTHING`,
          [newId(), this.hospitalId(), id, day.day, day.code, this.actorId()],
        );
      }

      return this.courseWithin(tx, id);
    });
  }

  async updateCourse(id: string, body: CourseUpdateRequest): Promise<AyushCourseRow> {
    return this.guard(async (tx) => {
      await tx.query(
        `UPDATE specialty.ayush_courses
            SET consent_id   = coalesce($2::uuid, consent_id),
                status       = coalesce($3::specialty."AyushCourseStatus", status),
                end_date     = coalesce($4::date, end_date),
                abort_reason = coalesce($5, abort_reason),
                updated_at   = now()
          WHERE id = $1 AND hospital_id = $6`,
        [
          id,
          body.consentId ?? null,
          body.status ?? null,
          body.endDate ?? null,
          body.abortReason ?? null,
          this.hospitalId(),
        ],
      );
      return this.courseWithin(tx, id);
    });
  }

  async listCourses(query: CourseQuery): Promise<readonly AyushCourseRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `${COURSE_SELECT}
          WHERE c.hospital_id = $1
            AND ($2::uuid IS NULL OR c.patient_id = $2::uuid)
            AND ($3::boolean IS NOT TRUE OR c.status IN ('planned','consented','in_progress'))
          ORDER BY c.start_date DESC
          LIMIT $4`,
        [this.hospitalId(), query.patientId ?? null, query.openOnly, query.limit],
      );
      return rows.map((x) => this.toCourse(x));
    });
  }

  async scheduleSession(courseId: string, body: SessionScheduleRequest): Promise<AyushSessionRow> {
    return this.guard(async (tx) => {
      const id = newId();
      await tx.query(
        `INSERT INTO specialty.ayush_therapy_sessions
           (id, hospital_id, course_id, day_no, procedure_code, room_id, status, recorded_by,
            created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,'scheduled',$7,now(),now())`,
        [
          id,
          this.hospitalId(),
          courseId,
          body.dayNo,
          body.procedureCode,
          body.roomId ?? null,
          this.actorId(),
        ],
      );
      return this.sessionWithin(tx, id);
    });
  }

  async logSession(id: string, body: SessionLogRequest): Promise<AyushSessionRow> {
    return this.guard(async (tx) => {
      await tx.query(
        `UPDATE specialty.ayush_therapy_sessions
            SET therapist_ids     = $2::uuid[],
                therapist_genders = $3::varchar[],
                gender_waiver_consent_id = coalesce($4::uuid, gender_waiver_consent_id),
                prechecks       = $5::jsonb,
                medicines_used  = $6::jsonb,
                params          = $7::jsonb,
                lakshana        = $8::specialty."AyushLakshana",
                adverse_event   = $9,
                tolerance       = $10,
                post_advice     = $11,
                status          = 'done',
                performed_at    = $12::timestamptz,
                updated_at      = now()
          WHERE id = $1 AND hospital_id = $13`,
        [
          id,
          body.therapistIds,
          body.therapistGenders,
          body.genderWaiverConsentId ?? null,
          JSON.stringify(body.prechecks),
          JSON.stringify(body.medicinesUsed),
          JSON.stringify(body.params),
          body.lakshana ?? null,
          body.adverseEvent ?? null,
          body.tolerance ?? null,
          body.postAdvice ?? null,
          body.performedAt,
          this.hospitalId(),
        ],
      );
      const session = await this.sessionWithin(tx, id);

      // The stop is real: the next session is refused by the database, and
      // somebody has to know why the patient is waiting.
      if (body.adverseEvent !== undefined) {
        const course = await this.courseWithin(tx, session.courseId);
        await this.outbox.publish(
          tx,
          consoleEvent('ayush.therapy.adverse', id, {
            sessionId: id,
            courseId: session.courseId,
            patientId: course.patientId,
            dayNo: session.dayNo,
            procedureCode: session.procedureCode,
            adverseEvent: body.adverseEvent,
          }),
        );
      }

      return session;
    });
  }

  async skipSession(id: string, body: SessionSkipRequest): Promise<AyushSessionRow> {
    return this.guard(async (tx) => {
      await tx.query(
        `UPDATE specialty.ayush_therapy_sessions
            SET status = 'skipped', skip_reason = $2, updated_at = now()
          WHERE id = $1 AND hospital_id = $3`,
        [id, body.skipReason, this.hospitalId()],
      );
      return this.sessionWithin(tx, id);
    });
  }

  /** The review that restarts a stopped course. */
  async reviewSession(id: string, body: SessionReviewRequest): Promise<AyushSessionRow> {
    return this.guard(async (tx) => {
      await tx.query(
        `UPDATE specialty.ayush_therapy_sessions
            SET reviewed_by = $2, reviewed_at = now(), review_note = $3, updated_at = now()
          WHERE id = $1 AND hospital_id = $4`,
        [id, this.actorId(), body.reviewNote, this.hospitalId()],
      );
      const session = await this.sessionWithin(tx, id);
      const course = await this.courseWithin(tx, session.courseId);

      await this.audit.write(tx, {
        action: 'approve',
        entity: 'ayush_therapy_session',
        rowId: id,
        businessKey: session.procedureCode,
        dataClass: 'phi',
        patientId: course.patientId,
        encounterId: null,
        reasonText: body.reviewNote,
        before: { reviewedAt: null },
        after: { reviewedAt: session.reviewedAt },
      });

      return session;
    });
  }

  async listSessions(courseId: string): Promise<readonly AyushSessionRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `${SESSION_SELECT}
          WHERE s.course_id = $1 AND s.hospital_id = $2
          ORDER BY s.day_no, s.procedure_code`,
        [courseId, this.hospitalId()],
      );
      return rows.map((x) => this.toSession(x));
    });
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  private one(rows: readonly Record<string, unknown>[]): Record<string, unknown> {
    const row = rows[0];
    if (row === undefined) throw AppError.notFound('That record was not found.');
    return row;
  }

  private async registrationWithin(
    tx: TransactionClient,
    practitionerId: string,
    system: string,
  ): Promise<AyushRegistrationRow> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM specialty.ayush_registrations
        WHERE hospital_id = $1 AND practitioner_id = $2 AND system::text = $3::text`,
      [this.hospitalId(), practitionerId, system],
    );
    return this.toRegistration(this.one(rows));
  }

  private async consultWithin(tx: TransactionClient, id: string): Promise<AyushConsultRow> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `${CONSULT_SELECT} WHERE c.id = $1 AND c.hospital_id = $2`,
      [id, this.hospitalId()],
    );
    return this.toConsult(this.one(rows));
  }

  private async lineWithin(tx: TransactionClient, id: string): Promise<AyushPrescriptionLineRow> {
    const { rows } = await tx.query<Record<string, unknown>>(`${LINE_SELECT} WHERE l.id = $1`, [id]);
    return this.toLine(this.one(rows));
  }

  private async courseWithin(tx: TransactionClient, id: string): Promise<AyushCourseRow> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `${COURSE_SELECT} WHERE c.id = $1 AND c.hospital_id = $2`,
      [id, this.hospitalId()],
    );
    return this.toCourse(this.one(rows));
  }

  private async sessionWithin(tx: TransactionClient, id: string): Promise<AyushSessionRow> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `${SESSION_SELECT} WHERE s.id = $1 AND s.hospital_id = $2`,
      [id, this.hospitalId()],
    );
    return this.toSession(this.one(rows));
  }

  private toRegistration(r: Record<string, unknown>): AyushRegistrationRow {
    const validTo = asTextOrNull(r.valid_to);
    const validFrom = asText(r.valid_from);
    const now = Date.now();
    const started = new Date(validFrom).getTime() <= now;
    const days = validTo === null ? null : Math.round((new Date(validTo).getTime() - now) / 86_400_000);
    return {
      id: asText(r.id),
      practitionerId: asText(r.practitioner_id),
      system: asText(r.system),
      council: asText(r.council),
      registrationNo: asText(r.registration_no),
      validFrom,
      validTo,
      // A lapsed registration is not a registration, so this is the same
      // predicate the trigger uses rather than a friendlier one.
      live: started && (days === null || days >= 0),
      daysRemaining: days,
    };
  }

  private toConsult(r: Record<string, unknown>): AyushConsultRow {
    const diagnoses = Array.isArray(r.diagnoses) ? (r.diagnoses as Record<string, unknown>[]) : [];
    const signedAt = asTextOrNull(r.signed_at);

    const blockedBy: string[] = [];
    if (signedAt === null) {
      const coded = diagnoses.some((d) => typeof d.namasteCode === 'string' && d.namasteCode.trim() !== '');
      if (!coded) blockedBy.push('no NAMASTE-coded diagnosis is recorded');
    }

    return {
      id: asText(r.id),
      patientId: asText(r.patient_id),
      encounterId: asTextOrNull(r.encounter_id),
      practitionerId: asText(r.practitioner_id),
      system: asText(r.system),
      assessment: asJson(r.assessment),
      diagnoses,
      plan: asJson(r.plan),
      pathyaApathya: asJson(r.pathya_apathya),
      lifestyle: asJson(r.lifestyle),
      notes: asTextOrNull(r.notes),
      signedBy: asTextOrNull(r.signed_by),
      signedAt,
      prescriptionLines: asNumber(r.line_count),
      blockedBy,
    };
  }

  private toLine(r: Record<string, unknown>): AyushPrescriptionLineRow {
    return {
      id: asText(r.id),
      consultId: asText(r.consult_id),
      medicineId: asText(r.medicine_id),
      medicineName: asText(r.medicine_name),
      form: asTextOrNull(r.form),
      dose: asText(r.dose),
      unit: asText(r.unit),
      anupana: asTextOrNull(r.anupana),
      kala: asTextOrNull(r.kala),
      potency: asTextOrNull(r.potency),
      scale: asTextOrNull(r.scale),
      repetition: asTextOrNull(r.repetition),
      durationDays: asNumber(r.duration_days),
      scheduleE1: asBool(r.schedule_e1),
      heavyMetal: asBool(r.heavy_metal),
      monitoringOrderId: asTextOrNull(r.monitoring_order_id),
      monitoringDueAt: asTextOrNull(r.monitoring_due_at),
    };
  }

  private toMedicine(r: Record<string, unknown>, consultSystem: string | null): AyushMedicineRow {
    const system = asText(r.system);
    // The register boundary, read forwards. Returned marked rather than
    // filtered out, so a vaidya learns why the remedy is out of reach instead
    // of concluding it does not exist.
    const reason =
      consultSystem === null || consultSystem === system
        ? null
        : `${system} is a different register — a registration in one system is not a licence in another`;

    return {
      id: asText(r.id),
      system,
      code: asText(r.code),
      name: asText(r.name),
      type: asText(r.type),
      form: asTextOrNull(r.form),
      manufacturer: asTextOrNull(r.manufacturer),
      scheduleE1: asBool(r.schedule_e1),
      heavyMetal: asBool(r.heavy_metal),
      contraindications: Array.isArray(r.contraindications) ? r.contraindications : [],
      reachable: reason === null,
      reason,
    };
  }

  private toCourse(r: Record<string, unknown>): AyushCourseRow {
    const consentId = asTextOrNull(r.consent_id);
    const oleated = r.oleated === true;
    const unreviewed = asTextOrNull(r.unreviewed_procedure);

    // The same facts the trigger checks, said before the therapist brings the
    // patient in and undresses them.
    const blockedBy: string[] = [];
    if (!oleated) {
      blockedBy.push('no completed purvakarma session records samyak snigdha lakshana');
    }
    if (consentId === null) blockedBy.push('the course has no recorded consent');
    if (unreviewed !== null) {
      blockedBy.push(`day ${asText(r.unreviewed_day)} (${unreviewed}) has an unreviewed adverse event`);
    }

    return {
      id: asText(r.id),
      patientId: asText(r.patient_id),
      consultId: asText(r.consult_id),
      admissionId: asTextOrNull(r.admission_id),
      system: asText(r.system),
      name: asText(r.name),
      planDays: Array.isArray(r.plan_days) ? (r.plan_days as Record<string, unknown>[]) : [],
      consentId,
      status: asText(r.status),
      startDate: asText(r.start_date),
      endDate: asTextOrNull(r.end_date),
      abortReason: asTextOrNull(r.abort_reason),
      sessionsDone: asNumber(r.sessions_done),
      sessionsPlanned: asNumber(r.sessions_planned),
      readyForPradhana: blockedBy.length === 0,
      blockedBy,
    };
  }

  private toSession(r: Record<string, unknown>): AyushSessionRow {
    return {
      id: asText(r.id),
      courseId: asText(r.course_id),
      dayNo: asNumber(r.day_no),
      procedureCode: asText(r.procedure_code),
      procedureName: asTextOrNull(r.procedure_name),
      phase: asTextOrNull(r.phase),
      roomId: asTextOrNull(r.room_id),
      therapistIds: asStringArray(r.therapist_ids),
      therapistGenders: asStringArray(r.therapist_genders),
      genderWaiverConsentId: asTextOrNull(r.gender_waiver_consent_id),
      prechecks: asJson(r.prechecks),
      medicinesUsed: Array.isArray(r.medicines_used) ? r.medicines_used : [],
      params: asJson(r.params),
      lakshana: asTextOrNull(r.lakshana),
      adverseEvent: asTextOrNull(r.adverse_event),
      reviewedBy: asTextOrNull(r.reviewed_by),
      reviewedAt: asTextOrNull(r.reviewed_at),
      reviewNote: asTextOrNull(r.review_note),
      tolerance: asTextOrNull(r.tolerance),
      postAdvice: asTextOrNull(r.post_advice),
      skipReason: asTextOrNull(r.skip_reason),
      status: asText(r.status),
      performedAt: asTextOrNull(r.performed_at),
      // An adverse event nobody has reviewed is what the whole course is
      // waiting on, which is worth saying on the row itself.
      blocksCourse: asTextOrNull(r.adverse_event) !== null && asTextOrNull(r.reviewed_at) === null,
    };
  }
}

const CONSULT_SELECT = `
  SELECT c.*,
         (SELECT count(*) FROM specialty.ayush_prescription_lines l WHERE l.consult_id = c.id)
           AS line_count
    FROM specialty.ayush_consults c`;

const LINE_SELECT = `
  SELECT l.*, m.name AS medicine_name, m.form
    FROM specialty.ayush_prescription_lines l
    JOIN mdm.ayush_medicines m ON m.id = l.medicine_id`;

const COURSE_SELECT = `
  SELECT c.*,
         (SELECT count(*) FROM specialty.ayush_therapy_sessions s
           WHERE s.course_id = c.id AND s.status = 'done') AS sessions_done,
         (SELECT count(*) FROM specialty.ayush_therapy_sessions s
           WHERE s.course_id = c.id) AS sessions_planned,
         EXISTS (SELECT 1 FROM specialty.ayush_therapy_sessions s
                  WHERE s.course_id = c.id AND s.status = 'done'
                    AND s.phase = 'purva' AND s.lakshana = 'samyak') AS oleated,
         (SELECT s.procedure_code FROM specialty.ayush_therapy_sessions s
           WHERE s.course_id = c.id AND s.adverse_event IS NOT NULL AND s.reviewed_at IS NULL
           ORDER BY s.day_no LIMIT 1) AS unreviewed_procedure,
         (SELECT s.day_no FROM specialty.ayush_therapy_sessions s
           WHERE s.course_id = c.id AND s.adverse_event IS NOT NULL AND s.reviewed_at IS NULL
           ORDER BY s.day_no LIMIT 1) AS unreviewed_day
    FROM specialty.ayush_courses c`;

const SESSION_SELECT = `
  SELECT s.*, p.name AS procedure_name
    FROM specialty.ayush_therapy_sessions s
    LEFT JOIN mdm.ayush_procedures p
      ON p.code = s.procedure_code
     AND (p.hospital_id IS NULL OR p.hospital_id = s.hospital_id)`;
