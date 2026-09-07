/** Query keys for the five device consoles, tenant-scoped like every other feature's. */
export function consoleKeys(hospitalId: string) {
  const root = ['device-consoles', hospitalId] as const;
  return {
    root,
    ecgs: (scope: string) => [...root, 'cardio', 'ecgs', scope] as const,
    ecgsRoot: () => [...root, 'cardio', 'ecgs'] as const,
    inrVisits: (enrolmentId: string) => [...root, 'cardio', 'inr', enrolmentId] as const,

    pfts: (scope: string) => [...root, 'pulmo', 'pft', scope] as const,
    pftsRoot: () => [...root, 'pulmo', 'pft'] as const,
    sleepStudies: (scope: string) => [...root, 'pulmo', 'sleep', scope] as const,
    papRx: (scope: string) => [...root, 'pulmo', 'pap', scope] as const,

    audiologyTests: (scope: string) => [...root, 'ent', 'audiology', scope] as const,
    audiologyRoot: () => [...root, 'ent', 'audiology'] as const,
    audiologyTest: (id: string) => [...root, 'ent', 'audiology', 'one', id] as const,

    dentalChart: (patientId: string) => [...root, 'dental', 'chart', patientId] as const,
    dentalPlans: (scope: string) => [...root, 'dental', 'plans', scope] as const,
    dentalPlansRoot: () => [...root, 'dental', 'plans'] as const,

    lesions: (scope: string) => [...root, 'derm', 'lesions', scope] as const,
    biopsies: (scope: string) => [...root, 'derm', 'biopsies', scope] as const,
    biopsiesRoot: () => [...root, 'derm', 'biopsies'] as const,
    courses: (scope: string) => [...root, 'derm', 'phototherapy', scope] as const,
    coursesRoot: () => [...root, 'derm', 'phototherapy'] as const,
  };
}

export type ConsoleKeys = ReturnType<typeof consoleKeys>;
