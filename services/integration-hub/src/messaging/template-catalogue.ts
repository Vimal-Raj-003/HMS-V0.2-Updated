/**
 * EN-009 §3.2 / §4 — the template master, with language variants.
 *
 * The single rule that makes this more than a map: **resolution falls back to
 * `en-IN` and nothing else.** `@vims/i18n` fixes the locale superset (decision
 * D-13) and states the invariant — "`en-IN` is always present, always complete,
 * and is the fallback for every other locale". A Tamil hospital that has not yet
 * translated `appointment_reminder_2h` must still send the reminder; it must not
 * send a raw key, and it must not silently pick Hindi because the two happen to
 * be adjacent in a list.
 *
 * Resolution returns *which* locale it landed on, because the caller needs it
 * for three separate reasons: the DLT registration is per language (a Tamil body
 * needs a Tamil DLT template id), the WhatsApp language code is per language,
 * and the segment count — and therefore the cost — changes completely between a
 * GSM-7 English body and a UCS-2 Tamil one.
 *
 * The store is an interface with an in-memory implementation, exactly as
 * `PayloadStore` is: EN-009 §4 defines `msg_templates` / `msg_template_versions`
 * in the `engage` schema, which is a Phase-10 schema that does not exist yet, so
 * the durable implementation lands with it and the contract is written now so
 * the send path is not retrofitted later.
 */
import { MESSAGING_DEFAULT_LOCALE as DEFAULT_LOCALE } from './locales.js';
import {
  BODY_PLACEHOLDER_RE,
  type LocaleCode,
  type MessageChannel,
  type MessageClass,
  type TemplateVariableType,
  type WhatsAppCategory,
} from './types.js';

export interface TemplateVariable {
  /** 1-based, matching `{{1}}` in the body and the `{#var#}` position on the DLT portal. */
  readonly index: number;
  readonly name: string;
  readonly type: TemplateVariableType;
  /** TRAI caps this at 30; the registry refuses a larger declaration. */
  readonly maxLength: number;
  readonly sample: string;
  /** Required for a `url` variable: the domains it may resolve to, all DLT-whitelisted. */
  readonly allowedUrlDomains?: readonly string[];
}

/** Meta template lifecycle (EN-009 §3.2.3). Only `approved` is sendable. */
export type WhatsAppTemplateStatus = 'draft' | 'pending' | 'approved' | 'rejected' | 'paused' | 'disabled';

export interface WhatsAppTemplateBinding {
  readonly templateName: string;
  /** Meta's own language tag (`en`, `ta`, `hi_IN`), which is not a BCP-47 tag. */
  readonly languageCode: string;
  readonly category: WhatsAppCategory;
  readonly status: WhatsAppTemplateStatus;
  readonly rejectionReason?: string;
  /** Number of dynamic URL-button suffixes the approved template declares. */
  readonly urlButtonParameters?: number;
}

export interface TemplateVersion {
  readonly hospitalId: string;
  readonly key: string;
  readonly locale: LocaleCode;
  readonly channel: MessageChannel;
  readonly messageClass: MessageClass;
  readonly version: number;
  /** Body with `{{1}}...{{n}}` placeholders. */
  readonly body: string;
  readonly variables: readonly TemplateVariable[];
  readonly ttlSeconds: number;
  readonly ownerModule: string;
  readonly whatsapp?: WhatsAppTemplateBinding;
}

export type TemplateResolution =
  | {
      readonly ok: true;
      readonly template: TemplateVersion;
      readonly requestedLocale: LocaleCode;
      readonly resolvedLocale: LocaleCode;
      /** True when the requested language had no variant and `en-IN` was used. */
      readonly fellBackToDefault: boolean;
    }
  | { readonly ok: false; readonly reason: 'no_template'; readonly detail: string };

export interface TemplateStore {
  put(template: TemplateVersion): Promise<void>;
  get(
    hospitalId: string,
    key: string,
    channel: MessageChannel,
    locale: LocaleCode,
  ): Promise<TemplateVersion | undefined>;
  list(hospitalId: string, key?: string): Promise<readonly TemplateVersion[]>;
}

function storeKey(hospitalId: string, key: string, channel: MessageChannel, locale: LocaleCode): string {
  return `${hospitalId} ${key} ${channel} ${locale}`;
}

export class InMemoryTemplateStore implements TemplateStore {
  private readonly items = new Map<string, TemplateVersion>();

  put(template: TemplateVersion): Promise<void> {
    this.items.set(storeKey(template.hospitalId, template.key, template.channel, template.locale), template);
    return Promise.resolve();
  }

  get(
    hospitalId: string,
    key: string,
    channel: MessageChannel,
    locale: LocaleCode,
  ): Promise<TemplateVersion | undefined> {
    return Promise.resolve(this.items.get(storeKey(hospitalId, key, channel, locale)));
  }

  list(hospitalId: string, key?: string): Promise<readonly TemplateVersion[]> {
    const out = [...this.items.values()].filter(
      (t) => t.hospitalId === hospitalId && (key === undefined || t.key === key),
    );
    return Promise.resolve(out);
  }
}

export class TemplateCatalogue {
  constructor(private readonly store: TemplateStore) {}

  async register(template: TemplateVersion): Promise<void> {
    await this.store.put(template);
  }

  /**
   * EN-009 §5: "No send without an active template version for the channel/
   * language (falls back to `en`)".
   */
  async resolve(
    hospitalId: string,
    key: string,
    channel: MessageChannel,
    locale: LocaleCode,
  ): Promise<TemplateResolution> {
    const exact = await this.store.get(hospitalId, key, channel, locale);
    if (exact !== undefined) {
      return {
        ok: true,
        template: exact,
        requestedLocale: locale,
        resolvedLocale: locale,
        fellBackToDefault: false,
      };
    }

    if (locale !== DEFAULT_LOCALE) {
      const fallback = await this.store.get(hospitalId, key, channel, DEFAULT_LOCALE);
      if (fallback !== undefined) {
        return {
          ok: true,
          template: fallback,
          requestedLocale: locale,
          resolvedLocale: DEFAULT_LOCALE,
          fellBackToDefault: true,
        };
      }
    }

    return {
      ok: false,
      reason: 'no_template',
      detail: `no '${channel}' template '${key}' in ${locale} and no ${DEFAULT_LOCALE} fallback for this hospital`,
    };
  }
}

/** The `{{n}}` indices a body actually uses, in ascending order, de-duplicated. */
export function bodyPlaceholderIndices(body: string): readonly number[] {
  const found = new Set<number>();
  const re = new RegExp(BODY_PLACEHOLDER_RE.source, 'g');
  let match = re.exec(body);
  while (match !== null) {
    const raw = match[1];
    if (raw !== undefined) found.add(Number.parseInt(raw, 10));
    match = re.exec(body);
  }
  return [...found].sort((a, b) => a - b);
}
