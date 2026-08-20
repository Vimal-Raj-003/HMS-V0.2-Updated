import { describe, expect, it } from 'vitest';
import type { PermissionCatalogueModule, PermissionDefinition, SodRule } from '../api/types';
import {
  EMPTY_FILTER,
  applyBulk,
  computeDiff,
  dangerNotes,
  filterModules,
  flattenGroups,
  groupState,
  isFilterActive,
  matchesFilter,
  permissionsToSave,
  riskTone,
  sodRulesFor,
  sodViolations,
  toggleKey,
} from './matrix';

/**
 * The matrix editor's arithmetic.
 *
 * These are the calculations an administrator signs off on without re-reading
 * 212 checkboxes: what the filter is showing, what the change set contains, and
 * whether the result breaks a segregation-of-duties rule. A component test can
 * only reach a handful of them through the DOM; these cover the rest exactly.
 */

function permission(overrides: Partial<PermissionDefinition> & { key: string }): PermissionDefinition {
  return {
    module: 'EN-007',
    resource: 'thing',
    action: 'read',
    description: 'Does a thing.',
    dataClass: 'operational',
    risk: 'low',
    phase: 0,
    ...overrides,
  };
}

const CATALOGUE: readonly PermissionCatalogueModule[] = [
  {
    module: 'EN-007',
    permissions: [
      permission({ key: 'admin.user.read' }),
      permission({ key: 'admin.user.deactivate', action: 'delete', risk: 'high', requiresReason: true }),
      permission({
        key: 'admin.role.assign',
        action: 'assign',
        risk: 'critical',
        sensitiveGrant: true,
        requiresStepUp: true,
        requiresReason: true,
        description: 'Assign or revoke a role for a user.',
      }),
    ],
  },
  {
    module: 'EN-024',
    permissions: [
      permission({ key: 'audit.read', module: 'EN-024', description: 'Search the audit trail.' }),
      permission({ key: 'audit.export', module: 'EN-024', action: 'export', phiRead: true, risk: 'high' }),
    ],
  },
];

const context = (draft: readonly string[], saved: readonly string[] = draft) => ({
  draft: new Set(draft),
  saved: new Set(saved),
});

describe('filtering', () => {
  it('requires every search term to match, so two words narrow rather than widen', () => {
    const target = permission({
      key: 'admin.role.assign',
      description: 'Assign or revoke a role for a user.',
    });
    expect(matchesFilter(target, { ...EMPTY_FILTER, text: 'role assign' }, context([]))).toBe(true);
    // "billing" is in neither the key nor the description, so an OR match would
    // wrongly keep this row.
    expect(matchesFilter(target, { ...EMPTY_FILTER, text: 'role billing' }, context([]))).toBe(false);
  });

  it('matches on the description as well as the key, because staff search in words', () => {
    const target = permission({ key: 'audit.read', description: 'Search the audit trail.' });
    expect(matchesFilter(target, { ...EMPTY_FILTER, text: 'trail' }, context([]))).toBe(true);
  });

  it('filters by module and by action independently', () => {
    const groups = filterModules(CATALOGUE, { ...EMPTY_FILTER, module: 'EN-024' }, context([]));
    expect(groups.map((g) => g.module)).toEqual(['EN-024']);

    const byAction = filterModules(CATALOGUE, { ...EMPTY_FILTER, action: 'export' }, context([]));
    expect(byAction.flatMap((g) => g.permissions.map((p) => p.key))).toEqual(['audit.export']);
  });

  it('shows only consequential keys when asked, and a plain read key is not one', () => {
    const groups = filterModules(CATALOGUE, { ...EMPTY_FILTER, dangerousOnly: true }, context([]));
    const shown = groups.flatMap((g) => g.permissions.map((p) => p.key));
    expect(shown).toContain('admin.role.assign');
    expect(shown).toContain('admin.user.deactivate');
    expect(shown).not.toContain('admin.user.read');
  });

  it('"changed only" compares the draft with what is saved, not with empty', () => {
    const ctx = context(['admin.user.read', 'audit.read'], ['admin.user.read']);
    const shown = filterModules(CATALOGUE, { ...EMPTY_FILTER, changedOnly: true }, ctx).flatMap((g) =>
      g.permissions.map((p) => p.key),
    );
    expect(shown).toEqual(['audit.read']);
  });

  it('drops a module entirely once none of its permissions match', () => {
    const groups = filterModules(CATALOGUE, { ...EMPTY_FILTER, text: 'zzzz' }, context([]));
    expect(groups).toEqual([]);
  });

  it('knows whether any filter is active', () => {
    expect(isFilterActive(EMPTY_FILTER)).toBe(false);
    expect(isFilterActive({ ...EMPTY_FILTER, text: '  ' })).toBe(false);
    expect(isFilterActive({ ...EMPTY_FILTER, grantedOnly: true })).toBe(true);
  });
});

describe('flattening for the virtualiser', () => {
  it('emits one heading row per module followed by its permissions', () => {
    const rows = flattenGroups(filterModules(CATALOGUE, EMPTY_FILTER, context([])));
    expect(rows.map((row) => row.kind)).toEqual([
      'module',
      'permission',
      'permission',
      'permission',
      'module',
      'permission',
      'permission',
    ]);
    const first = rows[0];
    expect(first?.kind === 'module' ? first.count : -1).toBe(3);
  });
});

describe('the change set', () => {
  it('reports each direction separately and in catalogue order', () => {
    const diff = computeDiff(
      CATALOGUE,
      new Set(['admin.user.read', 'audit.read']),
      new Set(['admin.user.read', 'admin.role.assign']),
    );
    expect(diff.granted).toBe(1);
    expect(diff.revoked).toBe(1);
    expect(diff.changes.map((c) => `${c.direction}:${c.permission.key}`)).toEqual([
      'granted:admin.role.assign',
      'revoked:audit.read',
    ]);
  });

  it('is empty when the draft equals what is saved', () => {
    const same = new Set(['admin.user.read']);
    expect(computeDiff(CATALOGUE, same, same).changes).toEqual([]);
  });

  it('reports a key the running build does not know rather than silently dropping it', () => {
    const diff = computeDiff(
      CATALOGUE,
      new Set(['admin.user.read', 'legacy.key.from.2025']),
      new Set(['admin.user.read']),
    );
    expect(diff.changes).toEqual([]);
    expect(diff.unknownKeys).toEqual(['legacy.key.from.2025']);
  });

  it('carries unknown keys through to the payload, so saving never strips them', () => {
    const payload = permissionsToSave(new Set(['admin.user.read']), ['legacy.key.from.2025']);
    expect(payload).toEqual(['admin.user.read', 'legacy.key.from.2025']);
  });
});

describe('bulk selection', () => {
  it('grants and revokes a list without disturbing the rest of the draft', () => {
    const start = new Set(['admin.user.read']);
    const granted = applyBulk(start, ['audit.read', 'audit.export'], 'grant');
    expect([...granted].sort()).toEqual(['admin.user.read', 'audit.export', 'audit.read']);

    const revoked = applyBulk(granted, ['audit.export'], 'revoke');
    expect([...revoked].sort()).toEqual(['admin.user.read', 'audit.read']);
  });

  it('is idempotent, so pressing "grant all" twice is not a change', () => {
    const once = applyBulk(new Set<string>(), ['audit.read'], 'grant');
    expect(applyBulk(once, ['audit.read'], 'grant')).toEqual(once);
  });

  it('toggles a single key both ways', () => {
    const on = toggleKey(new Set<string>(), 'audit.read');
    expect(on.has('audit.read')).toBe(true);
    expect(toggleKey(on, 'audit.read').has('audit.read')).toBe(false);
  });

  it('reports a module checkbox as none, some or all', () => {
    const keys = ['a', 'b', 'c'];
    expect(groupState(keys, new Set<string>())).toBe('none');
    expect(groupState(keys, new Set(['b']))).toBe('some');
    expect(groupState(keys, new Set(keys))).toBe('all');
    expect(groupState([], new Set(['b']))).toBe('none');
  });
});

describe('segregation of duties', () => {
  const rules: readonly SodRule[] = [
    {
      permA: 'admin.user.read',
      permB: 'admin.role.assign',
      mode: 'block',
      reason: 'Reading the directory and granting roles is maker and checker in one person.',
    },
  ];

  it('reports a conflict only when both halves are held', () => {
    expect(sodViolations(rules, new Set<string>(), new Set(['admin.user.read']))).toEqual([]);
    const found = sodViolations(rules, new Set<string>(), new Set(['admin.user.read', 'admin.role.assign']));
    expect(found).toHaveLength(1);
    expect(found[0]?.introduced).toBe(true);
  });

  it('distinguishes a conflict this edit introduces from one the role already had', () => {
    const both = new Set(['admin.user.read', 'admin.role.assign']);
    const found = sodViolations(rules, both, both);
    expect(found[0]?.introduced).toBe(false);
  });

  it('finds the rules touching a single key so a row can warn before the box is ticked', () => {
    expect(sodRulesFor(rules, 'admin.role.assign')).toHaveLength(1);
    expect(sodRulesFor(rules, 'audit.read')).toHaveLength(0);
  });
});

describe('danger annotation', () => {
  it('lists every flag the catalogue marks, each with an explanation', () => {
    const notes = dangerNotes(
      permission({ key: 'x', sensitiveGrant: true, requiresStepUp: true, phiRead: true }),
    );
    expect(notes.map((n) => n.flag).sort()).toEqual(['phiRead', 'requiresStepUp', 'sensitiveGrant']);
    for (const note of notes) expect(note.explanation.length).toBeGreaterThan(20);
  });

  it('leaves an ordinary read key unmarked', () => {
    expect(dangerNotes(permission({ key: 'x' }))).toEqual([]);
  });

  it('maps risk to a tone without ever losing a level', () => {
    expect([riskTone('low'), riskTone('medium'), riskTone('high'), riskTone('critical')]).toEqual([
      'neutral',
      'info',
      'warning',
      'danger',
    ]);
  });
});
