'use client';

import { useQuery } from '@tanstack/react-query';
import { Badge, EmptyState } from '@vims/ui';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { useSession } from '@/lib/session-context';
import { getDietPlans } from '../api/client';
import { therapyKeys } from '../api/keys';
import type { DietPlanRow } from '../api/types';

/** The nutrients a restriction can be written against, and what to call them. */
const NUTRIENTS: readonly { readonly key: string; readonly label: string; readonly unit: string }[] = [
  { key: 'kcal', label: 'Energy', unit: 'kcal' },
  { key: 'protein', label: 'Protein', unit: 'g' },
  { key: 'carb', label: 'Carbohydrate', unit: 'g' },
  { key: 'fat', label: 'Fat', unit: 'g' },
  { key: 'na', label: 'Sodium', unit: 'mg' },
  { key: 'k', label: 'Potassium', unit: 'mg' },
  { key: 'po4', label: 'Phosphate', unit: 'mg' },
];

/** Which restriction key limits which nutrient. Mirrors the trigger's map. */
const RESTRICTION_OF: Readonly<Record<string, string>> = {
  kcal: 'kcalMax',
  protein: 'proteinMaxG',
  na: 'naMg',
  k: 'kMg',
  po4: 'po4Mg',
};

/**
 * OP-011 — dietetics.
 *
 * ── The totals are the plan, and they are read-only ────────────────────────
 *
 * Every column here is summed by the database from the meals and the food
 * composition tables. The screen's job is to show the summed value beside the
 * restriction it has to respect, because a renal plan 1,100 mg over on
 * potassium is arithmetic nobody does by eye — and the plan that breaks its own
 * limit is refused before it reaches a kitchen either way.
 *
 * ── The variance is the useful number ──────────────────────────────────────
 *
 * A plan aiming at 1,800 kcal whose meals add to 568 is not a rounding error,
 * it is a plan somebody stopped building halfway through. The usual way a
 * dietician discovers it is a patient who lost weight they were meant to gain.
 */
export function NutritionScreen(): React.JSX.Element {
  const { hospitalId } = useSession();
  const keys = therapyKeys(hospitalId);

  const plans = useQuery({
    queryKey: keys.dietPlans('all'),
    queryFn: ({ signal }) => getDietPlans({}, { signal }),
    refetchInterval: 120_000,
  });

  const rows = plans.data ?? [];
  const active = rows.filter((p) => p.status === 'active');

  return (
    <section className="flex flex-col gap-5">
      <PageHeader
        title="Dietetics & nutrition"
        description="Diet plans and what they actually contain — energy, macros and minerals summed from the meals rather than typed at the top."
      />

      <AsyncPanel
        loading={plans.isPending}
        error={plans.error}
        isEmpty={rows.length === 0}
        skeletonLabel="Loading diet plans"
        skeletonRows={5}
        onRetry={() => void plans.refetch()}
        empty={
          <EmptyState
            cause="No diet plan has been built."
            nextAction="Assess a patient, then build a plan from the food list; its totals are computed as you go."
          />
        }
      >
        <ul className="flex flex-col gap-3">
          {rows.map((plan) => (
            <PlanCard key={plan.id} plan={plan} />
          ))}
        </ul>
      </AsyncPanel>

      {active.length === 0 ? null : (
        <p className="text-xs text-fg-muted">
          {active.length} active {active.length === 1 ? 'plan' : 'plans'}. One per patient — a kitchen reading
          two acts on whichever it saw.
        </p>
      )}
    </section>
  );
}

/**
 * A nutrient value, or nothing.
 *
 * The totals and restrictions blobs are `unknown` at the type level because
 * they come back as free-form JSON, and `pg` hands numerics back as strings.
 * Anything that is not a finite number is not a nutrient value, so it shows as
 * a dash rather than as "[object Object]".
 */
function amount(blob: Record<string, unknown>, key: string | undefined): number | null {
  if (key === undefined) return null;
  const raw = blob[key];
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string') {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function PlanCard({ plan }: { readonly plan: DietPlanRow }): React.JSX.Element {
  const totals = plan.totals;
  const restrictions = plan.restrictions;

  return (
    <li className="rounded-md border border-default bg-layer-1 p-3">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="font-medium">{plan.name}</span>
        <Badge tone={plan.status === 'active' ? 'success' : 'neutral'}>{plan.status}</Badge>
        <span className="font-mono text-xs text-fg-muted">
          from {new Date(plan.validFrom).toLocaleDateString()}
          {plan.validTo === null ? '' : ` to ${new Date(plan.validTo).toLocaleDateString()}`}
        </span>
        {plan.kcalVariancePct === null ? null : (
          <Badge tone={Math.abs(plan.kcalVariancePct) > 15 ? 'warning' : 'neutral'}>
            {plan.kcalVariancePct > 0 ? '+' : ''}
            {plan.kcalVariancePct}% against target
          </Badge>
        )}
      </div>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[40rem] text-sm">
          <caption className="sr-only">
            What this plan contains, summed from its meals, beside any restriction it has to respect.
          </caption>
          <thead className="text-left text-xs uppercase tracking-wide text-fg-muted">
            <tr>
              <th scope="col" className="py-1">
                Nutrient
              </th>
              <th scope="col" title="Summed from the meals">
                In the plan
              </th>
              <th scope="col">Restricted to</th>
            </tr>
          </thead>
          <tbody>
            {NUTRIENTS.map((n) => {
              const value = amount(totals, n.key);
              const limit = amount(restrictions, RESTRICTION_OF[n.key]);
              // The database refuses this plan outright, so seeing it here means
              // somebody is looking at a draft they are about to be stopped on.
              const over = value !== null && limit !== null && value > limit;
              return (
                <tr key={n.key} className="border-t border-default">
                  <th scope="row" className="py-1 text-left font-normal">
                    {n.label}
                  </th>
                  <td className={over ? 'font-semibold text-fg-danger' : ''}>
                    {value === null ? '—' : `${value.toLocaleString('en-IN')} ${n.unit}`}
                  </td>
                  <td className="text-fg-muted">
                    {limit === null ? '—' : `${limit.toLocaleString('en-IN')} ${n.unit}`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {plan.meals.length === 0 ? null : (
        <p className="mt-2 text-xs text-fg-muted">
          {plan.meals.length} {plan.meals.length === 1 ? 'meal' : 'meals'}
          {plan.costPerDay === null ? '' : ` · ₹${plan.costPerDay.toLocaleString('en-IN')} a day`}
        </p>
      )}
    </li>
  );
}
