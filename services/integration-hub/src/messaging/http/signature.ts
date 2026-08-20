/**
 * Webhook signature verification — EN-009 §13 "webhook signature verification
 * (Meta X-Hub-Signature-256), IP allowlists".
 *
 * A delivery webhook is an unauthenticated public endpoint that mutates message
 * state and, for `STOP`, mutates the consent ledger. Without verification anyone
 * who learns the URL can mark a critical alert as delivered — which is worse
 * than a message not arriving, because the escalation ladder then stops.
 *
 * Every comparison is constant-time (`timingSafeEqual`). A `===` on a signature
 * leaks its prefix through timing, and that is enough to forge one given
 * patience; it costs nothing to do correctly.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // `timingSafeEqual` throws on a length mismatch, which is itself a timing
  // signal; hashing both sides to a fixed width removes it.
  if (left.length !== right.length) {
    const pad = createHmac('sha256', 'length-guard').update(left).digest();
    const other = createHmac('sha256', 'length-guard').update(right).digest();
    return timingSafeEqual(pad, other);
  }
  return timingSafeEqual(left, right);
}

/**
 * Meta's `X-Hub-Signature-256`: `sha256=` + HMAC-SHA256 of the **raw request
 * body** with the app secret. The raw bytes matter — re-serialising the parsed
 * JSON changes key order and whitespace and the signature never matches.
 */
export function verifyMetaSignature(input: {
  readonly rawBody: string;
  readonly header: string | undefined;
  readonly appSecret: string;
}): boolean {
  if (input.header === undefined) return false;
  const expected = `sha256=${createHmac('sha256', input.appSecret).update(input.rawBody, 'utf8').digest('hex')}`;
  return constantTimeEquals(expected, input.header.trim());
}

/**
 * Twilio's `X-Twilio-Signature`: base64 HMAC-SHA1 over the full request URL
 * concatenated with each POST parameter name and value, sorted by name.
 */
export function verifyTwilioSignature(input: {
  readonly url: string;
  readonly params: Readonly<Record<string, string>>;
  readonly header: string | undefined;
  readonly authToken: string;
}): boolean {
  if (input.header === undefined) return false;
  const payload = Object.keys(input.params)
    .sort()
    .reduce((acc, key) => `${acc}${key}${input.params[key] ?? ''}`, input.url);
  const expected = createHmac('sha1', input.authToken).update(payload, 'utf8').digest('base64');
  return constantTimeEquals(expected, input.header.trim());
}

/**
 * MSG91 publishes no webhook signature scheme.
 *
 * Saying so out loud is the point: the honest options are an IP allowlist at the
 * edge and a shared secret the hospital puts in the callback URL, and pretending
 * otherwise would leave an unauthenticated status endpoint looking verified. The
 * adapter therefore requires a configured shared token and compares it in
 * constant time; a connector configured without one is refused at registration.
 */
export function verifySharedToken(input: {
  readonly presented: string | undefined;
  readonly expected: string;
}): boolean {
  if (input.presented === undefined) return false;
  return constantTimeEquals(input.presented.trim(), input.expected);
}
