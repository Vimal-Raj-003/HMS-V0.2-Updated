import { z } from 'zod';

/**
 * TR-007 request schemas.
 *
 * ── Why the sequence is sent as a whole list ────────────────────────────────
 *
 * `PATCH /cases/:id/sequence` takes every procedure and its new position, not
 * one move. A queue is an arrangement: "put the nail at 2" is ambiguous about
 * what happens to whatever was at 2, and resolving that on the server means
 * guessing at a surgical decision. Sending the whole list means the client
 * states the arrangement it wants and the database judges that arrangement.
 */

const uuid = z.string().uuid();
const shortText = z.string().trim().min(1).max(200);

export const procedurePrioritySchema = z.enum(['life_saving', 'limb_saving', 'definitive', 'adjunct']);
export const procedureStateSchema = z.enum([
  'planned',
  'ready',
  'in_theatre',
  'done',
  'abandoned',
  'deferred',
]);
export const consentStateSchema = z.enum([
  'not_sought',
  'sought',
  'given',
  'refused',
  'emergency_waiver',
  'withdrawn',
]);
export const consultStateSchema = z.enum([
  'requested',
  'acknowledged',
  'seen',
  'advised',
  'declined',
  'cancelled',
]);

export const openCaseSchema = z.object({
  patientId: uuid,
  erVisitId: uuid.optional(),
  activationId: uuid.optional(),
  admissionId: uuid.optional(),
  leadClinicianId: uuid.optional(),
  notes: z.string().trim().max(2000).optional(),
});
export type OpenCaseRequest = z.infer<typeof openCaseSchema>;

export const closeCaseSchema = z.object({
  outcome: z.enum([
    'transferred_to_icu',
    'transferred_to_ward',
    'discharged',
    'referred_out',
    'died',
    'other',
  ]),
  notes: z.string().trim().max(2000).optional(),
});
export type CloseCaseRequest = z.infer<typeof closeCaseSchema>;

export const planProcedureSchema = z.object({
  name: shortText,
  specialty: z.string().trim().min(1).max(60),
  priority: procedurePrioritySchema,
  fractureId: uuid.optional(),
  injuryId: uuid.optional(),
  side: z.enum(['left', 'right', 'bilateral', 'not_applicable']).optional(),
  surgeonId: uuid.optional(),
  estimatedMinutes: z.number().int().min(5).max(1440).optional(),
  plannedFor: z.string().datetime({ offset: true }).optional(),
  /**
   * Why this is where it is. Free text on purpose: the reason a laparotomy goes
   * before a nail is a sentence, and a code would lose it.
   */
  rationale: z.string().trim().max(2000).optional(),
});
export type PlanProcedureRequest = z.infer<typeof planProcedureSchema>;

export const sequenceSchema = z
  .object({
    order: z
      .array(z.object({ procedureId: uuid, sequence: z.number().int().min(1).max(99) }))
      .min(1)
      .max(50),
  })
  .refine((v) => new Set(v.order.map((o) => o.sequence)).size === v.order.length, {
    message: 'Two procedures cannot share a position in the queue.',
    path: ['order'],
  })
  .refine((v) => new Set(v.order.map((o) => o.procedureId)).size === v.order.length, {
    message: 'One procedure appears twice in this arrangement.',
    path: ['order'],
  });
export type SequenceRequest = z.infer<typeof sequenceSchema>;

export const procedureStateChangeSchema = z
  .object({
    state: procedureStateSchema,
    surgeonId: uuid.optional(),
    at: z.string().datetime({ offset: true }).optional(),
    /** Required for `deferred` and `abandoned`. The database checks it too. */
    reason: z.string().trim().min(8).max(1000).optional(),
  })
  .refine((v) => !['deferred', 'abandoned'].includes(v.state) || v.reason !== undefined, {
    message: 'Deferring or abandoning a procedure on a patient who is still injured records why.',
    path: ['reason'],
  });
export type ProcedureStateRequest = z.infer<typeof procedureStateChangeSchema>;

/**
 * Recording an ordinary consent.
 *
 * `emergency_waiver` is deliberately absent from this enum. It is guarded by
 * `polytrauma.consent.waive`, a `high`-risk key held by three consultant roles
 * — and a narrow permission reachable by sending a different `state` to the
 * wide route is not a permission at all. The waiver has its own route and its
 * own schema below.
 */
export const consentSchema = z
  .object({
    state: z.enum(['not_sought', 'sought', 'given', 'refused', 'withdrawn']),
    signedBy: z.string().trim().max(120).optional(),
    relationship: z.string().trim().max(60).optional(),
    explainedLocale: z.string().trim().max(12).optional(),
    risksDiscussed: z.array(z.string().trim().min(1).max(200)).max(30).default([]),
    witnessName: z.string().trim().max(120).optional(),
    documentRef: z.string().trim().max(200).optional(),
    /** Required for `emergency_waiver`; the database refuses one without it. */
    reason: z.string().trim().min(12).max(1000).optional(),
  })
  .refine((v) => v.state !== 'given' || (v.signedBy !== undefined && v.signedBy.length >= 2), {
    message: 'A consent that was given names who gave it.',
    path: ['signedBy'],
  })
  .refine((v) => !['given', 'refused'].includes(v.state) || v.risksDiscussed.length > 0, {
    message:
      'Record the risks that were actually discussed. A consent with no risks against it is a signature, not a conversation.',
    path: ['risksDiscussed'],
  });
export type ConsentRequest = z.infer<typeof consentSchema>;

/**
 * Recording an emergency waiver.
 *
 * The state is not a field — reaching this route *is* the state. What the
 * caller supplies is the grounds, which are the whole of the waiver's
 * lawfulness and are kept on the row rather than in a log, because the row is
 * what a court reads.
 */
export const waiverSchema = z.object({
  reason: z.string().trim().min(12).max(1000),
  witnessName: z.string().trim().max(120).optional(),
  documentRef: z.string().trim().max(200).optional(),
  /** Who was attempted, and how. "No next of kin" is a finding, not an absence. */
  risksDiscussed: z.array(z.string().trim().min(1).max(200)).max(30).default([]),
});
export type WaiverRequest = z.infer<typeof waiverSchema>;

export const bloodSchema = z.object({
  procedureId: uuid.optional(),
  component: z.enum([
    'packed_red_cells',
    'whole_blood',
    'fresh_frozen_plasma',
    'platelets',
    'cryoprecipitate',
  ]),
  unitsRequired: z.number().int().min(1).max(60),
  unitsReserved: z.number().int().min(0).max(60).default(0),
  crossmatchRef: z.string().trim().max(60).optional(),
  neededBy: z.string().datetime({ offset: true }).optional(),
  mtpActivated: z.boolean().default(false),
  notes: z.string().trim().max(1000).optional(),
});
export type BloodRequest = z.infer<typeof bloodSchema>;

export const bloodUpdateSchema = z.object({
  unitsReserved: z.number().int().min(0).max(60).optional(),
  unitsIssued: z.number().int().min(0).max(60).optional(),
  crossmatchRef: z.string().trim().max(60).optional(),
  mtpActivated: z.boolean().optional(),
});
export type BloodUpdateRequest = z.infer<typeof bloodUpdateSchema>;

/**
 * Default targets in minutes, by urgency.
 *
 * Stored on the consult row rather than looked up at read time, so a later
 * change to the policy does not silently re-judge a consult that was answered
 * under the old one.
 */
export const CONSULT_SLA_MINUTES: Readonly<Record<string, number>> = {
  immediate: 15,
  urgent: 60,
  routine: 240,
};

export const consultSchema = z.object({
  specialty: z.string().trim().min(1).max(60),
  question: z.string().trim().min(8).max(2000),
  urgency: z.enum(['immediate', 'urgent', 'routine']).default('urgent'),
  /** Overrides the default for this urgency, when the case needs a tighter one. */
  slaMinutes: z.number().int().min(1).max(10080).optional(),
});
export type ConsultRequestBody = z.infer<typeof consultSchema>;

export const consultResponseSchema = z
  .object({
    state: consultStateSchema,
    advice: z.string().trim().max(4000).optional(),
    declineReason: z.string().trim().min(8).max(1000).optional(),
  })
  .refine((v) => v.state !== 'advised' || (v.advice !== undefined && v.advice.length >= 4), {
    message: 'Advice recorded with nothing in it is a consult nobody can act on.',
    path: ['advice'],
  })
  .refine((v) => v.state !== 'declined' || v.declineReason !== undefined, {
    message: 'A declined consult says why, so the asking team knows what to do instead.',
    path: ['declineReason'],
  });
export type ConsultResponseRequest = z.infer<typeof consultResponseSchema>;

export const escalateSchema = z.object({
  escalatedTo: uuid,
  /**
   * Required when the target has not been passed. Escalating early is
   * legitimate — a patient can deteriorate faster than an SLA anticipated — it
   * just should not be silent, or the escalation register stops being read.
   */
  note: z.string().trim().min(8).max(1000).optional(),
});
export type EscalateRequest = z.infer<typeof escalateSchema>;

export const teamSchema = z.object({
  userId: uuid,
  role: z.string().trim().min(1).max(60),
  specialty: z.string().trim().max(60).optional(),
  isLead: z.boolean().default(false),
});
export type TeamRequest = z.infer<typeof teamSchema>;

export const taskSchema = z.object({
  title: shortText,
  detail: z.string().trim().max(2000).optional(),
  ownerId: uuid.optional(),
  procedureId: uuid.optional(),
  dueAt: z.string().datetime({ offset: true }).optional(),
  /** A blocking task holds the board open. */
  blocking: z.boolean().default(false),
});
export type TaskRequest = z.infer<typeof taskSchema>;

export const taskCompleteSchema = z.object({ notes: z.string().trim().max(1000).optional() });
export type TaskCompleteRequest = z.infer<typeof taskCompleteSchema>;

export const huddleSchema = z.object({
  specialties: z.array(z.string().trim().min(1).max(60)).min(1).max(20),
  attendees: z.array(uuid).max(40).default([]),
  decisions: z.string().trim().min(8).max(8000),
  concerns: z.string().trim().max(4000).optional(),
});
export type HuddleRequest = z.infer<typeof huddleSchema>;

export const familyUpdateSchema = z.object({
  spokeTo: z.string().trim().min(1).max(120),
  relationship: z.string().trim().max(60).optional(),
  locale: z.string().trim().max(12).optional(),
  summary: z.string().trim().min(8).max(4000),
  /** Separate, because it is the one thing families report never having been told. */
  prognosisDiscussed: z.boolean().default(false),
});
export type FamilyUpdateRequest = z.infer<typeof familyUpdateSchema>;

export const boardQuerySchema = z.object({
  state: z.enum(['active', 'handed_over', 'closed']).optional(),
  patientId: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type BoardQuery = z.infer<typeof boardQuerySchema>;

export const idSchema = z.object({ id: uuid });
