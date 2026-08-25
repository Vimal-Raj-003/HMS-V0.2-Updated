import { describe, expect, it } from 'vitest';
import type { RadOrderItemView } from '../api/types';
import {
  EGFR_HARD_STOP,
  EMPTY_SAFETY_SCREEN,
  doseBannerText,
  mayProceed,
  requirementsOf,
  safetyVerdict,
  toSafetyScreenRequest,
  type SafetyScreenState,
} from './safety-screen';

/**
 * OP-008 §3.1.2 and §5 — the imaging safety screen as a gate.
 *
 * The distinction asserted throughout is blocking versus advisory. `docs/06`
 * §10: styling every warning as a hard stop is how alert fatigue is
 * manufactured, and a screen where everything blocks is a screen where people
 * learn to click past blocks.
 */

function item(overrides: Partial<RadOrderItemView> = {}): RadOrderItemView {
  return {
    id: 'item-1',
    lineNo: 1,
    procedureKey: 'proc-1',
    procedureCode: 'CT-HEAD',
    procedureName: 'CT head plain',
    modality: 'CT',
    laterality: 'not_applicable',
    contrast: false,
    status: 'ordered',
    studyInstanceUid: null,
    scheduledProcedureStepId: null,
    isPcpndt: false,
    isIonising: true,
    ...overrides,
  };
}

const answered: SafetyScreenState = { ...EMPTY_SAFETY_SCREEN, pregnancyStatus: 'no' };

describe('what an order needs screened', () => {
  it('reads the requirements from the order lines, not from patient demographics', () => {
    // Deliberate: this feature never fetches a patient's sex or age, so the
    // pregnancy question keys on `isIonising`. Stricter than the spec, and
    // stricter in the safe direction.
    expect(requirementsOf([item()])).toEqual({ ionising: true, magneticResonance: false, pcpndt: false });
    expect(requirementsOf([item({ modality: 'MR', isIonising: false })]).magneticResonance).toBe(true);
    expect(requirementsOf([item({ isPcpndt: true })]).pcpndt).toBe(true);
  });
});

describe('the pregnancy gate (OP-008 §5 bullet 1, AC §14.2)', () => {
  const need = { ionising: true, magneticResonance: false, pcpndt: false };

  it('blocks an ionising exam until the question has been asked', () => {
    const verdict = safetyVerdict(EMPTY_SAFETY_SCREEN, need);
    expect(verdict.blocking.join(' ')).toMatch(/Record the pregnancy status/iu);
    expect(mayProceed(EMPTY_SAFETY_SCREEN, need)).toBe(false);
  });

  it('distinguishes "not asked" from "not pregnant"', () => {
    expect(mayProceed(answered, need)).toBe(true);
  });

  it('blocks a pregnant patient until a written justification exists', () => {
    const pregnant: SafetyScreenState = { ...EMPTY_SAFETY_SCREEN, pregnancyStatus: 'yes' };
    expect(safetyVerdict(pregnant, need).blocking.join(' ')).toMatch(/written justification/iu);
    expect(
      mayProceed(
        { ...pregnant, radiationJustification: 'Suspected intracranial haemorrhage after head injury.' },
        need,
      ),
    ).toBe(true);
  });

  it('treats "possible" as a real answer that needs the same justification', () => {
    const possible: SafetyScreenState = { ...EMPTY_SAFETY_SCREEN, pregnancyStatus: 'possible' };
    expect(safetyVerdict(possible, need).blocking.length).toBeGreaterThan(0);
  });

  it('asks for the LMP as an advisory rather than as a block', () => {
    const possible: SafetyScreenState = {
      ...EMPTY_SAFETY_SCREEN,
      pregnancyStatus: 'possible',
      radiationJustification: 'Suspected pulmonary embolism, non-ionising alternative not diagnostic.',
    };
    const verdict = safetyVerdict(possible, need);
    expect(verdict.blocking).toHaveLength(0);
    expect(verdict.advisories.join(' ')).toMatch(/10-day \/ 28-day/iu);
  });

  it('asks nothing about pregnancy for a non-ionising, non-MR study', () => {
    expect(
      mayProceed(EMPTY_SAFETY_SCREEN, { ionising: false, magneticResonance: false, pcpndt: false }),
    ).toBe(true);
  });
});

describe('the contrast and renal gate (OP-008 §5 bullet 2, AC §14.3)', () => {
  const need = { ionising: true, magneticResonance: false, pcpndt: false };

  it('blocks contrast with no eGFR at all', () => {
    const form = { ...answered, contrastRequired: true };
    expect(safetyVerdict(form, need).blocking.join(' ')).toMatch(/recent eGFR/iu);
  });

  it('blocks contrast below the hard stop without a named radiologist approval', () => {
    const form = { ...answered, contrastRequired: true, egfr: '22' };
    expect(safetyVerdict(form, need).blocking.join(' ')).toContain(String(EGFR_HARD_STOP));
  });

  it('lets it through on a recorded approval, and keeps saying so as an advisory', () => {
    const form = {
      ...answered,
      contrastRequired: true,
      egfr: '22',
      contrastApprovalReason: 'Dr Menon accepts the risk; hydration protocol started, nephrology aware.',
    };
    const verdict = safetyVerdict(form, need);
    expect(verdict.blocking).toHaveLength(0);
    expect(verdict.advisories.join(' ')).toMatch(/recorded radiologist approval/iu);
  });

  it('allows a normal eGFR without ceremony', () => {
    expect(mayProceed({ ...answered, contrastRequired: true, egfr: '88' }, need)).toBe(true);
  });

  it('blocks a documented contrast allergy until somebody decides, and offers the premedication', () => {
    const form = { ...answered, contrastRequired: true, egfr: '90', contrastAllergyKnown: true };
    const verdict = safetyVerdict(form, need);
    expect(verdict.blocking.join(' ')).toMatch(/premedication protocol or a non-contrast alternative/iu);
    expect(verdict.advisories.join(' ')).toMatch(/prednisolone 50 mg at 13 h, 7 h and 1 h/iu);
  });

  it('treats the metformin hold as an advisory and never as a block', () => {
    const form = { ...answered, contrastRequired: true, egfr: '90', metforminHoldAdvised: true };
    const verdict = safetyVerdict(form, need);
    expect(verdict.blocking).toHaveLength(0);
    expect(verdict.advisories.join(' ')).toMatch(/Metformin/iu);
  });
});

describe('the MRI gate (OP-008 §5 bullet 3, AC §14.10)', () => {
  const need = { ionising: false, magneticResonance: true, pcpndt: false };

  it('blocks until the safety questionnaire is completed', () => {
    expect(safetyVerdict(EMPTY_SAFETY_SCREEN, need).blocking.join(' ')).toMatch(
      /questionnaire is mandatory/iu,
    );
  });

  it('blocks an implant flagged unsafe until MR-conditional evidence is documented', () => {
    const form = { ...EMPTY_SAFETY_SCREEN, mriSafetyCompleted: true, mriUnsafeImplant: true };
    expect(safetyVerdict(form, need).blocking.join(' ')).toMatch(/MR-conditional evidence/iu);
    const overridden = {
      ...form,
      mriOverrideReason: 'Device is MR-conditional at 1.5 T; card sighted, conditions applied.',
    };
    expect(mayProceed(overridden, need)).toBe(true);
    expect(safetyVerdict(overridden, need).advisories.join(' ')).toMatch(/documented MR-conditional/iu);
  });
});

describe('PC-PNDT on the order screen', () => {
  it('states the Form F requirement as an advisory, because the block lives on completion', () => {
    const verdict = safetyVerdict(answered, { ionising: false, magneticResonance: false, pcpndt: true });
    expect(verdict.blocking).toHaveLength(0);
    expect(verdict.advisories.join(' ')).toMatch(/Form F must be completed and signed/iu);
  });
});

describe('the request body', () => {
  it('omits what was never answered rather than sending zeroes', () => {
    const request = toSafetyScreenRequest(EMPTY_SAFETY_SCREEN);
    expect(Object.keys(request)).not.toContain('egfr');
    expect(Object.keys(request)).not.toContain('lmpDate');
    expect(Object.keys(request)).not.toContain('radiationJustification');
  });

  it('sends the numbers and the reasons that were given', () => {
    const request = toSafetyScreenRequest({
      ...answered,
      egfr: '41.5',
      contrastApprovalReason: '  Approved by Dr Menon.  ',
    });
    expect(request.egfr).toBe(41.5);
    expect(request.contrastApprovalReason).toBe('Approved by Dr Menon.');
  });
});

describe('the cumulative-dose banner (OP-008 §3.6.2, AC §14.6)', () => {
  it('says it in words rather than as a bare number', () => {
    const text = doseBannerText({
      ctCount12m: 4,
      studyCount12m: 6,
      msv12m: '42.1',
      cumulativeMsvLifetime: '95.3',
      thresholdBreached: false,
    });
    expect(text).toContain('4 CTs in the last 12 months');
    expect(text).toContain('42.1 mSv');
  });

  it('escalates the wording once the hospital’s threshold is passed', () => {
    const text = doseBannerText({
      ctCount12m: 9,
      studyCount12m: 12,
      msv12m: '120.4',
      cumulativeMsvLifetime: '210.9',
      thresholdBreached: true,
    });
    expect(text).toMatch(/review threshold/iu);
  });

  it('says nothing at all when the patient has had no imaging', () => {
    expect(
      doseBannerText({
        ctCount12m: 0,
        studyCount12m: 0,
        msv12m: '0',
        cumulativeMsvLifetime: '0',
        thresholdBreached: false,
      }),
    ).toBeNull();
  });
});
