import { describe, expect, it } from 'vitest';
import type { PacsStudyView } from '../api/types';
import {
  TRUSTED_MATCH_BASES,
  formatStudySize,
  isQuarantined,
  reconcileMode,
  whyInQueue,
} from './reconciliation';

/**
 * EN-008 §5 and AC §14.4 — "never silently attach to wrong patient".
 *
 * The property asserted here is the one that keeps a chest CT out of the wrong
 * chart: **name is not a match key**, and a demographic resemblance can never be
 * confirmed with one click.
 */

function study(overrides: Partial<PacsStudyView> = {}): PacsStudyView {
  return {
    id: 'study-1',
    studyInstanceUid: '1.2.840.113619.2.55.3.1',
    patientId: '0192f0e2-0000-7000-8000-0000000000aa',
    accessionNo: 'RAD-0001',
    orderItemId: 'item-1',
    modality: 'CT',
    status: 'stored',
    tier: 'hot',
    matchedBy: 'accession',
    reconciliationStatus: 'matched',
    seriesCount: 4,
    instanceCount: 812,
    sizeBytes: '1073741824',
    isMlc: false,
    legalHold: false,
    ...overrides,
  };
}

describe('what the archive is allowed to have matched on', () => {
  it('trusts only identifiers the hospital itself minted', () => {
    expect(TRUSTED_MATCH_BASES).toEqual(['accession', 'study_uid', 'mwl', 'manual']);
    // The one that must never appear:
    expect(TRUSTED_MATCH_BASES).not.toContain('fallback');
    expect(TRUSTED_MATCH_BASES.some((basis) => /name/iu.test(basis))).toBe(false);
  });

  it('offers a one-click confirm for an accession match', () => {
    expect(reconcileMode(study())).toEqual({ kind: 'confirm_trusted', basis: 'accession' });
  });

  it('demands the patient be named for a demographic resemblance', () => {
    const mode = reconcileMode(study({ matchedBy: 'fallback', reconciliationStatus: 'needs_review' }));
    expect(mode.kind).toBe('name_the_patient');
  });

  it('demands the patient be named for a study that arrived with nothing', () => {
    const mode = reconcileMode(
      study({
        matchedBy: 'unmatched',
        patientId: null,
        accessionNo: null,
        reconciliationStatus: 'needs_review',
      }),
    );
    expect(mode.kind).toBe('name_the_patient');
  });

  it('demands the patient be named even for a "trusted" basis with nothing attached', () => {
    // A study whose basis says `accession` but which carries no patient id is
    // not a confirmable match; it is a row with a hole in it.
    expect(reconcileMode(study({ patientId: null })).kind).toBe('name_the_patient');
  });

  it('says so rather than offering a second confirmation on a settled study', () => {
    expect(reconcileMode(study({ reconciliationStatus: 'reconciled' }))).toEqual({
      kind: 'already_reconciled',
    });
  });
});

describe('the words shown beside a queued study', () => {
  it('explains a demographic guess plainly', () => {
    expect(whyInQueue(study({ matchedBy: 'fallback' }))).toMatch(/demographic resemblance/iu);
  });

  it('explains an orphan study plainly', () => {
    expect(whyInQueue(study({ matchedBy: 'unmatched' }))).toMatch(/no accession number/iu);
  });

  it('treats a basis it does not recognise as unconfirmed rather than as fine', () => {
    expect(whyInQueue(study({ matchedBy: 'something_new' }))).toMatch(/unconfirmed/iu);
  });
});

describe('quarantine (EN-035 AC §14.6)', () => {
  it('quarantines a study still needing review', () => {
    expect(isQuarantined(study({ reconciliationStatus: 'needs_review' }))).toBe(true);
  });

  it('quarantines a study attached to nobody', () => {
    expect(isQuarantined(study({ patientId: null }))).toBe(true);
  });

  it('lets a confirmed study through', () => {
    expect(isQuarantined(study({ reconciliationStatus: 'reconciled' }))).toBe(false);
  });
});

describe('study size', () => {
  it('reads a bigint string without losing precision to a float', () => {
    expect(formatStudySize('1073741824')).toBe('1.0 GB');
    expect(formatStudySize('512')).toBe('512 B');
  });

  it('says "unknown" rather than "0 B" for something it cannot parse', () => {
    expect(formatStudySize('not a number')).toBe('unknown size');
  });
});
