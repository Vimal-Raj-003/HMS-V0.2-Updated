-- ═════════════════════════════════════════════════════════════════════════════
-- Phase 8 · NC-033 — the kitchen
-- Diet orders becoming trays, and the four reasons a tray does not go
-- ═════════════════════════════════════════════════════════════════════════════
--
-- The Phase 8 half of NC-033 only. The canteen till, the staff subsidy, kitchen
-- stores, HACCP audit logs and food waste are Phase 9 — they are an ERP problem
-- and this is a patient-safety one.
--
-- ── The rules ───────────────────────────────────────────────────────────────
--
-- 1. **A recipe whose allergens intersect the patient's is refused**, not
--    warned about. Allergies are recorded meticulously in the chart and then a
--    peanut arrives on a tray, because the tray was assembled from a menu and
--    the menu does not know the patient. The tray carries the patient's
--    allergens copied at planning — a check against a stale list is the exact
--    failure this exists to stop — and the only exception is a dietician's
--    named override with a reason on the item.
--
-- 2. **A recipe above the patient's IDDSI level cannot go on their tray.**
--    OP-035 already writes a swallow order with a food level and a fluid level,
--    and `slp_swallow_orders` has carried an `ack_kitchen_at` column since
--    Phase 3 — the order was built expecting a kitchen to read it. This is the
--    kitchen. A patient assessed at level 4 who is handed level 7 toast
--    aspirates it, and there is no override at all: the exception to a swallow
--    order is a new swallow order, written by the person who assessed them.
--
-- 3. **NPO is derived, never chosen.** A patient nil by mouth for theatre at
--    07:00 is not a patient whose breakfast tray somebody should remember to
--    cancel. The status is computed from the NPO window against the slot's
--    serve time, so forgetting is not one of the available actions — and a
--    held tray still prints, marked, because the ward needs to know the patient
--    was not simply missed.
--
-- 4. **Hot food leaves at 63 °C or above, cold at 5 °C or below.** FSSAI
--    Schedule 4 and every HACCP plan built on it. A trolley below temperature
--    is not one to deliver quickly; the outcomes are reheat or discard, both
--    recorded, and neither is an override.
--
-- ── And the kitchen does not decide what a patient eats ────────────────────
--
-- `diet_type_code`, `allergens` and the two IDDSI levels on a tray are all
-- copied from the active diet by a trigger and have no request field. The
-- dietician and the ward decide through OP-011 and OP-035; what the kitchen
-- owns is whether the tray goes.
--
-- §B  The rules
-- §C  Grants
-- §D  Row-level security
-- §E  Reference data
--
-- CreateEnum
CREATE TYPE "mdm"."DietCategory" AS ENUM ('regular', 'therapeutic', 'texture', 'tube_feed', 'paediatric', 'religious');

-- CreateEnum
CREATE TYPE "ops"."MealStatus" AS ENUM ('planned', 'held_npo', 'assembled', 'dispatched', 'delivered', 'refused', 'returned', 'cancelled');

-- CreateEnum
CREATE TYPE "mdm"."ServeTemperature" AS ENUM ('hot', 'cold', 'ambient');

-- CreateTable
CREATE TABLE "mdm"."dk_diet_types" (
    "id" UUID NOT NULL,
    "hospital_id" UUID,
    "code" VARCHAR(40) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "category" "mdm"."DietCategory" NOT NULL,
    "excludes" JSONB NOT NULL DEFAULT '[]',
    "iddsi_food_level" INTEGER,
    "iddsi_fluid_level" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "dk_diet_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops"."dk_meal_slots" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "serve_minute" INTEGER NOT NULL,
    "cutoff_minute" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "dk_meal_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mdm"."dk_recipes" (
    "id" UUID NOT NULL,
    "hospital_id" UUID,
    "code" VARCHAR(60) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "allergens" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "iddsi_level" INTEGER NOT NULL,
    "serve_temperature" "mdm"."ServeTemperature" NOT NULL DEFAULT 'hot',
    "is_veg" BOOLEAN NOT NULL DEFAULT true,
    "is_egg" BOOLEAN NOT NULL DEFAULT false,
    "is_jain" BOOLEAN NOT NULL DEFAULT false,
    "is_halal" BOOLEAN NOT NULL DEFAULT false,
    "nutrients" JSONB NOT NULL DEFAULT '{}',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "dk_recipes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops"."dk_active_diets" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "admission_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "ward_id" UUID,
    "bed_label" VARCHAR(40),
    "diet_type_code" VARCHAR(40) NOT NULL,
    "order_ref" UUID,
    "allergens" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "iddsi_food_level" INTEGER,
    "iddsi_fluid_level" INTEGER,
    "swallow_order_id" UUID,
    "npo_from" TIMESTAMPTZ(6),
    "npo_to" TIMESTAMPTZ(6),
    "preferences" JSONB NOT NULL DEFAULT '{}',
    "attendant_meal" BOOLEAN NOT NULL DEFAULT false,
    "instructions" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "dk_active_diets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops"."dk_meal_trays" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "service_date" DATE NOT NULL,
    "slot_id" UUID NOT NULL,
    "active_diet_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "ward_id" UUID,
    "bed_label" VARCHAR(40),
    "diet_type_code" VARCHAR(40) NOT NULL,
    "allergens" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "iddsi_food_level" INTEGER,
    "iddsi_fluid_level" INTEGER,
    "ticket_no" VARCHAR(40),
    "status" "ops"."MealStatus" NOT NULL DEFAULT 'planned',
    "hold_reason" TEXT,
    "dispatch_temp_tenth_c" INTEGER,
    "dispatched_at" TIMESTAMPTZ(6),
    "dispatched_by" UUID,
    "delivered_at" TIMESTAMPTZ(6),
    "delivered_by" UUID,
    "intake_pct" INTEGER,
    "feedback" JSONB NOT NULL DEFAULT '{}',
    "exception" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "dk_meal_trays_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops"."dk_meal_items" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "tray_id" UUID NOT NULL,
    "recipe_id" UUID NOT NULL,
    "portions" INTEGER NOT NULL DEFAULT 1,
    "allergens" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "iddsi_level" INTEGER,
    "override_by" UUID,
    "override_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "dk_meal_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uq_diet_type_code" ON "mdm"."dk_diet_types"("hospital_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "uq_meal_slot_code" ON "ops"."dk_meal_slots"("hospital_id", "branch_id", "code");

-- CreateIndex
CREATE INDEX "dk_recipes_iddsi_level_idx" ON "mdm"."dk_recipes"("iddsi_level");

-- CreateIndex
CREATE UNIQUE INDEX "uq_recipe_code" ON "mdm"."dk_recipes"("hospital_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "uq_active_diet_admission" ON "ops"."dk_active_diets"("admission_id");

-- CreateIndex
CREATE INDEX "dk_active_diets_hospital_id_ward_id_idx" ON "ops"."dk_active_diets"("hospital_id", "ward_id");

-- CreateIndex
CREATE INDEX "dk_meal_trays_hospital_id_service_date_slot_id_ward_id_idx" ON "ops"."dk_meal_trays"("hospital_id", "service_date", "slot_id", "ward_id");

-- CreateIndex
CREATE INDEX "dk_meal_trays_hospital_id_status_idx" ON "ops"."dk_meal_trays"("hospital_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "uq_meal_tray" ON "ops"."dk_meal_trays"("active_diet_id", "service_date", "slot_id");

-- CreateIndex
CREATE INDEX "dk_meal_items_hospital_id_tray_id_idx" ON "ops"."dk_meal_items"("hospital_id", "tray_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_meal_item" ON "ops"."dk_meal_items"("tray_id", "recipe_id");

-- AddForeignKey
ALTER TABLE "ops"."dk_meal_trays" ADD CONSTRAINT "dk_meal_trays_slot_id_fkey" FOREIGN KEY ("slot_id") REFERENCES "ops"."dk_meal_slots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops"."dk_meal_trays" ADD CONSTRAINT "dk_meal_trays_active_diet_id_fkey" FOREIGN KEY ("active_diet_id") REFERENCES "ops"."dk_active_diets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops"."dk_meal_items" ADD CONSTRAINT "dk_meal_items_tray_id_fkey" FOREIGN KEY ("tray_id") REFERENCES "ops"."dk_meal_trays"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops"."dk_meal_items" ADD CONSTRAINT "dk_meal_items_recipe_id_fkey" FOREIGN KEY ("recipe_id") REFERENCES "mdm"."dk_recipes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ═════════════════════════════════════════════════════════════════════════════
-- §B. THE RULES
-- ═════════════════════════════════════════════════════════════════════════════

-- ── §B.1  The tray copies the patient, not a join ───────────────────────────
--
-- Every one of these has no request field. A kitchen that could type a diet
-- code has decided what a patient eats, and a tray checked against a join is a
-- tray checked against whatever the chart says at read time rather than what it
-- said when the food was assembled.
--
-- The hospital's own clock, through a SECURITY DEFINER function.
--
-- A meal slot is a wall-clock fact — "breakfast is at eight" — and turning that
-- into an instant needs the hospital's timezone, not the session's. Reading
-- `core.hospitals` directly from the trigger would work only while the tenant
-- policy happens to make the row visible; a definer function gives the same
-- answer under every policy, which is what a derivation needs.
CREATE OR REPLACE FUNCTION ops.hospital_timezone(p_hospital_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$ SELECT h.timezone FROM core.hospitals h WHERE h.id = p_hospital_id $$;

ALTER FUNCTION ops.hospital_timezone(uuid) OWNER TO hms_migrator;

CREATE OR REPLACE FUNCTION ops.derive_tray_from_diet()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_diet record;
  v_slot record;
  v_tz   text;
  v_serve timestamptz;
BEGIN
  SELECT d.patient_id, d.ward_id, d.bed_label, d.diet_type_code, d.allergens,
         d.iddsi_food_level, d.iddsi_fluid_level, d.npo_from, d.npo_to
    INTO v_diet
    FROM ops.dk_active_diets d WHERE d.id = NEW.active_diet_id;

  IF v_diet IS NULL THEN
    RAISE EXCEPTION 'That admission has no active diet. (NC-033 §B.1)' USING ERRCODE = 'NC033';
  END IF;

  NEW.patient_id        := v_diet.patient_id;
  NEW.ward_id           := v_diet.ward_id;
  NEW.bed_label         := v_diet.bed_label;
  NEW.diet_type_code    := v_diet.diet_type_code;
  NEW.allergens         := coalesce(v_diet.allergens, ARRAY[]::text[]);
  NEW.iddsi_food_level  := v_diet.iddsi_food_level;
  NEW.iddsi_fluid_level := v_diet.iddsi_fluid_level;

  SELECT s.serve_minute, s.code INTO v_slot FROM ops.dk_meal_slots s WHERE s.id = NEW.slot_id;
  IF v_slot IS NULL THEN
    RAISE EXCEPTION 'There is no such meal slot. (NC-033 §B.1)' USING ERRCODE = 'NC033';
  END IF;

  -- §B.3 NPO is derived. A patient nil by mouth for theatre at 07:00 is not a
  -- patient whose breakfast tray somebody should remember to cancel, so
  -- forgetting is not one of the available actions.
  v_tz := ops.hospital_timezone(NEW.hospital_id);
  IF v_tz IS NULL THEN
    RAISE EXCEPTION
      'This hospital has no timezone recorded, and a meal slot is a wall-clock time. Breakfast at eight is meaningless without knowing whose eight. (NC-033 §B.1)'
      USING ERRCODE = 'NC033';
  END IF;

  -- Wall-clock in the hospital's own zone, then an instant. Using the session
  -- timezone here would move breakfast for anybody connecting from elsewhere.
  v_serve := (NEW.service_date + make_interval(mins => v_slot.serve_minute)) AT TIME ZONE v_tz;

  IF v_diet.npo_from IS NOT NULL
     AND v_serve >= v_diet.npo_from
     AND (v_diet.npo_to IS NULL OR v_serve < v_diet.npo_to) THEN
    -- A held tray still exists and still prints, marked. The ward needs to know
    -- the patient was not simply missed.
    IF NEW.status IN ('planned', 'held_npo') THEN
      NEW.status := 'held_npo';
      -- In the hospital's clock, because the ward reads this on a printed
      -- ticket and "00:30" is not when anybody stopped eating.
      NEW.hold_reason := format(
        'Nil by mouth from %s%s.',
        to_char(v_diet.npo_from AT TIME ZONE v_tz, 'DD Mon HH24:MI'),
        CASE WHEN v_diet.npo_to IS NULL THEN ''
             ELSE ' to ' || to_char(v_diet.npo_to AT TIME ZONE v_tz, 'DD Mon HH24:MI') END);
    ELSIF NEW.status IN ('assembled', 'dispatched', 'delivered') THEN
      -- Only the states that put food in front of somebody. Cancelling,
      -- refusing or returning a held tray is housekeeping and has to stay
      -- available, or a discharge during an NPO window leaves a row nobody
      -- can close.
      RAISE EXCEPTION
        'This patient is nil by mouth at %. A tray cannot be assembled, dispatched or delivered into an NPO window — if the window is wrong, the order that set it is what changes. (NC-033 §B.3)',
        to_char(v_serve AT TIME ZONE v_tz, 'DD Mon HH24:MI')
        USING ERRCODE = 'NC033';
    END IF;
  ELSIF NEW.status = 'held_npo' THEN
    -- The window moved or ended. The hold lifts by itself, for the same reason
    -- it was applied by itself.
    NEW.status := 'planned';
    NEW.hold_reason := NULL;
  END IF;

  RETURN NEW;
END $$;

-- No `UPDATE OF` list. `UPDATE OF <cols>` fires on the *statement's* column
-- list, so an UPDATE that set only `diet_type_code` would not run the
-- derivation and the typed value would stick — which is the whole rule
-- defeated by the shape of the trigger rather than by anybody's intent.
--
-- The `a_` prefix is load-bearing too: triggers at the same timing fire in
-- alphabetical order, and the NPO hold has to be derived before the dispatch
-- rules read the status.
CREATE TRIGGER trg_a_derive_tray_from_diet
  BEFORE INSERT OR UPDATE ON ops.dk_meal_trays
  FOR EACH ROW EXECUTE FUNCTION ops.derive_tray_from_diet();


-- ── §B.2  The allergen guard, and the IDDSI ceiling ─────────────────────────
--
-- Both fire on the item, because this is where a recipe meets a patient. The
-- allergen rule has a named exception — a dietician's override with a reason —
-- and the swallow rule has none: the exception to a swallow order is a new
-- swallow order, written by whoever assessed the patient.
CREATE OR REPLACE FUNCTION ops.a_tray_item_is_safe_for_this_patient()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_recipe record;
  v_tray   record;
  v_clash  text[];
BEGIN
  SELECT r.name, r.allergens, r.iddsi_level, r.serve_temperature
    INTO v_recipe
    FROM mdm.dk_recipes r WHERE r.id = NEW.recipe_id;

  IF v_recipe IS NULL THEN
    RAISE EXCEPTION 'That recipe is not in the master. (NC-033 §B.2)' USING ERRCODE = 'NC033';
  END IF;

  SELECT t.allergens, t.iddsi_food_level, t.status
    INTO v_tray
    FROM ops.dk_meal_trays t WHERE t.id = NEW.tray_id;

  -- Stamped, so the tray keeps a record of what it was checked against rather
  -- than a pointer to whatever the master says next month.
  NEW.allergens  := coalesce(v_recipe.allergens, ARRAY[]::text[]);
  NEW.iddsi_level := v_recipe.iddsi_level;

  SELECT array_agg(a) INTO v_clash
    FROM unnest(coalesce(v_recipe.allergens, ARRAY[]::text[])) a
   WHERE a = ANY (coalesce(v_tray.allergens, ARRAY[]::text[]));

  IF v_clash IS NOT NULL AND NEW.override_by IS NULL THEN
    RAISE EXCEPTION
      '% contains % and this patient is recorded as allergic to it. Allergies are written down meticulously and then a tray arrives anyway, because the tray was assembled from a menu and the menu does not know the patient. A dietician may serve it over this refusal, with a reason. (NC-033 §B.2)',
      v_recipe.name, array_to_string(v_clash, ' and ')
      USING ERRCODE = 'NC033';
  END IF;

  -- The IDDSI ceiling. No override exists, and none is coming: a patient
  -- assessed at level 4 who is handed level 7 toast aspirates it, and the
  -- person who can change that is the one who did the assessment.
  IF v_tray.iddsi_food_level IS NOT NULL AND v_recipe.iddsi_level > v_tray.iddsi_food_level THEN
    RAISE EXCEPTION
      '% is IDDSI level % and this patient has a live swallow order at level %. There is no override for this: the exception to a swallow order is a new swallow order, from whoever assessed them. (NC-033 §B.2)',
      v_recipe.name, v_recipe.iddsi_level, v_tray.iddsi_food_level
      USING ERRCODE = 'NC033';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_a_tray_item_is_safe_for_this_patient
  BEFORE INSERT OR UPDATE OF recipe_id, tray_id, override_by ON ops.dk_meal_items
  FOR EACH ROW EXECUTE FUNCTION ops.a_tray_item_is_safe_for_this_patient();

-- An override has a name on it and a reason. Two halves of one decision.
ALTER TABLE "ops"."dk_meal_items"
  ADD CONSTRAINT "an_allergen_override_is_signed_and_reasoned"
  CHECK (("override_by" IS NULL AND "override_reason" IS NULL)
      OR ("override_by" IS NOT NULL AND "override_reason" IS NOT NULL
          AND length(btrim("override_reason")) >= 8));

ALTER TABLE "ops"."dk_meal_items"
  ADD CONSTRAINT "a_portion_is_a_portion"
  CHECK ("portions" BETWEEN 1 AND 20);

-- The IDDSI framework runs 0–4 for drinks and 3–7 for foods, so 0–7 covers it.
ALTER TABLE "mdm"."dk_recipes"
  ADD CONSTRAINT "an_iddsi_level_is_on_the_framework"
  CHECK ("iddsi_level" BETWEEN 0 AND 7);

ALTER TABLE "mdm"."dk_diet_types"
  ADD CONSTRAINT "a_diet_iddsi_level_is_on_the_framework"
  CHECK (("iddsi_food_level" IS NULL OR "iddsi_food_level" BETWEEN 0 AND 7)
     AND ("iddsi_fluid_level" IS NULL OR "iddsi_fluid_level" BETWEEN 0 AND 4));

ALTER TABLE "ops"."dk_active_diets"
  ADD CONSTRAINT "a_patient_iddsi_level_is_on_the_framework"
  CHECK (("iddsi_food_level" IS NULL OR "iddsi_food_level" BETWEEN 0 AND 7)
     AND ("iddsi_fluid_level" IS NULL OR "iddsi_fluid_level" BETWEEN 0 AND 4));

-- An NPO window runs forwards.
ALTER TABLE "ops"."dk_active_diets"
  ADD CONSTRAINT "an_npo_window_runs_forwards"
  CHECK ("npo_to" IS NULL OR "npo_from" IS NULL OR "npo_to" > "npo_from");

-- A meal is served after the counts are frozen, not before.
ALTER TABLE "ops"."dk_meal_slots"
  ADD CONSTRAINT "a_cutoff_precedes_the_service"
  CHECK ("serve_minute" BETWEEN 0 AND 1439
     AND "cutoff_minute" BETWEEN 0 AND 1439
     AND "cutoff_minute" < "serve_minute");


-- ── §B.4  The temperature at dispatch ───────────────────────────────────────
--
-- FSSAI Schedule 4, and every HACCP plan built on it: hot food held at 63 °C or
-- above, cold at 5 °C or below. Stored in tenths of a degree so it stays an
-- integer, and both thresholds are functions for the same reason every other
-- threshold in this codebase is.
CREATE OR REPLACE FUNCTION ops.hot_holding_min_tenth_c()
RETURNS int LANGUAGE sql IMMUTABLE AS $$ SELECT 630 $$;

CREATE OR REPLACE FUNCTION ops.cold_holding_max_tenth_c()
RETURNS int LANGUAGE sql IMMUTABLE AS $$ SELECT 50 $$;

CREATE OR REPLACE FUNCTION ops.a_tray_leaves_at_temperature()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_hot  boolean;
  v_cold boolean;
  v_min  int := ops.hot_holding_min_tenth_c();
  v_max  int := ops.cold_holding_max_tenth_c();
BEGIN
  IF NEW.status <> 'dispatched' OR OLD.status = 'dispatched' THEN RETURN NEW; END IF;

  IF NOT EXISTS (SELECT 1 FROM ops.dk_meal_items i WHERE i.tray_id = NEW.id) THEN
    RAISE EXCEPTION 'An empty tray is not a meal. (NC-033 §B.4)' USING ERRCODE = 'NC033';
  END IF;

  IF NEW.dispatch_temp_tenth_c IS NULL OR NEW.dispatched_by IS NULL THEN
    RAISE EXCEPTION
      'Record the trolley temperature and who dispatched it. The temperature is the control point, and a control point nobody measured is a control point that is not there. (NC-033 §B.4)'
      USING ERRCODE = 'NC033';
  END IF;

  SELECT bool_or(r.serve_temperature = 'hot'), bool_or(r.serve_temperature = 'cold')
    INTO v_hot, v_cold
    FROM ops.dk_meal_items i JOIN mdm.dk_recipes r ON r.id = i.recipe_id
   WHERE i.tray_id = NEW.id;

  IF coalesce(v_hot, false) AND NEW.dispatch_temp_tenth_c < v_min THEN
    RAISE EXCEPTION
      'This tray carries hot food and left the kitchen at %.% °C, below the %.% °C hot-holding minimum. It is not a tray to deliver quickly — reheat it to core temperature or discard it, and record which. (NC-033 §B.4)',
      NEW.dispatch_temp_tenth_c / 10, NEW.dispatch_temp_tenth_c % 10, v_min / 10, v_min % 10
      USING ERRCODE = 'NC033';
  END IF;

  IF coalesce(v_cold, false) AND NOT coalesce(v_hot, false)
     AND NEW.dispatch_temp_tenth_c > v_max THEN
    RAISE EXCEPTION
      'This tray carries cold food and left at %.% °C, above the %.% °C limit. (NC-033 §B.4)',
      NEW.dispatch_temp_tenth_c / 10, NEW.dispatch_temp_tenth_c % 10, v_max / 10, v_max % 10
      USING ERRCODE = 'NC033';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_b_tray_leaves_at_temperature
  BEFORE UPDATE ON ops.dk_meal_trays
  FOR EACH ROW EXECUTE FUNCTION ops.a_tray_leaves_at_temperature();

-- Delivery follows dispatch, and both carry a name.
ALTER TABLE "ops"."dk_meal_trays"
  ADD CONSTRAINT "a_dispatch_is_signed"
  CHECK (("dispatched_at" IS NULL) = ("dispatched_by" IS NULL));

ALTER TABLE "ops"."dk_meal_trays"
  ADD CONSTRAINT "a_delivery_is_signed"
  CHECK (("delivered_at" IS NULL) = ("delivered_by" IS NULL));

ALTER TABLE "ops"."dk_meal_trays"
  ADD CONSTRAINT "a_delivery_follows_a_dispatch"
  CHECK ("delivered_at" IS NULL OR ("dispatched_at" IS NOT NULL AND "delivered_at" >= "dispatched_at"));

-- Intake is a percentage. The reason NC-033 is a clinical module and not a
-- catering one: a week at 20% is a nutrition referral, and it is only a number
-- worth acting on if it is bounded.
ALTER TABLE "ops"."dk_meal_trays"
  ADD CONSTRAINT "an_intake_is_a_percentage"
  CHECK ("intake_pct" IS NULL OR "intake_pct" BETWEEN 0 AND 100);

ALTER TABLE "ops"."dk_meal_trays"
  ADD CONSTRAINT "a_refusal_or_return_says_why"
  CHECK ("status" NOT IN ('refused', 'returned', 'cancelled')
      OR ("exception" IS NOT NULL AND length(btrim("exception")) >= 4));

ALTER TABLE "ops"."dk_meal_trays"
  ADD CONSTRAINT "a_held_tray_says_why"
  CHECK ("status" <> 'held_npo' OR "hold_reason" IS NOT NULL);


-- ═════════════════════════════════════════════════════════════════════════════
-- §B.5  A tray label carries no diagnosis, and never will
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Tray labels travel through corridors on open trolleys and are read by
-- porters, attendants, other patients and visitors. The temptation is real and
-- specific: "Diabetic — Mrs Sharma, Ca breast" is more useful to a tray-line
-- than "Mrs S., bed 12", and somebody will eventually add the column.
--
-- Under the DPDP Act a diagnosis on a food trolley is a disclosure, and the
-- honest way to hold that is to make the column impossible rather than to write
-- it down in a policy. Fourth use of this technique after the PC-PNDT foetal
-- sex check, the MHCA restraint enum and the THOTA payment columns — and this
-- one, like those, fails at deployment next to the paragraph explaining why.
DO $$
DECLARE v_found text;
BEGIN
  SELECT string_agg(format('%s.%s', table_name, column_name), ', ') INTO v_found
  FROM information_schema.columns
  WHERE table_schema IN ('ops', 'mdm')
    AND table_name IN ('dk_meal_trays', 'dk_meal_items', 'dk_active_diets')
    AND (column_name ILIKE '%diagnos%'
      OR column_name ILIKE '%icd%'
      OR column_name IN ('condition', 'problem', 'infection_status', 'hiv_status'));

  IF v_found IS NOT NULL THEN
    RAISE EXCEPTION
      'A tray label carries no diagnosis. These rows print onto labels that travel the corridors on open trolleys and are read by porters, other patients and visitors — a diagnosis there is a disclosure, and no ward workflow needs one to serve a meal. Found: %',
      v_found;
  END IF;
END $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- §C. GRANTS
-- ═════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE r record; v_count int := 0;
BEGIN
  FOR r IN
    SELECT n.nspname AS s, c.relname AS t, c.oid
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r','p') AND c.relispartition = false
      AND ((n.nspname = 'ops'
            AND c.relname IN ('dk_meal_slots','dk_active_diets','dk_meal_trays','dk_meal_items'))
        OR (n.nspname = 'mdm' AND c.relname IN ('dk_diet_types','dk_recipes')))
      AND NOT has_table_privilege('hms_app', c.oid, 'SELECT')
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.%I TO hms_app', r.s, r.t);
    EXECUTE format('GRANT SELECT ON %I.%I TO hms_readonly', r.s, r.t);
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE 'Granted application DML on % dietary table(s)', v_count;
END $$;

-- A tray that was served was served: the intake, the feedback and the
-- temperature are a food-safety record, and NABH asks to see them.
REVOKE DELETE ON "ops"."dk_meal_trays" FROM hms_app;

-- The kitchen does not decide what a patient eats. The diet type, the
-- allergens and the two IDDSI levels come from OP-011's order and OP-035's
-- swallow order, and the console can write only its own half.
--
-- A table-level REVOKE with a column-level GRANT, not `REVOKE UPDATE (col)`,
-- which is a no-op against a role holding the table privilege.
REVOKE UPDATE ON "ops"."dk_active_diets" FROM hms_app;
GRANT UPDATE (preferences, attendant_meal, instructions, ward_id, bed_label, updated_at)
  ON "ops"."dk_active_diets" TO hms_app;

-- ── And the one door through it ─────────────────────────────────────────────
--
-- The dietician has to be able to write those columns, and the dietician is
-- `hms_app` too: the application connects as one role, and which person is
-- behind a request is a permission key rather than a database identity. A
-- column REVOKE alone would therefore have locked out the person the columns
-- belong to.
--
-- So the revoke stands and there is exactly one door through it: a definer
-- function that writes the clinical half and nothing else. The kitchen's own
-- update path cannot reach those columns through any statement it could
-- write, even a hand-edited one — which is the property the revoke was for,
-- and the property a route boundary alone would not have.
CREATE OR REPLACE FUNCTION ops.set_diet_clinical(
  p_id                uuid,
  p_hospital_id       uuid,
  p_branch_id         uuid,
  p_admission_id      uuid,
  p_patient_id        uuid,
  p_ward_id           uuid,
  p_bed_label         varchar,
  p_diet_type_code    varchar,
  p_order_ref         uuid,
  p_allergens         text[],
  p_iddsi_food_level  int,
  p_iddsi_fluid_level int,
  p_swallow_order_id  uuid,
  p_npo_from          timestamptz,
  p_npo_to            timestamptz,
  p_preferences       jsonb,
  p_attendant_meal    boolean,
  p_instructions      text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO ops.dk_active_diets
    (id, hospital_id, branch_id, admission_id, patient_id, ward_id, bed_label,
     diet_type_code, order_ref, allergens, iddsi_food_level, iddsi_fluid_level,
     swallow_order_id, npo_from, npo_to, preferences, attendant_meal, instructions,
     created_at, updated_at)
  VALUES
    (p_id, p_hospital_id, p_branch_id, p_admission_id, p_patient_id, p_ward_id, p_bed_label,
     p_diet_type_code, p_order_ref, coalesce(p_allergens, ARRAY[]::text[]),
     p_iddsi_food_level, p_iddsi_fluid_level, p_swallow_order_id, p_npo_from, p_npo_to,
     coalesce(p_preferences, '{}'::jsonb), coalesce(p_attendant_meal, false), p_instructions,
     now(), now())
  ON CONFLICT (admission_id) DO UPDATE
     SET ward_id           = EXCLUDED.ward_id,
         bed_label         = EXCLUDED.bed_label,
         diet_type_code    = EXCLUDED.diet_type_code,
         order_ref         = EXCLUDED.order_ref,
         allergens         = EXCLUDED.allergens,
         iddsi_food_level  = EXCLUDED.iddsi_food_level,
         iddsi_fluid_level = EXCLUDED.iddsi_fluid_level,
         swallow_order_id  = EXCLUDED.swallow_order_id,
         npo_from          = EXCLUDED.npo_from,
         npo_to            = EXCLUDED.npo_to,
         preferences       = EXCLUDED.preferences,
         attendant_meal    = EXCLUDED.attendant_meal,
         instructions      = EXCLUDED.instructions,
         updated_at        = now()
  RETURNING id INTO v_id;

  -- Every tray already planned against this diet is re-derived: a patient who
  -- goes nil by mouth at ten has a lunch tray already planned, and the hold
  -- has to reach it.
  UPDATE ops.dk_meal_trays SET updated_at = now()
   WHERE active_diet_id = v_id AND status IN ('planned', 'held_npo');

  RETURN v_id;
END $$;

ALTER FUNCTION ops.set_diet_clinical(uuid, uuid, uuid, uuid, uuid, uuid, varchar, varchar, uuid,
                                     text[], int, int, uuid, timestamptz, timestamptz, jsonb,
                                     boolean, text) OWNER TO hms_migrator;

-- And a recipe's allergens are the master's. A kitchen that could clear the
-- peanut flag on a recipe has repealed §B.2.
REVOKE UPDATE ON "mdm"."dk_recipes" FROM hms_app;
GRANT UPDATE (name, nutrients, serve_temperature, is_veg, is_egg, is_jain, is_halal,
              active, updated_at)
  ON "mdm"."dk_recipes" TO hms_app;


-- ═════════════════════════════════════════════════════════════════════════════
-- §D. ROW-LEVEL SECURITY
-- ═════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  r record; v_has_hospital boolean; v_hospital_null boolean; v_has_branch boolean;
  v_using text; v_check text; v_count int := 0;
BEGIN
  FOR r IN
    SELECT n.nspname AS schema_name, c.relname AS table_name
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('core','mdm','patient','clinical','lab','rad','pharmacy','inventory','finance','queue','engage','billing','integration','ops','specialty')
      AND c.relkind IN ('r','p') AND c.relispartition = false
      AND c.relname NOT LIKE '\_prisma%'
      AND c.relname NOT IN ('cdss_safety_floor','console_components','opioid_conversion_factors',
                            'immunisation_schedules','anticholinergic_scores','beers_criteria',
                            'telemedicine_drug_rules')
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
  WHERE ((n.nspname = 'ops'
          AND c.relname IN ('dk_meal_slots','dk_active_diets','dk_meal_trays','dk_meal_items'))
      OR (n.nspname = 'mdm' AND c.relname IN ('dk_diet_types','dk_recipes')))
    AND c.relkind IN ('r','p') AND c.relispartition = false
    AND (NOT c.relrowsecurity OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='tenant_isolation'));
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Dietary tables without RLS or a tenant policy: %', v_missing;
  END IF;
END $$;

-- The constraint-name uniqueness invariant (D-219) is checked again here,
-- because this migration adds twelve constraints and the whole value of the
-- assertion is that it runs where a name could collide.
DO $$
DECLARE v_dupes text;
BEGIN
  SELECT string_agg(format('%s (%s)', conname, tables), '; ' ORDER BY conname) INTO v_dupes
  FROM (
    SELECT c.conname, string_agg(DISTINCT t.relname, ', ') AS tables
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname IN ('core','mdm','patient','clinical','lab','rad','pharmacy','inventory',
                         'finance','queue','engage','billing','integration','ops','specialty')
       AND c.contype IN ('c','u','x')
       AND t.relispartition = false
     GROUP BY c.conname
    HAVING count(DISTINCT t.relname) > 1
  ) d;

  IF v_dupes IS NOT NULL THEN
    RAISE EXCEPTION
      'Two rules share a constraint name, and the API''s constraint-to-message map is keyed on that name — so one of them will show the other''s explanation to somebody. Rename one: %',
      v_dupes;
  END IF;
END $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- §E. REFERENCE DATA
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Diet types and the IDDSI levels they imply. The framework is published by the
-- IDDSI initiative and is the same in every hospital; which diets a hospital
-- offers is not, so these are the common ones and a hospital adds its own.

INSERT INTO mdm.dk_diet_types
  (id, hospital_id, code, name, category, excludes, iddsi_food_level, iddsi_fluid_level,
   created_at, updated_at)
SELECT v.* FROM (VALUES
  (gen_random_uuid(), NULL::uuid, 'regular'::varchar, 'Regular'::varchar,
   'regular'::mdm."DietCategory", '[]'::jsonb, NULL::int, NULL::int, now(), now()),
  (gen_random_uuid(), NULL, 'diabetic', 'Diabetic', 'therapeutic',
   '["sugar","jaggery","sweetened beverages"]'::jsonb, NULL, NULL, now(), now()),
  (gen_random_uuid(), NULL, 'renal', 'Renal', 'therapeutic',
   '["potassium-rich fruit","salt substitute","processed meat"]'::jsonb, NULL, NULL, now(), now()),
  (gen_random_uuid(), NULL, 'low_salt', 'Low salt', 'therapeutic',
   '["added salt","pickle","papad"]'::jsonb, NULL, NULL, now(), now()),
  -- The texture diets carry their IDDSI level, because a texture diet that did
  -- not would be a label rather than a rule.
  (gen_random_uuid(), NULL, 'soft_bite', 'Soft and bite-sized (IDDSI 6)', 'texture',
   '[]'::jsonb, 6, NULL, now(), now()),
  (gen_random_uuid(), NULL, 'minced_moist', 'Minced and moist (IDDSI 5)', 'texture',
   '[]'::jsonb, 5, NULL, now(), now()),
  (gen_random_uuid(), NULL, 'pureed', 'Pureed (IDDSI 4)', 'texture',
   '[]'::jsonb, 4, 4, now(), now()),
  (gen_random_uuid(), NULL, 'liquidised', 'Liquidised (IDDSI 3)', 'texture',
   '[]'::jsonb, 3, 3, now(), now()),
  (gen_random_uuid(), NULL, 'tube_feed', 'Tube feed', 'tube_feed',
   '[]'::jsonb, NULL, NULL, now(), now()),
  (gen_random_uuid(), NULL, 'paediatric', 'Paediatric', 'paediatric',
   '["whole nuts","hard round sweets","popcorn"]'::jsonb, NULL, NULL, now(), now()),
  (gen_random_uuid(), NULL, 'jain', 'Jain', 'religious',
   '["onion","garlic","root vegetables"]'::jsonb, NULL, NULL, now(), now()),
  (gen_random_uuid(), NULL, 'halal', 'Halal', 'religious',
   '["pork","non-halal meat","alcohol"]'::jsonb, NULL, NULL, now(), now())
) AS v(id, hospital_id, code, name, category, excludes, iddsi_food_level, iddsi_fluid_level,
       created_at, updated_at)
WHERE NOT EXISTS (
  SELECT 1 FROM mdm.dk_diet_types d WHERE d.hospital_id IS NULL AND d.code = v.code
);
