import { describe, expect, it } from 'vitest';
import { AppError } from '../../../core/problem/app-error.js';
import { escapeLike, resolveSearch } from './patient.search.service.js';

/**
 * The search router, tested for the property that matters and is invisible: that
 * each input lands on the predicate whose index was built for it.
 *
 * A wrong branch here still returns rows — it just returns them after scanning
 * three million, on the highest-traffic screen in the hospital. Nothing in
 * review or in an end-to-end test catches that; only asserting the predicate
 * does.
 */

function resolve(query: Parameters<typeof resolveSearch>[0]) {
  const values: unknown[] = [];
  const resolved = resolveSearch(query, (value) => `$${values.push(value)}`);
  return { ...resolved, values };
}

describe('search routing', () => {
  it('sends an explicit UHID to the prefix index, never to a trigram', () => {
    const result = resolve({ uhid: 'blr-a/000 0123' });
    expect(result.mode).toBe('uhid_prefix');
    expect(result.predicate).toContain('p.uhid_normalised LIKE');
    expect(result.values).toEqual(['BLRA0000123%']);
  });

  it('sends a complete mobile to the exact E.164 probe', () => {
    const result = resolve({ mobile: '98450 12345' });
    expect(result.mode).toBe('mobile_exact');
    expect(result.predicate).toBe('p.mobile = $1');
    expect(result.values).toEqual(['+919845012345']);
  });

  it('sends a partial mobile to the local prefix index', () => {
    const result = resolve({ mobile: '98450' });
    expect(result.mode).toBe('mobile_prefix');
    expect(result.predicate).toContain('p.mobile_local LIKE');
    expect(result.values).toEqual(['98450%']);
  });

  it('sends an ABHA number to the partial index in every spelling of it', () => {
    const result = resolve({ abha: '91123456789012' });
    expect(result.mode).toBe('abha_number');
    expect(result.predicate).toContain('p.abha_number IS NOT NULL');
    expect(result.predicate).toContain('= ANY(');
    expect(result.values[0]).toContain('91-1234-5678-9012');
  });

  it('sends an ABHA address to its own partial index', () => {
    const result = resolve({ abha: 'Asha.Rao001@sbx' });
    expect(result.mode).toBe('abha_address');
    expect(result.values).toEqual(['asha.rao001@sbx']);
  });

  it('sends an identifier to the identifier index by semi-join, not by OR', () => {
    const result = resolve({ identifier: 'p1234567' });
    expect(result.mode).toBe('identifier_prefix');
    expect(result.predicate).toContain('p.id IN (SELECT i.patient_id FROM patient.identifiers i');
    expect(result.predicate).not.toContain(' OR ');
    expect(result.values).toEqual(['P1234567%']);
  });

  it('sends a name to the trigram index', () => {
    const result = resolve({ q: 'Asha Rao' });
    expect(result.mode).toBe('name_trigram');
    expect(result.predicate).toBe('p.full_name % $1');
  });

  it('never produces a predicate that ORs two columns together', () => {
    // The whole design: one mode, one index. A disjunction across columns is
    // what makes PostgreSQL abandon all of them for a sequential scan.
    for (const query of [
      { uhid: 'BLR1' },
      { mobile: '98450' },
      { abha: '91123456789012' },
      { identifier: 'X99' },
      { q: 'Asha' },
      {},
    ]) {
      expect(resolve(query).predicate.split(' OR ')).toHaveLength(1);
    }
  });

  it('falls back to the recent-patients keyset when nothing was asked', () => {
    expect(resolve({}).mode).toBe('recent');
    expect(resolve({}).predicate).toBe('true');
  });
});

describe('the single search box classifies by shape', () => {
  it.each([
    ['asha.rao001@sbx', 'abha_address'],
    ['91123456789012', 'abha_number'],
    ['9845012345', 'mobile_exact'],
    ['98450', 'mobile_prefix'],
    ['BLRA0000123', 'uhid_prefix'],
    ['Asha Rao', 'name_trigram'],
  ])('routes %s to %s', (q, mode) => {
    expect(resolve({ q }).mode).toBe(mode);
  });

  it('separates a 14-digit ABHA from a 10-digit mobile by length alone', () => {
    // They cannot collide: a national mobile is at most 10 digits.
    expect(resolve({ q: '9845012345' }).mode).toBe('mobile_exact');
    expect(resolve({ q: '91123456789012' }).mode).toBe('abha_number');
  });
});

describe('refusals', () => {
  it('refuses a name search too short for a trigram rather than quietly scanning', () => {
    // `pg_trgm` needs three characters to produce a trigram; below that the `%`
    // operator cannot use the index and would scan the MPI.
    expect(() => resolve({ q: 'Li' })).toThrow(AppError);
    expect(() => resolve({ q: 'Lin' })).not.toThrow();
  });

  it('refuses a UHID that normalises to nothing', () => {
    expect(() => resolve({ uhid: '///' })).toThrow(AppError);
  });
});

describe('LIKE escaping', () => {
  it('neutralises the wildcards that would turn a prefix scan into a full one', () => {
    expect(escapeLike('100%')).toBe('100\\%');
    expect(escapeLike('a_b')).toBe('a\\_b');
    expect(escapeLike('c\\d')).toBe('c\\\\d');
  });

  it('is belt and braces: normalisation already strips the wildcards', () => {
    // Every path that reaches a `LIKE` runs its input through a normaliser that
    // keeps only A–Z, 0–9 and a couple of punctuation marks, so a `%` cannot
    // arrive there today. `escapeLike` is the guarantee that survives somebody
    // loosening a normaliser later, which is exactly the change that would not
    // look dangerous in review.
    expect(resolve({ mobile: '98%450' }).values).toEqual(['98450%']);
    expect(resolve({ uhid: 'BL%R' }).values).toEqual(['BLR%']);
  });
});
