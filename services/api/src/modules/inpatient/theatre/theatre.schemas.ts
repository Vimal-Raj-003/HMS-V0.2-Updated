import { queryFlag } from '@vims/contracts';
import { z } from 'zod';

/**
 * Phase 7D request schemas.
 *
 * ── There is no field here that skips a checklist phase ─────────────────────
 *
 * No `force`, no `emergencyMode`, no `skipTimeout`. `phase-07`: configuration
 * may add items but may never remove or bypass the three phases — and a request
 * field that could is exactly such a bypass, so there is not one.
 */

const uuid = z.string().uuid();

export const caseSchema = z.object({
  patientId: uuid,
  admissionId: uuid.optional(),
  theatreId: uuid.optional(),
  polytraumaCaseId: uuid.optional(),
  fractureId: uuid.optional(),
  plannedProcedure: z.string().trim().min(3).max(300),
  procedureCode: z.string().trim().max(40).optional(),
  specialty: z.string().trim().min(1).max(60),
  /** Compared against the consent and the site mark. Wrong-site surgery is a never event. */
  side: z.enum(['left', 'right', 'bilateral', 'not_applicable']).optional(),
  urgency: z.enum(['elective', 'urgent', 'emergency']).default('elective'),
  anaesthesiaType: z.enum(['general', 'spinal', 'regional', 'local', 'sedation', 'combined']).optional(),
  asaGrade: z.number().int().min(1).max(6).optional(),
  surgeonId: uuid.optional(),
  anaesthetistId: uuid.optional(),
  scheduledStart: z.string().datetime({ offset: true }).optional(),
  estimatedMinutes: z.number().int().min(10).max(1440).optional(),
  /** Set when this case displaces an elective one. */
  bumpedCaseId: uuid.optional(),
});
export type CaseRequest = z.infer<typeof caseSchema>;

export const preopSchema = z.object({
  consentId: uuid.optional(),
  consentTaken: z.boolean().optional(),
  siteMarked: z.boolean().optional(),
  fastingFrom: z.string().datetime({ offset: true }).optional(),
  pacCleared: z.boolean().optional(),
  crossmatchRef: z.string().trim().max(60).optional(),
  antibioticGiven: z.boolean().optional(),
});
export type PreopRequest = z.infer<typeof preopSchema>;

/** The extra items a hospital adds. The three phases themselves are not optional. */
export const checklistSchema = z.object({
  phase: z.enum(['sign_in', 'time_out', 'sign_out']),
  items: z.record(z.string(), z.union([z.boolean(), z.string()])).default({}),
});
export type ChecklistRequest = z.infer<typeof checklistSchema>;

export const intraopSchema = z.object({
  wheeledIn: z.boolean().optional(),
  anaesthesiaStart: z.boolean().optional(),
  incision: z.boolean().optional(),
  closure: z.boolean().optional(),
  wheeledOut: z.boolean().optional(),
  performedProcedure: z.string().trim().max(2000).optional(),
  findings: z.string().trim().max(8000).optional(),
  bloodLossMl: z.number().int().min(0).max(20_000).optional(),
  specimens: z.array(z.string().trim().min(1).max(160)).max(20).optional(),
  fluoroscopyMinutes: z.number().min(0).max(600).optional(),
  fluoroscopyDoseMgy: z.number().min(0).max(100_000).optional(),
  scrubNurseId: uuid.optional(),
  circulatingNurseId: uuid.optional(),
});
export type IntraopRequest = z.infer<typeof intraopSchema>;

export const countsSchema = z.object({
  swabIn: z.number().int().min(0).max(500),
  swabOut: z.number().int().min(0).max(500),
  instrumentIn: z.number().int().min(0).max(500),
  instrumentOut: z.number().int().min(0).max(500),
  sharpsIn: z.number().int().min(0).max(500),
  sharpsOut: z.number().int().min(0).max(500),
  /** Required when they do not agree. The case may close on a resolution, never on silence. */
  resolution: z.string().trim().min(12).max(2000).optional(),
});
export type CountsRequest = z.infer<typeof countsSchema>;

export const closeSchema = z.object({
  operativeNote: z.string().trim().min(10).max(20_000).optional(),
  postOpOrders: z.string().trim().max(8000).optional(),
});
export type CloseRequest = z.infer<typeof closeSchema>;

export const setSchema = z.object({
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(160),
  setType: z.string().trim().min(1).max(40),
  itemCount: z.number().int().min(0).max(500).default(0),
  shelfLifeDays: z.number().int().min(1).max(1825).default(180),
  contents: z.record(z.string(), z.unknown()).optional(),
});
export type SetRequest = z.infer<typeof setSchema>;

export const loadSchema = z.object({
  loadNo: z.string().trim().min(1).max(60),
  autoclaveId: z.string().trim().min(1).max(40),
  cycleNo: z.string().trim().max(40).optional(),
  setIds: z.array(uuid).min(1).max(100),
  peakTemperatureC: z.number().min(0).max(200).optional(),
  holdMinutes: z.number().min(0).max(600).optional(),
  peakPressureBar: z.number().min(0).max(10).optional(),
});
export type LoadRequest = z.infer<typeof loadSchema>;

export const indicatorSchema = z.object({
  bowieDick: z.enum(['pass', 'fail', 'pending']).optional(),
  chemicalIndicator: z.enum(['pass', 'fail', 'pending']).optional(),
  /** Only this one proves the spores died. A load waits in quarantine until it reads. */
  biologicalIndicator: z.enum(['pass', 'fail', 'pending']).optional(),
});
export type IndicatorRequest = z.infer<typeof indicatorSchema>;

export const issueSchema = z.object({
  setId: uuid,
  loadId: uuid,
  otCaseId: uuid.optional(),
  patientId: uuid.optional(),
  issuedTo: z.string().trim().max(120).optional(),
});
export type IssueRequest = z.infer<typeof issueSchema>;

export const returnSchema = z.object({
  returnState: z.enum(['used', 'unused', 'contaminated', 'incomplete']),
});
export type ReturnRequest = z.infer<typeof returnSchema>;

export const boardQuerySchema = z.object({
  theatreId: uuid.optional(),
  date: z.string().date().optional(),
  openOnly: queryFlag().default(true),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type BoardQuery = z.infer<typeof boardQuerySchema>;

export const loadQuerySchema = z.object({
  state: z.string().trim().max(24).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type LoadQuery = z.infer<typeof loadQuerySchema>;
