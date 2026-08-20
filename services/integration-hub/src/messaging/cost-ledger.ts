/**
 * EN-009 §3.7 — cost per message, rolled up per tenant.
 *
 * Two things make this arithmetic rather than a counter:
 *
 *  1. **SMS is billed per segment, not per message**, and the segment count
 *     depends on the script. The same appointment reminder is one GSM-7 segment
 *     in English and three UCS-2 segments in Tamil (`segments.ts`), so a cost
 *     report built on message counts understates a Tamil hospital's bill by 3x
 *     and reconciles against the provider invoice at nothing like the 1 % EN-009
 *     §14.12 requires. The DLT charge is added per message on top, because that
 *     is how the operators bill it.
 *  2. **WhatsApp is billed per 24-hour conversation, not per message.** The
 *     first template of a category opens a conversation window; every further
 *     message of that category inside the window is free. Charging per message
 *     would roughly double the reported WhatsApp spend of any hospital that
 *     sends a reminder and then a receipt to the same patient in one day.
 *
 * Money is held in **integer minor units** (paise), never a float: `0.1 + 0.2`
 * is the reason a monthly total drifts from the invoice by rupees, and
 * `docs/03` stores money as `numeric(14,2)` precisely to avoid it.
 */
import type { MessageChannel, WhatsAppCategory } from './types.js';

export interface SmsRates {
  /** Minor units per segment, domestic. */
  readonly perSegment: number;
  /** The operator's per-message DLT charge, added once regardless of segments. */
  readonly dltCharge: number;
  /** Used when the destination country code is not the hospital's own. */
  readonly internationalPerSegment?: number;
}

export interface WhatsAppRates {
  /** Minor units per 24-hour conversation, per Meta category. */
  readonly perConversation: Readonly<Record<WhatsAppCategory, number>>;
  /** Meta's window. Configurable only so a test does not have to wait a day. */
  readonly conversationWindowMs: number;
}

export interface RateCard {
  readonly hospitalId: string;
  readonly currency: string;
  /** The hospital's own country code; anything else prices as international. */
  readonly homeCountryCode: string;
  readonly sms?: SmsRates;
  readonly whatsapp?: WhatsAppRates;
}

export interface CostEntry {
  readonly hospitalId: string;
  readonly branchId: string | null;
  readonly messageId: string;
  readonly channel: MessageChannel;
  readonly module: string;
  readonly templateKey: string;
  readonly campaignId: string | null;
  readonly segments: number;
  /** Minor units. */
  readonly amount: number;
  readonly currency: string;
  /** True when a WhatsApp message rode an already-open conversation and cost nothing. */
  readonly freeInsideConversation: boolean;
  /** EN-009 §3.3.2: "cost of fallback tracked separately". */
  readonly isFallback: boolean;
  readonly at: Date;
}

export interface CostTotals {
  readonly currency: string;
  readonly messages: number;
  readonly segments: number;
  readonly amount: number;
}

export interface CostStore {
  putRateCard(card: RateCard): Promise<void>;
  getRateCard(hospitalId: string): Promise<RateCard | undefined>;
  put(entry: CostEntry): Promise<void>;
  list(hospitalId: string): Promise<readonly CostEntry[]>;
  /** The open WhatsApp conversation for a number+category, if any. */
  getConversationOpenedAt(
    hospitalId: string,
    phoneE164: string,
    category: WhatsAppCategory,
  ): Promise<Date | undefined>;
  setConversationOpenedAt(
    hospitalId: string,
    phoneE164: string,
    category: WhatsAppCategory,
    at: Date,
  ): Promise<void>;
}

export class InMemoryCostStore implements CostStore {
  private readonly cards = new Map<string, RateCard>();
  private readonly entries: CostEntry[] = [];
  private readonly conversations = new Map<string, Date>();

  putRateCard(card: RateCard): Promise<void> {
    this.cards.set(card.hospitalId, card);
    return Promise.resolve();
  }

  getRateCard(hospitalId: string): Promise<RateCard | undefined> {
    return Promise.resolve(this.cards.get(hospitalId));
  }

  put(entry: CostEntry): Promise<void> {
    this.entries.push(entry);
    return Promise.resolve();
  }

  list(hospitalId: string): Promise<readonly CostEntry[]> {
    return Promise.resolve(this.entries.filter((e) => e.hospitalId === hospitalId));
  }

  getConversationOpenedAt(
    hospitalId: string,
    phoneE164: string,
    category: WhatsAppCategory,
  ): Promise<Date | undefined> {
    return Promise.resolve(this.conversations.get(`${hospitalId} ${phoneE164} ${category}`));
  }

  setConversationOpenedAt(
    hospitalId: string,
    phoneE164: string,
    category: WhatsAppCategory,
    at: Date,
  ): Promise<void> {
    this.conversations.set(`${hospitalId} ${phoneE164} ${category}`, at);
    return Promise.resolve();
  }
}

export interface PricedMessage {
  readonly amount: number;
  readonly currency: string;
  readonly segments: number;
  readonly freeInsideConversation: boolean;
}

/** Meta's window, for reference. Overridable on the rate card for tests. */
export const WHATSAPP_CONVERSATION_WINDOW_MS = 24 * 60 * 60 * 1000;

export class CostLedger {
  constructor(private readonly store: CostStore) {}

  async setRateCard(card: RateCard): Promise<void> {
    await this.store.putRateCard(card);
  }

  async priceSms(input: {
    readonly hospitalId: string;
    readonly segments: number;
    readonly destinationCountryCode: string;
  }): Promise<PricedMessage> {
    const card = await this.store.getRateCard(input.hospitalId);
    const rates = card?.sms;
    if (card === undefined || rates === undefined) {
      // No rate card is not free: it is unknown, and reporting it as zero would
      // make a budget alert impossible. Zero with an explicit currency of the
      // card (or INR) is recorded and the reconciliation report shows the gap.
      return {
        amount: 0,
        currency: card?.currency ?? 'INR',
        segments: input.segments,
        freeInsideConversation: false,
      };
    }
    const perSegment =
      input.destinationCountryCode === card.homeCountryCode
        ? rates.perSegment
        : (rates.internationalPerSegment ?? rates.perSegment);
    return {
      amount: perSegment * input.segments + rates.dltCharge,
      currency: card.currency,
      segments: input.segments,
      freeInsideConversation: false,
    };
  }

  /**
   * Prices a WhatsApp template send and, when it opens a conversation, records
   * the window so the next message of the same category inside 24 hours is free.
   */
  async priceWhatsApp(input: {
    readonly hospitalId: string;
    readonly phoneE164: string;
    readonly category: WhatsAppCategory;
    readonly at: Date;
  }): Promise<PricedMessage> {
    const card = await this.store.getRateCard(input.hospitalId);
    const rates = card?.whatsapp;
    if (card === undefined || rates === undefined) {
      return { amount: 0, currency: card?.currency ?? 'INR', segments: 1, freeInsideConversation: false };
    }

    const openedAt = await this.store.getConversationOpenedAt(
      input.hospitalId,
      input.phoneE164,
      input.category,
    );
    const windowMs = rates.conversationWindowMs;
    const inside = openedAt !== undefined && input.at.getTime() - openedAt.getTime() < windowMs;

    if (inside) {
      return { amount: 0, currency: card.currency, segments: 1, freeInsideConversation: true };
    }

    await this.store.setConversationOpenedAt(input.hospitalId, input.phoneE164, input.category, input.at);
    return {
      amount: rates.perConversation[input.category],
      currency: card.currency,
      segments: 1,
      freeInsideConversation: false,
    };
  }

  async record(entry: CostEntry): Promise<void> {
    await this.store.put(entry);
  }

  async entries(hospitalId: string): Promise<readonly CostEntry[]> {
    return this.store.list(hospitalId);
  }

  /**
   * EN-009 §3.7 roll-up. `groupBy` mirrors the API's `?by=module|branch|campaign`
   * plus the channel split the delivery dashboard needs.
   */
  async totals(
    hospitalId: string,
    options: {
      readonly from?: Date;
      readonly to?: Date;
      readonly groupBy?: 'module' | 'branch' | 'campaign' | 'channel' | 'template';
      readonly isFallback?: boolean;
    } = {},
  ): Promise<ReadonlyMap<string, CostTotals>> {
    const all = await this.store.list(hospitalId);
    const out = new Map<string, CostTotals>();

    for (const entry of all) {
      if (options.from !== undefined && entry.at.getTime() < options.from.getTime()) continue;
      if (options.to !== undefined && entry.at.getTime() >= options.to.getTime()) continue;
      if (options.isFallback !== undefined && entry.isFallback !== options.isFallback) continue;

      const key = groupKeyOf(entry, options.groupBy ?? 'channel');
      const current = out.get(key) ?? { currency: entry.currency, messages: 0, segments: 0, amount: 0 };
      out.set(key, {
        currency: entry.currency,
        messages: current.messages + 1,
        segments: current.segments + entry.segments,
        amount: current.amount + entry.amount,
      });
    }
    return out;
  }
}

function groupKeyOf(
  entry: CostEntry,
  groupBy: 'module' | 'branch' | 'campaign' | 'channel' | 'template',
): string {
  switch (groupBy) {
    case 'module':
      return entry.module;
    case 'branch':
      return entry.branchId ?? '(hospital)';
    case 'campaign':
      return entry.campaignId ?? '(none)';
    case 'template':
      return entry.templateKey;
    case 'channel':
      return entry.channel;
  }
}
