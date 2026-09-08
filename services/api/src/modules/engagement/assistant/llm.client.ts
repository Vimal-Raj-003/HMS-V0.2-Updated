import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENV, type Env } from '../../../core/config/env.js';

/**
 * PE-009 · A model client that is allowed to be absent.
 *
 * DeepSeek's API is OpenAI-shaped, and so is nearly every other one worth
 * pointing this at — including a model running inside a hospital's own network,
 * which for an on-prem deployment is frequently the only acceptable place for
 * a patient's words to go. So this speaks `POST {base}/chat/completions` and
 * has no vendor name in it beyond a default model string.
 *
 * ── Absence is a supported configuration, not a failure ────────────────────
 *
 * `isConfigured` is false when no key is set, and the service then answers from
 * the hospital's own directory instead. That is not a degraded mode bolted on
 * for tests: a hospital that has not bought a model subscription still gets a
 * working assistant, and a hospital that has still gets one on the morning the
 * vendor is down.
 *
 * ── What is not sent ───────────────────────────────────────────────────────
 *
 * No patient identifier, no UHID, no appointment, no row from any clinical
 * table. The grounding handed to the model is the hospital's public directory —
 * the same specialities and consultants it prints on a board in the lobby,
 * filtered by the `website_visible` flags that already exist in `mdm`.
 */

export interface ChatTurn {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

@Injectable()
export class LlmClient {
  private readonly log = new Logger(LlmClient.name);

  constructor(@Inject(ENV) private readonly env: Env) {}

  get isConfigured(): boolean {
    return this.env.ASSISTANT_LLM_BASE_URL !== undefined && this.env.ASSISTANT_LLM_API_KEY !== undefined;
  }

  /** The model's reply, or `null` for every failure. A landing page does not 500. */
  async complete(messages: readonly ChatTurn[]): Promise<string | null> {
    const base = this.env.ASSISTANT_LLM_BASE_URL;
    const key = this.env.ASSISTANT_LLM_API_KEY;
    if (base === undefined || key === undefined) return null;

    // `AbortSignal.timeout` rather than a race: it cancels the socket instead of
    // leaving the request running with nobody waiting for it.
    const signal = AbortSignal.timeout(this.env.ASSISTANT_LLM_TIMEOUT_MS);

    try {
      const response = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: this.env.ASSISTANT_LLM_MODEL,
          messages,
          // Low, not zero. This answers factual questions about a hospital, and
          // an invented consultant is the failure that matters here.
          temperature: 0.2,
          max_tokens: 400,
          stream: false,
        }),
      });

      if (!response.ok) {
        // The body may quote the prompt back, and the prompt contains whatever
        // the visitor typed. Status only.
        this.log.warn(`assistant model returned ${String(response.status)}`);
        return null;
      }

      const payload: unknown = await response.json();
      const text = readFirstChoice(payload);
      if (text === null) {
        this.log.warn('assistant model returned an unreadable body');
        return null;
      }
      return text;
    } catch (error) {
      // Timeouts and DNS failures are ordinary here. Never the message body:
      // a fetch error can carry the request, and the request carries the
      // visitor's words (docs/04 §7 — no PHI in logs).
      this.log.warn(`assistant model unreachable: ${error instanceof Error ? error.name : 'unknown'}`);
      return null;
    }
  }
}

/**
 * Reads `choices[0].message.content` without trusting any of it.
 *
 * The response is a third party's JSON. Typing it as an interface and indexing
 * straight in would be a lie the compiler cannot catch, so every hop is checked.
 */
function readFirstChoice(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const choices = (payload as Record<string, unknown>)['choices'];
  if (!Array.isArray(choices) || choices.length === 0) return null;

  const first: unknown = choices[0];
  if (typeof first !== 'object' || first === null) return null;

  const message = (first as Record<string, unknown>)['message'];
  if (typeof message !== 'object' || message === null) return null;

  const content = (message as Record<string, unknown>)['content'];
  if (typeof content !== 'string') return null;

  const trimmed = content.trim();
  return trimmed.length === 0 ? null : trimmed;
}
