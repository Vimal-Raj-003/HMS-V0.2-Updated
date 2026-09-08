/** Mirrors `services/api/src/modules/nonclinical/dietary/dietary.types.ts`. */

export interface ActiveDietRow {
  readonly id: string;
  readonly admissionId: string;
  readonly patientId: string;
  readonly wardId: string | null;
  readonly bedLabel: string | null;
  readonly dietTypeCode: string;
  readonly allergens: readonly string[];
  readonly iddsiFoodLevel: number | null;
  readonly iddsiFluidLevel: number | null;
  readonly npoFrom: string | null;
  readonly npoTo: string | null;
  readonly attendantMeal: boolean;
  readonly instructions: string | null;
}

export interface MealItemRow {
  readonly id: string;
  readonly trayId: string;
  readonly recipeId: string;
  readonly recipeName: string;
  readonly portions: number;
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
  readonly patientId: string;
  readonly wardId: string | null;
  readonly bedLabel: string | null;
  readonly dietTypeCode: string;
  readonly allergens: readonly string[];
  readonly iddsiFoodLevel: number | null;
  readonly status: string;
  readonly holdReason: string | null;
  readonly dispatchTempTenthC: number | null;
  readonly intakePct: number | null;
  readonly itemCount: number;
  readonly blockedBy: readonly string[];
}

export interface RecipeRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly allergens: readonly string[];
  readonly iddsiLevel: number;
  readonly serveTemperature: string;
  readonly servable: boolean;
  readonly reason: string | null;
  /** True only for the allergen refusal. A swallow order has no override. */
  readonly overridable: boolean;
}

export interface MealSlotRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly serveMinute: number;
  readonly cutoffMinute: number;
  readonly cutoffPassed: boolean;
}

export interface HoldingLimits {
  readonly hotMinTenthC: number;
  readonly coldMaxTenthC: number;
}
