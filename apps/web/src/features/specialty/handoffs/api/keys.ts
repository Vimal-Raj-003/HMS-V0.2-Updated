/** Query keys for OP-018, OP-021 and IP-020. */
export function handoffKeys(hospitalId: string) {
  const root = ['handoffs', hospitalId] as const;
  return {
    root,
    consults: (scope: string) => [...root, 'consults', scope] as const,
    drugRules: (consultId: string) => [...root, 'drug-rules', consultId] as const,
    referrals: (scope: string) => [...root, 'referrals', scope] as const,
    pathways: (scope: string) => [...root, 'pathways', scope] as const,
    variance: (scope: string) => [...root, 'variance', scope] as const,
  };
}

export type HandoffKeys = ReturnType<typeof handoffKeys>;
