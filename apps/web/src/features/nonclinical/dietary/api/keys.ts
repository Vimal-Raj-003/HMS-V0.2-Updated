/** Query keys for NC-033. */
export function dietaryKeys(hospitalId: string) {
  const root = ['dietary', hospitalId] as const;
  return {
    root,
    slots: [...root, 'slots'] as const,
    diets: (scope: string) => [...root, 'diets', scope] as const,
    trays: (scope: string) => [...root, 'trays', scope] as const,
    items: (trayId: string) => [...root, 'items', trayId] as const,
    recipes: (trayId: string) => [...root, 'recipes', trayId] as const,
    limits: [...root, 'holding-limits'] as const,
  };
}

export type DietaryKeys = ReturnType<typeof dietaryKeys>;
