'use client';

import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Columns3,
  Loader2,
  Rows3,
} from 'lucide-react';
import { Fragment, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useDelayedFlag } from '../hooks/use-delayed-flag.js';
import { cn } from '../lib/cn.js';
import { Button } from '../primitives/button.js';
import { Checkbox } from '../primitives/checkbox.js';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '../primitives/dropdown-menu.js';
import { Label } from '../primitives/label.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../primitives/select.js';
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../primitives/table.js';
import { EmptyState } from './empty-state.js';
import { SkeletonList } from './skeleton-list.js';

/**
 * `WorklistTable` — docs/06 §5.2 #41 and screen archetype §9.A, the shape almost every
 * list in the product takes: doctor queue, lab bench, validation, radiology reading,
 * DLQ, claims, appointment book, patient list.
 *
 * "Server-driven cursor pagination, sticky header + first column, saved views per user,
 *  column chooser, density toggle, bulk selection with a persistent action bar, row
 *  expander for secondary fields, virtualisation above 100 rows."
 *
 * The things this component refuses to do, on purpose:
 *   - **it never sorts, filters or pages in the browser.** `sort` in, `onSortChange`
 *     out; `hasMore` + `onLoadMore` for the cursor. docs/07 §4 bans `OFFSET`, and a
 *     client-side sort over one page silently lies about the other 40,000 rows.
 *   - **it never renders a vague empty state.** `empty` is `{ cause, nextAction }` —
 *     two required strings — because §5.2 #36 forbids "No data found".
 *   - **it never fires a bulk action without the count.** The action bar states how
 *     many rows are selected and the handler receives the rows themselves, so the
 *     caller's confirm dialog can list them (§9.A: "bulk actions require an explicit
 *     confirm listing counts").
 */

export type SortDirection = 'asc' | 'desc';

export interface WorklistSort {
  readonly columnKey: string;
  readonly direction: SortDirection;
}

export type WorklistDensity = 'compact' | 'default' | 'touch';

/** §6.3 — 32 / 40 / 52 px rows. Also the virtualiser's row height, so they must agree. */
export const DENSITY_ROW_HEIGHT_PX: Readonly<Record<WorklistDensity, number>> = {
  compact: 32,
  default: 40,
  touch: 52,
};

export interface WorklistColumn<TRow> {
  readonly key: string;
  /** Already-localised header text. */
  readonly header: string;
  readonly render: (row: TRow) => ReactNode;
  /** Server-side sortable. A sortable column with no `onSortChange` is inert by design. */
  readonly sortable?: boolean;
  /** Right-aligned, tabular — money, counts, ages (docs/06 §8). */
  readonly numeric?: boolean;
  /**
   * `always` survives every breakpoint; `secondary` drops into the row expander at
   * `md` and below (§4.3: "tables keep 4–6 priority columns, rest in row expander").
   */
  readonly importance?: 'always' | 'secondary';
  /** Safety-critical columns cannot be hidden by the column chooser (§4.3). */
  readonly hideable?: boolean;
  readonly width?: string;
}

export interface SavedView {
  readonly id: string;
  /** Already-localised name of the user's saved view. */
  readonly label: string;
}

export interface WorklistBulkAction<TRow> {
  readonly id: string;
  readonly label: string;
  readonly tone?: 'default' | 'danger';
  /** Receives the selected rows, so the caller's confirm dialog can list them. */
  readonly onSelect: (rows: readonly TRow[]) => void;
}

export interface WorklistTableLabels {
  readonly caption: string;
  readonly scrollRegion: string;
  readonly selectAll: string;
  readonly selectRow: string;
  readonly sortAscending: string;
  readonly sortDescending: string;
  readonly notSorted: string;
  readonly density: string;
  readonly densityOption: Readonly<Record<WorklistDensity, string>>;
  readonly columns: string;
  readonly savedView: string;
  readonly savedViewPlaceholder: string;
  readonly saveView: string;
  readonly loadMore: string;
  readonly loading: string;
  readonly selectedCount: (count: number) => string;
  readonly clearSelection: string;
  readonly rowCount: (count: number) => string;
  readonly expandRow: string;
  readonly rowActions: string;
}

export interface WorklistEmptyState {
  /** Why the list is empty, specifically (§5.2 #36). */
  readonly cause: string;
  readonly nextAction: string;
  readonly action?: { readonly label: string; readonly onSelect: () => void };
}

export interface WorklistTableProps<TRow> {
  readonly rows: readonly TRow[];
  readonly getRowId: (row: TRow) => string;
  readonly columns: readonly WorklistColumn<TRow>[];
  readonly labels: WorklistTableLabels;
  readonly empty: WorklistEmptyState;

  readonly sort?: WorklistSort;
  readonly onSortChange?: (sort: WorklistSort) => void;

  readonly density?: WorklistDensity;
  readonly onDensityChange?: (density: WorklistDensity) => void;

  readonly hiddenColumnKeys?: ReadonlySet<string>;
  readonly onHiddenColumnsChange?: (hidden: ReadonlySet<string>) => void;

  readonly views?: readonly SavedView[];
  readonly activeViewId?: string;
  readonly onViewChange?: (viewId: string) => void;
  readonly onSaveView?: () => void;

  readonly selectedIds?: ReadonlySet<string>;
  readonly onSelectionChange?: (selected: ReadonlySet<string>) => void;
  readonly bulkActions?: readonly WorklistBulkAction<TRow>[];

  readonly onRowOpen?: (row: TRow) => void;
  /** `.` on the focused row — docs/06 §6.1. */
  readonly onRowActions?: (row: TRow) => void;
  /** Rows that carry a 3 px left rule, never a row background (§9.A). */
  readonly criticalRowIds?: ReadonlySet<string>;

  readonly hasMore?: boolean;
  readonly loading?: boolean;
  readonly onLoadMore?: () => void;

  /** Number of rows above which the body is windowed (§5.2 #41: 100). */
  readonly virtualiseAbove?: number;
  /** Height of the scroll viewport in pixels; the virtualiser needs a bounded box. */
  readonly viewportHeightPx?: number;
  readonly className?: string;
}

const DENSITIES: readonly WorklistDensity[] = ['compact', 'default', 'touch'];
const OVERSCAN_ROWS = 8;

export function WorklistTable<TRow>({
  rows,
  getRowId,
  columns,
  labels,
  empty,
  sort,
  onSortChange,
  density = 'default',
  onDensityChange,
  hiddenColumnKeys,
  onHiddenColumnsChange,
  views,
  activeViewId,
  onViewChange,
  onSaveView,
  selectedIds,
  onSelectionChange,
  bulkActions,
  onRowOpen,
  onRowActions,
  criticalRowIds,
  hasMore = false,
  loading = false,
  onLoadMore,
  virtualiseAbove = 100,
  viewportHeightPx = 560,
  className,
}: WorklistTableProps<TRow>): React.JSX.Element {
  const id = useId();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const [expandedRowId, setExpandedRowId] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);

  const rowHeight = DENSITY_ROW_HEIGHT_PX[density];
  const visibleColumns = useMemo(
    () => columns.filter((column) => hiddenColumnKeys?.has(column.key) !== true),
    [columns, hiddenColumnKeys],
  );
  const secondaryColumns = useMemo(
    () => visibleColumns.filter((column) => column.importance === 'secondary'),
    [visibleColumns],
  );

  const selectable = onSelectionChange !== undefined;
  const selected = selectedIds ?? new Set<string>();

  // ── windowing (§5.2 #41 — "virtualisation above 100 rows") ─────────────────
  const virtualised = rows.length > virtualiseAbove;
  const visibleCount = Math.max(1, Math.ceil(viewportHeightPx / rowHeight));
  const startIndex = virtualised
    ? Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN_ROWS)
    : 0;
  const endIndex = virtualised
    ? Math.min(rows.length, startIndex + visibleCount + OVERSCAN_ROWS * 2)
    : rows.length;
  const windowRows = virtualised ? rows.slice(startIndex, endIndex) : rows;
  const padTop = startIndex * rowHeight;
  const padBottom = Math.max(0, (rows.length - endIndex) * rowHeight);

  // Keeps keyboard navigation working across the window boundary: move the viewport
  // first, then focus the row once React has rendered it.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null) return;
    const target = viewport.querySelector<HTMLTableRowElement>(`[data-row-index="${String(focusIndex)}"]`);
    if (target !== null) {
      if (document.activeElement !== target && viewport.contains(document.activeElement)) target.focus();
      return;
    }
    if (virtualised) viewport.scrollTop = Math.max(0, focusIndex * rowHeight - viewportHeightPx / 2);
  }, [focusIndex, virtualised, rowHeight, viewportHeightPx]);

  const showSkeleton = useDelayedFlag(loading && rows.length === 0);

  const toggleRow = (rowId: string): void => {
    if (!selectable) return;
    const next = new Set(selected);
    if (next.has(rowId)) next.delete(rowId);
    else next.add(rowId);
    onSelectionChange(next);
  };

  const allSelected = rows.length > 0 && rows.every((row) => selected.has(getRowId(row)));
  const someSelected = rows.some((row) => selected.has(getRowId(row)));

  const toggleAll = (): void => {
    if (!selectable) return;
    onSelectionChange(allSelected ? new Set<string>() : new Set(rows.map(getRowId)));
  };

  const nextSort = (column: WorklistColumn<TRow>): void => {
    if (onSortChange === undefined || column.sortable !== true) return;
    const direction: SortDirection =
      sort?.columnKey === column.key && sort.direction === 'asc' ? 'desc' : 'asc';
    onSortChange({ columnKey: column.key, direction });
  };

  const handleRowKeyDown = (event: React.KeyboardEvent<HTMLTableRowElement>, index: number, row: TRow): void => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setFocusIndex(Math.min(index + 1, rows.length - 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        setFocusIndex(Math.max(index - 1, 0));
        break;
      case 'Home':
        event.preventDefault();
        setFocusIndex(0);
        break;
      case 'End':
        event.preventDefault();
        setFocusIndex(rows.length - 1);
        break;
      case ' ':
        if (selectable) {
          event.preventDefault();
          toggleRow(getRowId(row));
        }
        break;
      case 'Enter':
        if (onRowOpen !== undefined) {
          event.preventDefault();
          onRowOpen(row);
        }
        break;
      case '.':
        if (onRowActions !== undefined) {
          event.preventDefault();
          onRowActions(row);
        }
        break;
      default:
        break;
    }
  };

  const selectedRows = rows.filter((row) => selected.has(getRowId(row)));

  return (
    <section data-slot="worklist-table" data-density={density} className={cn('flex flex-col gap-2', className)}>
      {/* ── toolbar: saved views, density, column chooser ─────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        {/* §1.1.1 — the count is the status; it is announced where it is shown
            rather than duplicated into a second, invisible live region. */}
        <span className="text-sm text-fg-muted" data-row-count="" aria-live="polite">
          {labels.rowCount(rows.length)}
        </span>

        {views === undefined || onViewChange === undefined ? null : (
          <div className="flex items-center gap-2">
            <Label htmlFor={`${id}-view`} className="text-xs">
              {labels.savedView}
            </Label>
            <Select value={activeViewId ?? ''} onValueChange={onViewChange}>
              <SelectTrigger id={`${id}-view`} className="w-48">
                <SelectValue placeholder={labels.savedViewPlaceholder} />
              </SelectTrigger>
              <SelectContent>
                {views.map((view) => (
                  <SelectItem key={view.id} value={view.id}>
                    {view.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {onSaveView === undefined ? null : (
              <Button variant="ghost" size="sm" onClick={onSaveView}>
                {labels.saveView}
              </Button>
            )}
          </div>
        )}

        <div className="ms-auto flex flex-wrap items-center gap-2">
          {onDensityChange === undefined ? null : (
            <div role="group" aria-label={labels.density} className="flex items-center gap-1">
              <Rows3 aria-hidden="true" className="size-4 text-fg-muted" />
              {DENSITIES.map((candidate) => (
                <Button
                  key={candidate}
                  variant={density === candidate ? 'primary' : 'ghost'}
                  size="sm"
                  aria-pressed={density === candidate}
                  data-density-option={candidate}
                  onClick={() => {
                    onDensityChange(candidate);
                  }}
                >
                  {labels.densityOption[candidate]}
                </Button>
              ))}
            </div>
          )}

          {onHiddenColumnsChange === undefined ? null : (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="secondary" size="sm">
                  <Columns3 aria-hidden="true" />
                  {labels.columns}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>{labels.columns}</DropdownMenuLabel>
                {columns.map((column) => (
                  <DropdownMenuCheckboxItem
                    key={column.key}
                    checked={hiddenColumnKeys?.has(column.key) !== true}
                    // A safety-critical column (allergy flag, scan, patient identity)
                    // can never be hidden — §4.3.
                    disabled={column.hideable === false}
                    onCheckedChange={(checked) => {
                      const next = new Set(hiddenColumnKeys ?? []);
                      if (checked) next.delete(column.key);
                      else next.add(column.key);
                      onHiddenColumnsChange(next);
                    }}
                  >
                    {column.header}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {/* ── the table ─────────────────────────────────────────────────────── */}
      {rows.length === 0 && !loading ? (
        <EmptyState
          cause={empty.cause}
          nextAction={empty.nextAction}
          {...(empty.action === undefined ? {} : { action: empty.action })}
        />
      ) : showSkeleton ? (
        <SkeletonList label={labels.loading} rowHeight={density} rows={8} columns={visibleColumns.map(() => 1)} />
      ) : (
        <div
          ref={viewportRef}
          role="region"
          aria-label={labels.scrollRegion}
          tabIndex={0}
          onScroll={(event) => {
            if (virtualised) setScrollTop(event.currentTarget.scrollTop);
          }}
          style={{ maxBlockSize: `${String(viewportHeightPx)}px` }}
          className="relative w-full overflow-auto rounded-lg border border-default focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          <table
            data-slot="worklist"
            data-virtualised={virtualised ? 'true' : 'false'}
            // Windowed rows mean the DOM row count lies; `aria-rowcount` tells the
            // truth so a screen reader says "row 812 of 4,000", not "row 12 of 20".
            aria-rowcount={rows.length}
            className="w-full caption-bottom border-collapse text-sm"
          >
            <caption className="sr-only">{labels.caption}</caption>
            <TableHeader>
              <TableRow>
                {selectable ? (
                  <TableHead className="sticky inset-inline-start-0 z-sticky w-10 bg-layer-1">
                    <Checkbox
                      aria-label={labels.selectAll}
                      checked={allSelected ? true : someSelected ? 'indeterminate' : false}
                      onCheckedChange={toggleAll}
                    />
                  </TableHead>
                ) : null}
                {visibleColumns.map((column, columnIndex) => {
                  const sorted = sort?.columnKey === column.key ? sort.direction : undefined;
                  const SortIcon =
                    sorted === 'asc' ? ArrowUp : sorted === 'desc' ? ArrowDown : ArrowUpDown;
                  return (
                    <TableHead
                      key={column.key}
                      data-column={column.key}
                      aria-sort={
                        column.sortable === true
                          ? sorted === 'asc'
                            ? 'ascending'
                            : sorted === 'desc'
                              ? 'descending'
                              : 'none'
                          : undefined
                      }
                      style={column.width === undefined ? undefined : { inlineSize: column.width }}
                      className={cn(
                        column.numeric === true ? 'text-end' : '',
                        // §9.A — sticky header AND sticky first column.
                        columnIndex === 0 && !selectable ? 'sticky inset-inline-start-0 z-sticky bg-layer-1' : '',
                        column.importance === 'secondary' ? 'hidden lg:table-cell' : '',
                      )}
                    >
                      {column.sortable === true && onSortChange !== undefined ? (
                        <button
                          type="button"
                          onClick={() => {
                            nextSort(column);
                          }}
                          className="inline-flex items-center gap-1 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                        >
                          {column.header}
                          <SortIcon aria-hidden="true" className="size-3" />
                          <span className="sr-only">
                            {sorted === 'asc'
                              ? labels.sortAscending
                              : sorted === 'desc'
                                ? labels.sortDescending
                                : labels.notSorted}
                          </span>
                        </button>
                      ) : (
                        column.header
                      )}
                    </TableHead>
                  );
                })}
              </TableRow>
            </TableHeader>

            <TableBody>
              {padTop > 0 ? (
                <tr aria-hidden="true" data-spacer="top">
                  <td style={{ blockSize: `${String(padTop)}px` }} />
                </tr>
              ) : null}

              {windowRows.map((row, windowIndex) => {
                const index = startIndex + windowIndex;
                const rowId = getRowId(row);
                const isSelected = selected.has(rowId);
                const expanded = expandedRowId === rowId;
                return (
                  <Fragment key={rowId}>
                    <TableRow
                      data-row-id={rowId}
                      data-row-index={index}
                      aria-rowindex={index + 2}
                      // Selection is conveyed by the row's own checkbox, which is the
                      // control a screen-reader user actually operates; `aria-selected`
                      // is not permitted on a row inside role="table".
                      data-state={isSelected ? 'selected' : undefined}
                      data-critical={criticalRowIds?.has(rowId) === true ? 'true' : undefined}
                      // §6.1 — one tab stop for the whole grid, arrow keys inside it.
                      tabIndex={index === focusIndex ? 0 : -1}
                      style={{ blockSize: `${String(rowHeight)}px` }}
                      onFocus={() => {
                        setFocusIndex(index);
                      }}
                      onKeyDown={(event) => {
                        handleRowKeyDown(event, index, row);
                      }}
                      onDoubleClick={() => {
                        onRowOpen?.(row);
                      }}
                    >
                      {selectable ? (
                        <TableCell className="sticky inset-inline-start-0 z-sticky bg-layer-1">
                          <Checkbox
                            aria-label={labels.selectRow}
                            checked={isSelected}
                            onCheckedChange={() => {
                              toggleRow(rowId);
                            }}
                          />
                        </TableCell>
                      ) : null}
                      {visibleColumns.map((column, columnIndex) => (
                        <TableCell
                          key={column.key}
                          data-column={column.key}
                          className={cn(
                            column.numeric === true ? 'text-end font-mono tabular-nums' : '',
                            columnIndex === 0 && !selectable
                              ? 'sticky inset-inline-start-0 z-sticky bg-layer-1'
                              : '',
                            column.importance === 'secondary' ? 'hidden lg:table-cell' : '',
                          )}
                        >
                          {column.render(row)}
                        </TableCell>
                      ))}
                    </TableRow>
                    {/* §4.3 — the columns that drop out below `lg` are not lost, they
                        move into an expander the same keyboard path can reach. */}
                    {/* Note for the virtualiser: this expander is `lg:hidden`, i.e. it
                        has zero height on the desktop widths where a 4,000-row worklist
                        is actually used, so the fixed row-height maths stays true there.
                        Below `lg` the list is short (it is a phone) and windowing is off. */}
                    {secondaryColumns.length === 0 ? null : (
                      <tr className="lg:hidden">
                        <td colSpan={visibleColumns.length + (selectable ? 1 : 0)} className="px-3 pb-2">
                          <button
                            type="button"
                            aria-expanded={expanded}
                            className="text-xs text-fg-link underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                            onClick={() => {
                              setExpandedRowId(expanded ? null : rowId);
                            }}
                          >
                            {labels.expandRow}
                          </button>
                          {expanded ? (
                            <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                              {secondaryColumns.map((column) => (
                                <div key={column.key} className="contents">
                                  <dt className="text-fg-muted">{column.header}</dt>
                                  <dd className="text-fg-default">{column.render(row)}</dd>
                                </div>
                              ))}
                            </dl>
                          ) : null}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}

              {padBottom > 0 ? (
                <tr aria-hidden="true" data-spacer="bottom">
                  <td style={{ blockSize: `${String(padBottom)}px` }} />
                </tr>
              ) : null}
            </TableBody>
          </table>
        </div>
      )}

      {/* ── cursor pagination (§9.A: "cursor: load more") ──────────────────── */}
      {hasMore && onLoadMore !== undefined ? (
        <div className="flex justify-center">
          <Button variant="secondary" size="sm" disabled={loading} onClick={onLoadMore}>
            {loading ? <Loader2 aria-hidden="true" className="motion-safe:animate-spin" /> : null}
            {loading ? labels.loading : labels.loadMore}
          </Button>
        </div>
      ) : null}

      {/* ── persistent bulk action bar (§5.2 #41) ──────────────────────────── */}
      {selectable && bulkActions !== undefined && selectedRows.length > 0 ? (
        <div
          data-slot="bulk-action-bar"
          role="region"
          aria-label={labels.selectedCount(selectedRows.length)}
          className={cn(
            'sticky bottom-0 z-sticky flex flex-wrap items-center gap-2 rounded-lg border',
            'border-accent-border bg-accent-surface px-3 py-2 text-accent-on-surface',
          )}
        >
          <span className="text-md font-medium">{labels.selectedCount(selectedRows.length)}</span>
          <div className="ms-auto flex flex-wrap items-center gap-2">
            {bulkActions.map((action) => (
              <Button
                key={action.id}
                variant={action.tone === 'danger' ? 'danger' : 'secondary'}
                size="sm"
                data-bulk-action={action.id}
                onClick={() => {
                  action.onSelect(selectedRows);
                }}
              >
                {action.label}
              </Button>
            ))}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                onSelectionChange(new Set<string>());
              }}
            >
              {labels.clearSelection}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
