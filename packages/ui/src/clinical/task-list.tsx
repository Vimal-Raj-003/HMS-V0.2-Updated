'use client';

import { CircleAlert, Clock } from 'lucide-react';
import { cn } from '../lib/cn.js';
import { Button } from '../primitives/button.js';

/**
 * `TaskList` — docs/06 §5.2 #31: "Grouped by due window (overdue / now / next
 * 2 h / later), swipe-to-complete on touch, skip requires reason, live re-sort,
 * 'my patients' filter, count badges feeding the shell."
 *
 * The grouping is the design. A flat list sorted by time makes "what is late"
 * a reading exercise; four named windows make it a glance, and the overdue
 * group keeps its identity even when it is empty — an absent group reads as
 * "nothing is overdue", which is the same sentence, but a *stated* empty
 * overdue group is the one a nurse can trust.
 *
 * **Skip requires a reason** (§5.2 #31), so `onSkip` receives the task and the
 * caller opens `ConfirmWithReasonDialog`; this component has no skip path that
 * bypasses it. Completing is one action because completing is the expected
 * outcome; skipping is the exception and exceptions get friction (§6.9).
 *
 * Grouping happens here rather than in the caller for the same reason
 * `InteractionPanel` sorts internally: if the window a task lands in depended on
 * the order it arrived, a re-sort could quietly move an overdue task out of the
 * overdue group.
 */

export type TaskWindow = 'overdue' | 'now' | 'next-2h' | 'later';

export interface ClinicalTask {
  readonly id: string;
  /** What to do, in ward language. e.g. "Paracetamol 500 mg — oral". */
  readonly title: string;
  /** Who it is for. Masked or full per the board's policy — decided by the caller. */
  readonly subject: string;
  /** Already localised, e.g. "due 14:00" or "35 min late". */
  readonly dueLabel: string;
  /** Minutes until due; negative is overdue. Drives the grouping. */
  readonly dueInMinutes: number;
  /** Marks the high-alert rows — narcotics, insulin, anticoagulants. */
  readonly highAlert?: boolean;
}

/**
 * The windows, in the order §5.2 #31 names them. Exported so the shell's count
 * badges are computed from the same function the list groups by, and cannot
 * disagree with it.
 */
export function groupTasks(tasks: readonly ClinicalTask[]): ReadonlyMap<TaskWindow, readonly ClinicalTask[]> {
  const windows: TaskWindow[] = ['overdue', 'now', 'next-2h', 'later'];
  const grouped = new Map<TaskWindow, ClinicalTask[]>(windows.map((w) => [w, []]));
  for (const task of tasks) {
    const key: TaskWindow =
      task.dueInMinutes < 0
        ? 'overdue'
        : task.dueInMinutes <= 15
          ? 'now'
          : task.dueInMinutes <= 120
            ? 'next-2h'
            : 'later';
    grouped.get(key)?.push(task);
  }
  // Within a window, the most urgent first. Overdue sorts by how late, so the
  // 90-minute-late dose is above the 5-minute-late one.
  for (const list of grouped.values()) list.sort((a, b) => a.dueInMinutes - b.dueInMinutes);
  return grouped;
}

export interface TaskListLabels {
  readonly heading: string;
  readonly window: Record<TaskWindow, string>;
  /** Shown in place of an empty group, e.g. "Nothing overdue". Keyed by window. */
  readonly emptyWindow: Record<TaskWindow, string>;
  readonly complete: string;
  readonly skip: string;
  readonly highAlert: string;
  /** Shown when there are no tasks at all in any window. */
  readonly none: string;
}

export interface TaskListProps {
  readonly tasks: readonly ClinicalTask[];
  readonly labels: TaskListLabels;
  readonly onComplete?: (id: string) => void;
  /** Always routed through a reason dialog by the caller (§5.2 #31, §6.9). */
  readonly onSkip?: (id: string) => void;
  readonly className?: string;
}

const WINDOW_STYLE: Record<TaskWindow, string> = {
  overdue: 'text-danger-fg',
  now: 'text-warning-fg',
  'next-2h': 'text-fg-default',
  later: 'text-fg-muted',
};

export function TaskList({ tasks, labels, onComplete, onSkip, className }: TaskListProps): React.JSX.Element {
  const grouped = groupTasks(tasks);
  const windows: TaskWindow[] = ['overdue', 'now', 'next-2h', 'later'];

  if (tasks.length === 0) {
    return (
      <section
        data-slot="task-list"
        data-state="empty"
        aria-label={labels.heading}
        className={cn(
          'border-default text-fg-muted rounded-lg border border-dashed px-3 py-6 text-center text-xs',
          className,
        )}
      >
        {labels.none}
      </section>
    );
  }

  return (
    <section
      data-slot="task-list"
      aria-label={labels.heading}
      className={cn('flex flex-col gap-5', className)}
    >
      {windows.map((window) => {
        const items = grouped.get(window) ?? [];
        // The overdue group is rendered even when empty — see the doc comment.
        if (items.length === 0 && window !== 'overdue') return null;

        return (
          <div key={window} data-slot="task-window" data-window={window}>
            <h3
              className={cn(
                'm-0 mb-2 flex items-center gap-1.5 text-xs font-semibold tracking-wide',
                WINDOW_STYLE[window],
              )}
            >
              {window === 'overdue' ? (
                <CircleAlert aria-hidden="true" className="size-3.5" />
              ) : (
                <Clock aria-hidden="true" className="size-3.5" />
              )}
              {labels.window[window]}
              <span className="text-fg-subtle font-mono tabular-nums">{items.length}</span>
            </h3>

            {items.length === 0 ? (
              <p className="text-fg-subtle m-0 text-xs">{labels.emptyWindow[window]}</p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                {items.map((task) => (
                  <li
                    key={task.id}
                    data-slot="task"
                    data-high-alert={task.highAlert === true ? 'true' : undefined}
                    className={cn(
                      'border-default bg-layer-1 flex items-center gap-3 rounded-md border p-2.5',
                      // A persistent marker on high-alert rows (§5.2 #12's rule,
                      // applied here because the task list is where a nurse
                      // actually starts the administration.
                      task.highAlert === true && 'border-l-[3px] border-l-danger-solid',
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-fg-default m-0 truncate text-sm font-medium">
                        {task.title}
                        {task.highAlert === true ? (
                          <span className="bg-danger-surface text-danger-on-surface ml-2 rounded px-1.5 py-0.5 text-2xs font-semibold">
                            {labels.highAlert}
                          </span>
                        ) : null}
                      </p>
                      <p className="text-fg-muted m-0 truncate text-xs">
                        {task.subject} · <span className="tabular-nums">{task.dueLabel}</span>
                      </p>
                    </div>

                    <div className="flex shrink-0 gap-1.5">
                      {onSkip === undefined ? null : (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            onSkip(task.id);
                          }}
                        >
                          {labels.skip}
                        </Button>
                      )}
                      {onComplete === undefined ? null : (
                        <Button
                          type="button"
                          variant="primary"
                          size="sm"
                          onClick={() => {
                            onComplete(task.id);
                          }}
                        >
                          {labels.complete}
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </section>
  );
}
