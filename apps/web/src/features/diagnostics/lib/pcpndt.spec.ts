import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_FORM_F,
  FORM_F_INDICATIONS,
  SCAN_EXEMPT_FILES,
  canRecordFormF,
  formFProblems,
  mentionsFoetalSex,
  scanSourceForSexFields,
  stripComments,
} from './pcpndt';

/**
 * PC-PNDT Act 1994, asserted of this feature's **source code**.
 *
 * This is not a unit test of a helper. It is the fourth of the product's four
 * statements that no field anywhere captures foetal sex — the migration's
 * `information_schema` assertion, the API's `.strict()` schemas, the API's
 * outbound view types, and this. It reads every `.ts` and `.tsx` file under
 * `features/diagnostics` and under the diagnostics routes, and fails if any of
 * them declares a field, label, option or property named for sex or gender.
 *
 * Falsifying it is one line: add `<Label>Foetal sex</Label>` to any screen and
 * this test names the file and the line.
 */

/**
 * Resolved from the package root, not from `import.meta.url`.
 *
 * The first version used `fileURLToPath(new URL('..', import.meta.url))`, and
 * under this package's jsdom environment `import.meta.url` is not a `file:`
 * URL — so `fileURLToPath` threw at module scope, the suite failed to *load*,
 * and vitest reported it as `(0 test)`. The whole run then read
 * `1 failed | 52 passed` with `610 passed`, which looks like a rounding error
 * and was in fact the only assertion standing between this feature and a
 * criminal offence never executing at all.
 *
 * `process.cwd()` is the package root under vitest, and the existence check
 * below turns a wrong root into a loud failure rather than an empty walk.
 */
const PACKAGE_ROOT = process.cwd();
const FEATURE_ROOT = join(PACKAGE_ROOT, 'src/features/diagnostics');
const ROUTES_ROOT = join(PACKAGE_ROOT, 'src/app/(workspace)/diagnostics');

for (const [name, root] of [
  ['FEATURE_ROOT', FEATURE_ROOT],
  ['ROUTES_ROOT', ROUTES_ROOT],
] as const) {
  if (!existsSync(root)) {
    throw new Error(
      `${name} does not exist: ${root}. This suite scans source files, so a wrong root would ` +
        `walk nothing and pass vacuously — which is exactly how it came to never run at all.`,
    );
  }
}

function collect(root: string, label: string): { readonly path: string; readonly source: string }[] {
  const files: { path: string; source: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/u.test(entry.name)) continue;
      files.push({
        path: `${label}${relative(root, full).split(sep).join('/')}`,
        source: readFileSync(full, 'utf8'),
      });
    }
  };
  walk(root);
  return files;
}

const SOURCES = [...collect(FEATURE_ROOT, ''), ...collect(ROUTES_ROOT, 'routes/')];

describe('the PC-PNDT field prohibition, asserted of the source', () => {
  it('reads a non-trivial number of files, so a broken walker cannot pass vacuously', () => {
    // If the directory walk silently found nothing, every assertion below would
    // pass for the wrong reason. This is the tripwire on the tripwire.
    expect(SOURCES.length).toBeGreaterThan(20);
    expect(SOURCES.some((file) => file.path === 'components/form-f-panel.tsx')).toBe(true);
    expect(SOURCES.some((file) => file.path.startsWith('routes/'))).toBe(true);
  });

  it('finds no field, label or property named for sex or gender anywhere in the feature', () => {
    const offences = scanSourceForSexFields(SOURCES);
    const rendered = offences.map((one) => `${one.path}:${one.line} → ${one.text}`).join('\n');
    expect(offences, `PC-PNDT: a sex-determination field appeared in:\n${rendered}`).toHaveLength(0);
  });

  it('exempts only the two files whose job is to define and prove the prohibition', () => {
    // Widening this list is the obvious way to sneak a field past the scan, so
    // the list itself is asserted rather than trusted.
    expect(SCAN_EXEMPT_FILES).toEqual(['lib/pcpndt.ts', 'lib/pcpndt.spec.ts']);
  });

  it('would catch a foetal-sex field if one were added', () => {
    const offences = scanSourceForSexFields([
      { path: 'components/fake-screen.tsx', source: 'const foetalSex = form.value;' },
    ]);
    expect(offences).toHaveLength(1);
    expect(offences[0]?.path).toBe('components/fake-screen.tsx');
  });

  it('catches the snake_case, kebab-case and label forms too', () => {
    for (const source of [
      'const foetal_sex = 1;',
      '<label htmlFor="fetal-gender">Fetal gender</label>',
      'interface X { readonly sex: string }',
      'const options = ["Male", "Female"]; const genderField = options;',
    ]) {
      expect(scanSourceForSexFields([{ path: 'components/x.tsx', source }]).length).toBeGreaterThan(0);
    }
  });

  it('does not fire on a word that merely contains the letters', () => {
    expect(scanSourceForSexFields([{ path: 'a.ts', source: 'const unisexRoom = true;' }])).toHaveLength(0);
    expect(scanSourceForSexFields([{ path: 'a.ts', source: 'const sexualHistory = 1;' }])).toHaveLength(0);
  });

  it('ignores prose in comments, because the screens must be free to cite the Act', () => {
    const source = ['/** The Act forbids any foetal sex field. */', 'const ok = 1;'].join('\n');
    expect(scanSourceForSexFields([{ path: 'a.ts', source }])).toHaveLength(0);
  });

  it('does not mistake a URL inside a string for the start of a comment', () => {
    // A regex-based comment stripper eats the rest of this line and, with it,
    // any offence that follows on it.
    const stripped = stripComments("const url = 'https://example.test'; const foetalSex = 1;");
    expect(stripped).toContain('foetalSex');
  });
});

describe('the PC-PNDT content validator (OP-022 §3.3.1)', () => {
  it('refuses the phrases a disclosure actually takes', () => {
    expect(mentionsFoetalSex('Foetal sex: male')).toBe(true);
    expect(mentionsFoetalSex('the fetus is a girl')).toBe(true);
    expect(mentionsFoetalSex('single live male foetus')).toBe(true);
    expect(mentionsFoetalSex('performed for sex determination')).toBe(true);
  });

  it('stays silent on the lawful uses of the same word', () => {
    // `migration.sql §C.7`'s reasoning: a control that fires on lawful work is a
    // control people learn to route around. "Sex of the patient" is on every
    // DICOM worklist entry.
    expect(mentionsFoetalSex('Sex of the patient recorded on the worklist')).toBe(false);
    expect(mentionsFoetalSex('Single live intrauterine gestation, cardiac activity present')).toBe(false);
    expect(mentionsFoetalSex(null, undefined, '')).toBe(false);
  });

  it('never rewrites the text — it only answers yes or no', () => {
    // A sanitiser that stripped the phrase would be helping to communicate it in
    // the manner that remained, so the module exposes no such function.
    const module = { mentionsFoetalSex } as Record<string, unknown>;
    expect(Object.keys(module)).toEqual(['mentionsFoetalSex']);
  });
});

describe('Form F', () => {
  const complete = {
    ...EMPTY_FORM_F,
    patientName: 'A. Patient',
    patientAgeYears: '29',
    husbandOrFatherName: 'B. Patient',
    fullAddress: '12 Example Road, Example City',
    identityDocumentType: 'Voter ID',
    identityDocumentRefMasked: '****4321',
    referringDoctorName: 'Dr C. Referrer',
    indicationCodes: ['growth_assessment'],
    proceduresPerformed: ['Obstetric ultrasound'],
    facilityRegistrationNo: 'REG-1',
    machineRegistrationNo: 'MACH-1',
    performedByName: 'Dr D. Sonologist',
    performedByRegistrationNo: 'MC-9',
    womanDeclarationSigned: true,
    womanDeclarationDocId: 'doc-1',
    doctorDeclarationSigned: true,
    doctorDeclarationDocId: 'doc-2',
  };

  it('accepts a Form that carries everything the register needs', () => {
    expect(formFProblems(complete)).toEqual([]);
    expect(canRecordFormF(complete)).toBe(true);
  });

  it('refuses a Form with no indication, because "routine" is not a lawful one', () => {
    const problems = formFProblems({ ...complete, indicationCodes: [] });
    expect(problems.join(' ')).toMatch(/not a lawful indication/iu);
  });

  it('offers only the indications Rule 10 prescribes, and no free-text "routine"', () => {
    expect(FORM_F_INDICATIONS.length).toBeGreaterThan(5);
    expect(FORM_F_INDICATIONS.some((one) => /routine/iu.test(one.label))).toBe(false);
  });

  it('refuses a Form with no machine registration number, because it prints on the report', () => {
    expect(formFProblems({ ...complete, machineRegistrationNo: '' }).join(' ')).toMatch(/machine/iu);
  });

  it('refuses a signed declaration with no document behind it', () => {
    expect(formFProblems({ ...complete, womanDeclarationDocId: '' }).join(' ')).toMatch(
      /tick with no document/iu,
    );
  });
});
