'use client';

import { useQuery } from '@tanstack/react-query';
import { Badge, Button, EmptyState, Input, Label } from '@vims/ui';
import { useId, useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { useSession } from '@/lib/session-context';
import { searchDrugs } from '../api/client';
import { clinicalKeys } from '../api/keys';
import type { DrugSearchResult } from '../api/types';

/**
 * Drug search — OP-002 §3.3, "generic/brand, ≤ 100 ms".
 *
 * Three things travel with every result because they change what a prescriber
 * does, and hiding them behind a detail view is how they get missed:
 *
 *  - **schedule** (H, H1, X, NDPS): a Schedule X entry needs a different pad and
 *    a different permission, and the prescriber should know before they build
 *    the line rather than at the refusal;
 *  - **high alert**: the drugs a hospital's own list says kill people when they
 *    go wrong;
 *  - **look-alike/sound-alike**, rendered in the master's tall-man form where it
 *    has one. `predniSONE` and `predniSOLONE` are one keystroke apart and are
 *    not the same drug.
 *
 * The query needs two characters — the API's own minimum — and is only issued
 * once the field has them, so an empty box makes no request.
 */
export function DrugSearch({
  onSelect,
  disabled,
}: {
  readonly onSelect: (drug: DrugSearchResult) => void;
  readonly disabled: boolean;
}): React.JSX.Element {
  const { hospitalId } = useSession();
  const keys = clinicalKeys(hospitalId);
  const inputId = useId();
  const [term, setTerm] = useState('');

  const trimmed = term.trim();
  const enabled = trimmed.length >= 2;

  const results = useQuery({
    queryKey: keys.drugSearch(trimmed),
    queryFn: ({ signal }) => searchDrugs(trimmed, { signal }),
    enabled,
    staleTime: 60_000,
  });

  const items = results.data?.items ?? [];

  return (
    <section className="flex flex-col gap-2" data-testid="drug-search">
      <Label htmlFor={inputId}>Find a drug</Label>
      <Input
        id={inputId}
        data-testid="drug-search-input"
        value={term}
        autoComplete="off"
        spellCheck={false}
        placeholder="Generic or brand — at least two letters"
        disabled={disabled}
        onChange={(event) => {
          setTerm(event.target.value);
        }}
      />

      {!enabled ? (
        <p className="text-2xs text-fg-muted">Type at least two letters. Nothing is searched before that.</p>
      ) : (
        <AsyncPanel
          loading={results.isLoading}
          error={results.error}
          isEmpty={items.length === 0}
          skeletonLabel="Searching the drug master"
          skeletonRows={4}
          onRetry={() => void results.refetch()}
          empty={
            <EmptyState
              cause={`Nothing in the drug master matches “${trimmed}”.`}
              nextAction="Check the spelling, or add the line by name if the drug is being recommended rather than dispensed here."
            />
          }
        >
          <ul className="flex flex-col gap-1" data-testid="drug-results">
            {items.map((drug) => (
              <li key={drug.record_key}>
                <Button
                  variant="ghost"
                  block
                  className="justify-start text-left"
                  data-testid={`drug-option-${drug.code}`}
                  disabled={disabled}
                  onClick={() => {
                    onSelect(drug);
                  }}
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-sm text-fg-default">
                      {drug.tall_man_display ?? drug.generic_name}
                    </span>
                    {drug.strength_text === null ? null : (
                      <span className="text-2xs text-fg-muted">{drug.strength_text}</span>
                    )}
                    {drug.brand_name === null ? null : (
                      <span className="text-2xs text-fg-subtle">{drug.brand_name}</span>
                    )}
                    {drug.is_high_alert ? (
                      <Badge tone="danger" size="sm">
                        High alert
                      </Badge>
                    ) : null}
                    {drug.is_lasa ? (
                      <Badge tone="warning" size="sm">
                        Look-alike
                      </Badge>
                    ) : null}
                    <Badge tone="neutral" size="sm">
                      Schedule {drug.schedule.toUpperCase()}
                    </Badge>
                    {drug.in_formulary ? null : (
                      <Badge tone="info" size="sm">
                        Not in formulary
                      </Badge>
                    )}
                  </span>
                </Button>
              </li>
            ))}
          </ul>
        </AsyncPanel>
      )}
    </section>
  );
}
