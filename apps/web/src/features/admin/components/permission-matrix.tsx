'use client';

import {
  Badge,
  Button,
  Checkbox,
  ConfirmWithReasonDialog,
  EmptyState,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@vims/ui';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Check, Copy, Minus, ScanSearch, ShieldAlert, TriangleAlert } from '@/lib/icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PermissionCatalogue, PermissionDefinition, RoleDetail, RoleListItem } from '../api/types';
import { formatCount } from '../lib/format';
import {
  DANGER_LEGEND,
  EMPTY_FILTER,
  actionsIn,
  applyBulk,
  computeDiff,
  dangerNotes,
  filterModules,
  flattenGroups,
  groupState,
  isFilterActive,
  permissionsToSave,
  riskTone,
  sodRulesFor,
  sodViolations,
  toggleKey,
  type MatrixFilter,
  type MatrixRow,
} from '../lib/matrix';

/**
 * The permission-matrix editor (EN-007 §3.3, §8 "Roles & Permissions").
 *
 * The scale problem is real: the Phase-0 catalogue is 212 keys and the seeded
 * template set is 64 roles, so the naive rendering is ~13,600 live checkboxes and
 * 64 role fetches on first paint. Three decisions make it tractable, and each of
 * them is a product decision rather than a rendering trick:
 *
 *  1. **One role is edited, several are compared.** Nobody edits sixty-four roles
 *     at once; they edit one and want to know how it differs from the template it
 *     came from. So the grid is `permissions × (edited role + up to four
 *     comparison columns)` and only those columns are fetched. The full
 *     64-column view would need a `GET /roles?expand=permissions` the API does
 *     not have, and rendering it would be a worse answer to a question nobody asks.
 *  2. **Rows are virtualised, headers are not.** Only the visible ~20 rows exist
 *     in the DOM; the header row is sticky inside the same scroller so it stays
 *     aligned when the grid scrolls horizontally, and the permission column is
 *     sticky at the inline start so a row never loses its identity.
 *  3. **Module headings are rows.** A virtualiser cannot position an element it
 *     has not rendered, so a "sticky group header" over a virtual list either
 *     jumps or mis-measures. Making the heading a measured row keeps the scroll
 *     height exact — and it gives the module its "select all" checkbox a natural
 *     home.
 *
 * Everything the screen can get *wrong* — filtering, the diff, the SoD check — is
 * pure and lives in `../lib/matrix.ts`, under unit test.
 */

const MODULE_ROW_HEIGHT = 40;
const PERMISSION_ROW_HEIGHT = 56;
const INITIAL_VIEWPORT_HEIGHT = 640;
/** Four is where the columns stop being readable at 1280 px, the clinical desktop target. */
const MAX_COMPARISON_ROLES = 4;

export interface ComparisonColumn {
  readonly role: RoleListItem;
  readonly permissions: ReadonlySet<string> | null;
  readonly loading: boolean;
}

export interface PermissionMatrixProps {
  readonly catalogue: PermissionCatalogue;
  readonly role: RoleDetail;
  readonly comparisons: readonly ComparisonColumn[];
  /** `admin.role.configure`; without it the grid renders as a read-only report. */
  readonly canConfigure: boolean;
  readonly saving: boolean;
  readonly onSave: (permissions: readonly string[], reason: string) => void;
  readonly onCloneRequested?: () => void;
}

export function PermissionMatrix({
  catalogue,
  role,
  comparisons,
  canConfigure,
  saving,
  onSave,
  onCloneRequested,
}: PermissionMatrixProps): React.JSX.Element {
  const saved = useMemo(() => new Set(role.permissions), [role.permissions]);

  const [draft, setDraft] = useState<ReadonlySet<string>>(saved);
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set<string>());
  const [filter, setFilter] = useState<MatrixFilter>(EMPTY_FILTER);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sodAcknowledged, setSodAcknowledged] = useState(false);

  // Switching role, or the role's version moving under us after a save, discards
  // the draft. Carrying it across would apply one role's edits to another.
  useEffect(() => {
    setDraft(new Set(role.permissions));
    setSelection(new Set<string>());
    setSodAcknowledged(false);
  }, [role.id, role.version, role.permissions]);

  // A system template is read-only in the database (`RolesService.update`
  // refuses it), so the grid must not offer edits it cannot land.
  const editable = canConfigure && !role.is_system;

  const context = useMemo(() => ({ draft, saved }), [draft, saved]);
  const groups = useMemo(
    () => filterModules(catalogue.modules, filter, context),
    [catalogue.modules, filter, context],
  );
  const rows = useMemo(() => flattenGroups(groups), [groups]);
  const diff = useMemo(() => computeDiff(catalogue.modules, saved, draft), [catalogue.modules, saved, draft]);
  const violations = useMemo(
    () => sodViolations(catalogue.segregationOfDuties, saved, draft),
    [catalogue.segregationOfDuties, saved, draft],
  );
  const introducedViolations = violations.filter((v) => v.introduced);
  const moduleNames = useMemo(() => catalogue.modules.map((m) => m.module), [catalogue.modules]);
  const actions = useMemo(() => actionsIn(catalogue.modules), [catalogue.modules]);
  const visibleKeys = useMemo(
    () => rows.flatMap((row) => (row.kind === 'permission' ? [row.permission.key] : [])),
    [rows],
  );

  const columnCount = 3 + comparisons.length;
  /**
   * How far the arrow keys may travel sideways.
   *
   * A permission row offers the selection box, the edited role and one cell per
   * comparison; a module heading offers its select-all box and its two bulk
   * buttons. The keys move within the widest of those, and each row clamps the
   * stored column to what it actually has — so there is always exactly one tab
   * stop and never a dead end (`docs/06` §6.1: roving tabindex, one tab stop per
   * grid).
   */
  const focusColumnCount = Math.max(3, 2 + comparisons.length);

  // ── virtualisation ─────────────────────────────────────────────────────────
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (rows[index]?.kind === 'module' ? MODULE_ROW_HEIGHT : PERMISSION_ROW_HEIGHT),
    overscan: 10,
    // The height the scroller is assumed to have until it has been measured.
    // Without it the first paint renders zero rows and the grid appears empty
    // for a frame — and in any environment that never fires a ResizeObserver
    // (server rendering, a test runner) it stays empty forever. `max-h-[58vh]`
    // is roughly this on a clinical desktop, so the guess is close enough that
    // the re-measure is invisible.
    initialRect: { width: 0, height: INITIAL_VIEWPORT_HEIGHT },
  });

  // ── roving focus (docs/06 §6.1: "roving tabindex in grids") ────────────────
  const [focus, setFocus] = useState<{ readonly row: number; readonly column: number }>({
    row: 0,
    column: 1,
  });
  const [focusPending, setFocusPending] = useState(false);

  useEffect(() => {
    if (!focusPending) return;
    virtualizer.scrollToIndex(focus.row, { align: 'auto' });
    const frame = requestAnimationFrame(() => {
      // The row clamps the column to what it actually has, so the cell to focus
      // is looked up by row and then by the nearest column at or below the
      // requested one — an overshooting arrow key must land somewhere.
      const container = scrollRef.current;
      if (container !== null) {
        for (let column = focus.column; column >= 0; column -= 1) {
          const cell = container.querySelector<HTMLElement>(
            `[data-matrix-cell="${String(focus.row)}:${String(column)}"]`,
          );
          if (cell !== null) {
            cell.focus();
            break;
          }
        }
      }
      setFocusPending(false);
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [focus, focusPending, virtualizer]);

  const move = useCallback(
    (rowDelta: number, columnDelta: number) => {
      setFocus((current) => ({
        row: clamp(current.row + rowDelta, 0, Math.max(rows.length - 1, 0)),
        column: clamp(current.column + columnDelta, 0, focusColumnCount - 1),
      }));
      setFocusPending(true);
    },
    [rows.length, focusColumnCount],
  );

  const onGridKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          move(1, 0);
          break;
        case 'ArrowUp':
          event.preventDefault();
          move(-1, 0);
          break;
        case 'ArrowRight':
          event.preventDefault();
          move(0, 1);
          break;
        case 'ArrowLeft':
          event.preventDefault();
          move(0, -1);
          break;
        case 'PageDown':
          event.preventDefault();
          move(10, 0);
          break;
        case 'PageUp':
          event.preventDefault();
          move(-10, 0);
          break;
        case 'Home':
          event.preventDefault();
          setFocus((c) => ({ row: 0, column: c.column }));
          setFocusPending(true);
          break;
        case 'End':
          event.preventDefault();
          setFocus((c) => ({ row: Math.max(rows.length - 1, 0), column: c.column }));
          setFocusPending(true);
          break;
        default:
          break;
      }
    },
    [move, rows.length],
  );

  // ── editing ────────────────────────────────────────────────────────────────
  const toggle = useCallback((key: string) => {
    setDraft((current) => toggleKey(current, key));
  }, []);

  const bulk = useCallback((keys: readonly string[], target: 'grant' | 'revoke') => {
    setDraft((current) => applyBulk(current, keys, target));
  }, []);

  const toggleSelection = useCallback((key: string) => {
    setSelection((current) => toggleKey(current, key));
  }, []);

  const setSelectionFor = useCallback((keys: readonly string[], selected: boolean) => {
    setSelection((current) => applyBulk(current, keys, selected ? 'grant' : 'revoke'));
  }, []);

  const selectedKeys = useMemo(() => [...selection], [selection]);
  const dirty = diff.changes.length > 0;
  const blockedBySod = introducedViolations.length > 0 && !sodAcknowledged;

  const columnTemplate = `2.75rem minmax(20rem, 1fr) 9rem ${comparisons.map(() => '8.5rem').join(' ')}`;

  return (
    <section aria-labelledby="matrix-heading" className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="matrix-heading" className="text-xl font-semibold tracking-tight">
          {role.name}
        </h2>
        <p className="font-mono text-xs text-fg-muted">
          {role.key} · v{role.version} · {formatCount(role.assigned_users)} assigned
        </p>
      </div>

      {role.is_system ? (
        <div
          role="status"
          className="flex flex-wrap items-center gap-3 rounded-md border border-info-border bg-info-surface p-3 text-sm text-info-on-surface"
        >
          <ShieldAlert className="size-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            This is one of the 64 seeded role templates. Templates are read-only so that every hospital starts
            from the same baseline and an auditor can prove it. Clone it to make a version you can edit.
          </span>
          {onCloneRequested === undefined ? null : (
            <Button variant="secondary" size="sm" onClick={onCloneRequested}>
              <Copy aria-hidden="true" />
              Clone this template
            </Button>
          )}
        </div>
      ) : null}

      {canConfigure ? null : (
        <p role="status" className="rounded-md border border-default bg-layer-1 p-3 text-sm text-fg-muted">
          You can read the matrix but not change it. Editing a role needs
          <span className="mx-1 font-mono text-xs">admin.role.configure</span>, which is granted to hospital
          administrators.
        </p>
      )}

      <FlagLegend />

      <MatrixToolbar
        filter={filter}
        onFilterChange={setFilter}
        modules={moduleNames}
        actions={actions}
        shown={visibleKeys.length}
        total={catalogue.total}
      />

      {editable ? (
        <BulkBar
          selectedCount={selectedKeys.length}
          visibleCount={visibleKeys.length}
          roleName={role.name}
          onSelectAllVisible={() => {
            setSelectionFor(visibleKeys, true);
          }}
          onClear={() => {
            setSelection(new Set<string>());
          }}
          onGrant={() => {
            bulk(selectedKeys, 'grant');
          }}
          onRevoke={() => {
            bulk(selectedKeys, 'revoke');
          }}
        />
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          icon={<ScanSearch />}
          cause="No permission matches these filters."
          nextAction="Clear the filters to see the whole catalogue again."
          action={{
            label: 'Clear filters',
            onSelect: () => {
              setFilter(EMPTY_FILTER);
            },
          }}
        />
      ) : (
        <div
          ref={scrollRef}
          // A scrollable box has to be reachable by keyboard or its content below
          // the fold is unreachable without a mouse (WCAG 2.1.1; axe's
          // `scrollable-region-focusable`). The roving tab stop inside the grid
          // moves *within* the rows; this one is how a keyboard user scrolls the
          // container itself.
          role="region"
          aria-label="Permission matrix, scrollable"
          tabIndex={0}
          className="relative max-h-[58vh] overflow-auto rounded-lg border border-default bg-layer-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          <div
            role="grid"
            aria-labelledby="matrix-heading"
            aria-rowcount={rows.length + 1}
            aria-colcount={columnCount}
            aria-readonly={editable ? undefined : true}
            onKeyDown={onGridKeyDown}
            className="min-w-max"
          >
            <div role="rowgroup" className="sticky top-0 z-sticky bg-layer-1 shadow-e1">
              <div
                role="row"
                aria-rowindex={1}
                className="grid items-center border-b border-strong"
                style={{ gridTemplateColumns: columnTemplate }}
              >
                <div role="columnheader" aria-colindex={1} className="px-2 py-2">
                  <span className="sr-only">Select rows for a bulk change</span>
                </div>
                <div
                  role="columnheader"
                  aria-colindex={2}
                  className="sticky start-0 bg-layer-1 px-2 py-2 text-xs font-medium text-fg-muted"
                >
                  Permission
                </div>
                <div
                  role="columnheader"
                  aria-colindex={3}
                  className="px-2 py-2 text-center text-xs font-medium text-accent-fg"
                >
                  {role.name}
                  <span className="block font-normal text-3xs text-fg-subtle">editing</span>
                </div>
                {comparisons.map((comparison, index) => (
                  <div
                    key={comparison.role.id}
                    role="columnheader"
                    aria-colindex={4 + index}
                    className="px-2 py-2 text-center text-xs font-medium text-fg-muted"
                  >
                    <span className="line-clamp-2">{comparison.role.name}</span>
                    <span className="block font-normal text-3xs text-fg-subtle">
                      {comparison.loading ? 'loading…' : 'comparison'}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div
              role="rowgroup"
              style={{ height: `${String(virtualizer.getTotalSize())}px`, position: 'relative' }}
            >
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const row = rows[virtualRow.index];
                if (row === undefined) return null;
                return (
                  <div
                    key={virtualRow.key}
                    role="row"
                    aria-rowindex={virtualRow.index + 2}
                    className="absolute inset-inline-0 top-0 grid items-center border-b border-default"
                    style={{
                      height: `${String(virtualRow.size)}px`,
                      transform: `translateY(${String(virtualRow.start)}px)`,
                      gridTemplateColumns: columnTemplate,
                    }}
                  >
                    {row.kind === 'module' ? (
                      <ModuleRow
                        row={row}
                        rowIndex={virtualRow.index}
                        columnCount={columnCount}
                        focus={focus}
                        editable={editable}
                        selection={selection}
                        draft={draft}
                        onSelectModule={(selected) => {
                          setSelectionFor(row.permissionKeys, selected);
                        }}
                        onGrantModule={() => {
                          bulk(row.permissionKeys, 'grant');
                        }}
                        onRevokeModule={() => {
                          bulk(row.permissionKeys, 'revoke');
                        }}
                        onFocusCell={(column) => {
                          setFocus({ row: virtualRow.index, column });
                        }}
                      />
                    ) : (
                      <PermissionRow
                        permission={row.permission}
                        rowIndex={virtualRow.index}
                        focus={focus}
                        editable={editable}
                        selected={selection.has(row.permission.key)}
                        granted={draft.has(row.permission.key)}
                        changed={draft.has(row.permission.key) !== saved.has(row.permission.key)}
                        comparisons={comparisons}
                        sodRuleCount={sodRulesFor(catalogue.segregationOfDuties, row.permission.key).length}
                        roleName={role.name}
                        onToggleSelection={() => {
                          toggleSelection(row.permission.key);
                        }}
                        onToggleGrant={() => {
                          toggle(row.permission.key);
                        }}
                        onFocusCell={(column) => {
                          setFocus({ row: virtualRow.index, column });
                        }}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {introducedViolations.length > 0 ? (
        <div
          role="alert"
          data-testid="sod-warning"
          className="rounded-md border border-danger-border bg-danger-surface p-3 text-sm text-danger-on-surface"
        >
          <p className="flex items-center gap-2 font-medium">
            <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
            This role would break {String(introducedViolations.length)} segregation-of-duties rule
            {introducedViolations.length === 1 ? '' : 's'}
          </p>
          <ul className="mt-2 flex flex-col gap-1">
            {introducedViolations.map((violation) => (
              <li key={`${violation.permA}|${violation.permB}`}>
                <span className="font-mono text-xs">
                  {violation.permA} + {violation.permB}
                </span>
                <span className="ms-2 uppercase text-3xs tracking-[0.08em]">{violation.mode}</span>
                <p className="text-sm">{violation.reason}</p>
              </li>
            ))}
          </ul>
          <label className="mt-3 flex items-center gap-2 text-sm">
            <Checkbox
              checked={sodAcknowledged}
              onCheckedChange={(value) => {
                setSodAcknowledged(value === true);
              }}
            />
            I have read each conflict above and accept it for this role.
          </label>
        </div>
      ) : null}

      <ChangeDiff
        changes={diff.changes}
        granted={diff.granted}
        revoked={diff.revoked}
        unknownKeys={diff.unknownKeys}
        onDiscard={() => {
          setDraft(new Set(role.permissions));
          setSodAcknowledged(false);
        }}
      />

      {editable ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <p aria-live="polite" className="me-auto text-sm text-fg-muted">
            {dirty
              ? `${formatCount(diff.granted)} to grant, ${formatCount(diff.revoked)} to revoke.`
              : 'No changes yet.'}
          </p>
          <Button
            variant="primary"
            disabled={!dirty || saving || blockedBySod}
            aria-busy={saving}
            data-testid="matrix-save"
            onClick={() => {
              setConfirmOpen(true);
            }}
          >
            {saving
              ? 'Saving…'
              : `Save ${dirty ? formatCount(diff.changes.length) : ''} change${diff.changes.length === 1 ? '' : 's'}`}
          </Button>
        </div>
      ) : null}

      <ConfirmWithReasonDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        labels={{
          title: `Change what ${role.name} can do`,
          description:
            `${formatCount(diff.granted)} permission(s) will be granted and ${formatCount(diff.revoked)} revoked for ` +
            `${formatCount(role.assigned_users)} user(s) holding this role. The change takes effect within five seconds ` +
            'and is written to the audit log with your reason.',
          reasonLabel: 'Reason for this change',
          reasonPlaceholder: 'Choose a reason',
          notePlaceholder: 'e.g. Pharmacy restructure — ward pharmacists no longer validate results',
          confirm: 'Save the role',
          cancel: 'Keep editing',
          typedValuePrompt: (expected) => `Type ${expected} to confirm`,
          reasonRequired: 'A reason is required. It is recorded against every user who holds this role.',
          typedValueMismatch: 'The value must match exactly.',
        }}
        confirmationValue={role.key}
        onConfirm={(result) => {
          setConfirmOpen(false);
          onSave(permissionsToSave(draft, diff.unknownKeys), result.reasonText);
        }}
      />
    </section>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// ── toolbar ──────────────────────────────────────────────────────────────────

function MatrixToolbar({
  filter,
  onFilterChange,
  modules,
  actions,
  shown,
  total,
}: {
  readonly filter: MatrixFilter;
  readonly onFilterChange: (filter: MatrixFilter) => void;
  readonly modules: readonly string[];
  readonly actions: readonly string[];
  readonly shown: number;
  readonly total: number;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-default bg-layer-1 p-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-60 flex-1">
          <Label htmlFor="matrix-search">Search permissions</Label>
          <Input
            id="matrix-search"
            type="search"
            value={filter.text}
            placeholder="key, description, resource or action"
            data-testid="matrix-search"
            onChange={(event) => {
              onFilterChange({ ...filter, text: event.target.value });
            }}
          />
        </div>

        <div className="w-48">
          <Label htmlFor="matrix-module">Module</Label>
          <Select
            value={filter.module ?? 'all'}
            onValueChange={(value) => {
              onFilterChange({ ...filter, module: value === 'all' ? null : value });
            }}
          >
            <SelectTrigger id="matrix-module" data-testid="matrix-module">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All modules</SelectItem>
              {modules.map((module) => (
                <SelectItem key={module} value={module}>
                  {module}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="w-40">
          <Label htmlFor="matrix-action">Action</Label>
          <Select
            value={filter.action ?? 'all'}
            onValueChange={(value) => {
              onFilterChange({ ...filter, action: value === 'all' ? null : value });
            }}
          >
            <SelectTrigger id="matrix-action" data-testid="matrix-action">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All actions</SelectItem>
              {actions.map((action) => (
                <SelectItem key={action} value={action}>
                  {action}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-4 text-sm">
        <ToggleFilter
          id="matrix-dangerous"
          label="Consequential only"
          checked={filter.dangerousOnly}
          onChange={(checked) => {
            onFilterChange({ ...filter, dangerousOnly: checked });
          }}
        />
        <ToggleFilter
          id="matrix-granted"
          label="Granted only"
          checked={filter.grantedOnly}
          onChange={(checked) => {
            onFilterChange({ ...filter, grantedOnly: checked });
          }}
        />
        <ToggleFilter
          id="matrix-changed"
          label="Changed only"
          checked={filter.changedOnly}
          onChange={(checked) => {
            onFilterChange({ ...filter, changedOnly: checked });
          }}
        />
        <p aria-live="polite" className="ms-auto text-fg-muted" data-testid="matrix-count">
          Showing {formatCount(shown)} of {formatCount(total)} permissions
        </p>
        {isFilterActive(filter) ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              onFilterChange(EMPTY_FILTER);
            }}
          >
            Clear filters
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Why a permission is dangerous, stated once and permanently.
 *
 * The catalogue's flags are the only warning an administrator gets before handing
 * `admin.role.assign` to sixty people, and a coloured chip alone does not carry
 * the reason (`docs/06` §1.2.3: colour is never the only signal, and a tooltip is
 * never the only source of information). A `<details>` element keeps it out of
 * the way while remaining keyboard-operable and readable by a screen reader
 * without any ARIA of our own.
 */
function FlagLegend(): React.JSX.Element {
  return (
    <details className="rounded-lg border border-default bg-layer-1 px-3 py-2">
      <summary className="cursor-pointer text-sm font-medium text-fg-default focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
        What the badges on a permission mean
      </summary>
      <ul className="mt-2 flex flex-col gap-2">
        {DANGER_LEGEND.map((note) => (
          <li key={note.flag} className="flex flex-wrap items-baseline gap-2 text-sm">
            <Badge tone={note.tone} size="sm">
              {note.label}
            </Badge>
            <span className="min-w-0 flex-1 text-fg-muted">{note.explanation}</span>
          </li>
        ))}
        <li className="flex flex-wrap items-baseline gap-2 text-sm">
          <Badge tone="warning" size="sm" icon={<ShieldAlert aria-hidden="true" />}>
            SoD pair
          </Badge>
          <span className="min-w-0 flex-1 text-fg-muted">
            This key appears in a segregation-of-duties rule. Holding it together with its pair means the same
            person can both make and check the same decision.
          </span>
        </li>
      </ul>
    </details>
  );
}

function ToggleFilter({
  id,
  label,
  checked,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-2">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(value) => {
          onChange(value === true);
        }}
      />
      <Label htmlFor={id} className="text-sm font-normal">
        {label}
      </Label>
    </span>
  );
}

// ── bulk action bar (docs/06 §9.A) ───────────────────────────────────────────

function BulkBar({
  selectedCount,
  visibleCount,
  roleName,
  onSelectAllVisible,
  onClear,
  onGrant,
  onRevoke,
}: {
  readonly selectedCount: number;
  readonly visibleCount: number;
  readonly roleName: string;
  readonly onSelectAllVisible: () => void;
  readonly onClear: () => void;
  readonly onGrant: () => void;
  readonly onRevoke: () => void;
}): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label="Bulk permission actions"
      data-testid="bulk-bar"
      className="flex flex-wrap items-center gap-2 rounded-md border border-default bg-layer-3 px-3 py-2 text-sm"
    >
      <span aria-live="polite" data-testid="bulk-selected">
        {selectedCount === 0
          ? 'Select rows, a module, or filter by action to change many at once.'
          : `${formatCount(selectedCount)} permission${selectedCount === 1 ? '' : 's'} selected`}
      </span>
      <span className="ms-auto flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onSelectAllVisible} disabled={visibleCount === 0}>
          Select all {formatCount(visibleCount)} shown
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={onGrant}
          disabled={selectedCount === 0}
          data-testid="bulk-grant"
        >
          Grant to {roleName}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={onRevoke}
          disabled={selectedCount === 0}
          data-testid="bulk-revoke"
        >
          Revoke from {roleName}
        </Button>
        <Button variant="ghost" size="sm" onClick={onClear} disabled={selectedCount === 0}>
          Clear selection
        </Button>
      </span>
    </div>
  );
}

// ── rows ─────────────────────────────────────────────────────────────────────

interface FocusState {
  readonly row: number;
  readonly column: number;
}

function ModuleRow({
  row,
  rowIndex,
  columnCount,
  focus,
  editable,
  selection,
  draft,
  onSelectModule,
  onGrantModule,
  onRevokeModule,
  onFocusCell,
}: {
  readonly row: Extract<MatrixRow, { kind: 'module' }>;
  readonly rowIndex: number;
  readonly columnCount: number;
  readonly focus: FocusState;
  readonly editable: boolean;
  readonly selection: ReadonlySet<string>;
  readonly draft: ReadonlySet<string>;
  readonly onSelectModule: (selected: boolean) => void;
  readonly onGrantModule: () => void;
  readonly onRevokeModule: () => void;
  readonly onFocusCell: (column: number) => void;
}): React.JSX.Element {
  const selectState = groupState(row.permissionKeys, selection);
  const grantState = groupState(row.permissionKeys, draft);
  // A heading row has three controls; a focus column beyond them lands on the last.
  const activeColumn = focus.row === rowIndex ? Math.min(focus.column, 2) : -1;

  return (
    <>
      <div
        role="rowheader"
        aria-colindex={1}
        aria-colspan={columnCount}
        className="col-span-full flex items-center gap-3 bg-sunken px-2"
      >
        {editable ? (
          <Checkbox
            aria-label={`Select all ${String(row.count)} permissions in ${row.module}`}
            data-matrix-cell={`${String(rowIndex)}:0`}
            tabIndex={activeColumn === 0 ? 0 : -1}
            checked={selectState === 'all' ? true : selectState === 'some' ? 'indeterminate' : false}
            onFocus={() => {
              onFocusCell(0);
            }}
            onCheckedChange={(value) => {
              onSelectModule(value === true);
            }}
          />
        ) : null}
        <span className="font-display text-2xs font-semibold uppercase tracking-[0.08em] text-fg-default">
          {row.module}
        </span>
        <Badge tone="neutral" size="sm">
          {formatCount(row.count)}
        </Badge>
        {editable ? (
          <span className="ms-auto flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              data-matrix-cell={`${String(rowIndex)}:1`}
              tabIndex={activeColumn === 1 ? 0 : -1}
              onFocus={() => {
                onFocusCell(1);
              }}
              onClick={onGrantModule}
              aria-label={`Grant every permission in ${row.module}`}
            >
              Grant all
            </Button>
            <Button
              variant="ghost"
              size="sm"
              data-matrix-cell={`${String(rowIndex)}:2`}
              tabIndex={activeColumn === 2 ? 0 : -1}
              onFocus={() => {
                onFocusCell(2);
              }}
              onClick={onRevokeModule}
              aria-label={`Revoke every permission in ${row.module}`}
            >
              Revoke all
            </Button>
            <span className="text-3xs text-fg-subtle">
              {grantState === 'all'
                ? 'all granted'
                : grantState === 'some'
                  ? 'partly granted'
                  : 'none granted'}
            </span>
          </span>
        ) : null}
      </div>
    </>
  );
}

function PermissionRow({
  permission,
  rowIndex,
  focus,
  editable,
  selected,
  granted,
  changed,
  comparisons,
  sodRuleCount,
  roleName,
  onToggleSelection,
  onToggleGrant,
  onFocusCell,
}: {
  readonly permission: PermissionDefinition;
  readonly rowIndex: number;
  readonly focus: FocusState;
  readonly editable: boolean;
  readonly selected: boolean;
  readonly granted: boolean;
  readonly changed: boolean;
  readonly comparisons: readonly ComparisonColumn[];
  readonly sodRuleCount: number;
  readonly roleName: string;
  readonly onToggleSelection: () => void;
  readonly onToggleGrant: () => void;
  readonly onFocusCell: (column: number) => void;
}): React.JSX.Element {
  const notes = dangerNotes(permission);
  // Columns on a permission row: 0 selection, 1 the edited role, 2.. comparisons.
  const maxColumn = 1 + comparisons.length;
  const activeColumn = focus.row === rowIndex ? Math.min(focus.column, maxColumn) : -1;

  return (
    <>
      <div role="gridcell" aria-colindex={1} className="flex items-center justify-center px-2">
        {editable ? (
          <Checkbox
            aria-label={`Select ${permission.key} for a bulk change`}
            data-matrix-cell={`${String(rowIndex)}:0`}
            tabIndex={activeColumn === 0 ? 0 : -1}
            checked={selected}
            onFocus={() => {
              onFocusCell(0);
            }}
            onCheckedChange={onToggleSelection}
          />
        ) : null}
      </div>

      <div
        role="rowheader"
        aria-colindex={2}
        // docs/06 §9.A — "sticky header + first column"; a scrolled-away key makes
        // the rest of the row meaningless.
        data-changed={changed ? 'true' : 'false'}
        className="sticky start-0 flex min-w-0 flex-col justify-center bg-layer-1 px-2 data-[changed=true]:border-s-[3px] data-[changed=true]:border-s-accent-border"
      >
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-xs text-fg-default">{permission.key}</span>
          <Badge tone={riskTone(permission.risk)} size="sm">
            {permission.risk}
          </Badge>
          {notes.map((note) => (
            <Badge key={note.flag} tone={note.tone} size="sm" icon={<TriangleAlert aria-hidden="true" />}>
              {note.label}
            </Badge>
          ))}
          {sodRuleCount > 0 ? (
            <Badge tone="warning" size="sm" icon={<ShieldAlert aria-hidden="true" />}>
              SoD pair
            </Badge>
          ) : null}
        </span>
        <span className="truncate text-xs text-fg-muted">{permission.description}</span>
        {/* Colour is never the only signal (§1.2.3): the flags above carry words,
            and the danger explanation is also announced here for screen readers. */}
        {notes.length === 0 ? null : (
          <span className="sr-only">
            {notes.map((note) => `${note.label}: ${note.explanation}`).join(' ')}
          </span>
        )}
      </div>

      <div
        role="gridcell"
        aria-colindex={3}
        {...(editable
          ? {}
          : {
              'data-matrix-cell': `${String(rowIndex)}:1`,
              tabIndex: activeColumn === 1 ? 0 : -1,
              onFocus: () => {
                onFocusCell(1);
              },
            })}
        className="flex items-center justify-center px-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        {editable ? (
          <Checkbox
            aria-label={`${permission.key} for ${roleName}`}
            data-matrix-cell={`${String(rowIndex)}:1`}
            data-testid={`cell-${permission.key}`}
            tabIndex={activeColumn === 1 ? 0 : -1}
            checked={granted}
            onFocus={() => {
              onFocusCell(1);
            }}
            onCheckedChange={onToggleGrant}
          />
        ) : (
          <StaticCell granted={granted} label={`${permission.key} for ${roleName}`} />
        )}
      </div>

      {comparisons.map((comparison, index) => (
        <div
          key={comparison.role.id}
          role="gridcell"
          aria-colindex={4 + index}
          // The cell itself is the focus target: there is no control inside it to
          // take focus, and the ARIA grid pattern puts the tab stop on the cell
          // in exactly that case.
          data-matrix-cell={`${String(rowIndex)}:${String(2 + index)}`}
          tabIndex={activeColumn === 2 + index ? 0 : -1}
          onFocus={() => {
            onFocusCell(2 + index);
          }}
          className="flex items-center justify-center px-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          {comparison.permissions === null ? (
            <span className="text-xs text-fg-subtle" aria-label="loading">
              …
            </span>
          ) : (
            <StaticCell
              granted={comparison.permissions.has(permission.key)}
              label={`${permission.key} for ${comparison.role.name}`}
            />
          )}
        </div>
      ))}
    </>
  );
}

/**
 * A read-only cell. Rendered as text plus a glyph rather than a disabled
 * checkbox: `docs/06` §4.1 forbids drawing a control the user cannot use, and a
 * greyed tick invites the click that will not work.
 */
function StaticCell({
  granted,
  label,
}: {
  readonly granted: boolean;
  readonly label: string;
}): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-1 text-xs">
      {granted ? (
        <Check className="size-4 text-success-fg" aria-hidden="true" />
      ) : (
        <Minus className="size-4 text-fg-subtle" aria-hidden="true" />
      )}
      <span className="sr-only">{granted ? `${label}: granted` : `${label}: not granted`}</span>
    </span>
  );
}

// ── the change diff ──────────────────────────────────────────────────────────

export function ChangeDiff({
  changes,
  granted,
  revoked,
  unknownKeys,
  onDiscard,
}: {
  readonly changes: readonly {
    readonly permission: PermissionDefinition;
    readonly direction: 'granted' | 'revoked';
  }[];
  readonly granted: number;
  readonly revoked: number;
  readonly unknownKeys: readonly string[];
  readonly onDiscard: () => void;
}): React.JSX.Element | null {
  if (changes.length === 0 && unknownKeys.length === 0) return null;

  return (
    <section
      aria-labelledby="matrix-diff-heading"
      data-testid="change-diff"
      className="rounded-lg border border-accent-border bg-accent-surface p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="matrix-diff-heading" className="text-md font-medium text-accent-on-surface">
          What will change
        </h3>
        <span className="flex items-center gap-2">
          <Badge tone="success" icon={<Check aria-hidden="true" />} data-testid="diff-granted-count">
            {formatCount(granted)} to grant
          </Badge>
          <Badge tone="danger" icon={<Minus aria-hidden="true" />} data-testid="diff-revoked-count">
            {formatCount(revoked)} to revoke
          </Badge>
          <Button variant="ghost" size="sm" onClick={onDiscard}>
            Discard changes
          </Button>
        </span>
      </div>

      <ul className="mt-2 max-h-56 overflow-y-auto text-sm">
        {changes.map((change) => (
          <li
            key={change.permission.key}
            data-direction={change.direction}
            className="flex flex-wrap items-center gap-2 border-b border-default py-1 last:border-b-0"
          >
            <Badge tone={change.direction === 'granted' ? 'success' : 'danger'} size="sm">
              {change.direction === 'granted' ? 'grant' : 'revoke'}
            </Badge>
            <span className="font-mono text-xs">{change.permission.key}</span>
            <span className="min-w-0 flex-1 truncate text-xs text-fg-muted">
              {change.permission.description}
            </span>
            {dangerNotes(change.permission).map((note) => (
              <Badge key={note.flag} tone={note.tone} size="sm">
                {note.label}
              </Badge>
            ))}
          </li>
        ))}
      </ul>

      {unknownKeys.length === 0 ? null : (
        <p className="mt-2 text-xs text-fg-muted">
          {formatCount(unknownKeys.length)} permission(s) held by this role are not in this build&rsquo;s
          catalogue ({unknownKeys.join(', ')}). They are left untouched rather than silently removed.
        </p>
      )}
    </section>
  );
}

export { MAX_COMPARISON_ROLES };
