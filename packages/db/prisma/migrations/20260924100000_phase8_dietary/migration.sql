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
