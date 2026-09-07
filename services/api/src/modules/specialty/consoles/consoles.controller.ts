import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { CardiologyService } from './cardiology.service.js';
import { DentalService } from './dental.service.js';
import { DermatologyService } from './dermatology.service.js';
import { EntService } from './ent.service.js';
import { PulmonologyService } from './pulmonology.service.js';
import {
  anticoagEnrolSchema,
  audiologyResultSchema,
  audiologyTestSchema,
  biopsyResultSchema,
  biopsySchema,
  cardioConsultSchema,
  dentalAcceptSchema,
  dentalPlanSchema,
  dentalPresentSchema,
  dentalSupersedeSchema,
  dentalSittingSchema,
  dermScoreSchema,
  echoReportSchema,
  ecgAcknowledgeSchema,
  ecgQuerySchema,
  ecgReadSchema,
  ecgRecordSchema,
  entExamSchema,
  hearingAidSchema,
  inrVisitSchema,
  lesionObservationSchema,
  lesionSchema,
  openQuerySchema,
  papComplianceSchema,
  papRxSchema,
  patientQuerySchema,
  pftInterpretSchema,
  pftStudySchema,
  phototherapyCourseSchema,
  phototherapySessionSchema,
  pulmoConsultSchema,
  raiseCeilingSchema,
  sleepScoreSchema,
  sleepStudySchema,
  stressTestSchema,
  thresholdBatchSchema,
  toothEventSchema,
  type AnticoagEnrolRequest,
  type AudiologyResultRequest,
  type AudiologyTestRequest,
  type BiopsyRequest,
  type BiopsyResultRequest,
  type CardioConsultRequest,
  type DentalAcceptRequest,
  type DentalPlanRequest,
  type DentalPresentRequest,
  type DentalSupersedeRequest,
  type DentalSittingRequest,
  type DermScoreRequest,
  type EcgAcknowledgeRequest,
  type EcgQuery,
  type EcgReadRequest,
  type EcgRecordRequest,
  type EchoReportRequest,
  type EntExamRequest,
  type HearingAidRequest,
  type InrVisitRequest,
  type LesionObservationRequest,
  type LesionRequest,
  type OpenQuery,
  type PapComplianceRequest,
  type PapRxRequest,
  type PatientQuery,
  type PftInterpretRequest,
  type PftStudyRequest,
  type PhototherapyCourseRequest,
  type PhototherapySessionRequest,
  type PulmoConsultRequest,
  type RaiseCeilingRequest,
  type SleepScoreRequest,
  type SleepStudyRequest,
  type StressTestRequest,
  type ThresholdBatchRequest,
  type ToothEventRequest,
} from './consoles.schemas.js';
import type {
  AnticoagRow,
  AudiologyTestDetail,
  AudiologyTestRow,
  BiopsyRow,
  CardioConsultRow,
  DentalChartDetail,
  DentalPlanRow,
  DentalSittingRow,
  DermScoreRow,
  EchoRow,
  EcgRow,
  EntExamRow,
  HearingAidRow,
  InrVisitRow,
  LesionObservationRow,
  LesionRow,
  PapRxRow,
  PftRow,
  PhototherapyCourseRow,
  PhototherapySessionRow,
  PulmoConsultRow,
  SleepStudyRow,
  StressTestRow,
} from './consoles.types.js';

/**
 * `/api/v1/{cardio,pulmo,ent,dental,derm}/*` — OP-029, OP-030, OP-028, OP-026,
 * OP-027.
 *
 * ── There is no route here that orders an investigation ─────────────────────
 *
 * An ECG, a spirometry trace, an audiogram, an OPG and a dermoscopy image are
 * all ordered through `POST /specialty/device-orders` and come back through the
 * framework's one attachment route. Five consoles with five upload endpoints is
 * what `phase-08` calls a defect, and the way to keep it from happening is for
 * none of them to have a route somebody could later add a flag to.
 *
 * ── There is no route here that sets a derived number ───────────────────────
 *
 * No `PATCH …/qtc`, no `PATCH …/pta`, no `PUT …/chart`. The chart in particular
 * has a read route and no write route at all, and the application role holds no
 * privilege on the table behind it — the write is a tooth event, and the chart
 * follows.
 *
 * ── Three routes are the documented way past a rule ─────────────────────────
 *
 * `POST …/ecgs/:id/acknowledge`, `POST …/plans/:id/supersede` and
 * `POST …/courses/:id/ceiling` each sit behind their own permission. Two of
 * them demand a reason. They exist so that the exception has a name and an
 * audit row, rather than the rule having a hole.
 */
@Controller()
export class ConsolesController {
  constructor(
    @Inject(CardiologyService) private readonly cardio: CardiologyService,
    @Inject(PulmonologyService) private readonly pulmo: PulmonologyService,
    @Inject(EntService) private readonly ent: EntService,
    @Inject(DentalService) private readonly dental: DentalService,
    @Inject(DermatologyService) private readonly derm: DermatologyService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // OP-029 · Cardiology
  // ═══════════════════════════════════════════════════════════════════════════

  @Permission('cardio.consult.record')
  @Idempotent()
  @Post('cardio/consults')
  async recordCardioConsult(
    @Body(new ZodBody(cardioConsultSchema)) body: CardioConsultRequest,
  ): Promise<CardioConsultRow> {
    return this.cardio.recordConsult(body);
  }

  @Permission('cardio.consult.sign')
  @Post('cardio/consults/:id/sign')
  async signCardioConsult(@Param('id') id: string): Promise<CardioConsultRow> {
    return this.cardio.signConsult(id);
  }

  @Permission('cardio.ecg.record')
  @Idempotent()
  @Post('cardio/ecgs')
  async recordEcg(@Body(new ZodBody(ecgRecordSchema)) body: EcgRecordRequest): Promise<EcgRow> {
    return this.cardio.recordEcg(body);
  }

  @Permission('cardio.ecg.read')
  @Get('cardio/ecgs')
  async listEcgs(@Query(new ZodBody(ecgQuerySchema)) query: EcgQuery): Promise<readonly EcgRow[]> {
    return this.cardio.listEcgs(query);
  }

  @Permission('cardio.ecg.interpret')
  @Post('cardio/ecgs/:id/read')
  async readEcg(
    @Param('id') id: string,
    @Body(new ZodBody(ecgReadSchema)) body: EcgReadRequest,
  ): Promise<EcgRow> {
    return this.cardio.readEcg(id, body);
  }

  /** The handover. The actor comes from the session, never the body. */
  @Permission('cardio.ecg.acknowledge_critical')
  @Post('cardio/ecgs/:id/acknowledge')
  async acknowledgeEcg(
    @Param('id') id: string,
    @Body(new ZodBody(ecgAcknowledgeSchema)) body: EcgAcknowledgeRequest,
  ): Promise<EcgRow> {
    return this.cardio.acknowledgeCritical(id, body);
  }

  @Permission('cardio.echo.report')
  @Idempotent()
  @Post('cardio/echoes')
  async recordEcho(@Body(new ZodBody(echoReportSchema)) body: EchoReportRequest): Promise<EchoRow> {
    return this.cardio.recordEcho(body);
  }

  @Permission('cardio.echo.sign')
  @Post('cardio/echoes/:id/sign')
  async signEcho(@Param('id') id: string): Promise<EchoRow> {
    return this.cardio.signEcho(id);
  }

  @Permission('cardio.stress.conduct')
  @Idempotent()
  @Post('cardio/stress-tests')
  async recordStressTest(
    @Body(new ZodBody(stressTestSchema)) body: StressTestRequest,
  ): Promise<StressTestRow> {
    return this.cardio.recordStressTest(body);
  }

  @Permission('cardio.anticoag.manage')
  @Idempotent()
  @Post('cardio/anticoagulation')
  async enrolAnticoag(
    @Body(new ZodBody(anticoagEnrolSchema)) body: AnticoagEnrolRequest,
  ): Promise<AnticoagRow> {
    return this.cardio.enrolAnticoag(body);
  }

  @Permission('cardio.anticoag.manage')
  @Idempotent()
  @Post('cardio/anticoagulation/:id/visits')
  async recordInrVisit(
    @Param('id') id: string,
    @Body(new ZodBody(inrVisitSchema)) body: InrVisitRequest,
  ): Promise<InrVisitRow> {
    return this.cardio.recordInrVisit(id, body);
  }

  @Permission('cardio.anticoag.manage')
  @Get('cardio/anticoagulation/:id/visits')
  async listInrVisits(@Param('id') id: string): Promise<readonly InrVisitRow[]> {
    return this.cardio.listInrVisits(id);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // OP-030 · Pulmonology
  // ═══════════════════════════════════════════════════════════════════════════

  @Permission('pulmo.consult.record')
  @Idempotent()
  @Post('pulmo/consults')
  async recordPulmoConsult(
    @Body(new ZodBody(pulmoConsultSchema)) body: PulmoConsultRequest,
  ): Promise<PulmoConsultRow> {
    return this.pulmo.recordConsult(body);
  }

  @Permission('pulmo.consult.sign')
  @Post('pulmo/consults/:id/sign')
  async signPulmoConsult(@Param('id') id: string): Promise<PulmoConsultRow> {
    return this.pulmo.signConsult(id);
  }

  @Permission('pulmo.pft.perform')
  @Idempotent()
  @Post('pulmo/pft')
  async recordPft(@Body(new ZodBody(pftStudySchema)) body: PftStudyRequest): Promise<PftRow> {
    return this.pulmo.recordPft(body);
  }

  @Permission('pulmo.pft.perform')
  @Get('pulmo/pft')
  async listPfts(@Query(new ZodBody(patientQuerySchema)) query: PatientQuery): Promise<readonly PftRow[]> {
    return this.pulmo.listPfts(query);
  }

  @Permission('pulmo.pft.interpret')
  @Post('pulmo/pft/:id/interpret')
  async interpretPft(
    @Param('id') id: string,
    @Body(new ZodBody(pftInterpretSchema)) body: PftInterpretRequest,
  ): Promise<PftRow> {
    return this.pulmo.interpretPft(id, body);
  }

  @Permission('pulmo.sleep.score')
  @Idempotent()
  @Post('pulmo/sleep-studies')
  async scheduleSleepStudy(
    @Body(new ZodBody(sleepStudySchema)) body: SleepStudyRequest,
  ): Promise<SleepStudyRow> {
    return this.pulmo.scheduleSleepStudy(body);
  }

  @Permission('pulmo.sleep.score')
  @Get('pulmo/sleep-studies')
  async listSleepStudies(
    @Query(new ZodBody(openQuerySchema)) query: OpenQuery,
  ): Promise<readonly SleepStudyRow[]> {
    return this.pulmo.listSleepStudies(query);
  }

  @Permission('pulmo.sleep.score')
  @Post('pulmo/sleep-studies/:id/score')
  async scoreSleepStudy(
    @Param('id') id: string,
    @Body(new ZodBody(sleepScoreSchema)) body: SleepScoreRequest,
  ): Promise<SleepStudyRow> {
    return this.pulmo.scoreSleepStudy(id, body);
  }

  @Permission('pulmo.sleep.sign')
  @Post('pulmo/sleep-studies/:id/sign')
  async signSleepStudy(@Param('id') id: string): Promise<SleepStudyRow> {
    return this.pulmo.signSleepStudy(id);
  }

  @Permission('pulmo.pap.prescribe')
  @Idempotent()
  @Post('pulmo/pap')
  async prescribePap(@Body(new ZodBody(papRxSchema)) body: PapRxRequest): Promise<PapRxRow> {
    return this.pulmo.prescribePap(body);
  }

  @Permission('pulmo.pap.review_compliance')
  @Get('pulmo/pap')
  async listPapRx(@Query(new ZodBody(patientQuerySchema)) query: PatientQuery): Promise<readonly PapRxRow[]> {
    return this.pulmo.listPapRx(query);
  }

  @Permission('pulmo.pap.review_compliance')
  @Post('pulmo/pap/:id/compliance')
  async recordCompliance(
    @Param('id') id: string,
    @Body(new ZodBody(papComplianceSchema)) body: PapComplianceRequest,
  ): Promise<PapRxRow> {
    return this.pulmo.recordCompliance(id, body);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // OP-028 · ENT and audiology
  // ═══════════════════════════════════════════════════════════════════════════

  @Permission('ent.exam.record')
  @Idempotent()
  @Post('ent/exams')
  async recordEntExam(@Body(new ZodBody(entExamSchema)) body: EntExamRequest): Promise<EntExamRow> {
    return this.ent.recordExam(body);
  }

  @Permission('ent.exam.sign')
  @Post('ent/exams/:id/sign')
  async signEntExam(@Param('id') id: string): Promise<EntExamRow> {
    return this.ent.signExam(id);
  }

  @Permission('ent.audiology.perform')
  @Idempotent()
  @Post('ent/audiology')
  async openAudiologyTest(
    @Body(new ZodBody(audiologyTestSchema)) body: AudiologyTestRequest,
  ): Promise<AudiologyTestRow> {
    return this.ent.openTest(body);
  }

  @Permission('ent.audiology.read')
  @Get('ent/audiology')
  async listAudiologyTests(
    @Query(new ZodBody(openQuerySchema)) query: OpenQuery,
  ): Promise<readonly AudiologyTestRow[]> {
    return this.ent.listTests(query);
  }

  @Permission('ent.audiology.read')
  @Get('ent/audiology/:id')
  async audiologyDetail(@Param('id') id: string): Promise<AudiologyTestDetail> {
    return this.ent.testDetail(id);
  }

  @Permission('ent.audiology.perform')
  @Post('ent/audiology/:id/thresholds')
  async recordThresholds(
    @Param('id') id: string,
    @Body(new ZodBody(thresholdBatchSchema)) body: ThresholdBatchRequest,
  ): Promise<AudiologyTestDetail> {
    return this.ent.recordThresholds(id, body);
  }

  @Permission('ent.audiology.perform')
  @Post('ent/audiology/:id/results')
  async recordAudiologyResult(
    @Param('id') id: string,
    @Body(new ZodBody(audiologyResultSchema)) body: AudiologyResultRequest,
  ): Promise<AudiologyTestDetail> {
    return this.ent.recordResult(id, body);
  }

  @Permission('ent.audiology.sign')
  @Post('ent/audiology/:id/sign')
  async signAudiologyTest(@Param('id') id: string): Promise<AudiologyTestDetail> {
    return this.ent.signTest(id);
  }

  @Permission('ent.hearing_aid.dispense')
  @Idempotent()
  @Post('ent/hearing-aids')
  async recordHearingAid(
    @Body(new ZodBody(hearingAidSchema)) body: HearingAidRequest,
  ): Promise<HearingAidRow> {
    return this.ent.recordHearingAid(body);
  }

  @Permission('ent.hearing_aid.dispense')
  @Get('ent/hearing-aids')
  async listHearingAids(
    @Query(new ZodBody(patientQuerySchema)) query: PatientQuery,
  ): Promise<readonly HearingAidRow[]> {
    return this.ent.listHearingAids(query);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // OP-026 · Dental
  // ═══════════════════════════════════════════════════════════════════════════

  /** The only write to the chart. The snapshot follows; it is never sent. */
  @Permission('dental.chart.record')
  @Idempotent()
  @Post('dental/tooth-events')
  async recordToothEvent(
    @Body(new ZodBody(toothEventSchema)) body: ToothEventRequest,
  ): Promise<DentalChartDetail> {
    return this.dental.recordToothEvent(body);
  }

  @Permission('dental.chart.read')
  @Get('dental/charts/:patientId')
  async dentalChart(@Param('patientId') patientId: string): Promise<DentalChartDetail> {
    return this.dental.chart(patientId);
  }

  @Permission('dental.plan.create')
  @Idempotent()
  @Post('dental/plans')
  async createDentalPlan(
    @Body(new ZodBody(dentalPlanSchema)) body: DentalPlanRequest,
  ): Promise<DentalPlanRow> {
    return this.dental.createPlan(body);
  }

  @Permission('dental.plan.create')
  @Get('dental/plans')
  async listDentalPlans(
    @Query(new ZodBody(openQuerySchema)) query: OpenQuery,
  ): Promise<readonly DentalPlanRow[]> {
    return this.dental.listPlans(query);
  }

  @Permission('dental.plan.present')
  @Post('dental/plans/:id/present')
  async presentDentalPlan(
    @Param('id') id: string,
    @Body(new ZodBody(dentalPresentSchema)) body: DentalPresentRequest,
  ): Promise<DentalPlanRow> {
    return this.dental.presentPlan(id, body);
  }

  @Permission('dental.plan.present')
  @Post('dental/plans/:id/accept')
  async acceptDentalPlan(
    @Param('id') id: string,
    @Body(new ZodBody(dentalAcceptSchema)) body: DentalAcceptRequest,
  ): Promise<DentalPlanRow> {
    return this.dental.acceptPlan(id, body);
  }

  /**
   * The documented way past the immutable price.
   *
   * It does not edit the accepted plan — the trigger refuses that — it cancels
   * it and drafts a replacement that has to be presented and signed again.
   */
  @Permission('dental.plan.supersede')
  @Post('dental/plans/:id/supersede')
  async supersedeDentalPlan(
    @Param('id') id: string,
    @Body(new ZodBody(dentalSupersedeSchema)) body: DentalSupersedeRequest,
  ): Promise<DentalPlanRow> {
    return this.dental.supersedePlan(id, body, body.reason);
  }

  @Permission('dental.sitting.record')
  @Idempotent()
  @Post('dental/sittings')
  async recordDentalSitting(
    @Body(new ZodBody(dentalSittingSchema)) body: DentalSittingRequest,
  ): Promise<DentalSittingRow> {
    return this.dental.recordSitting(body);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // OP-027 · Dermatology
  // ═══════════════════════════════════════════════════════════════════════════

  @Permission('derm.lesion.record')
  @Idempotent()
  @Post('derm/lesions')
  async createLesion(@Body(new ZodBody(lesionSchema)) body: LesionRequest): Promise<LesionRow> {
    return this.derm.createLesion(body);
  }

  @Permission('derm.lesion.read')
  @Get('derm/lesions')
  async listLesions(@Query(new ZodBody(openQuerySchema)) query: OpenQuery): Promise<readonly LesionRow[]> {
    return this.derm.listLesions(query);
  }

  @Permission('derm.lesion.record')
  @Post('derm/lesions/:id/observations')
  async observeLesion(
    @Param('id') id: string,
    @Body(new ZodBody(lesionObservationSchema)) body: LesionObservationRequest,
  ): Promise<LesionObservationRow> {
    return this.derm.observeLesion(id, body);
  }

  @Permission('derm.score.record')
  @Idempotent()
  @Post('derm/scores')
  async recordDermScore(@Body(new ZodBody(dermScoreSchema)) body: DermScoreRequest): Promise<DermScoreRow> {
    return this.derm.recordScore(body);
  }

  @Permission('derm.score.record')
  @Get('derm/scores')
  async listDermScores(
    @Query(new ZodBody(patientQuerySchema)) query: PatientQuery,
  ): Promise<readonly DermScoreRow[]> {
    return this.derm.listScores(query);
  }

  @Permission('derm.biopsy.manage')
  @Idempotent()
  @Post('derm/biopsies')
  async sendBiopsy(@Body(new ZodBody(biopsySchema)) body: BiopsyRequest): Promise<BiopsyRow> {
    return this.derm.sendBiopsy(body);
  }

  @Permission('derm.biopsy.manage')
  @Get('derm/biopsies')
  async listBiopsies(@Query(new ZodBody(openQuerySchema)) query: OpenQuery): Promise<readonly BiopsyRow[]> {
    return this.derm.listBiopsies(query);
  }

  @Permission('derm.biopsy.manage')
  @Post('derm/biopsies/:id/result')
  async fileBiopsyResult(
    @Param('id') id: string,
    @Body(new ZodBody(biopsyResultSchema)) body: BiopsyResultRequest,
  ): Promise<BiopsyRow> {
    return this.derm.fileBiopsyResult(id, body);
  }

  @Permission('derm.phototherapy.prescribe')
  @Idempotent()
  @Post('derm/phototherapy')
  async prescribeCourse(
    @Body(new ZodBody(phototherapyCourseSchema)) body: PhototherapyCourseRequest,
  ): Promise<PhototherapyCourseRow> {
    return this.derm.prescribeCourse(body);
  }

  @Permission('derm.phototherapy.deliver')
  @Get('derm/phototherapy')
  async listCourses(
    @Query(new ZodBody(openQuerySchema)) query: OpenQuery,
  ): Promise<readonly PhototherapyCourseRow[]> {
    return this.derm.listCourses(query);
  }

  @Permission('derm.phototherapy.deliver')
  @Idempotent()
  @Post('derm/phototherapy/:id/sessions')
  async deliverSession(
    @Param('id') id: string,
    @Body(new ZodBody(phototherapySessionSchema)) body: PhototherapySessionRequest,
  ): Promise<PhototherapySessionRow> {
    return this.derm.deliverSession(id, body);
  }

  /**
   * The documented way past the dose ceiling.
   *
   * A separate route behind a separate permission with a mandatory reason,
   * because the alternative — a `maxDoseMj` field on the session body — is a
   * limit the person who wants to exceed it can move.
   */
  @Permission('derm.phototherapy.raise_ceiling')
  @Post('derm/phototherapy/:id/ceiling')
  async raiseCeiling(
    @Param('id') id: string,
    @Body(new ZodBody(raiseCeilingSchema)) body: RaiseCeilingRequest,
  ): Promise<PhototherapyCourseRow> {
    return this.derm.raiseCeiling(id, body);
  }
}
