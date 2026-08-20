import { describe, expect, it } from 'vitest';
import { PRIORITY_CLASSES, PRIORITY_CLASS_NAMES, isWithinWindow, jobOptionsFor } from './priority-classes.js';

/**
 * `docs/07` §4's table, asserted rather than trusted. It is the kind of thing
 * that is silently edited to "fix" a slow queue, and the failure that causes —
 * a critical-result fan-out behind a nightly export — is invisible until it
 * matters.
 */
describe('the five BullMQ priority classes (docs/07 §4)', () => {
  it('is exactly the five classes the document names', () => {
    expect([...PRIORITY_CLASS_NAMES]).toEqual(['critical', 'interactive', 'standard', 'bulk', 'maintenance']);
  });

  it.each([
    ['critical', 1, 20],
    ['interactive', 2, 16],
    ['standard', 3, 32],
    ['bulk', 4, 4],
    ['maintenance', 5, 2],
  ] as const)('%s carries priority %i and concurrency %i', (name, priority, concurrency) => {
    expect(PRIORITY_CLASSES[name].priority).toBe(priority);
    expect(PRIORITY_CLASSES[name].concurrency).toBe(concurrency);
  });

  it('gives every class its own queue, so concurrency is a bulkhead and not a shared budget', () => {
    const queues = PRIORITY_CLASS_NAMES.map((n) => PRIORITY_CLASSES[n].queueName);
    expect(new Set(queues).size).toBe(queues.length);
  });

  it('orders lower-numbered classes first, matching BullMQ semantics', () => {
    const priorities = PRIORITY_CLASS_NAMES.map((n) => PRIORITY_CLASSES[n].priority);
    expect([...priorities].sort((a, b) => a - b)).toEqual(priorities);
  });

  it('never silently drops a failed job — the failed set is the DLQ', () => {
    expect(jobOptionsFor('standard').removeOnFail).toBe(false);
    expect(jobOptionsFor('standard').attempts).toBeGreaterThan(1);
    expect(jobOptionsFor('standard').backoff).toEqual({ type: 'exponential', delay: 1_000 });
  });

  it('lets a caller override without losing the class priority', () => {
    expect(jobOptionsFor('critical', { attempts: 3 })).toMatchObject({ priority: 1, attempts: 3 });
  });

  it('confines the maintenance window to 01:00–05:00 and leaves the rest always-on', () => {
    const at = (hour: number): Date => new Date(2026, 7, 20, hour, 0, 0);
    expect(isWithinWindow(PRIORITY_CLASSES.maintenance, at(2))).toBe(true);
    expect(isWithinWindow(PRIORITY_CLASSES.maintenance, at(5))).toBe(false);
    expect(isWithinWindow(PRIORITY_CLASSES.maintenance, at(14))).toBe(false);
    expect(isWithinWindow(PRIORITY_CLASSES.critical, at(14))).toBe(true);
    expect(isWithinWindow(PRIORITY_CLASSES.bulk, at(14))).toBe(true);
  });
});
