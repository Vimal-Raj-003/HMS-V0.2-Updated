import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { DietaryService } from './dietary.service.js';
import {
  activeDietSchema,
  dietOperationalSchema,
  dietQuerySchema,
  mealSlotSchema,
  recipeQuerySchema,
  recipeSchema,
  trayCloseSchema,
  trayDeliverSchema,
  trayDispatchSchema,
  trayItemSchema,
  trayPlanSchema,
  trayQuerySchema,
  type ActiveDietRequest,
  type DietOperationalRequest,
  type DietQuery,
  type MealSlotRequest,
  type RecipeQuery,
  type RecipeRequest,
  type TrayCloseRequest,
  type TrayDeliverRequest,
  type TrayDispatchRequest,
  type TrayItemRequest,
  type TrayPlanRequest,
  type TrayQuery,
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
 * `/api/v1/dietary/*` — NC-033, the Phase 8 half.
 *
 * ── No route sets a diet, a texture level or an allergen list ──────────────
 *
 * Those come from OP-011's order and OP-035's swallow order, and the columns
 * are revoked from the application on the diet itself. The kitchen's routes
 * cover its own half: a preference, a bed move, an attendant meal.
 *
 * ── None overrides a swallow order ─────────────────────────────────────────
 *
 * A patient assessed at IDDSI level 4 who is handed level 7 toast aspirates it.
 * The allergen guard has an override because there is a real clinical
 * judgement behind it; this one has none, and the exception is a new swallow
 * order from whoever did the assessment.
 *
 * ── And none that dispatches without a temperature ─────────────────────────
 *
 * The temperature is the control point. A control point nobody measured is a
 * control point that is not there, so it is a required field on the only route
 * that dispatches.
 */
@Controller()
export class DietaryController {
  constructor(@Inject(DietaryService) private readonly svc: DietaryService) {}

  // ── Masters ───────────────────────────────────────────────────────────────

  @Permission('dietary.master.manage')
  @Idempotent()
  @Post('dietary/slots')
  async addSlot(@Body(new ZodBody(mealSlotSchema)) body: MealSlotRequest): Promise<MealSlotRow> {
    return this.svc.addSlot(body);
  }

  @Permission('dietary.read')
  @Get('dietary/slots')
  async listSlots(): Promise<readonly MealSlotRow[]> {
    return this.svc.listSlots();
  }

  @Permission('dietary.master.manage')
  @Idempotent()
  @Post('dietary/recipes')
  async addRecipe(@Body(new ZodBody(recipeSchema)) body: RecipeRequest): Promise<RecipeRow> {
    return this.svc.addRecipe(body);
  }

  /**
   * The menu, read against one tray. A dish the patient cannot have comes back
   * marked rather than filtered out, and the mark says which of the two
   * refusals it is — because a screen that offers an override on a swallow
   * order would be teaching a lie.
   */
  @Permission('dietary.read')
  @Get('dietary/recipes')
  async listRecipes(
    @Query(new ZodBody(recipeQuerySchema)) query: RecipeQuery,
  ): Promise<readonly RecipeRow[]> {
    return this.svc.listRecipes(query);
  }

  @Permission('dietary.read')
  @Get('dietary/holding-limits')
  async holdingLimits(): Promise<HoldingLimits> {
    return this.svc.holdingLimits();
  }

  // ── The live diet ─────────────────────────────────────────────────────────

  /** The dietician's route. One diet per admission, upserted. */
  @Permission('dietary.diet.operational')
  @Idempotent()
  @Post('dietary/diets')
  async setDiet(@Body(new ZodBody(activeDietSchema)) body: ActiveDietRequest): Promise<ActiveDietRow> {
    return this.svc.setDiet(body);
  }

  /** The kitchen's half: a preference, a bed move, an attendant meal. */
  @Permission('dietary.diet.operational')
  @Post('dietary/diets/:id')
  async updateDiet(
    @Param('id') id: string,
    @Body(new ZodBody(dietOperationalSchema)) body: DietOperationalRequest,
  ): Promise<ActiveDietRow> {
    return this.svc.updateDietOperational(id, body);
  }

  @Permission('dietary.diet.read')
  @Get('dietary/diets')
  async listDiets(@Query(new ZodBody(dietQuerySchema)) query: DietQuery): Promise<readonly ActiveDietRow[]> {
    return this.svc.listDiets(query);
  }

  // ── Trays ─────────────────────────────────────────────────────────────────

  @Permission('dietary.tray.plan')
  @Idempotent()
  @Post('dietary/trays')
  async planTrays(@Body(new ZodBody(trayPlanSchema)) body: TrayPlanRequest): Promise<readonly MealTrayRow[]> {
    return this.svc.planTrays(body);
  }

  @Permission('dietary.read')
  @Get('dietary/trays')
  async listTrays(@Query(new ZodBody(trayQuerySchema)) query: TrayQuery): Promise<readonly MealTrayRow[]> {
    return this.svc.listTrays(query);
  }

  /**
   * Put a dish on a tray. An `overrideReason` turns this into the dietician's
   * override of the allergen guard — the one exception in this module — and it
   * needs `dietary.allergen.override` rather than this key.
   */
  @Permission('dietary.tray.assemble')
  @Post('dietary/trays/:id/items')
  async addItem(
    @Param('id') id: string,
    @Body(new ZodBody(trayItemSchema)) body: TrayItemRequest,
  ): Promise<readonly MealItemRow[]> {
    return this.svc.addItem(id, body);
  }

  /** The same act, with the override. Separated so the key can be. */
  @Permission('dietary.allergen.override')
  @Post('dietary/trays/:id/items/override')
  async addItemWithOverride(
    @Param('id') id: string,
    @Body(new ZodBody(trayItemSchema)) body: TrayItemRequest,
  ): Promise<readonly MealItemRow[]> {
    return this.svc.addItem(id, body);
  }

  @Permission('dietary.read')
  @Get('dietary/trays/:id/items')
  async listItems(@Param('id') id: string): Promise<readonly MealItemRow[]> {
    return this.svc.listItems(id);
  }

  @Permission('dietary.tray.dispatch')
  @Post('dietary/trays/:id/dispatch')
  async dispatchTray(
    @Param('id') id: string,
    @Body(new ZodBody(trayDispatchSchema)) body: TrayDispatchRequest,
  ): Promise<MealTrayRow> {
    return this.svc.dispatchTray(id, body);
  }

  @Permission('dietary.tray.deliver')
  @Post('dietary/trays/:id/deliver')
  async deliverTray(
    @Param('id') id: string,
    @Body(new ZodBody(trayDeliverSchema)) body: TrayDeliverRequest,
  ): Promise<MealTrayRow> {
    return this.svc.deliverTray(id, body);
  }

  @Permission('dietary.tray.deliver')
  @Post('dietary/trays/:id/close')
  async closeTray(
    @Param('id') id: string,
    @Body(new ZodBody(trayCloseSchema)) body: TrayCloseRequest,
  ): Promise<MealTrayRow> {
    return this.svc.closeTray(id, body);
  }
}
