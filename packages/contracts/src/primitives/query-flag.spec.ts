import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { queryFlag } from './query-flag.js';

const schema = z.object({ includeClosed: queryFlag().default(false) });

describe('queryFlag', () => {
  /**
   * The bug this primitive exists for. `z.coerce.boolean()` is `Boolean(value)`,
   * and every non-empty string is truthy — so the string "false" arrived as
   * `true` and a board showed rows the user had just unticked.
   */
  it('reads the string "false" as false, which z.coerce.boolean does not', () => {
    expect(schema.parse({ includeClosed: 'false' }).includeClosed).toBe(false);
    // The behaviour being replaced, asserted so nobody reintroduces it:
    expect(z.coerce.boolean().parse('false')).toBe(true);
  });

  it('accepts the spellings a URL actually carries', () => {
    for (const truthy of ['true', 'TRUE', '1', 'yes', 'on', 'True']) {
      expect(schema.parse({ includeClosed: truthy }).includeClosed, truthy).toBe(true);
    }
    for (const falsy of ['false', 'FALSE', '0', 'no', 'off', ' False ']) {
      expect(schema.parse({ includeClosed: falsy }).includeClosed, falsy).toBe(false);
    }
  });

  /** A ticked checkbox with no value attribute sends the bare key. */
  it('treats a bare parameter as true', () => {
    expect(schema.parse({ includeClosed: '' }).includeClosed).toBe(true);
  });

  it('falls back to the default when the parameter is absent', () => {
    expect(schema.parse({}).includeClosed).toBe(false);
    expect(z.object({ f: queryFlag().default(true) }).parse({}).f).toBe(true);
  });

  it('passes actual booleans and numbers through', () => {
    expect(schema.parse({ includeClosed: true }).includeClosed).toBe(true);
    expect(schema.parse({ includeClosed: 0 }).includeClosed).toBe(false);
    expect(schema.parse({ includeClosed: 2 }).includeClosed).toBe(true);
  });

  /**
   * A typo in a filter should be a 400, not a different result set. This is the
   * half of the old behaviour that was actively dangerous: `?deniedOnly=treu`
   * silently returned the denied-only audit view.
   */
  it('rejects a spelling it does not recognise rather than guessing true', () => {
    expect(() => schema.parse({ includeClosed: 'treu' })).toThrow();
    expect(() => schema.parse({ includeClosed: 'maybe' })).toThrow();
  });
});
