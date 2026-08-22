import type {
  AllergenCategory,
  AllergyCriticality,
  AllergyEntry,
  AllergySeverity,
  AllergyStatement,
} from '@vims/ui';
import type { AllergyItem } from '../api/types';
import { formatDay } from './numbers';

/**
 * `GET /patients/{id}/allergies` → the design system's four-arm
 * `AllergyStatement`.
 *
 * `docs/06` §10 names the defect this file exists to prevent: *"an empty allergy
 * area that could mean 'none' or 'not asked'"*. The four states are kept
 * genuinely distinct all the way to the screen, and there is **no path in this
 * file that produces `none-known` from an absence**:
 *
 *  - the list could not be loaded            → `unable-to-assess` ("unable to assess")
 *  - the patient record says `not_recorded`  → `not-recorded` (amber, "not recorded")
 *  - the patient record says `unable_to_assess` → `unable-to-assess`, with its reason
 *  - the patient record says `none_known`    → `none-known`, attributed and dated
 *  - entries exist                           → `known`
 *
 * `none-known` is reachable **only** from an explicit `none_known` statement on
 * the patient record. An empty array is not evidence of anything: it is what a
 * patient nobody has asked looks like, and what a patient whose record this
 * session may not read looks like.
 *
 * The API's clinical severity vocabulary (`mild`/`moderate`/`severe`/`anaphylaxis`)
 * is wider than the design system's, and `anaphylaxis` maps to `severe` — never
 * downwards. An unknown severity also maps **up**, for the reason
 * `features/patient/lib/allergy.ts` gives: under-stating a reaction whose
 * severity nobody recorded is the failure that hurts a patient.
 */

export type AllergyStatementCode = 'not_recorded' | 'unable_to_assess' | 'none_known' | 'known';

function mapCategory(category: string): AllergenCategory {
  switch (category) {
    case 'drug':
    case 'food':
    case 'environment':
    case 'latex':
      return category;
    case 'biologic':
      return 'drug-class';
    default:
      return 'other';
  }
}

function mapSeverity(severity: string): AllergySeverity {
  switch (severity) {
    case 'mild':
    case 'moderate':
    case 'severe':
      return severity;
    case 'anaphylaxis':
      return 'severe';
    default:
      return 'unknown';
  }
}

function mapCriticality(criticality: string): AllergyCriticality {
  switch (criticality) {
    case 'low':
    case 'high':
      return criticality;
    default:
      return 'unable-to-assess';
  }
}

function toEntry(item: AllergyItem): AllergyEntry {
  const reactions = item.reaction.filter((reaction) => reaction.trim() !== '');
  const [firstReaction, ...restReactions] = reactions;
  return {
    id: item.id,
    allergen: {
      display: item.substance_text,
      category: mapCategory(item.category),
      ...(item.substance_code === null ? {} : { code: item.substance_code }),
    },
    reactions:
      firstReaction === undefined
        ? { kind: 'not-documented' }
        : { kind: 'documented', reactions: [firstReaction, ...restReactions] },
    severity: mapSeverity(item.severity),
    criticality: mapCriticality(item.criticality),
    verification:
      item.verification === 'confirmed'
        ? { kind: 'confirmed', by: item.recorded_by, on: formatDay(item.recorded_at) }
        : item.verification === 'refuted'
          ? { kind: 'refuted', by: item.recorded_by, on: formatDay(item.recorded_at) }
          : { kind: 'unverified' },
    recordedBy: item.recorded_by,
    recordedOn: formatDay(item.recorded_at),
  };
}

export interface AllergyStatementInput {
  /** `null` when the list has not loaded, `[]` when it loaded and was empty. */
  readonly items: readonly AllergyItem[] | null;
  /** The patient record's own statement, when this session may read it. */
  readonly statement?: AllergyStatementCode | undefined;
  readonly assertedBy?: string | null | undefined;
  readonly assertedOn?: string | null | undefined;
  readonly unableReason?: string | null | undefined;
  /** True when the allergy request failed. Degrades to "unable to assess", never to blank. */
  readonly failed?: boolean;
}

export function toAllergyStatement(input: AllergyStatementInput): AllergyStatement {
  if (input.failed === true || input.items === null) {
    return {
      kind: 'unable-to-assess',
      reason:
        'the allergy list could not be loaded on this device. Do not read this as "no allergies" — check the chart or ask the patient before prescribing.',
    };
  }

  // `entered_in_error` is kept by the database and must never be matched
  // against or shown as a live allergy (`docs/06` §1.2.6 — never deleted).
  const live = input.items.filter((item) => item.status !== 'entered_in_error');
  const [first, ...rest] = live.map(toEntry);

  if (first !== undefined) return { kind: 'known', entries: [first, ...rest] };

  switch (input.statement) {
    case 'none_known':
      return {
        kind: 'none-known',
        assertedBy: input.assertedBy ?? 'Not recorded',
        assertedOn: formatDay(input.assertedOn ?? null),
      };
    case 'unable_to_assess':
      return {
        kind: 'unable-to-assess',
        reason: input.unableReason ?? 'no reason was recorded.',
      };
    case 'known':
      // The record asserts allergies exist and none came back. That is a data
      // fault, and it is emphatically not a licence to show silence.
      return {
        kind: 'unable-to-assess',
        reason:
          'allergies are recorded on this patient but none could be listed here. Open the patient record before prescribing.',
      };
    case 'not_recorded':
    case undefined:
      return { kind: 'not-recorded' };
  }
}

/**
 * The one predicate a prescribing path may use to decide there is nothing to
 * match against, restated as a named export so a screen never re-derives it.
 *
 * `@vims/ui` exports `isSafeToAssumeNoAllergy`, which returns `true` for exactly
 * `none-known`. This wrapper exists so the *inverse* has a name too: three of
 * the four states mean "you do not know", and a screen that shows a green tick
 * for any of them is the defect.
 */
export function allergyStatusIsUnknown(statement: AllergyStatement): boolean {
  return statement.kind === 'not-recorded' || statement.kind === 'unable-to-assess';
}
