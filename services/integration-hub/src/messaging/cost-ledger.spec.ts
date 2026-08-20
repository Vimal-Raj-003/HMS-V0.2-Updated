import { describe, expect, it } from 'vitest';
import { CostLedger, InMemoryCostStore, WHATSAPP_CONVERSATION_WINDOW_MS } from './cost-ledger.js';

const HOSPITAL = '11111111-1111-4111-8111-111111111111';
const AT = new Date('2026-08-21T08:30:00.000Z');

async function ledger(): Promise<CostLedger> {
  const l = new CostLedger(new InMemoryCostStore());
  await l.setRateCard({
    hospitalId: HOSPITAL,
    currency: 'INR',
    homeCountryCode: '91',
    // Minor units: 18 paise per segment, 3 paise DLT charge.
    sms: { perSegment: 18, dltCharge: 3, internationalPerSegment: 450 },
    whatsapp: {
      perConversation: { UTILITY: 115, AUTHENTICATION: 130, MARKETING: 880 },
      conversationWindowMs: WHATSAPP_CONVERSATION_WINDOW_MS,
    },
  });
  return l;
}

describe('SMS pricing', () => {
  it('charges per segment plus the DLT charge once', async () => {
    const l = await ledger();
    expect((await l.priceSms({ hospitalId: HOSPITAL, segments: 1, destinationCountryCode: '91' })).amount).toBe(21);
    expect((await l.priceSms({ hospitalId: HOSPITAL, segments: 3, destinationCountryCode: '91' })).amount).toBe(57);
  });

  it('prices an international destination differently', async () => {
    const l = await ledger();
    const priced = await l.priceSms({ hospitalId: HOSPITAL, segments: 1, destinationCountryCode: '971' });
    expect(priced.amount).toBe(453);
  });

  it('records zero rather than guessing when no rate card exists', async () => {
    // Zero is wrong, but it is *visibly* wrong on a reconciliation report;
    // inventing a rate is wrong invisibly.
    const l = new CostLedger(new InMemoryCostStore());
    const priced = await l.priceSms({ hospitalId: HOSPITAL, segments: 2, destinationCountryCode: '91' });
    expect(priced.amount).toBe(0);
    expect(priced.currency).toBe('INR');
  });
});

describe('WhatsApp conversation pricing', () => {
  it('charges the first message of a category and nothing for the next one inside 24 hours', async () => {
    const l = await ledger();
    const first = await l.priceWhatsApp({ hospitalId: HOSPITAL, phoneE164: '+919876543210', category: 'UTILITY', at: AT });
    expect(first.amount).toBe(115);
    expect(first.freeInsideConversation).toBe(false);

    const second = await l.priceWhatsApp({
      hospitalId: HOSPITAL,
      phoneE164: '+919876543210',
      category: 'UTILITY',
      at: new Date(AT.getTime() + 3 * 60 * 60 * 1000),
    });
    expect(second.amount).toBe(0);
    expect(second.freeInsideConversation).toBe(true);
  });

  it('opens a new conversation once the window has passed', async () => {
    const l = await ledger();
    await l.priceWhatsApp({ hospitalId: HOSPITAL, phoneE164: '+919876543210', category: 'UTILITY', at: AT });
    const later = await l.priceWhatsApp({
      hospitalId: HOSPITAL,
      phoneE164: '+919876543210',
      category: 'UTILITY',
      at: new Date(AT.getTime() + WHATSAPP_CONVERSATION_WINDOW_MS + 1),
    });
    expect(later.amount).toBe(115);
  });

  it('keeps categories apart — a marketing message does not ride a utility conversation', async () => {
    const l = await ledger();
    await l.priceWhatsApp({ hospitalId: HOSPITAL, phoneE164: '+919876543210', category: 'UTILITY', at: AT });
    const marketing = await l.priceWhatsApp({
      hospitalId: HOSPITAL,
      phoneE164: '+919876543210',
      category: 'MARKETING',
      at: AT,
    });
    expect(marketing.amount).toBe(880);
  });
});

describe('roll-ups', () => {
  it('totals by module, channel and campaign, and separates fallback cost', async () => {
    const l = await ledger();
    const base = {
      hospitalId: HOSPITAL,
      branchId: null,
      currency: 'INR',
      freeInsideConversation: false,
      at: AT,
    };
    await l.record({ ...base, messageId: 'm1', channel: 'whatsapp', module: 'OP-001', templateKey: 'appointment_confirmed', campaignId: null, segments: 1, amount: 115, isFallback: false });
    await l.record({ ...base, messageId: 'm2', channel: 'sms', module: 'OP-001', templateKey: 'appointment_confirmed', campaignId: null, segments: 2, amount: 39, isFallback: true });
    await l.record({ ...base, messageId: 'm3', channel: 'sms', module: 'NC-026', templateKey: 'camp_invite', campaignId: 'camp-1', segments: 1, amount: 21, isFallback: false });

    const byChannel = await l.totals(HOSPITAL, { groupBy: 'channel' });
    expect(byChannel.get('sms')?.amount).toBe(60);
    expect(byChannel.get('sms')?.segments).toBe(3);
    expect(byChannel.get('whatsapp')?.amount).toBe(115);

    const byModule = await l.totals(HOSPITAL, { groupBy: 'module' });
    expect(byModule.get('OP-001')?.messages).toBe(2);

    const byCampaign = await l.totals(HOSPITAL, { groupBy: 'campaign' });
    expect(byCampaign.get('camp-1')?.amount).toBe(21);

    // EN-009 §3.3.2: "cost of fallback tracked separately".
    const fallbackOnly = await l.totals(HOSPITAL, { groupBy: 'channel', isFallback: true });
    expect(fallbackOnly.get('sms')?.amount).toBe(39);
  });

  it('honours a date range', async () => {
    const l = await ledger();
    await l.record({
      hospitalId: HOSPITAL,
      branchId: null,
      messageId: 'm1',
      channel: 'sms',
      module: 'OP-001',
      templateKey: 'k',
      campaignId: null,
      segments: 1,
      amount: 21,
      currency: 'INR',
      freeInsideConversation: false,
      isFallback: false,
      at: AT,
    });

    const before = await l.totals(HOSPITAL, { to: new Date(AT.getTime() - 1) });
    expect(before.size).toBe(0);
    const including = await l.totals(HOSPITAL, { from: AT, to: new Date(AT.getTime() + 1) });
    expect(including.get('sms')?.amount).toBe(21);
  });

  it('keeps hospitals apart', async () => {
    const l = await ledger();
    await l.record({
      hospitalId: HOSPITAL,
      branchId: null,
      messageId: 'm1',
      channel: 'sms',
      module: 'OP-001',
      templateKey: 'k',
      campaignId: null,
      segments: 1,
      amount: 21,
      currency: 'INR',
      freeInsideConversation: false,
      isFallback: false,
      at: AT,
    });
    expect((await l.totals('22222222-2222-4222-8222-222222222222')).size).toBe(0);
  });
});
