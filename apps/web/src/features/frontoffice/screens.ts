import type { Route } from 'next';

/**
 * The front-office screens, declared once.
 *
 * The same reason `features/admin/screens.ts` exists: the left navigation, the
 * console home and the ⌘K palette are three navigation surfaces, and `docs/06`
 * §4.1 — "never render an item the user cannot use" — applies to all three
 * identically. Declaring the list three times is how a screen ends up reachable
 * from the palette by somebody whose menu correctly hid it.
 *
 * This module owns **no** navigation wiring. `FRONT_OFFICE_SCREENS` is exported
 * so whoever owns `src/lib/nav.ts` and the palette can consume it; nothing here
 * imports either.
 *
 * `entitlement` is the licence key that gates a screen, and two of the three are
 * deliberately `null`. EN-006 marks `queue.token.issue` and `queue.board.read`
 * `clinicalSafetyExempt` in the permission catalogue: an unpaid invoice or a
 * degraded licence tier must never stop a hospital handing out a token, showing
 * a board or calling the next patient. `queue.token.call` is on the same path —
 * a queue that can be joined and displayed but not called is a waiting room that
 * never moves — so the console carries no licence gate at all.
 */
export interface FrontOfficeScreen {
  readonly key: string;
  readonly label: string;
  readonly href: Route;
  /** The **API's** permission key, so the screen is offered exactly when its first request would succeed. */
  readonly permission: string;
  /** One line for the console home tile and the palette's secondary text. */
  readonly summary: string;
  /** Shown on the permission-denied state, in plain words (`docs/06` §6.7). */
  readonly deniedExplanation: string;
  /** ⌘K keywords beyond the label — what a user would actually type. */
  readonly keywords: readonly string[];
  /** Licence entitlement key, or `null` where safety forbids gating (EN-006 §5). */
  readonly entitlement: string | null;
}

export const FRONT_OFFICE_SCREENS: readonly FrontOfficeScreen[] = [
  {
    key: 'appointments',
    label: 'Appointment book',
    href: '/frontoffice/appointments',
    permission: 'appointment.list',
    summary: "A doctor's day or week, with capacity on every slot, drag or keyboard reschedule.",
    deniedExplanation:
      'The appointment book is held by reception, the call centre and clinical staff. Your roles do not include any of those.',
    keywords: ['appointment', 'book', 'slot', 'calendar', 'reschedule', 'cancel', 'check in', 'opd'],
    entitlement: 'module.appointments.enabled',
  },
  {
    key: 'queue',
    label: 'Queue console',
    href: '/frontoffice/queue',
    permission: 'queue.token.read',
    summary: 'The live queue at a counter: call next, recall, skip with a reason, transfer, complete.',
    deniedExplanation:
      'Reading a queue needs the token-read permission, which is held by reception, counter staff, nurses and doctors.',
    keywords: ['queue', 'token', 'call next', 'recall', 'skip', 'counter', 'waiting', 'board'],
    // Never licence-gated: EN-006 §5 / the `clinicalSafetyExempt` flag on
    // `queue.token.issue` and `queue.board.read`.
    entitlement: null,
  },
  {
    key: 'cash',
    label: 'Cash counter',
    href: '/frontoffice/cash',
    permission: 'receipt.shift.read',
    summary: 'Open a shift, take a split tender, refund, void, and close against a denomination sheet.',
    deniedExplanation:
      'The cash counter is held by cashiers, billing executives and finance. Reading a drawer you do not operate is deliberately not granted to everyone.',
    keywords: ['cash', 'counter', 'shift', 'receipt', 'payment', 'refund', 'void', 'denomination', 'float'],
    entitlement: 'module.cash_counter.enabled',
  },
];

export function frontOfficeScreen(key: string): FrontOfficeScreen {
  const screen = FRONT_OFFICE_SCREENS.find((candidate) => candidate.key === key);
  if (screen === undefined) throw new Error(`Unknown front-office screen: ${key}`);
  return screen;
}

/**
 * The route list, for whoever wires navigation.
 *
 * `/frontoffice` itself is the hub and carries no permission of its own: it
 * renders only the tiles the session can open, and says so when that is none.
 */
export const FRONT_OFFICE_HOME: Route = '/frontoffice';

export const FRONT_OFFICE_ROUTES: readonly Route[] = [
  FRONT_OFFICE_HOME,
  ...FRONT_OFFICE_SCREENS.map((screen) => screen.href),
];
