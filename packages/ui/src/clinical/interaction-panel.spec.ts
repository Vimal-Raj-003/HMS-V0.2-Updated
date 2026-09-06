import { describe, expect, it } from 'vitest';
import { sortInteractionsBySeverity, type InteractionItem } from './interaction-panel.js';

/**
 * The ordering is a safety property, so it is asserted rather than assumed.
 *
 * docs/06 §5.2 #17 says "severity-sorted (contraindicated → major → moderate →
 * minor)". A prescriber reads down the list and stops when they have seen
 * enough, so a moderate interaction sorting above a contraindicated one buries
 * the one thing the panel exists to surface. The component therefore sorts
 * internally and never trusts the order it was handed.
 */

const item = (id: string, severity: InteractionItem['severity'], title = id): InteractionItem => ({
  id,
  severity,
  interruption: 'passive',
  title,
  mechanism: 'm',
  management: 'a',
  ruleId: 'R-1',
});

describe('InteractionPanel ordering — docs/06 §5.2 #17', () => {
  it('puts contraindicated first however the caller ordered them', () => {
    const sorted = sortInteractionsBySeverity([
      item('d', 'info'),
      item('c', 'moderate'),
      item('b', 'major'),
      item('a', 'contraindicated'),
    ]);
    expect(sorted.map((i) => i.severity)).toEqual(['contraindicated', 'major', 'moderate', 'info']);
  });

  it('orders every severity by clinical urgency, not alphabetically', () => {
    // 'contraindicated' < 'info' < 'low' < 'major' < 'moderate' alphabetically,
    // which would put the two most serious bands in the wrong places. This is
    // the assertion that fails if the rank map is ever replaced by a sort on the
    // label.
    const sorted = sortInteractionsBySeverity([
      item('1', 'low'),
      item('2', 'info'),
      item('3', 'contraindicated'),
      item('4', 'moderate'),
      item('5', 'major'),
    ]);
    expect(sorted.map((i) => i.severity)).toEqual(['contraindicated', 'major', 'moderate', 'low', 'info']);
  });

  it('is stable within a severity, by title', () => {
    const sorted = sortInteractionsBySeverity([
      item('z', 'major', 'Zolpidem + X'),
      item('a', 'major', 'Amiodarone + Y'),
    ]);
    expect(sorted.map((i) => i.title)).toEqual(['Amiodarone + Y', 'Zolpidem + X']);
  });

  it('does not mutate the array it was given', () => {
    const input = [item('1', 'info'), item('2', 'contraindicated')];
    const before = input.map((i) => i.id);
    sortInteractionsBySeverity(input);
    expect(input.map((i) => i.id)).toEqual(before);
  });
});
