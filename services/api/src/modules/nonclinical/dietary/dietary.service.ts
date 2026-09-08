import { Injectable } from '@nestjs/common';
import { newId } from '@vims/contracts';
import type { TransactionClient } from '../../../core/db/database.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { consoleEvent } from '../../specialty/consoles/consoles.events.js';
import {
  ConsoleSupport,
  asBool,
  asJson,
  asNumber,
  asNumberOrNull,
  asStringArray,
  asText,
  asTextOrNull,
} from '../../specialty/consoles/consoles.support.js';
import type {
  ActiveDietRequest,
  DietOperationalRequest,
  DietQuery,
  MealSlotRequest,
  RecipeQuery,
  RecipeRequest,
  TrayCloseRequest,
  TrayDeliverRequest,
  TrayDispatchRequest,
  TrayItemRequest,
  TrayPlanRequest,
  TrayQuery,
} from './dietary.schemas.js';
import type {
  ActiveDietRow,
  HoldingLimits,
  MealItemRow,
  MealSlotRow,
  MealTrayRow,
  RecipeRow,
} from './dietary.types.js';

/**
 * NC-033 — the tray line.
 *
 * ── Nothing here decides what a patient eats ───────────────────────────────
 *
 * The diet type, the allergen list and the two IDDSI levels are copied onto
 * every tray by a trigger and revoked from the application at column level on
 * the diet itself. What this service adds is answering *will this tray go* one
 * step earlier than the refusal does.
 *
 * ── `servable` on the recipe list is the whole idea ────────────────────────
 *
 * A tray-line worker picking dishes from a menu should see the peanut chutney
 * struck through with "this patient is allergic" on it, not discover that after
 * assembling a plate. The same query says which refusals a dietician could
 * override and which nobody can — because the difference between those two is
 * the module's central distinction and hiding it teaches the wrong lesson.
 *
 * ── And the NPO hold is not computed here ──────────────────────────────────
 *
 * A trigger derives it from the nil-by-mouth window against the slot's serve
 * time, in the hospital's own timezone. This service reads the result.
 */
@Injectable()
export class DietaryService extends ConsoleSupport {
  // ── Masters ───────────────────────────────────────────────────────────────

  async addSlot(body: MealSlotRequest): Promise<MealSlotRow> {
    return this.guard(async (tx) => {
      const id = newId();
      await tx.query(
        `INSERT INTO ops.dk_meal_slots
           (id, hospital_id, branch_id, code, name, serve_minute, cutoff_minute, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now(),now())`,
        [id, this.hospitalId(), this.branchId(), body.code, body.name, body.serveMinute, body.cutoffMinute],
      );
      const slots = await this.slotsWithin(tx);
      const slot = slots.find((s) => s.id === id);
      if (slot === undefined) throw AppError.notFound('That meal slot was not found.');
      return slot;
    });
  }

  async listSlots(): Promise<readonly MealSlotRow[]> {
    return this.guard((tx) => this.slotsWithin(tx));
  }

  async addRecipe(body: RecipeRequest): Promise<RecipeRow> {
    return this.guard(async (tx) => {
      const id = newId();
      await tx.query(
        `INSERT INTO mdm.dk_recipes
           (id, hospital_id, code, name, allergens, iddsi_level, serve_temperature,
            is_veg, is_egg, is_jain, is_halal, nutrients, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5::text[],$6,$7::mdm."ServeTemperature",$8,$9,$10,$11,$12::jsonb,
                 now(),now())`,
        [
          id,
          this.hospitalId(),
          body.code,
          body.name,
          body.allergens,
          body.iddsiLevel,
          body.serveTemperature,
          body.isVeg,
          body.isEgg,
          body.isJain,
          body.isHalal,
          JSON.stringify(body.nutrients),
        ],
      );
      const { rows } = await tx.query<Record<string, unknown>>(`SELECT * FROM mdm.dk_recipes WHERE id = $1`, [
        id,
      ]);
      return this.toRecipe(this.one(rows), null);
    });
  }

  /**
   * The menu, read against one tray.
   *
   * A dish the patient cannot have comes back marked rather than filtered out,
   * and the mark says which of the two refusals it is: an allergen, which a
   * dietician may override, or an IDDSI level, which nobody may.
   */
  async listRecipes(query: RecipeQuery): Promise<readonly RecipeRow[]> {
    return this.guard(async (tx) => {
      const tray = query.trayId === undefined ? null : await this.trayWithin(tx, query.trayId);
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM mdm.dk_recipes r
          WHERE (r.hospital_id IS NULL OR r.hospital_id = $1)
            AND r.active
            AND ($2::text IS NULL OR r.name ILIKE '%' || $2::text || '%')
          ORDER BY r.name
          LIMIT $3`,
        [this.hospitalId(), query.q ?? null, query.limit],
      );
      return rows.map((r) => this.toRecipe(r, tray));
    });
  }

  /** The two thresholds, so the dispatch screen shows them rather than hits them. */
  async holdingLimits(): Promise<HoldingLimits> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT ops.hot_holding_min_tenth_c() AS hot, ops.cold_holding_max_tenth_c() AS cold`,
      );
      const row = this.one(rows);
      return { hotMinTenthC: asNumber(row.hot), coldMaxTenthC: asNumber(row.cold) };
    });
  }

  // ── The live diet ─────────────────────────────────────────────────────────

  /**
   * Set or replace a patient's live diet.
   *
   * Upserted on the admission because there is one diet per admission by
   * definition: two rows would be two answers to what the patient may eat, and
   * the tray would take whichever it read.
   */
  async setDiet(body: ActiveDietRequest): Promise<ActiveDietRow> {
    return this.guard(async (tx) => {
      // Through `ops.set_diet_clinical`, not a plain upsert. The clinical
      // columns are revoked from `hms_app` at column level, and that revoke has
      // to hold for the kitchen's route while still letting the dietician's
      // through — so the door is a definer function rather than a permission
      // check somebody could forget to write.
      //
      // It also re-derives every tray already planned against this diet, in
      // the same transaction, because a patient who goes nil by mouth at ten
      // has a lunch tray already planned and the hold has to reach it.
      await tx.query(
        `SELECT ops.set_diet_clinical(
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::text[],$11,$12,$13,
           $14::timestamptz,$15::timestamptz,$16::jsonb,$17,$18)`,
        [
          newId(),
          this.hospitalId(),
          this.branchId(),
          body.admissionId,
          body.patientId,
          body.wardId ?? null,
          body.bedLabel ?? null,
          body.dietTypeCode,
          body.orderRef ?? null,
          body.allergens,
          body.iddsiFoodLevel ?? null,
          body.iddsiFluidLevel ?? null,
          body.swallowOrderId ?? null,
          body.npoFrom ?? null,
          body.npoTo ?? null,
          JSON.stringify(body.preferences),
          body.attendantMeal,
          body.instructions ?? null,
        ],
      );

      return this.dietByAdmission(tx, body.admissionId);
    });
  }

  async updateDietOperational(id: string, body: DietOperationalRequest): Promise<ActiveDietRow> {
    return this.guard(async (tx) => {
      // Deliberately narrow. The clinical columns are revoked from `hms_app`,
      // so a wider statement here would not fail a review — it would fail at
      // the database, which is the point.
      await tx.query(
        `UPDATE ops.dk_active_diets
            SET ward_id        = coalesce($2::uuid, ward_id),
                bed_label      = coalesce($3, bed_label),
                preferences    = coalesce($4::jsonb, preferences),
                attendant_meal = coalesce($5::boolean, attendant_meal),
                instructions   = coalesce($6, instructions),
                updated_at     = now()
          WHERE id = $1 AND hospital_id = $7`,
        [
          id,
          body.wardId ?? null,
          body.bedLabel ?? null,
          body.preferences === undefined ? null : JSON.stringify(body.preferences),
          body.attendantMeal ?? null,
          body.instructions ?? null,
          this.hospitalId(),
        ],
      );
      return this.dietWithin(tx, id);
    });
  }

  async listDiets(query: DietQuery): Promise<readonly ActiveDietRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM ops.dk_active_diets d
          WHERE d.hospital_id = $1
            AND ($2::uuid IS NULL OR d.ward_id = $2::uuid)
            AND ($3::boolean IS NOT TRUE
                 OR (d.npo_from IS NOT NULL AND (d.npo_to IS NULL OR d.npo_to > now())))
            AND ($4::boolean IS NOT TRUE OR d.iddsi_food_level IS NOT NULL)
          ORDER BY d.ward_id, d.bed_label
          LIMIT $5`,
        [this.hospitalId(), query.wardId ?? null, query.npoOnly, query.texturedOnly, query.limit],
      );
      return rows.map((x) => this.toDiet(x));
    });
  }

  // ── Trays ─────────────────────────────────────────────────────────────────

  /**
   * Plan a meal for a set of beds.
   *
   * A whole ward in one call, because this is a tray line and not a form —
   * and because the NPO hold has to be derived for every bed at once or the
   * ones planned before the theatre list arrived would be missed.
   */
  async planTrays(body: TrayPlanRequest): Promise<readonly MealTrayRow[]> {
    return this.guard(async (tx) => {
      const planned: string[] = [];
      for (const dietId of body.activeDietIds) {
        const id = newId();
        const { rows } = await tx.query<Record<string, unknown>>(
          `INSERT INTO ops.dk_meal_trays
             (id, hospital_id, branch_id, service_date, slot_id, active_diet_id,
              patient_id, diet_type_code, created_by, created_at, updated_at)
           VALUES ($1,$2,$3,$4::date,$5,$6,
                   '00000000-0000-0000-0000-000000000000','pending',$7,now(),now())
           ON CONFLICT (active_diet_id, service_date, slot_id) DO NOTHING
           RETURNING id`,
          [id, this.hospitalId(), this.branchId(), body.serviceDate, body.slotId, dietId, this.actorId()],
        );
        // `ON CONFLICT DO NOTHING` returns nothing when the tray already
        // exists, which is the correct answer to planning a meal twice.
        if (rows[0] !== undefined) planned.push(asText(rows[0].id));
      }

      const trays: MealTrayRow[] = [];
      for (const id of planned) {
        const tray = await this.trayWithin(tx, id);
        trays.push(tray);

        // The ward needs to know the patient was not simply missed. A bed with
        // no tray and no explanation is a bed somebody chases the kitchen
        // about, and sometimes one where somebody quietly finds a biscuit.
        if (tray.status === 'held_npo') {
          await this.outbox.publish(
            tx,
            consoleEvent('dietary.tray.held', id, {
              trayId: id,
              patientId: tray.patientId,
              wardId: tray.wardId,
              slotCode: tray.slotCode,
              serviceDate: tray.serviceDate,
              holdReason: tray.holdReason ?? '',
            }),
          );
        }
      }
      return trays;
    });
  }

  async listTrays(query: TrayQuery): Promise<readonly MealTrayRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `${TRAY_SELECT}
          WHERE t.hospital_id = $1
            AND ($2::date IS NULL OR t.service_date = $2::date)
            AND ($3::uuid IS NULL OR t.slot_id = $3::uuid)
            AND ($4::uuid IS NULL OR t.ward_id = $4::uuid)
            AND ($5::boolean IS NOT TRUE OR t.status = 'held_npo')
            AND ($6::boolean IS NOT TRUE
                 OR t.status IN ('planned','held_npo','assembled','dispatched'))
          ORDER BY t.ward_id, t.bed_label
          LIMIT $7`,
        [
          this.hospitalId(),
          query.serviceDate ?? null,
          query.slotId ?? null,
          query.wardId ?? null,
          query.heldOnly,
          query.undeliveredOnly,
          query.limit,
        ],
      );
      return rows.map((x) => this.toTray(x));
    });
  }

  /**
   * Put a dish on a tray.
   *
   * The allergen and IDDSI checks are the database's. What is here is the
   * override plumbing: a reason turns into a named override, and a named
   * override is announced, because it is the one exception this module allows.
   */
  async addItem(trayId: string, body: TrayItemRequest): Promise<readonly MealItemRow[]> {
    return this.guard(async (tx) => {
      const id = newId();
      const overriding = body.overrideReason !== undefined;
      await tx.query(
        `INSERT INTO ops.dk_meal_items
           (id, hospital_id, tray_id, recipe_id, portions, override_by, override_reason,
            created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now(),now())
         ON CONFLICT (tray_id, recipe_id) DO UPDATE
            SET portions = EXCLUDED.portions,
                override_by = EXCLUDED.override_by,
                override_reason = EXCLUDED.override_reason,
                updated_at = now()`,
        [
          id,
          this.hospitalId(),
          trayId,
          body.recipeId,
          body.portions,
          overriding ? this.actorId() : null,
          body.overrideReason ?? null,
        ],
      );

      const items = await this.itemsWithin(tx, trayId);
      const item = items.find((i) => i.recipeId === body.recipeId);

      if (overriding && item !== undefined && item.allergens.length > 0) {
        const tray = await this.trayWithin(tx, trayId);

        await this.audit.write(tx, {
          action: 'override',
          entity: 'meal_item',
          rowId: item.id,
          businessKey: item.recipeName,
          dataClass: 'phi',
          patientId: tray.patientId,
          encounterId: null,
          reasonText: body.overrideReason ?? null,
          before: null,
          after: { allergens: item.allergens, recipeId: body.recipeId },
        });

        await this.outbox.publish(
          tx,
          consoleEvent('dietary.allergen.overridden', item.id, {
            itemId: item.id,
            trayId,
            patientId: tray.patientId,
            recipeId: body.recipeId,
            allergens: [...item.allergens],
            overrideBy: this.actorId(),
          }),
        );
      }

      return items;
    });
  }

  async listItems(trayId: string): Promise<readonly MealItemRow[]> {
    return this.guard((tx) => this.itemsWithin(tx, trayId));
  }

  /**
   * Send the trolley, with its temperature.
   *
   * The database decides which threshold applies from what is actually on the
   * tray, and refuses a reading outside it. A failure is announced because a
   * control point that fails twice in a week is an equipment problem, and
   * nobody sees that from inside a single refusal.
   */
  async dispatchTray(id: string, body: TrayDispatchRequest): Promise<MealTrayRow> {
    const seen: { tray: MealTrayRow | null } = { tray: null };
    try {
      return await this.guard(async (tx) => {
        seen.tray = await this.trayWithin(tx, id);
        await tx.query(
          `UPDATE ops.dk_meal_trays
              SET status = 'dispatched', dispatch_temp_tenth_c = $2,
                  dispatched_at = now(), dispatched_by = $3, updated_at = now()
            WHERE id = $1 AND hospital_id = $4`,
          [id, body.temperatureTenthC, this.actorId(), this.hospitalId()],
        );
        return this.trayWithin(tx, id);
      });
    } catch (err) {
      const tray = seen.tray;
      if (tray !== null) await this.publishTemperatureFailure(tray, body.temperatureTenthC);
      throw err;
    }
  }

  async deliverTray(id: string, body: TrayDeliverRequest): Promise<MealTrayRow> {
    return this.guard(async (tx) => {
      await tx.query(
        `UPDATE ops.dk_meal_trays
            SET status = 'delivered', delivered_at = now(), delivered_by = $2,
                intake_pct = coalesce($3::int, intake_pct), feedback = $4::jsonb,
                updated_at = now()
          WHERE id = $1 AND hospital_id = $5`,
        [id, this.actorId(), body.intakePct ?? null, JSON.stringify(body.feedback), this.hospitalId()],
      );
      return this.trayWithin(tx, id);
    });
  }

  async closeTray(id: string, body: TrayCloseRequest): Promise<MealTrayRow> {
    return this.guard(async (tx) => {
      await tx.query(
        `UPDATE ops.dk_meal_trays
            SET status = $2::ops."MealStatus", exception = $3, updated_at = now()
          WHERE id = $1 AND hospital_id = $4`,
        [id, body.status, body.exception, this.hospitalId()],
      );
      return this.trayWithin(tx, id);
    });
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  private one(rows: readonly Record<string, unknown>[]): Record<string, unknown> {
    const row = rows[0];
    if (row === undefined) throw AppError.notFound('That record was not found.');
    return row;
  }

  private async slotsWithin(tx: TransactionClient): Promise<readonly MealSlotRow[]> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT s.*,
              (EXTRACT(HOUR FROM now() AT TIME ZONE ops.hospital_timezone(s.hospital_id)) * 60
               + EXTRACT(MINUTE FROM now() AT TIME ZONE ops.hospital_timezone(s.hospital_id)))
                > s.cutoff_minute AS cutoff_passed
         FROM ops.dk_meal_slots s
        WHERE s.hospital_id = $1 AND s.active
        ORDER BY s.serve_minute`,
      [this.hospitalId()],
    );
    return rows.map((r) => ({
      id: asText(r.id),
      code: asText(r.code),
      name: asText(r.name),
      serveMinute: asNumber(r.serve_minute),
      cutoffMinute: asNumber(r.cutoff_minute),
      cutoffPassed: asBool(r.cutoff_passed),
    }));
  }

  private async dietWithin(tx: TransactionClient, id: string): Promise<ActiveDietRow> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM ops.dk_active_diets WHERE id = $1 AND hospital_id = $2`,
      [id, this.hospitalId()],
    );
    return this.toDiet(this.one(rows));
  }

  private async dietByAdmission(tx: TransactionClient, admissionId: string): Promise<ActiveDietRow> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM ops.dk_active_diets WHERE admission_id = $1 AND hospital_id = $2`,
      [admissionId, this.hospitalId()],
    );
    return this.toDiet(this.one(rows));
  }

  private async trayWithin(tx: TransactionClient, id: string): Promise<MealTrayRow> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `${TRAY_SELECT} WHERE t.id = $1 AND t.hospital_id = $2`,
      [id, this.hospitalId()],
    );
    return this.toTray(this.one(rows));
  }

  private async itemsWithin(tx: TransactionClient, trayId: string): Promise<readonly MealItemRow[]> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT i.*, r.name AS recipe_name
         FROM ops.dk_meal_items i JOIN mdm.dk_recipes r ON r.id = i.recipe_id
        WHERE i.tray_id = $1 AND i.hospital_id = $2
        ORDER BY r.name`,
      [trayId, this.hospitalId()],
    );
    return rows.map((r) => ({
      id: asText(r.id),
      trayId: asText(r.tray_id),
      recipeId: asText(r.recipe_id),
      recipeName: asText(r.recipe_name),
      portions: asNumber(r.portions),
      allergens: asStringArray(r.allergens),
      iddsiLevel: asNumberOrNull(r.iddsi_level),
      overrideBy: asTextOrNull(r.override_by),
      overrideReason: asTextOrNull(r.override_reason),
    }));
  }

  private async publishTemperatureFailure(tray: MealTrayRow, tenthC: number): Promise<void> {
    // Its own transaction: the one that tried the dispatch has been rolled
    // back by the trigger.
    await this.guard(async (tx) => {
      // Which threshold was missed follows from what is on the tray, not from
      // the reading: 12.0 °C is too cold for hot food and too warm for cold
      // food, and inferring the band from the number gets that backwards.
      // Scalar subqueries rather than a GROUP BY, so an empty tray returns a
      // row with a null band instead of no row at all — an empty tray is
      // refused for being empty, and that is not a temperature failure.
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT ops.hot_holding_min_tenth_c() AS hot,
                ops.cold_holding_max_tenth_c() AS cold,
                (SELECT bool_or(r.serve_temperature = 'hot')
                   FROM ops.dk_meal_items i
                   JOIN mdm.dk_recipes r ON r.id = i.recipe_id
                  WHERE i.tray_id = $1) AS carries_hot`,
        [tray.id],
      );
      const row = this.one(rows);
      if (row.carries_hot === null || row.carries_hot === undefined) return;

      const hot = asNumber(row.hot);
      const cold = asNumber(row.cold);
      const band = row.carries_hot === true ? 'hot' : 'cold';

      await this.outbox.publish(
        tx,
        consoleEvent('dietary.temperature.failed', tray.id, {
          trayId: tray.id,
          slotCode: tray.slotCode,
          wardId: tray.wardId,
          recordedTenthC: tenthC,
          requiredTenthC: band === 'hot' ? hot : cold,
          band,
        }),
      );
    });
  }

  private toDiet(r: Record<string, unknown>): ActiveDietRow {
    return {
      id: asText(r.id),
      admissionId: asText(r.admission_id),
      patientId: asText(r.patient_id),
      wardId: asTextOrNull(r.ward_id),
      bedLabel: asTextOrNull(r.bed_label),
      dietTypeCode: asText(r.diet_type_code),
      orderRef: asTextOrNull(r.order_ref),
      allergens: asStringArray(r.allergens),
      iddsiFoodLevel: asNumberOrNull(r.iddsi_food_level),
      iddsiFluidLevel: asNumberOrNull(r.iddsi_fluid_level),
      swallowOrderId: asTextOrNull(r.swallow_order_id),
      npoFrom: asTextOrNull(r.npo_from),
      npoTo: asTextOrNull(r.npo_to),
      preferences: asJson(r.preferences),
      attendantMeal: asBool(r.attendant_meal),
      instructions: asTextOrNull(r.instructions),
    };
  }

  private toTray(r: Record<string, unknown>): MealTrayRow {
    const status = asText(r.status);
    const itemCount = asNumber(r.item_count);
    const holdReason = asTextOrNull(r.hold_reason);

    // The same facts the dispatch trigger checks, said while there is still
    // time to do something about them.
    const blockedBy: string[] = [];
    if (status === 'held_npo') blockedBy.push(holdReason ?? 'the patient is nil by mouth');
    if (itemCount === 0 && status !== 'cancelled') blockedBy.push('nothing is on the tray');

    return {
      id: asText(r.id),
      serviceDate: asText(r.service_date),
      slotId: asText(r.slot_id),
      slotCode: asText(r.slot_code),
      activeDietId: asText(r.active_diet_id),
      patientId: asText(r.patient_id),
      wardId: asTextOrNull(r.ward_id),
      bedLabel: asTextOrNull(r.bed_label),
      dietTypeCode: asText(r.diet_type_code),
      allergens: asStringArray(r.allergens),
      iddsiFoodLevel: asNumberOrNull(r.iddsi_food_level),
      iddsiFluidLevel: asNumberOrNull(r.iddsi_fluid_level),
      ticketNo: asTextOrNull(r.ticket_no),
      status,
      holdReason,
      dispatchTempTenthC: asNumberOrNull(r.dispatch_temp_tenth_c),
      dispatchedAt: asTextOrNull(r.dispatched_at),
      deliveredAt: asTextOrNull(r.delivered_at),
      intakePct: asNumberOrNull(r.intake_pct),
      exception: asTextOrNull(r.exception),
      itemCount,
      blockedBy,
    };
  }

  private toRecipe(r: Record<string, unknown>, tray: MealTrayRow | null): RecipeRow {
    const allergens = asStringArray(r.allergens);
    const iddsiLevel = asNumber(r.iddsi_level);

    let reason: string | null = null;
    let overridable = false;

    if (tray !== null) {
      // The IDDSI ceiling first, because it is the one nobody can override and
      // a screen offering an override on it would be teaching a lie.
      if (tray.iddsiFoodLevel !== null && iddsiLevel > tray.iddsiFoodLevel) {
        reason = `IDDSI level ${String(iddsiLevel)} — this patient has a swallow order at level ${String(tray.iddsiFoodLevel)}`;
      } else {
        const clash = allergens.filter((a) => tray.allergens.includes(a));
        if (clash.length > 0) {
          reason = `contains ${clash.join(' and ')}, which this patient is allergic to`;
          overridable = true;
        }
      }
    }

    return {
      id: asText(r.id),
      code: asText(r.code),
      name: asText(r.name),
      allergens,
      iddsiLevel,
      serveTemperature: asText(r.serve_temperature),
      isVeg: asBool(r.is_veg),
      isEgg: asBool(r.is_egg),
      isJain: asBool(r.is_jain),
      isHalal: asBool(r.is_halal),
      servable: reason === null,
      reason,
      overridable,
    };
  }
}

const TRAY_SELECT = `
  SELECT t.*, s.code AS slot_code,
         (SELECT count(*) FROM ops.dk_meal_items i WHERE i.tray_id = t.id) AS item_count
    FROM ops.dk_meal_trays t
    JOIN ops.dk_meal_slots s ON s.id = t.slot_id`;
