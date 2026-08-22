import { describe, expect, it } from 'vitest';
import {
  ACTIVE_TOKEN_STATUSES,
  elapsedSeconds,
  estimateWaitSeconds,
  formatTokenDisplay,
  isPriorityClass,
  priorityRankFor,
  statusAfterSkip,
} from './queue.logic.js';

describe('priority ordering', () => {
  it('puts the emergency class above every other class', () => {
    const others = [
      'priority_senior',
      'priority_pregnant',
      'priority_disabled',
      'priority_infant',
      'priority_vip',
      'priority_staff',
      'appointment',
      'regular',
    ] as const;
    for (const other of others) {
      expect(priorityRankFor('priority_emergency')).toBeGreaterThan(priorityRankFor(other));
    }
  });

  it('ranks an appointment above a walk-in but below every statutory priority group', () => {
    expect(priorityRankFor('appointment')).toBeGreaterThan(priorityRankFor('regular'));
    expect(priorityRankFor('appointment')).toBeLessThan(priorityRankFor('priority_senior'));
    expect(priorityRankFor('appointment')).toBeLessThan(priorityRankFor('priority_disabled'));
  });

  it('treats the three statutory groups as equals, so arrival time decides between them', () => {
    expect(priorityRankFor('priority_senior')).toBe(priorityRankFor('priority_pregnant'));
    expect(priorityRankFor('priority_senior')).toBe(priorityRankFor('priority_disabled'));
  });

  it('recognises the priority classes by name', () => {
    expect(isPriorityClass('priority_senior')).toBe(true);
    expect(isPriorityClass('appointment')).toBe(false);
  });
});

describe('one active token per patient per queue per day', () => {
  it('counts a served, no-show, cancelled, expired or transferred token as finished', () => {
    for (const finished of ['served', 'no_show', 'cancelled', 'expired', 'transferred'] as const) {
      expect(ACTIVE_TOKEN_STATUSES).not.toContain(finished);
    }
  });

  it('counts a skipped token as still active, because it returns to the queue', () => {
    expect(ACTIVE_TOKEN_STATUSES).toContain('skipped');
    expect(ACTIVE_TOKEN_STATUSES).toContain('held');
  });
});

describe('token display', () => {
  it('pads to the configured width', () => {
    expect(formatTokenDisplay('A', 7, 3)).toBe('A-007');
    expect(formatTokenDisplay('D12', 123, 4)).toBe('D12-0123');
  });

  it('never renders a number narrower than one digit, whatever the config says', () => {
    expect(formatTokenDisplay('A', 7, 0)).toBe('A-7');
    expect(formatTokenDisplay('A', 7, -3)).toBe('A-7');
  });

  it('does not truncate a number that outgrew its width', () => {
    expect(formatTokenDisplay('A', 1234, 3)).toBe('A-1234');
  });
});

describe('estimates and skips', () => {
  it('multiplies position by service time', () => {
    expect(estimateWaitSeconds(5, 600)).toBe(3000);
    expect(estimateWaitSeconds(0, 600)).toBe(0);
  });

  it('never returns a negative estimate', () => {
    expect(estimateWaitSeconds(-3, 600)).toBe(0);
  });

  it('retires a token as a no-show once the skip limit is reached', () => {
    expect(statusAfterSkip(1, 2)).toBe('skipped');
    expect(statusAfterSkip(2, 2)).toBe('no_show');
    expect(statusAfterSkip(3, 2)).toBe('no_show');
  });

  it('falls back to two skips when the queue is misconfigured with zero', () => {
    expect(statusAfterSkip(1, 0)).toBe('skipped');
    expect(statusAfterSkip(2, 0)).toBe('no_show');
  });

  it('floors a negative wait at zero rather than reporting time travel', () => {
    const later = new Date('2026-08-22T10:00:00Z');
    const earlier = new Date('2026-08-22T09:30:00Z');
    expect(elapsedSeconds(earlier, later)).toBe(1800);
    expect(elapsedSeconds(later, earlier)).toBe(0);
  });
});
