/** TR-007 read models, mirroring `services/api/src/modules/emergency/polytrauma`. */

export interface ProcedureView {
  readonly id: string;
  readonly caseId: string;
  readonly name: string;
  readonly specialty: string;
  readonly fractureId: string | null;
  readonly side: string | null;
  readonly priority: string;
  readonly sequence: number;
  readonly state: string;
  readonly surgeonId: string | null;
  readonly plannedFor: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly estimatedMinutes: number | null;
  readonly rationale: string | null;
  readonly deferReason: string | null;
  readonly consentState: string;
  readonly consentSignedBy: string | null;
  readonly bloodRequired: number;
  readonly bloodReserved: number;
  /** One sentence saying what is stopping this one, computed by the server. */
  readonly blockedBy: string | null;
}

export interface ConsultView {
  readonly id: string;
  readonly caseId: string;
  readonly specialty: string;
  readonly question: string;
  readonly urgency: string;
  readonly slaMinutes: number;
  readonly requestedAt: string;
  readonly requestedBy: string | null;
  readonly dueAt: string;
  readonly state: string;
  readonly acknowledgedAt: string | null;
  readonly seenAt: string | null;
  readonly seenBy: string | null;
  readonly advice: string | null;
  readonly escalatedAt: string | null;
  readonly escalatedTo: string | null;
  readonly escalationNote: string | null;
  readonly declineReason: string | null;
  readonly breached: boolean;
  readonly minutesRemaining: number;
}

export interface BloodView {
  readonly id: string;
  readonly caseId: string;
  readonly procedureId: string | null;
  readonly component: string;
  readonly unitsRequired: number;
  readonly unitsReserved: number;
  readonly unitsIssued: number;
  readonly mtpActivated: boolean;
  readonly crossmatchRef: string | null;
  readonly neededBy: string | null;
  readonly notes: string | null;
  readonly shortBy: number;
}

export interface TeamMemberView {
  readonly id: string;
  readonly userId: string;
  readonly role: string;
  readonly specialty: string | null;
  readonly isLead: boolean;
  readonly joinedAt: string;
  readonly leftAt: string | null;
}

export interface TaskView {
  readonly id: string;
  readonly title: string;
  readonly detail: string | null;
  readonly ownerId: string | null;
  readonly procedureId: string | null;
  readonly dueAt: string | null;
  readonly completedAt: string | null;
  readonly completedBy: string | null;
  readonly blocking: boolean;
  readonly overdue: boolean;
}

export interface HuddleView {
  readonly id: string;
  readonly heldAt: string;
  readonly chairId: string | null;
  readonly specialties: readonly string[];
  readonly attendees: readonly string[];
  readonly decisions: string;
  readonly concerns: string | null;
}

export interface FamilyUpdateView {
  readonly id: string;
  readonly at: string;
  readonly byId: string | null;
  readonly spokeTo: string;
  readonly relationship: string | null;
  readonly locale: string | null;
  readonly summary: string;
  readonly prognosisDiscussed: boolean;
}

export interface BoardCardView {
  readonly id: string;
  readonly caseNo: string;
  readonly patientId: string;
  readonly erVisitId: string | null;
  readonly leadClinicianId: string | null;
  readonly state: string;
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly outcome: string | null;
  readonly issAtOpen: number | null;
  readonly nissAtOpen: number | null;
  readonly trissAtOpen: string | null;
  readonly nextProcedure: string | null;
  readonly nextPriority: string | null;
  readonly proceduresOutstanding: number;
  readonly consultsOpen: number;
  readonly consultsBreached: number;
  readonly bloodShort: number;
  readonly blockingTasks: number;
  readonly hoursOpen: number;
}

export interface BoardDetailView extends BoardCardView {
  readonly notes: string | null;
  readonly closureNotes: string | null;
  readonly procedures: readonly ProcedureView[];
  readonly consults: readonly ConsultView[];
  readonly blood: readonly BloodView[];
  readonly team: readonly TeamMemberView[];
  readonly tasks: readonly TaskView[];
  readonly huddles: readonly HuddleView[];
  readonly familyUpdates: readonly FamilyUpdateView[];
}
