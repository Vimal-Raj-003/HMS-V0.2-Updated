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
  {
    key: 'triage-desk',
    label: 'Triage',
    href: '/er/triage',
    area: 'emergency',
    permission: 'triage.record.create',
    summary:
      'ESI four-decision-point triage with the level computed as you type, or START tags under a declared incident. Re-triage writes a second record; the first one stays.',
    deniedExplanation:
      'Triage is held by the nurses who do it and the doctors who supervise them. Overriding the computed level sits in the same bundle rather than a senior one, because an override that needs a supervisor is an override that becomes a level nobody corrected.',
    keywords: [
      'triage',
      'esi',
      'start',
      'jumpstart',
      'acuity',
      'gcs',
      'glasgow',
      'retriage',
      'deteriorated',
      'override',
      'tag',
      'red yellow green black',
      'mass casualty',
    ],
    entitlement: 'module.emergency.enabled',
  },
  {
    key: 'trauma-board',
    label: 'Trauma board',
    href: '/er/trauma',
    area: 'emergency',
    permission: 'trauma.activation.list',
    summary:
      'Who was called, who answered and how long the resuscitation has been running — with the mass-casualty banner when an incident is open.',
    deniedExplanation:
      'The trauma board is held by everyone who answers a page: the emergency floor, surgeons, anaesthetists, intensivists and residents. Calling the team is deliberately one of the easiest permissions to hold — under-triage is the failure mode a trauma system is judged on.',
    keywords: [
      'trauma',
      'activation',
      'trauma team',
      'page',
      'pager',
      'acknowledge',
      'stand down',
      'golden hour',
      'resus',
      'mci',
      'mass casualty',
      'level 1',
      'level one',
    ],
    entitlement: 'module.emergency.enabled',
  },
  {
    key: 'trauma-registry',
    label: 'Trauma registry',
    href: '/er/registry',
    area: 'emergency',
    permission: 'trauma.score.read',
    summary:
      'Code the injuries by AIS region and severity; ISS, NISS, RTS, shock index, MGAP and TRISS are computed from them and the arrival physiology, then signed off.',
    deniedExplanation:
      'The registry is held by the clinicians who score a resuscitation and by MRD coders. Amending a signed score is a separate, higher key held by coding — the superseded version always stays visible.',
    keywords: [
      'trauma registry',
      'iss',
      'niss',
      'ais',
      'rts',
      'triss',
      'mgap',
      'shock index',
      'injury severity',
      'coding',
      'mortality review',
      'cribari',
    ],
    entitlement: 'module.emergency.enabled',
  },
  {
    key: 'mlc-register',
    label: 'Medico-legal register',
    href: '/er/mlc',
    area: 'emergency',
    permission: 'mlc.register.read',
    summary:
      'The statutory register, gapless per branch per year, with the intimation clock on every case and the worklists for what is overdue.',
    deniedExplanation:
      'The medico-legal register is held by the emergency floor, MRD and the Medical Superintendent. Sexual-assault, POCSO, dowry and custodial cases need a separate key and are not listed or counted without it — showing that a restricted case exists would itself be the disclosure.',
    keywords: [
      'mlc',
      'medico-legal',
      'medicolegal',
      'register',
      'police',
      'intimation',
      'forensic',
      'assault',
      'rta',
      'court',
      'certificate',
      'evidence',
      'chain of custody',
      'inquest',
      'brought dead',
    ],
    entitlement: 'module.emergency.enabled',
  },
  {
    key: 'mlc-case',
    label: 'Medico-legal case',
    href: '/er/mlc/case',
    area: 'emergency',
    permission: 'mlc.case.read',
    summary:
      'One case: the forensic body map, the police intimation and its receipt, the hash-chained evidence log, and what is still holding the patient in the department.',
    deniedExplanation:
      'Reading a medico-legal case is held by the clinicians treating the patient, MRD and the Medical Superintendent. A restricted case additionally needs the sensitive-access key, and without it the case reads as though it does not exist.',
    keywords: [
      'mlc case',
      'body map',
      'injury',
      'bns',
      'grievous',
      'wound certificate',
      'evidence',
      'seal',
      'custody',
      'handover',
      'discharge gate',
      'override',
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
