import type { Route } from 'next';

/**
 * The front office's screens, declared once.
 *
 * This is the list the workspace navigation and the ⌘K palette should read. It is
 * **exported rather than wired**: `workspace-chrome.tsx`, the palette and
 * `lib/nav.ts` are owned by another change, so this file is the hand-off and
 * nothing here reaches into them.
 *
 * Each entry carries the **API's** permission key, not a UI-invented one, so a
 * screen is offered exactly when its first request would succeed — the same rule
 * `features/admin/screens.ts` follows.
 */
export interface PatientScreen {
  readonly key: string;
  readonly label: string;
  readonly href: Route;
  readonly permission: string;
  /** One line for a navigation tile and the palette's secondary text. */
  readonly summary: string;
  /** Shown on the permission-denied state, in plain words (docs/06 §6.7). */
  readonly deniedExplanation: string;
  /** ⌘K keywords beyond the label — what a user would actually type. */
  readonly keywords: readonly string[];
}

export const PATIENT_SCREENS: readonly PatientScreen[] = [
  {
    key: 'registration',
    label: 'Registration desk',
    href: '/patients',
    // `patient.record.list` and not `patient.record.create`: the screen is
    // search-first, and a call-centre agent who may look a patient up but not
    // register one still needs it. The New patient form inside is gated
    // separately on `patient.record.create`.
    permission: 'patient.record.list',
    summary: 'Find a patient before creating one; register a new patient in under 90 seconds.',
    deniedExplanation:
      'Searching the patient index is granted to the front office, the call centre, clinicians and medical records. Your roles include none of those.',
    keywords: ['register', 'registration', 'new patient', 'uhid', 'front office', 'reception', 'search'],
  },
  {
    key: 'merge',
    label: 'Duplicate & merge',
    href: '/patients/merge',
    permission: 'patient.merge.review',
    summary: 'The duplicate queue, side-by-side comparison and the two-step merge.',
    deniedExplanation:
      'Merging two patient records joins their clinical history permanently, so reviewing duplicates is held by medical records rather than by the desk that creates them.',
    keywords: ['merge', 'duplicate', 'dedupe', 'mrd', 'unmerge', 'alias'],
  },
] as const;

/**
 * Patient 360 is reachable only with a patient id, so it is not a navigation
 * destination and is not in `PATIENT_SCREENS` — a menu item leading to
 * `/patients/undefined` is worse than no menu item. It is declared here so the
 * gate and the ⌘K patient-jump share one permission key.
 */
export const PATIENT_RECORD_SCREEN = {
  key: 'record',
  label: 'Patient record',
  permission: 'patient.record.read',
  deniedExplanation:
    'Opening a patient record is a PHI read and is audited. It is granted to clinicians, the front office and medical records.',
} as const;

export function patientScreen(key: string): PatientScreen {
  const screen = PATIENT_SCREENS.find((candidate) => candidate.key === key);
  if (screen === undefined) throw new Error(`Unknown patient screen: ${key}`);
  return screen;
}
