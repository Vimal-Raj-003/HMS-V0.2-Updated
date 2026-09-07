import type { Route } from 'next';

/**
 * The Phase-8 specialty screens, declared once.
 *
 * Same contract as `features/inpatient/screens.ts`: the left navigation, the
 * console home and the ⌘K palette read one list. A console's *own* screens are
 * declared by the console; what is here is the framework's own — the registry
 * an administrator composes from.
 */
export interface SpecialtyScreen {
  readonly key: string;
  readonly label: string;
  readonly href: Route;
  readonly area: 'specialty';
  readonly permission: string;
  readonly summary: string;
  readonly deniedExplanation: string;
  readonly keywords: readonly string[];
  readonly entitlement: string | null;
}

export const SPECIALTY_SCREENS: readonly SpecialtyScreen[] = [
  {
    key: 'console-registry',
    label: 'Specialty consoles',
    href: '/specialty/consoles',
    area: 'specialty',
    permission: 'console.registry.read',
    summary:
      'Which specialties have a workspace of their own, what is on it, and which departments open it — composed from the tabs this build ships, with no deploy.',
    deniedExplanation:
      'Seeing which consoles exist is held widely, because a clinician needs to know why their department opens the workspace it does. Composing one changes what a whole department sees on its next patient, so it sits with administration and records a reason.',
    keywords: [
      'specialty console',
      'console',
      'registry',
      'tabs',
      'workspace',
      'ophthalmology',
      'dental',
      'cardiology',
      'device result',
      'worklist',
    ],
    entitlement: null,
  },
  {
    key: 'eye-clinic',
    label: 'Eye clinic',
    href: '/ophtha/clinic',
    area: 'specialty',
    permission: 'ophtha.visit.read',
    summary:
      'The refraction lane, the examination and the lens plan \u2014 one column per eye, an acuity ladder that has a bottom, and powers that move in quarter dioptres.',
    deniedExplanation:
      'The eye clinic is held by ophthalmologists, optometrists and the nurses who run the lanes. Recording is wide; signing the visit is the consultant\u2019s, and signing a spectacle prescription is a further key a hospital delegates deliberately.',
    keywords: [
      'ophthalmology',
      'eye',
      'refraction',
      'visual acuity',
      'spectacle',
      'glasses',
      'intraocular pressure',
      'glaucoma',
      'cataract',
      'retinopathy',
      'oct',
      'logmar',
    ],
    entitlement: 'module.ophthalmology.enabled',
  },
];

export function specialtyScreen(key: string): SpecialtyScreen {
  const screen = SPECIALTY_SCREENS.find((candidate) => candidate.key === key);
  if (screen === undefined) throw new Error(`Unknown specialty screen: ${key}`);
  return screen;
}

export const SPECIALTY_ROUTES: readonly Route[] = SPECIALTY_SCREENS.map((screen) => screen.href);
