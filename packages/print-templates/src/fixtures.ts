/**
 * A print context and sample payloads for tests and for the admin console's
 * "preview with sample data" screen (`EN-005 §14.11`). Deliberately synthetic —
 * `docs/09 §11`: no production PHI ever reaches a lower environment.
 *
 * The diagnostic-report fixtures are *clinically coherent*, not lorem ipsum: the
 * potassium is critical and carries its call-back, the creatinine is high, the
 * sodium is normal, and the amended fixture amends the analyte the amendment
 * table names. A fixture whose critical value has no call-back would let a
 * regression in the call-out pass unnoticed.
 */

import type { LabCumulativeReportPayload } from './html/lab-cumulative-report.js';
import type { LabReportPayload } from './html/lab-report.js';
import type { RadReportPayload } from './html/rad-report.js';
import type { PrintContext } from './types.js';

export function sampleContext(overrides: Partial<PrintContext> = {}): PrintContext {
  return {
    hospital: {
      name: "Vim's Trauma & Multispeciality Hospital",
      legalName: 'VIMS Healthcare Private Limited',
      addressLines: ['Plot 14, Ring Road', 'Coimbatore 641004, Tamil Nadu'],
      phone: '+91 422 400 1200',
      email: 'care@example.invalid',
      gstin: '33AABCV1234F1Z5',
      accreditationLine: 'NABH accredited · NABL M-0000',
    },
    branch: {
      name: 'Main Campus',
      addressLines: ['Block A, Ground Floor'],
      phone: '+91 422 400 1210',
    },
    locale: 'en-IN',
    direction: 'ltr',
    printedAtLabel: '20-Aug-2026 09:14',
    printedBy: 'R. Devi (Front Office)',
    documentRef: 'OPB-2026-000481',
    duplicate: false,
    ...overrides,
  };
}

/** An opaque verification token of the shape `randomBytes(24).toString('base64url')` produces. */
export const SAMPLE_VERIFY_TOKEN = 'Zk9tQ3RXbFJ4YlZ1TnNBMlk3RGpQZzFF';

export const SAMPLE_PATIENT = Object.freeze({
  name: 'Ramesh Subramanian',
  uhid: 'CBE-000123456',
  ageSex: '58/M',
  dateOfBirthLabel: '14-Feb-1968',
  referringDoctor: 'Dr. A. Kumar, Nephrology',
  wardBed: 'Ward 3 / Bed 12',
  visitType: 'Inpatient',
  alerts: ['Allergy: penicillin', 'Isolation: contact'],
});

/**
 * A biochemistry report with one critical potassium, a documented call-back and
 * an out-of-scope send-out — the combination that exercises the call-out box,
 * the flag chip, the delta line and the accreditation footnote at once.
 */
export function sampleLabReport(overrides: Partial<LabReportPayload> = {}): LabReportPayload {
  return {
    title: 'Laboratory Report',
    subtitle: 'Biochemistry',
    reportNo: 'LAB-2026-004471/BIO',
    accessionNo: 'LAB-2026-004471',
    status: { release: 'final', version: 1 },
    patient: { ...SAMPLE_PATIENT },
    order: {
      orderedAtLabel: '20-Aug-2026 06:40',
      orderedBy: 'Dr. A. Kumar, Nephrology',
      priority: 'stat',
      clinicalNotes: 'CKD stage 4, on review for hyperkalaemia.',
      source: 'Inpatient',
    },
    specimens: [
      {
        sampleNo: 'S-2026-889201',
        specimenType: 'Serum',
        container: 'Gold-top SST, 1 of 2',
        collectedAtLabel: '20-Aug-2026 06:58',
        receivedAtLabel: '20-Aug-2026 07:12',
        conditionOnReceipt: 'Acceptable',
      },
    ],
    reportedAtLabel: '20-Aug-2026 08:41',
    criticalValues: [
      {
        analyte: 'Potassium',
        value: '6.9',
        unit: 'mmol/L',
        flag: 'critical_high',
        detectedAtLabel: '20-Aug-2026 08:02',
        notifiedToName: 'Dr. A. Kumar',
        notifiedToRole: 'Ordering physician',
        notifiedAtLabel: '20-Aug-2026 08:09',
        notifiedByName: 'S. Meena (Senior Technologist)',
        method: 'telephone',
        readBackConfirmed: true,
        clinicianUnreachable: false,
      },
    ],
    groups: [
      {
        heading: 'Renal profile',
        specimen: 'Serum',
        method: 'Ion-selective electrode / enzymatic',
        analyser: 'Roche cobas c503 · INST-04',
        rows: [
          {
            analyte: 'Sodium',
            loincCode: '2951-2',
            value: '138',
            unit: 'mmol/L',
            referenceInterval: '136 – 145',
            flag: 'normal',
            method: 'ISE indirect',
            deltaFlagged: false,
            amended: false,
            outsideNablScope: false,
          },
          {
            analyte: 'Potassium',
            loincCode: '2823-3',
            value: '6.9',
            unit: 'mmol/L',
            referenceInterval: '3.5 – 5.1',
            flag: 'critical_high',
            method: 'ISE indirect',
            previousValue: '5.4 mmol/L',
            previousAtLabel: '18-Aug-2026 07:10',
            deltaFlagged: true,
            comment: 'Repeated on a fresh draw; haemolysis index within limits.',
            amended: false,
            outsideNablScope: false,
          },
          {
            analyte: 'Creatinine',
            loincCode: '2160-0',
            value: '3.42',
            unit: 'mg/dL',
            referenceInterval: '0.70 – 1.30',
            flag: 'high',
            method: 'Enzymatic',
            deltaFlagged: false,
            amended: false,
            outsideNablScope: false,
          },
          {
            analyte: 'Cystatin C',
            value: '2.11',
            unit: 'mg/L',
            referenceInterval: '0.61 – 0.95',
            flag: 'high',
            method: 'Immunoturbidimetry',
            outsourcedTo: 'Partner Reference Laboratory, Chennai',
            deltaFlagged: false,
            amended: false,
            outsideNablScope: true,
          },
        ],
        notes: [],
      },
    ],
    notes: ['Results relate only to the specimen received. Clinical correlation is advised.'],
    authorisers: [
      {
        name: 'Dr. Lakshmi Narayanan',
        credentials: 'MD (Pathology)',
        designation: 'Consultant Biochemist',
        registrationNo: 'TMC/48210',
        signedAtLabel: '20-Aug-2026 08:41',
        signMethod: 'dsc',
        role: 'authoriser',
      },
    ],
    accreditation: {
      nablLogoPrinted: false,
      scopeNote: 'Laboratory accredited by NABL to ISO 15189:2022, certificate M-0000.',
    },
    verify: {
      baseUrl: 'https://verify.vims-hospital.example/r',
      token: SAMPLE_VERIFY_TOKEN,
      caption: 'Scan to verify this report',
      validityNote: 'The verification page confirms issue date and version only. Valid for 90 days.',
    },
    footerNote: 'This is a computer-generated report and is valid without a physical signature.',
    labels: {},
    ...overrides,
  };
}

/** A CT head report with a critical finding, a co-signature and a dose record. */
export function sampleRadReport(overrides: Partial<RadReportPayload> = {}): RadReportPayload {
  return {
    title: 'Radiology Report',
    reportNo: 'RAD-2026-001902',
    accessionNo: 'RAD-2026-001902',
    status: { release: 'final', version: 1 },
    patient: { ...SAMPLE_PATIENT, referringDoctor: 'Dr. P. Iyer, Emergency Medicine' },
    study: {
      description: 'CT Brain, plain',
      modality: 'CT',
      bodyPart: 'Head',
      laterality: 'Not applicable',
      priority: 'stat',
      requestedAtLabel: '20-Aug-2026 05:52',
      performedAtLabel: '20-Aug-2026 06:08',
      reportedAtLabel: '20-Aug-2026 06:31',
      room: 'CT Suite 1',
      equipment: 'Siemens SOMATOM go.Top · AST-0112',
      protocol: 'Trauma head, 5 mm axial',
      repeatCount: 0,
    },
    clinicalIndication: 'Fall from height, GCS 12 on arrival, right-sided weakness.',
    technique: ['Non-contrast axial sections of the brain from the skull base to the vertex at 5 mm.'],
    contrast: { given: false },
    comparison: ['No prior cross-sectional imaging of the brain is available for comparison.'],
    findings: [
      'A hyperdense extra-axial collection is seen along the left fronto-parietal convexity, measuring 11 mm in maximum thickness, with a biconvex configuration consistent with an acute extradural haematoma.',
      'There is effacement of the adjacent sulci and 6 mm of midline shift to the right. The basal cisterns remain patent.',
      'An undisplaced fracture of the left parietal bone crosses the middle meningeal groove.',
      'No intraventricular extension. Grey–white differentiation is preserved elsewhere.',
    ],
    impression: [
      'Acute left fronto-parietal extradural haematoma, 11 mm, with 6 mm midline shift — urgent neurosurgical referral advised.',
      'Undisplaced left parietal fracture crossing the middle meningeal groove.',
    ],
    recommendations: ['Immediate neurosurgical review. Repeat CT at 6 hours or sooner if the GCS falls.'],
    scores: [],
    criticalFinding: {
      level: 'critical',
      text: 'Acute extradural haematoma with midline shift.',
      detectedAtLabel: '20-Aug-2026 06:24',
      notifiedToName: 'Dr. P. Iyer',
      notifiedToRole: 'Emergency physician',
      notifiedAtLabel: '20-Aug-2026 06:27',
      notifiedByName: 'Dr. S. Rao',
      method: 'telephone',
      readBackConfirmed: true,
      clinicianUnreachable: false,
    },
    dose: {
      ctdiVol: '48.2 mGy',
      dlp: '812 mGy·cm',
      estimatedEffectiveDose: '1.71 mSv',
      drlComparison: 'Within the national DRL of 1000 mGy·cm for adult head CT',
      cumulative12Months: '4.9 mSv across 3 studies',
      source: 'rdsr',
    },
    keyImages: [],
    notes: [],
    authorisers: [
      {
        name: 'Dr. Sanjay Rao',
        credentials: 'MD, DNB (Radiodiagnosis)',
        designation: 'Consultant Radiologist',
        registrationNo: 'TMC/33991',
        signedAtLabel: '20-Aug-2026 06:31',
        signMethod: 'aadhaar_esign',
        role: 'authoriser',
      },
    ],
    verify: {
      baseUrl: 'https://verify.vims-hospital.example/r',
      token: 'RmFrZVJhZFRva2VuXzAwMDAwMDAwMDAwMQ',
      caption: 'Scan to verify this report',
    },
    footerNote: 'Images are available in the patient portal for 90 days.',
    labels: {},
    ...overrides,
  };
}

/** Two years of HbA1c and creatinine — acceptance criterion 12 of `OP-004 §14`. */
export function sampleCumulativeReport(
  overrides: Partial<LabCumulativeReportPayload> = {},
): LabCumulativeReportPayload {
  const dates = [
    '12-Sep-2024',
    '18-Dec-2024',
    '22-Mar-2025',
    '01-Jul-2025',
    '14-Oct-2025',
    '20-Jan-2026',
    '02-May-2026',
    '20-Aug-2026',
  ];

  const hba1c = [7.8, 8.4, 8.1, 9.2, 8.7, 7.9, 7.4, 7.1];
  const creatinine = [1.42, 1.61, 1.88, 2.14, 2.55, 2.91, 3.2, 3.42];

  return {
    title: 'Cumulative Laboratory Report',
    reportNo: 'LAB-CUM-2026-000317',
    accessionNo: 'LAB-CUM-2026-000317',
    status: { release: 'final', version: 1 },
    patient: { ...SAMPLE_PATIENT },
    periodLabel: '12-Sep-2024 to 20-Aug-2026',
    compiledAtLabel: '20-Aug-2026 09:10',
    columns: dates.map((dateLabel, index) => ({
      dateLabel,
      accessionNo: `LAB-${String(2024 + Math.floor(index / 4))}-${String(1000 + index * 37)}`,
    })),
    analytes: [
      {
        analyte: 'HbA1c',
        unit: '%',
        loincCode: '4548-4',
        referenceInterval: '4.0 – 5.6',
        referenceLow: 4.0,
        referenceHigh: 5.6,
        cells: hba1c.map((value) => ({
          value: value.toFixed(1),
          flag: 'high' as const,
          numeric: value,
          amended: false,
        })),
      },
      {
        analyte: 'Creatinine',
        unit: 'mg/dL',
        loincCode: '2160-0',
        referenceInterval: '0.70 – 1.30',
        referenceLow: 0.7,
        referenceHigh: 1.3,
        cells: creatinine.map((value, index) => ({
          value: value.toFixed(2),
          flag: 'high' as const,
          numeric: value,
          amended: index === 2,
        })),
      },
    ],
    showTrend: true,
    notes: [],
    authorisers: [
      {
        name: 'Dr. Lakshmi Narayanan',
        credentials: 'MD (Pathology)',
        designation: 'Consultant Biochemist',
        registrationNo: 'TMC/48210',
        signedAtLabel: '20-Aug-2026 09:10',
        signMethod: 'dsc',
        role: 'authoriser',
      },
    ],
    verify: {
      baseUrl: 'https://verify.vims-hospital.example/r',
      token: 'Q3VtdWxhdGl2ZVRva2VuXzAwMDAwMDAwMDE',
      caption: 'Scan to verify this report',
    },
    ...overrides,
  };
}
