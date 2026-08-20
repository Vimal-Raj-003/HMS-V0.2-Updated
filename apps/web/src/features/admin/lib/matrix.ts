import type { PermissionCatalogueModule, PermissionDefinition, SodRule } from '../api/types';

/**
 * The permission matrix, as data.
 *
 * Everything on this screen that can be got wrong quietly lives here rather than
 * inside a component: which rows a filter shows, what a draft actually changes,
 * and which segregation-of-duties pairs the *prospective* role would hold. A
 * matrix editor that mis-computes its own diff is worse than no editor, because
 * the administrator will sign off on the summary rather than on 230 checkboxes.
 */

/** The flags the catalogue uses to mark a permission as consequential. */
export type DangerFlag =
  | 'sensitiveGrant'
  | 'requiresSecondPerson'
  | 'requiresStepUp'
  | 'requiresReason'
  | 'phiRead'
  | 'clinicalSafetyExempt';

export interface DangerNote {
  readonly flag: DangerFlag;
  readonly label: string;
  readonly tone: 'danger' | 'warning' | 'violet' | 'info' | 'success';
  /** One sentence saying *why* it matters — never a bare icon (docs/06 §1.2.3). */
  readonly explanation: string;
}

const DANGER_NOTES: Readonly<Record<DangerFlag, Omit<DangerNote, 'flag'>>> = {
  sensitiveGrant: {
    label: 'Dual approval',
    tone: 'danger',
    explanation:
      'Granting this needs two approvers and MFA on the person receiving it (EN-007 §5). Adding it to a role hands it to everybody who already holds that role.',
  },
  requiresSecondPerson: {
    label: 'Second person',
    tone: 'danger',
    explanation:
      'Using it requires a second, different authenticated person at the moment of the action — the same user can never be both.',
  },
  requiresStepUp: {
    label: 'Step-up auth',
    tone: 'warning',
    explanation: 'The holder must re-authenticate within the last five minutes before the action is allowed.',
  },
  requiresReason: {
    label: 'Reason required',
    tone: 'warning',
    explanation: 'Every use is refused without a typed reason, which is written into the audit row.',
  },
  phiRead: {
    label: 'Reads PHI',
    tone: 'violet',
    explanation: 'Every use writes a READ_PHI audit row and appears in the privacy officer’s review.',
  },
  clinicalSafetyExempt: {
    label: 'Safety-exempt',
    tone: 'success',
    explanation:
      'Licence state, degradation tier and feature flags can never block this key (EN-040 §5). It stays available even on an expired subscription.',
  },
};

/** Every flag with its explanation, for the always-visible legend on the editor. */
export const DANGER_LEGEND: readonly DangerNote[] = (Object.keys(DANGER_NOTES) as DangerFlag[]).map(
  (flag) => ({ flag, ...DANGER_NOTES[flag] }),
);

export function dangerNotes(permission: PermissionDefinition): readonly DangerNote[] {
  const notes: DangerNote[] = [];
  for (const flag of Object.keys(DANGER_NOTES) as DangerFlag[]) {
    if (permission[flag] === true) notes.push({ flag, ...DANGER_NOTES[flag] });
  }
  return notes;
}

/** Risk drives the row's treatment; `critical` also carries the left rule (docs/06 §9.A). */
export function riskTone(risk: PermissionDefinition['risk']): 'neutral' | 'info' | 'warning' | 'danger' {
  switch (risk) {
    case 'low':
      return 'neutral';
    case 'medium':
      return 'info';
    case 'high':
      return 'warning';
    case 'critical':
      return 'danger';
  }
}

// ── filtering ────────────────────────────────────────────────────────────────

export interface MatrixFilter {
  /** Free text over key, description, resource and action. */
  readonly text: string;
  readonly module: string | null;
  readonly action: string | null;
  readonly risk: PermissionDefinition['risk'] | null;
  /** Only permissions carrying at least one of the catalogue's danger flags. */
  readonly dangerousOnly: boolean;
  /** Only rows where the edited role's draft differs from what is saved. */
  readonly changedOnly: boolean;
  /** Only rows the edited role currently holds in the draft. */
  readonly grantedOnly: boolean;
}

export const EMPTY_FILTER: MatrixFilter = {
  text: '',
  module: null,
  action: null,
  risk: null,
  dangerousOnly: false,
  changedOnly: false,
  grantedOnly: false,
};

export function isFilterActive(filter: MatrixFilter): boolean {
  return (
    filter.text.trim() !== '' ||
    filter.module !== null ||
    filter.action !== null ||
    filter.risk !== null ||
    filter.dangerousOnly ||
    filter.changedOnly ||
    filter.grantedOnly
  );
}

export interface MatrixContext {
  /** The edited role's draft permission set. */
  readonly draft: ReadonlySet<string>;
  /** What is currently saved on the server, for the `changedOnly` filter. */
  readonly saved: ReadonlySet<string>;
}

export function matchesFilter(
  permission: PermissionDefinition,
  filter: MatrixFilter,
  context: MatrixContext,
): boolean {
  const text = filter.text.trim().toLowerCase();
  if (text !== '') {
    const haystack =
      `${permission.key} ${permission.description} ${permission.resource} ${permission.action}`.toLowerCase();
    // Every whitespace-separated term must appear, so "audit export" narrows
    // rather than widening the way an OR match would.
    if (!text.split(/\s+/).every((term) => haystack.includes(term))) return false;
  }
  if (filter.module !== null && permission.module !== filter.module) return false;
  if (filter.action !== null && permission.action !== filter.action) return false;
  if (filter.risk !== null && permission.risk !== filter.risk) return false;
  if (filter.dangerousOnly && dangerNotes(permission).length === 0) return false;
  if (filter.grantedOnly && !context.draft.has(permission.key)) return false;
  if (filter.changedOnly && context.draft.has(permission.key) === context.saved.has(permission.key)) {
    return false;
  }
  return true;
}

export interface MatrixGroup {
  readonly module: string;
  readonly permissions: readonly PermissionDefinition[];
}

export function filterModules(
  modules: readonly PermissionCatalogueModule[],
  filter: MatrixFilter,
  context: MatrixContext,
): readonly MatrixGroup[] {
  const groups: MatrixGroup[] = [];
  for (const group of modules) {
    const permissions = group.permissions.filter((p) => matchesFilter(p, filter, context));
    if (permissions.length > 0) groups.push({ module: group.module, permissions });
  }
  return groups;
}

/**
 * The flat list the virtualiser measures.
 *
 * Module headings are rows, not sticky containers, because a virtualised list
 * cannot position an element it has not rendered. Making the heading a row means
 * the scroll height is exact and the grid never jumps as the user scrolls — the
 * failure mode of every "sticky group header over a virtual list" implementation.
 */
export type MatrixRow =
  | {
      readonly kind: 'module';
      readonly module: string;
      readonly count: number;
      readonly permissionKeys: readonly string[];
    }
  | { readonly kind: 'permission'; readonly module: string; readonly permission: PermissionDefinition };

export function flattenGroups(groups: readonly MatrixGroup[]): readonly MatrixRow[] {
  const rows: MatrixRow[] = [];
  for (const group of groups) {
    rows.push({
      kind: 'module',
      module: group.module,
      count: group.permissions.length,
      permissionKeys: group.permissions.map((p) => p.key),
    });
    for (const permission of group.permissions) {
      rows.push({ kind: 'permission', module: group.module, permission });
    }
  }
  return rows;
}

// ── the change set ───────────────────────────────────────────────────────────

export interface MatrixChange {
  readonly permission: PermissionDefinition;
  readonly direction: 'granted' | 'revoked';
}

/**
 * What the draft would do to the saved role, in catalogue order.
 *
 * Computed against the catalogue rather than against the raw key sets so that a
 * key held by the role but absent from the catalogue — a deprecated key from an
 * earlier release — is reported separately instead of silently vanishing from
 * the summary while the PATCH quietly drops it.
 */
export interface MatrixDiff {
  readonly changes: readonly MatrixChange[];
  readonly granted: number;
  readonly revoked: number;
  /** Keys the role holds that the running build does not know about. */
  readonly unknownKeys: readonly string[];
}

export function computeDiff(
  modules: readonly PermissionCatalogueModule[],
  saved: ReadonlySet<string>,
  draft: ReadonlySet<string>,
): MatrixDiff {
  const changes: MatrixChange[] = [];
  const known = new Set<string>();

  for (const group of modules) {
    for (const permission of group.permissions) {
      known.add(permission.key);
      const was = saved.has(permission.key);
      const is = draft.has(permission.key);
      if (was === is) continue;
      changes.push({ permission, direction: is ? 'granted' : 'revoked' });
    }
  }

  const unknownKeys = [...saved].filter((key) => !known.has(key)).sort();

  return {
    changes,
    granted: changes.filter((c) => c.direction === 'granted').length,
    revoked: changes.filter((c) => c.direction === 'revoked').length,
    unknownKeys,
  };
}

/**
 * The permission set to send.
 *
 * Unknown keys are carried through untouched. Dropping them would let opening the
 * editor and pressing Save silently strip a permission the running build has not
 * heard of — a deployment-order bug that looks like sabotage in the audit log.
 */
export function permissionsToSave(draft: ReadonlySet<string>, unknownKeys: readonly string[]): string[] {
  return [...new Set([...draft, ...unknownKeys])].sort();
}

// ── segregation of duties (docs/05) ──────────────────────────────────────────

export interface SodViolation extends SodRule {
  /** True when the draft introduces it and the saved role did not have it. */
  readonly introduced: boolean;
}

export function sodViolations(
  rules: readonly SodRule[],
  saved: ReadonlySet<string>,
  draft: ReadonlySet<string>,
): readonly SodViolation[] {
  return rules
    .filter((rule) => draft.has(rule.permA) && draft.has(rule.permB))
    .map((rule) => ({ ...rule, introduced: !(saved.has(rule.permA) && saved.has(rule.permB)) }));
}

/** Rules touching this key, so a row can warn before the box is ticked. */
export function sodRulesFor(rules: readonly SodRule[], key: string): readonly SodRule[] {
  return rules.filter((rule) => rule.permA === key || rule.permB === key);
}

// ── bulk selection ───────────────────────────────────────────────────────────

export type BulkTarget = 'grant' | 'revoke';

export function applyBulk(
  draft: ReadonlySet<string>,
  keys: readonly string[],
  target: BulkTarget,
): ReadonlySet<string> {
  const next = new Set(draft);
  for (const key of keys) {
    if (target === 'grant') next.add(key);
    else next.delete(key);
  }
  return next;
}

export function toggleKey(draft: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(draft);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/** Tri-state for a module's "select all" box. */
export function groupState(keys: readonly string[], selection: ReadonlySet<string>): 'none' | 'some' | 'all' {
  if (keys.length === 0) return 'none';
  let held = 0;
  for (const key of keys) if (selection.has(key)) held += 1;
  if (held === 0) return 'none';
  return held === keys.length ? 'all' : 'some';
}

/** Every distinct action verb in the catalogue, for the "bulk select by action" control. */
export function actionsIn(modules: readonly PermissionCatalogueModule[]): readonly string[] {
  const actions = new Set<string>();
  for (const group of modules) for (const p of group.permissions) actions.add(p.action);
  return [...actions].sort();
}
