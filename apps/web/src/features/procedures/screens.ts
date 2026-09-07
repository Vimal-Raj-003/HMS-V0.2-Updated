import type { Route } from 'next';

/**
 * The Phase-8 procedure screens.
 *
 * OP-010 is not a specialty: the eye clinic's laser, dermatology's biopsy and
 * the pain clinic's block all land on the same board, which is why it has its
 * own nav group rather than sitting under any one console.
 */
export interface ProcedureScreen {
  readonly key: string;
  readonly label: string;
  readonly href: Route;
  readonly area: 'procedures';
  readonly permission: string;
  readonly summary: string;
  readonly deniedExplanation: string;
  readonly keywords: readonly string[];
  readonly entitlement: string | null;
}

export const PROCEDURE_SCREENS: readonly ProcedureScreen[] = [
  {
    key: 'procedure-board',
    label: 'Procedure board',
    href: '/procedures/board',
    area: 'procedures',
    permission: 'procedure.order.read',
    summary:
      'Every procedure booked, and what each is still waiting on — consent, the time-out, the checklist — before anybody walks a patient into a room.',
    deniedExplanation:
      'The procedure board is held by everybody who works a procedure room, because a case waiting on a consent is everybody’s problem. Doing the procedure, overriding a checklist and signing the note are separate keys.',
    keywords: [
      'procedure',
      'minor ot',
      'time-out',
      'consent',
      'checklist',
      'booking',
      'room',
      'recovery',
      'aldrete',
      'sedation',
      'biopsy',
      'excision',
    ],
    entitlement: 'module.procedures.enabled',
  },
  {
    key: 'nursing-rooms',
    label: 'Nursing rooms',
    href: '/procedures/nursing',
    area: 'procedures',
    permission: 'opdnursing.task.read',
    summary:
      'The injection, dressing and plaster rooms — who is waiting, who is still being watched after a first dose, and what each is here for.',
    deniedExplanation:
      'The room worklists are held by the nurses who run them and the supervisors who staff them. Giving a drug and being the second person on a high-alert one are separate keys, and the database refuses them being the same person.',
    keywords: [
      'injection',
      'dressing',
      'plaster',
      'nebulisation',
      'suture removal',
      'opd nursing',
      'observation',
      'high alert',
      'batch',
      'cannulation',
    ],
    entitlement: 'module.procedures.enabled',
  },
];

export function procedureScreen(key: string): ProcedureScreen {
  const screen = PROCEDURE_SCREENS.find((candidate) => candidate.key === key);
  if (screen === undefined) throw new Error(`Unknown procedure screen: ${key}`);
  return screen;
}

export const PROCEDURE_ROUTES: readonly Route[] = PROCEDURE_SCREENS.map((screen) => screen.href);
