/**
 * What the transplant register and the fertility clinic return.
 *
 * The derived facts are the authority each record rests on, and `blockedBy` is
 * the statute read forwards — which matters here because an Authorisation
 * Committee meets on a schedule, and a workup begun before it has met is weeks
 * of somebody's dialysis wasted.
 */

export interface RecipientRow {
  readonly id: string;
  readonly patientId: string;
  readonly organ: string;
  readonly bloodGroup: string;
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
  readonly organ: string;
  readonly donorType: string;
  readonly relationship: string | null;
  readonly committeeRef: string | null;
  readonly status: string;
  readonly performedAt: string | null;
  readonly blockedBy: readonly string[];
  readonly needsCommittee: boolean;
}

export interface DonorRow {
  readonly id: string;
  readonly bankRegistrationNo: string;
  readonly bankDonorRef: string;
  readonly gamete: string;
  readonly ageYears: number;
  readonly donationCount: number;
  readonly available: boolean;
}

export interface ArtCycleRow {
  readonly id: string;
  readonly patientId: string;
  readonly cycleNo: number;
  readonly startedAt: string;
  readonly technique: string;
  readonly donorId: string | null;
  readonly embryosTransferred: number | null;
  readonly outcome: string | null;
  readonly blockedBy: readonly string[];
}
