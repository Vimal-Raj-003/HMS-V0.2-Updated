/** Query keys for OP-037. */
export function ayushKeys(hospitalId: string) {
  const root = ['ayush', hospitalId] as const;
  return {
    root,
    registrations: (scope: string) => [...root, 'registrations', scope] as const,
    consults: (scope: string) => [...root, 'consults', scope] as const,
    courses: (scope: string) => [...root, 'courses', scope] as const,
    sessions: (courseId: string) => [...root, 'sessions', courseId] as const,
    limits: [...root, 'heavy-metal-limits'] as const,
  };
}

export type AyushKeys = ReturnType<typeof ayushKeys>;
