/** NC-013 + TR-009 response shapes. */

export interface VehicleDocumentView {
  readonly id: string;
  readonly type: string;
  readonly number: string | null;
  readonly issuedOn: string | null;
  readonly expiryOn: string | null;
  readonly mandatory: boolean;
  /** Negative means expired. The dispatch board turns amber inside 30. */
  readonly daysToExpiry: number | null;
}

export interface FleetVehicleView {
  readonly id: string;
  readonly fleetCode: string;
  readonly registrationNo: string;
  readonly type: string;
  readonly status: string;
  readonly statusReason: string | null;
  readonly make: string | null;
  readonly model: string | null;
  readonly equipment: unknown;
  readonly currentOdometer: number;
  readonly lastLat: string | null;
  readonly lastLng: string | null;
  readonly lastPositionAt: string | null;
  readonly currentTripId: string | null;
  readonly isActive: boolean;

  readonly documents: readonly VehicleDocumentView[];
  /**
   * Whether this vehicle can be dispatched *right now*, and if not, why.
   *
   * Computed here so the console can grey the row out; the database refuses it
   * regardless. The screen explains and the trigger decides — the same split as
   * TR-008's discharge gate.
   */
  readonly dispatchable: boolean;
  readonly blockers: readonly string[];
}

export interface FleetRequestView {
  readonly id: string;
  readonly requestNo: string;
  readonly source: string;
  readonly priority: string;
  readonly clinicalNeed: string;
  readonly pickup: unknown;
  readonly drop: unknown;
  readonly requestedAt: string;
  readonly requiredAt: string | null;
  readonly status: string;
  readonly patientId: string | null;
  readonly erVisitId: string | null;
  readonly externalCaseId: string | null;
  /** True for 108/112/state EMS. These are never billed to the patient. */
  readonly freeAtPointOfUse: boolean;
  readonly waitingMinutes: number;
}

export interface FleetTripView {
  readonly id: string;
  readonly tripNo: string;
  readonly requestId: string | null;
  readonly vehicleId: string;
  readonly fleetCode: string | null;
  readonly registrationNo: string | null;
  readonly crew: unknown;
  readonly status: string;

  readonly dispatchedAt: string | null;
  readonly enRouteAt: string | null;
  readonly atSceneAt: string | null;
  readonly patientContactAt: string | null;
  readonly departedSceneAt: string | null;
  readonly arrivedHospitalAt: string | null;
  readonly handoverCompleteAt: string | null;

  readonly startOdometer: number | null;
  readonly endOdometer: number | null;
  readonly gpsDistanceKm: string | null;
  readonly distanceFlagged: boolean;
  readonly waitingMinutes: number;

  readonly patientId: string | null;
  readonly erVisitId: string | null;
  readonly destinationExternal: string | null;
  readonly diversionReason: string | null;

  readonly billingStatus: string;
  readonly remarks: string | null;
  readonly cancelReason: string | null;

  /** Dispatch to at-scene. The number a commissioner asks for. */
  readonly responseMinutes: number | null;
  /** Arrival to handover complete. Over fifteen is a corridor problem. */
  readonly offloadMinutes: number | null;
  readonly elapsedMinutes: number;
}

export interface PrehospitalVitalView {
  readonly id: string;
  readonly at: string;
  readonly seq: number;
  readonly heartRate: number | null;
  readonly systolicBp: number | null;
  readonly diastolicBp: number | null;
  readonly respiratoryRate: number | null;
  readonly spo2: number | null;
  readonly temperatureC: string | null;
  readonly glucose: number | null;
  readonly gcsEye: number | null;
  readonly gcsVerbal: number | null;
  readonly gcsMotor: number | null;
  readonly gcsIntubated: boolean;
  /** `12T` when intubated, computed by the shared function. */
  readonly gcsDisplay: string | null;
  readonly painScore: number | null;
  readonly source: string;
}

export interface PrehospitalInterventionView {
  readonly id: string;
  readonly at: string;
  readonly type: string;
  readonly details: unknown;
  readonly performedBy: string | null;
  /** Minutes from patient contact. The ER reads the road as a timeline. */
  readonly minutesFromContact: number | null;
}

export interface PrehospitalDrugView {
  readonly id: string;
  readonly at: string;
  readonly drugName: string;
  readonly dose: string;
  readonly unit: string;
  readonly route: string;
  readonly givenBy: string | null;
  readonly isControlled: boolean;
  readonly registerRef: string | null;
}

export interface PrealertView {
  readonly id: string;
  readonly tripId: string;
  readonly pathway: string;
  readonly atmist: unknown;
  readonly suggestedActivation: string;
  readonly status: string;
  readonly raisedAt: string;
  readonly etaAt: string | null;
  readonly bayId: string | null;
  readonly erVisitId: string | null;
  readonly acknowledgedBy: string | null;
  readonly acknowledgedAt: string | null;
  readonly divertedTo: string | null;
  readonly divertReason: string | null;
  readonly updates: unknown;
  /** Seconds from raise to acknowledgement. The target is 120. */
  readonly secondsToAcknowledge: number | null;
  /** Minutes until the ETA. Negative means they should already be here. */
  readonly etaMinutes: number | null;
}

export interface HandoverView {
  readonly id: string;
  readonly tripId: string;
  readonly erVisitId: string | null;
  readonly mciTagNo: string | null;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly offloadMinutes: number | null;
  readonly controlledDrugReconciled: boolean;
  readonly discrepancies: string | null;
  /** The triage record the road observations were carried into, unedited. */
  readonly vitalsCarriedTriageId: string | null;
}

export interface PrehospitalRecordView {
  readonly id: string;
  readonly tripId: string;
  readonly patientId: string | null;
  readonly patientTemp: unknown;
  readonly complaint: string | null;
  readonly mechanism: unknown;
  readonly scene: unknown;
  readonly startCategory: string | null;
  readonly mciTagNo: string | null;
  readonly allergies: string | null;
  readonly medications: string | null;
  readonly history: string | null;
  readonly offlineCaptured: boolean;
  readonly signedByEmtAt: string | null;
  readonly createdAt: string;

  readonly vitals: readonly PrehospitalVitalView[];
  readonly interventions: readonly PrehospitalInterventionView[];
  readonly drugs: readonly PrehospitalDrugView[];
  readonly prealerts: readonly PrealertView[];
  readonly handover: HandoverView | null;

  /**
   * What the field values suggest, from the same TR-001 criteria the ER uses.
   * A suggestion: the team is called by a person, in the ER.
   */
  readonly suggestedActivation: {
    readonly tier: string;
    readonly criteria: readonly string[];
  } | null;
}

/** One trip with its clinical record, as the crew's tablet renders it. */
export interface TripDetailView {
  readonly trip: FleetTripView;
  readonly request: FleetRequestView | null;
  readonly pcr: PrehospitalRecordView | null;
}

export interface DispatchBoardView {
  /** Waiting for a vehicle, most urgent first. */
  readonly queue: readonly FleetRequestView[];
  readonly trips: readonly FleetTripView[];
  readonly vehicles: readonly FleetVehicleView[];
  /** Inbound to the ER: what the receiving team needs before anybody arrives. */
  readonly inbound: readonly PrealertView[];
  readonly generatedAt: string;
}
