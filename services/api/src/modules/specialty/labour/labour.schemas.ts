import { queryFlag } from '@vims/contracts';
import { z } from 'zod';

/**
 * Request shapes for IP-011.
 *
 * ── There is no field for a partograph alert ────────────────────────────────
 *
 * The alert and action lines are computed from the start of the active phase
 * and the point being plotted. A room that could declare its own alerts is a
 * room that never crosses a line.
 *
 * ── And no `uterotonicDelaySec`, no `txaWithin3h`, no `matched` ─────────────
 *
 * The third-stage delay is the birth and the drug. The tranexamic acid window
 * runs from the birth. And whether two wristbands match is what the *scanner*
 * read against the code on the record — not what the person scanning believed.
 * All three are the numbers a review reads, and all three are the database's.
 *
 * ── There is no `force` on anything here ────────────────────────────────────
 *
 * Not on the chart, not on a handover. The action line releases when a decision
 * is recorded — `continue_expectantly` is one of the five, and a legitimate one.
 * A wristband pair releases when a scan matches, and nothing else.
 */

const uuid = z.string().uuid();

export const episodeSchema = z.object({
  admissionId: uuid,
  patientId: uuid,
  pregnancyId: uuid.optional(),
  eddAtAdmission: z.string().date().optional(),
  gpal: z.record(z.string(), z.unknown()).default({}),
  riskFlags: z.array(z.string().max(40)).max(30).default([]),
  bloodGroup: z.string().max(8).optional(),
  rhNegative: z.boolean().optional(),
  onsetAt: z.string().optional(),
  membraneStatus: z.enum(['intact', 'srom', 'arm']).optional(),
  membraneRuptureAt: z.string().optional(),
  liquor: z.string().max(24).optional(),
  presentation: z.string().max(24).optional(),
  /** Nought for a first baby. The second-stage clock is different for each. */
  parity: z.number().int().min(0).max(20).default(0),
  partographStandard: z.enum(['who_classic', 'lcg']).default('who_classic'),
  epidural: z.boolean().default(false),
  companionPresent: z.boolean().default(false),
  consents: z.record(z.string(), z.unknown()).default({}),
});
export type EpisodeRequest = z.infer<typeof episodeSchema>;

export const episodeUpdateSchema = z
  .object({
    /** Both lines are drawn from this, so it is the anchor of the whole chart. */
    activePhaseFrom: z.string().optional(),
    secondStageFrom: z.string().optional(),
    epidural: z.boolean().optional(),
    membraneStatus: z.enum(['intact', 'srom', 'arm']).optional(),
    membraneRuptureAt: z.string().optional(),
    liquor: z.string().max(24).optional(),
    presentation: z.string().max(24).optional(),
    companionPresent: z.boolean().optional(),
    outcome: z.enum(['vaginal', 'assisted', 'lscs', 'referred', 'undelivered']).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change.' });
export type EpisodeUpdateRequest = z.infer<typeof episodeUpdateSchema>;

/**
 * A batch of chart entries, because a set of observations is taken together and
 * a chart written one field at a time is a chart nobody finishes.
 */
export const partographSchema = z.object({
  entries: z
    .array(
      z.object({
        recordedAt: z.string().optional(),
        param: z.enum([
          'dilatation',
          'descent',
          'contractions',
          'fhr',
          'liquor',
          'moulding',
          'caput',
          'pulse',
          'bp',
          'temp',
          'urine',
          'oxytocin',
          'drug',
          'fluid',
          'pain_relief',
          'position',
          'intake',
        ]),
        value: z.record(z.string(), z.unknown()),
        source: z.enum(['manual', 'ctg']).default('manual'),
      }),
    )
    .min(1)
    .max(40),
});
export type PartographRequest = z.infer<typeof partographSchema>;

/**
 * The decision at a line. Five choices, because the point of a partograph is
 * that one of a small number of things now happens — and "continue" is one of
 * them, with a sentence beside it.
 */
export const decisionSchema = z
  .object({
    decision: z.enum(['augment', 'assist', 'caesarean', 'refer', 'continue_expectantly']),
    decisionNote: z.string().max(4000).optional(),
  })
  .refine(
    (v) =>
      v.decision !== 'continue_expectantly' ||
      (v.decisionNote !== undefined && v.decisionNote.trim().length >= 8),
    { message: 'Continuing past the line needs a reason.' },
  );
export type DecisionRequest = z.infer<typeof decisionSchema>;

export const deliverySchema = z.object({
  mode: z.enum(['spontaneous_vaginal', 'vacuum', 'forceps', 'breech', 'lscs_elective', 'lscs_emergency']),
  deliveredAt: z.string(),
  place: z.string().max(60).optional(),
  attendants: z.array(z.record(z.string(), z.unknown())).max(10).default([]),
  indication: z.string().max(2000).optional(),
  otCaseId: uuid.optional(),
  decisionToDeliveryMin: z.number().int().min(0).max(600).optional(),
  episiotomy: z.boolean().default(false),
  tearDegree: z.enum(['none', 'first', 'second', 'third_a', 'third_b', 'third_c', 'fourth']).optional(),
  /** The one-minute window. The delay is derived from these two. */
  uterotonicDrug: z.string().max(60).optional(),
  uterotonicAt: z.string().optional(),
  placenta: z.record(z.string(), z.unknown()).default({}),
  thirdStage: z.record(z.string(), z.unknown()).default({}),
  eblMl: z.number().int().min(0).max(10000).optional(),
  /** Visual estimation understates by about a third, so the method is recorded. */
  eblMethod: z.enum(['visual', 'gravimetric', 'calibrated_drape', 'suction_and_swabs']).optional(),
  complications: z.array(z.record(z.string(), z.unknown())).max(20).default([]),
  notes: z.string().max(4000).optional(),

  /**
   * The baby, recorded in the same call. A delivery that saves without a
   * newborn is a baby who exists in a room and not in a system, and the gap is
   * where the wristband goes on unrecorded.
   */
  newborn: z.object({
    sex: z.enum(['male', 'female', 'ambiguous', 'unknown']),
    status: z.enum(['live', 'stillbirth_fresh', 'stillbirth_macerated', 'neonatal_death']).default('live'),
    birthWeightG: z.number().int().min(200).max(8000).optional(),
    lengthCm: z.number().min(15).max(70).optional(),
    hcCm: z.number().min(15).max(60).optional(),
    gaWeeks: z.number().int().min(20).max(45).optional(),
    apgar1: z.number().int().min(0).max(10).optional(),
    apgar5: z.number().int().min(0).max(10).optional(),
    apgar10: z.number().int().min(0).max(10).optional(),
    apgarComponents: z.record(z.string(), z.unknown()).default({}),
    resuscitation: z.record(z.string(), z.unknown()).default({}),
    cordClampDelayed: z.boolean().default(false),
    motherAdmissionId: uuid.optional(),
  }),
});
export type DeliveryRequest = z.infer<typeof deliverySchema>;

export const newbornUpdateSchema = z
  .object({
    birthWeightG: z.number().int().min(200).max(8000).optional(),
    lengthCm: z.number().min(15).max(70).optional(),
    hcCm: z.number().min(15).max(60).optional(),
    apgar10: z.number().int().min(0).max(10).optional(),
    resuscitation: z.record(z.string(), z.unknown()).optional(),
    vitaminKAt: z.string().optional(),
    firstFeedAt: z.string().optional(),
    skinToSkinMin: z.number().int().min(0).max(600).optional(),
    nicuAdmitted: z.boolean().optional(),
    admissionId: uuid.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change.' });
export type NewbornUpdateRequest = z.infer<typeof newbornUpdateSchema>;

export const examSchema = z.object({
  kind: z.enum(['initial', '24h', 'discharge']),
  findings: z.record(z.string(), z.unknown()).default({}),
  anomalies: z.array(z.record(z.string(), z.unknown())).max(20).default([]),
  cchdScreen: z.record(z.string(), z.unknown()).default({}),
  hip: z.string().max(24).optional(),
  redReflex: z.string().max(24).optional(),
  weightG: z.number().int().min(200).max(8000).optional(),
});
export type ExamRequest = z.infer<typeof examSchema>;

/**
 * A handover scan. `matched` is not here: it is what the scanner read against
 * the code on the record, not what the person scanning believed.
 */
export const identityCheckSchema = z.object({
  motherBandScan: z.string().min(1).max(24),
  babyBandScan: z.string().min(1).max(24),
  context: z.enum(['first_feed', 'handover', 'feed_pickup', 'transfer', 'discharge', 'procedure']),
});
export type IdentityCheckRequest = z.infer<typeof identityCheckSchema>;

export const pphStepSchema = z.object({
  step: z.enum([
    'call_for_help',
    'uterotonic',
    'txa',
    'bimanual_compression',
    'balloon_tamponade',
    'massive_transfusion',
    'theatre',
    'hysterectomy',
  ]),
  at: z.string().optional(),
  note: z.string().max(500).optional(),
});
export type PphStepRequest = z.infer<typeof pphStepSchema>;

export const pphCloseSchema = z.object({
  outcome: z.string().min(4).max(2000),
});
export type PphCloseRequest = z.infer<typeof pphCloseSchema>;

export const birthReportSchema = z.object({
  form1: z.record(z.string(), z.unknown()),
});
export type BirthReportRequest = z.infer<typeof birthReportSchema>;

export const birthReportSubmitSchema = z.object({
  crsRegNo: z.string().max(60).optional(),
});
export type BirthReportSubmitRequest = z.infer<typeof birthReportSubmitSchema>;

export const episodeQuerySchema = z.object({
  patientId: uuid.optional(),
  openOnly: queryFlag().default(false),
  blockedOnly: queryFlag().default(false),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type EpisodeQuery = z.infer<typeof episodeQuerySchema>;

export const newbornQuerySchema = z.object({
  motherPatientId: uuid.optional(),
  reportDueOnly: queryFlag().default(false),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type NewbornQuery = z.infer<typeof newbornQuerySchema>;
