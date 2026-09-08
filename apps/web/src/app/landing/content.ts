/**
 * Everything the landing page asserts, in one file, so that each claim can be
 * checked against the repository rather than against a memory of it.
 *
 * The figures in `INSTRUMENTS` are counted, not estimated. The command that
 * produced each is recorded beside it; re-run them before changing a number.
 * A landing page that rounds 908 up to "1000+" is the first small lie a product
 * tells about itself, and this one is a clinical system.
 */

export interface Instrument {
  readonly value: number;
  readonly suffix?: string;
  readonly label: string;
  readonly note: string;
}

export const INSTRUMENTS: readonly Instrument[] = [
  {
    // find services/api/src -name '*.controller.ts' -exec grep -hoE '@(Get|Post|Put|Patch|Delete)\(' {} + | wc -l
    value: 1080,
    label: 'API endpoints',
    note: 'Every one validated, policy-checked and swept for crashes',
  },
  {
    // grep -rh '^model ' packages/db/prisma/schema/*.prisma | wc -l
    value: 908,
    label: 'Database models',
    note: 'Tenanted, effective-dated, and append-only where clinical',
  },
  {
    // grep -rhoiE 'CREATE (OR REPLACE )?TRIGGER' packages/db/prisma/migrations | wc -l
    value: 253,
    label: 'Enforcing triggers',
    note: 'Safety rules that live in the database, not in a form',
  },
  {
    // grep -rhoiE 'CREATE POLICY' packages/db/prisma/migrations | wc -l
    value: 122,
    label: 'Row-level policies',
    note: 'One hospital cannot read another, even by mistake',
  },
  {
    // find apps/web/src/app -name 'page.tsx' | wc -l
    value: 123,
    label: 'Screens',
    note: 'Desktop, tablet and phone, with the keyboard first',
  },
  {
    // grep -c 'key:' packages/contracts/src/rbac/role-templates.ts
    value: 71,
    label: 'Role templates',
    note: 'From ward nurse to auditor, all through one sign-in',
  },
];

export interface Stage {
  readonly step: string;
  readonly detail: string;
}

/** What the software covers, in the order a patient meets it. */
export const PATHWAY: readonly Stage[] = [
  { step: 'Arrives', detail: 'Registration, UHID, ABHA, appointment, token' },
  { step: 'Is assessed', detail: 'Triage, vitals, consultation, prescription' },
  { step: 'Is investigated', detail: 'Lab orders, samples, results, imaging, reports' },
  { step: 'Is treated', detail: 'Pharmacy, admission, ward, theatre, intensive care' },
  { step: 'Settles', detail: 'Tariff, bill, insurance, receipt, discharge summary' },
];

export interface Domain {
  readonly index: string;
  readonly name: string;
  readonly detail: string;
}

/** The eight domains of `docs/12-module-index.md`, in its order. */
export const DOMAINS: readonly Domain[] = [
  {
    index: '01',
    name: 'OPD clinical',
    detail:
      'Vitals room, doctor console, CPOE, e-prescription with interaction and allergy checks, and thirty specialty consoles from dialysis to oncology.',
  },
  {
    index: '02',
    name: 'Trauma & orthopaedics',
    detail:
      'ESI and START triage, trauma scores, the fracture registry, implant traceability, cast and splint records, medico-legal cases.',
  },
  {
    index: '03',
    name: 'Inpatient',
    detail:
      'Admission and bed state, the nursing station, MAR, intake–output, NEWS2, handover, theatre with the WHO checklist, intensive care, blood bank.',
  },
  {
    index: '04',
    name: 'Non-clinical & ERP',
    detail:
      'Accounts and the general ledger, HR and rostering, assets and biomedical, ambulance, housekeeping, dietary, gate and visitor, NABH quality, biomedical waste.',
  },
  {
    index: '05',
    name: 'Enablers & integrations',
    detail:
      'HL7 v2 over MLLP, ASTM analysers, FHIR R4, DICOM worklists and PACS, ABDM, payment gateways, SMS and WhatsApp — each with a dead-letter queue.',
  },
  {
    index: '06',
    name: 'Revenue cycle',
    detail:
      'The tariff engine, effective-dated packages, GST, discount approvals, refunds, insurance and TPA pre-authorisation, claims and denials.',
  },
  {
    index: '07',
    name: 'Patient engagement',
    detail:
      'The patient and family portal, corporate and TPA portals, referrals, feedback and NPS, follow-up reminders, kiosks and queue displays.',
  },
  {
    index: '08',
    name: 'AI & advanced',
    detail:
      'Clinical decision support, coding assistance, document extraction, demand and length-of-stay prediction — every output a suggestion a human confirms.',
  },
];

export interface Rule {
  readonly title: string;
  readonly law: string;
  readonly body: string;
  /** Quoted from the migration that installs it, not paraphrased. */
  readonly enforcement: string;
  readonly reference: string;
}

/**
 * Four of the two hundred and fifty-three. Each quotation below is the text the
 * database itself raises or carries as a comment; the reference is the file it
 * lives in. They are on the landing page because they are the difference
 * between a hospital system and a database with a hospital-shaped form on it.
 */
export const RULES: readonly Rule[] = [
  {
    title: 'A vinca alkaloid is never given intrathecally',
    law: 'The never-event',
    body: 'Vincristine into the spinal fluid is an ascending paralysis and then death over about a week, and there is no treatment. It has happened dozens of times worldwide — every time in a system that had a field where the route could be typed.',
    enforcement:
      'There is no override key, no permission that reaches it and no second signature. The order is refused, and the refusal explains itself at length, because the person who meets it will be certain it is a bug in the software.',
    reference: 'OP-031 §B.2',
  },
  {
    title: 'Brain-stem death is two examinations, six hours apart',
    law: 'THOTA 1994',
    body: 'Four doctors, twice, six hours apart, and none of them on the transplant team. The alternative is a transplant team certifying its own donor, which is why the Act names the panel rather than describing it.',
    enforcement:
      'The interval is computed by the database from the two examination times and checked against the statute. The interval is the test: a single examination cannot distinguish brain-stem death from a reversible state.',
    reference: 'IP-019 §B.2',
  },
  {
    title: 'No table has a column for the sex of a foetus',
    law: 'PC-PNDT 1994',
    body: 'The Act exists because sex-selective abortion removed tens of millions of girls from the Indian population, and it is enforced by inspecting records. A column for it, however well guarded, is a column that can be made to hold it.',
    enforcement:
      'So there is none. The migration scans the live schema and refuses to apply if one has appeared — a migration written in three years by somebody who has not read this file will fail on the statement that adds the column.',
    reference: 'OP-040 §B.6',
  },
  {
    title: 'A transfusion starts on a two-person bedside check',
    law: 'The commonest fatal error',
    body: 'An ABO-incompatible transfusion kills in minutes, and the commonest cause is a bag hung on the wrong patient. Two people, the wristband as scanned and the bag as scanned.',
    enforcement:
      'This cannot be skipped, deferred or configured away, and there is no column here that could express doing so. The proof that it cannot be overridden is that nothing in the schema can say it.',
    reference: 'IP-007 §B.1',
  },
];

export interface Standard {
  readonly code: string;
  readonly detail: string;
}

export const STANDARDS: readonly Standard[] = [
  { code: 'ABDM', detail: 'ABHA identity, consent and the health record' },
  { code: 'NABH', detail: 'Accreditation evidence produced as a by-product' },
  { code: 'DPDP 2023', detail: 'Consent, purpose limitation, erasure, breach clock' },
  { code: 'HL7 v2', detail: 'MLLP listeners for analysers and legacy systems' },
  { code: 'FHIR R4', detail: 'Resources for exchange, not an afterthought' },
  { code: 'DICOM', detail: 'Modality worklists and PACS via Orthanc' },
  { code: 'GST', detail: 'Place of supply, HSN/SAC, gapless invoice series' },
  { code: 'ICD-10 · SNOMED', detail: 'Coded diagnoses, searchable and reportable' },
];

export interface Destination {
  readonly name: string;
  readonly who: string;
  /**
   * Typed as the literal route rather than `string`, so Next's typed-routes
   * check catches a typo here at build time instead of shipping a tile that
   * leads to a 404. Every staff destination is the same door by design.
   */
  readonly href?: '/login';
  readonly note?: string;
}

/**
 * Grouped by where someone works rather than by job title. A hospital has 60+
 * roles (`docs/05`) and a list of them is unreadable; a receptionist looking for
 * their way in recognises "front office" instantly and never has to find
 * "Receptionist / Front Office" in an alphabetical column.
 */
export const DESTINATIONS: readonly Destination[] = [
  {
    name: 'Front office',
    who: 'Reception, registration, appointments, cash counter',
    href: '/login',
  },
  {
    name: 'Clinical',
    who: 'Doctors, nurses, OPD, emergency, wards, theatre',
    href: '/login',
  },
  { name: 'Diagnostics', who: 'Laboratory, radiology, blood bank', href: '/login' },
  {
    name: 'Pharmacy & stores',
    who: 'Dispensing, inventory, purchase, biomedical',
    href: '/login',
  },
  {
    name: 'Administration',
    who: 'Hospital and branch admins, MRD, quality, accounts, HR',
    href: '/login',
  },
  {
    // Patients authenticate with OTP or ABHA rather than a password, which is a
    // different sign-in flow and a different phase of the build. Linking it to
    // the staff screen would send a patient somewhere their credentials cannot
    // work, so it says so instead.
    name: 'Patients & partners',
    who: 'Patients, families, corporate HR, TPAs, referring doctors',
    note: 'Opens with the patient portal',
  },
];
