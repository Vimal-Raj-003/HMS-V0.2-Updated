import type { Route } from 'next';

/**
 * The Phase-2 clinical screens, declared once.
 *
 * The same reason `features/frontoffice/screens.ts` exists: the left navigation,
 * the console home and the ⌘K palette are three navigation surfaces, and
 * `docs/06` §4.1 — "never render an item the user cannot use" — applies to all
 * three identically. Declaring the list three times is how a screen ends up
 * reachable from the palette by somebody whose menu correctly hid it.
 *
 * **This module owns no navigation wiring.** `CLINICAL_SCREENS` and
 * `CLINICAL_ROUTES` are exported so whoever owns `src/lib/nav.ts`, the palette
 * and `workspace-chrome.tsx` can consume them; nothing here imports any of
 * those, and none of them were edited.
 *
 * `entitlement` is the licence key that gates a screen, and two of the four are
 * deliberately `null`. The permission catalogue marks `cdss.evaluate`,
 * `cdss.alert.read`, `cdss.alert.respond` and `vitals.alert.acknowledge`
 * `clinicalSafetyExempt` (EN-040 §5, D-9): a hard stop a lapsed subscription
 * could switch off is not a hard stop, and a hospital with an unpaid invoice
 * still gets its critical-value alert. So the two screens that carry the safety
 * surface carry no licence gate at all.
 */
export interface ClinicalScreen {
  readonly key: string;
  readonly label: string;
  readonly href: Route;
  /** The **API's** permission key, so the screen is offered exactly when its first request would succeed. */
  readonly permission: string;
  /** One line for the hub tile and the palette's secondary text. */
  readonly summary: string;
  /** Shown on the permission-denied state, in plain words (`docs/06` §6.7). */
  readonly deniedExplanation: string;
  /** ⌘K keywords beyond the label — what a user would actually type. */
  readonly keywords: readonly string[];
  /** Licence entitlement key, or `null` where safety forbids gating. */
  readonly entitlement: string | null;
}

export const CLINICAL_SCREENS: readonly ClinicalScreen[] = [
  {
    key: 'vitals',
    label: 'Vitals room',
    href: '/clinical/vitals',
    // The nurse's key. It appears on no prescribing route, and it is the key
    // whose absence means this screen could not save anything it captured.
    permission: 'vitals.record.create',
    summary:
      'Tablet-first observation capture, with the hospital’s own abnormal and critical bands and the NEWS2 the server scored.',
    deniedExplanation:
      'Recording observations is a nursing permission. Doctors read vitals and acknowledge their alerts, but do not record them.',
    keywords: ['vitals', 'bp', 'pulse', 'spo2', 'temperature', 'news2', 'nurse', 'observations', 'triage'],
    entitlement: 'module.vitals_room.enabled',
  },
  {
    key: 'console',
    label: 'Doctor console',
    href: '/clinical/console',
    permission: 'opd.encounter.read',
    summary:
      'The consultation: banner, timeline, problems, medications, allergies, diagnoses, an autosaving note, sign and amend.',
    deniedExplanation:
      'Reading a consultation needs the encounter-read permission, held by doctors, nurses and medical records staff.',
    keywords: ['consult', 'consultation', 'encounter', 'note', 'diagnosis', 'sign', 'amend', 'doctor', 'opd'],
    entitlement: 'module.opd_cpoe.enabled',
  },
  {
    key: 'prescribe',
    label: 'e-Prescription',
    href: '/clinical/prescribe',
    permission: 'rx.create',
    summary:
      'Drug search, a dose builder that will not guess a weight, and the safety checks — hard stop, coded-reason override, passive.',
    deniedExplanation:
      'Prescribing is held by prescribers. Nurses and pharmacists can read and print a prescription but never create one.',
    keywords: ['prescribe', 'prescription', 'rx', 'drug', 'dose', 'cdss', 'interaction', 'allergy'],
    // Never licence-gated: the CDSS keys this screen depends on are
    // `clinicalSafetyExempt`, and a prescribing screen that a degraded licence
    // could strip of its safety checks is worse than no screen.
    entitlement: null,
  },
  {
    key: 'alerts',
    label: 'Alert fatigue',
    href: '/clinical/alerts',
    permission: 'cdss.report.read',
    summary:
      'Override rate by rule, alerts per 1000 orders, and the reasons clinicians gave — the numbers a governance committee tunes rules from.',
    deniedExplanation:
      'The alert-fatigue report is a governance view, held by quality, the medical superintendent and hospital administration.',
    keywords: ['alert', 'fatigue', 'override', 'cdss', 'governance', 'quality', 'rules', 'tuning'],
    entitlement: null,
  },
];

export function clinicalScreen(key: string): ClinicalScreen {
  const screen = CLINICAL_SCREENS.find((candidate) => candidate.key === key);
  if (screen === undefined) throw new Error(`Unknown clinical screen: ${key}`);
  return screen;
}

/**
 * The route list, for whoever wires navigation.
 *
 * `/clinical` itself is the hub and carries no permission of its own: it renders
 * only the tiles the session can open, and says so when that is none.
 */
export const CLINICAL_HOME: Route = '/clinical';

export const CLINICAL_ROUTES: readonly Route[] = [
  CLINICAL_HOME,
  ...CLINICAL_SCREENS.map((screen) => screen.href),
];
