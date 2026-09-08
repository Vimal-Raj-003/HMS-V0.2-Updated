import { queryFlag } from '@vims/contracts';
import { z } from 'zod';

/**
 * Request shapes for NC-033's Phase 8 half.
 *
 * ── A tray has no `dietTypeCode`, `allergens` or IDDSI level ────────────────
 *
 * All four come from the active diet and are stamped by a trigger. A kitchen
 * that could type a diet code has decided what a patient eats, and a tray
 * carrying an allergen list somebody retyped is a tray checked against a copy
 * of a copy.
 *
 * ── Nor a `status` on planning ─────────────────────────────────────────────
 *
 * `held_npo` is derived from the nil-by-mouth window against the meal slot's
 * serve time, in the hospital's own clock. A patient nil by mouth for theatre
 * at seven is not a patient whose breakfast somebody should remember to
 * cancel, so forgetting is not one of the available actions.
 *
 * ── And no override for a swallow order, anywhere ──────────────────────────
 *
 * The allergen guard has one, because there is a real clinical judgement
 * behind it. The IDDSI ceiling does not: a patient assessed at level 4 who is
 * handed level 7 toast aspirates it, and the person who can change that is the
 * one who did the assessment.
 */

const uuid = z.string().uuid();

// ── Masters ─────────────────────────────────────────────────────────────────

export const mealSlotSchema = z
  .object({
    code: z.string().min(1).max(20),
    name: z.string().min(1).max(60),
    /** Wall-clock minutes past midnight in the hospital's own timezone. */
    serveMinute: z.number().int().min(0).max(1439),
    cutoffMinute: z.number().int().min(0).max(1439),
  })
  .refine((v) => v.cutoffMinute < v.serveMinute, {
    message: 'The count freezes before the meal is served.',
    path: ['cutoffMinute'],
  });
export type MealSlotRequest = z.infer<typeof mealSlotSchema>;

export const recipeSchema = z.object({
  code: z.string().min(1).max(60),
  name: z.string().min(1).max(160),
  /**
   * From a controlled list, because these are matched against the patient's
   * recorded allergens and free text would match nothing. Only settable at
   * creation — the column grant refuses an update, so a kitchen cannot clear
   * the peanut flag on a dish it has already listed.
   */
  allergens: z
    .array(
      z.enum([
        'peanut',
        'tree_nut',
        'milk',
        'egg',
        'wheat',
        'gluten',
        'soy',
        'fish',
        'shellfish',
        'sesame',
        'mustard',
        'celery',
        'sulphite',
      ]),
    )
    .default([]),
  /** 0–4 for fluids, 3–7 for foods, on the IDDSI framework. */
  iddsiLevel: z.number().int().min(0).max(7),
  serveTemperature: z.enum(['hot', 'cold', 'ambient']).default('hot'),
  isVeg: z.boolean().default(true),
  isEgg: z.boolean().default(false),
  isJain: z.boolean().default(false),
  isHalal: z.boolean().default(false),
  nutrients: z.record(z.string(), z.unknown()).default({}),
});
export type RecipeRequest = z.infer<typeof recipeSchema>;

export const recipeQuerySchema = z.object({
  /** When given, each dish comes back with whether it can go on *that* tray. */
  trayId: uuid.optional(),
  q: z.string().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(300).default(200),
});
export type RecipeQuery = z.infer<typeof recipeQuerySchema>;

// ── The live diet ───────────────────────────────────────────────────────────

export const activeDietSchema = z.object({
  admissionId: uuid,
  patientId: uuid,
  wardId: uuid.optional(),
  bedLabel: z.string().max(40).optional(),
  /** From OP-011's order. The kitchen's own routes cannot change it. */
  dietTypeCode: z.string().min(1).max(40),
  orderRef: uuid.optional(),
  allergens: z.array(z.string().max(40)).max(40).default([]),
  iddsiFoodLevel: z.number().int().min(0).max(7).optional(),
  iddsiFluidLevel: z.number().int().min(0).max(4).optional(),
  swallowOrderId: uuid.optional(),
  npoFrom: z.string().optional(),
  npoTo: z.string().optional(),
  preferences: z.record(z.string(), z.unknown()).default({}),
  attendantMeal: z.boolean().default(false),
  instructions: z.string().max(2000).optional(),
});
export type ActiveDietRequest = z.infer<typeof activeDietSchema>;

/** What the kitchen may change: its own half, and nothing clinical. */
export const dietOperationalSchema = z.object({
  wardId: uuid.optional(),
  bedLabel: z.string().max(40).optional(),
  preferences: z.record(z.string(), z.unknown()).optional(),
  attendantMeal: z.boolean().optional(),
  instructions: z.string().max(2000).optional(),
});
export type DietOperationalRequest = z.infer<typeof dietOperationalSchema>;

export const dietQuerySchema = z.object({
  wardId: uuid.optional(),
  npoOnly: queryFlag().default(false),
  texturedOnly: queryFlag().default(false),
  limit: z.coerce.number().int().min(1).max(300).default(200),
});
export type DietQuery = z.infer<typeof dietQuerySchema>;

// ── Trays ───────────────────────────────────────────────────────────────────

export const trayPlanSchema = z.object({
  serviceDate: z.string().date(),
  slotId: uuid,
  /** Plan the whole ward in one call: this is a tray line, not a form. */
  activeDietIds: z.array(uuid).min(1).max(400),
});
export type TrayPlanRequest = z.infer<typeof trayPlanSchema>;

export const trayItemSchema = z.object({
  recipeId: uuid,
  portions: z.number().int().min(1).max(20).default(1),
  /**
   * The dietician's decision to serve an item the allergen guard refused.
   * Both halves or neither — a name with no reason is a signature on a blank
   * page.
   */
  overrideReason: z.string().min(8).max(2000).optional(),
});
export type TrayItemRequest = z.infer<typeof trayItemSchema>;

export const trayDispatchSchema = z.object({
  /**
   * Tenths of a degree Celsius, so it stays an integer. Hot food leaves at
   * 63.0 °C or above and cold at 5.0 °C or below; the database decides which
   * rule applies from what is actually on the tray.
   */
  temperatureTenthC: z.number().int().min(-200).max(1000),
});
export type TrayDispatchRequest = z.infer<typeof trayDispatchSchema>;

export const trayDeliverSchema = z.object({
  /** A week at twenty per cent is a nutrition referral. */
  intakePct: z.number().int().min(0).max(100).optional(),
  feedback: z.record(z.string(), z.unknown()).default({}),
});
export type TrayDeliverRequest = z.infer<typeof trayDeliverSchema>;

export const trayCloseSchema = z.object({
  status: z.enum(['refused', 'returned', 'cancelled']),
  exception: z.string().min(4).max(2000),
});
export type TrayCloseRequest = z.infer<typeof trayCloseSchema>;

export const trayQuerySchema = z.object({
  serviceDate: z.string().date().optional(),
  slotId: uuid.optional(),
  wardId: uuid.optional(),
  heldOnly: queryFlag().default(false),
  undeliveredOnly: queryFlag().default(false),
  limit: z.coerce.number().int().min(1).max(400).default(200),
});
export type TrayQuery = z.infer<typeof trayQuerySchema>;
