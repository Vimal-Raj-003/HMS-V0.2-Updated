import type { Route } from 'next';

/**
 * The Phase-3 diagnostics screens, declared once.
 *
 * The same reason `features/clinical/screens.ts` exists: the left navigation,
 * the console home and the ⌘K palette are three navigation surfaces, and
 * `docs/06` §4.1 — "never render an item the user cannot use" — applies to all
 * three identically. Declaring the list three times is how a screen ends up
 * reachable from the palette by somebody whose menu correctly hid it.
 *
 * ── On `entitlement: null` ──────────────────────────────────────────────────
 *
 * Three screens carry no licence gate at all, and that is `EN-040 §5` rather
 * than an oversight: a hard stop a lapsed subscription could switch off is not a
 * hard stop. The permission catalogue marks `lab.critical.read`,
 * `lab.critical.notify`, `rad.critical.read` and `rad.critical.notify`
 * `clinicalSafetyExempt`, so the policy engine's licence check can never refuse
 * them. A hospital in arrears still gets its potassium of 6.8, and its
 * intracranial haemorrhage, to a human. `screens.spec.ts` asserts both halves.
 *
 * The QC console is the interesting case and is deliberately gated on the same
 * key as the rest of the laboratory rather than on a quality-module key of its
 * own. EN-031 §5's release gate lives in the **database**: an out-of-control
 * analyte holds results whether or not anybody can open this screen. A licence
 * tier that hid the console while the gate kept biting would leave a laboratory
 * blocked with no way to see why or to record the corrective action that clears
 * it — a trap rather than a downgrade.
 *
 * ── On i18n ─────────────────────────────────────────────────────────────────
 *
 * `CLAUDE.md` §4 requires every user-visible string to come from a `next-intl`
 * key. `next-intl` is a declared dependency of `apps/web` and the catalogues
 * exist in `packages/i18n/src/messages/*.json`, but **no screen in this
 * application uses it**: there is no `NextIntlClientProvider` in the tree, no
 * `i18n/request.ts`, and every string in `features/admin`, `features/frontoffice`
 * and `features/clinical` is an English literal. This feature follows the
 * pattern that exists rather than introducing a second one, because a single
 * feature reading from a provider nothing mounts would render every label as its
 * own key. Adding the keys is a `packages/i18n` change and those are outside this
 * change's remit; it is reported as a gap.
 *
 * **This module owns no navigation wiring.** `DIAGNOSTICS_SCREENS` and
 * `DIAGNOSTICS_ROUTES` are exported so whoever owns `src/lib/nav.ts`, the
 * palette and `workspace-chrome.tsx` can consume them.
 */
export interface DiagnosticsScreen {
  readonly key: string;
  readonly label: string;
  readonly href: Route;
  /** Which console this belongs to, for grouping in the nav and the hub. */
  readonly area: 'lab' | 'radiology' | 'investigations';
  /** The **API's** permission key, so the screen is offered exactly when its first request would succeed. */
  readonly permission: string;
  /** One line for the hub tile and the palette's secondary text. */
  readonly summary: string;
  /** Shown on the permission-denied state, in plain words (`docs/06` §6.7). */
  readonly deniedExplanation: string;
  /** ⌘K keywords beyond the label — what a user would actually type. */
  readonly keywords: readonly string[];
  /** Licence entitlement key, or `null` where clinical safety forbids gating. */
  readonly entitlement: string | null;
}

export const DIAGNOSTICS_SCREENS: readonly DiagnosticsScreen[] = [
  {
    key: 'lab-collection',
    label: 'Sample collection',
    href: '/diagnostics/lab/collection',
    area: 'lab',
    // The phlebotomist's key. Its absence means this screen could confirm
    // nothing it scanned, which is the only thing it is for.
    permission: 'lab.sample.collect',
    summary:
      'Barcode-first collection, receipt and accessioning: two scans or a documented reason, condition on receipt, and rejection against a coded NABL reason.',
    deniedExplanation:
      'Confirming a collection is a phlebotomy and laboratory-reception permission. Doctors and nurses order tests; the person who draws the tube confirms it.',
    keywords: [
      'collect',
      'collection',
      'phlebotomy',
      'sample',
      'specimen',
      'barcode',
      'accession',
      'receive',
      'reject',
      'tube',
      'label',
    ],
    entitlement: 'module.lab.enabled',
  },
  {
    key: 'lab-bench',
    label: 'Bench worklist',
    href: '/diagnostics/lab/bench',
    area: 'lab',
    // `GET /lab/worklists/bench` is gated on this exact key, so a session that
    // can open the screen can load the list it is made of.
    permission: 'lab.result.enter',
    summary:
      'The technologist’s queue by sub-department, with result entry, technical verification and medical authorisation — and the QC gate that holds a release.',
    deniedExplanation:
      'Entering results is a laboratory technologist’s permission. Verification and authorisation are separate keys again, held by senior technologists and pathologists.',
    keywords: [
      'bench',
      'worklist',
      'result',
      'entry',
      'verify',
      'authorise',
      'authorize',
      'biochemistry',
      'haematology',
      'microbiology',
      'lab',
    ],
    entitlement: 'module.lab.enabled',
  },
  {
    key: 'lab-critical',
    label: 'Critical values',
    href: '/diagnostics/lab/critical',
    area: 'lab',
    permission: 'lab.critical.read',
    summary:
      'Outstanding panic values with their clocks, the read-back or the documented escalation, and the acknowledgement that closes the loop.',
    deniedExplanation:
      'The critical-value board is held by laboratory staff and the clinicians who receive the calls. It is never licence-gated: a hospital in arrears still gets its panic values to a human.',
    keywords: [
      'critical',
      'panic',
      'value',
      'callback',
      'call back',
      'read back',
      'escalation',
      'acknowledge',
      'nabl',
      'alert',
    ],
    // EN-040 §5 / D-9. `lab.critical.read` and `lab.critical.notify` are both
    // `clinicalSafetyExempt`; a licence gate on the screen would reintroduce
    // exactly what the permission layer deliberately removed.
    entitlement: null,
  },
  {
    key: 'lab-qc',
    label: 'Quality control',
    href: '/diagnostics/lab/qc',
    area: 'lab',
    permission: 'labq.qc.read',
    summary:
      'Levey-Jennings, Westgard violations, the analytes currently holding patient results, and the corrective action that clears a lockout.',
    deniedExplanation:
      'The QC console is held by laboratory quality staff, senior technologists and the laboratory director. Entering a control run and authorising a release under one are separate keys again.',
    keywords: [
      'qc',
      'quality',
      'control',
      'westgard',
      'levey',
      'jennings',
      'lockout',
      'nabl',
      'corrective',
      'iqc',
    ],
    // Gated with the laboratory rather than separately — see the note above:
    // the release gate is in the database and hiding this screen would not
    // lift it.
    entitlement: 'module.lab.enabled',
  },
  {
    key: 'rad-orders',
    label: 'Imaging orders',
    href: '/diagnostics/radiology/orders',
    area: 'radiology',
    permission: 'rad.order.create',
    summary:
      'Raise an imaging request against a mandatory clinical question, then answer the safety screen that decides whether it may proceed at all.',
    deniedExplanation:
      'Raising an imaging order is a prescriber’s permission. Radiographers and the front desk read and schedule orders but do not create them.',
    keywords: [
      'imaging',
      'radiology',
      'order',
      'xray',
      'x-ray',
      'ct',
      'mri',
      'ultrasound',
      'safety',
      'screen',
      'pregnancy',
      'contrast',
      'egfr',
      'form f',
      'pcpndt',
    ],
    entitlement: 'module.radiology.enabled',
  },
  {
    key: 'rad-reading',
    label: 'Reading worklist',
    href: '/diagnostics/radiology/reading',
    area: 'radiology',
    // `GET /rad/reading-worklist` is gated on `rad.report.create`.
    permission: 'rad.report.create',
    summary:
      'The radiologist’s queue, STAT first, with the report through preliminary, signature and amendment — and the critical-finding call-back beside it.',
    deniedExplanation:
      'Reading and reporting is a radiologist’s permission. Signing is a further key again, and no role may hold both it and the acquisition key.',
    keywords: [
      'reading',
      'worklist',
      'report',
      'radiologist',
      'preliminary',
      'wet read',
      'sign',
      'amend',
      'addendum',
      'critical',
      'finding',
    ],
    // Carries the imaging critical-finding loop, whose keys are
    // `clinicalSafetyExempt`. Same reasoning as the prescribing screen in
    // Phase 2: a reporting surface a degraded licence could strip of its
    // safety path is worse than no surface.
    entitlement: null,
  },
  {
    key: 'rad-pacs',
    label: 'PACS studies',
    href: '/diagnostics/radiology/pacs',
    area: 'radiology',
    permission: 'rad.study.read',
    summary:
      'The archive index and the reconciliation queue — what arrived, what it matched on, and what may not be attached to a chart until somebody names the patient.',
    deniedExplanation:
      'Reading the archive index is held by radiology staff and the care team. Reconciling a study is a further permission, and it always records a reason.',
    keywords: [
      'pacs',
      'study',
      'studies',
      'dicom',
      'archive',
      'orthanc',
      'reconcile',
      'reconciliation',
      'unmatched',
      'viewer',
    ],
    entitlement: 'module.radiology.enabled',
  },
  {
    key: 'investigations',
    label: 'Investigation console',
    href: '/diagnostics/investigations',
    area: 'investigations',
    permission: 'invest.worklist.read',
    summary:
      'Everything that is neither an analyzer nor DICOM — ECG, PFT, endoscopy, external reports — through capture, report, co-sign and delivery.',
    deniedExplanation:
      'The investigation worklist is held by the technicians and clinicians who run non-DICOM studies. Signing and co-signing a report are two further keys, and a resident holds only the first.',
    keywords: [
      'investigation',
      'ecg',
      'echo',
      'tmt',
      'pft',
      'endoscopy',
      'holter',
      'eeg',
      'external report',
      'cosign',
      'co-sign',
    ],
    entitlement: 'module.investigations.enabled',
  },
];

export function diagnosticsScreen(key: string): DiagnosticsScreen {
  const screen = DIAGNOSTICS_SCREENS.find((candidate) => candidate.key === key);
  if (screen === undefined) throw new Error(`Unknown diagnostics screen: ${key}`);
  return screen;
}

export function screensInArea(area: DiagnosticsScreen['area']): readonly DiagnosticsScreen[] {
  return DIAGNOSTICS_SCREENS.filter((screen) => screen.area === area);
}

export const AREA_LABELS: Readonly<Record<DiagnosticsScreen['area'], string>> = {
  lab: 'Laboratory',
  radiology: 'Radiology & imaging',
  investigations: 'Investigations',
};

/**
 * The hub route. It carries no permission of its own: it renders only the tiles
 * the session can open, and says so when that is none. Gating the hub would turn
 * "you hold one of these eight keys" into a 403 for everybody who holds seven.
 */
export const DIAGNOSTICS_HOME: Route = '/diagnostics';

export const DIAGNOSTICS_ROUTES: readonly Route[] = [
  DIAGNOSTICS_HOME,
  ...DIAGNOSTICS_SCREENS.map((screen) => screen.href),
];
