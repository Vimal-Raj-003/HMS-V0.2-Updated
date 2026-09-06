/**
 * Laterality, once, for thirty consoles.
 *
 * OP-025 §0.1 asks for a reusable `sided<T>` pattern shared by ophthalmology
 * (OD/OS/OU), ENT (right/left ear or nostril), orthopaedics, dermatology
 * lesions and dental quadrants.
 *
 * ── One vocabulary in the database, the specialty's own words on screen ─────
 *
 * The stored value is always `clinical.Laterality`:
 * `left | right | bilateral | not_applicable`. An ophthalmologist writes OD and
 * reads OD; a report counting eyes counts `right`. Storing "OD" for the eye and
 * "right" for the ear would give one report two spellings of the same fact, and
 * that is how an audit finds a hospital operated on 41 right knees and 3 Rt
 * knees.
 *
 * `not_applicable` is a statement — this finding has no side — and is different
 * from a blank, which is somebody who did not say. Where a side is genuinely
 * required, the database refuses `not_applicable`; the field is never simply
 * left out.
 */
import { z } from 'zod';

export const LATERALITY = ['left', 'right', 'bilateral', 'not_applicable'] as const;
export type Laterality = (typeof LATERALITY)[number];

export const lateralitySchema = z.enum(LATERALITY);

/** How each specialty writes the same four values. */
export interface LateralityVocabulary {
  readonly left: string;
  readonly right: string;
  readonly bilateral: string;
  readonly notApplicable: string;
}

/**
 * The display vocabularies. Presentation only — nothing here is ever stored.
 *
 * `eye` is the one that matters most: an ophthalmologist reading "left" instead
 * of OS on a theatre list will re-read it, and re-reading a side under time
 * pressure is exactly the moment wrong-site surgery happens.
 */
export const LATERALITY_VOCABULARIES = {
  eye: { left: 'OS', right: 'OD', bilateral: 'OU', notApplicable: '—' },
  ear: { left: 'Left ear', right: 'Right ear', bilateral: 'Both ears', notApplicable: '—' },
  nostril: { left: 'Left nostril', right: 'Right nostril', bilateral: 'Both', notApplicable: '—' },
  limb: { left: 'Left', right: 'Right', bilateral: 'Both', notApplicable: 'Not applicable' },
  breast: { left: 'Left', right: 'Right', bilateral: 'Bilateral', notApplicable: '—' },
  plain: { left: 'Left', right: 'Right', bilateral: 'Bilateral', notApplicable: 'Not applicable' },
} as const satisfies Record<string, LateralityVocabulary>;

export type LateralityContext = keyof typeof LATERALITY_VOCABULARIES;

/** The word this specialty uses for a stored laterality. */
export function lateralityLabel(side: Laterality, context: LateralityContext = 'plain'): string {
  const vocabulary = LATERALITY_VOCABULARIES[context];
  switch (side) {
    case 'left':
      return vocabulary.left;
    case 'right':
      return vocabulary.right;
    case 'bilateral':
      return vocabulary.bilateral;
    case 'not_applicable':
      return vocabulary.notApplicable;
  }
}

/**
 * A finding recorded per side.
 *
 * `bilateral` is deliberately absent from the shape: a value that is true of
 * both sides is two values that happen to agree, and storing it once means the
 * day they stop agreeing there is nowhere to put the difference. Diagnoses and
 * plans may be `bilateral`; measurements are per side.
 */
export function sided<T extends z.ZodTypeAny>(
  value: T,
): z.ZodObject<{ left: z.ZodOptional<T>; right: z.ZodOptional<T> }> {
  return z.object({ left: value.optional(), right: value.optional() });
}

export interface Sided<T> {
  readonly left?: T | undefined;
  readonly right?: T | undefined;
}

/** True when a `Sided<T>` says nothing at all — neither side was recorded. */
export function isEmptySided<T>(value: Sided<T>): boolean {
  return value.left === undefined && value.right === undefined;
}
