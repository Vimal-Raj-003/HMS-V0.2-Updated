'use client';

import { Badge } from '@vims/ui';
import { formatDate } from '../lib/format';
import { LABEL_BASE_LOCALE, LABEL_SECOND_LOCALES } from '../lib/counter';
import type { LabelView } from '../api/types';

/**
 * The medicine labels, as they will print — `phase-04` exit gate 2: "labels
 * print in English **and** one Indian language".
 *
 * This is a preview of a print job rather than a print job: the physical label
 * goes to a ZPL/TSPL printer through the print agent (EN-005), which this build
 * does not have on the web side. What the screen *can* prove is the thing gate 2
 * is actually about — that both languages carry real dosage instructions and
 * both are on the pharmacist's screen before the bag is handed over, so a label
 * that came back empty in the patient's language is caught here rather than at
 * the patient's kitchen table.
 *
 * The instruction text comes from the API's own counselling-checklist
 * translations, falling back to the prescription's English instructions when the
 * hospital has not translated that drug. That fallback is visible rather than
 * silent: a label that quietly prints English under a Tamil heading is worse
 * than one that says it has no Tamil.
 */
export function LabelPreview({
  labels,
  secondLocale,
}: {
  readonly labels: readonly LabelView[];
  readonly secondLocale: string;
}): React.JSX.Element {
  const localeName = (code: string): string =>
    code === LABEL_BASE_LOCALE
      ? 'English (en-IN)'
      : (LABEL_SECOND_LOCALES.find((entry) => entry.code === code)?.label ?? code);

  const byItem = new Map<string, LabelView[]>();
  for (const label of labels) {
    const bucket = byItem.get(label.dispenseItemId) ?? [];
    bucket.push(label);
    byItem.set(label.dispenseItemId, bucket);
  }

  return (
    <section className="flex flex-col gap-3" data-testid="label-preview">
      <p className="text-sm text-fg-muted">
        {byItem.size === 1
          ? '1 label, in two languages.'
          : `${String(byItem.size)} labels, each in two languages.`}{' '}
        Check the {localeName(secondLocale)} line reads as instructions and not as an untranslated code before
        you hand the bag over.
      </p>

      <ul className="grid gap-3 md:grid-cols-2">
        {[...byItem.entries()].map(([itemId, forItem]) => {
          const first = forItem[0];
          if (first === undefined) return null;
          return (
            <li
              key={itemId}
              data-testid="label-card"
              className="flex flex-col gap-2 rounded-lg border border-strong bg-layer-1 p-3"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-md font-medium text-fg-default">{first.itemName}</span>
                <span className="font-mono text-2xs text-fg-subtle">Qty {first.qty}</span>
              </div>
              <div className="flex flex-wrap gap-2 font-mono text-2xs text-fg-muted">
                <span>{first.patientName}</span>
                {first.batchNo === null ? null : <span>Batch {first.batchNo}</span>}
                {first.expiryDate === null ? null : <span>Exp {formatDate(first.expiryDate)}</span>}
              </div>

              {forItem.map((label) => (
                <div
                  key={`${label.dispenseItemId}-${label.locale}`}
                  data-testid={`label-line-${label.locale}`}
                  className="rounded-md border border-default bg-layer-2 p-2"
                  lang={label.locale}
                >
                  <p className="text-3xs uppercase tracking-[0.08em] text-fg-subtle">
                    {localeName(label.locale)}
                  </p>
                  <p className="text-sm text-fg-default">{label.instructions}</p>
                </div>
              ))}

              {first.warnings.length === 0 ? null : (
                <ul className="flex flex-wrap gap-1">
                  {first.warnings.map((warning) => (
                    <li key={warning}>
                      <Badge tone="warning">{warning}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
