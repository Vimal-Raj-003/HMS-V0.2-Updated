import { queryFlag } from '@vims/contracts';
import { z } from 'zod';

/**
 * Request shapes for IP-019 and OP-024.
 *
 * ── `relationship` is an enum of the statute's list ─────────────────────────
 *
 * Not free text. A living donor is somebody on §2's list of near relatives, or
 * they are somebody the Authorisation Committee has approved — and those are
 * two different records with two different authorities. Letting a clinic type
 * "cousin" into a relationship field is how a donation with no committee
 * behind it comes to look like a family one.
 *
 * ── And there is no field for a payment ─────────────────────────────────────
 *
 * Not on a donation, not on a recipient, not on a gamete donor. Both Acts
 * prohibit consideration, and a migration-time assertion refuses any column
 * that would record one.
 *
 * ── Nor a `donationCount` on a gamete donor ─────────────────────────────────
 *
 * The Act allows one donation in a lifetime, and a count a clinic could set is
 * a limit a clinic could walk round.
 */

const uuid = z.string().uuid();

export const recipientSchema = z.object({
  patientId: uuid,
  organ: z.enum(['kidney', 'liver', 'heart', 'lung', 'pancreas', 'cornea', 'bone_marrow', 'intestine']),
  indication: z.string().min(8).max(2000),
  bloodGroup: z.string().min(1).max(8),
  hlaTyping: z.record(z.string(), z.unknown()).default({}),
  nottoId: z.string().max(40).optional(),
  listedAt: z.string().date(),
  urgency: z.enum(['routine', 'urgent', 'super_urgent']).default('routine'),
});
export type RecipientRequest = z.infer<typeof recipientSchema>;

export const donationSchema = z.object({
  recipientId: uuid,
  donorPatientId: uuid.optional(),
  organ: z.enum(['kidney', 'liver', 'heart', 'lung', 'pancreas', 'cornea', 'bone_marrow', 'intestine']),
  donorType: z.enum(['living_near_relative', 'living_other', 'deceased_brainstem', 'deceased_cardiac']),
  /** §2's list, and only it. Required for a near-relative donation. */
  relationship: z
    .enum([
      'spouse',
      'son',
      'daughter',
      'father',
      'mother',
      'brother',
      'sister',
      'grandfather',
      'grandmother',
      'grandson',
      'granddaughter',
    ])
    .optional(),
  relationshipEvidence: z.record(z.string(), z.unknown()).default({}),
  /** The only route for a donor who is not on that list. */
  committeeRef: z.string().max(80).optional(),
  committeeDecidedAt: z.string().optional(),
  brainstemDeathId: uuid.optional(),
  reason: z.string().min(8).max(2000),
});
export type DonationRequest = z.infer<typeof donationSchema>;

export const donationConsentSchema = z.object({
  donorConsentId: uuid.optional(),
  recipientConsentId: uuid.optional(),
  crossmatch: z.record(z.string(), z.unknown()).optional(),
  status: z
    .enum([
      'registered',
      'workup',
      'committee_pending',
      'approved',
      'scheduled',
      'transplanted',
      'declined',
      'withdrawn',
    ])
    .optional(),
  performedAt: z.string().optional(),
  otCaseId: uuid.optional(),
});
export type DonationConsentRequest = z.infer<typeof donationConsentSchema>;

/**
 * The panel. Four ids, and the database refuses fewer than four people or any
 * overlap with the transplant team.
 */
export const brainstemSchema = z.object({
  patientId: uuid,
  admissionId: uuid.optional(),
  firstExamAt: z.string(),
  firstExam: z.record(z.string(), z.unknown()),
  rmpInChargeId: uuid,
  authorityNomineeId: uuid,
  neurologistId: uuid,
  treatingDoctorId: uuid,
  transplantTeamIds: z.array(uuid).max(40).default([]),
  reason: z.string().min(8).max(2000),
});
export type BrainstemRequest = z.infer<typeof brainstemSchema>;

export const secondExamSchema = z.object({
  secondExamAt: z.string(),
  secondExam: z.record(z.string(), z.unknown()),
  certify: z.boolean().default(false),
  form10Ref: z.string().max(80).optional(),
  /** The second examination is the moment of certification, so it carries the
   *  reason the key asks for. */
  reason: z.string().min(8).max(2000),
});
export type SecondExamRequest = z.infer<typeof secondExamSchema>;

export const donorSchema = z.object({
  /** The bank's registration and the bank's own reference. A clinic does not
   *  hold donor identities under the Act. */
  bankRegistrationNo: z.string().min(1).max(60),
  bankDonorRef: z.string().min(1).max(60),
  gamete: z.enum(['oocyte', 'semen']),
  ageYears: z.number().int().min(18).max(55),
  screening: z.record(z.string(), z.unknown()).default({}),
  reason: z.string().min(8).max(2000),
});
export type DonorRequest = z.infer<typeof donorSchema>;

export const artCycleSchema = z.object({
  patientId: uuid,
  partnerPatientId: uuid.optional(),
  clinicRegistrationNo: z.string().min(1).max(60),
  cycleNo: z.number().int().min(1).max(30),
  startedAt: z.string().date(),
  technique: z.enum(['iui', 'ivf', 'icsi', 'fet', 'oocyte_donation', 'embryo_donation']),
  donorId: uuid.optional(),
  stimulation: z.record(z.string(), z.unknown()).default({}),
});
export type ArtCycleRequest = z.infer<typeof artCycleSchema>;

export const artUpdateSchema = z
  .object({
    laboratory: z.record(z.string(), z.unknown()).optional(),
    patientConsentId: uuid.optional(),
    partnerConsentId: uuid.optional(),
    /** One to three. A triplet pregnancy is the commonest serious harm here. */
    embryosTransferred: z.number().int().min(1).max(3).optional(),
    transferredAt: z.string().optional(),
    outcome: z
      .enum(['ongoing', 'biochemical', 'clinical_pregnancy', 'live_birth', 'miscarriage', 'failed'])
      .optional(),
    registryRef: z.string().max(80).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change.' });
export type ArtUpdateRequest = z.infer<typeof artUpdateSchema>;

export const transplantQuerySchema = z.object({
  organ: z.string().max(24).optional(),
  awaitingCommitteeOnly: queryFlag().default(false),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type TransplantQuery = z.infer<typeof transplantQuerySchema>;

export const artQuerySchema = z.object({
  patientId: uuid.optional(),
  availableDonorsOnly: queryFlag().default(false),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type ArtQuery = z.infer<typeof artQuerySchema>;
