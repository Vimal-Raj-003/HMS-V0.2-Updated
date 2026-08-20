import { describe, expect, it } from 'vitest';
import { ConsentLedger, InMemoryConsentStore, consentClassFor, insidePromotionalWindow } from './consent-ledger.js';
import type { MessageClass } from './types.js';

const HOSPITAL = '11111111-1111-4111-8111-111111111111';
const PHONE = '+919876543210';
const TZ = 'Asia/Kolkata';

/** 14:00 IST — inside the promotional window, so the window is never the reason. */
const MIDDAY = new Date('2026-08-21T08:30:00.000Z');
/** 21:30 IST. */
const LATE = new Date('2026-08-21T16:00:00.000Z');

function ledger(): ConsentLedger {
  return new ConsentLedger(new InMemoryConsentStore());
}

async function decide(l: ConsentLedger, messageClass: MessageClass, at: Date = MIDDAY): Promise<ReturnType<ConsentLedger['decide']>> {
  return l.decide({ hospitalId: HOSPITAL, phoneE164: PHONE, channel: 'sms', messageClass, at, timeZone: TZ });
}

describe('classification drives the consent decision', () => {
  it('lets transactional and critical traffic through with no consent recorded at all', async () => {
    // EN-009 §5: "critical/transactional … sendable 24x7 to any verified number
    // without marketing consent". Blocking an appointment confirmation because
    // nobody ticked a marketing box is an operational failure, not a privacy win.
    const l = ledger();
    expect((await decide(l, 'transactional')).allowed).toBe(true);
    expect((await decide(l, 'critical')).allowed).toBe(true);
  });

  it('refuses service-explicit traffic to the same number and the same moment', async () => {
    const l = ledger();
    const decision = await decide(l, 'service_explicit');
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error('unreachable');
    expect(decision.reason).toBe('consent_missing');
  });

  it('refuses promotional traffic to the same number and the same moment', async () => {
    const l = ledger();
    const decision = await decide(l, 'promotional');
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error('unreachable');
    expect(decision.reason).toBe('consent_missing');
  });

  it('allows service-explicit once a consent is recorded, and still refuses promotional', async () => {
    const l = ledger();
    await l.recordConsent({
      hospitalId: HOSPITAL,
      phoneE164: PHONE,
      channel: 'sms',
      consentClass: 'service_explicit',
      status: 'opted_in',
      source: 'registration_form',
      at: MIDDAY,
    });

    expect((await decide(l, 'service_explicit')).allowed).toBe(true);
    // Consent is per class. A service consent is not a marketing consent, and
    // treating it as one is exactly the DPDP "itemised consent" failure.
    expect((await decide(l, 'promotional')).allowed).toBe(false);
  });
});

describe('DND applies to promotional traffic only', () => {
  it('refuses a promotional message to a DND number even with a recorded marketing opt-in', async () => {
    const l = ledger();
    await l.recordConsent({
      hospitalId: HOSPITAL,
      phoneE164: PHONE,
      channel: 'sms',
      consentClass: 'promotional',
      status: 'opted_in',
      source: 'campaign_form',
      at: MIDDAY,
    });
    await l.recordDnd({ phoneE164: PHONE, preference: 'promotional', scrubbedAt: MIDDAY });

    const decision = await decide(l, 'promotional');
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error('unreachable');
    expect(decision.reason).toBe('dnd_registered');
  });

  it('does not let the same DND entry block the appointment reminder', async () => {
    // This is the asymmetry that matters: NCPR registration is about commercial
    // traffic. A DND number still gets its token and its bill.
    const l = ledger();
    await l.recordDnd({ phoneE164: PHONE, preference: 'promotional', scrubbedAt: MIDDAY });

    expect((await decide(l, 'transactional')).allowed).toBe(true);
    expect((await decide(l, 'critical')).allowed).toBe(true);
  });
});

describe('the promotional 9AM-9PM window', () => {
  it('refuses a fully consented, non-DND promotional message at 21:30 IST', async () => {
    const l = ledger();
    await l.recordConsent({
      hospitalId: HOSPITAL,
      phoneE164: PHONE,
      channel: 'sms',
      consentClass: 'promotional',
      status: 'opted_in',
      source: 'campaign_form',
      at: MIDDAY,
    });

    const decision = await decide(l, 'promotional', LATE);
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error('unreachable');
    expect(decision.reason).toBe('outside_promotional_window');
  });

  it('sends the same hospital transactional traffic at 21:30 IST', async () => {
    const l = ledger();
    expect((await decide(l, 'transactional', LATE)).allowed).toBe(true);
  });

  it('computes the window in the hospital time zone, not in UTC', () => {
    // 16:00 UTC is 21:30 IST (closed) and 20:00 in Dubai (closed) but 16:00 in
    // London (open). A UTC comparison would get all three wrong.
    expect(insidePromotionalWindow(LATE, 'Asia/Kolkata')).toBe(false);
    expect(insidePromotionalWindow(LATE, 'Europe/London')).toBe(true);
    expect(insidePromotionalWindow(MIDDAY, 'Asia/Kolkata')).toBe(true);
  });
});

describe('opt-out and the block list', () => {
  it('refuses after an opt-out and names the source in the reason', async () => {
    const l = ledger();
    await l.optOut({
      hospitalId: HOSPITAL,
      phoneE164: PHONE,
      channel: 'sms',
      consentClass: 'promotional',
      source: 'whatsapp_reply',
      at: MIDDAY,
    });

    const decision = await decide(l, 'promotional');
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error('unreachable');
    expect(decision.reason).toBe('opted_out');
    expect(decision.detail).toContain('whatsapp_reply');
  });

  it('honours an opt-out recorded against transactional traffic itself', async () => {
    // EN-009 §5: "transactional always allowed **unless legally opted out**".
    const l = ledger();
    await l.optOut({
      hospitalId: HOSPITAL,
      phoneE164: PHONE,
      channel: 'sms',
      consentClass: 'transactional',
      source: 'front_desk',
      at: MIDDAY,
    });

    const decision = await decide(l, 'transactional');
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error('unreachable');
    expect(decision.reason).toBe('opted_out');
  });

  it('refuses everything to a bounced number, including a critical alert', async () => {
    // `bounced` is technical, not legal: the message cannot arrive, so a
    // critical alert routed here would be silently lost and must escalate.
    const l = ledger();
    await l.block({ hospitalId: HOSPITAL, phoneE164: PHONE, reason: 'bounced', at: MIDDAY });

    for (const messageClass of ['transactional', 'critical', 'promotional'] as const) {
      const decision = await decide(l, messageClass);
      expect(decision.allowed).toBe(false);
      if (decision.allowed) throw new Error('unreachable');
      expect(decision.reason).toBe('number_blocked');
    }
  });

  it('lets a critical alert override a do-not-contact mark, and says so', async () => {
    // EN-037 §94 makes this non-configurable. It is allowed *and recorded*.
    const l = ledger();
    await l.block({ hospitalId: HOSPITAL, phoneE164: PHONE, reason: 'do_not_contact', at: MIDDAY });

    expect((await decide(l, 'transactional')).allowed).toBe(false);

    const critical = await decide(l, 'critical');
    expect(critical.allowed).toBe(true);
    if (!critical.allowed) throw new Error('unreachable');
    expect(critical.overrodeDnd).toBe(true);
    expect(critical.note).toContain('EN-037');
  });

  it('treats an expired consent as no consent', async () => {
    const l = ledger();
    await l.recordConsent({
      hospitalId: HOSPITAL,
      phoneE164: PHONE,
      channel: 'sms',
      consentClass: 'service_explicit',
      status: 'opted_in',
      source: 'registration_form',
      at: new Date('2025-01-01T00:00:00.000Z'),
      expiresAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    const decision = await decide(l, 'service_explicit');
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error('unreachable');
    expect(decision.detail).toContain('expired');
  });
});

describe('decision recording', () => {
  it('keeps refusals for the Privacy Officer to answer a complaint with', async () => {
    const l = ledger();
    await l.recordDecision({
      hospitalId: HOSPITAL,
      phoneE164: PHONE,
      channel: 'sms',
      messageClass: 'promotional',
      templateKey: 'camp_invite',
      allowed: false,
      reason: 'dnd_registered',
      detail: 'NCPR',
      at: MIDDAY,
    });

    const decisions = await l.decisionsFor(HOSPITAL, PHONE);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.reason).toBe('dnd_registered');
  });
});

describe('consentClassFor', () => {
  it('records critical traffic against the transactional consent class', () => {
    expect(consentClassFor('critical')).toBe('transactional');
    expect(consentClassFor('transactional')).toBe('transactional');
    expect(consentClassFor('service_explicit')).toBe('service_explicit');
    expect(consentClassFor('promotional')).toBe('promotional');
  });
});
