/** Query keys for IP-019 and OP-024. */
export function transplantKeys(hospitalId: string) {
  const root = ['transplant', hospitalId] as const;
  return {
    root,
    recipients: (scope: string) => [...root, 'recipients', scope] as const,
    donations: (scope: string) => [...root, 'donations', scope] as const,
    donors: (scope: string) => [...root, 'donors', scope] as const,
    cycles: (scope: string) => [...root, 'cycles', scope] as const,
  };
}

export type TransplantKeys = ReturnType<typeof transplantKeys>;
