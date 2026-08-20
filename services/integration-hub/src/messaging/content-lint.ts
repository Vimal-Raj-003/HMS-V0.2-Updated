/**
 * The content lint — **the rule that matters most, enforced at registration.**
 *
 * `docs/prompts/phase-01`: "No PHI in SMS/WhatsApp content beyond what the
 * template approval allows." EN-009 §5: "templates carrying diagnosis/results
 * content are prohibited by lint (`phi_level=none` on SMS)". EN-037 §111 and
 * §135 say the same thing from the other side: "a type whose external template
 * contains clinical placeholders fails publication … never values, diagnoses,
 * drug names or test names that reveal a condition".
 *
 * ### Why this runs at registration and not at send
 * A send-time check catches the message. It does not catch the *template*, and
 * the template is the artefact: by the time a send is refused, somebody has
 * written "Your HbA1c is {{2}}", an approver has approved it, it has been
 * submitted to the DLT portal and it is sitting in the template master waiting
 * for the day the guard is bypassed or the check is moved. Refusing it at
 * registration means the sentence never exists. The send path keeps a second,
 * narrower check anyway — on *values*, which registration cannot see — because a
 * variable typed `name` can still be handed "Positive for HIV" by a caller.
 *
 * ### Why the lexicon is condition-revealing rather than merely medical
 * "Your lab report is ready" is a legal, useful, PHI-free message and the
 * seeded catalogue (EN-009 §4.1) contains it. "Your HIV ELISA is reactive" is
 * not. The difference is not the word "lab" — it is whether the sentence tells a
 * reader who glances at a lock screen something about the person's health. So
 * the lists below name conditions, condition-revealing tests, medication and
 * result *values*, and deliberately leave neutral operational vocabulary
 * ("report", "appointment", "token", "bill", "X-ray") alone. A lint that fired
 * on "report" would be turned off within a week, and a lint that is turned off
 * protects nobody.
 *
 * ### One documented conflict with EN-009 §4.1
 * The seeded catalogue lists `critical_alert_doctor` with variables "patient
 * initials, test, value, callback" — a test name and a result value in an SMS.
 * That contradicts EN-009 §5 and EN-037 §135, which are both more specific and
 * are the rules the phase-01 prompt restates. The lint follows §5/§135: such a
 * template is refused, and the safe form of the same alert carries location,
 * urgency and a callback number only, with the value read back over the phone.
 * `docs/DECISIONS.md` should carry this as an ADR; CLAUDE.md §0 requires the
 * conflict be reported rather than silently resolved.
 */
import type { TemplateVariableType } from './types.js';
import { DLT_VARIABLE_MAX_LENGTH } from './types.js';

export type ContentLintCode =
  | 'condition_term'
  | 'sensitive_speciality'
  | 'medication_term'
  | 'dose_literal'
  | 'result_term'
  | 'result_literal'
  | 'revealing_test_name'
  | 'clinical_variable_name'
  | 'identifier_literal'
  | 'variable_too_long';

export interface ContentLintFinding {
  readonly code: ContentLintCode;
  readonly path: string;
  readonly message: string;
  /** The matched text, so the Template Studio can highlight it. Never PHI: it is the template, not a message. */
  readonly evidence: string;
}

interface Rule {
  readonly code: ContentLintCode;
  readonly re: RegExp;
  readonly message: string;
}

function words(list: readonly string[]): string {
  return list.join('|');
}

/** Conditions. Naming one in a message tells a bystander what the person has. */
const CONDITION_TERMS = [
  'diagnos\\w*',
  'prognos\\w*',
  'malignan\\w*',
  'carcinoma',
  'sarcoma',
  'tumou?rs?',
  'cancer',
  'metasta\\w*',
  'hiv',
  'aids',
  'tuberculos\\w*',
  'hepatitis',
  'cirrhosis',
  'diabet\\w*',
  'hypertensive',
  'hypertension',
  'pregnan\\w*',
  'abortion',
  'miscarriage',
  'infertilit\\w*',
  'schizophren\\w*',
  'psychosis',
  'psychotic',
  'bipolar',
  'dementia',
  'alzheimer\\w*',
  'epileps\\w*',
  'seizure',
  'infarct\\w*',
  'stroke',
  'sepsis',
  'septic',
  'anaemia',
  'anemia',
  'leukaemia',
  'leukemia',
  'thalassaemia',
  'thalassemia',
  'venereal',
  'syphilis',
  'gonorrho?ea',
  'addiction',
  'de-?addiction',
  'overdose',
  'suicid\\w*',
  'self-?harm',
  'termination of pregnancy',
];

/**
 * Departments whose name is itself a diagnosis. A neutral one ("Orthopaedics",
 * "General Medicine") is fine and stays out of the list on purpose.
 */
const SENSITIVE_SPECIALITIES = [
  'oncolog\\w*',
  'psychiatr\\w*',
  'mental health',
  'art centre',
  'art center',
  'ivf',
  'fertilit\\w*',
  'sexual health',
  'std clinic',
  'sti clinic',
  'dots centre',
  'dots center',
  'rehab(?:ilitation)? for substance',
];

const MEDICATION_TERMS = [
  'prescrib\\w*',
  'prescription',
  'tablets?',
  'capsules?',
  'syrups?',
  'injections?',
  'infusions?',
  'dosage',
  'dose',
  'antibiotics?',
  'insulin',
  'steroids?',
  'opioids?',
  'narcotics?',
  'chemotherapy',
  'chemo',
  'radiotherapy',
  'dialys\\w*',
  'transfusion',
];

const RESULT_TERMS = [
  'reactive',
  'non-?reactive',
  'seropositive',
  'seronegative',
  'abnormal',
  'deranged',
  'elevated',
  'critically high',
  'critically low',
  'out of range',
  'within normal limits',
  'detected',
  'not detected',
  'malignant',
  'benign',
];

/** Tests whose *name* discloses what is being looked for. */
const REVEALING_TESTS = [
  'hba1c',
  'hb a1c',
  'elisa',
  'vdrl',
  'hbsag',
  'anti-?hcv',
  'beta ?hcg',
  'b-?hcg',
  'pregnancy test',
  'upt',
  'biops\\w*',
  'fnac',
  'histopath\\w*',
  'cytolog\\w*',
  'tumou?r marker',
  'psa',
  'ca-?125',
  'ca-?19-?9',
  'viral load',
  'cd4',
  'sputum afb',
  'mantoux',
  'drug screen',
  'toxicolog\\w*',
  'rt-?pcr',
  'karyotyp\\w*',
];

const RULES: readonly Rule[] = Object.freeze([
  {
    code: 'condition_term',
    re: new RegExp(`\\b(?:${words(CONDITION_TERMS)})\\b`, 'i'),
    message:
      'names a medical condition. An SMS or WhatsApp message is read on a lock screen by whoever is holding the phone (EN-009 §5, EN-037 §135).',
  },
  {
    code: 'sensitive_speciality',
    re: new RegExp(`\\b(?:${words(SENSITIVE_SPECIALITIES)})\\b`, 'i'),
    message:
      'names a speciality that discloses the condition being treated. Use the branch or hospital name and let the patient find the department on arrival.',
  },
  {
    code: 'medication_term',
    re: new RegExp(`\\b(?:${words(MEDICATION_TERMS)})\\b`, 'i'),
    message: 'refers to medication or treatment. Drug names and therapy are never permitted on an external channel.',
  },
  {
    code: 'result_term',
    re: new RegExp(`\\b(?:${words(RESULT_TERMS)})\\b`, 'i'),
    message: 'states a qualitative result. Send a secure link to the report instead of the finding itself.',
  },
  {
    code: 'revealing_test_name',
    re: new RegExp(`\\b(?:${words(REVEALING_TESTS)})\\b`, 'i'),
    message: 'names a test that reveals what is being investigated (EN-037 §135).',
  },
  {
    code: 'dose_literal',
    // `500 mg`, `2.5ml`, `40 IU` — a strength is a drug even when the drug is unnamed.
    re: /\b\d+(?:\.\d+)?\s?(?:mg|mcg|ml|iu|units?)\b/i,
    message: 'contains a drug strength or dose.',
  },
  {
    code: 'result_literal',
    // `7.8 mg/dL`, `140/90 mmHg`, `98 bpm` — a value with a clinical unit.
    re: /\b\d+(?:[./]\d+)?\s?(?:mg\/dl|mmol\/l|g\/dl|iu\/l|mmhg|bpm|cells\/(?:cumm|ul)|%\s?(?:hba1c|saturation))\b/i,
    message: 'contains a clinical measurement.',
  },
  {
    code: 'identifier_literal',
    // A pasted Aadhaar/ABHA in the *template* — every patient would receive it.
    re: /(?<!\d)(?:\d{2}-\d{4}-\d{4}-\d{4}|\d{12,14})(?!\d)/,
    message: 'contains what looks like an Aadhaar or ABHA number typed into the template body itself.',
  },
]);

/** Variable names that promise clinical content whatever the declared type says. */
const CLINICAL_VARIABLE_NAMES = new Set<string>([
  'diagnosis',
  'diagnoses',
  'drug',
  'drugs',
  'medicine',
  'medicines',
  'medication',
  'dose',
  'dosage',
  'result',
  'results',
  'value',
  'values',
  'reading',
  'readings',
  'test',
  'tests',
  'testname',
  'investigation',
  'finding',
  'findings',
  'impression',
  'observation',
  'condition',
  'disease',
  'symptom',
  'symptoms',
  'complaint',
  'complaints',
  'procedure',
  'surgery',
  'therapy',
  'treatment',
  'prescription',
  'allergy',
  'allergies',
  'vitals',
  'bp',
  'sugar',
  'speciality',
  'specialty',
  'department',
]);

/**
 * Splits a variable name into its words, so `testResult`, `test_result` and
 * `TEST RESULT` all become `['test','result']`.
 *
 * Segment matching rather than substring matching, because both alternatives
 * are wrong in a way that gets the lint switched off: exact matching misses
 * `testResult` and `drugName`, and substring matching flags `latestVisit` for
 * containing "test". A lint with false positives is a lint somebody disables.
 */
export function variableNameSegments(name: string): readonly string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((part) => part.toLowerCase())
    .filter((part) => part.length > 0);
}

function namesClinicalContent(name: string): boolean {
  return variableNameSegments(name).some((segment) => CLINICAL_VARIABLE_NAMES.has(segment));
}

export interface LintableVariable {
  readonly index: number;
  readonly name: string;
  readonly type: TemplateVariableType;
  readonly maxLength: number;
}

/**
 * Lints one template version. `body` is the rendered-with-placeholders text as
 * it will be registered; `variables` are its declared slots.
 */
export function lintTemplateContent(input: {
  readonly body: string;
  readonly variables: readonly LintableVariable[];
  readonly registeredContent?: string;
}): readonly ContentLintFinding[] {
  const findings: ContentLintFinding[] = [];

  const texts: readonly { readonly path: string; readonly value: string }[] = [
    { path: 'body', value: input.body },
    ...(input.registeredContent === undefined
      ? []
      : [{ path: 'registeredContent', value: input.registeredContent }]),
  ];

  for (const { path, value } of texts) {
    for (const rule of RULES) {
      const match = rule.re.exec(value);
      if (match !== null) {
        findings.push({
          code: rule.code,
          path,
          message: `template ${path} ${rule.message}`,
          evidence: match[0],
        });
      }
    }
  }

  for (const variable of input.variables) {
    if (namesClinicalContent(variable.name)) {
      findings.push({
        code: 'clinical_variable_name',
        path: `variables.${String(variable.index)}`,
        message: `variable '${variable.name}' would interpolate clinical content into an external message. Remove it; send a secure link to the record instead (EN-009 §5).`,
        evidence: variable.name,
      });
    }
    // The declared type is already a closed set with no clinical member, but the
    // *name* can still promise one — and a reviewer reads the name, not the enum.
    for (const rule of RULES) {
      if (rule.code === 'identifier_literal') continue;
      const match = rule.re.exec(variable.name);
      if (match !== null) {
        findings.push({
          code: rule.code,
          path: `variables.${String(variable.index)}`,
          message: `variable '${variable.name}' ${rule.message}`,
          evidence: match[0],
        });
      }
    }
    if (variable.maxLength > DLT_VARIABLE_MAX_LENGTH) {
      findings.push({
        code: 'variable_too_long',
        path: `variables.${String(variable.index)}`,
        message: `TRAI's 2024 traceability rules cap a DLT variable at ${String(DLT_VARIABLE_MAX_LENGTH)} characters; '${variable.name}' declares ${String(variable.maxLength)}. A longer value is truncated or dropped by the carrier without an error.`,
        evidence: String(variable.maxLength),
      });
    }
  }

  return findings;
}

/**
 * The send-time half: registration cannot see the values a caller will supply,
 * and a variable typed `name` can still be handed "Reactive for HIV".
 */
export function lintVariableValue(name: string, value: string): readonly ContentLintFinding[] {
  const findings: ContentLintFinding[] = [];
  for (const rule of RULES) {
    if (rule.code === 'identifier_literal') continue;
    const match = rule.re.exec(value);
    if (match !== null) {
      findings.push({
        code: rule.code,
        path: `values.${name}`,
        // The evidence is the matched *lexicon* word, never the surrounding value.
        message: `the value supplied for '${name}' ${rule.message}`,
        evidence: match[0],
      });
    }
  }
  return findings;
}
