import type { EncounterDetail, UpdateEncounterRequest } from '../api/types';

/**
 * The consultation note, as the editor holds it.
 *
 * The note body the API stores is an open `jsonb` object because OP-002 §3.2
 * builds the examination from EN-039 specialty templates, which are
 * configuration. Until those templates exist, the editor uses the five sections
 * OP-002 §8 names on the tab strip, and stores them under stable keys so a
 * template-driven editor can grow around them without rewriting stored notes.
 *
 * Two of the five are also **columns** on `clinical.encounters`
 * (`chief_complaint_text`, `treatment_plan`, `advice`), because the API projects
 * them onto the queue card and the visit summary. They are sent in both places
 * from one source of truth here, so the note and the column can never disagree.
 *
 * "Clinical text fields: no truncation, no silent loss" (phase-02
 * §Constraints). Nothing in this file trims, caps or normalises the text; the
 * only transformation is `trim()` on the *comparison* used to decide whether a
 * save is needed, which never touches what is stored.
 */

export interface NoteDraft {
  readonly chiefComplaint: string;
  readonly history: string;
  readonly examination: string;
  readonly plan: string;
  readonly advice: string;
}

export const EMPTY_DRAFT: NoteDraft = {
  chiefComplaint: '',
  history: '',
  examination: '',
  plan: '',
  advice: '',
};

function readString(source: Record<string, unknown> | null, key: string): string {
  if (source === null) return '';
  const value = source[key];
  return typeof value === 'string' ? value : '';
}

export function draftFromEncounter(encounter: EncounterDetail): NoteDraft {
  const note = encounter.note;
  return {
    chiefComplaint: encounter.chief_complaint_text ?? readString(note, 'chiefComplaint'),
    history: readString(note, 'history'),
    examination: readString(note, 'examination'),
    plan: encounter.treatment_plan ?? readString(note, 'plan'),
    advice: encounter.advice ?? readString(note, 'advice'),
  };
}

export function toNoteBody(draft: NoteDraft): Record<string, unknown> {
  return {
    chiefComplaint: draft.chiefComplaint,
    history: draft.history,
    examination: draft.examination,
    plan: draft.plan,
    advice: draft.advice,
  };
}

/**
 * The autosave payload.
 *
 * `version` is the optimistic lock, and it is the reason this is a function
 * rather than a spread: a save that carries a stale version must be **refused**
 * by the server, not resolved by the client. Two tabs, or a tablet syncing an
 * offline draft against a note the doctor has since edited on the desktop, must
 * not silently overwrite each other.
 */
export function toUpdateRequest(draft: NoteDraft, version: number): UpdateEncounterRequest {
  return {
    version,
    chiefComplaintText: draft.chiefComplaint,
    treatmentPlan: draft.plan,
    advice: draft.advice,
    note: toNoteBody(draft),
  };
}

export function draftsDiffer(left: NoteDraft, right: NoteDraft): boolean {
  return (
    left.chiefComplaint.trim() !== right.chiefComplaint.trim() ||
    left.history.trim() !== right.history.trim() ||
    left.examination.trim() !== right.examination.trim() ||
    left.plan.trim() !== right.plan.trim() ||
    left.advice.trim() !== right.advice.trim()
  );
}

export function isEmptyDraft(draft: NoteDraft): boolean {
  return !draftsDiffer(draft, EMPTY_DRAFT);
}

/**
 * What to show after a `409 optimistic-lock-conflict`.
 *
 * The doctor's text is never discarded — that is the whole point of the refusal
 * being visible rather than absorbed. This returns the sections that actually
 * differ so the screen can show a side-by-side of exactly those, and the doctor
 * decides. It does not merge: a machine merging two clinical narratives is how a
 * sentence ends up half in each.
 */
export interface ConflictedSection {
  readonly key: keyof NoteDraft;
  readonly label: string;
  readonly mine: string;
  readonly theirs: string;
}

const SECTION_LABELS: Readonly<Record<keyof NoteDraft, string>> = {
  chiefComplaint: 'Complaint',
  history: 'History',
  examination: 'Examination',
  plan: 'Plan',
  advice: 'Advice',
};

export function conflictedSections(mine: NoteDraft, theirs: NoteDraft): readonly ConflictedSection[] {
  const keys: readonly (keyof NoteDraft)[] = ['chiefComplaint', 'history', 'examination', 'plan', 'advice'];
  return keys
    .filter((key) => mine[key].trim() !== theirs[key].trim())
    .map((key) => ({ key, label: SECTION_LABELS[key], mine: mine[key], theirs: theirs[key] }));
}

/** The note body of one stored version, projected back into the editor's shape. */
export function draftFromContent(content: Record<string, unknown>): NoteDraft {
  return {
    chiefComplaint: readString(content, 'chiefComplaint'),
    history: readString(content, 'history'),
    examination: readString(content, 'examination'),
    plan: readString(content, 'plan'),
    advice: readString(content, 'advice'),
  };
}

/** The five sections in tab order, for a renderer that must not invent one. */
export const NOTE_SECTIONS: readonly { readonly key: keyof NoteDraft; readonly label: string }[] = [
  { key: 'chiefComplaint', label: SECTION_LABELS.chiefComplaint },
  { key: 'history', label: SECTION_LABELS.history },
  { key: 'examination', label: SECTION_LABELS.examination },
  { key: 'plan', label: SECTION_LABELS.plan },
  { key: 'advice', label: SECTION_LABELS.advice },
];
