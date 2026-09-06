import { queryFlag } from '@vims/contracts';
import { z } from 'zod';

/**
 * NC-013 + TR-009 request contracts.
 *
 * ── One trip, two vocabularies ──────────────────────────────────────────────
 *
 * The fleet console speaks of vehicles, milestones and distance; the crew's
 * tablet speaks of observations, interventions and handovers. Both write to the
 * same `ops.fleet_trips` row, which is why the milestone endpoint is shared and
 * the clinical ones hang off a PCR.
 */
const uuid = z.string().uuid();

export const idSchema = uuid;
export const pageLimit = z.coerce.number().int().min(1).max(200).default(50);

const latitude = z.coerce.number().min(-90).max(90);
const longitude = z.coerce.number().min(-180).max(180);
const isoTime = z.string().datetime({ offset: true });

export const VEHICLE_TYPES = [
  'bls',
  'als',
  'neonatal',
  'ventilator',
  'patient_transport',
  'mortuary_van',
  'private',
  'other',
] as const;

export const VEHICLE_STATUSES = [
  'available',
  'on_trip',
  'not_ready',
  'maintenance',
  'breakdown',
  'out_of_service',
  'retired',
] as const;

export const DOCUMENT_TYPES = [
  'rc',
  'insurance',
  'fitness',
  'permit',
  'puc',
  'road_tax',
  'speed_governor',
  'ambulance_licence',
  'other',
] as const;

export const REQUEST_SOURCES = [
  'er',
  'ward',
  'ip_transfer',
  'discharge',
  'ems_108',
  'ems_112',
  'state_ems',
  'patient_app',
  'call_centre',
  'corporate',
  'event',
  'internal',
  'referral_in',
  'transfer_out',
] as const;

/** These three are free at the point of use. The database enforces it too. */
export const STATE_EMS_SOURCES = ['ems_108', 'ems_112', 'state_ems'] as const;

export const CLINICAL_NEEDS = [
  'als',
  'bls',
  'patient_transport',
  'neonatal',
  'ventilator',
  'isolation',
] as const;

export const TRIP_MILESTONES = [
  'en_route',
  'at_scene',
  'patient_onboard',
  'arrived_hospital',
  'returning',
] as const;

export const INTERVENTION_TYPES = [
  'airway_adjunct',
  'supraglottic',
  'ett',
  'oxygen',
  'bvm',
  'cpr_start',
  'cpr_stop',
  'defib_shock',
  'iv_access',
  'io_access',
  'fluids',
  'tourniquet_on',
  'tourniquet_off',
  'pelvic_binder',
  'splint',
  'c_collar',
  'dressing',
  'needle_decompression',
  'nebulisation',
  'glucose',
  'other',
] as const;

export const PATHWAYS = [
  'trauma',
  'stemi',
  'stroke',
  'sepsis',
  'paediatric',
  'obstetric',
  'burns',
  'mci',
  'medical',
  'other',
] as const;

// ── The fleet ────────────────────────────────────────────────────────────────

export const createVehicleSchema = z.object({
  fleetCode: z.string().trim().min(2).max(24),
  registrationNo: z.string().trim().min(4).max(24),
  type: z.enum(VEHICLE_TYPES),
  make: z.string().trim().max(60).optional(),
  model: z.string().trim().max(60).optional(),
  year: z.coerce.number().int().min(1980).max(2100).optional(),
  /** `[{ assetId, name, mandatory }]` — the shift-start check reads this. */
  equipment: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(120),
        assetId: uuid.optional(),
        mandatory: z.boolean().default(false),
      }),
    )
    .max(60)
    .default([]),
  gpsDeviceId: z.string().trim().max(64).optional(),
  fuelType: z.string().trim().max(20).optional(),
  tankCapacityL: z.coerce.number().int().min(0).max(500).optional(),
  ownership: z.enum(['owned', 'leased', 'outsourced']).default('owned'),
  baseStationId: uuid.optional(),
  currentOdometer: z.coerce.number().int().min(0).default(0),
});
export type CreateVehicleRequest = z.infer<typeof createVehicleSchema>;

export const vehicleStatusSchema = z.object({
  status: z.enum(VEHICLE_STATUSES),
  statusReason: z.string().trim().max(200).optional(),
});
export type VehicleStatusRequest = z.infer<typeof vehicleStatusSchema>;

export const documentSchema = z.object({
  type: z.enum(DOCUMENT_TYPES),
  number: z.string().trim().max(60).optional(),
  issuedOn: z.string().date().optional(),
  /** Required whenever `mandatory` — a paper nobody dated is a paper nobody checked. */
  expiryOn: z.string().date().optional(),
  fileRef: z.string().trim().max(300).optional(),
  mandatory: z.boolean().default(true),
});
export type DocumentRequest = z.infer<typeof documentSchema>;

export const fleetQuerySchema = z.object({
  status: z.enum(VEHICLE_STATUSES).optional(),
  type: z.enum(VEHICLE_TYPES).optional(),
  /** Default false: the board is about what can go out now. */
  includeRetired: queryFlag().default(false),
  limit: pageLimit,
});
export type FleetQuery = z.infer<typeof fleetQuerySchema>;

export const crewSchema = z.object({
  name: z.string().trim().min(2).max(160),
  role: z.enum(['driver', 'emt', 'nurse', 'doctor', 'attendant']),
  userId: uuid.optional(),
  employeeRef: z.string().trim().max(40).optional(),
  licenceRef: z.string().trim().max(80).optional(),
  licenceExpiry: z.string().date().optional(),
  badgeNo: z.string().trim().max(40).optional(),
  phone: z.string().trim().max(20).optional(),
  alsQualified: z.boolean().default(false),
});
export type CrewRequest = z.infer<typeof crewSchema>;

export const shiftSchema = z.object({
  crewId: uuid,
  vehicleId: uuid.optional(),
  shiftStart: isoTime,
  shiftEnd: isoTime.optional(),
  rosterRef: z.string().trim().max(64).optional(),
});
export type ShiftRequest = z.infer<typeof shiftSchema>;

// ── Requests and trips ───────────────────────────────────────────────────────

const place = z.object({
  address: z.string().trim().min(3).max(300),
  lat: latitude.optional(),
  lng: longitude.optional(),
  contact: z.string().trim().max(160).optional(),
  landmark: z.string().trim().max(200).optional(),
});

export const requestSchema = z.object({
  source: z.enum(REQUEST_SOURCES),
  priority: z.enum(['emergency', 'urgent', 'scheduled']).default('urgent'),
  pickup: place,
  drop: place.optional(),
  requiredAt: isoTime.optional(),
  clinicalNeed: z.enum(CLINICAL_NEEDS).default('bls'),
  patientId: uuid.optional(),
  erVisitId: uuid.optional(),
  requesterContact: z.string().trim().max(160).optional(),
  externalCaseId: z.string().trim().max(60).optional(),
  escorts: z.record(z.string(), z.unknown()).optional(),
});
export type FleetRequestRequest = z.infer<typeof requestSchema>;

export const dispatchSchema = z.object({
  requestId: uuid,
  vehicleId: uuid,
  crew: z
    .array(
      z.object({
        crewId: uuid,
        role: z.enum(['driver', 'emt', 'nurse', 'doctor', 'attendant']),
        name: z.string().trim().max(160).optional(),
      }),
    )
    .min(1)
    .max(6),
  startOdometer: z.coerce.number().int().min(0).optional(),
});
export type DispatchRequest = z.infer<typeof dispatchSchema>;

export const milestoneSchema = z.object({
  milestone: z.enum(TRIP_MILESTONES),
  /** The device's own clock. The server's is recorded too; both are kept. */
  atDevice: isoTime.optional(),
  lat: latitude.optional(),
  lng: longitude.optional(),
});
export type MilestoneRequest = z.infer<typeof milestoneSchema>;

/** The reason rides in `x-reason`. */
export const divertSchema = z.object({
  destinationExternal: z.string().trim().min(2).max(200),
});
export type DivertRequest = z.infer<typeof divertSchema>;

export const closeTripSchema = z.object({
  endOdometer: z.coerce.number().int().min(0),
  waitingMinutes: z.coerce.number().int().min(0).max(1440).default(0),
  remarks: z.string().trim().max(2000).optional(),
});
export type CloseTripRequest = z.infer<typeof closeTripSchema>;

export const positionSchema = z.object({
  positions: z
    .array(
      z.object({
        at: isoTime,
        lat: latitude,
        lng: longitude,
        speedKmh: z.coerce.number().min(0).max(300).optional(),
        heading: z.coerce.number().int().min(0).max(359).optional(),
        ignition: z.boolean().optional(),
        source: z.enum(['device', 'phone']).default('device'),
        accuracyM: z.coerce.number().int().min(0).max(10000).optional(),
      }),
    )
    .min(1)
    .max(200),
});
export type PositionRequest = z.infer<typeof positionSchema>;

export const checklistSchema = z.object({
  vehicleId: uuid,
  kind: z.enum(['shift_start', 'post_trip', 'weekly']),
  crewShiftId: uuid.optional(),
  tripId: uuid.optional(),
  responses: z
    .array(
      z.object({
        item: z.string().trim().min(1).max(120),
        mandatory: z.boolean().default(false),
        ok: z.boolean(),
        qty: z.coerce.number().int().min(0).optional(),
        expiry: z.string().date().optional(),
      }),
    )
    .min(1)
    .max(120),
});
export type ChecklistRequest = z.infer<typeof checklistSchema>;

export const fuelSchema = z.object({
  vehicleId: uuid,
  litres: z.coerce.number().min(0.1).max(500),
  amount: z.coerce.number().min(0).max(200000),
  odometer: z.coerce.number().int().min(0),
  station: z.string().trim().max(120).optional(),
  source: z.enum(['manual', 'card_import']).default('manual'),
  receiptRef: z.string().trim().max(300).optional(),
});
export type FuelRequest = z.infer<typeof fuelSchema>;

// ── The patient care record ──────────────────────────────────────────────────

export const pcrSchema = z.object({
  tripId: uuid,
  patientId: uuid.optional(),
  patientTemp: z
    .object({
      name: z.string().trim().max(160).optional(),
      unknown: z.boolean().default(false),
      sex: z.enum(['male', 'female', 'other', 'unknown']).optional(),
      ageBand: z.string().trim().max(24).optional(),
      identificationMarks: z.array(z.string().trim().max(200)).max(6).default([]),
    })
    .optional(),
  complaint: z.string().trim().max(2000).optional(),
  mechanism: z.record(z.string(), z.unknown()).optional(),
  scene: z
    .object({
      safety: z.string().trim().max(300).optional(),
      bystanders: z.coerce.number().int().min(0).max(1000).optional(),
      police: z.boolean().optional(),
      mlcSuspected: z.boolean().optional(),
      sceneType: z.string().trim().max(80).optional(),
    })
    .optional(),
  startCategory: z.enum(['red', 'yellow', 'green', 'black']).optional(),
  mciTagNo: z.string().trim().max(40).optional(),
  allergies: z.string().trim().max(1000).optional(),
  medications: z.string().trim().max(1000).optional(),
  history: z.string().trim().max(2000).optional(),
  destinationReason: z.string().trim().max(300).optional(),
  /** Written with no signal; the sequence lets two tablets merge. */
  offlineCaptured: z.boolean().default(false),
  deviceId: z.string().trim().max(64).optional(),
  deviceSequence: z.coerce.number().int().min(0).optional(),
});
export type PcrRequest = z.infer<typeof pcrSchema>;

export const vitalsSchema = z.object({
  at: isoTime,
  seq: z.coerce.number().int().min(1).default(1),
  heartRate: z.coerce.number().int().min(0).max(300).optional(),
  systolicBp: z.coerce.number().int().min(0).max(300).optional(),
  diastolicBp: z.coerce.number().int().min(0).max(250).optional(),
  respiratoryRate: z.coerce.number().int().min(0).max(120).optional(),
  spo2: z.coerce.number().int().min(0).max(100).optional(),
  temperatureC: z.coerce.number().min(20).max(45).optional(),
  glucose: z.coerce.number().int().min(0).max(1200).optional(),
  gcsEye: z.coerce.number().int().min(1).max(4).optional(),
  gcsVerbal: z.coerce.number().int().min(1).max(5).optional(),
  gcsMotor: z.coerce.number().int().min(1).max(6).optional(),
  gcsIntubated: z.boolean().default(false),
  pupils: z.record(z.string(), z.unknown()).optional(),
  painScore: z.coerce.number().int().min(0).max(10).optional(),
  source: z.enum(['manual', 'monitor']).default('manual'),
  deviceId: z.string().trim().max(64).optional(),
});
export type VitalsRequest = z.infer<typeof vitalsSchema>;

export const interventionSchema = z.object({
  at: isoTime,
  type: z.enum(INTERVENTION_TYPES),
  details: z.record(z.string(), z.unknown()).optional(),
  performedBy: z.string().trim().max(160).optional(),
});
export type PhInterventionRequest = z.infer<typeof interventionSchema>;

export const drugSchema = z.object({
  at: isoTime,
  drugId: uuid.optional(),
  drugName: z.string().trim().min(2).max(200),
  dose: z.coerce.number().positive().max(100000),
  unit: z.string().trim().min(1).max(16),
  route: z.string().trim().min(1).max(24),
  givenBy: z.string().trim().max(160).optional(),
  /** Morphine, ketamine, midazolam. The handover waits for the reconciliation. */
  isControlled: z.boolean().default(false),
  registerRef: z.string().trim().max(64).optional(),
});
export type PhDrugRequest = z.infer<typeof drugSchema>;

export const prealertSchema = z.object({
  /** Age, Time, Mechanism, Injuries, Signs, Treatment. */
  atmist: z.object({
    age: z.string().trim().max(60),
    timeOfIncident: z.string().trim().max(40).optional(),
    mechanism: z.string().trim().max(400),
    injuries: z.string().trim().max(600),
    signs: z.string().trim().max(400),
    treatment: z.string().trim().max(600),
  }),
  pathway: z.enum(PATHWAYS).default('other'),
  etaAt: isoTime.optional(),
});
export type PrealertRequest = z.infer<typeof prealertSchema>;

export const acknowledgePrealertSchema = z.object({
  /** The bay held for them. A pre-alert is only useful if it reserves. */
  bayId: uuid.optional(),
});
export type AcknowledgePrealertRequest = z.infer<typeof acknowledgePrealertSchema>;

/** The reason rides in `x-reason`. */
export const divertPrealertSchema = z.object({
  divertedTo: z.string().trim().min(2).max(200),
});
export type DivertPrealertRequest = z.infer<typeof divertPrealertSchema>;

export const handoverSchema = z.object({
  erVisitId: uuid.optional(),
  mciTagNo: z.string().trim().max(40).optional(),
  receiverUserId: uuid,
  checklist: z.record(z.string(), z.unknown()).optional(),
  discrepancies: z.string().trim().max(2000).optional(),
  equipmentExchanged: z.record(z.string(), z.unknown()).optional(),
  controlledDrugReconciled: z.boolean().default(false),
  /**
   * Carry the last road observations into the first triage record.
   *
   * Default true, and that default is exit gate 1: a nurse retyping a blood
   * pressure at 3 a.m. is a transposed digit, and a transposed digit here is a
   * triage level.
   */
  carryVitalsIntoTriage: z.boolean().default(true),
  ageYears: z.coerce.number().int().min(0).max(130).optional(),
});
export type HandoverRequest = z.infer<typeof handoverSchema>;

export const boardQuerySchema = z.object({
  /** Default false: the board is about what is happening now. */
  includeClosed: queryFlag().default(false),
  limit: pageLimit,
});
export type BoardQuery = z.infer<typeof boardQuerySchema>;
