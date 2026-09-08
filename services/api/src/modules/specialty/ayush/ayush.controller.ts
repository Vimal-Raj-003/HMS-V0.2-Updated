import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { AyushService } from './ayush.service.js';
import {
  consultQuerySchema,
  consultSchema,
  consultSignSchema,
  consultUpdateSchema,
  courseQuerySchema,
  courseSchema,
  courseUpdateSchema,
  medicineQuerySchema,
  medicineSchema,
  prescriptionSchema,
  registrationQuerySchema,
  registrationSchema,
  sessionLogSchema,
  sessionReviewSchema,
  sessionScheduleSchema,
  sessionSkipSchema,
  type ConsultQuery,
  type ConsultRequest,
  type ConsultSignRequest,
  type ConsultUpdateRequest,
  type CourseQuery,
  type CourseRequest,
  type CourseUpdateRequest,
  type MedicineQuery,
  type MedicineRequest,
  type PrescriptionRequest,
  type RegistrationQuery,
  type RegistrationRequest,
  type SessionLogRequest,
  type SessionReviewRequest,
  type SessionScheduleRequest,
  type SessionSkipRequest,
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
 * `/api/v1/ayush/*` — OP-037.
 *
 * ── No route prescribes outside a registration ─────────────────────────────
 *
 * There is no cross-system route, no waive and no override. The councils keep
 * separate registers and a registration in one system is not a licence in
 * another; the boundary is a row with validity dates that a trigger reads, and
 * the honest way to hold a statutory boundary is to have no shape that
 * expresses an exception to it.
 *
 * ── None that skips the oleation ───────────────────────────────────────────
 *
 * A pradhana karma needs a completed purvakarma session recording samyak
 * lakshana. There is no route that says otherwise, because the failure mode is
 * a death and the temptation is a busy Thursday.
 *
 * ── And none that overrides a gender match ─────────────────────────────────
 *
 * The exception is `genderWaiverConsentId` on the log — the patient's own
 * recorded choice. An administrator holding an override would be exactly the
 * wrong person holding it.
 */
@Controller()
export class AyushController {
  constructor(@Inject(AyushService) private readonly svc: AyushService) {}

  // ── Registrations ─────────────────────────────────────────────────────────

  /** Reasoned: this is what stands between a patient and an unregistered practitioner. */
  @Permission('ayush.registration.manage')
  @Idempotent()
  @Post('ayush/registrations')
  async recordRegistration(
    @Body(new ZodBody(registrationSchema)) body: RegistrationRequest,
  ): Promise<AyushRegistrationRow> {
    return this.svc.recordRegistration(body);
  }

  @Permission('ayush.read')
  @Get('ayush/registrations')
  async listRegistrations(
    @Query(new ZodBody(registrationQuerySchema)) query: RegistrationQuery,
  ): Promise<readonly AyushRegistrationRow[]> {
    return this.svc.listRegistrations(query);
  }

  // ── Consultations ─────────────────────────────────────────────────────────

  @Permission('ayush.consult.record')
  @Idempotent()
  @Post('ayush/consults')
  async openConsult(@Body(new ZodBody(consultSchema)) body: ConsultRequest): Promise<AyushConsultRow> {
    return this.svc.openConsult(body);
  }

  @Permission('ayush.consult.record')
  @Post('ayush/consults/:id')
  async updateConsult(
    @Param('id') id: string,
    @Body(new ZodBody(consultUpdateSchema)) body: ConsultUpdateRequest,
  ): Promise<AyushConsultRow> {
    return this.svc.updateConsult(id, body);
  }

  @Permission('ayush.consult.sign')
  @Post('ayush/consults/:id/sign')
  async signConsult(
    @Param('id') id: string,
    @Body(new ZodBody(consultSignSchema)) body: ConsultSignRequest,
  ): Promise<AyushConsultRow> {
    return this.svc.signConsult(id, body);
  }

  @Permission('ayush.read')
  @Get('ayush/consults')
  async listConsults(
    @Query(new ZodBody(consultQuerySchema)) query: ConsultQuery,
  ): Promise<readonly AyushConsultRow[]> {
    return this.svc.listConsults(query);
  }

  // ── Prescribing ───────────────────────────────────────────────────────────

  @Permission('ayush.rx.create')
  @Idempotent()
  @Post('ayush/consults/:id/prescriptions')
  async prescribe(
    @Param('id') id: string,
    @Body(new ZodBody(prescriptionSchema)) body: PrescriptionRequest,
  ): Promise<AyushPrescriptionLineRow> {
    return this.svc.prescribe(id, body);
  }

  @Permission('ayush.read')
  @Get('ayush/consults/:id/prescriptions')
  async listPrescriptions(@Param('id') id: string): Promise<readonly AyushPrescriptionLineRow[]> {
    return this.svc.listPrescriptions(id);
  }

  /**
   * The formulary, read against a consultation. Medicines from another system
   * come back marked unreachable rather than filtered out, so a vaidya learns
   * the register boundary instead of concluding the remedy does not exist.
   */
  @Permission('ayush.read')
  @Get('ayush/medicines')
  async listMedicines(
    @Query(new ZodBody(medicineQuerySchema)) query: MedicineQuery,
  ): Promise<readonly AyushMedicineRow[]> {
    return this.svc.listMedicines(query);
  }

  @Permission('ayush.formulary.manage')
  @Idempotent()
  @Post('ayush/medicines')
  async addMedicine(@Body(new ZodBody(medicineSchema)) body: MedicineRequest): Promise<AyushMedicineRow> {
    return this.svc.addMedicine(body);
  }

  /** The ceiling and the monitoring threshold, so the composer shows them. */
  @Permission('ayush.read')
  @Get('ayush/heavy-metal-limits')
  async heavyMetalLimits(): Promise<{ readonly maxDays: number; readonly monitoringAfterDays: number }> {
    return this.svc.heavyMetalLimits();
  }

  // ── Courses and therapy ───────────────────────────────────────────────────

  @Permission('ayush.read')
  @Get('ayush/procedures')
  async listProcedures(@Query('system') system?: string): Promise<readonly AyushProcedureRow[]> {
    return this.svc.listProcedures(system);
  }

  @Permission('ayush.course.plan')
  @Idempotent()
  @Post('ayush/courses')
  async planCourse(@Body(new ZodBody(courseSchema)) body: CourseRequest): Promise<AyushCourseRow> {
    return this.svc.planCourse(body);
  }

  @Permission('ayush.course.plan')
  @Post('ayush/courses/:id')
  async updateCourse(
    @Param('id') id: string,
    @Body(new ZodBody(courseUpdateSchema)) body: CourseUpdateRequest,
  ): Promise<AyushCourseRow> {
    return this.svc.updateCourse(id, body);
  }

  @Permission('ayush.read')
  @Get('ayush/courses')
  async listCourses(
    @Query(new ZodBody(courseQuerySchema)) query: CourseQuery,
  ): Promise<readonly AyushCourseRow[]> {
    return this.svc.listCourses(query);
  }

  @Permission('ayush.course.plan')
  @Post('ayush/courses/:id/sessions')
  async scheduleSession(
    @Param('id') id: string,
    @Body(new ZodBody(sessionScheduleSchema)) body: SessionScheduleRequest,
  ): Promise<AyushSessionRow> {
    return this.svc.scheduleSession(id, body);
  }

  @Permission('ayush.read')
  @Get('ayush/courses/:id/sessions')
  async listSessions(@Param('id') id: string): Promise<readonly AyushSessionRow[]> {
    return this.svc.listSessions(id);
  }

  @Permission('ayush.therapy.record')
  @Post('ayush/sessions/:id/log')
  async logSession(
    @Param('id') id: string,
    @Body(new ZodBody(sessionLogSchema)) body: SessionLogRequest,
  ): Promise<AyushSessionRow> {
    return this.svc.logSession(id, body);
  }

  @Permission('ayush.therapy.record')
  @Post('ayush/sessions/:id/skip')
  async skipSession(
    @Param('id') id: string,
    @Body(new ZodBody(sessionSkipSchema)) body: SessionSkipRequest,
  ): Promise<AyushSessionRow> {
    return this.svc.skipSession(id, body);
  }

  /** The review that restarts a course the database has stopped. */
  @Permission('ayush.therapy.review')
  @Post('ayush/sessions/:id/review')
  async reviewSession(
    @Param('id') id: string,
    @Body(new ZodBody(sessionReviewSchema)) body: SessionReviewRequest,
  ): Promise<AyushSessionRow> {
    return this.svc.reviewSession(id, body);
  }
}
