-- ═════════════════════════════════════════════════════════════════════════════
-- TR-009 + NC-013 — the pre-hospital record and the ambulance fleet
--
-- `phase-06` §6.11, exit gate 1. Thirteen tables in a new `ops` schema for the
-- fleet, seven in `clinical` for the patient care record.
--
-- ── A new schema, and why ───────────────────────────────────────────────────
--
-- `ops` is the first non-clinical operations schema. Phase 9 brings housekeeping,
-- laundry, canteen, gate and biomedical into the same space, and putting the
-- fleet in `clinical` now would mean moving five modules later. The split is
-- where the data class changes: a vehicle's insurance expiry is not PHI, a
-- patient's road blood pressure is.
--
-- ── One trip table ──────────────────────────────────────────────────────────
--
-- TR-009 §4 specifies `ph_trips` beside NC-013's `fleet_trips`, sharing about
-- twenty fields. Both modules report on the same milestone timestamps — NC-013
-- for the response-time SLA, TR-009 for the offload interval — and two rows
-- holding those times is two answers to "when did it arrive". There is one
-- `ops.fleet_trips`; the clinical record hangs off it. A trip with no patient
-- (mortuary standby, event cover) simply has no PCR.
--
-- ── No PostGIS ──────────────────────────────────────────────────────────────
--
-- `CLAUDE.md` §2 locks the extension list and PostGIS is not on it, nor in the
-- on-prem image. Coordinates are `numeric(9,6)` and distance is
-- `ops.haversine_km()` — accurate to metres over ambulance distances, portable,
-- and a generated geometry column away from PostGIS if that is ever approved.
--
-- ── The constraints ─────────────────────────────────────────────────────────
--
--   §B.1  A vehicle with an expired mandatory document is not dispatched.
--   §B.2  A trip's clock runs forward, and the odometer with it.
--   §B.3  A 108/112 trip is never billed to the patient.
--   §B.4  A handover needs an identity, both signatures, and — if a controlled
--         drug was given on the road — a reconciliation.
--   §B.5  A pre-alert is frozen at handover; updates append.
--   §B.6  Pre-hospital vitals and interventions are append-only.
--   §B.7  A trip cannot complete while its patient's PCR is unsigned.
--   §B.8  A diversion names a reason and a decider.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE SCHEMA IF NOT EXISTS "ops";
COMMENT ON SCHEMA "ops" IS
  'Non-clinical operations: the ambulance fleet now, and housekeeping, laundry, canteen, gate and biomedical from Phase 9. The split from `clinical` is where the data class changes — a vehicle''s insurance expiry is not PHI.';

-- CreateEnum
CREATE TYPE "clinical"."PrehospitalPathway" AS ENUM ('trauma', 'stemi', 'stroke', 'sepsis', 'paediatric', 'obstetric', 'burns', 'mci', 'medical', 'other');

-- CreateEnum
CREATE TYPE "clinical"."PrealertStatus" AS ENUM ('raised', 'acknowledged', 'diverted', 'stood_down', 'arrived');

-- CreateEnum
CREATE TYPE "clinical"."InterventionType" AS ENUM ('airway_adjunct', 'supraglottic', 'ett', 'oxygen', 'bvm', 'cpr_start', 'cpr_stop', 'defib_shock', 'iv_access', 'io_access', 'fluids', 'tourniquet_on', 'tourniquet_off', 'pelvic_binder', 'splint', 'c_collar', 'dressing', 'needle_decompression', 'nebulisation', 'glucose', 'other');

-- CreateEnum
CREATE TYPE "ops"."VehicleType" AS ENUM ('bls', 'als', 'neonatal', 'ventilator', 'patient_transport', 'mortuary_van', 'private', 'other');

-- CreateEnum
CREATE TYPE "ops"."VehicleStatus" AS ENUM ('available', 'on_trip', 'not_ready', 'maintenance', 'breakdown', 'out_of_service', 'retired');

-- CreateEnum
CREATE TYPE "ops"."VehicleDocumentType" AS ENUM ('rc', 'insurance', 'fitness', 'permit', 'puc', 'road_tax', 'speed_governor', 'ambulance_licence', 'other');

-- CreateEnum
CREATE TYPE "ops"."CrewRole" AS ENUM ('driver', 'emt', 'nurse', 'doctor', 'attendant');

-- CreateEnum
CREATE TYPE "ops"."TripRequestSource" AS ENUM ('er', 'ward', 'ip_transfer', 'discharge', 'ems_108', 'ems_112', 'state_ems', 'patient_app', 'call_centre', 'corporate', 'event', 'internal', 'referral_in', 'transfer_out');

-- CreateEnum
CREATE TYPE "ops"."TripPriority" AS ENUM ('emergency', 'urgent', 'scheduled');

-- CreateEnum
CREATE TYPE "ops"."ClinicalNeed" AS ENUM ('als', 'bls', 'patient_transport', 'neonatal', 'ventilator', 'isolation');

-- CreateEnum
CREATE TYPE "ops"."TripRequestStatus" AS ENUM ('new', 'queued', 'assigned', 'cancelled', 'converted');

-- CreateEnum
CREATE TYPE "ops"."TripStatus" AS ENUM ('assigned', 'en_route', 'at_scene', 'patient_onboard', 'arrived_hospital', 'handover_complete', 'returning', 'completed', 'cancelled', 'aborted', 'diverted');

-- CreateEnum
CREATE TYPE "ops"."TripBillingStatus" AS ENUM ('not_billable', 'pending', 'posted', 'credit', 'waived', 'failed');

-- CreateEnum
CREATE TYPE "ops"."ChecklistKind" AS ENUM ('shift_start', 'post_trip', 'weekly');

-- CreateEnum
CREATE TYPE "ops"."FleetIncidentKind" AS ENUM ('accident', 'speeding', 'complaint', 'equipment_failure', 'delay', 'other');

-- AlterTable

-- CreateTable
CREATE TABLE "clinical"."ph_pcr" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "patient_temp" JSONB,
    "patient_id" UUID,
    "mechanism" JSONB,
    "complaint" TEXT,
    "scene" JSONB,
    "start_category" VARCHAR(16),
    "mci_tag_no" VARCHAR(40),
    "primary_survey" JSONB,
    "allergies" TEXT,
    "medications" TEXT,
    "history" TEXT,
    "refusal" JSONB,
    "destination_reason" VARCHAR(300),
    "consent" JSONB,
    "offline_captured" BOOLEAN NOT NULL DEFAULT false,
    "device_id" VARCHAR(64),
    "device_sequence" INTEGER,
    "synced_at" TIMESTAMPTZ(6),
    "signed_by_emt_at" TIMESTAMPTZ(6),
    "signed_by_emt_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ph_pcr_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."ph_vitals" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "pcr_id" UUID NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL,
    "seq" INTEGER NOT NULL DEFAULT 1,
    "heart_rate" INTEGER,
    "systolic_bp" INTEGER,
    "diastolic_bp" INTEGER,
    "respiratory_rate" INTEGER,
    "spo2" INTEGER,
    "temperature_c" DECIMAL(4,1),
    "glucose" INTEGER,
    "gcs_eye" INTEGER,
    "gcs_verbal" INTEGER,
    "gcs_motor" INTEGER,
    "gcs_intubated" BOOLEAN NOT NULL DEFAULT false,
    "pupils" JSONB,
    "pain_score" INTEGER,
    "source" VARCHAR(16) NOT NULL DEFAULT 'manual',
    "device_id" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ph_vitals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."ph_interventions" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "pcr_id" UUID NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL,
    "type" "clinical"."InterventionType" NOT NULL,
    "details" JSONB,
    "performed_by" VARCHAR(160),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ph_interventions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."ph_drugs" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "pcr_id" UUID NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL,
    "drug_id" UUID,
    "drug_name" VARCHAR(200) NOT NULL,
    "dose" DECIMAL(10,3) NOT NULL,
    "unit" VARCHAR(16) NOT NULL,
    "route" VARCHAR(24) NOT NULL,
    "given_by" VARCHAR(160),
    "is_controlled" BOOLEAN NOT NULL DEFAULT false,
    "register_ref" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ph_drugs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."ph_media" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "pcr_id" UUID NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "file_ref" VARCHAR(400) NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "captured_at" TIMESTAMPTZ(6) NOT NULL,
    "device_id" VARCHAR(64),
    "mlc_relevant" BOOLEAN NOT NULL DEFAULT false,
    "evidence_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ph_media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."ph_prealerts" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "pcr_id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "raised_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "raised_by" UUID,
    "atmist" JSONB NOT NULL,
    "pathway" "clinical"."PrehospitalPathway" NOT NULL DEFAULT 'other',
    "suggested_activation" VARCHAR(16) NOT NULL DEFAULT 'none',
    "confirmed_activation_id" UUID,
    "eta_at" TIMESTAMPTZ(6),
    "bay_id" UUID,
    "er_visit_id" UUID,
    "status" "clinical"."PrealertStatus" NOT NULL DEFAULT 'raised',
    "acknowledged_by" UUID,
    "acknowledged_at" TIMESTAMPTZ(6),
    "diverted_to" VARCHAR(200),
    "divert_reason" TEXT,
    "updates" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ph_prealerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."ph_handovers" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "pcr_id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "er_visit_id" UUID,
    "mci_tag_no" VARCHAR(40),
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "checklist" JSONB,
    "emt_sign_id" UUID,
    "receiver_sign_id" UUID,
    "offload_minutes" INTEGER,
    "discrepancies" TEXT,
    "equipment_exchanged" JSONB,
    "controlled_drug_reconciled" BOOLEAN NOT NULL DEFAULT false,
    "vitals_carried_triage_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ph_handovers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops"."fleet_vehicles" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "fleet_code" VARCHAR(24) NOT NULL,
    "registration_no" VARCHAR(24) NOT NULL,
    "type" "ops"."VehicleType" NOT NULL,
    "make" VARCHAR(60),
    "model" VARCHAR(60),
    "year" INTEGER,
    "equipment" JSONB NOT NULL DEFAULT '[]',
    "gps_device_id" VARCHAR(64),
    "gps_provider" VARCHAR(60),
    "fastag_id" VARCHAR(40),
    "fuel_type" VARCHAR(20),
    "tank_capacity_l" INTEGER,
    "ownership" VARCHAR(16) NOT NULL DEFAULT 'owned',
    "vendor_id" UUID,
    "asset_id" UUID,
    "base_station_id" UUID,
    "status" "ops"."VehicleStatus" NOT NULL DEFAULT 'not_ready',
    "status_reason" VARCHAR(200),
    "current_odometer" INTEGER NOT NULL DEFAULT 0,
    "last_lat" DECIMAL(9,6),
    "last_lng" DECIMAL(9,6),
    "last_position_at" TIMESTAMPTZ(6),
    "current_trip_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "fleet_vehicles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops"."fleet_vehicle_documents" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "type" "ops"."VehicleDocumentType" NOT NULL,
    "number" VARCHAR(60),
    "issued_on" DATE,
    "expiry_on" DATE,
    "file_ref" VARCHAR(300),
    "mandatory" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "fleet_vehicle_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops"."fleet_stations" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "lat" DECIMAL(9,6) NOT NULL,
    "lng" DECIMAL(9,6) NOT NULL,
    "geofence_radius_m" INTEGER NOT NULL DEFAULT 150,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "fleet_stations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops"."fleet_crew" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "user_id" UUID,
    "employee_ref" VARCHAR(40),
    "name" VARCHAR(160) NOT NULL,
    "role" "ops"."CrewRole" NOT NULL,
    "licence_ref" VARCHAR(80),
    "licence_expiry" DATE,
    "badge_no" VARCHAR(40),
    "phone" VARCHAR(20),
    "als_qualified" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "fleet_crew_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops"."fleet_crew_shifts" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "crew_id" UUID NOT NULL,
    "vehicle_id" UUID,
    "shift_start" TIMESTAMPTZ(6) NOT NULL,
    "shift_end" TIMESTAMPTZ(6),
    "roster_ref" VARCHAR(64),
    "checklist_passed" BOOLEAN NOT NULL DEFAULT false,
    "status" VARCHAR(16) NOT NULL DEFAULT 'on_duty',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "fleet_crew_shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops"."fleet_requests" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "request_no" VARCHAR(40) NOT NULL,
    "source" "ops"."TripRequestSource" NOT NULL,
    "priority" "ops"."TripPriority" NOT NULL DEFAULT 'urgent',
    "patient_id" UUID,
    "er_visit_id" UUID,
    "pickup" JSONB NOT NULL,
    "drop" JSONB,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "required_at" TIMESTAMPTZ(6),
    "clinical_need" "ops"."ClinicalNeed" NOT NULL DEFAULT 'bls',
    "escorts" JSONB,
    "payer" JSONB,
    "requester_user_id" UUID,
    "requester_contact" VARCHAR(160),
    "external_case_id" VARCHAR(60),
    "status" "ops"."TripRequestStatus" NOT NULL DEFAULT 'new',
    "cancel_reason" TEXT,
    "estimate_amount" DECIMAL(14,2),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "fleet_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops"."fleet_trips" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "trip_no" VARCHAR(40) NOT NULL,
    "request_id" UUID,
    "vehicle_id" UUID NOT NULL,
    "crew" JSONB NOT NULL DEFAULT '[]',
    "status" "ops"."TripStatus" NOT NULL DEFAULT 'assigned',
    "dispatched_at" TIMESTAMPTZ(6),
    "en_route_at" TIMESTAMPTZ(6),
    "at_scene_at" TIMESTAMPTZ(6),
    "patient_contact_at" TIMESTAMPTZ(6),
    "departed_scene_at" TIMESTAMPTZ(6),
    "arrived_hospital_at" TIMESTAMPTZ(6),
    "handover_complete_at" TIMESTAMPTZ(6),
    "available_at" TIMESTAMPTZ(6),
    "start_odometer" INTEGER,
    "end_odometer" INTEGER,
    "gps_distance_km" DECIMAL(8,2),
    "distance_flagged" BOOLEAN NOT NULL DEFAULT false,
    "waiting_minutes" INTEGER NOT NULL DEFAULT 0,
    "tolls" JSONB,
    "patient_id" UUID,
    "er_visit_id" UUID,
    "mci_incident_id" UUID,
    "destination_branch_id" UUID,
    "destination_external" VARCHAR(200),
    "diversion_reason" TEXT,
    "diversion_by" UUID,
    "billing_status" "ops"."TripBillingStatus" NOT NULL DEFAULT 'pending',
    "bill_item_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "sla" JSONB,
    "remarks" TEXT,
    "cancel_reason" TEXT,
    "closed_by" UUID,
    "closed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "fleet_trips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops"."fleet_positions" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "trip_id" UUID,
    "at" TIMESTAMPTZ(6) NOT NULL,
    "lat" DECIMAL(9,6) NOT NULL,
    "lng" DECIMAL(9,6) NOT NULL,
    "speed_kmh" DECIMAL(6,2),
    "heading" INTEGER,
    "ignition" BOOLEAN,
    "source" VARCHAR(16) NOT NULL DEFAULT 'device',
    "accuracy_m" INTEGER,

    CONSTRAINT "fleet_positions_pkey" PRIMARY KEY ("id","at")
)
PARTITION BY RANGE ("at");

-- CreateTable
CREATE TABLE "ops"."fleet_checklists" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "trip_id" UUID,
    "crew_shift_id" UUID,
    "kind" "ops"."ChecklistKind" NOT NULL,
    "template_ref" VARCHAR(80),
    "responses" JSONB NOT NULL,
    "failed_items" JSONB NOT NULL DEFAULT '[]',
    "passed" BOOLEAN NOT NULL DEFAULT false,
    "override_by" UUID,
    "override_reason" TEXT,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "by_id" UUID,

    CONSTRAINT "fleet_checklists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops"."fleet_fuel_logs" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "driver_id" UUID,
    "litres" DECIMAL(8,2) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "odometer" INTEGER NOT NULL,
    "station" VARCHAR(120),
    "source" VARCHAR(16) NOT NULL DEFAULT 'manual',
    "receipt_ref" VARCHAR(300),
    "km_per_litre" DECIMAL(6,2),
    "anomaly_flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fleet_fuel_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops"."fleet_maintenance_plans" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "interval_km" INTEGER,
    "interval_days" INTEGER,
    "last_service_km" INTEGER,
    "last_service_date" DATE,
    "next_due_km" INTEGER,
    "next_due_date" DATE,
    "hard_stop_overdue_km" INTEGER NOT NULL DEFAULT 2000,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "fleet_maintenance_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops"."fleet_breakdowns" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "trip_id" UUID,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lat" DECIMAL(9,6),
    "lng" DECIMAL(9,6),
    "description" TEXT NOT NULL,
    "replacement_vehicle_id" UUID,
    "resolved_at" TIMESTAMPTZ(6),
    "cost" DECIMAL(14,2),
    "root_cause" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fleet_breakdowns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops"."fleet_incidents" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "trip_id" UUID,
    "kind" "ops"."FleetIncidentKind" NOT NULL,
    "severity" VARCHAR(16) NOT NULL DEFAULT 'minor',
    "description" TEXT NOT NULL,
    "reported_by" UUID,
    "actions" TEXT,
    "status" VARCHAR(16) NOT NULL DEFAULT 'open',
    "incident_ref" VARCHAR(64),
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "fleet_incidents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ph_pcr_trip_id_key" ON "clinical"."ph_pcr"("trip_id");

-- CreateIndex
CREATE INDEX "ph_pcr_hospital_id_patient_id_idx" ON "clinical"."ph_pcr"("hospital_id", "patient_id");

-- CreateIndex
CREATE INDEX "ph_pcr_hospital_id_created_at_idx" ON "clinical"."ph_pcr"("hospital_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ph_vitals_hospital_id_pcr_id_at_idx" ON "clinical"."ph_vitals"("hospital_id", "pcr_id", "at");

-- CreateIndex
CREATE INDEX "ph_interventions_hospital_id_pcr_id_at_idx" ON "clinical"."ph_interventions"("hospital_id", "pcr_id", "at");

-- CreateIndex
CREATE INDEX "ph_drugs_hospital_id_pcr_id_at_idx" ON "clinical"."ph_drugs"("hospital_id", "pcr_id", "at");

-- CreateIndex
CREATE INDEX "ph_media_hospital_id_pcr_id_idx" ON "clinical"."ph_media"("hospital_id", "pcr_id");

-- CreateIndex
CREATE INDEX "ph_prealerts_hospital_id_status_raised_at_idx" ON "clinical"."ph_prealerts"("hospital_id", "status", "raised_at" DESC);

-- CreateIndex
CREATE INDEX "ph_prealerts_hospital_id_trip_id_idx" ON "clinical"."ph_prealerts"("hospital_id", "trip_id");

-- CreateIndex
CREATE UNIQUE INDEX "ph_handovers_pcr_id_key" ON "clinical"."ph_handovers"("pcr_id");

-- CreateIndex
CREATE INDEX "ph_handovers_hospital_id_trip_id_idx" ON "clinical"."ph_handovers"("hospital_id", "trip_id");

-- CreateIndex
CREATE INDEX "ph_handovers_hospital_id_completed_at_idx" ON "clinical"."ph_handovers"("hospital_id", "completed_at" DESC);

-- CreateIndex
CREATE INDEX "fleet_vehicles_hospital_id_branch_id_status_type_idx" ON "ops"."fleet_vehicles"("hospital_id", "branch_id", "status", "type");

-- CreateIndex
CREATE UNIQUE INDEX "uq_fleet_registration" ON "ops"."fleet_vehicles"("hospital_id", "registration_no");

-- CreateIndex
CREATE UNIQUE INDEX "uq_fleet_code" ON "ops"."fleet_vehicles"("hospital_id", "fleet_code");

-- CreateIndex
CREATE INDEX "fleet_vehicle_documents_hospital_id_expiry_on_idx" ON "ops"."fleet_vehicle_documents"("hospital_id", "expiry_on");

-- CreateIndex
CREATE UNIQUE INDEX "uq_fleet_document_per_type" ON "ops"."fleet_vehicle_documents"("vehicle_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "uq_fleet_station_name" ON "ops"."fleet_stations"("hospital_id", "branch_id", "name");

-- CreateIndex
CREATE INDEX "fleet_crew_hospital_id_branch_id_role_is_active_idx" ON "ops"."fleet_crew"("hospital_id", "branch_id", "role", "is_active");

-- CreateIndex
CREATE INDEX "fleet_crew_shifts_hospital_id_vehicle_id_status_idx" ON "ops"."fleet_crew_shifts"("hospital_id", "vehicle_id", "status");

-- CreateIndex
CREATE INDEX "fleet_crew_shifts_hospital_id_crew_id_shift_start_idx" ON "ops"."fleet_crew_shifts"("hospital_id", "crew_id", "shift_start" DESC);

-- CreateIndex
CREATE INDEX "fleet_requests_hospital_id_branch_id_status_requested_at_idx" ON "ops"."fleet_requests"("hospital_id", "branch_id", "status", "requested_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_fleet_request_no" ON "ops"."fleet_requests"("hospital_id", "request_no");

-- CreateIndex
CREATE INDEX "fleet_trips_hospital_id_branch_id_status_created_at_idx" ON "ops"."fleet_trips"("hospital_id", "branch_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "fleet_trips_hospital_id_vehicle_id_status_idx" ON "ops"."fleet_trips"("hospital_id", "vehicle_id", "status");

-- CreateIndex
CREATE INDEX "fleet_trips_hospital_id_patient_id_idx" ON "ops"."fleet_trips"("hospital_id", "patient_id");

-- CreateIndex
CREATE INDEX "fleet_trips_hospital_id_er_visit_id_idx" ON "ops"."fleet_trips"("hospital_id", "er_visit_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_fleet_trip_no" ON "ops"."fleet_trips"("hospital_id", "trip_no");

-- CreateIndex
CREATE INDEX "fleet_positions_hospital_id_vehicle_id_at_idx" ON "ops"."fleet_positions"("hospital_id", "vehicle_id", "at" DESC);

-- CreateIndex
CREATE INDEX "fleet_positions_hospital_id_trip_id_at_idx" ON "ops"."fleet_positions"("hospital_id", "trip_id", "at");

-- CreateIndex
CREATE INDEX "fleet_checklists_hospital_id_vehicle_id_at_idx" ON "ops"."fleet_checklists"("hospital_id", "vehicle_id", "at" DESC);

-- CreateIndex
CREATE INDEX "fleet_fuel_logs_hospital_id_vehicle_id_at_idx" ON "ops"."fleet_fuel_logs"("hospital_id", "vehicle_id", "at" DESC);

-- CreateIndex
CREATE INDEX "fleet_maintenance_plans_hospital_id_vehicle_id_is_active_idx" ON "ops"."fleet_maintenance_plans"("hospital_id", "vehicle_id", "is_active");

-- CreateIndex
CREATE INDEX "fleet_breakdowns_hospital_id_vehicle_id_at_idx" ON "ops"."fleet_breakdowns"("hospital_id", "vehicle_id", "at" DESC);

-- CreateIndex
CREATE INDEX "fleet_incidents_hospital_id_vehicle_id_at_idx" ON "ops"."fleet_incidents"("hospital_id", "vehicle_id", "at" DESC);

-- AddForeignKey
ALTER TABLE "clinical"."ph_vitals" ADD CONSTRAINT "ph_vitals_pcr_id_fkey" FOREIGN KEY ("pcr_id") REFERENCES "clinical"."ph_pcr"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."ph_interventions" ADD CONSTRAINT "ph_interventions_pcr_id_fkey" FOREIGN KEY ("pcr_id") REFERENCES "clinical"."ph_pcr"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."ph_drugs" ADD CONSTRAINT "ph_drugs_pcr_id_fkey" FOREIGN KEY ("pcr_id") REFERENCES "clinical"."ph_pcr"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."ph_media" ADD CONSTRAINT "ph_media_pcr_id_fkey" FOREIGN KEY ("pcr_id") REFERENCES "clinical"."ph_pcr"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."ph_prealerts" ADD CONSTRAINT "ph_prealerts_pcr_id_fkey" FOREIGN KEY ("pcr_id") REFERENCES "clinical"."ph_pcr"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."ph_handovers" ADD CONSTRAINT "ph_handovers_pcr_id_fkey" FOREIGN KEY ("pcr_id") REFERENCES "clinical"."ph_pcr"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops"."fleet_vehicle_documents" ADD CONSTRAINT "fleet_vehicle_documents_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "ops"."fleet_vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops"."fleet_crew_shifts" ADD CONSTRAINT "fleet_crew_shifts_crew_id_fkey" FOREIGN KEY ("crew_id") REFERENCES "ops"."fleet_crew"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops"."fleet_crew_shifts" ADD CONSTRAINT "fleet_crew_shifts_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "ops"."fleet_vehicles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops"."fleet_trips" ADD CONSTRAINT "fleet_trips_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "ops"."fleet_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops"."fleet_trips" ADD CONSTRAINT "fleet_trips_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "ops"."fleet_vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops"."fleet_checklists" ADD CONSTRAINT "fleet_checklists_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "ops"."fleet_vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops"."fleet_checklists" ADD CONSTRAINT "fleet_checklists_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "ops"."fleet_trips"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops"."fleet_fuel_logs" ADD CONSTRAINT "fleet_fuel_logs_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "ops"."fleet_vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops"."fleet_maintenance_plans" ADD CONSTRAINT "fleet_maintenance_plans_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "ops"."fleet_vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops"."fleet_breakdowns" ADD CONSTRAINT "fleet_breakdowns_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "ops"."fleet_vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops"."fleet_breakdowns" ADD CONSTRAINT "fleet_breakdowns_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "ops"."fleet_trips"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops"."fleet_incidents" ADD CONSTRAINT "fleet_incidents_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "ops"."fleet_vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops"."fleet_incidents" ADD CONSTRAINT "fleet_incidents_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "ops"."fleet_trips"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ═════════════════════════════════════════════════════════════════════════════
-- §A.1  PARTITIONS, and the distance function
-- ═════════════════════════════════════════════════════════════════════════════

-- The same month-ahead premake `core.audit_log` uses, plus a DEFAULT partition
-- so a device with a wrong clock produces a monitored anomaly rather than a
-- dropped GPS fix during a resuscitation.
DO $$
DECLARE m int;
BEGIN
  FOR m IN -1 .. 3 LOOP
    PERFORM core.ensure_month_partition(
      'ops', 'fleet_positions',
      (date_trunc('month', now()) + (m || ' month')::interval)::date
    );
  END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS ops.fleet_positions_default
  PARTITION OF ops.fleet_positions DEFAULT;

/*
 * Great-circle distance in kilometres.
 *
 * PostGIS is not in this stack (`CLAUDE.md` §2) and is not in the on-prem
 * image. Over the distances an ambulance covers, the haversine formula on a
 * spherical earth is accurate to a few metres — well inside what an ETA or a
 * geofence needs, and orders of magnitude better than the GPS fix it is fed.
 *
 * IMMUTABLE and PARALLEL SAFE so it can sit in an index expression or a
 * nearest-vehicle sort without forcing a sequential scan.
 */
CREATE OR REPLACE FUNCTION ops.haversine_km(
  lat1 numeric, lng1 numeric, lat2 numeric, lng2 numeric
) RETURNS numeric
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $$
  SELECT round(
    (6371.0088 * 2 * asin(sqrt(
        power(sin(radians(lat2 - lat1) / 2), 2)
      + cos(radians(lat1)) * cos(radians(lat2))
      * power(sin(radians(lng2 - lng1) / 2), 2)
    )))::numeric, 3)
$$;

COMMENT ON FUNCTION ops.haversine_km IS
  'Great-circle distance in km. Stands in for PostGIS, which is not in this stack — accurate to metres over ambulance distances, and far better than the GPS fix it is given.';


-- ═════════════════════════════════════════════════════════════════════════════
-- §A.2  ROW-LEVEL SECURITY
-- ═════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  r record; v_has_hospital boolean; v_hospital_null boolean; v_has_branch boolean;
  v_using text; v_check text; v_count int := 0;
BEGIN
  FOR r IN
    SELECT n.nspname AS schema_name, c.relname AS table_name
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('core','mdm','patient','clinical','lab','rad','pharmacy','inventory','finance','queue','engage','billing','integration','ops')
      AND c.relkind IN ('r','p') AND c.relispartition = false
      AND c.relname NOT LIKE '\_prisma%' AND c.relname <> 'cdss_safety_floor'
      AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation')
    ORDER BY n.nspname, c.relname
  LOOP
    SELECT count(*) FILTER (WHERE column_name='hospital_id') > 0,
           bool_or(column_name='hospital_id' AND is_nullable='YES'),
           count(*) FILTER (WHERE column_name='branch_id') > 0
      INTO v_has_hospital, v_hospital_null, v_has_branch
      FROM information_schema.columns
     WHERE table_schema = r.schema_name AND table_name = r.table_name;
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', r.schema_name, r.table_name);
    IF v_has_hospital AND NOT v_hospital_null THEN
      v_using := 'hospital_id = ANY (core.accessible_hospital_ids())';
      IF v_has_branch THEN v_using := v_using || ' AND (branch_id IS NULL OR branch_id = ANY (core.current_branch_ids()))'; END IF;
      v_check := v_using;
    ELSIF v_has_hospital AND v_hospital_null THEN
      v_using := '(hospital_id IS NULL OR hospital_id = ANY (core.accessible_hospital_ids()))';
      IF v_has_branch THEN v_using := v_using || ' AND (branch_id IS NULL OR branch_id = ANY (core.current_branch_ids()))'; END IF;
      v_check := 'hospital_id = ANY (core.accessible_hospital_ids())';
      IF v_has_branch THEN v_check := v_check || ' AND (branch_id IS NULL OR branch_id = ANY (core.current_branch_ids()))'; END IF;
    ELSE v_using := 'false'; v_check := 'false';
    END IF;
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I.%I', r.schema_name, r.table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I.%I FOR ALL TO hms_app USING (%s) WITH CHECK (%s)', r.schema_name, r.table_name, v_using, v_check);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_ro ON %I.%I', r.schema_name, r.table_name);
    EXECUTE format('CREATE POLICY tenant_isolation_ro ON %I.%I FOR SELECT TO hms_readonly USING (%s)', r.schema_name, r.table_name, v_using);
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE 'RLS enabled on % new table(s)', v_count;
END $$;

DO $$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ') INTO v_missing
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE ((n.nspname = 'clinical' AND c.relname LIKE 'ph\_%') OR n.nspname = 'ops')
    AND c.relkind IN ('r','p') AND c.relispartition = false
    AND (NOT c.relrowsecurity OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='tenant_isolation'));
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'TR-009/NC-013 tables without RLS or a tenant policy: %', v_missing;
  END IF;
END $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- §B. THE CONSTRAINTS
-- ═════════════════════════════════════════════════════════════════════════════

-- ── §B.1  An ambulance with expired papers does not leave the yard ──────────
--
-- Driving an ambulance without valid insurance or a fitness certificate is an
-- offence under the Motor Vehicles Act, and the person who pays for it is the
-- driver. A dispatcher under pressure at 3 a.m. will not check six expiry
-- dates, so the database does.
--
-- Only `mandatory` documents block. A hospital that wants to dispatch on an
-- expired PUC marks it non-mandatory and owns that decision on the record,
-- rather than the rule being unenforceable because one document is awkward.
CREATE OR REPLACE FUNCTION ops.refuse_dispatch_of_undocumented_vehicle()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, ops AS $$
DECLARE
  v_expired text;
  v_status text;
BEGIN
  SELECT string_agg(d.type::text || ' (expired ' || to_char(d.expiry_on, 'DD Mon YYYY') || ')', ', ')
    INTO v_expired
    FROM ops.fleet_vehicle_documents d
   WHERE d.vehicle_id = NEW.vehicle_id
     AND d.mandatory
     AND d.expiry_on IS NOT NULL
     AND d.expiry_on < current_date;

  IF v_expired IS NOT NULL THEN
    RAISE EXCEPTION 'This ambulance cannot be dispatched: % (NC-013 §B.1). Driving it is an offence, and it is the crew who answer for it.', v_expired
      USING ERRCODE = 'NC013';
  END IF;

  SELECT status::text INTO v_status FROM ops.fleet_vehicles WHERE id = NEW.vehicle_id;
  IF v_status IN ('maintenance', 'breakdown', 'out_of_service', 'retired') THEN
    RAISE EXCEPTION 'This ambulance is %, not available (NC-013 §B.1).', v_status
      USING ERRCODE = 'NC013';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "fleet_trip_needs_a_roadworthy_vehicle"
  BEFORE INSERT ON "ops"."fleet_trips"
  FOR EACH ROW EXECUTE FUNCTION ops.refuse_dispatch_of_undocumented_vehicle();

-- ── §B.2  The clock runs forward, and so does the odometer ──────────────────
--
-- Every one of these intervals is an SLA somebody reports on. A negative one
-- gets averaged into a number a commissioner reads.
ALTER TABLE "ops"."fleet_trips"
  ADD CONSTRAINT "fleet_trip_milestones_ordered"
  CHECK (
    ("en_route_at"           IS NULL OR "dispatched_at"      IS NULL OR "en_route_at"          >= "dispatched_at")
    AND ("at_scene_at"       IS NULL OR "en_route_at"        IS NULL OR "at_scene_at"          >= "en_route_at")
    AND ("departed_scene_at" IS NULL OR "at_scene_at"        IS NULL OR "departed_scene_at"    >= "at_scene_at")
    AND ("arrived_hospital_at" IS NULL OR "departed_scene_at" IS NULL OR "arrived_hospital_at" >= "departed_scene_at")
    AND ("handover_complete_at" IS NULL OR "arrived_hospital_at" IS NULL OR "handover_complete_at" >= "arrived_hospital_at")
    AND ("available_at"      IS NULL OR "handover_complete_at" IS NULL OR "available_at"       >= "handover_complete_at")
  );

ALTER TABLE "ops"."fleet_trips"
  ADD CONSTRAINT "fleet_trip_odometer_runs_forward"
  CHECK ("end_odometer" IS NULL OR "start_odometer" IS NULL OR "end_odometer" >= "start_odometer");

ALTER TABLE "ops"."fleet_trips"
  ADD CONSTRAINT "fleet_trip_waiting_is_a_duration"
  CHECK ("waiting_minutes" >= 0);

-- ── §B.3  A 108 trip is never billed to the patient ─────────────────────────
--
-- The national ambulance service is free at the point of use. A hospital
-- posting a charge against a 108 trip is not a pricing decision, it is a
-- headline. The rule is a CHECK rather than a service branch because the
-- charge would otherwise be posted by whichever module happens to close the
-- trip.
-- The source lives on the request, so this cannot be a CHECK — a CHECK sees one
-- row. A trigger it is, and it *sets* rather than refuses on the `pending`
-- path: a trip arriving from the generic close should become non-billable, not
-- fail in front of a dispatcher who did nothing wrong.
CREATE OR REPLACE FUNCTION ops.refuse_billing_state_ems_trip()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, ops AS $$
DECLARE v_source text;
BEGIN
  IF NEW.billing_status NOT IN ('posted', 'pending') OR NEW.request_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT source::text INTO v_source FROM ops.fleet_requests WHERE id = NEW.request_id;

  IF v_source IN ('ems_108', 'ems_112', 'state_ems') THEN
    IF NEW.billing_status = 'posted' THEN
      RAISE EXCEPTION 'A % trip is free at the point of use and is never billed to the patient (NC-013 §B.3).', v_source
        USING ERRCODE = 'NC013';
    END IF;
    NEW.billing_status := 'not_billable';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "state_ems_trips_are_not_billed"
  BEFORE INSERT OR UPDATE ON "ops"."fleet_trips"
  FOR EACH ROW EXECUTE FUNCTION ops.refuse_billing_state_ems_trip();

-- Billing waits for the distance to be believable. GPS and the odometer
-- disagreeing by more than a tenth is either a fault or a detour, and both are
-- worth a human look before an invoice.
ALTER TABLE "ops"."fleet_trips"
  ADD CONSTRAINT "flagged_distance_blocks_billing"
  CHECK (NOT "distance_flagged" OR "billing_status" <> 'posted');

-- ── §B.8  A diversion names a reason and a decider ──────────────────────────
--
-- Turning an ambulance away from the hospital it was heading for is a decision
-- with a name on it. "It went somewhere else" is how a death in transit becomes
-- unexplainable.
ALTER TABLE "ops"."fleet_trips"
  ADD CONSTRAINT "diversion_is_owned_and_reasoned"
  CHECK (
    "status" <> 'diverted'
    OR ("diversion_reason" IS NOT NULL AND length(btrim("diversion_reason")) >= 8 AND "diversion_by" IS NOT NULL)
  );

ALTER TABLE "ops"."fleet_trips"
  ADD CONSTRAINT "cancelled_trip_says_why"
  CHECK ("status" NOT IN ('cancelled', 'aborted') OR "cancel_reason" IS NOT NULL);

-- A statutory document either has an expiry or is explicitly perpetual. A
-- mandatory one with no expiry recorded is a document nobody checked.
ALTER TABLE "ops"."fleet_vehicle_documents"
  ADD CONSTRAINT "mandatory_document_has_an_expiry"
  CHECK (NOT "mandatory" OR "expiry_on" IS NOT NULL);

ALTER TABLE "ops"."fleet_vehicle_documents"
  ADD CONSTRAINT "document_expiry_after_issue"
  CHECK ("issued_on" IS NULL OR "expiry_on" IS NULL OR "expiry_on" >= "issued_on");

-- A checklist that failed a mandatory item and was let through names who let it
-- through and why. Silence here is a vehicle going out with a missing
-- defibrillator and nobody accountable.
ALTER TABLE "ops"."fleet_checklists"
  ADD CONSTRAINT "checklist_override_is_owned_and_reasoned"
  CHECK (
    "override_by" IS NULL
    OR ("override_reason" IS NOT NULL AND length(btrim("override_reason")) >= 8)
  );

ALTER TABLE "ops"."fleet_fuel_logs"
  ADD CONSTRAINT "fuel_entry_is_positive"
  CHECK ("litres" > 0 AND "amount" >= 0 AND "odometer" >= 0);

ALTER TABLE "ops"."fleet_crew_shifts"
  ADD CONSTRAINT "shift_ends_after_it_starts"
  CHECK ("shift_end" IS NULL OR "shift_end" >= "shift_start");

ALTER TABLE "ops"."fleet_stations"
  ADD CONSTRAINT "station_coordinates_are_on_earth"
  CHECK ("lat" BETWEEN -90 AND 90 AND "lng" BETWEEN -180 AND 180);

ALTER TABLE "ops"."fleet_positions"
  ADD CONSTRAINT "position_coordinates_are_on_earth"
  CHECK ("lat" BETWEEN -90 AND 90 AND "lng" BETWEEN -180 AND 180);

-- ── §B.4  A handover hands the patient to somebody ──────────────────────────
--
-- An identity — an ER visit or an MCI tag — both signatures, and a controlled
-- drug reconciliation if morphine went in on the road. The crew leaving before
-- any of those is how a patient ends up in a corridor belonging to nobody, and
-- how an ampoule goes unaccounted for.
CREATE OR REPLACE FUNCTION clinical.assert_handover_is_complete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clinical AS $$
DECLARE v_controlled int;
BEGIN
  IF NEW.completed_at IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.er_visit_id IS NULL AND NEW.mci_tag_no IS NULL THEN
    RAISE EXCEPTION 'A handover names who the patient now is — an ER visit, or an MCI tag (TR-009 §B.4). Handing somebody to nobody is how they end up in a corridor belonging to no team.'
      USING ERRCODE = 'TR009';
  END IF;

  IF NEW.emt_sign_id IS NULL OR NEW.receiver_sign_id IS NULL THEN
    RAISE EXCEPTION 'A handover is signed by both the crew and the receiving clinician (TR-009 §B.4).'
      USING ERRCODE = 'TR009';
  END IF;

  SELECT count(*) INTO v_controlled
    FROM clinical.ph_drugs d
   WHERE d.pcr_id = NEW.pcr_id AND d.is_controlled;

  IF v_controlled > 0 AND NOT NEW.controlled_drug_reconciled THEN
    RAISE EXCEPTION 'A controlled drug was given on the road; the vehicle register is reconciled before the crew leaves (TR-009 §B.4). % dose(s) outstanding.', v_controlled
      USING ERRCODE = 'TR009';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "ph_handover_is_complete_before_it_completes"
  BEFORE INSERT OR UPDATE ON "clinical"."ph_handovers"
  FOR EACH ROW EXECUTE FUNCTION clinical.assert_handover_is_complete();

ALTER TABLE "clinical"."ph_handovers"
  ADD CONSTRAINT "handover_completes_after_it_starts"
  CHECK ("completed_at" IS NULL OR "completed_at" >= "started_at");

-- ── §B.5  A pre-alert freezes at handover ───────────────────────────────────
--
-- The ATMIST the receiving team acted on is what they acted on. Rewriting it
-- afterwards to match what was found rewrites the reason the team was called,
-- which is exactly the field a trauma audit reads. `updates` appends; the rest
-- is fixed once the patient is through the door.
CREATE OR REPLACE FUNCTION clinical.freeze_prealert_at_handover()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clinical AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A pre-alert is never deleted (TR-009 §B.5). Stand it down, with a reason.'
      USING ERRCODE = 'TR009';
  END IF;

  IF OLD.status = 'arrived' THEN
    IF NEW.atmist IS DISTINCT FROM OLD.atmist
       OR NEW.pathway IS DISTINCT FROM OLD.pathway
       OR NEW.suggested_activation IS DISTINCT FROM OLD.suggested_activation
       OR NEW.raised_at IS DISTINCT FROM OLD.raised_at THEN
      RAISE EXCEPTION 'This pre-alert was acted on and the patient has arrived (TR-009 §B.5). Add an update; the original is what the team was called for.'
        USING ERRCODE = 'TR009';
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER "ph_prealert_freezes_on_arrival"
  BEFORE UPDATE OR DELETE ON "clinical"."ph_prealerts"
  FOR EACH ROW EXECUTE FUNCTION clinical.freeze_prealert_at_handover();

ALTER TABLE "clinical"."ph_prealerts"
  ADD CONSTRAINT "prealert_divert_is_owned_and_reasoned"
  CHECK (
    "status" <> 'diverted'
    OR ("divert_reason" IS NOT NULL AND length(btrim("divert_reason")) >= 8 AND "diverted_to" IS NOT NULL)
  );

ALTER TABLE "clinical"."ph_prealerts"
  ADD CONSTRAINT "acknowledged_prealert_names_who"
  CHECK ("status" <> 'acknowledged' OR ("acknowledged_by" IS NOT NULL AND "acknowledged_at" IS NOT NULL));

ALTER TABLE "clinical"."ph_prealerts"
  ADD CONSTRAINT "prealert_activation_suggestion_is_known"
  CHECK ("suggested_activation" IN ('none', 'level_1', 'level_2'));

-- ── §B.6  The road record is append-only ────────────────────────────────────
--
-- The ER reads these as a timeline and a trauma audit reads them as evidence of
-- what the crew found. A vitals set that can be corrected after arrival is a
-- vitals set that will be corrected to match the ER's, and the whole point of
-- the road observations is that they were taken before anybody resuscitated.
CREATE OR REPLACE FUNCTION clinical.refuse_prehospital_rewrite()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clinical AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (TR-009 §B.6). The road observations are what the crew found before anybody resuscitated; add a later set rather than correcting this one.', TG_TABLE_NAME
    USING ERRCODE = 'TR009';
END $$;

CREATE TRIGGER "ph_vitals_are_append_only"
  BEFORE UPDATE OR DELETE ON "clinical"."ph_vitals"
  FOR EACH ROW EXECUTE FUNCTION clinical.refuse_prehospital_rewrite();

CREATE TRIGGER "ph_interventions_are_append_only"
  BEFORE UPDATE OR DELETE ON "clinical"."ph_interventions"
  FOR EACH ROW EXECUTE FUNCTION clinical.refuse_prehospital_rewrite();

CREATE TRIGGER "ph_drugs_are_append_only"
  BEFORE UPDATE OR DELETE ON "clinical"."ph_drugs"
  FOR EACH ROW EXECUTE FUNCTION clinical.refuse_prehospital_rewrite();

ALTER TABLE "clinical"."ph_vitals"
  ADD CONSTRAINT "ph_vitals_gcs_components_in_range"
  CHECK (
    ("gcs_eye"    IS NULL OR "gcs_eye"    BETWEEN 1 AND 4)
    AND ("gcs_verbal" IS NULL OR "gcs_verbal" BETWEEN 1 AND 5)
    AND ("gcs_motor"  IS NULL OR "gcs_motor"  BETWEEN 1 AND 6)
  );

-- The same rule TR-001 enforces at triage, applied to the road: a verbal score
-- cannot be observed through a tube, and inventing one inflates the GCS.
ALTER TABLE "clinical"."ph_vitals"
  ADD CONSTRAINT "ph_vitals_intubated_has_no_verbal"
  CHECK (NOT "gcs_intubated" OR "gcs_verbal" IS NULL);

ALTER TABLE "clinical"."ph_drugs"
  ADD CONSTRAINT "ph_drug_dose_is_positive"
  CHECK ("dose" > 0);

-- ── §B.7  A trip does not complete on an unsigned record ────────────────────
--
-- The EMT signs the PCR before the crew goes back on the road. An unsigned
-- record is a draft, and a draft is what a trip that closed on the way to the
-- next call leaves behind.
CREATE OR REPLACE FUNCTION ops.assert_pcr_signed_before_completion()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, ops, clinical AS $$
DECLARE v_pcr record;
BEGIN
  IF NEW.status <> 'completed' OR OLD.status = 'completed' THEN
    RETURN NEW;
  END IF;

  SELECT p.id, p.signed_by_emt_at,
         (SELECT count(*) FROM clinical.ph_vitals v WHERE v.pcr_id = p.id) AS vitals
    INTO v_pcr
    FROM clinical.ph_pcr p
   WHERE p.trip_id = NEW.id;

  -- A trip with no patient has no record to sign. That is legitimate: a
  -- mortuary standby or an event cover carries nobody.
  IF v_pcr.id IS NULL THEN
    RETURN NEW;
  END IF;

  IF v_pcr.signed_by_emt_at IS NULL THEN
    RAISE EXCEPTION 'The patient care record for this trip is unsigned (TR-009 §B.7). An unsigned PCR is a draft, and the crew is about to go back on the road.'
      USING ERRCODE = 'TR009';
  END IF;

  IF v_pcr.vitals = 0 THEN
    RAISE EXCEPTION 'No observations were recorded on this trip (TR-009 §B.7). Record at least one set, or the reason none could be taken.'
      USING ERRCODE = 'TR009';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "fleet_trip_completes_on_a_signed_record"
  BEFORE UPDATE ON "ops"."fleet_trips"
  FOR EACH ROW EXECUTE FUNCTION ops.assert_pcr_signed_before_completion();


-- ═════════════════════════════════════════════════════════════════════════════
-- §C. GRANTS
-- ═════════════════════════════════════════════════════════════════════════════
GRANT USAGE ON SCHEMA "ops" TO hms_app, hms_readonly;

DO $$
DECLARE r record; v_count int := 0;
BEGIN
  FOR r IN
    SELECT n.nspname AS s, c.relname AS t, c.oid
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('ops', 'clinical') AND c.relkind IN ('r','p') AND c.relispartition = false
      AND c.relname NOT LIKE '\_prisma%'
      AND NOT has_table_privilege('hms_app', c.oid, 'SELECT')
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.%I TO hms_app', r.s, r.t);
    EXECUTE format('GRANT SELECT ON %I.%I TO hms_readonly', r.s, r.t);
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE 'Granted application DML on % TR-009/NC-013 table(s)', v_count;
END $$;

-- Partitions inherit privileges from the parent only for those created after
-- the grant, so cover the ones the premake above already made.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'ops' AND c.relispartition AND c.relkind IN ('r','p')
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ops.%I TO hms_app', r.relname);
    EXECUTE format('GRANT SELECT ON ops.%I TO hms_readonly', r.relname);
  END LOOP;
END $$;

REVOKE UPDATE, DELETE ON "clinical"."ph_vitals"        FROM hms_app;
REVOKE UPDATE, DELETE ON "clinical"."ph_interventions" FROM hms_app;
REVOKE UPDATE, DELETE ON "clinical"."ph_drugs"         FROM hms_app;
REVOKE DELETE          ON "clinical"."ph_prealerts"    FROM hms_app;

COMMENT ON TABLE "ops"."fleet_trips" IS
  'One row per journey, clinical record or not. TR-009 specifies a second trip table; both would hold the same milestone timestamps, and two answers to "when did it arrive" is one too many for a response-time SLA.';

COMMENT ON TABLE "clinical"."ph_vitals" IS
  'Append-only. These are what the crew found before anybody resuscitated, and a set that can be corrected after arrival is a set that will be corrected to match the ER''s.';

COMMENT ON COLUMN "ops"."fleet_trips"."distance_flagged" IS
  'GPS and the odometer disagree by more than a tenth. Blocks billing until somebody looks — it is either a fault or a detour, and both deserve a human.';
