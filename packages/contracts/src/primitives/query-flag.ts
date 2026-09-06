import { z } from 'zod';

/**
 * A boolean query-string parameter that reads `?flag=false` as **false**.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * `z.coerce.boolean()` is `Boolean(value)`, and `Boolean("false")` is `true`.
 * Every non-empty string is truthy, so a schema written as
 *
 *     includeDeparted: z.coerce.boolean().default(false)
 *
 * accepts `?includeDeparted=false` and returns `true`. The default masks it:
 * the flag behaves correctly when the client omits the parameter and inverts the
 * moment the client sends it explicitly, which is exactly what a checkbox bound
 * to a query string does. It shipped that way in eight files here, and the way
 * it surfaced was an ER board showing departed patients with "show departed"
 * unticked — a board that quietly overstates how full the department is.
 *
 * ── What it accepts ─────────────────────────────────────────────────────────
 *
 * The four spellings a URL actually carries, in either case: `true`/`false`,
 * `1`/`0`, `yes`/`no`, `on`/`off`. A bare `?flag` (empty value) means true,
 * because that is what an HTML form sends for a ticked checkbox with no value
 * attribute. Anything else is rejected with a message naming the parameter,
 * rather than being silently read as true — a typo in a filter should be a 400,
 * not a different result set.
 */
const TRUE_SPELLINGS = new Set(['true', '1', 'yes', 'on', '']);
const FALSE_SPELLINGS = new Set(['false', '0', 'no', 'off']);

export function queryFlag(): z.ZodType<boolean | undefined, unknown> {
  return z.preprocess((value) => {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value !== 'string') return value;

    const normalised = value.trim().toLowerCase();
    if (TRUE_SPELLINGS.has(normalised)) return true;
    if (FALSE_SPELLINGS.has(normalised)) return false;
    // Left as-is so the boolean schema rejects it and the caller is told which
    // parameter was wrong, instead of the typo becoming `true`.
    return value;
  }, z.boolean().optional());
}
