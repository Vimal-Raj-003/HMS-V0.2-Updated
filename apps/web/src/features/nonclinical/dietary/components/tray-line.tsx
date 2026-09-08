'use client';

import { useQuery } from '@tanstack/react-query';
import { Badge, EmptyState } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { useSession } from '@/lib/session-context';
import { getHoldingLimits, getRecipes, getSlots, getTrayItems, getTrays } from '../api/client';
import { dietaryKeys } from '../api/keys';
import type { MealTrayRow, RecipeRow } from '../api/types';

const TODAY = (): string => new Date().toISOString().slice(0, 10);

/**
 * NC-033 — the tray line.
 *
 * ── The menu is filtered against the patient, not against nothing ──────────
 *
 * The whole point of this screen: a tray-line worker picking dishes sees the
 * peanut chutney struck through with "this patient is allergic to peanut" on
 * it, rather than assembling a plate and discovering that at the trolley.
 *
 * ── And the two refusals look different, deliberately ──────────────────────
 *
 * An allergen refusal shows an "ask the dietician" affordance, because a
 * dietician may override it and there is a real clinical judgement behind that.
 * A swallow-order refusal shows none, because nobody may override it — and a
 * screen that offered the same button for both would teach the wrong lesson
 * about which is which.
 *
 * ── Held trays are on the board, not hidden ────────────────────────────────
 *
 * A bed with no tray and no explanation is a bed somebody chases the kitchen
 * about, and sometimes one where somebody quietly finds a biscuit.
 */
export function TrayLine(): React.JSX.Element {
  const { hospitalId } = useSession();
  const keys = dietaryKeys(hospitalId);
  const [slotId, setSlotId] = useState<string | null>(null);
  const [trayId, setTrayId] = useState<string | null>(null);
  const serviceDate = TODAY();

  const slots = useQuery({
    queryKey: keys.slots,
    queryFn: ({ signal }) => getSlots({ signal }),
    staleTime: 3_600_000,
  });

  const slotRows = slots.data ?? [];
  // Default to the next meal whose count is still open, which is the one
  // somebody standing at the tray line is actually working on.
  const activeSlot = slotId ?? slotRows.find((s) => !s.cutoffPassed)?.id ?? slotRows[0]?.id ?? null;

  const trays = useQuery({
    queryKey: keys.trays(`${serviceDate}:${activeSlot ?? 'none'}`),
    queryFn: ({ signal }) =>
      getTrays(activeSlot === null ? { serviceDate } : { serviceDate, slotId: activeSlot }, { signal }),
    refetchInterval: 60_000,
  });

  const trayRows = trays.data ?? [];
  const activeTray = trayId ?? trayRows[0]?.id ?? null;
  const held = trayRows.filter((t) => t.status === 'held_npo');

  const items = useQuery({
    queryKey: keys.items(activeTray ?? 'none'),
    queryFn: ({ signal }) =>
      activeTray === null ? Promise.resolve([]) : getTrayItems(activeTray, { signal }),
    enabled: activeTray !== null,
  });

  const recipes = useQuery({
    queryKey: keys.recipes(activeTray ?? 'none'),
    queryFn: ({ signal }) => getRecipes(activeTray ?? undefined, { signal }),
    enabled: activeTray !== null,
  });

  const limits = useQuery({
    queryKey: keys.limits,
    queryFn: ({ signal }) => getHoldingLimits({ signal }),
    staleTime: 3_600_000,
  });

  const itemRows = items.data ?? [];
  const recipeRows = recipes.data ?? [];
  const tray = trayRows.find((t) => t.id === activeTray) ?? null;

  return (
    <section className="flex flex-col gap-5">
      <PageHeader
        title="Tray line"
        description="What is on each tray comes from the diet order and the swallow order. What the kitchen owns is whether the tray goes."
      />

      <section aria-label="Meal" className="flex flex-wrap gap-2">
        {slotRows.map((slot) => (
          <button
            key={slot.id}
            type="button"
            onClick={() => {
              setSlotId(slot.id);
              setTrayId(null);
            }}
            aria-pressed={activeSlot === slot.id}
            className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${
              activeSlot === slot.id ? 'border-accent-border bg-accent-surface' : 'border-default bg-layer-1'
            }`}
          >
            <span>{slot.name}</span>
            {/* The count is frozen. Adding a tray now is a late request. */}
            {slot.cutoffPassed ? <Badge tone="neutral">count frozen</Badge> : null}
          </button>
        ))}
      </section>

      {held.length > 0 ? (
        <section
          aria-label="Trays held nil by mouth"
          className="rounded-lg border border-warning-border bg-warning-surface p-4"
        >
          <h2 className="text-sm font-semibold text-warning-on-surface">
            {held.length} {held.length === 1 ? 'tray is' : 'trays are'} held — nil by mouth
          </h2>
          <p className="mt-1 text-xs text-warning-on-surface">
            These are on the board rather than missing from it. A bed with no tray and no explanation is a bed
            somebody chases the kitchen about.
          </p>
          <ul className="mt-3 flex flex-col gap-1 text-sm">
            {held.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-3">
                <span className="font-mono text-xs">{t.bedLabel ?? '—'}</span>
                <span className="text-xs text-warning-on-surface">{t.holdReason}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-label="Trays" className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Trays</h2>
        <AsyncPanel
          loading={trays.isPending}
          error={trays.error}
          isEmpty={trayRows.length === 0}
          skeletonLabel="Loading the tray line"
          skeletonRows={5}
          onRetry={() => void trays.refetch()}
          empty={
            <EmptyState
              cause="No trays are planned for this meal."
              nextAction="Plan the ward. Everything clinical on a tray is copied from the live diet, so there is nothing to type."
            />
          }
        >
          <ul className="flex flex-col gap-2 text-sm">
            {trayRows.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  onClick={() => {
                    setTrayId(row.id);
                  }}
                  aria-pressed={activeTray === row.id}
                  className={`flex w-full flex-wrap items-center gap-3 rounded-md border p-3 text-left ${
                    activeTray === row.id
                      ? 'border-accent-border bg-accent-surface'
                      : 'border-default bg-layer-1'
                  }`}
                >
                  <span className="font-mono text-xs">{row.bedLabel ?? '—'}</span>
                  <Badge tone="neutral">{row.dietTypeCode}</Badge>
                  <TrayFlags tray={row} />
                  <span className="flex-1" />
                  <span className="text-xs text-fg-muted">{row.itemCount} dishes</span>
                  <Badge tone={statusTone(row.status)}>{row.status.replace(/_/gu, ' ')}</Badge>
                </button>
              </li>
            ))}
          </ul>
        </AsyncPanel>
      </section>

      {tray === null ? null : (
        <>
          <section aria-label="On this tray" className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold">On this tray</h2>
            <ul className="flex flex-wrap gap-2 text-sm">
              {itemRows.map((item) => (
                <li
                  key={item.id}
                  className="flex items-center gap-2 rounded-md border border-default bg-layer-1 p-2"
                >
                  <span>{item.recipeName}</span>
                  {item.overrideReason === null ? null : (
                    <Badge tone="warning" title={item.overrideReason}>
                      allergen override
                    </Badge>
                  )}
                </li>
              ))}
              {itemRows.length === 0 ? <li className="text-xs text-fg-muted">Nothing yet.</li> : null}
            </ul>
          </section>

          <section aria-label="Menu" className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold">Menu — checked against this patient</h2>
            <ul className="flex flex-wrap gap-2 text-sm">
              {recipeRows.map((recipe) => (
                <DishChip key={recipe.id} recipe={recipe} />
              ))}
            </ul>
          </section>
        </>
      )}

      {limits.data === undefined ? null : (
        <p className="text-xs text-fg-muted">
          Hot food leaves the kitchen at {(limits.data.hotMinTenthC / 10).toFixed(1)} °C or above and cold at{' '}
          {(limits.data.coldMaxTenthC / 10).toFixed(1)} °C or below. A trolley outside that is not one to
          deliver quickly — reheat it or discard it, and record which.
        </p>
      )}
    </section>
  );
}

function statusTone(status: string): 'success' | 'warning' | 'danger' | 'neutral' {
  if (status === 'delivered') return 'success';
  if (status === 'held_npo') return 'warning';
  if (status === 'refused' || status === 'returned') return 'danger';
  return 'neutral';
}

/** The two facts on a tray that decide what may go on it. */
function TrayFlags({ tray }: { readonly tray: MealTrayRow }): React.JSX.Element {
  return (
    <>
      {tray.allergens.map((a) => (
        <Badge key={a} tone="danger">
          {a}
        </Badge>
      ))}
      {tray.iddsiFoodLevel === null ? null : <Badge tone="warning">IDDSI {tray.iddsiFoodLevel}</Badge>}
    </>
  );
}

/**
 * One dish, with the reason it cannot go.
 *
 * The allergen refusal and the swallow refusal look different on purpose: one
 * says a dietician can decide otherwise, the other says nobody can. A single
 * greyed-out chip for both would teach that they are the same kind of rule.
 */
function DishChip({ recipe }: { readonly recipe: RecipeRow }): React.JSX.Element {
  if (recipe.servable) {
    return (
      <li className="flex items-center gap-2 rounded-md border border-default bg-layer-2 p-2">
        <span>{recipe.name}</span>
        <span className="text-xs text-fg-muted">IDDSI {recipe.iddsiLevel}</span>
      </li>
    );
  }

  return (
    <li
      className={`flex flex-col gap-1 rounded-md border p-2 ${
        recipe.overridable
          ? 'border-warning-border bg-warning-surface'
          : 'border-danger-border bg-danger-surface'
      }`}
    >
      <span className="line-through">{recipe.name}</span>
      <span className={`text-xs ${recipe.overridable ? 'text-warning-on-surface' : 'text-fg-danger'}`}>
        {recipe.reason}
      </span>
      <span className="text-xs text-fg-muted">
        {recipe.overridable
          ? 'A dietician may serve this over the refusal, with a reason.'
          : 'There is no override. The exception to a swallow order is a new swallow order.'}
      </span>
    </li>
  );
}
