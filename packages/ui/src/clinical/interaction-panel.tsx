import { AlertOctagon, AlertTriangle, Info, ShieldAlert } from 'lucide-react';
import { cn } from '../lib/cn.js';
import { Button } from '../primitives/button.js';

/**
 * `InteractionPanel` — docs/06 §5.2 #17: "Severity-sorted list (contraindicated
 * → major → moderate → minor) with mechanism, management text, and per-item
 * acknowledge; contraindicated escalates to `AllergyAlertDialog` styling."
 *
 * The vocabulary is the API's, not a UI-local invention: `CdssSeverity` and
 * `CdssFamily` are the unions `services/api/.../cdss.engine.ts` stores on
 * `cdss_alert_events`. A component with its own list of severities drifts, and
 * the drift shows up as an unstyled alert rather than as a type error.
 *
 * **Sort order is a safety property, not a preference.** A prescriber reads down
 * the list and stops when they have seen enough; if a moderate interaction can
 * sort above a contraindicated one, the list has buried the thing it exists to
 * surface. So the panel sorts internally on a fixed rank rather than trusting
 * the order it was handed, and a test asserts it.
 *
 * The panel deliberately does **not** own the hard stop. A contraindicated pair
 * takes the same red treatment as `AllergyAlertDialog` here, but the actual
 * refusal is a `hard_stop` interruption enforced by the service — §5.2 #16's
 * dialog is what blocks. This panel is the reading surface.
 */

/** Exactly `CdssSeverity` from the API. */
export type InteractionSeverity = 'info' | 'low' | 'moderate' | 'major' | 'contraindicated';

/** Exactly `CdssInterruption` from the API. */
export type InteractionInterruption = 'passive' | 'soft_stop' | 'hard_stop' | 'shadow';

export interface InteractionItem {
  readonly id: string;
  readonly severity: InteractionSeverity;
  readonly interruption: InteractionInterruption;
  /** e.g. "Warfarin + Ciprofloxacin". Already localised. */
  readonly title: string;
  /** Why it happens — "CYP1A2 inhibition raises warfarin exposure". */
  readonly mechanism: string;
  /** What to do — EN-029 §5 requires at least one constructive action. */
  readonly management: string;
  /** The rule that fired, shown so a prescriber can dispute it. */
  readonly ruleId: string;
  /** Set once this session has acknowledged it, with the coded reason. */
  readonly acknowledgedReason?: string;
}

/**
 * Descending clinical urgency. Rank, not alphabet: `contraindicated` must never
 * sort below `major` because a locale renamed it.
 */
const RANK: Record<InteractionSeverity, number> = {
  contraindicated: 0,
  major: 1,
  moderate: 2,
  low: 3,
  info: 4,
};

const SEVERITY_STYLE: Record<
  InteractionSeverity,
  { readonly container: string; readonly chip: string; readonly Icon: typeof AlertTriangle }
> = {
  contraindicated: {
    // The AllergyAlertDialog treatment, per §5.2 #17.
    container: 'border-danger-border bg-danger-surface',
    chip: 'bg-danger-solid text-danger-on-solid',
    Icon: ShieldAlert,
  },
  major: {
    container: 'border-danger-border bg-layer-1',
    chip: 'bg-danger-surface text-danger-on-surface border border-danger-border',
    Icon: AlertOctagon,
  },
  moderate: {
    container: 'border-warning-border bg-layer-1',
    chip: 'bg-warning-surface text-warning-on-surface border border-warning-border',
    Icon: AlertTriangle,
  },
  low: {
    container: 'border-default bg-layer-1',
    chip: 'bg-sunken text-fg-muted border border-default',
    Icon: Info,
  },
  info: {
    container: 'border-default bg-layer-1',
    chip: 'bg-sunken text-fg-muted border border-default',
    Icon: Info,
  },
};

export interface InteractionPanelLabels {
  /** Accessible name for the list, e.g. "Drug interactions". */
  readonly heading: string;
  /** Localised severity names, keyed by severity. */
  readonly severity: Record<InteractionSeverity, string>;
  readonly mechanism: string;
  readonly management: string;
  readonly acknowledge: string;
  /** e.g. "Acknowledged — {reason}". `{reason}` is substituted. */
  readonly acknowledged: string;
  readonly ruleId: string;
  /** Shown when there are none, e.g. "No interactions found for these 4 drugs." */
  readonly none: string;
  /**
   * Degraded state. The vendor knowledge base was unreachable, so this list is
   * the local formulary only and is **not** a clean result (D-9).
   */
  readonly degraded?: string;
}

export interface InteractionPanelProps {
  readonly items: readonly InteractionItem[];
  readonly labels: InteractionPanelLabels;
  /** Per-item acknowledge (§5.2 #17). Omitted for a read-only reviewer. */
  readonly onAcknowledge?: (id: string) => void;
  /**
   * True when only part of the knowledge base answered. Rendering a short list
   * as if it were complete is the failure D-9 exists to prevent: "no
   * interactions found" and "we could not look" are different sentences.
   */
  readonly degraded?: boolean;
  readonly className?: string;
}

export function InteractionPanel({
  items,
  labels,
  onAcknowledge,
  degraded = false,
  className,
}: InteractionPanelProps): React.JSX.Element {
  const sorted = [...items].sort(
    (a, b) => RANK[a.severity] - RANK[b.severity] || a.title.localeCompare(b.title),
  );

  return (
    <section
      data-slot="interaction-panel"
      aria-label={labels.heading}
      className={cn('flex flex-col gap-2', className)}
    >
      {degraded && labels.degraded !== undefined ? (
        <p
          data-slot="interaction-degraded"
          role="status"
          className="border-warning-border bg-warning-surface text-warning-on-surface rounded-md border px-3 py-2 text-xs"
        >
          {labels.degraded}
        </p>
      ) : null}

      {sorted.length === 0 ? (
        <p className="text-fg-muted border-default rounded-lg border border-dashed px-3 py-4 text-center text-xs">
          {labels.none}
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {sorted.map((item) => {
            const style = SEVERITY_STYLE[item.severity];
            const acknowledged = item.acknowledgedReason !== undefined;
            return (
              <li
                key={item.id}
                data-slot="interaction-item"
                data-severity={item.severity}
                data-interruption={item.interruption}
                className={cn('rounded-lg border p-3', style.container)}
              >
                <div className="flex items-start gap-2.5">
                  <style.Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" strokeWidth={2.25} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="text-fg-default text-sm font-medium">{item.title}</span>
                      {/*
                        The severity is a word, not only a colour. §5.2 #17 sorts
                        by it, so a reader must be able to see which band a row is
                        in without comparing hues.
                      */}
                      <span className={cn('rounded-full px-2 py-0.5 text-2xs font-medium', style.chip)}>
                        {labels.severity[item.severity]}
                      </span>
                    </div>

                    <dl className="mt-1.5 grid gap-1 text-xs">
                      <div className="flex gap-1.5">
                        <dt className="text-fg-subtle shrink-0">{labels.mechanism}</dt>
                        <dd className="text-fg-muted m-0">{item.mechanism}</dd>
                      </div>
                      <div className="flex gap-1.5">
                        <dt className="text-fg-subtle shrink-0">{labels.management}</dt>
                        <dd className="text-fg-default m-0 font-medium">{item.management}</dd>
                      </div>
                    </dl>

                    <div className="mt-2 flex flex-wrap items-center gap-3">
                      <span className="text-fg-subtle font-mono text-2xs">
                        {labels.ruleId} {item.ruleId}
                      </span>
                      {acknowledged ? (
                        <span className="text-fg-muted text-2xs">
                          {labels.acknowledged.replace('{reason}', item.acknowledgedReason ?? '')}
                        </span>
                      ) : onAcknowledge === undefined ? null : (
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          onClick={() => {
                            onAcknowledge(item.id);
                          }}
                        >
                          {labels.acknowledge}
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Exported for the test that asserts urgency ordering is not left to the caller. */
export function sortInteractionsBySeverity(items: readonly InteractionItem[]): readonly InteractionItem[] {
  return [...items].sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.title.localeCompare(b.title));
}
