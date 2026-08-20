/**
 * EN-009 §3.5 — the opt-in / opt-out ledger, DND scrubbing and the class rules
 * that decide which of them apply.
 *
 * ### Why classification is the whole of this file
 * Every interesting question here reduces to "what kind of message is this?".
 * EN-009 §5 sets the rule and it is not symmetric:
 *
 *  * `critical` and `transactional` — OTP, token, appointment, report-ready,
 *    bill, discharge, critical alerts — are "sendable 24x7 to any verified
 *    number without marketing consent". Blocking an appointment confirmation
 *    because someone unticked a marketing box is a patient-safety and
 *    operational failure, not a privacy win.
 *  * `service_explicit` — follow-up, medication and vaccination reminders,
 *    surveys — "requires recorded consent".
 *  * `promotional` — camps, packages, birthday wishes — requires "explicit
 *    marketing opt-in + DND scrub + 9AM-9PM + frequency cap".
 *
 * Treating all four the same in either direction is a bug: too strict stops
 * clinical messages, too loose earns a TRAI complaint and a DPDP penalty. So the
 * class is carried on the template, not chosen by the caller, and the decision
 * function below is the only place the asymmetry is expressed.
 *
 * ### Refusal is an event, not an absence
 * `docs/04` §7: "any failed write, failed interface message or failed alert
 * delivery surfaces to a human queue. Never swallow an exception in a clinical
 * path." A message dropped for policy is exactly that kind of failure — the
 * Privacy Officer needs the evidence when a patient complains, and the sending
 * module needs to know its notification never left. So every decision, allow or
 * refuse, is written to the ledger, and the send path additionally records the
 * refusal as a `blocked` row in `ihub_messages`.
 */
import type { MessageChannel, MessageClass } from './types.js';

/** The classes consent is actually recorded against. `critical` maps to `transactional`. */
export type ConsentClass = 'transactional' | 'service_explicit' | 'promotional';

export function consentClassFor(messageClass: MessageClass): ConsentClass {
  return messageClass === 'critical' ? 'transactional' : messageClass;
}

export type ConsentStatus = 'opted_in' | 'opted_out';

/** EN-009 §3.5: where the consent came from, which is what the DPO must produce. */
export type ConsentSource =
  | 'registration_form'
  | 'portal_toggle'
  | 'whatsapp_reply'
  | 'sms_keyword'
  | 'kiosk'
  | 'campaign_form'
  | 'front_desk'
  | 'migration';

export interface ConsentEntry {
  readonly hospitalId: string;
  readonly phoneE164: string;
  readonly channel: MessageChannel;
  readonly consentClass: ConsentClass;
  readonly status: ConsentStatus;
  readonly source: ConsentSource;
  readonly at: Date;
  readonly expiresAt?: Date;
  /** EN-028 consent artefact id, when the ledger mirrors one. */
  readonly consentId?: string;
  /** IP/UA/agent id/wording shown — never PHI. */
  readonly evidence?: Readonly<Record<string, string>>;
}

export type BlockReason = 'invalid' | 'bounced' | 'complaint' | 'do_not_contact' | 'deceased';

export interface BlockEntry {
  readonly hospitalId: string;
  readonly phoneE164: string;
  readonly reason: BlockReason;
  readonly at: Date;
  readonly addedBy?: string;
}

/** TRAI NCPR preference. `fully` blocks all commercial traffic, `promotional` only marketing. */
export type DndPreference = 'fully' | 'promotional';

export interface DndEntry {
  readonly phoneE164: string;
  readonly preference: DndPreference;
  readonly scrubbedAt: Date;
}

export type ConsentRefusal =
  'number_blocked' | 'opted_out' | 'consent_missing' | 'dnd_registered' | 'outside_promotional_window';

export type ConsentDecision =
  | {
      readonly allowed: true;
      readonly consentClass: ConsentClass;
      readonly overrodeDnd: boolean;
      readonly note?: string;
    }
  | {
      readonly allowed: false;
      readonly consentClass: ConsentClass;
      readonly reason: ConsentRefusal;
      readonly detail: string;
    };

export interface ConsentDecisionInput {
  readonly hospitalId: string;
  readonly phoneE164: string;
  readonly channel: MessageChannel;
  readonly messageClass: MessageClass;
  readonly at: Date;
  /** IANA zone of the hospital. The 9AM-9PM window is local, not UTC. */
  readonly timeZone: string;
}

/** What is written whichever way the decision went (EN-009 §3.5, `docs/04` §7). */
export interface ConsentDecisionRecord {
  readonly hospitalId: string;
  readonly phoneE164: string;
  readonly channel: MessageChannel;
  readonly messageClass: MessageClass;
  readonly templateKey: string;
  readonly allowed: boolean;
  readonly reason: ConsentRefusal | 'allowed';
  readonly detail: string;
  readonly at: Date;
  readonly messageId?: string;
}

export interface ConsentStore {
  putConsent(entry: ConsentEntry): Promise<void>;
  getConsent(
    hospitalId: string,
    phoneE164: string,
    channel: MessageChannel,
    consentClass: ConsentClass,
  ): Promise<ConsentEntry | undefined>;
  putBlock(entry: BlockEntry): Promise<void>;
  getBlock(hospitalId: string, phoneE164: string): Promise<BlockEntry | undefined>;
  putDnd(entry: DndEntry): Promise<void>;
  getDnd(phoneE164: string): Promise<DndEntry | undefined>;
  putDecision(record: ConsentDecisionRecord): Promise<void>;
  listDecisions(hospitalId: string, phoneE164?: string): Promise<readonly ConsentDecisionRecord[]>;
}

function consentKey(
  hospitalId: string,
  phoneE164: string,
  channel: MessageChannel,
  consentClass: ConsentClass,
): string {
  return `${hospitalId} ${phoneE164} ${channel} ${consentClass}`;
}

export class InMemoryConsentStore implements ConsentStore {
  private readonly consents = new Map<string, ConsentEntry>();
  private readonly blocks = new Map<string, BlockEntry>();
  private readonly dnd = new Map<string, DndEntry>();
  private readonly decisions: ConsentDecisionRecord[] = [];

  putConsent(entry: ConsentEntry): Promise<void> {
    this.consents.set(
      consentKey(entry.hospitalId, entry.phoneE164, entry.channel, entry.consentClass),
      entry,
    );
    return Promise.resolve();
  }

  getConsent(
    hospitalId: string,
    phoneE164: string,
    channel: MessageChannel,
    consentClass: ConsentClass,
  ): Promise<ConsentEntry | undefined> {
    return Promise.resolve(this.consents.get(consentKey(hospitalId, phoneE164, channel, consentClass)));
  }

  putBlock(entry: BlockEntry): Promise<void> {
    this.blocks.set(`${entry.hospitalId} ${entry.phoneE164}`, entry);
    return Promise.resolve();
  }

  getBlock(hospitalId: string, phoneE164: string): Promise<BlockEntry | undefined> {
    return Promise.resolve(this.blocks.get(`${hospitalId} ${phoneE164}`));
  }

  putDnd(entry: DndEntry): Promise<void> {
    this.dnd.set(entry.phoneE164, entry);
    return Promise.resolve();
  }

  getDnd(phoneE164: string): Promise<DndEntry | undefined> {
    return Promise.resolve(this.dnd.get(phoneE164));
  }

  putDecision(record: ConsentDecisionRecord): Promise<void> {
    this.decisions.push(record);
    return Promise.resolve();
  }

  listDecisions(hospitalId: string, phoneE164?: string): Promise<readonly ConsentDecisionRecord[]> {
    return Promise.resolve(
      this.decisions.filter(
        (d) => d.hospitalId === hospitalId && (phoneE164 === undefined || d.phoneE164 === phoneE164),
      ),
    );
  }
}

/** EN-009 §5: promotional traffic is legal between 09:00 and 21:00 local time. */
export const PROMOTIONAL_WINDOW_START_HOUR = 9;
export const PROMOTIONAL_WINDOW_END_HOUR = 21;

/**
 * The local hour in an IANA zone. `Intl` is used rather than an offset table
 * because India has no DST but the UAE, Qatar and future deployments are not the
 * only zones this will meet, and a hand-rolled offset is wrong twice a year.
 */
export function localHourIn(at: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hour12: false });
  const parsed = Number.parseInt(formatter.format(at), 10);
  return Number.isFinite(parsed) ? parsed : at.getUTCHours();
}

export function insidePromotionalWindow(at: Date, timeZone: string): boolean {
  const hour = localHourIn(at, timeZone);
  return hour >= PROMOTIONAL_WINDOW_START_HOUR && hour < PROMOTIONAL_WINDOW_END_HOUR;
}

export class ConsentLedger {
  constructor(private readonly store: ConsentStore) {}

  async recordConsent(entry: ConsentEntry): Promise<void> {
    await this.store.putConsent(entry);
  }

  /** `STOP` on WhatsApp, an SMS keyword, the portal toggle, or the front desk. */
  async optOut(input: {
    readonly hospitalId: string;
    readonly phoneE164: string;
    readonly channel: MessageChannel;
    readonly consentClass: ConsentClass;
    readonly source: ConsentSource;
    readonly at: Date;
    readonly evidence?: Readonly<Record<string, string>>;
  }): Promise<void> {
    await this.store.putConsent({
      hospitalId: input.hospitalId,
      phoneE164: input.phoneE164,
      channel: input.channel,
      consentClass: input.consentClass,
      status: 'opted_out',
      source: input.source,
      at: input.at,
      ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
    });
  }

  async block(entry: BlockEntry): Promise<void> {
    await this.store.putBlock(entry);
  }

  /** Mirrors the TRAI NCPR scrub result for one number. */
  async recordDnd(entry: DndEntry): Promise<void> {
    await this.store.putDnd(entry);
  }

  async decisionsFor(hospitalId: string, phoneE164?: string): Promise<readonly ConsentDecisionRecord[]> {
    return this.store.listDecisions(hospitalId, phoneE164);
  }

  /**
   * The gate. Order matters: a blocked number is refused before consent is even
   * looked at, because "bounced" and "do not contact" are statements about
   * whether a message *can* or *may* arrive at all.
   */
  async decide(input: ConsentDecisionInput): Promise<ConsentDecision> {
    const consentClass = consentClassFor(input.messageClass);
    const isCritical = input.messageClass === 'critical';

    const block = await this.store.getBlock(input.hospitalId, input.phoneE164);
    if (block !== undefined) {
      // `invalid`/`bounced` are technical: the message cannot arrive, and a
      // critical alert routed here would be silently lost, so it must fail
      // loudly and escalate to another channel (EN-037 §106).
      if (block.reason === 'invalid' || block.reason === 'bounced') {
        return {
          allowed: false,
          consentClass,
          reason: 'number_blocked',
          detail: `number is on the block list as '${block.reason}'; it cannot receive messages on this channel`,
        };
      }
      // `complaint`/`do_not_contact`/`deceased` are legal. EN-037 §94 makes
      // critical patient-safety alerts non-configurable overrides, and those go
      // to *staff*, not to a patient who asked not to be contacted — so the
      // override is allowed and recorded rather than assumed.
      if (!isCritical) {
        return {
          allowed: false,
          consentClass,
          reason: 'number_blocked',
          detail: `number is marked '${block.reason}'; only critical patient-safety alerts may be sent to it (EN-009 §3.8)`,
        };
      }
      return {
        allowed: true,
        consentClass,
        overrodeDnd: true,
        note: `critical alert delivered to a number marked '${block.reason}' — EN-037 §94 makes this override non-configurable; recorded for the DPO`,
      };
    }

    const recorded = await this.store.getConsent(
      input.hospitalId,
      input.phoneE164,
      input.channel,
      consentClass,
    );
    const expired = recorded?.expiresAt !== undefined && recorded.expiresAt.getTime() <= input.at.getTime();

    if (recorded?.status === 'opted_out' && !expired) {
      if (isCritical) {
        return {
          allowed: true,
          consentClass,
          overrodeDnd: true,
          note: 'critical alert overrides a recorded opt-out (EN-037 §94)',
        };
      }
      return {
        allowed: false,
        consentClass,
        reason: 'opted_out',
        detail: `an opt-out is recorded for '${consentClass}' traffic on this number (source: ${recorded.source}, at ${recorded.at.toISOString()})`,
      };
    }

    if (consentClass === 'transactional') {
      // EN-009 §5: 24x7, no marketing consent needed, no DND scrub.
      return { allowed: true, consentClass, overrodeDnd: false };
    }

    if (consentClass === 'service_explicit') {
      if (recorded?.status !== 'opted_in' || expired) {
        return {
          allowed: false,
          consentClass,
          reason: 'consent_missing',
          detail: expired
            ? 'the recorded service consent for this number has expired'
            : 'service-explicit traffic needs a recorded consent for this number and class (EN-009 §5, DPDP Act 2023 §6)',
        };
      }
      return { allowed: true, consentClass, overrodeDnd: false };
    }

    // promotional
    if (recorded?.status !== 'opted_in' || expired) {
      return {
        allowed: false,
        consentClass,
        reason: 'consent_missing',
        detail:
          'promotional traffic needs an explicit marketing opt-in for this number (TRAI TCCCPR 2018, DPDP Act 2023)',
      };
    }
    const dnd = await this.store.getDnd(input.phoneE164);
    if (dnd !== undefined) {
      return {
        allowed: false,
        consentClass,
        reason: 'dnd_registered',
        detail: `the number is on the TRAI NCPR register ('${dnd.preference}'), which no hospital-side opt-in overrides for promotional traffic`,
      };
    }
    if (!insidePromotionalWindow(input.at, input.timeZone)) {
      return {
        allowed: false,
        consentClass,
        reason: 'outside_promotional_window',
        detail: `promotional messages may only be sent between ${String(PROMOTIONAL_WINDOW_START_HOUR)}:00 and ${String(
          PROMOTIONAL_WINDOW_END_HOUR,
        )}:00 ${input.timeZone}; local time is ${String(localHourIn(input.at, input.timeZone))}:00 (TRAI TCCCPR 2018)`,
      };
    }
    return { allowed: true, consentClass, overrodeDnd: false };
  }

  /** Writes the decision, whichever way it went. Called by the send path, always. */
  async recordDecision(record: ConsentDecisionRecord): Promise<void> {
    await this.store.putDecision(record);
  }
}
