import { describe, expect, it } from 'vitest';
import { groupTasks, type ClinicalTask } from './task-list.js';

/**
 * docs/06 §5.2 #31 groups tasks by due window. The grouping lives in the
 * component rather than in the caller so that a live re-sort cannot move an
 * overdue task out of the overdue group — which is the failure that would make
 * a nurse believe nothing is late.
 */

const task = (id: string, dueInMinutes: number): ClinicalTask => ({
  id,
  title: id,
  subject: 'Bed 1',
  dueLabel: '',
  dueInMinutes,
});

describe('TaskList grouping — docs/06 §5.2 #31', () => {
  it('places each task in the window its due time falls in', () => {
    const grouped = groupTasks([task('late', -1), task('now', 10), task('soon', 90), task('later', 300)]);
    expect(grouped.get('overdue')?.map((t) => t.id)).toEqual(['late']);
    expect(grouped.get('now')?.map((t) => t.id)).toEqual(['now']);
    expect(grouped.get('next-2h')?.map((t) => t.id)).toEqual(['soon']);
    expect(grouped.get('later')?.map((t) => t.id)).toEqual(['later']);
  });

  it('treats exactly-due as due now, not as overdue', () => {
    // 0 minutes is "due", and calling it late would cry wolf on every task at
    // the moment it becomes actionable.
    expect(
      groupTasks([task('t', 0)])
        .get('now')
        ?.map((t) => t.id),
    ).toEqual(['t']);
    expect(groupTasks([task('t', 0)]).get('overdue')).toEqual([]);
  });

  it('sorts the most overdue first', () => {
    const grouped = groupTasks([task('five', -5), task('ninety', -90), task('thirty', -30)]);
    expect(grouped.get('overdue')?.map((t) => t.id)).toEqual(['ninety', 'thirty', 'five']);
  });

  it('always returns all four windows, even when empty', () => {
    // The overdue group is rendered even when empty, so it has to exist in the
    // map rather than being absent and defaulting to undefined at the callsite.
    const grouped = groupTasks([]);
    expect([...grouped.keys()]).toEqual(['overdue', 'now', 'next-2h', 'later']);
    for (const list of grouped.values()) expect(list).toEqual([]);
  });
});
