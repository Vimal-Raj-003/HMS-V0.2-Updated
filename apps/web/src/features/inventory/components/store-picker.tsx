'use client';

import { useQuery } from '@tanstack/react-query';
import { EmptyState, Label } from '@vims/ui';
import { useEffect, useId } from 'react';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';
import { listStores } from '../api/client';
import { inventoryKeys } from '../api/keys';

/**
 * The store this screen is working in.
 *
 * Almost every screen in Phase 4 is meaningless without one — a stock balance,
 * an indent, a dispense and a day close are all *of a store* — and the store id
 * is a UUID, so it cannot be typed and must not be in the URL. So it is chosen
 * once, here, from the stores the session can actually see.
 *
 * It selects the first store automatically. That is a deliberate convenience and
 * a safe one: a pharmacist with one counter never has to choose, and a group
 * pharmacist with four sees the picker and a named store rather than a blank
 * one. What it never does is *remember* a store across sessions — a counter
 * tablet is shared, and a remembered store is the wrong store on the next shift.
 */
export function StorePicker({
  storeType,
  value,
  onChange,
  label,
}: {
  /** `pharmacy`, `main`, `ward`… or omitted for every store the session can see. */
  readonly storeType?: string;
  readonly value: string;
  readonly onChange: (storeId: string) => void;
  readonly label: string;
}): React.JSX.Element {
  const fieldId = useId();
  const { hospitalId, granted } = useSession();
  const keys = inventoryKeys(hospitalId);
  const canList = granted.has('inventory.store.list');

  const stores = useQuery({
    queryKey: keys.stores(storeType ?? 'all', 'first'),
    queryFn: ({ signal }) => listStores(storeType === undefined ? {} : { storeType }, { signal }),
    enabled: canList,
    staleTime: 5 * 60_000,
  });

  const items = stores.data?.items ?? [];
  const first = items[0];

  useEffect(() => {
    if (value === '' && first !== undefined) onChange(first.id);
  }, [value, first, onChange]);

  if (!canList) {
    return (
      <EmptyState
        cause="You cannot see the list of stores."
        nextAction="Every screen here works in one store, and the store list is a separate permission (inventory.store.list). Ask your hospital administrator to grant it — it is read-only."
      />
    );
  }

  if (stores.error !== null)
    return <ProblemCard error={stores.error} onRetry={() => void stores.refetch()} />;

  if (!stores.isPending && items.length === 0) {
    return (
      <EmptyState
        cause={`No ${storeType ?? ''} store is configured for this hospital.`}
        nextAction="A store has to exist before anything can be received into it or issued out of it. Ask your hospital administrator to create one."
      />
    );
  }

  return (
    <div className="flex min-w-56 flex-col gap-1">
      <Label htmlFor={fieldId}>{label}</Label>
      <select
        id={fieldId}
        data-testid="store-picker"
        className="h-9 rounded-md border border-control bg-layer-1 px-2 text-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
        value={value}
        disabled={stores.isPending}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        {stores.isPending ? <option value="">Loading the stores…</option> : null}
        {items.map((store) => (
          <option key={store.id} value={store.id}>
            {store.name} ({store.code})
          </option>
        ))}
      </select>
    </div>
  );
}
