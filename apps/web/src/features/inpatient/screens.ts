import type { Route } from 'next';

/**
 * The Phase-7 inpatient screens, declared once.
 *
 * Same contract as `features/emergency/screens.ts`: the left navigation, the
 * console home and the ⌘K palette read one list.
 */
export interface IpScreen {
  readonly key: string;
  readonly label: string;
  readonly href: Route;
  readonly area: 'inpatient';
  readonly permission: string;
  readonly summary: string;
  readonly deniedExplanation: string;
  readonly keywords: readonly string[];
  readonly entitlement: string | null;
}

export const IP_SCREENS: readonly IpScreen[] = [
  {
    key: 'bed-board',
    label: 'Bed board',
    href: '/ip/board',
    area: 'inpatient',
    permission: 'bed.board.read',
    summary:
      'Every bed, its state and who is in it — derived from the occupancy table on every read, so there is no counter to drift.',
    deniedExplanation:
      'The bed board is held by nearly everybody who looks after inpatients, on purpose: a board only the bed manager can read is a board everybody phones the bed manager about. Allocating and blocking beds are separate keys.',
    keywords: [
      'bed board',
      'beds',
      'occupancy',
      'census',
      'ward',
      'free beds',
      'available',
      'cleaning',
      'turnover',
      'admission',
      'capacity',
    ],
    entitlement: 'module.inpatient.enabled',
  },
  {
    key: 'admissions',
    label: 'Admissions',
    href: '/ip/admissions',
    area: 'inpatient',
    permission: 'admission.list',
    summary:
      'Who is in, who is waiting for a bed, and who is expected out today — with the patients whose class is dearer than their cover flagged before settlement, not after.',
    deniedExplanation:
      'The admitted list is held by the wards, the desk, billing and MRD. Admitting a patient is a separate key, and admitting on a short deposit is a further one that records who decided.',
    keywords: [
      'admission',
      'admit',
      'inpatient',
      'ip number',
      'discharge',
      'expected discharge',
      'length of stay',
      'deposit',
      'entitlement',
      'transfer',
    ],
    entitlement: 'module.inpatient.enabled',
  },
  {
    key: 'housekeeping',
    label: 'Bed turnover',
    href: '/ip/housekeeping',
    area: 'inpatient',
    permission: 'housekeeping.task.read',
    summary:
      'Beds waiting on a clean, ordered by how close each is to breaching — the queue between a discharge and the next admission.',
    deniedExplanation:
      'The cleaning worklist is held by housekeeping, the ward attendants and the nurses who are waiting on the bed. Passing or failing a clean is a separate key, and returning a bed without one is a further key that records why.',
    keywords: [
      'housekeeping',
      'cleaning',
      'turnover',
      'terminal clean',
      'bed ready',
      'sla',
      'breach',
      'discharge to admission',
    ],
    entitlement: 'module.inpatient.enabled',
  },
  {
    key: 'nursing-station',
    label: 'Nursing station',
    href: '/ip/ward',
    area: 'inpatient',
    permission: 'nursing.ward.read',
    summary:
      'Every patient on the ward ordered by who needs looking at — an escalation first, then the highest NEWS2, then the late doses.',
    deniedExplanation:
      'The ward screen is held by the nurses and doctors looking after inpatients, plus dietetics, therapy and pharmacy. Giving a dose and closing an escalation are separate keys.',
    keywords: [
      'nursing station',
      'ward',
      'news2',
      'deterioration',
      'escalation',
      'falls',
      'braden',
      'morse',
      'isolation',
      'devices',
      'handover',
    ],
    entitlement: 'module.inpatient.enabled',
  },
  {
    key: 'mar-round',
    label: 'Drug round',
    href: '/ip/mar',
    area: 'inpatient',
    permission: 'mar.read',
    summary:
      'Every dose due, latest first. Two scans to give one, a second nurse for anything high alert, and a coded reason for anything not given.',
    deniedExplanation:
      'The drug chart is held by the nurses who give doses, the doctors who write them and the pharmacists who verify them — three different keys, held by three different people on purpose.',
    keywords: [
      'mar',
      'drug round',
      'medication',
      'five rights',
      '5 rights',
      'barcode',
      'wristband',
      'high alert',
      'insulin',
      'witness',
      'missed dose',
      'prn',
    ],
    entitlement: 'module.inpatient.enabled',
  },
  {
    key: 'ip-bill',
    label: 'Inpatient bill',
    href: '/ip/bill',
    area: 'inpatient',
    permission: 'ipbill.read',
    summary:
      'The running bill derived from the occupancy timeline, the corrections shown as corrections, and the discharge gate with what is holding it.',
    deniedExplanation:
      'The inpatient bill is held by billing, cash, the insurance desk and the ward in charge. Running the charge job, changing the policy and overriding the discharge gate are three further keys.',
    keywords: [
      'inpatient bill',
      'room rent',
      'charges',
      'gst',
      'discharge clearance',
      'outstanding',
      'deposit',
      'midnight job',
      'proration',
      'superseded',
    ],
    entitlement: 'module.inpatient.enabled',
  },
];

export function ipScreen(key: string): IpScreen {
  const screen = IP_SCREENS.find((candidate) => candidate.key === key);
  if (screen === undefined) throw new Error(`Unknown inpatient screen: ${key}`);
  return screen;
}

export const IP_ROUTES: readonly Route[] = IP_SCREENS.map((screen) => screen.href);
