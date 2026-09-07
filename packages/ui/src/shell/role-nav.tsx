'use client';

import { ChevronDown } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { cn } from '../lib/cn.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '../primitives/tooltip.js';

/**
 * `RoleNav` — docs/06 §4.1: "generated from the user's permission set — **never render
 * an item the user cannot use**. Max 2 levels; each item shows a live count badge where
 * meaningful. Collapses to a 56 px icon rail with tooltips; state persists per user per
 * device."
 *
 * The permission filter is applied here rather than at the call site so no screen can
 * forget it: an item whose `permission` is absent from `grantedPermissions` is dropped,
 * along with any parent left with no children.
 */
export interface RoleNavItem {
  readonly key: string;
  /** Already-localised label. */
  readonly label: string;
  readonly href: string;
  readonly icon?: ReactNode;
  /** Permission key from `@vims/contracts` — the item is hidden without it. */
  readonly permission?: string;
  /**
   * Licence key from `@vims/contracts` — the item is hidden when the hospital
   * has not bought the module.
   *
   * A permission answers "may this person"; an entitlement answers "did this
   * hospital buy it". Both must be true before an item is drawn, and a module
   * that is switched off must leave no door behind — `phase-08` gate 11 asks
   * for exactly that, console by console.
   */
  readonly entitlement?: string;
  /** Live count badge (Rx queue, pending validations, DLQ…). */
  readonly count?: number;
  /** Max 2 levels (docs/06 §4.1). */
  readonly children?: readonly RoleNavItem[];
}

export interface RoleNavProps {
  readonly items: readonly RoleNavItem[];
  readonly grantedPermissions: ReadonlySet<string>;
  /**
   * The `module.*` keys the hospital's licence allows.
   *
   * Optional so a caller with no licence state — a story, a test of the
   * permission filter alone — behaves as it always did. Omitting it means
   * "licensing is not being modelled here", not "nothing is licensed": the
   * alternative would empty the menu for every existing caller.
   */
  readonly licensedModules?: ReadonlySet<string>;
  readonly activeKey?: string;
  readonly collapsed?: boolean;
  /** Accessible name of the navigation landmark, from the caller's i18n catalogue. */
  readonly label: string;
  readonly onNavigate?: (item: RoleNavItem) => void;
  readonly className?: string;
}

export function filterByPermission(
  items: readonly RoleNavItem[],
  granted: ReadonlySet<string>,
  licensed?: ReadonlySet<string>,
): RoleNavItem[] {
  const out: RoleNavItem[] = [];
  for (const item of items) {
    if (item.permission !== undefined && !granted.has(item.permission)) continue;
    if (item.entitlement !== undefined && licensed !== undefined && !licensed.has(item.entitlement)) {
      continue;
    }
    const children =
      item.children === undefined ? undefined : filterByPermission(item.children, granted, licensed);
    // A group whose every child was filtered away is a door onto an empty room.
    if (item.children !== undefined && (children === undefined || children.length === 0)) continue;
    out.push(children === undefined ? item : { ...item, children });
  }
  return out;
}

const itemClassName = cn(
  'flex w-full items-center gap-2 rounded-md px-2 py-2 text-md text-fg-default',
  'hover:bg-layer-3',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
  'aria-[current=page]:bg-accent-surface aria-[current=page]:text-accent-on-surface aria-[current=page]:font-medium',
  '[&_svg]:size-4 [&_svg]:shrink-0',
);

function CountBadge({ count }: { readonly count: number }): React.JSX.Element {
  return (
    <span className="ms-auto rounded-full bg-sunken px-1.5 text-2xs font-medium tabular-nums text-fg-default">
      {count}
    </span>
  );
}

function Leaf({
  item,
  collapsed,
  active,
  onNavigate,
}: {
  readonly item: RoleNavItem;
  readonly collapsed: boolean;
  readonly active: boolean;
  readonly onNavigate?: (item: RoleNavItem) => void;
}): React.JSX.Element {
  const link = (
    <a
      href={item.href}
      aria-current={active ? 'page' : undefined}
      onClick={(event) => {
        if (onNavigate !== undefined) {
          event.preventDefault();
          onNavigate(item);
        }
      }}
      className={cn(itemClassName, collapsed && 'justify-center px-0')}
    >
      {item.icon}
      {collapsed ? <span className="sr-only">{item.label}</span> : <span>{item.label}</span>}
      {!collapsed && item.count !== undefined ? <CountBadge count={item.count} /> : null}
    </a>
  );

  // §4.1 — the icon rail keeps its labels available through tooltips.
  return collapsed ? (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right">{item.label}</TooltipContent>
    </Tooltip>
  ) : (
    link
  );
}

function Branch({
  item,
  collapsed,
  activeKey,
  onNavigate,
}: {
  readonly item: RoleNavItem;
  readonly collapsed: boolean;
  readonly activeKey?: string;
  readonly onNavigate?: (item: RoleNavItem) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(() => item.children?.some((child) => child.key === activeKey) ?? false);
  const panelId = `role-nav-${item.key}`;

  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          setOpen((value) => !value);
        }}
        className={cn(itemClassName, collapsed && 'justify-center px-0')}
      >
        {item.icon}
        {collapsed ? <span className="sr-only">{item.label}</span> : <span>{item.label}</span>}
        {collapsed ? null : (
          <ChevronDown
            className={cn('ms-auto transition-transform duration-fast', open && 'rotate-180')}
            aria-hidden="true"
          />
        )}
      </button>
      <ul id={panelId} hidden={!open} className="flex flex-col gap-0.5 ps-4">
        {(item.children ?? []).map((child) => (
          <li key={child.key}>
            <Leaf
              item={child}
              collapsed={collapsed}
              active={child.key === activeKey}
              {...(onNavigate === undefined ? {} : { onNavigate })}
            />
          </li>
        ))}
      </ul>
    </li>
  );
}

export function RoleNav({
  items,
  grantedPermissions,
  licensedModules,
  activeKey,
  collapsed = false,
  label,
  onNavigate,
  className,
}: RoleNavProps): React.JSX.Element {
  const visible = filterByPermission(items, grantedPermissions, licensedModules);

  return (
    <nav
      data-slot="role-nav"
      data-collapsed={collapsed ? 'true' : 'false'}
      aria-label={label}
      className={cn(
        'flex h-full shrink-0 flex-col gap-0.5 overflow-y-auto border-e border-default bg-layer-1 p-2',
        collapsed ? 'w-14' : 'w-60',
        className,
      )}
    >
      <ul className="flex flex-col gap-0.5">
        {visible.map((item) =>
          item.children === undefined ? (
            <li key={item.key}>
              <Leaf
                item={item}
                collapsed={collapsed}
                active={item.key === activeKey}
                {...(onNavigate === undefined ? {} : { onNavigate })}
              />
            </li>
          ) : (
            <Branch
              key={item.key}
              item={item}
              collapsed={collapsed}
              {...(activeKey === undefined ? {} : { activeKey })}
              {...(onNavigate === undefined ? {} : { onNavigate })}
            />
          ),
        )}
      </ul>
    </nav>
  );
}
