import { z } from 'zod';

/**
 * Request contracts for OP-004 — the order-to-report path.
 *
 * Three of these carry a laboratory rule rather than a shape rule, and each is
 * here so the caller gets a field error instead of a constraint violation from
 * four layers down:
 *
 *  * `collectSampleSchema` refuses a collection that has neither two scans nor a
 *    named override reason. `lab_samples_two_identifier_check` says the same
 *    thing in SQL; saying it here is what turns "23514" into "scan the wristband
 *    or record why you could not".
 *  * `criticalCallbackSchema` is `docs/DECISIONS.md D-10` as a discriminated
 *    union: a read-back names the person and repeats the value, an unreachable
 *    entry names the tier it was escalated to, and **neither-and-both are both
 *    unparseable** — the same shape as the `lab_critical_value_callbacks_evidence`
 *    CHECK, which is the backstop rather than the mechanism.
 *  * `qcActionSchema` requires an authoriser and a reason when the impact is
 *    `released_with_authorisation`, because that arm is `EN-031 §5`'s single
 *    lawful exception to the release gate and it must be storable only as
 *    evidence.
 */

const uuid = z.string().uuid();
const reason = z.string().trim().min(8, 'Give a reason somebody reading the register can act on').max(1000);
const cursor = z.string().max(2000).optional();
const pageLimit = z.coerce.number().int().min(1).max(100).default(25);

export const LAB_SOURCES = [
  'opd',
  'er',
  'ip',
  'icu',
  'health_checkup',
  'walkin',
  'portal',
  'home_collection',
  'camp',
  'referred_in',
  'standing_order',
] as const;

export const LAB_PRIORITIES = ['routine', 'urgent', 'stat'] as const;

export const LAB_DISCIPLINES = [
  'biochemistry',
  'haematology',
  'clinical_pathology',
  'microbiology',
  'serology',
  'immunology',
  'histopathology',
  'cytopathology',
  'molecular',
  'genetics',
  'blood_bank',
  'outsourced',
] as const;

export const LAB_COLLECTION_SITES = [
  'opd_collection_room',
  'ward',
  'icu',
  'er',
  'ot',
  'home',
  'camp',
  'external',
  'other',
] as const;

export const LAB_SAMPLE_CONDITIONS = [
  'satisfactory',
  'haemolysed',
  'lipaemic',
  'icteric',
  'clotted',
  'insufficient',
  'leaked',
  'unlabelled',
  'mislabelled',
  'wrong_container',
  'delayed',
  'temperature_excursion',
  'contaminated',
] as const;

export const LAB_RESULT_TYPES = [
  'numeric',
  'semi_quantitative',
  'qualitative',
  'coded',
  'text',
  'multiselect',
  'calculated',
] as const;

export const LAB_NOTIFY_METHODS = ['phone', 'in_person', 'secure_message', 'video', 'pager', 'sms'] as const;

export const LAB_REPORT_TYPES = ['interim', 'departmental', 'final', 'amended', 'cumulative'] as const;

export const WESTGARD_RULES = [
  'r_1_2s',
  'r_1_3s',
  'r_2_2s',
  'r_R_4s',
  'r_4_1s',
  'r_10x',
  'r_8x',
  'r_12x',
  'r_7T',
  'r_2of3_2s',
  'r_3_1s',
  'r_6x',
  'r_9x',
] as const;

export const QC_LEVELS = ['l1', 'l2', 'l3', 'l4', 'other'] as const;

export const QC_PATIENT_IMPACTS = [
  'none',
  'retest_all',
  'retest_selected',
  'released_with_authorisation',
] as const;

export const idSchema = z.string().uuid('That is not a valid identifier.');

/** A barcode is scanned, so it is short, printable and never a UUID. */
export const barcodeSchema = z.string().trim().min(1).max(64);

// ── orders ───────────────────────────────────────────────────────────────────

export const labOrderTestSchema = z.object({
  /** `mdm.mdm_lab_tests.record_key`. A panel expands here, not in the client. */
  testKey: uuid,
  /** `clinical.order_items.id` when this line fulfils a CPOE line. */
  orderItemId: uuid.optional(),
  priority: z.enum(LAB_PRIORITIES).optional(),
});

export const createLabOrderSchema = z.object({
  patientId: uuid,
  branchId: uuid.optional(),
  visitId: uuid.optional(),
  admissionId: uuid.optional(),
  erVisitId: uuid.optional(),
  encounterId: uuid.optional(),
  /** `clinical.orders.id`. Absent for a walk-in with an outside prescription. */
  clinicalOrderId: uuid.optional(),
  source: z.enum(LAB_SOURCES).default('opd'),
  priority: z.enum(LAB_PRIORITIES).default('routine'),
  orderingPractitionerKey: uuid.optional(),
  referringFacility: z.string().trim().max(300).optional(),
  referringDoctorName: z.string().trim().max(200).optional(),
  clinicalNotes: z.string().trim().max(4000).optional(),
  isMlc: z.boolean().default(false),
  mlcRef: z.string().trim().max(64).optional(),
  tests: z.array(labOrderTestSchema).min(1).max(60),
});

export const addOnTestsSchema = z.object({
  tests: z.array(labOrderTestSchema).min(1).max(30),
});

export const cancelTestsSchema = z.object({
  reason,
  /** Empty means the whole order. */
  orderTestIds: z.array(uuid).max(60).default([]),
});

export const labOrderQuerySchema = z.object({
  patientId: uuid.optional(),
  status: z.string().trim().max(32).optional(),
  priority: z.enum(LAB_PRIORITIES).optional(),
  cursor,
  limit: pageLimit,
});

// ── pre-analytical ───────────────────────────────────────────────────────────

export const issueLabelsSchema = z.object({
  /** A reprint is audited and must say why (`EN-013 §3`). */
  reprintReason: z.string().trim().min(4).max(300).optional(),
  printerId: uuid.optional(),
  copies: z.coerce.number().int().min(1).max(4).default(1),
});

export const collectSampleSchema = z
  .object({
    patientScanVerified: z.boolean().default(false),
    containerScanVerified: z.boolean().default(false),
    /**
     * `OP-004 §5`: the only route past the two scans, and it is audited. A
     * reason with no scans is a decision; no reason and no scans is a gap.
     */
    identityOverrideReason: z.string().trim().min(8).max(500).optional(),
    collectionSite: z.enum(LAB_COLLECTION_SITES).default('opd_collection_room'),
    fasting: z.boolean().optional(),
    fastingHours: z.number().min(0).max(72).optional(),
    drawAttempts: z.number().int().min(1).max(10).optional(),
    drawSite: z.string().trim().max(120).optional(),
  })
  .refine(
    (v) => (v.patientScanVerified && v.containerScanVerified) || v.identityOverrideReason !== undefined,
    {
      path: ['patientScanVerified'],
      message:
        'A collection is confirmed by scanning the patient and the container, or by recording why that was impossible. OP-004 §5 allows no third answer.',
    },
  );

export const receiveSampleSchema = z.object({
  conditionOnReceipt: z.enum(LAB_SAMPLE_CONDITIONS).default('satisfactory'),
  receiptTempC: z.number().min(-80).max(60).optional(),
});

export const accessionSampleSchema = z.object({
  storageLocation: z.string().trim().max(120).optional(),
});

export const rejectSampleSchema = z.object({
  /** `lab.lab_rejection_reasons.record_key`. Never free text — it is a KPI. */
  rejectionReasonKey: uuid,
  note: z.string().trim().max(1000).optional(),
  /**
   * Default true because `lab_rejection_reasons.requires_recollection` is the
   * hospital's answer and almost always true; this only lets a caller decline
   * one the master would otherwise raise (a duplicate order).
   */
  recollect: z.boolean().default(true),
});

// ── analytical ───────────────────────────────────────────────────────────────

export const resultEntrySchema = z.object({
  orderTestId: uuid,
  /** `mdm.mdm_lab_test_parameters.record_key`. Null for a single-analyte test. */
  parameterKey: uuid.optional(),
  resultType: z.enum(LAB_RESULT_TYPES).default('numeric'),
  valueNumeric: z.number().optional(),
  valueOperator: z.enum(['<', '>', '<=', '>=', '~']).optional(),
  valueCoded: z.string().trim().max(200).optional(),
  valueCodedSystem: z.string().trim().max(64).optional(),
  valueMulti: z.array(z.string().trim().max(200)).max(40).default([]),
  valueText: z.string().trim().max(8000).optional(),
  unit: z.string().trim().max(32).optional(),
  /** `integration.lab_instruments.id`. Set for an analyzer result. */
  instrumentId: uuid.optional(),
  runId: z.string().trim().max(64).optional(),
  instrumentFlags: z.array(z.string().trim().max(32)).max(20).default([]),
  dilutionFactor: z.number().positive().max(100000).optional(),
  comment: z.string().trim().max(2000).optional(),
});

export const enterResultsSchema = z.object({
  results: z.array(resultEntrySchema).min(1).max(100),
});

export const releaseResultsSchema = z.object({
  resultIds: z.array(uuid).min(1).max(100),
  /**
   * `EN-031 §5`'s single exception, named rather than implied: the
   * `lab.labq_qc_actions` row in which a Lab Director authorised release under
   * an out-of-control QC state. Anything else and the gate holds.
   */
  qcOverrideActionId: uuid.optional(),
  signMethod: z.enum(['system', 'dsc', 'aadhaar_esign', 'webauthn']).default('system'),
});

export const amendResultSchema = z.object({
  reason,
  resultType: z.enum(LAB_RESULT_TYPES).default('numeric'),
  valueNumeric: z.number().optional(),
  valueOperator: z.enum(['<', '>', '<=', '>=', '~']).optional(),
  valueCoded: z.string().trim().max(200).optional(),
  valueMulti: z.array(z.string().trim().max(200)).max(40).default([]),
  valueText: z.string().trim().max(8000).optional(),
  unit: z.string().trim().max(32).optional(),
  comment: z.string().trim().max(2000).optional(),
});

export const benchWorklistQuerySchema = z.object({
  discipline: z.enum(LAB_DISCIPLINES),
  /** Which stage of the bench: work to do, or work waiting to be released. */
  stage: z.enum(['pending', 'awaiting_release']).default('pending'),
  cursor,
  limit: pageLimit,
});

export const patientResultsQuerySchema = z.object({
  testKey: uuid.optional(),
  cursor,
  limit: pageLimit,
});

// ── the critical-value loop ──────────────────────────────────────────────────

/**
 * `docs/DECISIONS.md D-10`. Two arms and no third; the discriminant is
 * `outcome`, so a client cannot post the ambiguous middle.
 */
export const criticalCallbackSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('read_back_confirmed'),
    method: z.enum(LAB_NOTIFY_METHODS).default('phone'),
    notifiedToUserId: uuid.optional(),
    notifiedToName: z.string().trim().min(2).max(200),
    notifiedToRole: z.string().trim().max(64).optional(),
    notifiedToContact: z.string().trim().max(64).optional(),
    /** The value the clinician repeated back. NABL wants the read-back, not "informed". */
    readBackValue: z.string().trim().min(1).max(120),
    attemptCount: z.coerce.number().int().min(1).max(50).default(1),
    remarks: z.string().trim().max(2000).optional(),
  }),
  z.object({
    outcome: z.literal('clinician_unreachable_escalated'),
    method: z.enum(LAB_NOTIFY_METHODS).default('phone'),
    /** Where it went instead. "Escalated" with no destination is the bypass D-10 forbids. */
    escalatedToLevel: z.coerce.number().int().min(1).max(5),
    escalatedToRole: z.string().trim().min(2).max(64),
    escalatedToUserId: uuid.optional(),
    attemptCount: z.coerce.number().int().min(1).max(50).default(1),
    remarks: z.string().trim().max(2000).optional(),
  }),
]);

export const criticalQuerySchema = z.object({
  open: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => v === true || v === 'true')
    .default(true),
  patientId: uuid.optional(),
  cursor,
  limit: pageLimit,
});

export const acknowledgeCriticalSchema = z.object({
  note: z.string().trim().max(2000).optional(),
});

// ── quality control ──────────────────────────────────────────────────────────

export const qcRunSchema = z.object({
  instrumentId: uuid,
  testKey: uuid,
  parameterKey: uuid.optional(),
  qcMaterialId: uuid,
  level: z.enum(QC_LEVELS),
  value: z.number(),
  unit: z.string().trim().max(32).optional(),
  runNo: z.coerce.number().int().min(1).max(100000).optional(),
  reagentLot: z.string().trim().max(64).optional(),
  comment: z.string().trim().max(2000).optional(),
});

export const qcStateQuerySchema = z.object({
  instrumentId: uuid.optional(),
  testKey: uuid.optional(),
  cursor,
  limit: pageLimit,
});

export const qcActionSchema = z
  .object({
    instrumentId: uuid,
    testKey: uuid,
    lockoutId: uuid.optional(),
    qcRunId: uuid.optional(),
    causeCode: z.string().trim().min(2).max(64),
    causeNote: z.string().trim().max(2000).optional(),
    actionCode: z.string().trim().min(2).max(64),
    actionNote: z.string().trim().max(2000).optional(),
    patientImpact: z.enum(QC_PATIENT_IMPACTS).default('none'),
    affectedResultCount: z.coerce.number().int().min(0).max(1_000_000).default(0),
    /**
     * Required on the override arm only. `labq.qc.release_override` is asserted
     * separately by the service; this is the text that goes into the monthly
     * management report `EN-031 §5` requires.
     */
    authorisationReason: z.string().trim().min(8).max(2000).optional(),
  })
  .refine((v) => v.patientImpact !== 'released_with_authorisation' || v.authorisationReason !== undefined, {
    path: ['authorisationReason'],
    message:
      'Releasing patient results under an out-of-control QC is EN-031 §5’s single exception and it is reported to management every month. It needs a written authorisation, not a click.',
  });

export const qcUnlockSchema = z.object({
  reason,
  /** The passing QC run that re-established control. A lockout is not cleared by opinion. */
  unlockQcRunId: uuid,
  correctiveActionId: uuid,
});

// ── reports ──────────────────────────────────────────────────────────────────

export const generateReportSchema = z.object({
  type: z.enum(LAB_REPORT_TYPES).default('final'),
  discipline: z.enum(LAB_DISCIPLINES).optional(),
  /** Every version after the first says why (`OP-004 §3.4.3`). */
  amendmentReason: z.string().trim().min(8).max(1000).optional(),
});

// ── catalogue ────────────────────────────────────────────────────────────────

export const catalogueQuerySchema = z.object({
  q: z.string().trim().max(80).optional(),
  discipline: z.enum(LAB_DISCIPLINES).optional(),
  cursor,
  limit: pageLimit,
});

export type CreateLabOrderRequest = z.infer<typeof createLabOrderSchema>;
export type LabOrderTestRequest = z.infer<typeof labOrderTestSchema>;
export type AddOnTestsRequest = z.infer<typeof addOnTestsSchema>;
export type CancelTestsRequest = z.infer<typeof cancelTestsSchema>;
export type LabOrderQuery = z.infer<typeof labOrderQuerySchema>;
export type IssueLabelsRequest = z.infer<typeof issueLabelsSchema>;
export type CollectSampleRequest = z.infer<typeof collectSampleSchema>;
export type ReceiveSampleRequest = z.infer<typeof receiveSampleSchema>;
export type AccessionSampleRequest = z.infer<typeof accessionSampleSchema>;
export type RejectSampleRequest = z.infer<typeof rejectSampleSchema>;
export type ResultEntryRequest = z.infer<typeof resultEntrySchema>;
export type EnterResultsRequest = z.infer<typeof enterResultsSchema>;
export type ReleaseResultsRequest = z.infer<typeof releaseResultsSchema>;
export type AmendResultRequest = z.infer<typeof amendResultSchema>;
export type BenchWorklistQuery = z.infer<typeof benchWorklistQuerySchema>;
export type PatientResultsQuery = z.infer<typeof patientResultsQuerySchema>;
export type CriticalCallbackRequest = z.infer<typeof criticalCallbackSchema>;
export type CriticalQuery = z.infer<typeof criticalQuerySchema>;
export type AcknowledgeCriticalRequest = z.infer<typeof acknowledgeCriticalSchema>;
export type QcRunRequest = z.infer<typeof qcRunSchema>;
export type QcStateQuery = z.infer<typeof qcStateQuerySchema>;
export type QcActionRequest = z.infer<typeof qcActionSchema>;
export type QcUnlockRequest = z.infer<typeof qcUnlockSchema>;
export type GenerateReportRequest = z.infer<typeof generateReportSchema>;
export type CatalogueQuery = z.infer<typeof catalogueQuerySchema>;
