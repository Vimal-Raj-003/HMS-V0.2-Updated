import { describe, expect, it } from 'vitest';
import {
  EMPTY_COLLECTION_FORM,
  MIN_OVERRIDE_REASON,
  canCollect,
  identityVerdict,
  isRejected,
  mayReprintLabel,
  stageIndex,
  toCollectRequest,
} from './collection';

/**
 * OP-004 §5 bullet 1 — "a collection is confirmed by scanning the patient and
 * the container, or by recording why that was impossible. There is no third
 * answer."
 *
 * The third answer is what this file exists to make unrepresentable.
 */

const both = { ...EMPTY_COLLECTION_FORM, patientScanVerified: true, containerScanVerified: true };

describe('the two-identifier check', () => {
  it('accepts two scans with no words needed', () => {
    expect(identityVerdict(both)).toEqual({ kind: 'both_scans' });
    expect(canCollect(both)).toBe(true);
  });

  it('blocks a collection with neither scan and no reason', () => {
    const verdict = identityVerdict(EMPTY_COLLECTION_FORM);
    expect(verdict.kind).toBe('blocked');
    if (verdict.kind !== 'blocked') throw new Error('expected a block');
    expect(verdict.message).toContain('the patient and the container');
  });

  it('blocks a collection with only one scan and no reason, and names which is missing', () => {
    const onlyPatient = { ...EMPTY_COLLECTION_FORM, patientScanVerified: true };
    const verdict = identityVerdict(onlyPatient);
    if (verdict.kind !== 'blocked') throw new Error('expected a block');
    expect(verdict.message).toContain('Scan the container');
  });

  it('accepts a documented override, because a dead printer is real', () => {
    const overridden = {
      ...EMPTY_COLLECTION_FORM,
      identityOverrideReason: 'Wristband unreadable, identity confirmed verbally with the nurse in charge.',
    };
    expect(identityVerdict(overridden).kind).toBe('documented_override');
    expect(canCollect(overridden)).toBe(true);
  });

  it('refuses an override reason too short to mean anything', () => {
    const verdict = identityVerdict({ ...EMPTY_COLLECTION_FORM, identityOverrideReason: 'ok' });
    if (verdict.kind !== 'blocked') throw new Error('expected a block');
    expect(verdict.message).toContain(String(MIN_OVERRIDE_REASON));
  });

  it('mirrors the API’s own minimum, so a reason this accepts is never refused by a 400', () => {
    // `collectSampleSchema.identityOverrideReason` is `min(8)`.
    expect(MIN_OVERRIDE_REASON).toBe(8);
  });
});

describe('building the collect request', () => {
  it('sends the two scan flags and no override when both were scanned', () => {
    const request = toCollectRequest(both);
    expect(request.patientScanVerified).toBe(true);
    expect(request.containerScanVerified).toBe(true);
    expect(Object.keys(request)).not.toContain('identityOverrideReason');
  });

  it('sends the trimmed override reason when there was one', () => {
    const request = toCollectRequest({
      ...EMPTY_COLLECTION_FORM,
      identityOverrideReason: '  Neonate with no wristband; identity confirmed by the mother.  ',
    });
    expect(request.identityOverrideReason).toBe(
      'Neonate with no wristband; identity confirmed by the mother.',
    );
  });

  it('throws rather than posting a collection nobody could verify', () => {
    // Reaching this line means a code path got past the gate. Loud beats a
    // silently-omitted reason, which would record a scan-verified collection
    // that was not one.
    expect(() => toCollectRequest(EMPTY_COLLECTION_FORM)).toThrow(/no third answer/iu);
  });

  it('omits fasting hours that are not a number rather than sending NaN', () => {
    const request = toCollectRequest({ ...both, fastingHours: 'about ten' });
    expect(Object.keys(request)).not.toContain('fastingHours');
  });
});

describe('the rules that follow a specimen through the bench', () => {
  it('allows a label reprint only before collection (EN-013 §5 bullet 6)', () => {
    expect(mayReprintLabel('awaiting_collection')).toBe(true);
    expect(mayReprintLabel('collected')).toBe(false);
    expect(mayReprintLabel('accessioned')).toBe(false);
  });

  it('recognises a rejected specimen, which is never resulted', () => {
    expect(isRejected('rejected')).toBe(true);
    expect(isRejected('received')).toBe(false);
  });

  it('orders the pre-analytical stages so the screen can show progress', () => {
    expect(stageIndex('pending')).toBeLessThan(stageIndex('collected'));
    expect(stageIndex('collected')).toBeLessThan(stageIndex('accessioned'));
    expect(stageIndex('rejected')).toBe(-1);
  });
});
