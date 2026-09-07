/** Query keys for the procedure board and the nursing rooms. */
export function procedureKeys(hospitalId: string) {
  const root = ['procedures', hospitalId] as const;
  return {
    root,
    orders: (scope: string) => [...root, 'orders', scope] as const,
    ordersRoot: () => [...root, 'orders'] as const,
    order: (id: string) => [...root, 'order', id] as const,
    rooms: () => [...root, 'rooms'] as const,
    tasks: (scope: string) => [...root, 'tasks', scope] as const,
    tasksRoot: () => [...root, 'tasks'] as const,
  };
}

export type ProcedureKeys = ReturnType<typeof procedureKeys>;
