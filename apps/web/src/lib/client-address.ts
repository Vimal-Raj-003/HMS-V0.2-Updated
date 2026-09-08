/**
 * Which address to rate-limit a public caller against.
 *
 * ── Why the obvious answer is wrong ────────────────────────────────────────
 *
 * The first version of this took the left-most entry of `X-Forwarded-For`,
 * which is the answer every tutorial gives and is a rate-limit bypass. The
 * header is a list that each proxy *appends* to, so when an edge appends rather
 * than overwrites, a caller who sends
 *
 *     X-Forwarded-For: 203.0.113.<random>
 *
 * has the left-most entry under their complete control. A different value per
 * request means a different bucket per request, and the limiter — the only
 * thing standing between an anonymous internet caller and a metered language
 * model — counts to one, forever.
 *
 * ── What is actually trustworthy ───────────────────────────────────────────
 *
 * Only what a proxy we trust wrote, and only if we know how many such proxies
 * there are. Two supported ways to say so, both deployment configuration
 * because only the deployment knows its own topology:
 *
 *   `ASSISTANT_CLIENT_IP_HEADER` — the name of a header the edge *overwrites*
 *   rather than appends: `cf-connecting-ip` behind Cloudflare, `x-real-ip` from
 *   an Nginx `set_real_ip_from` allow-list with `real_ip_recursive off`,
 *   `x-vercel-forwarded-for` on Vercel. Preferred, because a header the edge
 *   always rewrites cannot carry a value the client chose.
 *
 *   `ASSISTANT_TRUSTED_PROXY_HOPS` — how many appending proxies sit in front.
 *   With N of them the last N entries were written by proxies we trust, and the
 *   outermost one wrote the real client's address at `length - N`. Anything
 *   further left was supplied by the caller and is ignored.
 *
 * ── And why the default is to trust nothing ────────────────────────────────
 *
 * Unconfigured, this returns `null` and no address is forwarded. Every public
 * visitor then shares one bucket at the API, which is restrictive — but the
 * failure is legitimate traffic being throttled, which somebody notices and
 * fixes, rather than the limiter silently not existing, which nobody notices
 * until the invoice. `docs/04` §6 asks for the safer behaviour when a control
 * cannot be evaluated, and this is it.
 */

export interface ClientAddressConfig {
  /** A header the edge overwrites. Case-insensitive. */
  readonly trustedHeader?: string | undefined;
  /** How many appending proxies sit in front of this process. */
  readonly trustedHops?: number | undefined;
}

/**
 * Reads the deployment's answer out of the environment.
 *
 * Typed as a bare string map rather than `NodeJS.ProcessEnv`, which this
 * project declares with a required `NODE_ENV`: only two keys are read, and a
 * test should be able to hand over exactly those two.
 */
export function clientAddressConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ClientAddressConfig {
  const header = env['ASSISTANT_CLIENT_IP_HEADER']?.trim();
  const hopsRaw = env['ASSISTANT_TRUSTED_PROXY_HOPS']?.trim();
  const hops = hopsRaw !== undefined && /^\d+$/u.test(hopsRaw) ? Number(hopsRaw) : 0;
  return {
    trustedHeader: header !== undefined && header !== '' ? header.toLowerCase() : undefined,
    trustedHops: hops,
  };
}

/**
 * The caller's address, or `null` when nothing about it can be trusted.
 *
 * `null` is a normal answer, not an error: it means "this deployment has not
 * said what is in front of it", and the caller of this function must then
 * forward no address at all rather than forwarding a guess.
 */
export function resolveClientAddress(headers: Headers, config: ClientAddressConfig): string | null {
  // 1. A header the edge overwrites. One value, and the client cannot set it,
  //    because whatever they sent was replaced before it reached us.
  if (config.trustedHeader !== undefined) {
    const value = headers.get(config.trustedHeader);
    if (value === null) return null;
    // Some edges still send a list here; the left-most is the edge's own answer
    // in that case, because the edge wrote the whole header.
    const first = value.split(',')[0]?.trim();
    return first !== undefined && first !== '' ? first : null;
  }

  // 2. Counted hops. The last N entries were written by proxies we trust, and
  //    the outermost of them recorded the real client.
  const hops = config.trustedHops ?? 0;
  if (hops <= 0) return null;

  const forwarded = headers.get('x-forwarded-for');
  if (forwarded === null) return null;

  const entries = forwarded
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');

  // Fewer entries than trusted hops means the chain is not what the deployment
  // described — a request that did not come through the expected path, or a
  // misconfiguration. Either way there is nothing here worth trusting.
  if (entries.length < hops) return null;

  return entries[entries.length - hops] ?? null;
}
