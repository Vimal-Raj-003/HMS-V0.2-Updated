import { describe, expect, it } from 'vitest';
import { countSegments } from './segments.js';
import { maskPhone, normaliseToE164 } from './phone.js';
import { deliveryRank, isDeliveryFailure, supersedesDeliveryStatus } from './types.js';

describe('SMS segment counting', () => {
  it('counts a plain English message as GSM-7', () => {
    const counted = countSegments('Dear R Iyer, your appointment is confirmed for 21-08-2026 10:30.');
    expect(counted.encoding).toBe('gsm7');
    expect(counted.segments).toBe(1);
  });

  it('splits at 160 septets, then at 153 for concatenated parts', () => {
    expect(countSegments('a'.repeat(160)).segments).toBe(1);
    expect(countSegments('a'.repeat(161)).segments).toBe(2);
    expect(countSegments('a'.repeat(306)).segments).toBe(2);
    expect(countSegments('a'.repeat(307)).segments).toBe(3);
  });

  it('charges two septets for a GSM-7 extension character', () => {
    // 80 square brackets are 160 septets: still one segment, but 81 is not.
    expect(countSegments('['.repeat(80)).segments).toBe(1);
    expect(countSegments('['.repeat(81)).segments).toBe(2);
  });

  it('falls to UCS-2 at 70 characters for an Indic script, which is the whole cost story', () => {
    // The same reminder in Tamil costs three times as much as in English, and a
    // cost report built on message counts never notices.
    const tamil = 'அன்புள்ள ஐயர், உங்கள் சந்திப்பு உறுதி செய்யப்பட்டது.';
    const counted = countSegments(tamil);
    expect(counted.encoding).toBe('ucs2');
    expect(counted.segments).toBe(1);

    expect(countSegments('அ'.repeat(70)).segments).toBe(1);
    expect(countSegments('அ'.repeat(71)).segments).toBe(2);
    expect(countSegments('அ'.repeat(134)).segments).toBe(2);
    expect(countSegments('அ'.repeat(135)).segments).toBe(3);
  });

  it('never reports zero segments for an empty body', () => {
    expect(countSegments('').segments).toBe(1);
  });
});

describe('E.164 normalisation', () => {
  it('accepts the four forms a front-office desk actually types', () => {
    for (const input of ['9876543210', '09876543210', '+91 98765 43210', '919876543210']) {
      const result = normaliseToE164(input);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.detail);
      // All four are one person; a ledger keyed on the raw string is four.
      expect(result.e164).toBe('+919876543210');
    }
  });

  it('rejects an Indian landline, which is billed and never arrives', () => {
    const result = normaliseToE164('04222345678');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('a landline was accepted');
    expect(result.reason).toBe('landline');
  });

  it('rejects a number of the wrong length rather than guessing', () => {
    expect(normaliseToE164('98765').ok).toBe(false);
    expect(normaliseToE164('98765432101234').ok).toBe(false);
  });

  it('honours the hospital default country and keeps an explicit one', () => {
    const uae = normaliseToE164('501234567', '971');
    expect(uae.ok).toBe(true);
    if (!uae.ok) throw new Error(uae.detail);
    expect(uae.e164).toBe('+971501234567');

    const explicit = normaliseToE164('+971501234567', '91');
    expect(explicit.ok).toBe(true);
    if (!explicit.ok) throw new Error(explicit.detail);
    expect(explicit.countryCode).toBe('971');
  });

  it('rejects an unknown country rather than inventing one', () => {
    const result = normaliseToE164('+99912345678');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('an unknown country was accepted');
    expect(result.reason).toBe('unknown_country');
  });

  it('masks to the same token the redactor produces', () => {
    expect(maskPhone('+919876543210')).toBe('«phone:3210»');
  });
});

describe('delivery status ranking', () => {
  it('lets a later status supersede an earlier one', () => {
    expect(supersedesDeliveryStatus('sent', 'delivered')).toBe(true);
    expect(supersedesDeliveryStatus('delivered', 'read')).toBe(true);
    expect(supersedesDeliveryStatus(undefined, 'queued')).toBe(true);
  });

  it('refuses an out-of-order callback, so a late `sent` cannot un-deliver a read message', () => {
    expect(supersedesDeliveryStatus('read', 'sent')).toBe(false);
    expect(supersedesDeliveryStatus('delivered', 'queued')).toBe(false);
    expect(supersedesDeliveryStatus('delivered', 'delivered')).toBe(false);
  });

  it('lets a carrier correct itself: undelivered outranks sent and delivered', () => {
    expect(supersedesDeliveryStatus('sent', 'undelivered')).toBe(true);
    expect(supersedesDeliveryStatus('delivered', 'failed')).toBe(true);
    expect(deliveryRank('failed')).toBeGreaterThan(deliveryRank('delivered'));
  });

  it('classifies the three terminal failures', () => {
    expect(isDeliveryFailure('failed')).toBe(true);
    expect(isDeliveryFailure('undelivered')).toBe(true);
    expect(isDeliveryFailure('expired')).toBe(true);
    expect(isDeliveryFailure('delivered')).toBe(false);
    expect(isDeliveryFailure('read')).toBe(false);
  });
});
