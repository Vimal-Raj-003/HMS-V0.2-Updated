import type { Route } from 'next';

/**
 * The Phase-8 specialty screens, declared once.
 *
 * Same contract as `features/inpatient/screens.ts`: the left navigation, the
 * console home and the ⌘K palette read one list. A console's *own* screens are
 * declared by the console; what is here is the framework's own — the registry
 * an administrator composes from.
 */
export interface SpecialtyScreen {
  readonly key: string;
  readonly label: string;
  readonly href: Route;
  readonly area: 'specialty';
  readonly permission: string;
  readonly summary: string;
  readonly deniedExplanation: string;
  readonly keywords: readonly string[];
  readonly entitlement: string | null;
}

export const SPECIALTY_SCREENS: readonly SpecialtyScreen[] = [
  {
    key: 'console-registry',
    label: 'Specialty consoles',
    href: '/specialty/consoles',
    area: 'specialty',
    permission: 'console.registry.read',
    summary:
      'Which specialties have a workspace of their own, what is on it, and which departments open it — composed from the tabs this build ships, with no deploy.',
    deniedExplanation:
      'Seeing which consoles exist is held widely, because a clinician needs to know why their department opens the workspace it does. Composing one changes what a whole department sees on its next patient, so it sits with administration and records a reason.',
    keywords: [
      'specialty console',
      'console',
      'registry',
      'tabs',
      'workspace',
      'ophthalmology',
      'dental',
      'cardiology',
      'device result',
      'worklist',
    ],
    entitlement: null,
  },
  {
    key: 'eye-clinic',
    label: 'Eye clinic',
    href: '/ophtha/clinic',
    area: 'specialty',
    permission: 'ophtha.visit.read',
    summary:
      'The refraction lane, the examination and the lens plan \u2014 one column per eye, an acuity ladder that has a bottom, and powers that move in quarter dioptres.',
    deniedExplanation:
      'The eye clinic is held by ophthalmologists, optometrists and the nurses who run the lanes. Recording is wide; signing the visit is the consultant\u2019s, and signing a spectacle prescription is a further key a hospital delegates deliberately.',
    keywords: [
      'ophthalmology',
      'eye',
      'refraction',
      'visual acuity',
      'spectacle',
      'glasses',
      'intraocular pressure',
      'glaucoma',
      'cataract',
      'retinopathy',
      'oct',
      'logmar',
    ],
    entitlement: 'module.ophthalmology.enabled',
  },
  {
    key: 'cardiology',
    label: 'Cardiology',
    href: '/cardio/console',
    area: 'specialty',
    permission: 'cardio.ecg.read',
    summary:
      'Tracings waiting to be handed over, the day\u2019s studies, and a corrected interval nobody can type \u2014 Bazett runs in the database, so the chart and the pharmacy alert read one number.',
    deniedExplanation:
      'Reading tracings is held by cardiology and by the technicians who record them. Interpreting one is a doctor\u2019s, and acknowledging a critical tracing is a further key \u2014 a technician closing the loop on their own tracing means it reads as closed while nobody was told.',
    keywords: [
      'cardiology',
      'ecg',
      'ekg',
      'tracing',
      'qtc',
      'echo',
      'echocardiogram',
      'stress test',
      'treadmill',
      'warfarin',
      'inr',
      'anticoagulation',
      'stemi',
    ],
    entitlement: 'module.cardiology.enabled',
  },
  {
    key: 'pulmonology',
    label: 'Pulmonology & sleep',
    href: '/pulmo/console',
    area: 'specialty',
    permission: 'pulmo.pft.perform',
    summary:
      'Lung function, sleep studies and the machines patients go home with. The ratio, the reversibility and the apnoea severity are derived \u2014 there is no box to type a diagnosis into.',
    deniedExplanation:
      'Running a spirometry manoeuvre and scoring a sleep study belong to the cardio-pulmonary laboratory; interpreting either belongs to a doctor. A study graded F cannot be signed by anybody, because an unacceptable effort is not a result.',
    keywords: [
      'pulmonology',
      'respiratory',
      'spirometry',
      'pft',
      'lung function',
      'fev1',
      'reversibility',
      'asthma',
      'copd',
      'sleep study',
      'polysomnography',
      'apnoea',
      'ahi',
      'cpap',
      'bipap',
    ],
    entitlement: 'module.pulmonology.enabled',
  },
  {
    key: 'audiology',
    label: 'ENT & audiology',
    href: '/ent/console',
    area: 'specialty',
    permission: 'ent.audiology.read',
    summary:
      'The booth, the audiogram and the aids that go home. The four-frequency average, the degree of loss and the conductive split are computed from the thresholds.',
    deniedExplanation:
      'Reading an audiogram is held across ENT. Running the booth and signing the report belong to the audiologist, whose registered scope is producing and interpreting it \u2014 and a test run on an unverified audiometer cannot be signed at all.',
    keywords: [
      'ent',
      'audiology',
      'audiogram',
      'hearing',
      'pta',
      'tympanometry',
      'threshold',
      'air bone gap',
      'hearing aid',
      'deafness',
      'ear nose throat',
    ],
    entitlement: 'module.ent.enabled',
  },
  {
    key: 'dental',
    label: 'Dentistry',
    href: '/dental/console',
    area: 'specialty',
    permission: 'dental.chart.read',
    summary:
      'The mouth as the log describes it \u2014 a chart rebuilt from what was recorded, never edited \u2014 and the quotation the patient is asked to agree to, at a price that stops moving once they do.',
    deniedExplanation:
      'Charting and periodontal recording are held by dentists and hygienists alike. Pricing and presenting a plan are the dentist\u2019s, because a treatment plan is a quotation the patient will consent to and pay for; re-pricing one they already signed is a further key with a reason attached.',
    keywords: [
      'dental',
      'dentistry',
      'odontogram',
      'tooth',
      'teeth',
      'fdi',
      'chart',
      'caries',
      'extraction',
      'crown',
      'implant',
      'treatment plan',
      'dmft',
      'perio',
    ],
    entitlement: 'module.dental.enabled',
  },
  {
    key: 'dermatology',
    label: 'Dermatology',
    href: '/derm/console',
    area: 'specialty',
    permission: 'derm.lesion.read',
    summary:
      'Lesions followed across visits, biopsies waiting on somebody, and the phototherapy cabin \u2014 with a dose the protocol suggests and a ceiling the database enforces.',
    deniedExplanation:
      'Reading the lesion map is held across dermatology, and delivering a phototherapy session by the nurse who runs the cabin. Photographs of a sensitive site need their own key, and raising a course\u2019s dose ceiling is the prescriber\u2019s deliberate act with a reason recorded.',
    keywords: [
      'dermatology',
      'skin',
      'lesion',
      'mole',
      'biopsy',
      'melanoma',
      'pasi',
      'psoriasis',
      'eczema',
      'easi',
      'scorad',
      'phototherapy',
      'nbuvb',
      'puva',
    ],
    entitlement: 'module.dermatology.enabled',
  },
  {
    key: 'therapy',
    label: 'Therapy',
    href: '/therapy/floor',
    area: 'specialty',
    permission: 'therapy.episode.read',
    summary:
      'Courses of treatment across physiotherapy, wound care, dietetics and speech \u2014 one episode, one plan, and how many sessions the payer actually authorised.',
    deniedExplanation:
      'Reading and delivering therapy is held by therapists of every discipline and by the doctors who refer in. Extending what a package authorised belongs to the desk that talks to the payer, because the eleventh session of ten is either fraud or unpaid work.',
    keywords: [
      'therapy',
      'physiotherapy',
      'physio',
      'rehabilitation',
      'rehab',
      'occupational therapy',
      'session',
      'goal',
      'episode',
      'authorisation',
      'discharge',
    ],
    entitlement: 'module.therapy.enabled',
  },
  {
    key: 'wound-care',
    label: 'Wound care',
    href: '/wounds/clinic',
    area: 'specialty',
    permission: 'wound.read',
    summary:
      'Every open wound, what it measured last, and which ones the four-week rule says are not healing on the current plan \u2014 area and reduction computed from the ruler.',
    deniedExplanation:
      'Measuring and dressing a wound is held right across the bedside, because the person with the ruler is whoever is changing the dressing. Closing a wound whose last measurement is not zero is a separate key with a reason: a wound closed on the record and open on the patient is how a discharged patient loses their district nurse.',
    keywords: [
      'wound',
      'ulcer',
      'pressure sore',
      'dressing',
      'debridement',
      'diabetic foot',
      'npwt',
      'healing',
      'area',
      'stalled',
    ],
    entitlement: 'module.wound_care.enabled',
  },
  {
    key: 'nutrition',
    label: 'Dietetics & nutrition',
    href: '/nutrition/clinic',
    area: 'specialty',
    permission: 'nutrition.assessment.read',
    summary:
      'Diet plans and what they actually contain. Energy, macros and minerals are summed from the meals, and a plan that breaks its own restriction is refused before it reaches a kitchen.',
    deniedExplanation:
      'Reading a plan is held widely \u2014 a ward that cannot see what a patient is on will feed them something else. Building and signing one is the dietician\u2019s, and writing the swallow texture is the speech therapist\u2019s, because a diet plan that contradicts the swallow finding is the aspiration.',
    keywords: [
      'nutrition',
      'dietetics',
      'dietician',
      'diet plan',
      'malnutrition',
      'kcal',
      'protein',
      'potassium',
      'renal diet',
      'tube feed',
      'food',
    ],
    entitlement: 'module.nutrition.enabled',
  },
  {
    key: 'swallow-orders',
    label: 'Swallow orders',
    href: '/slp/orders',
    area: 'specialty',
    permission: 'slp.swallow_order.read',
    summary:
      'What each patient may safely eat and drink, and which orders the kitchen and the ward have not read yet \u2014 an order changes nothing about the tray until both have.',
    deniedExplanation:
      'Reading a swallow order is held by everybody who might hand somebody a glass of water. Writing one is the speech therapist\u2019s alone, and acknowledging one belongs to the kitchen and the ward \u2014 never to the person who wrote it.',
    keywords: [
      'swallow',
      'dysphagia',
      'iddsi',
      'texture',
      'thickened fluids',
      'nil by mouth',
      'npo',
      'aspiration',
      'speech therapy',
      'diet texture',
      'kitchen',
    ],
    entitlement: 'module.speech_therapy.enabled',
  },
  {
    key: 'pain-clinic',
    label: 'Pain management',
    href: '/pain/board',
    area: 'specialty',
    permission: 'pain.episode.read',
    summary:
      'The three facts about a year no consultation can see: who is above the opioid review threshold across every prescription, whose treatment agreement lapses next, and who is close to the annual steroid ceiling.',
    deniedExplanation:
      'Reading a pain episode is held across the clinic. Prescribing an opioid and countersigning one above the threshold are never on one person, and revoking a treatment agreement stops every further prescription on that episode \u2014 so it carries a reason.',
    keywords: [
      'pain',
      'opioid',
      'morphine equivalent',
      'mme',
      'naloxone',
      'treatment agreement',
      'nerve block',
      'epidural',
      'steroid',
      'neuropathic',
      'chronic pain',
    ],
    entitlement: 'module.pain_clinic.enabled',
  },
  {
    key: 'immunisation',
    label: 'Immunisation',
    href: '/immunisation/session',
    area: 'specialty',
    permission: 'immunisation.record.read',
    summary:
      'What the session can draw from, which batches are held after a cold chain breach, and who is overdue \u2014 with the minimum age and the interval enforced rather than warned about.',
    deniedExplanation:
      'Giving a vaccine is held right across the nursing floor, because an immunisation session is run by whoever is in the room, and it is never blocked by a licence. Deciding the fate of a breached batch and striking a dose from a child\u2019s record are separate keys with reasons \u2014 both change what everybody else can do.',
    keywords: [
      'immunisation',
      'vaccination',
      'vaccine',
      'dose',
      'schedule',
      'cold chain',
      'vial',
      'aefi',
      'booster',
      'catch-up',
      'certificate',
    ],
    entitlement: 'module.immunisation.enabled',
  },
  {
    key: 'health-checkup',
    label: 'Health check-ups',
    href: '/healthcheck/floor',
    area: 'specialty',
    permission: 'healthcheck.episode.read',
    summary:
      'Who is in the building, which station each of them can go to next, and what still stands between a check and its report \u2014 because a station out of order is a wasted morning.',
    deniedExplanation:
      'Running the routing slip is held by the front office and the nursing floor alike, since the person who calls a patient is whoever is free. Signing the report is a clinician\u2019s, and it cannot be signed while any station is outstanding.',
    keywords: [
      'health check',
      'checkup',
      'master health',
      'executive health',
      'corporate wellness',
      'routing slip',
      'station',
      'package',
      'health score',
      'annual check',
    ],
    entitlement: 'module.health_checkup.enabled',
  },
  {
    key: 'dialysis-board',
    label: 'Dialysis unit',
    href: '/dialysis/board',
    area: 'specialty',
    permission: 'dialysis.program.read',
    summary:
      'Every machine, its isolation zone, who is on it and who is next \u2014 because when a machine goes down the only question is which other machine in the same zone is free.',
    deniedExplanation:
      'The board is held by the dialysis floor and the nephrology team. Moving a machine between isolation zones is a separate, named decision, because it is what stops hepatitis crossing a unit.',
    keywords: [
      'dialysis',
      'haemodialysis',
      'renal',
      'machine',
      'chair',
      'isolation zone',
      'hepatitis',
      'shift',
      'nephrology',
    ],
    entitlement: 'module.dialysis.enabled',
  },
  {
    key: 'dialysis-sessions',
    label: 'Dialysis sessions',
    href: '/dialysis/sessions',
    area: 'specialty',
    permission: 'dialysis.program.read',
    summary:
      'The chair: the pre-weight, the fluid it implies, the rate that decides whether the patient crashes, and the filter the database says may be used.',
    deniedExplanation:
      'Running a session belongs to the dialysis floor. Ending one early is a nurse\u2019s, and it carries a reason, because an abort is a different clinical fact from a cancellation.',
    keywords: [
      'dialysis session',
      'ultrafiltration',
      'dry weight',
      'kt/v',
      'urr',
      'dialyser',
      'reuse',
      'fistula',
      'access',
      'adequacy',
    ],
    entitlement: 'module.dialysis.enabled',
  },
  {
    key: 'antenatal-clinic',
    label: 'Antenatal clinic',
    href: '/antenatal/clinic',
    area: 'specialty',
    permission: 'obg.pregnancy.read',
    summary:
      'Who is booked, how far on they are, and what the calendar says is late \u2014 with the anti-D register at the top, because that one is a child who has not been conceived.',
    deniedExplanation:
      'Running the clinic is held by the nursing floor and the obstetric team alike. Moving an estimated date of delivery, and the two statutory registers, are separate named keys.',
    keywords: [
      'antenatal',
      'anc',
      'pregnancy',
      'obstetrics',
      'edd',
      'gestation',
      'anti-d',
      'rhesus',
      'form f',
      'pcpndt',
      'mtp',
      'postnatal',
      'epds',
    ],
    entitlement: 'module.antenatal.enabled',
  },
  {
    key: 'labour-board',
    label: 'Labour room',
    href: '/labour/board',
    area: 'specialty',
    permission: 'obs.labour.read',
    summary:
      'Who is in labour, where they are against the line, and the three things that need somebody now \u2014 a stopped chart, a haemorrhage, and a wristband that did not match.',
    deniedExplanation:
      'The chart and the birth belong to the midwifery floor. The decision at the action line is a doctor\u2019s, and Form 1 is medical records\u2019, because a statutory return to a Registrar is not a clinical note.',
    keywords: [
      'labour',
      'delivery',
      'partograph',
      'action line',
      'newborn',
      'apgar',
      'pph',
      'haemorrhage',
      'wristband',
      'birth certificate',
      'form 1',
      'obstetrics',
    ],
    entitlement: 'module.labour_room.enabled',
  },
  {
    key: 'chemo-daycare',
    label: 'Chemotherapy day care',
    href: '/oncology/daycare',
    area: 'specialty',
    permission: 'onco.case.read',
    summary:
      'Today\u2019s cycles, what is waiting on pharmacy, and the lifetime totals that will refuse a dose in eighteen months if nobody starts on them now.',
    deniedExplanation:
      'The plan and the signature are the oncologist\u2019s; the independent recalculation is pharmacy\u2019s and nobody else\u2019s; the chair is nursing\u2019s, with a colleague.',
    keywords: [
      'chemotherapy',
      'oncology',
      'cancer',
      'regimen',
      'cycle',
      'bsa',
      'carboplatin',
      'doxorubicin',
      'vincristine',
      'ctcae',
      'toxicity',
      'day care',
    ],
    entitlement: 'module.oncology.enabled',
  },
  {
    key: 'psychiatry-ward',
    label: 'Mental health ward',
    href: '/psychiatry/ward',
    area: 'specialty',
    permission: 'psy.episode.read',
    summary:
      'Whose authority to detain is running out, which restraints are still open, and what each of them still needs before it can be closed.',
    deniedExplanation:
      'Mental health records are excluded from summaries, exports and outbound sharing by default, so reading one is itself a named permission. Assessing capacity and ordering restraint are separate again.',
    keywords: [
      'psychiatry',
      'mental health',
      'mhca',
      'capacity',
      'advance directive',
      'nominated representative',
      'restraint',
      'seclusion',
      'ect',
      'phq-9',
      'review board',
      'section 89',
    ],
    entitlement: 'module.psychiatry.enabled',
  },
];

export function specialtyScreen(key: string): SpecialtyScreen {
  const screen = SPECIALTY_SCREENS.find((candidate) => candidate.key === key);
  if (screen === undefined) throw new Error(`Unknown specialty screen: ${key}`);
  return screen;
}

export const SPECIALTY_ROUTES: readonly Route[] = SPECIALTY_SCREENS.map((screen) => screen.href);
