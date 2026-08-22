import { describe, expect, it } from 'vitest';
import type { EncounterDetail } from '../api/types';
import {
  conflictedSections,
  draftFromContent,
  draftFromEncounter,
  draftsDiffer,
  EMPTY_DRAFT,
  isEmptyDraft,
  NOTE_SECTIONS,
  toNoteBody,
  toUpdateRequest,
} from './note';

function encounter(overrides: Partial<EncounterDetail> = {}): EncounterDetail {
  return {
    id: 'enc-1',
    patient_id: 'pat-1',
    visit_id: 'vis-1',
    practitioner_key: null,
    doctor_user_id: 'doc-1',
    department_key: null,
    type: 'opd',
    status: 'in_progress',
    started_at: '2026-08-22T09:00:00.000Z',
    completed_at: null,
    cancelled_at: null,
    cancel_reason: null,
    active_seconds: 120,
    chief_complaint_text: 'Cough for three days',
    chief_complaint_codes: [],
    treatment_plan: 'Rest, fluids',
    advice: 'Return if breathless',
    follow_up_date: null,
    no_diagnosis_reason: null,
    dosing_weight_kg: null,
    dosing_weight_source: 'unknown',
    dosing_weight_at: null,
    dosing_weight_by: null,
    dosing_weight_vitals_id: null,
    cosign_required: false,
    signed_document_id: null,
    version: 3,
    diagnoses: [],
    note: { history: 'Non-smoker', examination: 'Chest clear' },
    note_document_id: null,
    note_version: null,
    note_status: 'draft',
    break_glass: false,
    ...overrides,
  };
}

describe('reading a note into the editor', () => {
  it('prefers the encounter’s own columns for the three fields it projects', () => {
    const draft = draftFromEncounter(encounter());
    expect(draft.chiefComplaint).toBe('Cough for three days');
    expect(draft.plan).toBe('Rest, fluids');
    expect(draft.advice).toBe('Return if breathless');
  });

  it('reads the rest from the note body', () => {
    const draft = draftFromEncounter(encounter());
    expect(draft.history).toBe('Non-smoker');
    expect(draft.examination).toBe('Chest clear');
  });

  it('reads a missing note as empty rather than as undefined text', () => {
    const draft = draftFromEncounter(
      encounter({ note: null, chief_complaint_text: null, treatment_plan: null, advice: null }),
    );
    expect(draft).toStrictEqual(EMPTY_DRAFT);
    expect(isEmptyDraft(draft)).toBe(true);
  });

  it('ignores a note field that is not text rather than rendering an object', () => {
    const draft = draftFromContent({ history: { nested: true } });
    expect(draft.history).toBe('');
  });
});

describe('the autosave payload', () => {
  it('carries the version as the optimistic lock', () => {
    const request = toUpdateRequest(draftFromEncounter(encounter()), 3);
    expect(request.version).toBe(3);
  });

  it('sends the same text in the column and in the note body, from one source', () => {
    const draft = { ...EMPTY_DRAFT, chiefComplaint: 'Fever', plan: 'Paracetamol' };
    const request = toUpdateRequest(draft, 1);
    expect(request.chiefComplaintText).toBe('Fever');
    expect(toNoteBody(draft).chiefComplaint).toBe('Fever');
    expect(request.treatmentPlan).toBe('Paracetamol');
  });

  it('never trims or caps what the doctor typed', () => {
    const long = 'a'.repeat(20_000);
    const request = toUpdateRequest({ ...EMPTY_DRAFT, examination: `  ${long}  ` }, 1);
    expect(toNoteBody({ ...EMPTY_DRAFT, examination: `  ${long}  ` }).examination).toBe(`  ${long}  `);
    expect(request.note?.['examination']).toBe(`  ${long}  `);
  });
});

describe('deciding whether a save is needed', () => {
  it('ignores whitespace-only differences', () => {
    expect(draftsDiffer({ ...EMPTY_DRAFT, plan: 'x' }, { ...EMPTY_DRAFT, plan: ' x ' })).toBe(false);
  });

  it('notices a real edit', () => {
    expect(draftsDiffer({ ...EMPTY_DRAFT, plan: 'x' }, { ...EMPTY_DRAFT, plan: 'y' })).toBe(true);
  });
});

describe('a conflict', () => {
  it('lists only the sections that actually differ, and never merges them', () => {
    const mine = { ...EMPTY_DRAFT, plan: 'Amoxicillin', advice: 'Rest' };
    const theirs = { ...EMPTY_DRAFT, plan: 'Azithromycin', advice: 'Rest' };
    const sections = conflictedSections(mine, theirs);
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ key: 'plan', mine: 'Amoxicillin', theirs: 'Azithromycin' });
  });

  it('reports nothing when the two agree', () => {
    expect(conflictedSections(EMPTY_DRAFT, EMPTY_DRAFT)).toStrictEqual([]);
  });
});

describe('the section list', () => {
  it('is the tab order the doctor works in', () => {
    expect(NOTE_SECTIONS.map((section) => section.key)).toStrictEqual([
      'chiefComplaint',
      'history',
      'examination',
      'plan',
      'advice',
    ]);
  });
});
