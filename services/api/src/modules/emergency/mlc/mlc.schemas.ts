import { queryFlag } from '@vims/contracts';
import { z } from 'zod';

/**
 * TR-008 request contracts.
 *
 * ── Three things no request body here can carry ─────────────────────────────
 *
 * A custody hash, an MLC number, and a two-finger test. The first is computed
 * by the database so the application cannot forge a link; the second comes from
 * the gapless series; the third has no field and the database refuses the key.
 * All three are absences on purpose — see `clinical-mlc.prisma`.
 */
const uuid = z.string().uuid();

export const idSchema = uuid;
export const pageLimit = z.coerce.number().int().min(1).max(200).default(50);

export const MLC_CATEGORIES = [
  'rta',
  'assault',
  'burns',
  'poisoning',
  'fall_from_height',
  'industrial',
  'animal_attack',
  'firearm',
  'sexual_assault',
  'self_harm',
  'dowry_related',
  'custodial',
  'unknown_unconscious',
  'brought_dead',
  'drowning',
  'electrocution',
  'snake_bite',
  'other',
] as const;

/** The four §5 calls sensitive. Access to these is a separate permission. */
export const SENSITIVE_CATEGORIES = ['sexual_assault', 'dowry_related', 'custodial'] as const;

export const INTIMATION_TYPES = [
  'initial',
  'update',
  'death',
  'inquest',
  'absconded',
  'transfer',
  'discharge',
  'dying_declaration_request',
  'mv_act_information',
] as const;

export const INJURY_KINDS = [
  'abrasion',
  'contusion',
  'laceration',
  'incised',
  'stab',
  'chop',
  'firearm_entry',
  'firearm_exit',
  'burn',
  'fracture',
  'bite',
  'ligature',
  'defence_wound',
  'other',
] as const;

export const BODY_VIEWS = [
  'front',
  'back',
  'left',
  'right',
  'head',
  'palms',
  'soles',
  'genital',
  'child_front',
  'child_back',
] as const;

export const BNS_CLASSES = ['simple', 'grievous', 'dangerous_to_life', 'not_assessed'] as const;

/**
 * BNS 2023 §116's limbs, as a closed list.
 *
 * A grievous classification has to name which one it rests on. Free text here
 * would let "grievous — obviously" into a certificate that a defence lawyer
 * then takes apart.
 */
export const GRIEVOUS_GROUNDS = [
  'emasculation',
  'permanent_privation_of_sight',
  'permanent_privation_of_hearing',
  'privation_of_member_or_joint',
  'destruction_or_impairment_of_powers',
  'permanent_disfiguration_of_head_or_face',
  'fracture_or_dislocation',
  'endangers_life_or_severe_pain_20_days',
] as const;

export const WEAPON_OPINIONS = [
  'blunt',
  'sharp',
  'pointed',
  'firearm',
  'thermal',
  'chemical',
  'animal',
  'ligature',
  'other',
  'undetermined',
] as const;

export const EVIDENCE_KINDS = [
  'photo',
  'video',
  'clothing',
  'belonging',
  'sample',
  'foreign_body',
  'document',
  'digital_other',
] as const;

export const EVIDENCE_LOCATIONS = [
  'er',
  'evidence_locker',
  'lab',
  'mrd',
  'police',
  'court',
  'disposed',
] as const;

export const REPORT_KINDS = [
  'wound_certificate',
  'mlc_report',
  'age_certificate',
  'fitness_certificate',
  'intoxication_certificate',
  'sexual_assault_report',
  'death_summary_court',
  'treatment_summary',
  'bsa_63_certificate',
  'other',
] as const;

const policeDetails = z.object({
  ps: z.string().trim().max(160).optional(),
  officer: z.string().trim().max(160).optional(),
  badge: z.string().trim().max(60).optional(),
  gdNo: z.string().trim().max(60).optional(),
  firNo: z.string().trim().max(60).optional(),
});

export const openCaseSchema = z.object({
  category: z.enum(MLC_CATEGORIES),
  subCategory: z.string().trim().max(80).optional(),

  erVisitId: uuid.optional(),
  admissionId: uuid.optional(),
  patientId: uuid.optional(),
  /** The ER tag. A case opens for somebody with no name. */
  tempTagId: z.string().trim().max(40).optional(),

  broughtBy: z
    .object({
      type: z.enum(['self', 'relative', 'police', 'ambulance_108', 'passer_by', 'employer', 'other']),
      names: z.array(z.string().trim().max(160)).max(6).default([]),
      phone: z.string().trim().max(20).optional(),
      police: policeDetails.optional(),
    })
    .optional(),
  informant: z
    .object({
      name: z.string().trim().max(160),
      relation: z.string().trim().max(80).optional(),
      phone: z.string().trim().max(20).optional(),
      address: z.string().trim().max(300).optional(),
    })
    .optional(),

  /** In the patient's or the informant's words. Not the doctor's summary. */
  historyAsStated: z.string().trim().max(4000).optional(),
  /** Two moles, a scar — how an unidentified body is later matched. */
  identificationMarks: z.array(z.string().trim().max(200)).max(10).default([]),
  allegedIncidentAt: z.string().datetime({ offset: true }).optional(),
  incidentPlace: z.string().trim().max(300).optional(),

  /** Per act, not one blanket yes. */
  consent: z
    .object({
      examination: z.boolean().optional(),
      photography: z.boolean().optional(),
      samples: z.boolean().optional(),
      policeInformation: z.boolean().optional(),
      takenFrom: z.string().trim().max(160).optional(),
      relation: z.string().trim().max(80).optional(),
    })
    .optional(),

  /** TR-001's structured mechanism, when that is what suggested the case. */
  suggestedFrom: z.string().trim().max(40).optional(),
  moId: uuid.optional(),
});
export type OpenCaseRequest = z.infer<typeof openCaseSchema>;

export const updateCaseSchema = openCaseSchema
  .partial()
  .omit({ category: true, erVisitId: true, admissionId: true })
  .extend({
    intoxicationAssessment: z
      .object({
        smellOfAlcohol: z.boolean().optional(),
        speech: z.string().trim().max(80).optional(),
        gait: z.string().trim().max(80).optional(),
        pupils: z.string().trim().max(80).optional(),
        rombergPositive: z.boolean().optional(),
        opinion: z.string().trim().max(300).optional(),
      })
      .optional(),
  });
export type UpdateCaseRequest = z.infer<typeof updateCaseSchema>;

export const registerQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  status: z.enum(['open', 'report_pending', 'report_final', 'closed', 'cancelled']).optional(),
  category: z.enum(MLC_CATEGORIES).optional(),
  /** Sensitive cases are excluded unless the caller holds the sensitive key. */
  includeSensitive: queryFlag().default(false),
  limit: pageLimit,
});
export type RegisterQuery = z.infer<typeof registerQuerySchema>;

/** The reason rides in `x-reason`. */
export const cancelCaseSchema = z.object({});
export type CancelCaseRequest = z.infer<typeof cancelCaseSchema>;

export const intimationSchema = z.object({
  type: z.enum(INTIMATION_TYPES).default('initial'),
  psName: z.string().trim().min(2).max(160),
  jurisdiction: z.string().trim().max(160).optional(),
  addressedTo: z.string().trim().max(160).optional(),
  templateRef: z.string().trim().max(120).optional(),
});
export type IntimationRequest = z.infer<typeof intimationSchema>;

export const dispatchSchema = z.object({
  channels: z
    .array(
      z.object({
        channel: z.enum(['printed', 'email', 'sms', 'portal']),
        to: z.string().trim().max(200),
        messageId: z.string().trim().max(120).optional(),
      }),
    )
    .min(1)
    .max(4),
});
export type DispatchRequest = z.infer<typeof dispatchSchema>;

/** Who signed for it. Without this the hospital sent a form and can prove nothing. */
export const acknowledgeSchema = z.object({
  officerName: z.string().trim().min(2).max(160),
  officerBadge: z.string().trim().max(60).optional(),
  signatureRef: z.string().trim().max(300).optional(),
});
export type AcknowledgeRequest = z.infer<typeof acknowledgeSchema>;

export const injurySchema = z.object({
  kind: z.enum(INJURY_KINDS),
  bodyView: z.enum(BODY_VIEWS),
  xPct: z.coerce.number().min(0).max(100),
  yPct: z.coerce.number().min(0).max(100),
  side: z.enum(['left', 'right', 'midline', 'bilateral']).optional(),

  siteDescription: z.string().trim().min(3).max(300),
  lengthCm: z.coerce.number().min(0).max(200).optional(),
  breadthCm: z.coerce.number().min(0).max(200).optional(),
  depthCm: z.coerce.number().min(0).max(100).optional(),
  shape: z.string().trim().max(80).optional(),
  edges: z.string().trim().max(80).optional(),
  direction: z.string().trim().max(80).optional(),
  colourStage: z.string().trim().max(80).optional(),
  ageEstimate: z.string().trim().max(120).optional(),
  foreignBody: z.string().trim().max(200).optional(),

  /** Tattooing, blackening, singeing — what a range opinion rests on. */
  firearmFeatures: z
    .object({
      tattooing: z.boolean().optional(),
      blackening: z.boolean().optional(),
      singeing: z.boolean().optional(),
      rangeOpinion: z.enum(['contact', 'close', 'intermediate', 'distant', 'undetermined']).optional(),
    })
    .optional(),

  bnsClass: z.enum(BNS_CLASSES).default('not_assessed'),
  grievousGround: z.enum(GRIEVOUS_GROUNDS).optional(),
  weaponOpinion: z.enum(WEAPON_OPINIONS).default('undetermined'),
  consistentWithHistory: z.enum(['yes', 'no', 'cannot_say']).default('cannot_say'),

  /** Links to the TR-001 coded injury when a trauma episode exists. */
  traumaInjuryId: uuid.optional(),
});
export type InjuryRequest = z.infer<typeof injurySchema>;

export const evidenceSchema = z.object({
  kind: z.enum(EVIDENCE_KINDS),
  description: z.string().trim().min(3).max(400),
  sealNo: z.string().trim().max(60).optional(),
  bagLabelRef: z.string().trim().max(120).optional(),
  sampleId: uuid.optional(),
  consentRef: z.string().trim().max(120).optional(),
  notes: z.string().trim().max(2000).optional(),

  /** Digital items only: the WORM key and the digest taken on the device. */
  fileRef: z.string().trim().max(400).optional(),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/u, 'A SHA-256 digest is 64 lowercase hex characters')
    .optional(),
  deviceId: z.string().trim().max(64).optional(),
  exif: z.record(z.string(), z.unknown()).optional(),
});
export type EvidenceRequest = z.infer<typeof evidenceSchema>;

/**
 * A custody transfer.
 *
 * `prevHash`, `hash` and `seq` are absent because the database computes all
 * three. An endpoint that accepted them would be an endpoint that could be used
 * to write a chain that never happened.
 */
export const custodySchema = z.object({
  toUserId: uuid.optional(),
  toExternal: z
    .object({
      officer: z.string().trim().min(2).max(160),
      badge: z.string().trim().max(60).optional(),
      ps: z.string().trim().min(2).max(160),
      firNo: z.string().trim().max(60).optional(),
    })
    .optional(),
  locationTo: z.enum(EVIDENCE_LOCATIONS),
  purpose: z.string().trim().min(4).max(200),
  /** Checked by the person receiving it. False needs a note — the DB insists. */
  sealIntact: z.boolean().default(true),
  witnessUserId: uuid.optional(),
  conditionNotes: z.string().trim().max(2000).optional(),
  temperatureC: z.coerce.number().min(-90).max(60).optional(),
});
export type CustodyRequest = z.infer<typeof custodySchema>;

export const handoverSchema = z.object({
  itemIds: z.array(uuid).min(1).max(100),
  toExternal: z.object({
    officer: z.string().trim().min(2).max(160),
    badge: z.string().trim().max(60).optional(),
    ps: z.string().trim().min(2).max(160),
    firNo: z.string().trim().max(60).optional(),
    caseNo: z.string().trim().max(80).optional(),
    requisitionRef: z.string().trim().min(2).max(300),
  }),
  witnessId: uuid.optional(),
  bsa63CertificateRef: z.string().trim().max(300).optional(),
});
export type HandoverRequest = z.infer<typeof handoverSchema>;

export const reportSchema = z.object({
  kind: z.enum(REPORT_KINDS),
  templateRef: z.string().trim().max(120).optional(),
  /** The structured findings the document renders from. */
  content: z.record(z.string(), z.unknown()),
});
export type ReportRequest = z.infer<typeof reportSchema>;

export const signReportSchema = z.object({
  documentRef: z.string().trim().min(2).max(300),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u, 'A SHA-256 digest is 64 lowercase hex characters'),
  /** Absent means the DSC was unavailable: the report is `final_wet_signed`. */
  dscRef: z.string().trim().max(200).optional(),
});
export type SignReportRequest = z.infer<typeof signReportSchema>;

/** The addendum reason rides in `x-reason`. */
export const addendumSchema = reportSchema.extend({ addendumOf: uuid });
export type AddendumRequest = z.infer<typeof addendumSchema>;

export const requestSchema = z.object({
  kind: z.enum(['injury_report', 'history', 'certified_copy', 'evidence', 'testimony', 'other']),
  requester: z.object({
    name: z.string().trim().max(160).optional(),
    badge: z.string().trim().max(60).optional(),
    ps: z.string().trim().max(160).optional(),
    court: z.string().trim().max(200).optional(),
    caseNo: z.string().trim().max(80).optional(),
    designation: z.string().trim().max(120).optional(),
  }),
  authorityRef: z.string().trim().max(300).optional(),
});
export type RequestRequest = z.infer<typeof requestSchema>;

export const answerRequestSchema = z.object({
  providedDocRefs: z.array(z.string().trim().max(300)).max(20).default([]),
  deniedReason: z.string().trim().max(2000).optional(),
});
export type AnswerRequestRequest = z.infer<typeof answerRequestSchema>;

export const dyingDeclarationSchema = z.object({
  magistrate: z
    .object({
      name: z.string().trim().max(160),
      designation: z.string().trim().max(120).optional(),
      court: z.string().trim().max(200).optional(),
      phone: z.string().trim().max(20).optional(),
    })
    .optional(),
  /** `fit` | `unfit`. The hospital certifies this and nothing else. */
  fitnessOpinion: z.enum(['fit', 'unfit']).optional(),
  vitalsSnapshot: z.record(z.string(), z.unknown()).optional(),
  recordedByExternal: z.string().trim().max(200).optional(),
});
export type DyingDeclarationRequest = z.infer<typeof dyingDeclarationSchema>;

/**
 * The MoHFW sexual-assault protocol.
 *
 * There is no field for a two-finger test, for "virginity", or for whether the
 * survivor is "habituated". Not omitted from the UI — absent from the contract,
 * and refused by the database if it arrives inside the proforma JSON anyway.
 */
export const sexualAssaultSchema = z.object({
  survivorAgeBand: z.enum(['under_12', '12_to_18', '18_to_25', '25_to_45', 'over_45']),
  isPocso: z.boolean().default(false),
  consentMatrix: z.object({
    examination: z.boolean(),
    evidenceCollection: z.boolean(),
    policeInformation: z.boolean(),
    photography: z.boolean().default(false),
    consentGivenBy: z.enum(['survivor', 'guardian', 'assent_with_guardian']).default('survivor'),
    guardianName: z.string().trim().max(160).optional(),
  }),
  chaperoneId: uuid.optional(),
  examProforma: z.record(z.string(), z.unknown()).optional(),
  safeKitChecklist: z.record(z.string(), z.unknown()).optional(),
  prophylaxis: z
    .object({
      emergencyContraception: z.boolean().optional(),
      hivPep: z.boolean().optional(),
      hivPepHoursFromIncident: z.coerce.number().min(0).max(720).optional(),
      sti: z.boolean().optional(),
      tetanus: z.boolean().optional(),
      hepatitisB: z.boolean().optional(),
    })
    .optional(),
  pregnancyTest: z.enum(['positive', 'negative', 'not_done', 'declined']).optional(),
  referrals: z
    .object({
      counsellor: z.boolean().optional(),
      oneStopCentre: z.boolean().optional(),
      legalAid: z.boolean().optional(),
      cwc: z.boolean().optional(),
    })
    .optional(),
  policeInformed: z.enum(['yes_consent', 'declined_adult', 'mandatory_pocso']),
  sjpuCwcIntimation: z
    .object({
      sjpuInformedAt: z.string().datetime({ offset: true }).optional(),
      cwcInformedAt: z.string().datetime({ offset: true }).optional(),
      reference: z.string().trim().max(120).optional(),
    })
    .optional(),
});
export type SexualAssaultRequest = z.infer<typeof sexualAssaultSchema>;

export const deathSchema = z.object({
  kind: z.enum(['brought_dead', 'died_in_hospital']),
  declaredAt: z.string().datetime({ offset: true }),
  provisionalCause: z.string().trim().max(300).optional(),
  mannerSuspected: z
    .enum(['natural', 'accident', 'suicide', 'homicide', 'undetermined'])
    .default('undetermined'),
  pmRequired: z.enum(['yes', 'no', 'pending']).default('pending'),
  bodyCustody: z.enum(['mortuary', 'police', 'released_to_relatives_with_noc']).default('mortuary'),
  nocNo: z.string().trim().max(60).optional(),
  mortuaryCaseId: uuid.optional(),
});
export type DeathRequest = z.infer<typeof deathSchema>;

/** The override reason rides in `x-reason`. */
export const overrideGateSchema = z.object({});
export type OverrideGateRequest = z.infer<typeof overrideGateSchema>;

export const worklistQuerySchema = z.object({
  kind: z
    .enum(['intimation_due', 'reports_pending', 'evidence_awaiting_police', 'court_dates'])
    .default('intimation_due'),
  limit: pageLimit,
});
export type WorklistQuery = z.infer<typeof worklistQuerySchema>;
