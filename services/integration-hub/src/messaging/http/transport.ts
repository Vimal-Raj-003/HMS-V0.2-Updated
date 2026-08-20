/**
 * The one seam that makes an HTTP adapter testable without a network.
 *
 * `docs/09` §2 and the task's own rule: no live network calls in a test. The
 * null/echo reference adapter is testable because it has no transport at all;
 * MSG91, Twilio and the WhatsApp Cloud API do, so the transport is injected into
 * the *factory* rather than reached for inside `send()`. Production wires
 * `fetchHttpTransport()`; tests wire `FakeHttpTransport`, which records what
 * would have gone out and answers with whatever the case under test needs.
 *
 * The interface is deliberately smaller than `fetch`: string bodies only, no
 * streaming, no redirects to follow. Everything these three providers do is a
 * form or JSON POST and a small JSON response, and a narrower surface is a
 * narrower fake.
 */

export interface HttpRequest {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface HttpTransport {
  send(request: HttpRequest, timeoutMs: number): Promise<HttpResponse>;
}

/**
 * A transport failure the adapter can classify without inspecting an exception
 * type it did not throw. `kind` maps straight onto `ErrorClass`.
 */
export class HttpTransportError extends Error {
  constructor(
    readonly kind: 'timeout' | 'network',
    message: string,
  ) {
    super(message);
    this.name = 'HttpTransportError';
  }
}

/** The production transport. Uses the platform `fetch`; adds no retry of its own. */
export function fetchHttpTransport(): HttpTransport {
  return {
    async send(request: HttpRequest, timeoutMs: number): Promise<HttpResponse> {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, timeoutMs);
      try {
        const response = await fetch(request.url, {
          method: request.method,
          headers: { ...request.headers },
          ...(request.body === undefined ? {} : { body: request.body }),
          signal: controller.signal,
          redirect: 'error',
        });
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          headers[key.toLowerCase()] = value;
        });
        return { status: response.status, headers, body: await response.text() };
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw new HttpTransportError('timeout', `request timed out after ${String(timeoutMs)} ms`);
        }
        throw new HttpTransportError('network', error instanceof Error ? error.message : 'network failure');
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export interface FakeExchange {
  /** Substring or regular expression matched against the request URL. */
  readonly match: string | RegExp;
  readonly response?: HttpResponse;
  /** Thrown instead of answering, to exercise the network/timeout paths. */
  readonly failWith?: HttpTransportError;
  /** How many times this rule applies before falling through. Default: unlimited. */
  readonly times?: number;
}

/**
 * The test transport. Deterministic, records every request, and refuses an
 * unmatched call loudly — a fake that silently returns 200 for a URL nobody
 * programmed is how an adapter passes its tests while calling the wrong endpoint.
 */
export class FakeHttpTransport implements HttpTransport {
  readonly requests: HttpRequest[] = [];
  private readonly rules: { exchange: FakeExchange; used: number }[] = [];

  constructor(exchanges: readonly FakeExchange[] = []) {
    for (const exchange of exchanges) this.rules.push({ exchange, used: 0 });
  }

  on(exchange: FakeExchange): this {
    this.rules.push({ exchange, used: 0 });
    return this;
  }

  /**
   * Forgets the recorded requests **and** the programmed rules.
   *
   * Keeping the rules and only resetting their counters looks tidier and is a
   * trap: a suite that programs a 400 in one test and a 200 in the next then
   * matches the stale 400 first, and the second test silently exercises the
   * first test's failure path. That was found here, by an integration test that
   * asked for WhatsApp and got the SMS fallback.
   */
  reset(): void {
    this.requests.length = 0;
    this.rules.length = 0;
  }

  send(request: HttpRequest, _timeoutMs: number): Promise<HttpResponse> {
    this.requests.push(request);
    for (const rule of this.rules) {
      const { match, times } = rule.exchange;
      const matches = typeof match === 'string' ? request.url.includes(match) : match.test(request.url);
      if (!matches) continue;
      if (times !== undefined && rule.used >= times) continue;
      rule.used += 1;
      if (rule.exchange.failWith !== undefined) return Promise.reject(rule.exchange.failWith);
      if (rule.exchange.response !== undefined) return Promise.resolve(rule.exchange.response);
    }
    return Promise.reject(
      new Error(`FakeHttpTransport: no programmed response for ${request.method} ${request.url}`),
    );
  }
}

/** Convenience for the common case. */
export function jsonResponse(status: number, body: unknown): HttpResponse {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}
