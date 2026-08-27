import { describe, expect, it } from 'vitest';
import type { DispenseAlertView, DispenseItemView, DispenseView } from '../api/types';
import {
  COUNTER_BLOCKING_FAMILIES,
  DUAL_AUTH_SCHEDULES,
  EMPTY_SCAN_LINE,
  HARD_STOPS_ARE_NEVER_DISMISSIBLE,
  LABEL_BASE_LOCALE,
  LABEL_SECOND_LOCALES,
  REASON_MIN_LENGTH,
  ackKeyOf,
  advisoryHardStops,
  blockingHardStops,
  canPostScan,
  completionVerdict,
  controlledLines,
  hardStops,
  isPartialFill,
  labelLocales,
  otcVerdict,
  requiresSecondPharmacist,
  scanProblems,
  secondPersonVerdict,
  toCompleteRequest,
  type ScanLineDraft,
} from './counter';

/**
 * The dispensing counter's four refusals.
 *
 * The first `describe` is the one that matters: `docs/06` §1.2 says a hard stop
 * "cannot be dismissed", and the tempting implementation of every hard stop
 * anybody has ever shipped is a dialog with an × in the corner.
 */

function alert(overrides: Partial<DispenseAlertView> = {}): DispenseAlertView {
  return {
    key: 'ALLERGY:PENICILLIN',
    family: 'allergy',
    severity: 'contraindicated',
    interruption: 'hard_stop',
    title: 'Documented penicillin allergy (anaphylaxis)',
    detail: 'Amoxicillin is a penicillin. The patient has a recorded anaphylactic reaction.',
    acknowledged: false,
    ...overrides,
  };
}

function line(overrides: Partial<DispenseItemView> = {}): DispenseItemView {
  return {
    id: 'item-1',
    lineNo: 1,
    itemId: 'drug-1',
    itemCode: 'AMOX500',
    itemName: 'Amoxicillin 500 mg capsule',
    schedule: 'h',
    batchId: 'batch-1',
    batchNo: 'B-2201',
    expiryDate: '2027-04-30',
    uomId: 'uom-1',
    qtyEntered: '10',
    qtyBase: '10',
    qtyOrderedBase: '10',
    qtyReturnedBase: '0',
    status: 'dispensed',
    partialReason: null,
    substitutedFromItemId: null,
    mrp: '84.00',
    sellingPrice: '84.00',
    discount: '0.00',
    gstRate: '12.00',
    taxAmount: '9.00',
    lineTotal: '84.00',
    scanned: true,
    fefoOverride: false,
    ledgerId: null,
    alerts: [],
    ...overrides,
  };
}

function dispense(overrides: Partial<DispenseView> = {}): DispenseView {
  const items = overrides.items ?? [line()];
  return {
    id: 'disp-1',
    dispenseNo: 'PH/2026/000123',
    dispenseType: 'rx',
    status: 'draft',
    pharmacyStoreId: 'store-1',
    storeId: 'store-1',
    prescriptionId: 'rx-1',
    rxQueueId: 'q-1',
    patientId: 'pat-1',
    walkInName: null,
    encounterId: null,
    prescriberName: 'Dr A Menon',
    prescriberRegNo: 'TN/12345',
    pharmacistUserId: 'user-pharmacist',
    secondAuthUserId: null,
    payerType: 'cash',
    subtotal: '84.00',
    discount: '0.00',
    taxAmount: '9.00',
    totalAmount: '93.00',
    currency: 'INR',
    dispensedAt: null,
    ...overrides,
    items,
    blockingAlerts: items.flatMap((item) =>
      item.alerts.filter((entry) => entry.interruption === 'hard_stop' && !entry.acknowledged),
    ),
  };
}

const NO_ACKS: ReadonlyMap<string, string> = new Map();

describe('the hard stop is never dismissible', () => {
  it('states it as a constant a change would have to delete', () => {
    expect(HARD_STOPS_ARE_NEVER_DISMISSIBLE).toBe(true);
  });

  /**
   * The failure this guards: somebody adds `dismissAlert`, the counter grows an
   * × on the allergy panel, and every completion after that is one click from a
   * patient with a recorded anaphylaxis getting a penicillin.
   */
  it('exports no function that could dismiss, ignore, bypass or suppress an alert', () => {
    const exported = Object.keys({
      advisoryHardStops,
      blockingHardStops,
      completionVerdict,
      controlledLines,
      hardStops,
      otcVerdict,
      requiresSecondPharmacist,
      secondPersonVerdict,
      toCompleteRequest,
    });
    expect(exported.some((name) => /dismiss|ignore|bypass|suppress|skip|silence/iu.test(name))).toBe(false);
  });

  it('blocks completion while an allergy hard stop carries no recorded reason', () => {
    const verdict = completionVerdict(dispense({ items: [line({ alerts: [alert()] })] }), NO_ACKS);
    expect(verdict.kind).toBe('blocked');
    if (verdict.kind !== 'blocked') throw new Error('expected a block');
    expect(verdict.reasons.join(' ')).toContain('penicillin allergy');
    expect(verdict.reasons.join(' ')).toMatch(/cannot be dismissed/iu);
  });

  it('still blocks when the reason is too short to be a reason', () => {
    const target = dispense({ items: [line({ alerts: [alert()] })] });
    const acks = new Map([[ackKeyOf('item-1', 'ALLERGY:PENICILLIN'), 'ok']]);
    expect(completionVerdict(target, acks).kind).toBe('blocked');
    expect('ok'.length).toBeLessThan(REASON_MIN_LENGTH);
  });

  it('permits completion only once the prescriber conversation is written down', () => {
    const target = dispense({ items: [line({ alerts: [alert()] })] });
    const acks = new Map([
      [
        ackKeyOf('item-1', 'ALLERGY:PENICILLIN'),
        'Dr Menon telephoned 10:42; rash only on prior exposure, not anaphylaxis; proceed.',
      ],
    ]);
    expect(completionVerdict(target, acks)).toEqual({ kind: 'permitted' });
  });

  it('refuses to build a completion request that omits the acknowledgement', () => {
    const target = dispense({ items: [line({ alerts: [alert()] })] });
    expect(() => toCompleteRequest(target, NO_ACKS, { counselled: true, language: 'hi' })).toThrow(
      /hard stop/iu,
    );
  });

  it('carries the reason on the request, keyed to the line and the alert', () => {
    const target = dispense({ items: [line({ alerts: [alert()] })] });
    const reason = 'Prescriber confirmed at 10:42 — documented reaction was a rash, not anaphylaxis.';
    const acks = new Map([[ackKeyOf('item-1', 'ALLERGY:PENICILLIN'), reason]]);
    const body = toCompleteRequest(target, acks, { counselled: true, language: 'ta' });
    expect(body.acknowledgements).toEqual([
      { dispenseItemId: 'item-1', alertKey: 'ALLERGY:PENICILLIN', reason },
    ]);
  });

  /**
   * The families are the API's, mirrored. An interaction blocks; a
   * `schedule_guardrail` — which fires on the *prescriber's* missing
   * registration number — is shown as the hard stop it is but does not hold the
   * counter, because stopping a morphine supply for an administrative fact is
   * the harm `pharmacy.controlled_substance_limits` warns about by name.
   */
  it('blocks on interaction as well as allergy', () => {
    expect(COUNTER_BLOCKING_FAMILIES.has('allergy')).toBe(true);
    expect(COUNTER_BLOCKING_FAMILIES.has('ddi')).toBe(true);
    const target = dispense({
      items: [line({ alerts: [alert({ key: 'DDI:WARFARIN', family: 'ddi', title: 'Warfarin ↔ NSAID' })] })],
    });
    expect(completionVerdict(target, NO_ACKS).kind).toBe('blocked');
  });

  it('shows a prescriber-facing hard stop without holding the counter for it', () => {
    const guardrail = alert({
      key: 'SCHED:NO_REG',
      family: 'schedule_guardrail',
      title: 'No prescriber reg',
    });
    const target = dispense({ items: [line({ alerts: [guardrail] })] });
    expect(advisoryHardStops(target)).toHaveLength(1);
    expect(blockingHardStops(target)).toHaveLength(0);
    expect(completionVerdict(target, NO_ACKS)).toEqual({ kind: 'permitted' });
  });

  it('does not re-raise an alert the API has already recorded as acknowledged', () => {
    const target = dispense({ items: [line({ alerts: [alert({ acknowledged: true })] })] });
    expect(hardStops(target)).toHaveLength(0);
    expect(completionVerdict(target, NO_ACKS)).toEqual({ kind: 'permitted' });
  });

  it('names every unresolved alert, not only the first', () => {
    const target = dispense({
      items: [
        line({ alerts: [alert()] }),
        line({
          id: 'item-2',
          lineNo: 2,
          itemName: 'Warfarin 5 mg',
          alerts: [alert({ key: 'DDI:W', family: 'ddi', title: 'Warfarin ↔ NSAID' })],
        }),
      ],
    });
    const verdict = completionVerdict(target, NO_ACKS);
    if (verdict.kind !== 'blocked') throw new Error('expected a block');
    expect(verdict.reasons).toHaveLength(2);
  });
});

describe('two pharmacists for a controlled drug', () => {
  const narcotic = line({ id: 'item-n', itemName: 'Morphine 10 mg/ml', schedule: 'ndps_narcotic' });

  it('knows which schedules need a second signature', () => {
    expect(DUAL_AUTH_SCHEDULES.has('ndps_narcotic')).toBe(true);
    expect(DUAL_AUTH_SCHEDULES.has('ndps_psychotropic')).toBe(true);
    expect(DUAL_AUTH_SCHEDULES.has('h1')).toBe(false);
  });

  it('asks for nobody on an ordinary dispense', () => {
    expect(requiresSecondPharmacist(dispense())).toBe(false);
    expect(secondPersonVerdict(dispense())).toEqual({ kind: 'not_required' });
  });

  it('blocks a narcotic dispense that has one signature', () => {
    const target = dispense({ items: [narcotic] });
    expect(controlledLines(target)).toHaveLength(1);
    const verdict = secondPersonVerdict(target);
    expect(verdict.kind).toBe('missing');
    expect(completionVerdict(target, NO_ACKS).kind).toBe('blocked');
  });

  /**
   * `phase-04` exit gate 4 and `PharmacyCoSignService`: the same person twice is
   * once. The tempting implementation of a two-person control is a checkbox, and
   * this is the assertion that a checkbox would fail.
   */
  it('refuses the same person as both signatures, in the API’s own words', () => {
    const target = dispense({ items: [narcotic], secondAuthUserId: 'user-pharmacist' });
    const verdict = secondPersonVerdict(target);
    expect(verdict.kind).toBe('same_person');
    if (verdict.kind !== 'same_person') throw new Error('expected same_person');
    expect(verdict.message).toContain('Two signatures from one person are one signature');
    expect(completionVerdict(target, NO_ACKS).kind).toBe('blocked');
  });

  it('permits it once a different pharmacist has signed', () => {
    const target = dispense({ items: [narcotic], secondAuthUserId: 'user-incharge' });
    expect(secondPersonVerdict(target)).toEqual({ kind: 'satisfied', userId: 'user-incharge' });
    expect(completionVerdict(target, NO_ACKS)).toEqual({ kind: 'permitted' });
  });
});

describe('the state of the dispense itself', () => {
  it('refuses to complete an empty dispense', () => {
    const verdict = completionVerdict(dispense({ items: [] }), NO_ACKS);
    if (verdict.kind !== 'blocked') throw new Error('expected a block');
    expect(verdict.reasons.join(' ')).toMatch(/nothing to give the patient/iu);
  });

  it('refuses to complete one that is already completed', () => {
    const verdict = completionVerdict(dispense({ status: 'completed' }), NO_ACKS);
    if (verdict.kind !== 'blocked') throw new Error('expected a block');
    expect(verdict.reasons.join(' ')).toMatch(/already says completed/iu);
  });

  it('treats a declined line as nothing in the bag', () => {
    const declined = line({ qtyBase: '0', status: 'declined' });
    const verdict = completionVerdict(dispense({ items: [declined] }), NO_ACKS);
    expect(verdict.kind).toBe('blocked');
  });
});

describe('the partial fill', () => {
  const full: ScanLineDraft = {
    ...EMPTY_SCAN_LINE,
    scanned: '8901234567890',
    qtyEntered: '10',
    qtyOrderedBase: '10',
  };

  it('posts a full fill with no reason', () => {
    expect(isPartialFill(full)).toBe(false);
    expect(canPostScan(full)).toBe(true);
  });

  it('demands a reason the prescriber can read when it gives less', () => {
    const short = { ...full, qtyEntered: '6' };
    expect(isPartialFill(short)).toBe(true);
    expect(scanProblems(short).join(' ')).toMatch(/partial fill and needs a reason/iu);
    expect(canPostScan({ ...short, partialReason: 'Only 6 in stock; balance ordered.' })).toBe(true);
  });

  it('does not call a typo a partial fill', () => {
    expect(isPartialFill({ ...full, qtyEntered: 'abc' })).toBe(false);
    expect(scanProblems({ ...full, qtyEntered: 'abc' }).join(' ')).toMatch(/how many units/iu);
  });

  it('will not build a line from a memory of a scan', () => {
    expect(scanProblems({ ...full, scanned: '' }).join(' ')).toMatch(/not from a memory of one/iu);
  });
});

describe('the over-the-counter refusal (exit gate 3)', () => {
  it('permits a plain OTC item', () => {
    expect(otcVerdict('otc', 'Paracetamol 500 mg')).toEqual({ kind: 'permitted' });
    expect(otcVerdict('g', 'ORS sachet')).toEqual({ kind: 'permitted' });
  });

  it('refuses a Schedule H drug, with the rule that refuses it', () => {
    const verdict = otcVerdict('h', 'Amoxicillin 500 mg');
    expect(verdict.kind).toBe('refused');
    if (verdict.kind !== 'refused') throw new Error('expected a refusal');
    expect(verdict.message).toContain('Rule 65(9)(a)');
    expect(verdict.message).toMatch(/Capture the prescription/iu);
  });

  it('refuses H1, X and both NDPS classes as well', () => {
    for (const schedule of ['h1', 'x', 'ndps_narcotic', 'ndps_psychotropic']) {
      expect(otcVerdict(schedule, 'Something').kind, schedule).toBe('refused');
    }
  });
});

describe('the label locales (exit gate 2)', () => {
  it('always prints English and one more', () => {
    expect(labelLocales('ta')).toEqual([LABEL_BASE_LOCALE, 'ta']);
    expect(labelLocales('ta')).toHaveLength(2);
  });

  it('never degrades to a single locale, whatever the dropdown holds', () => {
    expect(labelLocales('')).toHaveLength(2);
    expect(labelLocales('   ')).toHaveLength(2);
    expect(labelLocales(LABEL_BASE_LOCALE)).toHaveLength(2);
    expect(new Set(labelLocales(LABEL_BASE_LOCALE)).size).toBe(2);
  });

  it('offers the eleven locales CLAUDE.md names', () => {
    expect(LABEL_SECOND_LOCALES).toHaveLength(11);
    expect(LABEL_SECOND_LOCALES.map((entry) => entry.code)).toContain('hi');
    expect(LABEL_SECOND_LOCALES.map((entry) => entry.code)).not.toContain(LABEL_BASE_LOCALE);
  });
});
