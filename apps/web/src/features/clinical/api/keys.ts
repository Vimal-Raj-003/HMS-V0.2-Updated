/**
 * TanStack Query cache keys for the clinical screens, scoped to the tenant
 * (`CLAUDE.md` §2), exactly as `features/frontoffice/api/keys.ts` is.
 *
 * The `hospitalId` prefix is not decoration. A group clinician switches
 * hospitals inside one browser tab; without the prefix, hospital B's allergy
 * list would be served from hospital A's cache entry — and an allergy list from
 * the wrong tenant is the input to the prescribing hard stop. Prefixing makes
 * the switch a cache miss, which is the only correct answer.
 *
 * Nothing here is keyed by anything that would reach the address bar: the keys
 * carry opaque ids, and `docs/06` §6.5's "no PHI in the URL" is honoured by the
 * routes in `app/(workspace)/clinical`, which take ids and nothing else.
 */
export function clinicalKeys(hospitalId: string) {
  const root = ['vims', hospitalId, 'clinical'] as const;
  return {
    root,

    referenceRanges: () => [...root, 'vitals', 'reference-ranges'] as const,
    vitalsFor: (patientId: string) => [...root, 'vitals', 'patient', patientId] as const,
    vitals: () => [...root, 'vitals'] as const,
    /** The open visits a reading can be attached to. */
    visitsForPatient: (patientId: string) => [...root, 'visits', 'patient', patientId] as const,

    encounter: (id: string) => [...root, 'encounter', id] as const,
    encounters: () => [...root, 'encounter'] as const,
    noteVersions: (id: string) => [...root, 'encounter', id, 'note-versions'] as const,

    timeline: (patientId: string, kinds: string) => [...root, 'timeline', patientId, kinds] as const,
    problems: (patientId: string) => [...root, 'problems', patientId] as const,
    medications: (patientId: string) => [...root, 'medications', patientId] as const,
    allergies: (patientId: string) => [...root, 'allergies', patientId] as const,
    patientRecord: (patientId: string) => [...root, 'patient', patientId] as const,

    drugSearch: (term: string) => [...root, 'drugs', term] as const,
    prescription: (id: string) => [...root, 'prescription', id] as const,
    prescriptions: () => [...root, 'prescription'] as const,

    alerts: (patientId: string) => [...root, 'cdss', 'alerts', patientId] as const,
    fatigue: (days: number) => [...root, 'cdss', 'fatigue', days] as const,

    orders: (patientId: string) => [...root, 'orders', patientId] as const,
  };
}

export type ClinicalKeys = ReturnType<typeof clinicalKeys>;
