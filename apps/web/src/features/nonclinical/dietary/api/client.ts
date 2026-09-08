import { queryString, request } from '@/features/specialty/api/http';
import type { ActiveDietRow, HoldingLimits, MealItemRow, MealSlotRow, MealTrayRow, RecipeRow } from './types';

/**
 * Every call the tray line makes.
 *
 * Nothing here sets a diet type, a texture level or an allergen list from the
 * kitchen, overrides a swallow order, or dispatches without a temperature —
 * because no such endpoint exists to call.
 */

const V1 = '/api/v1';

interface Signal {
  readonly signal?: AbortSignal;
}
function withSignal(options: Signal): { signal?: AbortSignal } {
  return options.signal === undefined ? {} : { signal: options.signal };
}

export async function getSlots(options: Signal = {}): Promise<readonly MealSlotRow[]> {
  return request(`${V1}/dietary/slots`, withSignal(options));
}

export async function getDiets(
  filters: { readonly wardId?: string; readonly npoOnly?: boolean } = {},
  options: Signal = {},
): Promise<readonly ActiveDietRow[]> {
  return request(
    `${V1}/dietary/diets${queryString({ wardId: filters.wardId, npoOnly: filters.npoOnly })}`,
    withSignal(options),
  );
}

export async function getTrays(
  filters: {
    readonly serviceDate?: string;
    readonly slotId?: string;
    readonly wardId?: string;
    readonly heldOnly?: boolean;
    readonly undeliveredOnly?: boolean;
  } = {},
  options: Signal = {},
): Promise<readonly MealTrayRow[]> {
  return request(
    `${V1}/dietary/trays${queryString({
      serviceDate: filters.serviceDate,
      slotId: filters.slotId,
      wardId: filters.wardId,
      heldOnly: filters.heldOnly,
      undeliveredOnly: filters.undeliveredOnly,
    })}`,
    withSignal(options),
  );
}

export async function getTrayItems(trayId: string, options: Signal = {}): Promise<readonly MealItemRow[]> {
  return request(`${V1}/dietary/trays/${trayId}/items`, withSignal(options));
}

/** The menu read against one tray, so a plate is never assembled that cannot go. */
export async function getRecipes(
  trayId: string | undefined,
  options: Signal = {},
): Promise<readonly RecipeRow[]> {
  return request(`${V1}/dietary/recipes${queryString({ trayId })}`, withSignal(options));
}

export async function getHoldingLimits(options: Signal = {}): Promise<HoldingLimits> {
  return request(`${V1}/dietary/holding-limits`, withSignal(options));
}
