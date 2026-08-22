import { z } from 'zod';

/**
 * Request contracts for OP-008 (RIS), EN-008 (PACS) and OP-022 (investigation
 * console).
 *
 * Two properties of this file are load-bearing rather than stylistic.
 *
 * **Every object is `.strict()`.** A Zod object is permissive by default, which
 * in this module would mean a client could post a field the product has no
 * column for and get a 200 back. For most modules that is untidy. Here it is the
 * difference between "the schema has no place to record foetal sex" and "the API
 * silently accepted one and threw it away" — and `phase-03 §Non-negotiables 4`
 * asks for the former. `.strict()` turns an unknown key into a 400 that names
 * it.
 *
 * **`FOETAL_SEX_PATTERN` is a refusal, not a sanitiser.** It never rewrites
 * text. Section 5 of the PC-PNDT Act 1994 prohibits communicating the sex of a
 * foetus "in any manner"; a product that quietly stripped the phrase and stored
 * the rest would be helping to communicate it in the manner that remained. The
 * request is refused whole, and the refusal names the statute.
 */

const uuid = z.string().uuid();
const shortText = (max: number) => z.string().trim().min(1).max(max);
const reason = z.string().trim().min(8, 'Give a reason somebody reading the register can act on').max(1000);

export const idSchema = uuid;

/**
 * The phrases a foetal-sex disclosure actually takes in an Indian ultrasound
 * report, in the two forms a report is written in.
 *
 * Deliberately narrow. `migration.sql §C.7` makes the same choice for the column
 * -name assertion and says why: a pattern that matched the bare word "sex"
 * would fire on "sex of the patient", which every DICOM worklist entry legally
 * carries, and a control that fires on lawful work is a control people learn to
 * route around.
 */
export const FOETAL_SEX_PATTERN =
  /\b(fo?etal\s+(sex|gender)|sex\s+of\s+(the\s+)?(fo?etus|baby|child)|gender\s+of\s+(the\s+)?(fo?etus|baby|child)|sex\s+determination|sex\s+selection|(fo?etus|baby)\s+is\s+a\s+(boy|girl)|male\s+fo?etus|female\s+fo?etus)\b/i;

export function mentionsFoetalSex(...values: readonly (string | null | undefined)[]): boolean {
  return values.some((v) => typeof v === 'string' && FOETAL_SEX_PATTERN.test(v));
}

// ── OP-008 §3.1 order intake ────────────────────────────────────────────────

export const RAD_PRIORITIES = ['routine', 'urgent', 'stat', 'portable_stat'] as const;
export const RAD_SOURCES = [
  'opd',
  'er',
  'ip',
  'icu',
  'ot',
  'walkin',
  'external',
  'health_checkup',
  'portal',
] as const;
export const LATERALITIES = ['left', 'right', 'bilateral', 'not_applicable'] as const;
export const PREGNANCY_STATUSES = ['unknown', 'no', 'yes', 'possible'] as const;
export const DOSE_SOURCES = ['rdsr', 'header', 'mpps', 'ocr', 'manual'] as const;
export const NOTIFY_METHODS = ['phone', 'in_person', 'secure_message', 'video', 'pager', 'sms'] as const;
export const SIGN_METHODS = ['system', 'dsc', 'aadhaar_esign', 'webauthn', 'countersign'] as const;
export const FINDING_LEVELS = ['none', 'incidental', 'urgent', 'critical'] as const;

export const radOrderItemSchema = z
  .object({
    /** `mdm.mdm_rad_procedures.record_key`. The master, not a free-text procedure. */
    procedureKey: uuid,
    laterality: z.enum(LATERALITIES).default('not_applicable'),
    contrast: z.boolean().default(false),
    views: z.array(shortText(60)).max(12).default([]),
    bodyPartDicom: shortText(64).optional(),
  })
  .strict();

export const createRadOrderSchema = z
  .object({
    patientId: uuid,
    branchId: uuid.optional(),
    visitId: uuid.optional(),
    encounterId: uuid.optional(),
    admissionId: uuid.optional(),
    erVisitId: uuid.optional(),
    clinicalOrderId: uuid.optional(),
    source: z.enum(RAD_SOURCES).default('opd'),
    priority: z.enum(RAD_PRIORITIES).default('routine'),
    /**
     * OP-008 §5: mandatory. An imaging request with no question is an exposure
     * with no justification, and the AERB inspection asks for the justification.
     */
    clinicalIndication: z.string().trim().min(3).max(4000),
    questionsToAnswer: z.string().trim().max(4000).optional(),
    icdCodes: z.array(shortText(16)).max(20).default([]),
    isMlc: z.boolean().default(false),
    transportMode: shortText(32).optional(),
    isolation: shortText(64).optional(),
    externalReferrer: shortText(300).optional(),
    items: z.array(radOrderItemSchema).min(1).max(20),
  })
  .strict();

export const safetyScreenSchema = z
  .object({
    pregnancyStatus: z.enum(PREGNANCY_STATUSES).optional(),
    lmpDate: z.string().date().optional(),
    radiationJustification: z.string().trim().max(4000).optional(),
    pregnancyConsentDocId: uuid.optional(),
    contrastRequired: z.boolean().optional(),
    egfr: z.number().min(0).max(250).optional(),
    contrastAllergyKnown: z.boolean().optional(),
    premedProtocolKey: uuid.optional(),
    metforminHoldAdvised: z.boolean().optional(),
    /** OP-008 §5: an override is a named person **and** a reason, in both directions. */
    contrastApprovalReason: reason.optional(),
    mriSafetyCompleted: z.boolean().optional(),
    mriSafetyAnswers: z.record(z.string(), z.unknown()).optional(),
    mriUnsafeImplant: z.boolean().optional(),
    mriOverrideReason: reason.optional(),
    sedationRequired: z.boolean().optional(),
  })
  .strict();

export const cancelRadOrderSchema = z
  .object({ reason, afterAcquisitionApprovedBy: uuid.optional() })
  .strict();

export const createAppointmentSchema = z
  .object({
    orderItemId: uuid,
    roomId: uuid,
    startAt: z.string().datetime({ offset: true }),
    endAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const checkInSchema = z.object({ roomId: uuid.optional() }).strict();

export const publishMwlSchema = z
  .object({
    roomId: uuid,
    scheduledAt: z.string().datetime({ offset: true }).optional(),
    /** EN-008 §5: entries expire 24 h after schedule by default. */
    expiresInHours: z.number().int().min(1).max(168).default(24),
  })
  .strict();

export const withdrawMwlSchema = z
  .object({ cause: z.enum(['completed', 'cancelled', 'expired']), reason })
  .strict();

export const radOrderQuerySchema = z
  .object({
    patientId: uuid.optional(),
    status: z.string().trim().max(32).optional(),
    modality: z.string().trim().max(8).optional(),
    priority: z.enum(RAD_PRIORITIES).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().max(2000).optional(),
  })
  .strict();

// ── OP-008 §3.3 acquisition ─────────────────────────────────────────────────

export const startExamSchema = z
  .object({
    roomId: uuid,
    protocolName: shortText(200).optional(),
    /**
     * OP-008 §3.3.2 "identity 2-check". Both are required before acquisition and
     * the CHECK on `rad_exams` refuses a `started_at` without them — this is the
     * door, not the lock.
     */
    identityVerified: z.literal(true),
    identityMethod: shortText(64),
    safetyChecklistCompleted: z.literal(true),
    isEmergencyPlaceholder: z.boolean().default(false),
  })
  .strict();

export const completeExamSchema = z
  .object({ technologistNotes: z.string().trim().max(4000).optional() })
  .strict();

export const repeatExposureSchema = z
  .object({
    kind: z.enum(['repeat', 'reject']),
    reasonCode: z.enum(['positioning', 'exposure', 'motion', 'artefact', 'equipment', 'patient', 'other']),
    reasonNote: z.string().trim().max(1000).optional(),
    viewName: shortText(120).optional(),
  })
  .strict()
  .refine((v) => v.reasonCode !== 'other' || (v.reasonNote?.length ?? 0) > 0, {
    message: 'A repeat logged as "other" must say what it was; AERB QA cannot audit an unnamed reason.',
    path: ['reasonNote'],
  });

export const contrastSchema = z
  .object({
    agentName: shortText(200),
    agentKey: uuid.optional(),
    volumeMl: z.number().positive().max(1000).optional(),
    concentration: shortText(64).optional(),
    /** OP-008 §3.3.2: a recall that cannot name the lot is a recall of every patient. */
    lotNo: shortText(64),
    expiryDate: z.string().date().optional(),
    route: shortText(32).optional(),
    injectorName: shortText(120).optional(),
    flowRateMlS: z.number().positive().max(100).optional(),
    reactionObserved: z.boolean().default(false),
    reactionSeverity: z.enum(['mild', 'moderate', 'severe']).optional(),
    reactionDescription: z.string().trim().max(2000).optional(),
  })
  .strict()
  .refine(
    (v) => !v.reactionObserved || (v.reactionSeverity !== undefined && v.reactionDescription !== undefined),
    {
      message: 'A reaction becomes an allergy record and an incident; it needs a severity and a description.',
      path: ['reactionSeverity'],
    },
  );

export const doseSchema = z
  .object({
    source: z.enum(DOSE_SOURCES),
    rdsrInstanceUid: z
      .string()
      .regex(/^[0-9]+(\.[0-9]+)+$/)
      .max(64)
      .optional(),
    protocolName: shortText(200).optional(),
    ctdivolMgy: z.number().nonnegative().max(100000).optional(),
    dlpMgycm: z.number().nonnegative().max(1000000).optional(),
    dapGycm2: z.number().nonnegative().max(1000000).optional(),
    kvp: z.number().nonnegative().max(1000).optional(),
    mas: z.number().nonnegative().max(100000).optional(),
    exposureCount: z.number().int().nonnegative().max(10000).optional(),
    fluoroTimeS: z.number().nonnegative().max(100000).optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.ctdivolMgy !== undefined ||
      v.dlpMgycm !== undefined ||
      v.dapGycm2 !== undefined ||
      v.exposureCount !== undefined,
    {
      message: 'A dose record with no dose in it is a form somebody clicked through.',
      path: ['dlpMgycm'],
    },
  )
  .refine((v) => v.source !== 'rdsr' || v.rdsrInstanceUid !== undefined, {
    message: 'An RDSR-sourced dose names the SOP Instance UID it was parsed from.',
    path: ['rdsrInstanceUid'],
  });

// ── PC-PNDT Form F (OP-008 §5, PC-PNDT Act 1994) ────────────────────────────

/**
 * Form F, and nothing beyond Form F.
 *
 * `.strict()` matters more here than anywhere else in the product: it is the
 * mechanical half of "no sex-determination field exists anywhere". The other
 * half is the migration's `information_schema` assertion, which refuses to apply
 * if such a column ever appears. Between them, there is no column to write to
 * and no request field that would reach one.
 */
export const formFSchema = z
  .object({
    patientName: shortText(300),
    patientAgeYears: z.number().int().min(10).max(70),
    husbandOrFatherName: shortText(300),
    fullAddress: z.string().trim().min(5).max(2000),
    identityDocumentType: shortText(64),
    /** Masked at the door: the register needs a reference, not the number itself. */
    identityDocumentRefMasked: shortText(64),
    gravida: z.number().int().min(0).max(30).optional(),
    para: z.number().int().min(0).max(30).optional(),
    livingChildren: z.number().int().min(0).max(30).optional(),
    previousAbortions: z.number().int().min(0).max(30).optional(),
    gestationalAgeWeeks: z.number().positive().max(45).optional(),
    lastMenstrualPeriod: z.string().date().optional(),
    referringDoctorName: shortText(300),
    referringDoctorRegistrationNo: shortText(64).optional(),
    /** Rule 10: the Form prescribes the lawful indications. "Routine" is not one. */
    indicationCodes: z.array(shortText(64)).min(1).max(20),
    indicationOther: z.string().trim().max(2000).optional(),
    proceduresPerformed: z.array(shortText(120)).min(1).max(20),
    facilityRegistrationNo: shortText(64),
    machineRegistrationNo: shortText(64),
    performedByName: shortText(300),
    performedByRegistrationNo: shortText(64),
    performedAt: z.string().datetime({ offset: true }),
    womanDeclarationSigned: z.boolean().default(false),
    womanDeclarationDocId: uuid.optional(),
    doctorDeclarationSigned: z.boolean().default(false),
    doctorDeclarationDocId: uuid.optional(),
  })
  .strict()
  .refine((v) => !v.womanDeclarationSigned || v.womanDeclarationDocId !== undefined, {
    message: 'A signed declaration carries the signed document. A tick with nothing behind it is not one.',
    path: ['womanDeclarationDocId'],
  })
  .refine((v) => !v.doctorDeclarationSigned || v.doctorDeclarationDocId !== undefined, {
    message: 'A signed declaration carries the signed document. A tick with nothing behind it is not one.',
    path: ['doctorDeclarationDocId'],
  });

// ── OP-008 §3.4 reporting ───────────────────────────────────────────────────

export const createReportSchema = z
  .object({
    orderItemId: uuid,
    templateKey: uuid.optional(),
    content: z.record(z.string(), z.unknown()).default({}),
    findingsText: z.string().trim().max(20000).optional(),
    impressionText: z.string().trim().max(8000).optional(),
    recommendations: z.string().trim().max(4000).optional(),
    biRads: shortText(8).optional(),
    tiRads: shortText(8).optional(),
    liRads: shortText(8).optional(),
    pirads: shortText(8).optional(),
    findingLevel: z.enum(FINDING_LEVELS).default('none'),
    keyImageRefs: z.array(shortText(64)).max(40).default([]),
    measurements: z.record(z.string(), z.unknown()).optional(),
    /** OP-008 §3.4.2: a resident drafts and the consultant finalises. */
    requestCosign: z.boolean().default(false),
  })
  .strict();

export const updateReportSchema = createReportSchema
  .omit({ orderItemId: true, requestCosign: true })
  .partial()
  .strict();

export const signReportSchema = z
  .object({
    signMethod: z.enum(SIGN_METHODS).default('system'),
    impressionText: z.string().trim().min(1).max(8000).optional(),
    findingLevel: z.enum(FINDING_LEVELS).optional(),
  })
  .strict();

export const amendReportSchema = z
  .object({
    reason,
    signMethod: z.enum(SIGN_METHODS).default('system'),
    content: z.record(z.string(), z.unknown()).default({}),
    findingsText: z.string().trim().max(20000).optional(),
    impressionText: z.string().trim().min(1).max(8000),
    recommendations: z.string().trim().max(4000).optional(),
    findingLevel: z.enum(FINDING_LEVELS).default('none'),
  })
  .strict();

export const criticalFindingSchema = z
  .object({
    level: z.enum(['incidental', 'urgent', 'critical']),
    findingText: z.string().trim().min(3).max(4000),
    orderingUserId: uuid.optional(),
    dueInMinutes: z.number().int().min(1).max(1440).default(60),
  })
  .strict();

/**
 * `docs/DECISIONS.md D-10`, in a request contract.
 *
 * Two arms and no third. Either somebody was told and repeated it back, or
 * nobody could be reached and the alert was escalated to a named tier. The
 * `CHECK` on `rad_critical_callbacks` says the same thing in SQL and is the
 * actual guarantee; this refinement exists so the caller gets a sentence rather
 * than a constraint name, and so the escalation arm is exactly as easy to fill
 * in as the read-back arm — if it were harder, the pressure would fall back onto
 * withholding the report, which is the hazard D-10 exists to remove.
 */
export const criticalCallbackSchema = z
  .object({
    method: z.enum(NOTIFY_METHODS),
    notifiedToUserId: uuid.optional(),
    notifiedToName: shortText(200).optional(),
    notifiedToRole: shortText(64).optional(),
    notifiedToContact: shortText(64).optional(),
    readBackConfirmed: z.boolean().default(false),
    readBackValue: shortText(300).optional(),
    clinicianUnreachable: z.boolean().default(false),
    escalatedToLevel: z.number().int().min(1).max(9).optional(),
    escalatedToRole: shortText(64).optional(),
    escalatedToUserId: uuid.optional(),
    attemptCount: z.number().int().min(1).max(50).default(1),
    remarks: z.string().trim().max(2000).optional(),
  })
  .strict()
  .refine(
    (v) =>
      (v.readBackConfirmed &&
        !v.clinicianUnreachable &&
        v.notifiedToName !== undefined &&
        v.readBackValue !== undefined) ||
      (v.clinicianUnreachable &&
        !v.readBackConfirmed &&
        v.escalatedToLevel !== undefined &&
        v.escalatedToRole !== undefined),
    {
      message:
        'A critical-finding communication is either a confirmed read-back from a named clinician (name + what they read back) or a documented "clinician unreachable — escalated to <tier>". There is no third state.',
      path: ['readBackConfirmed'],
    },
  );

export const peerReviewSchema = z
  .object({
    score: z.number().int().min(1).max(3),
    discrepancyType: z.enum(['none', 'minor', 'major']),
    comment: z.string().trim().max(4000).optional(),
    samplingBasis: shortText(64).optional(),
    isPrelimFinalComparison: z.boolean().default(false),
    prelimVersion: z.number().int().positive().optional(),
    finalVersion: z.number().int().positive().optional(),
  })
  .strict();

export const worklistQuerySchema = z
  .object({
    modality: z.string().trim().max(8).optional(),
    status: z.string().trim().max(32).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().max(2000).optional(),
  })
  .strict();

// ── EN-008 PACS ─────────────────────────────────────────────────────────────

export const ingestStudySchema = z
  .object({
    studyInstanceUid: z
      .string()
      .regex(/^[0-9]+(\.[0-9]+)+$/)
      .max(64),
    orthancId: shortText(64).optional(),
    serverId: uuid.optional(),
    accessionNo: shortText(32).optional(),
    /** The DICOM PatientID as it arrived — the UHID, or an ER tag. Never a name match. */
    uhidAtAcquisition: shortText(32).optional(),
    modality: shortText(8).optional(),
    bodyPartDicom: shortText(64).optional(),
    studyDate: z.string().datetime({ offset: true }).optional(),
    description: shortText(300).optional(),
    series: z
      .array(
        z
          .object({
            seriesInstanceUid: z
              .string()
              .regex(/^[0-9]+(\.[0-9]+)+$/)
              .max(64),
            seriesNumber: z.number().int().min(0).max(100000).optional(),
            orthancId: shortText(64).optional(),
            modality: shortText(8).optional(),
            description: shortText(300).optional(),
            sopClassUid: z
              .string()
              .regex(/^[0-9]+(\.[0-9]+)+$/)
              .max(64)
              .optional(),
            isDoseSr: z.boolean().default(false),
            isStructuredReport: z.boolean().default(false),
            instances: z
              .array(
                z
                  .object({
                    sopInstanceUid: z
                      .string()
                      .regex(/^[0-9]+(\.[0-9]+)+$/)
                      .max(64),
                    sopClassUid: z
                      .string()
                      .regex(/^[0-9]+(\.[0-9]+)+$/)
                      .max(64)
                      .optional(),
                    instanceNumber: z.number().int().min(0).max(1000000).optional(),
                    orthancId: shortText(64).optional(),
                    sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
                    transferSyntaxUid: z
                      .string()
                      .regex(/^[0-9]+(\.[0-9]+)+$/)
                      .max(64)
                      .optional(),
                    numberOfFrames: z.number().int().positive().max(100000).optional(),
                    isRdsr: z.boolean().default(false),
                  })
                  .strict(),
              )
              .max(2000)
              .default([]),
          })
          .strict(),
      )
      .max(200)
      .default([]),
  })
  .strict();

export const mppsSchema = z
  .object({
    sopInstanceUid: z
      .string()
      .regex(/^[0-9]+(\.[0-9]+)+$/)
      .max(64),
    studyInstanceUid: z
      .string()
      .regex(/^[0-9]+(\.[0-9]+)+$/)
      .max(64)
      .optional(),
    accessionNo: shortText(32).optional(),
    modalityAet: shortText(16),
    status: z.enum(['IN PROGRESS', 'COMPLETED', 'DISCONTINUED']),
    startedAt: z.string().datetime({ offset: true }).optional(),
    endedAt: z.string().datetime({ offset: true }).optional(),
    discontinueReason: shortText(200).optional(),
  })
  .strict()
  .refine((v) => v.status !== 'DISCONTINUED' || v.discontinueReason !== undefined, {
    message: 'A discontinued procedure step says why; that is the AERB and QA record.',
    path: ['discontinueReason'],
  });

/**
 * EN-008 §5: "never silently attach to wrong patient".
 *
 * `patientId` is optional and that is the whole design. Confirming a match the
 * archive made on the accession number or the Study Instance UID is a
 * legitimate one-click action. Confirming a *fallback* match is not: a fallback
 * match is a guess made on demographics, so the human confirming it must state
 * which patient they mean. The service refuses the second case; the CHECK on
 * `pacs_studies` refuses it again if the service ever forgets.
 */
export const reconcileStudySchema = z
  .object({
    patientId: uuid.optional(),
    orderItemId: uuid.optional(),
    note: z.string().trim().max(2000).optional(),
  })
  .strict();

export const viewerTokenSchema = z
  .object({
    action: z.enum(['view', 'download', 'export', 'annotate', 'print']).default('view'),
    scope: z.enum(['view', 'download']).default('view'),
    expiresInMinutes: z.number().int().min(1).max(1440).default(15),
  })
  .strict();

export const shareLinkSchema = z
  .object({
    patientId: uuid,
    studyIds: z.array(uuid).min(1).max(50),
    consentId: uuid,
    channel: z.enum(['patient', 'referrer', 'telerad', 'insurer']),
    recipientName: shortText(200).optional(),
    recipientContactMasked: shortText(64).optional(),
    expiresInDays: z.number().int().min(1).max(30).default(7),
    maxViews: z.number().int().min(1).max(100).default(10),
  })
  .strict();

export const revokeShareLinkSchema = z.object({ reason }).strict();

export const studyQuerySchema = z
  .object({
    patientId: uuid.optional(),
    reconciliationStatus: z.enum(['matched', 'needs_review', 'reconciled', 'rejected']).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().max(2000).optional(),
  })
  .strict();

export const purgePlanSchema = z
  .object({
    policyId: uuid.optional(),
    plannedAt: z.string().datetime({ offset: true }),
    studyIds: z.array(uuid).min(1).max(500),
  })
  .strict();

// ── OP-022 investigation console ────────────────────────────────────────────

export const MODALITY_GROUPS = [
  'usg_non_dicom',
  'ecg',
  'tmt',
  'echo',
  'holter',
  'pft',
  'audiometry',
  'eeg',
  'ncv',
  'emg',
  'endoscopy',
  'colonoscopy',
  'bronchoscopy',
  'fundus',
  'oct',
  'dental_xray',
  'dermatoscopy',
  'clinical_photo',
  'external_report',
  'other',
] as const;

export const createInvestigationStudySchema = z
  .object({
    patientId: uuid,
    branchId: uuid.optional(),
    serviceKey: uuid,
    clinicalOrderId: uuid.optional(),
    visitId: uuid.optional(),
    encounterId: uuid.optional(),
    priority: z.enum(['routine', 'urgent', 'stat']).default('routine'),
    scheduledAt: z.string().datetime({ offset: true }).optional(),
    deviceRef: uuid.optional(),
  })
  .strict();

export const startInvestigationSchema = z
  .object({ identityVerified: z.literal(true), identityMethod: shortText(64) })
  .strict();

export const doneInvestigationSchema = z
  .object({
    techniqueNotes: z.string().trim().max(4000).optional(),
    /** OP-022 §5: a repeat says why; the dose, if any, goes to the OP-008 register. */
    repeatFlag: z.boolean().default(false),
    repeatReason: z.string().trim().max(2000).optional(),
    doseRecordRef: uuid.optional(),
  })
  .strict()
  .refine((v) => !v.repeatFlag || v.repeatReason !== undefined, {
    message: 'A repeat needs a reason.',
    path: ['repeatReason'],
  });

export const investigationMediaSchema = z
  .object({
    kind: z.enum(['dicom', 'jpeg', 'png', 'tiff', 'pdf', 'video', 'audio', 'waveform', 'other']),
    fileId: uuid,
    mimeType: shortText(120),
    sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
    thumbnailFileId: uuid.optional(),
    durationSeconds: z.number().nonnegative().max(360000).optional(),
    sequenceNo: z.number().int().min(0).max(10000).default(0),
    source: z
      .enum(['upload', 'watch_folder', 'capture', 'dicom', 'device_gateway', 'external'])
      .default('upload'),
    sopInstanceUid: z
      .string()
      .regex(/^[0-9]+(\.[0-9]+)+$/)
      .max(64)
      .optional(),
  })
  .strict();

export const detachMediaSchema = z.object({ reason }).strict();

export const investigationReportSchema = z
  .object({
    templateKey: uuid.optional(),
    body: z.record(z.string(), z.unknown()).default({}),
    impression: z.string().trim().max(8000).optional(),
    critical: z.boolean().default(false),
  })
  .strict();

export const signInvestigationReportSchema = z
  .object({
    signMethod: z.enum(SIGN_METHODS).default('system'),
    impression: z.string().trim().min(1).max(8000).optional(),
    /**
     * OP-022 §5: the PC-PNDT keyword validator's verdict is recorded, and only a
     * named authorised doctor may override a failure, with a reason. Unlike
     * radiology — where no such field exists to override — an investigation
     * service may legitimately be an obstetric ultrasound written on a non-DICOM
     * machine, so the Act's text check lives here with its override trail.
     */
    pcpndtOverrideReason: reason.optional(),
  })
  .strict();

export const cosignInvestigationReportSchema = z
  .object({
    signMethod: z.enum(SIGN_METHODS).default('countersign'),
    discrepancy: z.enum(['none', 'minor', 'major']).default('none'),
    cosignChanges: z.record(z.string(), z.unknown()).optional(),
    impression: z.string().trim().min(1).max(8000).optional(),
  })
  .strict();

export const amendInvestigationReportSchema = z
  .object({
    reason,
    signMethod: z.enum(SIGN_METHODS).default('system'),
    body: z.record(z.string(), z.unknown()).default({}),
    impression: z.string().trim().min(1).max(8000),
    critical: z.boolean().default(false),
  })
  .strict();

export const investigationWorklistQuerySchema = z
  .object({
    status: z.string().trim().max(32).optional(),
    modalityGroup: z.enum(MODALITY_GROUPS).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().max(2000).optional(),
  })
  .strict();

export type CreateRadOrderRequest = z.infer<typeof createRadOrderSchema>;
export type SafetyScreenRequest = z.infer<typeof safetyScreenSchema>;
export type CancelRadOrderRequest = z.infer<typeof cancelRadOrderSchema>;
export type CreateAppointmentRequest = z.infer<typeof createAppointmentSchema>;
export type CheckInRequest = z.infer<typeof checkInSchema>;
export type PublishMwlRequest = z.infer<typeof publishMwlSchema>;
export type WithdrawMwlRequest = z.infer<typeof withdrawMwlSchema>;
export type RadOrderQuery = z.infer<typeof radOrderQuerySchema>;
export type StartExamRequest = z.infer<typeof startExamSchema>;
export type CompleteExamRequest = z.infer<typeof completeExamSchema>;
export type RepeatExposureRequest = z.infer<typeof repeatExposureSchema>;
export type ContrastRequest = z.infer<typeof contrastSchema>;
export type DoseRequest = z.infer<typeof doseSchema>;
export type FormFRequest = z.infer<typeof formFSchema>;
export type CreateReportRequest = z.infer<typeof createReportSchema>;
export type UpdateReportRequest = z.infer<typeof updateReportSchema>;
export type SignReportRequest = z.infer<typeof signReportSchema>;
export type AmendReportRequest = z.infer<typeof amendReportSchema>;
export type CriticalFindingRequest = z.infer<typeof criticalFindingSchema>;
export type CriticalCallbackRequest = z.infer<typeof criticalCallbackSchema>;
export type PeerReviewRequest = z.infer<typeof peerReviewSchema>;
export type WorklistQuery = z.infer<typeof worklistQuerySchema>;
export type IngestStudyRequest = z.infer<typeof ingestStudySchema>;
export type MppsRequest = z.infer<typeof mppsSchema>;
export type ReconcileStudyRequest = z.infer<typeof reconcileStudySchema>;
export type ViewerTokenRequest = z.infer<typeof viewerTokenSchema>;
export type ShareLinkRequest = z.infer<typeof shareLinkSchema>;
export type RevokeShareLinkRequest = z.infer<typeof revokeShareLinkSchema>;
export type StudyQuery = z.infer<typeof studyQuerySchema>;
export type PurgePlanRequest = z.infer<typeof purgePlanSchema>;
export type CreateInvestigationStudyRequest = z.infer<typeof createInvestigationStudySchema>;
export type StartInvestigationRequest = z.infer<typeof startInvestigationSchema>;
export type DoneInvestigationRequest = z.infer<typeof doneInvestigationSchema>;
export type InvestigationMediaRequest = z.infer<typeof investigationMediaSchema>;
export type DetachMediaRequest = z.infer<typeof detachMediaSchema>;
export type InvestigationReportRequest = z.infer<typeof investigationReportSchema>;
export type SignInvestigationReportRequest = z.infer<typeof signInvestigationReportSchema>;
export type CosignInvestigationReportRequest = z.infer<typeof cosignInvestigationReportSchema>;
export type AmendInvestigationReportRequest = z.infer<typeof amendInvestigationReportSchema>;
export type InvestigationWorklistQuery = z.infer<typeof investigationWorklistQuerySchema>;
