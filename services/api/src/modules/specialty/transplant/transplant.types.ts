/**
 * What the transplant register and the fertility clinic return.
 *
 * The derived facts are the authority each record rests on: whether a donation
 * has one, whether a brain-stem death panel is lawful, whether a donor has
 * already donated. The `blockedBy` lists are the statutes read forwards —
 * useful here more than anywhere, because an Authorisation Committee meets on
 * a schedule and a workup that starts before it has met is weeks wasted.
 */

export interface RecipientRow {
  readonly id: string;
  readonly patientId: string;
  readonly organ: string;
  readonly indication: string;
  readonly bloodGroup: string;
  readonly nottoId: string | null;
  readonly listedAt: string;
  readonly urgency: string;
  readonly status: string;
  readonly waitingDays: number;
  readonly donationsRegistered: number;
  readonly hasApprovedDonation: boolean;
}

export interface DonationRow {
  readonly id: string;
  readonly recipientId: string;
  readonly donorPatientId: string | null;
  readonly organ: string;
  readonly donorType: string;
  readonly relationship: string | null;
  readonly committeeRef: string | null;
  readonly committeeDecidedAt: string | null;
  readonly brainstemDeathId: string | null;
  readonly status: string;
  readonly performedAt: string | null;
  /** What the Act still wants before this can reach a theatre. */
  readonly blockedBy: readonly string[];
  /** True when the route is the Committee rather than a listed relationship. */
  readonly needsCommittee: boolean;
}

export interface BrainstemRow {
  readonly id: string;
  readonly patientId: string;
  readonly firstExamAt: string;
  readonly secondExamAt: string | null;
  /** Derived. The Act requires three hundred and sixty. */
  readonly intervalMin: number | null;
  readonly certifiedAt: string | null;
  readonly form10Ref: string | null;
  /** Minutes until the second examination may lawfully be done. */
  readonly minutesUntilSecondExam: number | null;
  readonly blockedBy: readonly string[];
}

export interface DonorRow {
  readonly id: string;
  readonly bankRegistrationNo: string;
  readonly bankDonorRef: string;
  readonly gamete: string;
  readonly ageYears: number;
  /** Derived. The Act allows one. */
  readonly donationCount: number;
  readonly available: boolean;
}

export interface ArtCycleRow {
  readonly id: string;
  readonly patientId: string;
  readonly partnerPatientId: string | null;
  readonly clinicRegistrationNo: string;
  readonly cycleNo: number;
  readonly startedAt: string;
  readonly technique: string;
  readonly donorId: string | null;
  readonly embryosTransferred: number | null;
  readonly transferredAt: string | null;
  readonly outcome: string | null;
  readonly registryRef: string | null;
  /** What stands between this cycle and a transfer. */
  readonly blockedBy: readonly string[];
}
