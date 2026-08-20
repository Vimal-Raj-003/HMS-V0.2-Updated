/**
 * EN-009 §3.2.2 — the TRAI DLT template registry.
 *
 * ### What DLT actually does, and why this file is a gate rather than a lookup
 * Indian SMS is not delivered on the strength of a valid API call. Every
 * commercial sender registers a **principal entity id**, one or more 6-character
 * **headers** (sender ids), and every distinct **content template** with the
 * telecom operators' DLT platform. At delivery time the operator matches the
 * message body against the registered content, character for character, with
 * only the declared `{#var#}` slots free. A body that differs — an extra space,
 * a changed greeting, a full stop that moved — does not bounce, does not error,
 * and does not appear in any failure report. **It is silently dropped.** The
 * hospital's first evidence is a patient who says they were never told.
 *
 * `docs/08` §10.3 states the required behaviour plainly: "Unregistered template
 * = hard block on send (no silent drop)". So this registry refuses in three
 * places, in this order of severity:
 *
 *  1. **At registration, on content.** A template that would put a diagnosis, a
 *     drug or a result into an SMS is rejected before it exists — see
 *     `content-lint.ts` for why that is the only moment at which the rejection
 *     is worth anything.
 *  2. **At registration, on drift.** The body we will render must already equal
 *     the content the hospital registered on the DLT portal, with `{{n}}`
 *     standing exactly where `{#var#}` stands. A mismatch is reported as a diff
 *     with the offset, because "your template does not match" is not actionable
 *     and an engineer will simply re-paste the same text.
 *  3. **At send, on drift again.** Registration hashes the normalised body. The
 *     template master can be edited afterwards, and a hospital that fixes a typo
 *     in the Tamil greeting has, at that instant, unregistered the template
 *     without knowing it. So the send path re-hashes the *current* body and
 *     refuses on mismatch rather than emitting a message that will vanish.
 *
 * The registry additionally enforces the parts of TRAI's rules that are
 * invisible until a message disappears: the 30-character variable cap from the
 * 2024 traceability amendment, URL whitelisting (an unwhitelisted link
 * invalidates the whole message), and the header/category binding — a
 * promotional body sent from a service header is dropped by the operator even
 * though both are registered.
 */
import { createHash } from 'node:crypto';
import { MESSAGING_DEFAULT_LOCALE as DEFAULT_LOCALE } from './locales.js';
import { lintTemplateContent, lintVariableValue, type ContentLintFinding } from './content-lint.js';
import { bodyPlaceholderIndices, type TemplateVariable, type TemplateVersion } from './template-catalogue.js';
import {
  CLASS_TO_DLT_CATEGORIES,
  DLT_PLACEHOLDER,
  DLT_VARIABLE_MAX_LENGTH,
  type DltCategory,
  type LocaleCode,
  type MessageClass,
} from './types.js';

/** A 6-character header registered on the DLT portal, with the categories it may carry. */
export interface DltSenderId {
  readonly headerId: string;
  readonly categories: readonly DltCategory[];
}

/** The hospital's DLT principal-entity registration (EN-009 §3.1). */
export interface DltEntityConfig {
  readonly hospitalId: string;
  readonly entityId: string;
  readonly senderIds: readonly DltSenderId[];
  /**
   * Domains whitelisted on the DLT portal. TRAI's 2024 traceability rules drop
   * a message carrying any URL whose domain is not on this list.
   */
  readonly urlWhitelist: readonly string[];
}

export interface DltRegistrationInput {
  readonly hospitalId: string;
  readonly templateKey: string;
  readonly locale: LocaleCode;
  readonly messageClass: MessageClass;
  readonly dltCategory: DltCategory;
  readonly dltTemplateId: string;
  readonly headerId: string;
  /** The content as approved on the DLT portal, with `{#var#}` in each slot. */
  readonly registeredContent: string;
  /** Our body, with `{{1}}...{{n}}`. Must normalise to `registeredContent`. */
  readonly body: string;
  readonly variables: readonly TemplateVariable[];
}

export interface DltRegistration {
  readonly hospitalId: string;
  readonly templateKey: string;
  readonly locale: LocaleCode;
  readonly messageClass: MessageClass;
  readonly dltCategory: DltCategory;
  readonly dltTemplateId: string;
  readonly dltEntityId: string;
  readonly headerId: string;
  readonly registeredContent: string;
  readonly variables: readonly TemplateVariable[];
  /** sha256 of the registered content. What a send is checked against. */
  readonly contentHash: string;
  readonly registeredAt: Date;
  readonly status: 'dlt_registered';
}

export type DltIssueCode =
  | 'no_entity'
  | 'unknown_header'
  | 'header_category_mismatch'
  | 'class_category_mismatch'
  | 'clinical_content'
  | 'placeholder_mismatch'
  | 'content_drift'
  | 'variable_too_long'
  | 'url_not_whitelisted'
  | 'url_variable_undeclared';

export interface DltIssue {
  readonly code: DltIssueCode;
  readonly path: string;
  readonly message: string;
}

export type DltRegistrationResult =
  | { readonly ok: true; readonly registration: DltRegistration }
  | { readonly ok: false; readonly issues: readonly DltIssue[] };

export type DltSendRefusal =
  | 'template_unregistered'
  | 'template_drift'
  | 'variable_missing'
  | 'variable_too_long'
  | 'clinical_value'
  | 'url_not_whitelisted';

export type DltRenderResult =
  | {
      readonly ok: true;
      readonly body: string;
      readonly registration: DltRegistration;
      readonly parameters: readonly string[];
      readonly varsHash: string;
    }
  | { readonly ok: false; readonly reason: DltSendRefusal; readonly detail: string };

export interface DltRegistrationStore {
  putEntity(entity: DltEntityConfig): Promise<void>;
  getEntity(hospitalId: string): Promise<DltEntityConfig | undefined>;
  put(registration: DltRegistration): Promise<void>;
  get(hospitalId: string, templateKey: string, locale: LocaleCode): Promise<DltRegistration | undefined>;
  list(hospitalId: string): Promise<readonly DltRegistration[]>;
}

function registrationKey(hospitalId: string, templateKey: string, locale: LocaleCode): string {
  return `${hospitalId} ${templateKey} ${locale}`;
}

export class InMemoryDltRegistrationStore implements DltRegistrationStore {
  private readonly entities = new Map<string, DltEntityConfig>();
  private readonly registrations = new Map<string, DltRegistration>();

  putEntity(entity: DltEntityConfig): Promise<void> {
    this.entities.set(entity.hospitalId, entity);
    return Promise.resolve();
  }

  getEntity(hospitalId: string): Promise<DltEntityConfig | undefined> {
    return Promise.resolve(this.entities.get(hospitalId));
  }

  put(registration: DltRegistration): Promise<void> {
    this.registrations.set(
      registrationKey(registration.hospitalId, registration.templateKey, registration.locale),
      registration,
    );
    return Promise.resolve();
  }

  get(hospitalId: string, templateKey: string, locale: LocaleCode): Promise<DltRegistration | undefined> {
    return Promise.resolve(this.registrations.get(registrationKey(hospitalId, templateKey, locale)));
  }

  list(hospitalId: string): Promise<readonly DltRegistration[]> {
    return Promise.resolve([...this.registrations.values()].filter((r) => r.hospitalId === hospitalId));
  }
}

/** `{{1}}` -> `{#var#}`. The one transformation that makes the two texts comparable. */
export function normaliseToDltContent(body: string): string {
  return body.replace(/\{\{\d+\}\}/g, DLT_PLACEHOLDER);
}

export function dltContentHash(registeredContent: string): string {
  return createHash('sha256').update(registeredContent, 'utf8').digest('hex');
}

/**
 * The first character at which two strings differ, with context.
 *
 * "Content does not match the DLT registration" sends an engineer to re-paste
 * the same text. "Differs at offset 41: expected `.` got `!`" is fixed in
 * fifteen seconds. EN-009 §14.1 requires the diff, and this is it.
 */
export function describeContentDrift(expected: string, actual: string): string {
  const limit = Math.min(expected.length, actual.length);
  let index = 0;
  while (index < limit && expected[index] === actual[index]) index += 1;

  if (index === limit && expected.length === actual.length) return 'identical';

  const from = Math.max(0, index - 24);
  const context = (text: string): string => {
    const slice = text.slice(from, index + 24);
    return `${from > 0 ? '...' : ''}${slice}${index + 24 < text.length ? '...' : ''}`;
  };
  const charAt = (text: string): string => (index < text.length ? JSON.stringify(text[index]) : '(end of text)');

  return `differs at offset ${String(index)}: DLT-registered content has ${charAt(expected)}, the template body has ${charAt(
    actual,
  )}\n  registered: ${context(expected)}\n  template:   ${context(actual)}`;
}

const URL_RE = /https?:\/\/[^\s<>"']+/gi;

function hostsIn(text: string): readonly string[] {
  const hosts: string[] = [];
  const re = new RegExp(URL_RE.source, URL_RE.flags);
  let match = re.exec(text);
  while (match !== null) {
    try {
      hosts.push(new URL(match[0]).hostname.toLowerCase());
    } catch {
      // A malformed URL cannot be whitelisted, so it is reported by hostname `?`
      // rather than silently ignored.
      hosts.push('?');
    }
    match = re.exec(text);
  }
  return hosts;
}

function isWhitelisted(host: string, whitelist: readonly string[]): boolean {
  const needle = host.toLowerCase();
  return whitelist.some((entry) => {
    const domain = entry.toLowerCase().replace(/^\*\./, '');
    return needle === domain || needle.endsWith(`.${domain}`);
  });
}

export interface DltRegistryDeps {
  readonly store: DltRegistrationStore;
  readonly clock: { now(): Date };
}

export class DltTemplateRegistry {
  constructor(private readonly deps: DltRegistryDeps) {}

  async configureEntity(entity: DltEntityConfig): Promise<void> {
    await this.deps.store.putEntity(entity);
  }

  async getEntity(hospitalId: string): Promise<DltEntityConfig | undefined> {
    return this.deps.store.getEntity(hospitalId);
  }

  /**
   * Registers one language variant of one template against the hospital's DLT
   * entity. Every issue is collected rather than thrown one at a time, matching
   * `validateConnectorConfig`, so the Template Studio can highlight all of them
   * at once instead of making an engineer discover them serially.
   */
  async register(input: DltRegistrationInput): Promise<DltRegistrationResult> {
    const issues: DltIssue[] = [];

    const entity = await this.deps.store.getEntity(input.hospitalId);
    if (entity === undefined) {
      return {
        ok: false,
        issues: [
          {
            code: 'no_entity',
            path: 'hospital',
            message:
              'this hospital has no DLT principal-entity registration. Until the entity id, headers and URL whitelist are recorded, no SMS template can be registered and no SMS can be sent (docs/08 §10.3).',
          },
        ],
      };
    }

    // ── 1. content: the rejection that has to happen here or nowhere ──────────
    const lint: readonly ContentLintFinding[] = lintTemplateContent({
      body: input.body,
      registeredContent: input.registeredContent,
      variables: input.variables.map((v) => ({
        index: v.index,
        name: v.name,
        type: v.type,
        maxLength: v.maxLength,
      })),
    });
    for (const finding of lint) {
      issues.push({
        code: finding.code === 'variable_too_long' ? 'variable_too_long' : 'clinical_content',
        path: finding.path,
        message: `${finding.message} (matched: ${JSON.stringify(finding.evidence)})`,
      });
    }

    // ── 2. header and category ────────────────────────────────────────────────
    const sender = entity.senderIds.find((s) => s.headerId === input.headerId);
    if (sender === undefined) {
      issues.push({
        code: 'unknown_header',
        path: 'headerId',
        message: `header '${input.headerId}' is not registered for DLT entity ${entity.entityId}. Registered: ${
          entity.senderIds.map((s) => s.headerId).join(', ') || '(none)'
        }`,
      });
    } else if (!sender.categories.includes(input.dltCategory)) {
      issues.push({
        code: 'header_category_mismatch',
        path: 'headerId',
        message: `header '${input.headerId}' is registered for ${sender.categories.join(
          '/',
        )} traffic, not '${input.dltCategory}'. The operator drops a message whose header and category disagree.`,
      });
    }

    const allowed = CLASS_TO_DLT_CATEGORIES[input.messageClass];
    if (!allowed.includes(input.dltCategory)) {
      issues.push({
        code: 'class_category_mismatch',
        path: 'dltCategory',
        message: `a '${input.messageClass}' template may be registered as ${allowed.join(
          ' or ',
        )}, not '${input.dltCategory}'. Registering a reminder under a category that skips the consent rule is the abuse the categories exist to prevent.`,
      });
    }

    // ── 3. placeholders line up with the declared variables ───────────────────
    const bodyIndices = bodyPlaceholderIndices(input.body);
    const declaredIndices = [...input.variables].map((v) => v.index).sort((a, b) => a - b);
    const registeredSlots = input.registeredContent.split(DLT_PLACEHOLDER).length - 1;

    if (bodyIndices.join(',') !== declaredIndices.join(',')) {
      issues.push({
        code: 'placeholder_mismatch',
        path: 'variables',
        message: `the body uses placeholders {${bodyIndices.join(',')}} but the template declares variables {${declaredIndices.join(
          ',',
        )}}`,
      });
    }
    if (registeredSlots !== bodyIndices.length) {
      issues.push({
        code: 'placeholder_mismatch',
        path: 'registeredContent',
        message: `the DLT-registered content has ${String(registeredSlots)} ${DLT_PLACEHOLDER} slot(s) but the body has ${String(
          bodyIndices.length,
        )} placeholder(s)`,
      });
    }

    // ── 4. drift: the body must already be the registered content ─────────────
    const normalised = normaliseToDltContent(input.body);
    if (normalised !== input.registeredContent) {
      issues.push({
        code: 'content_drift',
        path: 'body',
        message: `the rendered template does not equal the DLT-registered content, so the operator would drop every message silently. ${describeContentDrift(
          input.registeredContent,
          normalised,
        )}`,
      });
    }

    // ── 5. URL whitelist ──────────────────────────────────────────────────────
    for (const host of hostsIn(input.registeredContent)) {
      if (!isWhitelisted(host, entity.urlWhitelist)) {
        issues.push({
          code: 'url_not_whitelisted',
          path: 'registeredContent',
          message: `the URL host '${host}' is not on this hospital's DLT URL whitelist. TRAI's 2024 traceability rules drop the whole message, not just the link.`,
        });
      }
    }
    for (const variable of input.variables) {
      if (variable.type !== 'url') continue;
      const domains = variable.allowedUrlDomains ?? [];
      if (domains.length === 0) {
        issues.push({
          code: 'url_variable_undeclared',
          path: `variables.${String(variable.index)}`,
          message: `variable '${variable.name}' is a URL but declares no allowed domains, so nothing could be checked against the DLT whitelist at send time.`,
        });
        continue;
      }
      for (const domain of domains) {
        if (!isWhitelisted(domain, entity.urlWhitelist)) {
          issues.push({
            code: 'url_not_whitelisted',
            path: `variables.${String(variable.index)}`,
            message: `variable '${variable.name}' may resolve to '${domain}', which is not on this hospital's DLT URL whitelist.`,
          });
        }
      }
    }

    if (issues.length > 0) return { ok: false, issues };

    const registration: DltRegistration = {
      hospitalId: input.hospitalId,
      templateKey: input.templateKey,
      locale: input.locale,
      messageClass: input.messageClass,
      dltCategory: input.dltCategory,
      dltTemplateId: input.dltTemplateId,
      dltEntityId: entity.entityId,
      headerId: input.headerId,
      registeredContent: input.registeredContent,
      variables: input.variables,
      contentHash: dltContentHash(input.registeredContent),
      registeredAt: this.deps.clock.now(),
      status: 'dlt_registered',
    };
    await this.deps.store.put(registration);
    return { ok: true, registration };
  }

  /**
   * The registration for a template in a locale, falling back to `en-IN` the
   * same way the template catalogue does — a Tamil send that fell back to the
   * English body must also use the English body's DLT template id.
   */
  async lookup(
    hospitalId: string,
    templateKey: string,
    locale: LocaleCode,
  ): Promise<DltRegistration | undefined> {
    const exact = await this.deps.store.get(hospitalId, templateKey, locale);
    if (exact !== undefined) return exact;
    if (locale === DEFAULT_LOCALE) return undefined;
    return this.deps.store.get(hospitalId, templateKey, DEFAULT_LOCALE);
  }

  /**
   * The send gate. Refuses rather than rendering when the template is
   * unregistered, when the current body no longer matches what was registered,
   * or when a supplied value would break a TRAI rule.
   */
  async renderForSend(input: {
    readonly template: TemplateVersion;
    readonly locale: LocaleCode;
    readonly values: Readonly<Record<string, string>>;
  }): Promise<DltRenderResult> {
    const registration = await this.lookup(input.template.hospitalId, input.template.key, input.locale);
    if (registration === undefined) {
      return {
        ok: false,
        reason: 'template_unregistered',
        detail: `SMS template '${input.template.key}' (${input.locale}) has no TRAI DLT registration. An unregistered template is dropped by the operator without an error, so the send is refused instead (docs/08 §10.3).`,
      };
    }

    // Drift, checked again against the *current* body: registration happened at
    // 16:00 six weeks ago and the template master has been editable ever since.
    const currentHash = dltContentHash(normaliseToDltContent(input.template.body));
    if (currentHash !== registration.contentHash) {
      return {
        ok: false,
        reason: 'template_drift',
        detail: `template '${input.template.key}' (${input.locale}) has been edited since it was registered with DLT template id ${registration.dltTemplateId}. ${describeContentDrift(
          registration.registeredContent,
          normaliseToDltContent(input.template.body),
        )}`,
      };
    }

    const parameters: string[] = [];
    for (const variable of registration.variables) {
      const value = input.values[variable.name];
      if (value === undefined) {
        return {
          ok: false,
          reason: 'variable_missing',
          detail: `no value supplied for template variable '${variable.name}' ({{${String(variable.index)}}})`,
        };
      }
      const cap = Math.min(variable.maxLength, DLT_VARIABLE_MAX_LENGTH);
      if ([...value].length > cap) {
        return {
          ok: false,
          reason: 'variable_too_long',
          detail: `value for '${variable.name}' is ${String(
            [...value].length,
          )} characters; TRAI caps a DLT variable at ${String(cap)}. A longer value is truncated or dropped by the carrier with no error (EN-009 §14.10).`,
        };
      }
      const findings = lintVariableValue(variable.name, value);
      const first = findings[0];
      if (first !== undefined) {
        return {
          ok: false,
          reason: 'clinical_value',
          detail: `${first.message} (matched: ${JSON.stringify(first.evidence)})`,
        };
      }
      if (variable.type === 'url') {
        const domains = variable.allowedUrlDomains ?? [];
        for (const host of hostsIn(value)) {
          if (!isWhitelisted(host, domains)) {
            return {
              ok: false,
              reason: 'url_not_whitelisted',
              detail: `the link supplied for '${variable.name}' points at '${host}', which the template does not declare and the DLT whitelist does not cover.`,
            };
          }
        }
      }
      parameters.push(value);
    }

    const body = input.template.body.replace(/\{\{(\d+)\}\}/g, (_match, digits: string) => {
      const index = Number.parseInt(digits, 10);
      const variable = registration.variables.find((v) => v.index === index);
      if (variable === undefined) return '';
      return input.values[variable.name] ?? '';
    });

    return { ok: true, body, registration, parameters, varsHash: hashValues(input.values) };
  }
}

/**
 * EN-009 §4 `msg_messages.vars_hash`: enough to prove two messages carried the
 * same values, carrying none of them.
 */
export function hashValues(values: Readonly<Record<string, string>>): string {
  const canonical = Object.keys(values)
    .sort()
    .map((key) => `${key}=${values[key] ?? ''}`)
    .join(' ');
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 32);
}
