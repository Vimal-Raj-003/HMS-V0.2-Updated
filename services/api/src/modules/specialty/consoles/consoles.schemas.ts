import { queryFlag } from '@vims/contracts';
import { z } from 'zod';

/**
 * Request shapes for the five device-heavy consoles.
 *
 * ── There is no field here for a derived number ─────────────────────────────
 *
 * No `qtcMs`, no `preRatio`, no `reversible`, no `ptaAvg`, no `degree`, no
 * `severity`, no PASI `value`, no chart `state`. Each of those is computed by a
 * trigger, and the proof that it cannot be overridden is that no request can
 * express it — not a guard in a service that a later endpoint might forget to
 * call.
 *
 * ── Booleans that arrive as text ────────────────────────────────────────────
 *
 * Every query-string flag goes through `queryFlag()`, because `"false"` is a
 * truthy string and a filter that silently inverts is worse than one that
 * fails.
 */

const uuid = z.string().uuid();
const money = z.coerce.number().min(0);

// ═══════════════════════════════════════════════════════════════════════════
// OP-029 · Cardiology
// ═══════════════════════════════════════════════════════════════════════════

export const cardioConsultSchema = z.object({
  patientId: uuid,
  encounterId: uuid,
  nyha: z.number().int().min(1).max(4).optional(),
  ccs: z.number().int().min(1).max(4).optional(),
  scores: z.record(z.string(), z.unknown()).default({}),
  cvHistory: z.record(z.string(), z.unknown()).default({}),
  exam: z.record(z.string(), z.unknown()).default({}),
  plan: z.record(z.string(), z.unknown()).default({}),
  problemCodes: z.array(z.string().max(24)).max(40).default([]),
});
export type CardioConsultRequest = z.infer<typeof cardioConsultSchema>;

export const ecgRecordSchema = z.object({
  patientId: uuid,
  encounterId: uuid.optional(),
  deviceOrderId: uuid.optional(),
  source: z.enum(['device', 'upload', 'manual']),
  acquiredAt: z.string().datetime(),
  techId: uuid.optional(),
  hr: z.number().int().optional(),
  prMs: z.number().int().optional(),
  qrsMs: z.number().int().optional(),
  /**
   * The QT, in milliseconds. There is deliberately no `qtcMs`: the corrected
   * interval is Bazett applied to this and the rate, in a trigger, so the
   * number a pharmacist screens against and the number in the note are one
   * number.
   */
  qtMs: z.number().int().optional(),
  axisDeg: z.number().int().min(-180).max(180).optional(),
  machineInterp: z.array(z.string().max(200)).max(30).default([]),
  leadQuality: z.string().max(24).optional(),
  waveformKey: z.string().max(500).optional(),
  pdfKey: z.string().max(500).optional(),
});
export type EcgRecordRequest = z.infer<typeof ecgRecordSchema>;

export const ecgReadSchema = z.object({
  interpretation: z.array(z.string().max(200)).min(1).max(30),
  /** Whether this tracing shows something that cannot wait. */
  critical: z.boolean(),
  /** `preliminary` for a technician's or the machine's read; `final` for the record. */
  status: z.enum(['preliminary', 'final']),
});
export type EcgReadRequest = z.infer<typeof ecgReadSchema>;

export const ecgAcknowledgeSchema = z.object({
  /** Who was told. Free text because it is a person, not a system account. */
  toldTo: z.string().min(2).max(160),
});
export type EcgAcknowledgeRequest = z.infer<typeof ecgAcknowledgeSchema>;

export const echoReportSchema = z.object({
  patientId: uuid,
  encounterId: uuid.optional(),
  deviceOrderId: uuid.optional(),
  studyUid: z.string().max(120).optional(),
  type: z.enum(['tte', 'tee', 'stress', 'fetal', 'paeds']),
  efPct: z.number().min(5).max(85).optional(),
  measurements: z.record(z.string(), z.unknown()).default({}),
  wallMotion: z.record(z.string(), z.unknown()).default({}),
  conclusions: z.string().max(4000).optional(),
  keyImages: z.array(uuid).max(40).default([]),
  techId: uuid.optional(),
});
export type EchoReportRequest = z.infer<typeof echoReportSchema>;

export const stressTestSchema = z.object({
  patientId: uuid,
  encounterId: uuid.optional(),
  protocol: z.enum(['bruce', 'mod_bruce', 'naughton', 'pharmacological']),
  stages: z.array(z.record(z.string(), z.unknown())).max(30).default([]),
  targetHr: z.number().int().optional(),
  maxHrPct: z.number().int().optional(),
  dukeScore: z.number().optional(),
  /**
   * Required whenever a result is given, by a CHECK. It is optional here
   * because a test can be recorded while it is still running.
   */
  terminationReason: z.string().min(4).max(200).optional(),
  result: z.enum(['positive', 'negative', 'equivocal', 'inconclusive']).optional(),
  physicianId: uuid,
  consentId: uuid.optional(),
  checklist: z.record(z.string(), z.unknown()).default({}),
});
export type StressTestRequest = z.infer<typeof stressTestSchema>;

export const anticoagEnrolSchema = z
  .object({
    patientId: uuid,
    drug: z.enum(['warfarin', 'acenocoumarol', 'doac']),
    indication: z.string().min(2).max(160),
    targetInrLow: z.number().min(0.5).max(10).optional(),
    targetInrHigh: z.number().min(0.5).max(10).optional(),
    startDate: z.string().date(),
  })
  .superRefine((v, ctx) => {
    // The database enforces this too. Saying it here means the clinic sees the
    // sentence before the round trip, rather than a constraint name after it.
    if (v.drug === 'doac' && (v.targetInrLow !== undefined || v.targetInrHigh !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['targetInrLow'],
        message: 'A direct oral anticoagulant is not monitored by INR, so it has no target range.',
      });
    }
    if (v.drug !== 'doac' && (v.targetInrLow === undefined || v.targetInrHigh === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['targetInrLow'],
        message: 'A vitamin-K antagonist needs a target INR range.',
      });
    }
  });
export type AnticoagEnrolRequest = z.infer<typeof anticoagEnrolSchema>;

export const inrVisitSchema = z
  .object({
    measuredAt: z.string().datetime(),
    inr: z.number().min(0.5).max(20),
    source: z.enum(['poc', 'lab']),
    weeklyDoseMg: z.number().min(0).max(200),
    /** Seven daily doses, Monday first. The database checks that they sum. */
    doseGrid: z.array(z.number().min(0).max(50)).length(7),
    nextAt: z.string().date().optional(),
    events: z.array(z.record(z.string(), z.unknown())).max(20).default([]),
  })
  .superRefine((v, ctx) => {
    const sum = v.doseGrid.reduce((a, b) => a + b, 0);
    if (Math.abs(sum - v.weeklyDoseMg) > 0.01) {
      ctx.addIssue({
        code: 'custom',
        path: ['doseGrid'],
        message: `The seven daily doses add up to ${sum} mg but the weekly dose says ${v.weeklyDoseMg} mg.`,
      });
    }
  });
export type InrVisitRequest = z.infer<typeof inrVisitSchema>;

export const ecgQuerySchema = z.object({
  patientId: uuid.optional(),
  unacknowledgedOnly: queryFlag().default(false),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type EcgQuery = z.infer<typeof ecgQuerySchema>;

// ═══════════════════════════════════════════════════════════════════════════
// OP-030 · Pulmonology
// ═══════════════════════════════════════════════════════════════════════════

export const pulmoConsultSchema = z.object({
  patientId: uuid,
  encounterId: uuid,
  smoking: z.record(z.string(), z.unknown()).default({}),
  exposures: z.array(z.record(z.string(), z.unknown())).max(30).default([]),
  scores: z.record(z.string(), z.unknown()).default({}),
  goldGroup: z.string().max(8).optional(),
  ginaStep: z.number().int().min(1).max(5).optional(),
  dxCodes: z.array(z.string().max(24)).max(40).default([]),
  plan: z.record(z.string(), z.unknown()).default({}),
});
export type PulmoConsultRequest = z.infer<typeof pulmoConsultSchema>;

export const pftStudySchema = z.object({
  patientId: uuid,
  encounterId: uuid.optional(),
  deviceOrderId: uuid.optional(),
  tests: z.array(z.string().max(20)).max(10).default([]),
  source: z.enum(['device', 'manual']).default('manual'),
  performedAt: z.string().datetime(),
  techId: uuid.optional(),
  demographics: z.record(z.string(), z.unknown()).default({}),
  /** ATS/ERS effort grade. An `F` can be recorded and never signed. */
  qualityGrade: z.enum(['A', 'B', 'C', 'D', 'E', 'F']).optional(),
  /**
   * Litres, as the device produced them. The ratio and the reversibility are
   * arithmetic on these, done in a trigger — there is no field for either.
   */
  preFvc: z.number().min(0).max(15).optional(),
  preFev1: z.number().min(0).max(15).optional(),
  prePef: z.number().min(0).max(30).optional(),
  postFvc: z.number().min(0).max(15).optional(),
  postFev1: z.number().min(0).max(15).optional(),
  predicted: z.record(z.string(), z.unknown()).default({}),
  dlco: z.record(z.string(), z.unknown()).default({}),
  volumes: z.record(z.string(), z.unknown()).default({}),
  fenoPpb: z.number().int().min(0).max(500).optional(),
  sixmwt: z.record(z.string(), z.unknown()).default({}),
  curvesKey: z.string().max(500).optional(),
});
export type PftStudyRequest = z.infer<typeof pftStudySchema>;

export const pftInterpretSchema = z.object({
  interpretation: z.string().min(4).max(4000),
  qualityGrade: z.enum(['A', 'B', 'C', 'D', 'E', 'F']),
});
export type PftInterpretRequest = z.infer<typeof pftInterpretSchema>;

export const sleepStudySchema = z.object({
  patientId: uuid,
  type: z.enum(['psg', 'hst', 'titration', 'split']),
  bedId: uuid.optional(),
  scheduledAt: z.string().datetime(),
  techId: uuid.optional(),
  deviceSerial: z.string().max(60).optional(),
  hookupChecklist: z.record(z.string(), z.unknown()).default({}),
});
export type SleepStudyRequest = z.infer<typeof sleepStudySchema>;

export const sleepScoreSchema = z.object({
  /** The severity band is derived from this, and there is no field for it. */
  ahi: z.number().min(0).max(200),
  scored: z.record(z.string(), z.unknown()).default({}),
  interpretation: z.string().max(4000).optional(),
});
export type SleepScoreRequest = z.infer<typeof sleepScoreSchema>;

export const papRxSchema = z.object({
  patientId: uuid,
  studyId: uuid.optional(),
  mode: z.enum(['cpap', 'apap', 'bipap', 'asv']),
  pressureCm: z.number().min(3).max(30).optional(),
  pressureMin: z.number().min(3).max(30).optional(),
  pressureMax: z.number().min(3).max(30).optional(),
  epap: z.number().min(3).max(30).optional(),
  ipap: z.number().min(3).max(30).optional(),
  mask: z.string().max(80).optional(),
  humidifier: z.boolean().default(false),
  deviceItemId: uuid.optional(),
  serial: z.string().max(60).optional(),
  ownership: z.enum(['rental', 'purchase', 'own']).default('rental'),
  startDate: z.string().date(),
});
export type PapRxRequest = z.infer<typeof papRxSchema>;

export const papComplianceSchema = z.object({
  periodFrom: z.string().date(),
  periodTo: z.string().date(),
  usageHoursAvg: z.number().min(0).max(24),
  pctNightsGe4h: z.number().int().min(0).max(100),
  residualAhi: z.number().min(0).max(200).optional(),
  leak: z.number().min(0).max(200).optional(),
  source: z.enum(['sd', 'cloud', 'manual']),
  reportKey: z.string().max(500).optional(),
});
export type PapComplianceRequest = z.infer<typeof papComplianceSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// OP-028 · ENT and audiology
// ═══════════════════════════════════════════════════════════════════════════

export const entExamSchema = z.object({
  patientId: uuid,
  encounterId: uuid,
  ear: z.record(z.string(), z.unknown()).default({}),
  nose: z.record(z.string(), z.unknown()).default({}),
  throat: z.record(z.string(), z.unknown()).default({}),
  neck: z.record(z.string(), z.unknown()).default({}),
  drawings: z.record(z.string(), z.unknown()).default({}),
  stopBang: z.number().int().min(0).max(8).optional(),
  epworth: z.number().int().min(0).max(24).optional(),
  formResponseId: uuid.optional(),
});
export type EntExamRequest = z.infer<typeof entExamSchema>;

export const audiologyTestSchema = z.object({
  patientId: uuid,
  encounterId: uuid.optional(),
  deviceOrderId: uuid.optional(),
  testType: z.enum(['pta', 'speech', 'tymp', 'oae', 'bera', 'assr', 'freefield', 'vra', 'play', 'rem']),
  source: z.enum(['device', 'manual']).default('manual'),
  boothId: z.string().max(40).optional(),
  performedAt: z.string().datetime(),
  /** The day's biological check. Without it the test can be run and never signed. */
  calibrationOk: z.boolean(),
});
export type AudiologyTestRequest = z.infer<typeof audiologyTestSchema>;

export const thresholdBatchSchema = z.object({
  thresholds: z
    .array(
      z.object({
        ear: z.enum(['left', 'right']),
        conduction: z.enum(['ac', 'bc']),
        freqHz: z.number().int().min(125).max(8000),
        thresholdDb: z.number().int().min(-10).max(120),
        masked: z.boolean().default(false),
        noResponse: z.boolean().default(false),
      }),
    )
    .min(1)
    .max(60),
});
export type ThresholdBatchRequest = z.infer<typeof thresholdBatchSchema>;

/**
 * Everything an audiology result carries except the three things it derives.
 * `ptaAvg`, `degree` and `type` come from the thresholds, so they are absent.
 */
export const audiologyResultSchema = z.object({
  ear: z.enum(['left', 'right']),
  configuration: z.string().max(40).optional(),
  srt: z.number().int().min(-10).max(120).optional(),
  sdsPct: z.number().int().min(0).max(100).optional(),
  mcl: z.number().int().min(-10).max(120).optional(),
  ucl: z.number().int().min(-10).max(120).optional(),
  tympType: z.enum(['A', 'As', 'Ad', 'B', 'C']).optional(),
  ecvMl: z.number().min(0).max(10).optional(),
  peakDapa: z.number().int().min(-600).max(400).optional(),
  complianceMl: z.number().min(0).max(10).optional(),
  reflexes: z.record(z.string(), z.unknown()).default({}),
  oae: z.record(z.string(), z.unknown()).default({}),
  abr: z.record(z.string(), z.unknown()).default({}),
  interpretation: z.string().max(4000).optional(),
});
export type AudiologyResultRequest = z.infer<typeof audiologyResultSchema>;

export const hearingAidSchema = z.object({
  patientId: uuid,
  ear: z.enum(['left', 'right']),
  model: z.string().min(1).max(120),
  serial: z.string().min(1).max(80),
  itemId: uuid.optional(),
  status: z.enum(['trial', 'dispensed', 'returned', 'serviced']).default('trial'),
  fitting: z.record(z.string(), z.unknown()).default({}),
  warrantyUntil: z.string().date().optional(),
});
export type HearingAidRequest = z.infer<typeof hearingAidSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// OP-026 · Dental
// ═══════════════════════════════════════════════════════════════════════════

export const toothEventSchema = z.object({
  patientId: uuid,
  encounterId: uuid.optional(),
  toothFdi: z.number().int().min(11).max(85),
  surfaces: z
    .array(z.enum(['M', 'O', 'D', 'B', 'L', 'P', 'I', 'R']))
    .max(6)
    .default([]),
  conditionCode: z.string().min(1).max(40),
  status: z.enum(['existing', 'planned', 'done', 'cancelled']),
  planItemId: uuid.optional(),
  procedureId: uuid.optional(),
  notes: z.string().max(2000).optional(),
});
export type ToothEventRequest = z.infer<typeof toothEventSchema>;

export const dentalPlanSchema = z.object({
  patientId: uuid,
  encounterId: uuid.optional(),
  items: z
    .array(
      z.object({
        procedureCode: z.string().min(1).max(40),
        description: z.string().min(1).max(240),
        teeth: z.array(z.number().int().min(11).max(85)).max(32).default([]),
        surfaces: z.record(z.string(), z.unknown()).default({}),
        phase: z.number().int().min(1).max(9).default(1),
        priority: z.enum(['urgent', 'phase1', 'phase2', 'phase3']).default('phase1'),
        quantity: z.number().int().min(1).max(32).default(1),
        sittingsPlanned: z.number().int().min(1).max(40).default(1),
        unitPrice: money,
        discount: money.default(0),
        tax: money.default(0),
        altGroup: z.string().max(24).optional(),
        dentistId: uuid.optional(),
      }),
    )
    .min(1)
    .max(60),
});
export type DentalPlanRequest = z.infer<typeof dentalPlanSchema>;

/**
 * Superseding an accepted plan: the replacement's lines, and why.
 *
 * The reason is a body field rather than a header, following OP-010's
 * checklist override — it belongs to the act, it is the thing the patient will
 * be shown if they ask why the price changed, and a header is easy to forget
 * in a client and impossible to make required in a schema.
 */
export const dentalSupersedeSchema = dentalPlanSchema.extend({
  reason: z.string().trim().min(8).max(2000),
});
export type DentalSupersedeRequest = z.infer<typeof dentalSupersedeSchema>;

export const dentalPresentSchema = z.object({
  consentId: uuid.optional(),
  instalmentSchedule: z.array(z.record(z.string(), z.unknown())).max(36).default([]),
});
export type DentalPresentRequest = z.infer<typeof dentalPresentSchema>;

export const dentalAcceptSchema = z.object({
  /** How the patient said yes. There is no fourth option. */
  acceptedVia: z.enum(['esign', 'portal', 'verbal_witness']),
  /** Which lines they accepted. An empty list accepts the whole plan. */
  acceptedItemIds: z.array(uuid).max(60).default([]),
});
export type DentalAcceptRequest = z.infer<typeof dentalAcceptSchema>;

export const dentalSittingSchema = z.object({
  patientId: uuid,
  planId: uuid.optional(),
  encounterId: uuid.optional(),
  procedureId: uuid.optional(),
  items: z.array(z.record(z.string(), z.unknown())).max(40).default([]),
  la: z.record(z.string(), z.unknown()).default({}),
  materials: z.array(z.record(z.string(), z.unknown())).max(40).default([]),
  implantUdi: z.string().max(80).optional(),
  rctDetail: z.record(z.string(), z.unknown()).default({}),
  extractionDetail: z.record(z.string(), z.unknown()).default({}),
  orthoDetail: z.record(z.string(), z.unknown()).default({}),
  photos: z.array(z.record(z.string(), z.unknown())).max(40).default([]),
  nextVisitDays: z.number().int().min(0).max(730).optional(),
});
export type DentalSittingRequest = z.infer<typeof dentalSittingSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// OP-027 · Dermatology
// ═══════════════════════════════════════════════════════════════════════════

export const lesionSchema = z.object({
  patientId: uuid,
  bodySiteSnomed: z.string().max(40).optional(),
  regionKey: z.string().min(1).max(40),
  side: z.enum(['left', 'right', 'bilateral', 'not_applicable']).default('not_applicable'),
  morphology: z.string().min(1).max(40),
  sizeMm: z.number().min(0).max(500).optional(),
  colour: z.string().max(40).optional(),
  descriptors: z.record(z.string(), z.unknown()).default({}),
  firstSeenEncounterId: uuid.optional(),
  sensitive: z.boolean().default(false),
});
export type LesionRequest = z.infer<typeof lesionSchema>;

export const lesionObservationSchema = z.object({
  encounterId: uuid.optional(),
  findings: z.record(z.string(), z.unknown()).default({}),
  itchNrs: z.number().int().min(0).max(10).optional(),
  photos: z.array(uuid).max(40).default([]),
});
export type LesionObservationRequest = z.infer<typeof lesionObservationSchema>;

/**
 * A score's components, and — only for the score types that have no published
 * formula — its value.
 *
 * PASI, EASI, SCORAD and BSA compute from `components` in a trigger, so a value
 * sent for one of those is discarded rather than honoured. The field stays on
 * the schema because DLQI, IGA and the rest genuinely have nothing to compute
 * from.
 */
export const dermScoreSchema = z.object({
  patientId: uuid,
  encounterId: uuid.optional(),
  scoreType: z.enum([
    'pasi',
    'easi',
    'scorad',
    'bsa',
    'dlqi',
    'iga_acne',
    'salt',
    'vasi',
    'uas7',
    'hurley',
    'ihs4',
    'leprosy_grade',
    'other',
  ]),
  components: z.record(z.string(), z.unknown()).default({}),
  value: z.number().min(0).max(9999).optional(),
  formResponseId: uuid.optional(),
});
export type DermScoreRequest = z.infer<typeof dermScoreSchema>;

export const biopsySchema = z.object({
  patientId: uuid,
  lesionId: uuid,
  procedureId: uuid.optional(),
  specimenNo: z.string().max(40).optional(),
  labOrderId: uuid.optional(),
  type: z.enum(['punch', 'shave', 'excision', 'incisional', 'curettage']),
  sizeMm: z.number().min(0).max(500).optional(),
  dif: z.boolean().default(false),
  clinicalDx: z.string().max(240).optional(),
});
export type BiopsyRequest = z.infer<typeof biopsySchema>;

export const biopsyResultSchema = z.object({
  resultSummary: z.string().min(2).max(4000),
  malignancyFlag: z.boolean(),
  margins: z.string().max(80).optional(),
  /**
   * Required by the database whenever the report is malignant and the biopsy is
   * being closed. Optional here because a benign report closes without one.
   */
  followupTaskId: uuid.optional(),
  status: z.enum(['reported', 'reviewed', 'action_planned']),
});
export type BiopsyResultRequest = z.infer<typeof biopsyResultSchema>;

export const phototherapyCourseSchema = z.object({
  patientId: uuid,
  modality: z.enum(['nbuvb', 'puva', 'excimer', 'uva1']),
  skinType: z.number().int().min(1).max(6),
  medMj: z.number().min(0).max(100000).optional(),
  startDoseMj: z.number().min(1).max(100000),
  incrementPct: z.number().min(0).max(100),
  maxDoseMj: z.number().min(1).max(100000),
  freqPerWeek: z.number().int().min(1).max(7),
  /** Must carry `eyes`. The database refuses a course without it. */
  shielding: z.record(z.string(), z.unknown()),
  psoralen: z.record(z.string(), z.unknown()).default({}),
  deviceId: uuid.optional(),
});
export type PhototherapyCourseRequest = z.infer<typeof phototherapyCourseSchema>;

export const phototherapySessionSchema = z.object({
  doseMj: z.number().min(1).max(100000),
  erythemaGrade: z.number().int().min(0).max(4).default(0),
  adverse: z.record(z.string(), z.unknown()).default({}),
  chargeIntentId: uuid.optional(),
});
export type PhototherapySessionRequest = z.infer<typeof phototherapySessionSchema>;

export const raiseCeilingSchema = z.object({
  maxDoseMj: z.number().min(1).max(100000),
  reason: z.string().min(8).max(500),
});
export type RaiseCeilingRequest = z.infer<typeof raiseCeilingSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// Shared queries
// ═══════════════════════════════════════════════════════════════════════════

export const patientQuerySchema = z.object({
  patientId: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type PatientQuery = z.infer<typeof patientQuerySchema>;

export const openQuerySchema = z.object({
  patientId: uuid.optional(),
  openOnly: queryFlag().default(false),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type OpenQuery = z.infer<typeof openQuerySchema>;
