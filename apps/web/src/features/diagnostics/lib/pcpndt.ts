/**
 * PC-PNDT Act 1994 — the product-level prohibition, expressed as code that can
 * fail a build.
 *
 * Section 5 of the Act prohibits communicating the sex of a foetus "in any
 * manner". Section 6 prohibits determining it. These are criminal provisions and
 * the recording clinician is personally liable, which is why OP-008 §5 bullet 1
 * and AC §14.9, EN-008 §5, EN-035 §1 and OP-040 §5 all say the same flat thing:
 * **no field anywhere captures foetal sex.**
 *
 * The product states that promise in four places, on purpose, because a promise
 * kept in only one place is a promise one refactor from being broken:
 *
 *  1. `migration.sql §C.7` reads `information_schema` and refuses to apply if
 *     such a column ever appears — there is no column to write to.
 *  2. `radiology.schemas.ts` makes every request object `.strict()` — an unknown
 *     key is a 400 that names it, rather than a silently discarded value.
 *  3. `radiology.types.ts` makes the same promise on the way out.
 *  4. **This module**, plus `pcpndt.spec.ts`, makes it of the *screens*: the
 *     spec reads every source file in this feature and fails if a field, label,
 *     option or property named for sex or gender appears in any of them.
 *
 * ── Two different controls, deliberately ────────────────────────────────────
 *
 * OP-008 and EN-008 state an **absolute schema prohibition**: never render such
 * a field, never let a template builder add one. OP-022 §3.3.1, §5 and AC §14.4
 * additionally require a **content validator**: on a PC-PNDT-flagged service,
 * report prose containing "male / female / boy / girl" or a transliteration
 * blocks the sign action, releasable only by an authorised override with a typed
 * reason. Both are built. `scanSourceForSexFields` is the first;
 * `mentionsFoetalSex` is the second.
 *
 * ── Why the prose pattern is narrow, and why it never rewrites ──────────────
 *
 * It is a **refusal, not a sanitiser**. A product that quietly stripped the
 * phrase and stored the rest would be helping to communicate it in the manner
 * that remained. And it is deliberately narrow, for the reason
 * `migration.sql §C.7` gives: a pattern that fired on the bare word "sex" would
 * fire on "sex of the patient", which every DICOM worklist entry lawfully
 * carries — and a control that fires on lawful work is a control people learn to
 * route around.
 */

/**
 * Kept character-for-character in step with `FOETAL_SEX_PATTERN` in
 * `services/api/src/modules/diagnostics/radiology/radiology.schemas.ts`.
 *
 * The client copy exists so a radiologist is told *before* they press sign,
 * rather than meeting a `statutory-limit` refusal after it. The server remains
 * the control: this one runs in a browser the hospital does not own.
 */
export const FOETAL_SEX_PATTERN =
  /\b(fo?etal\s+(sex|gender)|sex\s+of\s+(the\s+)?(fo?etus|baby|child)|gender\s+of\s+(the\s+)?(fo?etus|baby|child)|sex\s+determination|sex\s+selection|(fo?etus|baby)\s+is\s+a\s+(boy|girl)|male\s+fo?etus|female\s+fo?etus)\b/i;

export function mentionsFoetalSex(...values: readonly (string | null | undefined)[]): boolean {
  return values.some((value) => typeof value === 'string' && FOETAL_SEX_PATTERN.test(value));
}

/**
 * The message shown when the check fires.
 *
 * It names the statute rather than saying "invalid input", because the person
 * reading it has to decide what to do next and "the software says no" is not
 * enough information to decide anything.
 */
export const FOETAL_SEX_REFUSAL =
  'This text appears to state the sex of a foetus. Section 5 of the PC-PNDT Act 1994 prohibits communicating it in any manner, so the report cannot be signed with this wording. Remove the phrase — the finding it belongs to can be described without it.';

// ═════════════════════════════════════════════════════════════════════════════
// The source-level guard
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The only two files exempt from the field scan, named here rather than in the
 * spec so that widening the exemption is itself a visible change with a test
 * against it. Both exist solely to define and prove the prohibition.
 */
export const SCAN_EXEMPT_FILES: readonly string[] = ['lib/pcpndt.ts', 'lib/pcpndt.spec.ts'];

/**
 * A token naming sex or gender, in any of the casings a field name takes:
 * `sex`, `Sex`, `foetalSex`, `foetal_sex`, `FOETAL-SEX`, `"Gender"`.
 *
 * The scanner normalises identifier boundaries before matching, so `unisex` and
 * `sexual` do not fire — only a whole token does.
 */
const SEX_TOKEN = /\b(sex|sexes|gender|genders)\b/i;

export interface SourceFile {
  /** Path relative to the feature root, e.g. `components/rad-order-screen.tsx`. */
  readonly path: string;
  readonly source: string;
}

export interface SexFieldOffence {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

/**
 * Strip comments, keep strings.
 *
 * The prohibition is on **fields**, not on prose: this file, and the doc
 * comments in the screens, must be free to cite the Act by name. A string
 * literal, on the other hand, is a rendered label — `<Label>Foetal sex</Label>`
 * is exactly the thing the Act forbids — so strings are kept in the scan.
 *
 * Written as a character scanner rather than a regex because a regex that
 * strips `//…` will happily eat the tail of `'https://x'`. The one case it
 * does not model is a regular-expression literal containing `//` or `/*`,
 * which does not occur outside this file.
 */
export function stripComments(source: string): string {
  let out = '';
  let index = 0;
  const length = source.length;

  while (index < length) {
    const char = source[index] ?? '';
    const next = source[index + 1] ?? '';

    if (char === '/' && next === '/') {
      while (index < length && source[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      while (index < length && !(source[index] === '*' && source[index + 1] === '/')) {
        // Newlines are preserved so reported line numbers stay true.
        if (source[index] === '\n') out += '\n';
        index += 1;
      }
      index += 2;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      out += char;
      index += 1;
      while (index < length) {
        const inner = source[index] ?? '';
        out += inner;
        index += 1;
        if (inner === '\\') {
          out += source[index] ?? '';
          index += 1;
          continue;
        }
        if (inner === quote) break;
      }
      continue;
    }

    out += char;
    index += 1;
  }

  return out;
}

/**
 * Split identifier boundaries so `foetalSex`, `foetal_sex` and `FOETAL-SEX` all
 * expose `sex` as a whole token to the matcher.
 */
function normaliseIdentifiers(line: string): string {
  return line
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1 $2')
    .replace(/[_\-.]/gu, ' ');
}

/**
 * The guard's own exported names, which the screens must be able to call.
 *
 * A screen that *refuses* a foetal sex has to name the thing it is refusing:
 * `mentionsFoetalSex(impression) ? FOETAL_SEX_REFUSAL : null`. Scanning that
 * line naively flags the enforcement as the offence, which is how a guard ends
 * up switched off to make its own test pass.
 *
 * The allowance is deliberately the narrowest thing that works. Only these
 * **exact** identifiers are removed, bounded as whole words, so:
 *
 *   - `mentionsFoetalSex(foetalSex)` still fires, on its argument;
 *   - `patientFoetalSex` still fires — it is not one of these names;
 *   - `<Label>Foetal sex</Label>` still fires — a rendered label is the offence;
 *   - `foetalSex: z.string()` still fires — a field is the offence.
 *
 * Exempting the *files* instead would have been the easy fix and a hole in
 * exactly the two screens that handle obstetric imaging.
 */
const GUARD_REFERENCES: readonly string[] = ['mentionsFoetalSex', 'FOETAL_SEX_REFUSAL', 'FOETAL_SEX_PATTERN'];

function withoutGuardReferences(line: string): string {
  let out = line;
  for (const name of GUARD_REFERENCES) {
    out = out.replace(new RegExp(`\\b${name}\\b`, 'gu'), ' ');
  }
  return out;
}

/**
 * Every place in the given sources where a field, label, option or property is
 * named for sex or gender.
 *
 * An empty result is the only acceptable one for this feature. There is no
 * lawful reason for a radiology, ultrasound or investigation screen to carry
 * such a field, and OP-008 §5 does not admit a configuration that adds one.
 */
export function scanSourceForSexFields(files: readonly SourceFile[]): readonly SexFieldOffence[] {
  const offences: SexFieldOffence[] = [];

  for (const file of files) {
    if (SCAN_EXEMPT_FILES.includes(file.path)) continue;
    const lines = stripComments(file.source).split('\n');
    lines.forEach((line, position) => {
      if (SEX_TOKEN.test(normaliseIdentifiers(withoutGuardReferences(line)))) {
        offences.push({ path: file.path, line: position + 1, text: line.trim() });
      }
    });
  }

  return offences;
}

// ═════════════════════════════════════════════════════════════════════════════
// Form F — what the register *does* require (OP-008 §4, PC-PNDT Rule 9 & 10)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The lawful indications for a prenatal diagnostic procedure, as the Form
 * prescribes them (Rule 10 / Form F clause 8).
 *
 * "Routine" is not one of them, and the absence is the point: the Act permits
 * the procedure only for the listed indications, so a free-text box here would
 * be a hole in the register. `indicationOther` exists on the API and is offered
 * beside these, because clause 8 itself ends in an "any other (specify)" line.
 */
export const FORM_F_INDICATIONS: readonly { readonly code: string; readonly label: string }[] = [
  { code: 'age_35_plus', label: 'Age of the pregnant woman above 35 years' },
  { code: 'spontaneous_abortions', label: 'Two or more spontaneous abortions or foetal loss' },
  { code: 'teratogen_exposure', label: 'Exposure to a potentially teratogenic agent' },
  { code: 'family_history', label: 'Family history of a genetic or chromosomal disorder' },
  { code: 'mental_retardation', label: 'Family history of mental retardation or physical deformity' },
  { code: 'growth_assessment', label: 'Assessment of foetal growth and wellbeing' },
  { code: 'anomaly_evaluation', label: 'Evaluation of a suspected structural anomaly' },
  { code: 'placental_localisation', label: 'Placental localisation' },
  { code: 'liquor_assessment', label: 'Assessment of liquor volume' },
  { code: 'multiple_gestation', label: 'Evaluation of a multiple gestation' },
];

export interface FormFState {
  readonly patientName: string;
  readonly patientAgeYears: string;
  readonly husbandOrFatherName: string;
  readonly fullAddress: string;
  readonly identityDocumentType: string;
  readonly identityDocumentRefMasked: string;
  readonly gravida: string;
  readonly para: string;
  readonly livingChildren: string;
  readonly previousAbortions: string;
  readonly gestationalAgeWeeks: string;
  readonly lastMenstrualPeriod: string;
  readonly referringDoctorName: string;
  readonly referringDoctorRegistrationNo: string;
  readonly indicationCodes: readonly string[];
  readonly indicationOther: string;
  readonly proceduresPerformed: readonly string[];
  readonly facilityRegistrationNo: string;
  readonly machineRegistrationNo: string;
  readonly performedByName: string;
  readonly performedByRegistrationNo: string;
  readonly womanDeclarationSigned: boolean;
  /** The stored artefact behind the tick. The API refuses a tick with nothing behind it. */
  readonly womanDeclarationDocId: string;
  readonly doctorDeclarationSigned: boolean;
  readonly doctorDeclarationDocId: string;
}

export const EMPTY_FORM_F: FormFState = {
  patientName: '',
  patientAgeYears: '',
  husbandOrFatherName: '',
  fullAddress: '',
  identityDocumentType: '',
  identityDocumentRefMasked: '',
  gravida: '',
  para: '',
  livingChildren: '',
  previousAbortions: '',
  gestationalAgeWeeks: '',
  lastMenstrualPeriod: '',
  referringDoctorName: '',
  referringDoctorRegistrationNo: '',
  indicationCodes: [],
  indicationOther: '',
  proceduresPerformed: [],
  facilityRegistrationNo: '',
  machineRegistrationNo: '',
  performedByName: '',
  performedByRegistrationNo: '',
  womanDeclarationSigned: false,
  womanDeclarationDocId: '',
  doctorDeclarationSigned: false,
  doctorDeclarationDocId: '',
};

/**
 * What is still missing before the Form may be recorded.
 *
 * The machine registration number and the performing doctor's registration
 * number are mandatory because OP-008 §5 requires both to print on the report,
 * and an unregistered machine performing a prenatal scan is itself an offence
 * under the Act.
 */
export function formFProblems(form: FormFState): readonly string[] {
  const problems: string[] = [];
  const age = Number.parseInt(form.patientAgeYears, 10);

  if (form.patientName.trim().length < 1) problems.push('The pregnant woman’s name is required.');
  if (!Number.isInteger(age) || age < 10 || age > 70) problems.push('Give her age in completed years.');
  if (form.husbandOrFatherName.trim().length < 1) {
    problems.push('Form F asks for the husband’s or father’s name.');
  }
  if (form.fullAddress.trim().length < 5) problems.push('The full address is required by the Form.');
  if (form.identityDocumentType.trim().length < 1) problems.push('Name the identity document produced.');
  if (form.identityDocumentRefMasked.trim().length < 1) {
    problems.push(
      'Record the masked reference of that document — the register needs a reference, not the number.',
    );
  }
  if (form.referringDoctorName.trim().length < 1) problems.push('The referring doctor must be named.');
  if (form.indicationCodes.length === 0) {
    problems.push(
      'Choose at least one indication from the Form F list. "Routine" is not a lawful indication.',
    );
  }
  if (form.proceduresPerformed.length === 0) problems.push('Record which procedures were performed.');
  if (form.facilityRegistrationNo.trim().length < 1) {
    problems.push('The centre’s PC-PNDT registration number is required.');
  }
  if (form.machineRegistrationNo.trim().length < 1) {
    problems.push('The machine’s registration number is required, and it prints on the report.');
  }
  if (form.performedByName.trim().length < 1) problems.push('Name the doctor who performed the procedure.');
  if (form.performedByRegistrationNo.trim().length < 1) {
    problems.push('That doctor’s registration number is required, and it prints on the report.');
  }
  if (!form.womanDeclarationSigned) problems.push('The woman’s declaration must be signed.');
  if (form.womanDeclarationSigned && form.womanDeclarationDocId.trim() === '') {
    problems.push(
      'Attach the signed declaration. A tick with no document behind it is not a signed declaration, and the API refuses one.',
    );
  }
  if (!form.doctorDeclarationSigned) problems.push('The doctor’s declaration must be signed.');
  if (form.doctorDeclarationSigned && form.doctorDeclarationDocId.trim() === '') {
    problems.push('Attach the doctor’s signed declaration document.');
  }

  return problems;
}

export function canRecordFormF(form: FormFState): boolean {
  return formFProblems(form).length === 0;
}
