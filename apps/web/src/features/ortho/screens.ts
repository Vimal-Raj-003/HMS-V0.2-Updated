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
  {
    key: 'implant-recalls',
    label: 'Implant recalls',
    href: '/ortho/implants/recalls',
    area: 'ortho',
    permission: 'implant.recall.read',
    summary:
      'Given a UDI or a lot number, exactly who is carrying that device — with the count of records that were typed rather than scanned, which is the confidence interval on the list.',
    deniedExplanation:
      'The recall desk is held by quality, and reading it needs the implant recall key. Running the trace is a further key again: it turns a device identifier into a list of patient names, and every run is recorded with the reason it was run.',
    keywords: [
      'recall',
      'udi',
      'lot',
      'field safety notice',
      'fsn',
      'implant',
      'traceability',
      'withdrawal',
      'advisory',
      'device',
      'trace',
    ],
    entitlement: 'module.ortho.enabled',
  },
  {
    key: 'plaster-room',
    label: 'Plaster room',
    href: '/ortho/plaster',
    area: 'ortho',
    permission: 'cast.request.read',
    summary:
      'Every cast, splint, brace and traction in place, ordered by how urgently the limb inside needs looking at — red flag first, then overdue, then due.',
    deniedExplanation:
      'The plaster room list is held by the clinicians and nurses who apply and check immobilisation. Removing a cast is a separate key: one off three weeks early is a fracture that displaces in the car park.',
    keywords: [
      'cast',
      'plaster',
      'splint',
      'backslab',
      'brace',
      'traction',
      'pop',
      'neurovascular',
      'compartment',
      'pin site',
      'immobilisation',
    ],
    entitlement: 'module.ortho.enabled',
  },
  {
    key: 'cast-record',
    label: 'Cast record',
    href: '/ortho/plaster/cast',
    area: 'ortho',
    permission: 'cast.request.read',
    summary:
      'One cast: the neurovascular check with its findings named in full, what was done about them, the pin-site grades, and taking it off.',
    deniedExplanation:
      'Reading a cast record is held by the clinicians looking after the limb. Recording a check is a separate key, and removing the cast a further one still.',
    keywords: [
      'cast record',
      'neurovascular check',
      'compartment syndrome',
      'capillary refill',
      'bivalve',
      'pin site',
      'checketts otterburn',
      'removal',
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
