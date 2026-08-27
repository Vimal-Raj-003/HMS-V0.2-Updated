'use client';

import { Badge, EmptyState } from '@vims/ui';
import type { DocumentView } from '../api/types';
import { extraText, statusTone } from '../lib/documents';
import { formatDate, formatInstant, formatQty, humanise } from '@/features/pharmacy/lib/format';

/**
 * One store or purchase document, rendered the same way everywhere.
 *
 * Indents, issues, transfers, adjustments, counts, purchase orders and goods
 * receipts are all `DocumentView` on the wire, and rendering each of them with
 * its own bespoke table is how one of them ends up missing its batch column. So
 * there is one renderer, and the per-document differences are the `extra` fields
 * a caller names.
 *
 * `docs/06` §1.2 rule 3: every status carries a word, not only a colour.
 */
export function DocumentSummary({
  document,
  title,
}: {
  readonly document: DocumentView;
  readonly title?: string;
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid={`document-${document.documentNo}`}>
      <span className="font-mono text-md text-fg-default">{document.documentNo}</span>
      {title === undefined ? null : <span className="text-sm text-fg-muted">{title}</span>}
      <Badge tone="neutral" className={statusTone(document.status)}>
        {humanise(document.status)}
      </Badge>
      <span className="text-2xs text-fg-subtle">raised {formatInstant(document.createdAt)}</span>
      <span className="text-2xs text-fg-subtle">
        {document.lines.length} line{document.lines.length === 1 ? '' : 's'}
      </span>
    </div>
  );
}

export interface ExtraColumn {
  readonly header: string;
  /** Every spelling the API might have used — see `extraValue`'s note. */
  readonly keys: readonly string[];
  readonly numeric?: boolean;
}

export function DocumentLinesTable({
  document,
  extras = [],
  caption,
}: {
  readonly document: DocumentView;
  readonly extras?: readonly ExtraColumn[];
  readonly caption: string;
}): React.JSX.Element {
  if (document.lines.length === 0) {
    return (
      <EmptyState
        cause="This document has no lines."
        nextAction="A document with no lines moves nothing. It can be cancelled without consequence."
      />
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-strong bg-layer-1">
      <table className="w-full text-sm" data-testid="document-lines">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
            <th scope="col" className="px-3 py-2 text-start">
              #
            </th>
            <th scope="col" className="px-3 py-2 text-start">
              Item
            </th>
            <th scope="col" className="px-3 py-2 text-start">
              Batch · expiry
            </th>
            <th scope="col" className="px-3 py-2 text-end">
              Quantity
            </th>
            {extras.map((extra) => (
              <th
                key={extra.header}
                scope="col"
                className={`px-3 py-2 ${extra.numeric === true ? 'text-end' : 'text-start'}`}
              >
                {extra.header}
              </th>
            ))}
            <th scope="col" className="px-3 py-2 text-start">
              Status
            </th>
          </tr>
        </thead>
        <tbody>
          {document.lines.map((line) => (
            <tr key={line.id} className="border-b border-default last:border-0">
              <td className="px-3 py-2 font-mono text-2xs text-fg-subtle">{line.lineNo}</td>
              <td className="px-3 py-2">
                {line.itemName}
                <span className="ms-2 font-mono text-2xs text-fg-subtle">{line.itemCode}</span>
              </td>
              <td className="px-3 py-2 font-mono text-2xs text-fg-muted">
                {line.batchNo ?? '—'}
                {extraText(line, 'expiryDate', 'expiry_date') === null
                  ? ''
                  : ` · ${formatDate(extraText(line, 'expiryDate', 'expiry_date'))}`}
              </td>
              <td className="px-3 py-2 text-end font-mono">{formatQty(line.qtyBase)}</td>
              {extras.map((extra) => {
                const value = extraText(line, ...extra.keys);
                return (
                  <td
                    key={extra.header}
                    className={`px-3 py-2 ${extra.numeric === true ? 'text-end font-mono' : ''}`}
                  >
                    {value === null ? '—' : extra.numeric === true ? formatQty(value) : humanise(value)}
                  </td>
                );
              })}
              <td className="px-3 py-2">
                <Badge tone="neutral" className={statusTone(line.status ?? '')}>
                  {humanise(line.status)}
                </Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
