import type { Route } from 'next';

/**
 * The Phase-6 emergency screens, declared once.
 *
 * Same contract as `features/rcm/screens.ts`: the left navigation, the console
 * home and the ⌘K palette read one list, because a screen added to one surface
 * and forgotten in another is how somebody reaches a page their navigation
 * deliberately hid.
 */
export interface ErScreen {
  readonly key: string;
  readonly label: string;
  readonly href: Route;
  readonly area: 'emergency';
  /** The **API's** permission key, so the screen is offered when its list loads. */
  readonly permission: string;
  readonly summary: string;
  readonly deniedExplanation: string;
  readonly keywords: readonly string[];
  readonly entitlement: string | null;
}

export const ER_SCREENS: readonly ErScreen[] = [
  {
    key: 'er-board',
    label: 'ER board',
    href: '/er/board',
    area: 'emergency',
    permission: 'er.board.read',
    summary:
      'Who is in the department, how sick, and how long they have waited — sorted strictly by acuity then by waiting time, with the ESI target clock on every row.',
    deniedExplanation:
      'The ER board is held by the emergency floor: triage nurses, emergency doctors and the front desk. Registering an arrival is deliberately one of the easiest permissions in the system to hold — a patient on a trolley cannot wait for an access request.',
    keywords: [
      'er',
      'emergency',
      'casualty',
      'board',
      'triage',
      'esi',
      'bay',
      'trolley',
      'resus',
      'ambulance',
      'quick registration',
      'unknown patient',
      'tag',
      'disposition',
      'lama',
    ],
    entitlement: 'module.emergency.enabled',
  },
];

export function erScreen(key: string): ErScreen {
  const screen = ER_SCREENS.find((candidate) => candidate.key === key);
  if (screen === undefined) throw new Error(`Unknown ER screen: ${key}`);
  return screen;
}

export const ER_ROUTES: readonly Route[] = ER_SCREENS.map((screen) => screen.href);
