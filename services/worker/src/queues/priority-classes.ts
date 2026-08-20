import type { JobsOptions } from 'bullmq';

/**
 * The five BullMQ priority classes of `docs/07` §4, as data.
 *
 * They are here rather than inline at each `queue.add()` for one reason: the
 * table is a *policy*, and a policy that is retyped at every call site is a
 * policy that drifts. A critical-result fan-out that was enqueued with the
 * default priority would sit behind a nightly report, which is the exact
 * failure the table exists to prevent.
 *
 * `priority` is BullMQ's own semantics — **lower runs first** — which happens to
 * match the numbering `docs/07` §4 already uses (1 = critical … 5 =
 * maintenance), so the document's column can be used verbatim rather than
 * inverted, and nobody has to remember which way round it is.
 *
 * One class, one queue. Priority ordering only applies *within* a BullMQ queue,
 * so five classes sharing one queue would give correct ordering but a single
 * shared concurrency budget: 4 stuck bulk exports would starve every critical
 * job. Separate queues give each class its own worker, its own concurrency and
 * its own bulkhead — which is what the `Concurrency` column of §4 means.
 */
export type PriorityClassName = 'critical' | 'interactive' | 'standard' | 'bulk' | 'maintenance';

/** When a class is allowed to run. `docs/07` §4, column "Window". */
export type ExecutionWindow =
  | { readonly kind: 'always' }
  | { readonly kind: 'off_peak_preferred' }
  | { readonly kind: 'hours'; readonly fromHour: number; readonly toHour: number };

export interface PriorityClassSpec {
  readonly name: PriorityClassName;
  /** BullMQ priority; lower runs first. */
  readonly priority: number;
  readonly concurrency: number;
  readonly queueName: string;
  readonly window: ExecutionWindow;
  /** The §4 "Jobs" column, kept so a producer can check where its job belongs. */
  readonly jobs: readonly string[];
}

export const PRIORITY_CLASSES: Readonly<Record<PriorityClassName, PriorityClassSpec>> = Object.freeze({
  critical: Object.freeze({
    name: 'critical',
    priority: 1,
    concurrency: 20,
    queueName: 'hms.critical',
    window: Object.freeze({ kind: 'always' } as const),
    jobs: Object.freeze(['critical result fan-out', 'code blue', 'EWS escalation', 'panic']),
  }),
  interactive: Object.freeze({
    name: 'interactive',
    priority: 2,
    concurrency: 16,
    queueName: 'hms.interactive',
    window: Object.freeze({ kind: 'always' } as const),
    jobs: Object.freeze([
      'user-waiting PDFs',
      'receipts',
      'labels',
      'payment webhook posting',
      'token print',
    ]),
  }),
  standard: Object.freeze({
    name: 'standard',
    priority: 3,
    concurrency: 32,
    queueName: 'hms.standard',
    window: Object.freeze({ kind: 'always' } as const),
    jobs: Object.freeze([
      'SMS/WhatsApp',
      'notifications',
      'outbox relay',
      'HL7 result filing',
      'charge posting',
    ]),
  }),
  bulk: Object.freeze({
    name: 'bulk',
    priority: 4,
    concurrency: 4,
    queueName: 'hms.bulk',
    window: Object.freeze({ kind: 'off_peak_preferred' } as const),
    jobs: Object.freeze([
      'reports',
      'exports',
      'claim packs',
      'MV refresh',
      'nightly room charges',
      'migrations',
    ]),
  }),
  maintenance: Object.freeze({
    name: 'maintenance',
    priority: 5,
    concurrency: 2,
    queueName: 'hms.maintenance',
    // §4 says 01:00–05:00. It is a *preference* enforced by the scheduler that
    // enqueues, never a gate on the processor: partition premake and audit
    // sealing are correctness jobs, and refusing to run one at 09:00 because
    // the clock says so would leave a tenant unsealed for sixteen hours.
    window: Object.freeze({ kind: 'hours', fromHour: 1, toHour: 5 } as const),
    jobs: Object.freeze(['retention', 'archival', 'partition premake', 'reindex', 'cache warm']),
  }),
});

export const PRIORITY_CLASS_NAMES: readonly PriorityClassName[] = Object.freeze([
  'critical',
  'interactive',
  'standard',
  'bulk',
  'maintenance',
]);

/**
 * Default job options for a class.
 *
 * `docs/07` §4: "Jobs are idempotent, carry `attempts`, exponential backoff with
 * jitter, and land in a DLQ — never a silent drop." BullMQ's `exponential`
 * backoff is deterministic; the jitter §4 asks for is added by the caller's
 * `backoff` override where a thundering herd is possible. `removeOnFail: false`
 * is the DLQ: a failed job stays in the failed set to be inspected and retried,
 * rather than evaporating.
 */
export function jobOptionsFor(cls: PriorityClassName, overrides: JobsOptions = {}): JobsOptions {
  const spec = PRIORITY_CLASSES[cls];
  return {
    priority: spec.priority,
    attempts: cls === 'critical' ? 10 : 5,
    backoff: { type: 'exponential', delay: 1_000 },
    removeOnComplete: { age: 3_600, count: 1_000 },
    removeOnFail: false,
    ...overrides,
  };
}

/** Whether `at` falls inside a class's preferred window. */
export function isWithinWindow(spec: PriorityClassSpec, at: Date): boolean {
  switch (spec.window.kind) {
    case 'always':
    case 'off_peak_preferred':
      return true;
    case 'hours': {
      const hour = at.getHours();
      return hour >= spec.window.fromHour && hour < spec.window.toHour;
    }
  }
}
