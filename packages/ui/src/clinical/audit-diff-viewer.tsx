import { ShieldCheck, ShieldX } from 'lucide-react';
import { cn } from '../lib/cn.js';

/**
 * `AuditDiffViewer` — docs/06 §5.2 #29: "Before/after field diff with old struck / new
 * emphasised, actor + role + IP + device + reason, hash-chain verification chip.
 * Read-only; opens from any record's 'History'."
 *
 * Read-only by construction: there are no handlers, no inputs and no way to mutate the
 * entry (docs/03 — the audit log is append-only and hash-chained).
 */
export interface AuditFieldChange {
  /** Already-localised field name in ward vocabulary, never the column name (§1.2.2). */
  readonly field: string;
  /** Rendered struck through. `null` means the field was previously unset. */
  readonly before: string | null;
  /** Rendered emphasised. `null` means the field was cleared. */
  readonly after: string | null;
}

export interface AuditEntry {
  readonly id: string;
  readonly actorName: string;
  readonly actorRole: string;
  /** `dd-MM-yyyy HH:mm` in hospital time (§1.2.10). */
  readonly at: string;
  readonly ipAddress?: string;
  readonly device?: string;
  readonly reason?: string;
  readonly changes: readonly AuditFieldChange[];
  /** Result of re-computing the hash chain for this row (docs/03 §audit). */
  readonly hashChainVerified: boolean;
  readonly hashPrefix?: string;
}

export interface AuditDiffViewerLabels {
  readonly region: string;
  readonly fieldColumn: string;
  readonly beforeColumn: string;
  readonly afterColumn: string;
  readonly emptyValue: string;
  readonly reasonPrefix: string;
  readonly chainVerified: string;
  readonly chainBroken: string;
  readonly byline: (actor: string, role: string, at: string) => string;
}

export interface AuditDiffViewerProps {
  readonly entry: AuditEntry;
  readonly labels: AuditDiffViewerLabels;
  readonly className?: string;
}

export function AuditDiffViewer({ entry, labels, className }: AuditDiffViewerProps): React.JSX.Element {
  return (
    <section
      data-slot="audit-diff-viewer"
      aria-label={labels.region}
      className={cn('flex flex-col gap-2 rounded-lg border border-default bg-layer-2 p-3', className)}
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-fg-default">{labels.byline(entry.actorName, entry.actorRole, entry.at)}</p>
        <span
          data-chain-verified={entry.hashChainVerified ? 'true' : 'false'}
          className={cn(
            'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-medium',
            entry.hashChainVerified
              ? 'border-success-border bg-success-surface text-success-on-surface'
              : 'border-danger-border bg-danger-surface text-danger-on-surface',
          )}
        >
          {entry.hashChainVerified ? (
            <ShieldCheck className="size-3" aria-hidden="true" />
          ) : (
            <ShieldX className="size-3" aria-hidden="true" />
          )}
          {entry.hashChainVerified ? labels.chainVerified : labels.chainBroken}
          {entry.hashPrefix === undefined ? null : <span className="font-mono">{entry.hashPrefix}</span>}
        </span>
      </header>

      {entry.reason === undefined ? null : (
        <p className="text-sm text-fg-muted">
          {labels.reasonPrefix} {entry.reason}
        </p>
      )}

      {entry.ipAddress === undefined && entry.device === undefined ? null : (
        <p className="font-mono text-xs text-fg-subtle">
          {[entry.ipAddress, entry.device].filter((part) => part !== undefined).join(' · ')}
        </p>
      )}

      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-default text-start">
            <th scope="col" className="py-1 pe-3 text-start text-xs font-medium text-fg-muted">
              {labels.fieldColumn}
            </th>
            <th scope="col" className="py-1 pe-3 text-start text-xs font-medium text-fg-muted">
              {labels.beforeColumn}
            </th>
            <th scope="col" className="py-1 text-start text-xs font-medium text-fg-muted">
              {labels.afterColumn}
            </th>
          </tr>
        </thead>
        <tbody>
          {entry.changes.map((change) => (
            <tr key={change.field} className="border-b border-default last:border-b-0">
              <th scope="row" className="py-1 pe-3 text-start font-medium text-fg-default">
                {change.field}
              </th>
              <td className="py-1 pe-3 text-fg-muted">
                {change.before === null ? (
                  <span className="italic">{labels.emptyValue}</span>
                ) : (
                  <del data-diff="before">{change.before}</del>
                )}
              </td>
              <td className="py-1 text-fg-default">
                {change.after === null ? (
                  <span className="italic text-fg-muted">{labels.emptyValue}</span>
                ) : (
                  <ins data-diff="after" className="font-medium no-underline">
                    {change.after}
                  </ins>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
