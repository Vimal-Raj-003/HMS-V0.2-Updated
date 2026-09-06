/** OP-006 response shapes. */

export interface ErZoneView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly kind: string;
  readonly sortOrder: number;
  readonly bayCount: number;
  readonly occupiedCount: number;
  readonly cleaningCount: number;
}

export interface ErBayView {
  readonly id: string;
  readonly zoneId: string;
  readonly zoneCode: string;
  readonly code: string;
  readonly name: string;
  readonly kind: string;
  readonly status: string;
  readonly currentVisitId: string | null;
  readonly hasMonitor: boolean;
  readonly hasVentilator: boolean;
  readonly hasOxygen: boolean;
  readonly vacatedAt: string | null;
}

export interface ErVisitView {
  readonly id: string;
  readonly erNo: string;
  readonly patientId: string | null;
  readonly tempIdentity: string | null;
  /** "Unknown male, approx 40" is a clinical fact, not a placeholder. */
  readonly displayName: string | null;
  readonly approximateAge: number | null;
  readonly gender: string | null;
  readonly arrivalMode: string;
  readonly broughtBy: string | null;
  readonly chiefComplaint: string | null;
  readonly mlcSuspected: boolean;
  readonly esiLevel: number | null;
  readonly status: string;
  readonly zoneId: string | null;
  readonly bayId: string | null;
  readonly bayCode: string | null;
  readonly expectedAt: string | null;
  readonly arrivedAt: string | null;
  readonly triagedAt: string | null;
  readonly targetSeenBy: string | null;
  readonly firstSeenAt: string | null;
  readonly dispositionAt: string | null;
  readonly isUnidentified: boolean;

  /** How long they have been in the department, in minutes. */
  readonly erLosMinutes: number | null;
  /**
   * How much of the ESI target has been used, as a percentage. The board turns
   * amber at 80 and red at 100 — `phase-06` §6.1.
   */
  readonly targetUsedPct: number | null;
  /** True once the ESI target has passed with nobody having seen them. */
  readonly targetBreached: boolean;
}

export interface ErMovementView {
  readonly id: string;
  readonly bayId: string;
  readonly bayCode: string;
  readonly movedInAt: string;
  readonly movedOutAt: string | null;
  readonly method: string;
}

export interface ErDispositionView {
  readonly id: string;
  readonly kind: string;
  readonly admissionRequestId: string | null;
  readonly referredToFacility: string | null;
  readonly lamaWitnessName: string | null;
  readonly deathAt: string | null;
  readonly summaryText: string | null;
  readonly decidedAt: string;
}

export interface ErVisitDetailView extends ErVisitView {
  readonly movements: readonly ErMovementView[];
  readonly disposition: ErDispositionView | null;
}

/**
 * The board.
 *
 * Sorted strictly by ESI then arrival time — the sickest first, and among
 * equally sick, whoever has waited longest. Anything else is a queue that
 * rewards being noticed.
 */
export interface ErBoardView {
  readonly visits: readonly ErVisitView[];
  readonly zones: readonly ErZoneView[];
  readonly bays: readonly ErBayView[];
  readonly counts: {
    readonly inbound: number;
    readonly waiting: number;
    readonly inTreatment: number;
    readonly boarding: number;
    readonly breached: number;
    readonly unidentified: number;
    readonly baysFree: number;
    readonly baysCleaning: number;
  };
}
