import type { AllergyRecord, AllergyStatement, AllergyStatus } from '@vims/ui';
import type { AllergyStatementCode, PatientAllergyRow, PatientBannerData } from '../api/types';
import { formatDate } from './format';

/**
 * The projection from the API's allergy state to the design system's, and the one
 * place in this feature where the four arms are handled.
 *
 * `docs/06` §10 names the defect this file exists to prevent: "an empty allergy
 * area that could mean 'none' or 'not asked'". The API models four states —
 * `not_recorded`, `unable_to_assess`, `none_known`, `known` — and so does
 * `@vims/ui`'s `AllergyStatement`/`AllergyStatus`. **Nothing here ever maps
 * `not_recorded` onto "no allergies".** The mapping is total and exhaustive, so a
 * fifth arm added to the enum becomes a compile error rather than a banner that
 * silently reads "none".
 *
 * Note the two types are not the same shape:
 *   - `AllergyStatement` (the editor) carries the *asserter* on `none-known`;
 *   - `AllergyStatus` (the banner) carries only the verification date.
 * Both are produced here so the banner and the editor can never disagree.
 */

/**
 * `PatientAlertSeverity` and the FHIR-shaped severity the banner renders are not
 * the same vocabulary. The banner's `AllergyRecord.severity` admits exactly
 * mild/moderate/severe, and the API's `patient.allergies.severity` can also be
 * `unknown`.
 *
 * An unknown severity is mapped **up**, to `severe`, not down. Under-stating a
 * reaction whose severity nobody recorded is the failure that hurts a patient;
 * over-stating it costs a prescriber one extra glance. The full, unmapped value
 * is still shown in the allergy list on Patient 360.
 */
function toBannerSeverity(severity: string): AllergyRecord['severity'] {
  switch (severity) {
    case 'mild':
      return 'mild';
    case 'moderate':
      return 'moderate';
    case 'severe':
      return 'severe';
    default:
      return 'severe';
  }
}

/**
 * `patient.allergies` rows the banner must show.
 *
 * `entered_in_error` and `refuted` rows are kept by the database (they are never
 * deleted — `docs/06` §1.2.6) but must not be matched against or displayed as
 * live allergies, so they are filtered here rather than in the renderer.
 */
export function bannerAllergyRecords(rows: readonly PatientAllergyRow[]): readonly AllergyRecord[] {
  return rows
    .filter((row) => row.status !== 'entered_in_error' && row.status !== 'refuted')
    .map((row) => ({
      substance: row.substance_text,
      // The reaction text lives in `patient.allergies.reactions` (EN-029) and is
      // not on the banner projection the API returns, so what is shown is the
      // criticality — never an empty string, which would read as "no reaction".
      reaction: row.criticality === 'high' ? 'High criticality' : 'Criticality not established',
      severity: toBannerSeverity(row.severity),
    }));
}

/** The banner's four-arm status. Total over `AllergyStatementCode`. */
export function toBannerAllergyStatus(banner: PatientBannerData): AllergyStatus {
  switch (banner.allergy_statement) {
    case 'known': {
      const allergies = bannerAllergyRecords(banner.allergies);
      // A `known` statement with nothing renderable is a data fault, not a
      // licence to show silence. It degrades to "unable to assess", which is the
      // honest statement: somebody asserted there are allergies and this screen
      // cannot list them.
      if (allergies.length === 0) {
        return {
          kind: 'unable-to-assess',
          reason: 'Allergies are recorded on this patient but could not be listed here. Open the record.',
        };
      }
      return { kind: 'known', allergies };
    }
    case 'none_known':
      return { kind: 'none-known', verifiedOn: formatDate(banner.allergy_asserted_at) };
    case 'unable_to_assess':
      return {
        kind: 'unable-to-assess',
        reason: banner.allergy_unable_reason ?? 'No reason was recorded.',
      };
    case 'not_recorded':
      return { kind: 'not-recorded' };
  }
}

/**
 * The editor's four-arm statement, for the read-back on Patient 360.
 *
 * `assertedBy` falls back to "Not recorded" rather than to an empty string: the
 * editor renders `noneKnown(by, on)`, and an empty `by` would produce
 * "No known allergies (verified by , on 12-08-2026)" — a sentence that looks like
 * a rendering bug and hides the fact that the assertion is unattributed.
 */
export function toAllergyStatement(input: {
  readonly allergy_statement: AllergyStatementCode;
  readonly allergy_asserted_by: string | null;
  readonly allergy_asserted_at: string | null;
  readonly allergy_unable_reason: string | null;
  readonly allergies?: readonly PatientAllergyRow[];
}): AllergyStatement {
  switch (input.allergy_statement) {
    case 'known': {
      const rows = input.allergies ?? [];
      const entries = rows
        .filter((row) => row.status !== 'entered_in_error')
        .map((row) => ({
          id: row.id,
          allergen: {
            display: row.substance_text,
            category: mapCategory(row.category),
          },
          reactions: { kind: 'not-documented' } as const,
          severity: mapSeverity(row.severity),
          criticality: mapCriticality(row.criticality),
          verification:
            row.status === 'refuted'
              ? ({
                  kind: 'refuted',
                  by: input.allergy_asserted_by ?? 'Not recorded',
                  on: formatDate(input.allergy_asserted_at),
                } as const)
              : ({ kind: 'unverified' } as const),
        }));
      const [first, ...rest] = entries;
      if (first === undefined) {
        return {
          kind: 'unable-to-assess',
          reason: 'Allergies are recorded on this patient but could not be listed here. Open the record.',
        };
      }
      return { kind: 'known', entries: [first, ...rest] };
    }
    case 'none_known':
      return {
        kind: 'none-known',
        assertedBy: input.allergy_asserted_by ?? 'Not recorded',
        assertedOn: formatDate(input.allergy_asserted_at),
      };
    case 'unable_to_assess':
      return {
        kind: 'unable-to-assess',
        reason: input.allergy_unable_reason ?? 'No reason was recorded.',
      };
    case 'not_recorded':
      return { kind: 'not-recorded' };
  }
}

function mapCategory(category: string): 'drug' | 'food' | 'environment' | 'latex' | 'other' {
  switch (category) {
    case 'drug':
    case 'food':
    case 'environment':
    case 'latex':
      return category;
    default:
      return 'other';
  }
}

function mapSeverity(severity: string): 'mild' | 'moderate' | 'severe' | 'unknown' {
  switch (severity) {
    case 'mild':
    case 'moderate':
    case 'severe':
      return severity;
    default:
      return 'unknown';
  }
}

function mapCriticality(criticality: string): 'low' | 'high' | 'unable-to-assess' {
  switch (criticality) {
    case 'low':
    case 'high':
      return criticality;
    default:
      return 'unable-to-assess';
  }
}

/**
 * What the **registration form** may send.
 *
 * `known` is missing on purpose and cannot be reached from the desk: the database
 * trigger promotes the statement when an allergy entry exists, and a client that
 * could assert `known` by hand would produce a banner claiming allergies are
 * recorded over an empty list. Recording entries is EN-029, not this phase.
 */
export type RegistrationAllergyStatement = Extract<
  AllergyStatement,
  { kind: 'not-recorded' } | { kind: 'unable-to-assess' } | { kind: 'none-known' }
>;

export function isRegistrationStatement(
  statement: AllergyStatement,
): statement is RegistrationAllergyStatement {
  return statement.kind !== 'known';
}

/** The wire form of a statement the desk is allowed to assert. */
export function toRegisterAllergyInput(statement: RegistrationAllergyStatement): {
  readonly statement: 'not_recorded' | 'unable_to_assess' | 'none_known';
  readonly unableReason?: string;
} {
  switch (statement.kind) {
    case 'not-recorded':
      return { statement: 'not_recorded' };
    case 'none-known':
      return { statement: 'none_known' };
    case 'unable-to-assess':
      return { statement: 'unable_to_assess', unableReason: statement.reason };
  }
}
