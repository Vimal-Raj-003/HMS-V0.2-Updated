import type { Route } from 'next';

/**
 * The Phase-6 orthopaedic screens, declared once.
 *
 * Same contract as `features/emergency/screens.ts`: the left navigation, the
 * console home and the ⌘K palette read one list.
 */
export interface OrthoScreen {
  readonly key: string;
  readonly label: string;
  readonly href: Route;
  readonly area: 'ortho';
  readonly permission: string;
  readonly summary: string;
  readonly deniedExplanation: string;
  readonly keywords: readonly string[];
  readonly entitlement: string | null;
}

export const ORTHO_SCREENS: readonly OrthoScreen[] = [
  {
    key: 'fracture-registry',
    label: 'Fracture registry',
    href: '/ortho/fractures',
    area: 'ortho',
    permission: 'fracture.record.list',
    summary:
      'Every fracture, with its AO/OTA code, its side, and whether the row would survive a registry export — the gaps named rather than counted.',
    deniedExplanation:
      'The fracture registry is held by orthopaedics, the emergency floor, radiology and MRD. Registering one provisionally is deliberately easy: a fracture nobody entered is one the registry never counts and nobody follows up.',
    keywords: [
      'fracture',
      'ao',
      'ota',
      'gustilo',
      'open fracture',
      'registry',
      'union',
      'nonunion',
      'ortho',
      'bone',
      'salter harris',
      'laterality',
      'side',
    ],
    entitlement: 'module.ortho.enabled',
  },
  {
    key: 'fracture-record',
    label: 'Fracture record',
    href: '/ortho/fractures/record',
    area: 'ortho',
    permission: 'fracture.record.read',
    summary:
      'One fracture: the classification, the plan and its side, the healing films with weeks since injury, the open-fracture clocks, and the union call.',
    deniedExplanation:
      'Reading a fracture record is held by the clinicians treating the patient and by radiology. Confirming the AO code and declaring union are separate keys held by orthopaedic surgeons — a classification is a treatment decision written as a number.',
    keywords: [
      'fracture record',
      'ao code',
      'weight bearing',
      'rust score',
      'antibiotic clock',
      'open fracture bundle',
      'healing',
      'union',
      'timeline',
    ],
    entitlement: 'module.ortho.enabled',
  },
];

export function orthoScreen(key: string): OrthoScreen {
  const screen = ORTHO_SCREENS.find((candidate) => candidate.key === key);
  if (screen === undefined) throw new Error(`Unknown ortho screen: ${key}`);
  return screen;
}

export const ORTHO_ROUTES: readonly Route[] = ORTHO_SCREENS.map((screen) => screen.href);
