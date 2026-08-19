import { describe, expect, it } from 'vitest';

import { printJobLogContext } from './logger.js';
import { DEFAULT_PRINT_RETRY, PRINT_QUEUE_PRIORITY, maxAttemptsFor, printJobOptions } from './print-queue.js';

describe('retry policy (EN-005 §3.3.2)', () => {
  /** "retries every 30 s for 10 min then failed with alert". */
  it('spans exactly the ten-minute window at thirty-second intervals', () => {
    expect(DEFAULT_PRINT_RETRY.intervalMs).toBe(30_000);
    expect(DEFAULT_PRINT_RETRY.windowMs).toBe(600_000);
    expect(maxAttemptsFor()).toBe(21);
    expect((maxAttemptsFor() - 1) * DEFAULT_PRINT_RETRY.intervalMs).toBe(DEFAULT_PRINT_RETRY.windowMs);
  });

  it('derives the attempt count from the window, so the two cannot drift apart', () => {
    expect(maxAttemptsFor({ intervalMs: 10_000, windowMs: 60_000 })).toBe(7);
  });
});

describe('queue options', () => {
  const ref = {
    jobId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    createdAt: '2026-08-20 09:14:00+00',
    hospitalId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    branchId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  };

  /**
   * The outbox is at-least-once by design (`docs/01 §5`), so the same
   * `queue.token.issued` event can arrive twice. Keying the BullMQ job on the
   * print job's own id is what stops the patient getting two slips.
   */
  it('keys the queue job on the print job id, making enqueue idempotent', () => {
    expect(printJobOptions(ref).jobId).toBe(ref.jobId);
  });

  it('runs in the interactive class and backs off at a fixed interval', () => {
    const options = printJobOptions(ref);
    expect(options.priority).toBe(PRINT_QUEUE_PRIORITY);
    expect(options.attempts).toBe(21);
    // Fixed, not exponential: when paper is loaded every waiting token must
    // recover together, and exponential backoff punishes the oldest job most.
    expect(options.backoff).toEqual({ type: 'fixed', delay: 30_000 });
  });
});

describe('log context (docs/04 §7 — no PHI in logs)', () => {
  const job = {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    docType: 'op_receipt',
    templateKey: 'bill_a4.html.v1',
    format: 'pdf',
    status: 'queued',
    attempts: 1,
    copies: 1,
    phi: true,
    printerId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    agentId: null,
    hospitalId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    branchId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    patientId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    patientName: 'Synthetic Test',
  };

  it('is an allow-list: the patient id and name cannot survive it', () => {
    const context = printJobLogContext(job);
    const serialised = JSON.stringify(context);
    expect(serialised).not.toContain(job.patientId);
    expect(serialised).not.toContain('Synthetic Test');
    expect(Object.keys(context).sort()).toEqual(
      [
        'agentId',
        'attempts',
        'branchId',
        'copies',
        'docType',
        'format',
        'hospitalId',
        'jobId',
        'phi',
        'printerId',
        'status',
        'templateKey',
      ].sort(),
    );
  });

  it('keeps the job id and template key, which is what EN-005 §13 permits', () => {
    const context = printJobLogContext(job);
    expect(context.jobId).toBe(job.id);
    expect(context.templateKey).toBe('bill_a4.html.v1');
  });
});
