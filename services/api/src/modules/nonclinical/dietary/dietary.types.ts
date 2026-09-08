/**
 * What the tray line returns.
 *
 * The derived fields are all versions of one question: *will this tray go, and
 * if not, why?* A tray-line screen that answers it only when the refusal
 * arrives is a screen where somebody assembles food that cannot be served.
 */

export interface ActiveDietRow {
  readonly id: string;
  readonly admissionId: string;
  readonly patientId: string;
  readonly wardId: string | null;
  readonly bedLabel: string | null;
  readonly dietTypeCode: string;
  readonly orderRef: string | null;
  /** Copied from the patient record when the diet is set. Never typed here. */
  readonly allergens: readonly string[];
  readonly iddsiFoodLevel: number | null;
  readonly iddsiFluidLevel: number | null;
  readonly swallowOrderId: string | null;
  readonly npoFrom: string | null;
  readonly npoTo: string | null;
  readonly preferences: Record<string, unknown>;
  readonly attendantMeal: boolean;
  readonly instructions: string | null;
}

export interface MealItemRow {
  readonly id: string;
  readonly trayId: string;
  readonly recipeId: string;
  readonly recipeName: string;
  readonly portions: number;
  /** Stamped from the recipe by the trigger that checked it. */
  readonly allergens: readonly string[];
  readonly iddsiLevel: number | null;
  readonly overrideBy: string | null;
  readonly overrideReason: string | null;
}

export interface MealTrayRow {
  readonly id: string;
  readonly serviceDate: string;
  readonly slotId: string;
  readonly slotCode: string;
  readonly activeDietId: string;
  readonly patientId: string;
  readonly wardId: string | null;
  readonly bedLabel: string | null;
  /** Copied at planning. There is no request field for any of these four. */
  readonly dietTypeCode: string;
  readonly allergens: readonly string[];
  readonly iddsiFoodLevel: number | null;
  readonly iddsiFluidLevel: number | null;
  readonly ticketNo: string | null;
  readonly status: string;
  readonly holdReason: string | null;
  readonly dispatchTempTenthC: number | null;
  readonly dispatchedAt: string | null;
  readonly deliveredAt: string | null;
  readonly intakePct: number | null;
  readonly exception: string | null;
  readonly itemCount: number;
  /** What is standing between this tray and a trolley. */
  readonly blockedBy: readonly string[];
}

export interface RecipeRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly allergens: readonly string[];
  readonly iddsiLevel: number;
  readonly serveTemperature: string;
  readonly isVeg: boolean;
  readonly isEgg: boolean;
  readonly isJain: boolean;
  readonly isHalal: boolean;
  /** True when this dish can go on the tray that was asked about. */
  readonly servable: boolean;
  /** Why not, in the words the refusal would use. */
  readonly reason: string | null;
  /** True when a dietician could override it — the allergen guard, not IDDSI. */
  readonly overridable: boolean;
}

export interface MealSlotRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly serveMinute: number;
  readonly cutoffMinute: number;
  /** Derived against the hospital's clock: whether the count is still open. */
  readonly cutoffPassed: boolean;
}

export interface HoldingLimits {
  readonly hotMinTenthC: number;
  readonly coldMaxTenthC: number;
}
