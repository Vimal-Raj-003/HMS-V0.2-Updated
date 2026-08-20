/**
 * The provider-reference directory: `provider_msg_id` -> the hub message it
 * belongs to.
 *
 * A delivery webhook is the only part of the messaging flow that arrives with no
 * context at all. Meta says `wamid.HBgMOTE...` is now `delivered`; MSG91 says
 * request id `3a7f...` is `DELIVRD`. Neither carries our message id, our tenant
 * or our correlation id, so without this mapping a status callback cannot find
 * the row it is about — and EN-009 §14.2 requires the status to move to
 * delivered/read via the webhook.
 *
 * EN-009 §4 puts this on `msg_messages.provider_msg_id`, indexed. That table is
 * in the `engage` schema, which does not exist yet, and `integration.ihub_messages`
 * has no column for a partner reference. So the mapping is an interface with an
 * in-memory implementation — the same shape and the same honesty as
 * `InMemoryPayloadStore`: process-local, lost on restart, and a callback that
 * arrives after a restart is therefore unmatched rather than misapplied. It is
 * replaced by a lookup on `msg_messages.provider_msg_id` when the `engage`
 * schema lands, and no caller changes.
 */
import type { MessageChannel, MessageClass, DeliveryStatus } from './types.js';

export interface SentMessageRef {
  readonly providerMessageId: string;
  /** `ihub_messages.id`. */
  readonly messageId: string;
  /** `ihub_messages.created_at::text` — the other half of the composite key. */
  readonly createdAt: string;
  readonly hospitalId: string;
  readonly branchId: string | null;
  readonly connectorKey: string;
  readonly channel: MessageChannel;
  readonly templateKey: string;
  readonly messageClass: MessageClass;
  readonly phoneE164: string;
  readonly locale: string;
  readonly module: string;
  readonly sentAt: Date;
  readonly status: DeliveryStatus;
  /** Set once a fallback has been sent for this message, so it happens once. */
  readonly fallbackMessageId?: string;
}

export interface MessageDirectory {
  put(ref: SentMessageRef): Promise<void>;
  byProviderMessageId(hospitalId: string, providerMessageId: string): Promise<SentMessageRef | undefined>;
  byMessageId(messageId: string): Promise<SentMessageRef | undefined>;
  update(messageId: string, patch: Partial<Pick<SentMessageRef, 'status' | 'fallbackMessageId'>>): Promise<void>;
}

export class InMemoryMessageDirectory implements MessageDirectory {
  private readonly byProvider = new Map<string, SentMessageRef>();
  private readonly byId = new Map<string, SentMessageRef>();

  put(ref: SentMessageRef): Promise<void> {
    this.byProvider.set(`${ref.hospitalId} ${ref.providerMessageId}`, ref);
    this.byId.set(ref.messageId, ref);
    return Promise.resolve();
  }

  byProviderMessageId(hospitalId: string, providerMessageId: string): Promise<SentMessageRef | undefined> {
    return Promise.resolve(this.byProvider.get(`${hospitalId} ${providerMessageId}`));
  }

  byMessageId(messageId: string): Promise<SentMessageRef | undefined> {
    return Promise.resolve(this.byId.get(messageId));
  }

  update(
    messageId: string,
    patch: Partial<Pick<SentMessageRef, 'status' | 'fallbackMessageId'>>,
  ): Promise<void> {
    const current = this.byId.get(messageId);
    if (current === undefined) return Promise.resolve();
    const next: SentMessageRef = { ...current, ...patch };
    this.byId.set(messageId, next);
    this.byProvider.set(`${next.hospitalId} ${next.providerMessageId}`, next);
    return Promise.resolve();
  }
}
