'use client';

import { Badge, EmptyState } from '@vims/ui';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import type { MedicationItem, ProblemItem, TimelineItem } from '../api/types';
import { formatDay, formatInstant } from '../lib/numbers';

/**
 * The consultation's context rail — `docs/06` §9 archetype B: timeline on one
 * side, work area in the middle, "vitals · allergies · active meds · alerts" on
 * the other.
 *
 * Everything in here is **read-only and lazily loaded**, which is the point: a
 * doctor reads far more than they write, and the three lists below are what
 * makes the difference between prescribing into a vacuum and prescribing into a
 * history. Each panel carries its own loading, empty and error state so one
 * slow query cannot blank the other two — `docs/06` §6.7, "never blank a chart
 * to reload it".
 */

export function TimelinePanel({
  items,
  loading,
  error,
  onRetry,
}: {
  readonly items: readonly TimelineItem[];
  readonly loading: boolean;
  readonly error: unknown;
  readonly onRetry: () => void;
}): React.JSX.Element {
  return (
    <section aria-label="Patient timeline" data-testid="timeline-panel" className="flex flex-col gap-2">
      <h2 className="text-sm font-medium text-fg-default">Timeline</h2>
      <AsyncPanel
        loading={loading}
        error={error}
        isEmpty={items.length === 0}
        skeletonLabel="Loading the patient's history"
        skeletonRows={6}
        onRetry={onRetry}
        empty={
          <EmptyState
            cause="Nothing on this patient's record in the window shown."
            nextAction="This may be their first visit, or the history may sit outside the loaded period."
          />
        }
      >
        <ol className="flex flex-col gap-2">
          {items.map((item) => (
            <li key={`${item.kind}-${item.id}`} className="border-l-2 border-default pl-3">
              <p className="text-2xs text-fg-subtle">{formatInstant(item.occurred_at)}</p>
              <p className="text-sm text-fg-default">{item.title}</p>
              <Badge tone="neutral" size="sm">
                {item.kind}
              </Badge>
            </li>
          ))}
        </ol>
      </AsyncPanel>
    </section>
  );
}

export function ProblemsPanel({
  items,
  loading,
  error,
  onRetry,
}: {
  readonly items: readonly ProblemItem[];
  readonly loading: boolean;
  readonly error: unknown;
  readonly onRetry: () => void;
}): React.JSX.Element {
  return (
    <section aria-label="Problem list" data-testid="problems-panel" className="flex flex-col gap-2">
      <h2 className="text-sm font-medium text-fg-default">Problems</h2>
      <AsyncPanel
        loading={loading}
        error={error}
        isEmpty={items.length === 0}
        skeletonLabel="Loading the problem list"
        skeletonRows={3}
        onRetry={onRetry}
        empty={
          <EmptyState
            cause="No problem has been carried forward for this patient."
            nextAction="A diagnosis marked chronic on this consultation becomes one."
          />
        }
      >
        <ul className="flex flex-col gap-1">
          {items.map((problem) => (
            <li key={problem.id} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-mono text-xs text-fg-muted">{problem.code}</span>
              <span className="text-fg-default">{problem.description}</span>
              {problem.is_chronic ? (
                <Badge tone="info" size="sm">
                  chronic
                </Badge>
              ) : null}
              <Badge tone="neutral" size="sm">
                {problem.status}
              </Badge>
              {problem.onset_date === null ? null : (
                <span className="text-2xs text-fg-subtle">since {formatDay(problem.onset_date)}</span>
              )}
            </li>
          ))}
        </ul>
      </AsyncPanel>
    </section>
  );
}

export function MedicationsPanel({
  items,
  loading,
  error,
  onRetry,
}: {
  readonly items: readonly MedicationItem[];
  readonly loading: boolean;
  readonly error: unknown;
  readonly onRetry: () => void;
}): React.JSX.Element {
  return (
    <section aria-label="Active medications" data-testid="medications-panel" className="flex flex-col gap-2">
      <h2 className="text-sm font-medium text-fg-default">Medications</h2>
      <AsyncPanel
        loading={loading}
        error={error}
        isEmpty={items.length === 0}
        skeletonLabel="Loading current medication"
        skeletonRows={3}
        onRetry={onRetry}
        empty={
          <EmptyState
            cause="No medication is recorded as current for this patient."
            nextAction="Ask what they are taking, including anything bought over the counter — the interaction check can only see what is on the list."
          />
        }
      >
        <ul className="flex flex-col gap-1">
          {items.map((medication) => (
            <li key={medication.id} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-fg-default">{medication.drug_text}</span>
              {medication.dose_text === null ? null : (
                <span className="text-2xs text-fg-muted">{medication.dose_text}</span>
              )}
              <Badge tone="neutral" size="sm">
                {medication.status}
              </Badge>
              <Badge tone="neutral" size="sm">
                {medication.source}
              </Badge>
            </li>
          ))}
        </ul>
      </AsyncPanel>
    </section>
  );
}
