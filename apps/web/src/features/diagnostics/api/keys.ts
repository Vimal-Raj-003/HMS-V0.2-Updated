/**
 * TanStack Query cache keys for the diagnostics screens, scoped to the tenant
 * (`CLAUDE.md` §2), exactly as `features/clinical/api/keys.ts` is.
 *
 * The `hospitalId` prefix is not decoration. A group pathologist or a
 * tele-radiologist switches hospitals inside one browser tab; without the prefix
 * hospital B's bench worklist would be served from hospital A's cache entry, and
 * a worklist from the wrong tenant is a specimen resulted against the wrong
 * patient.
 *
 * Nothing here is keyed by anything that reaches the address bar. The keys carry
 * opaque ids and coded filters; the routes under `app/(workspace)/diagnostics`
 * take no parameters at all, so `docs/06` §6.5's "no PHI in the URL" holds by
 * construction rather than by review.
 */
export function diagnosticsKeys(hospitalId: string) {
  const root = ['vims', hospitalId, 'diagnostics'] as const;
  const lab = [...root, 'lab'] as const;
  const rad = [...root, 'rad'] as const;

  return {
    root,

    // ── OP-004 laboratory ────────────────────────────────────────────────────
    labRoot: lab,
    labOrders: (status: string, priority: string) => [...lab, 'orders', status, priority] as const,
    labOrder: (id: string) => [...lab, 'order', id] as const,
    labSample: (barcode: string) => [...lab, 'sample', barcode] as const,
    labSamples: () => [...lab, 'sample'] as const,
    rejectionReasons: () => [...lab, 'rejection-reasons'] as const,
    testCatalogue: (term: string, discipline: string) => [...lab, 'tests', discipline, term] as const,

    bench: (discipline: string, stage: string) => [...lab, 'bench', discipline, stage] as const,
    benchRoot: () => [...lab, 'bench'] as const,
    labResult: (id: string) => [...lab, 'result', id] as const,
    labResults: () => [...lab, 'result'] as const,
    patientResults: (patientId: string) => [...lab, 'result', 'patient', patientId] as const,
    labResultChain: (id: string) => [...lab, 'result', id, 'chain'] as const,

    criticalValues: (open: boolean) => [...lab, 'critical', open ? 'open' : 'all'] as const,
    criticalValuesRoot: () => [...lab, 'critical'] as const,
    criticalValue: (id: string) => [...lab, 'critical', 'one', id] as const,

    qcState: (instrumentId: string, testKey: string) =>
      [...lab, 'qc', 'state', instrumentId, testKey] as const,
    qcStateRoot: () => [...lab, 'qc', 'state'] as const,
    qcRun: (id: string) => [...lab, 'qc', 'run', id] as const,

    // ── OP-008 / EN-008 / OP-022 ─────────────────────────────────────────────
    radRoot: rad,
    radOrders: (status: string, modality: string, priority: string) =>
      [...rad, 'orders', status, modality, priority] as const,
    radOrder: (id: string) => [...rad, 'order', id] as const,

    readingWorklist: (modality: string, status: string) => [...rad, 'reading', modality, status] as const,
    readingWorklistRoot: () => [...rad, 'reading'] as const,
    radReport: (id: string) => [...rad, 'report', id] as const,
    radReports: () => [...rad, 'report'] as const,
    radCriticals: (modality: string) => [...rad, 'criticals', modality] as const,
    radCriticalsRoot: () => [...rad, 'criticals'] as const,

    pacsStudies: (reconciliationStatus: string) => [...rad, 'pacs', 'studies', reconciliationStatus] as const,
    pacsStudiesRoot: () => [...rad, 'pacs', 'studies'] as const,
    pacsStudy: (id: string) => [...rad, 'pacs', 'study', id] as const,

    doseSummary: (patientId: string) => [...rad, 'dose', patientId] as const,

    investigations: (status: string, modalityGroup: string) =>
      [...root, 'investigations', 'worklist', status, modalityGroup] as const,
    investigationsRoot: () => [...root, 'investigations'] as const,
    investigationStudy: (id: string) => [...root, 'investigations', 'study', id] as const,
    investigationReport: (id: string) => [...root, 'investigations', 'report', id] as const,
  };
}

export type DiagnosticsKeys = ReturnType<typeof diagnosticsKeys>;
