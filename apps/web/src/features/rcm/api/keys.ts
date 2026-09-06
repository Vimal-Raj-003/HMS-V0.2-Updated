/**
 * TanStack Query cache keys for RC-003, scoped to the tenant.
 *
 * The hospital prefix matters more here than almost anywhere else: a group
 * finance manager switches hospitals in one tab, and a *price* served from
 * another tenant's cache is a bill raised at the wrong hospital's rates.
 */
export function rcmKeys(hospitalId: string) {
  const root = ['vims', hospitalId, 'rcm'] as const;

  return {
    root,
    plans: (planType: string, status: string) => [...root, 'plans', planType, status] as const,
    plansRoot: () => [...root, 'plans'] as const,
    versions: (planId: string) => [...root, 'versions', planId] as const,
    versionsRoot: () => [...root, 'versions'] as const,
    items: (versionId: string) => [...root, 'items', versionId] as const,
    itemsRoot: () => [...root, 'items'] as const,
    missingRates: (status: string) => [...root, 'missing-rates', status] as const,
    missingRatesRoot: () => [...root, 'missing-rates'] as const,
    resolve: (serviceId: string, at: string) => [...root, 'resolve', serviceId, at] as const,
    changeLog: (versionId: string) => [...root, 'change-log', versionId] as const,

    // OP-005
    bills: (patientId: string, status: string) => [...root, 'bills', patientId, status] as const,
    billsRoot: () => [...root, 'bills'] as const,
    bill: (id: string) => [...root, 'bill', id] as const,
    billingExceptions: (status: string) => [...root, 'billing-exceptions', status] as const,

    // EN-010
    payments: () => [...root, 'payments'] as const,
    payIntents: (status: string) => [...root, 'pay-intents', status] as const,
    reconExceptions: (status: string) => [...root, 'recon-exceptions', status] as const,

    // OP-023
    packages: (status: string) => [...root, 'packages', status] as const,
    activation: (id: string) => [...root, 'activation', id] as const,
    variances: (activationId: string) => [...root, 'variances', activationId] as const,

    // EN-002 / RC-002
    preauths: (status: string) => [...root, 'preauths', status] as const,
    preauth: (id: string) => [...root, 'preauth', id] as const,

    // RC-007
    schemes: () => [...root, 'schemes'] as const,
    schemeCases: (status: string) => [...root, 'scheme-cases', status] as const,
    schemeCase: (id: string) => [...root, 'scheme-case', id] as const,
    schemeClaims: (status: string) => [...root, 'scheme-claims', status] as const,
    schemeClaim: (id: string) => [...root, 'scheme-claim', id] as const,
    schemeShortfalls: (status: string) => [...root, 'scheme-shortfalls', status] as const,
    cashAttempts: () => [...root, 'scheme-cash-attempts'] as const,

    // RC-008
    estimates: (status: string) => [...root, 'estimates', status] as const,
    estimate: (id: string) => [...root, 'estimate', id] as const,
    estimateVariance: () => [...root, 'estimate-variance'] as const,
    estimateVarianceSummary: () => [...root, 'estimate-variance-summary'] as const,

    // RC-006
    leakFindings: (status: string) => [...root, 'leak-findings', status] as const,
    leakFinding: (id: string) => [...root, 'leak-finding', id] as const,
    leakScans: () => [...root, 'leak-scans'] as const,
    leakDashboard: () => [...root, 'leak-dashboard'] as const,

    // NC-034
    payoutPeriods: () => [...root, 'payout-periods'] as const,
    payoutStatements: (periodId: string) => [...root, 'payout-statements', periodId] as const,
    payoutStatement: (id: string) => [...root, 'payout-statement', id] as const,
  };
}

export type RcmKeys = ReturnType<typeof rcmKeys>;
