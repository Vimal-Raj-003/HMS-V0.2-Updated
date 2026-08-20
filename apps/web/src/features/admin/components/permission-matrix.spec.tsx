import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { PermissionCatalogue, PermissionDefinition, RoleDetail, RoleListItem } from '../api/types';
import { PermissionMatrix } from './permission-matrix';

/**
 * The matrix editor as an administrator meets it.
 *
 * The arithmetic is covered exhaustively in `../lib/matrix.spec.ts`; what is
 * asserted here is the behaviour that only exists once the pieces are wired
 * together — that filtering changes what the grid reports, that a bulk action
 * moves the change set, that the diff is visible *before* the save, and that the
 * save cannot happen without a reason.
 */

beforeAll(() => {
  // TanStack Virtual measures its scroller with `offsetWidth`/`offsetHeight`,
  // which jsdom always reports as 0 — so without this the grid renders no rows
  // at all and every row assertion below would pass vacuously.
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => 640,
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get: () => 1280,
  });
});

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

const CATALOGUE: PermissionCatalogue = {
  total: 5,
  segregationOfDuties: [
    {
      permA: 'admin.user.read',
      permB: 'admin.role.assign',
      mode: 'block',
      reason: 'Reading the directory and granting roles puts maker and checker in one person.',
    },
  ],
  modules: [
    {
      module: 'EN-007',
      permissions: [
        permission({ key: 'admin.user.read', description: 'View user accounts.' }),
        permission({ key: 'admin.user.deactivate', action: 'delete', risk: 'high', requiresReason: true }),
        permission({
          key: 'admin.role.assign',
          action: 'assign',
          risk: 'critical',
          sensitiveGrant: true,
          requiresStepUp: true,
          description: 'Assign or revoke a role for a user.',
        }),
      ],
    },
    {
      module: 'EN-024',
      permissions: [
        permission({ key: 'audit.read', module: 'EN-024', description: 'Search the audit trail.' }),
        permission({
          key: 'audit.export',
          module: 'EN-024',
          action: 'export',
          phiRead: true,
          risk: 'high',
          description: 'Export audit data.',
        }),
      ],
    },
  ],
};

const ROLE: RoleDetail = {
  id: '0192f0e2-0000-7000-8000-000000000001',
  key: 'ward_pharmacist',
  name: 'Ward pharmacist',
  description: 'Dispenses on the ward.',
  template_key: null,
  home_workspace: 'pharmacy',
  category: 'clinical',
  is_system: false,
  sensitive_grant: false,
  version: 3,
  active: true,
  created_at: '2026-01-01T00:00:00.000Z',
  assigned_users: 12,
  abac_defaults: {},
  permissions: ['admin.user.read'],
  segregationOfDuties: [],
};

const COMPARISON: RoleListItem = { ...ROLE, id: 'cmp', key: 'pharmacist_op', name: 'OP pharmacist' };

function renderMatrix(overrides: Partial<Parameters<typeof PermissionMatrix>[0]> = {}) {
  const onSave = vi.fn();
  const view = render(
    <PermissionMatrix
      catalogue={CATALOGUE}
      role={ROLE}
      comparisons={[]}
      canConfigure
      saving={false}
      onSave={onSave}
      {...overrides}
    />,
  );
  return { ...view, onSave };
}

describe('filtering', () => {
  it('reports how much of the catalogue is showing, and narrows as the user types', () => {
    renderMatrix();
    expect(screen.getByTestId('matrix-count')).toHaveTextContent('Showing 5 of 5 permissions');

    fireEvent.change(screen.getByTestId('matrix-search'), { target: { value: 'audit' } });
    expect(screen.getByTestId('matrix-count')).toHaveTextContent('Showing 2 of 5 permissions');
    expect(screen.getByTestId('cell-audit.read')).toBeInTheDocument();
    expect(screen.queryByTestId('cell-admin.user.read')).not.toBeInTheDocument();
  });

  it('narrows further with a second term rather than widening', () => {
    renderMatrix();
    fireEvent.change(screen.getByTestId('matrix-search'), { target: { value: 'audit export' } });
    expect(screen.getByTestId('matrix-count')).toHaveTextContent('Showing 1 of 5 permissions');
  });

  it('offers an empty state that names the cause and clears the filter', () => {
    renderMatrix();
    fireEvent.change(screen.getByTestId('matrix-search'), { target: { value: 'nothing-matches-this' } });
    expect(screen.getByText('No permission matches these filters.')).toBeInTheDocument();

    // Two buttons carry this label — the toolbar's and the empty state's own
    // next action. The empty state's is the one a lost user reaches for.
    const clears = screen.getAllByRole('button', { name: 'Clear filters' });
    fireEvent.click(clears[clears.length - 1] as HTMLElement);
    expect(screen.getByTestId('matrix-count')).toHaveTextContent('Showing 5 of 5 permissions');
  });

  it('shows only the consequential keys when asked', () => {
    renderMatrix();
    fireEvent.click(screen.getByLabelText('Consequential only'));
    expect(screen.getByTestId('matrix-count')).toHaveTextContent('Showing 3 of 5 permissions');
    expect(screen.queryByTestId('cell-admin.user.read')).not.toBeInTheDocument();
  });

  it('can show only what the role already holds', () => {
    renderMatrix();
    fireEvent.click(screen.getByLabelText('Granted only'));
    expect(screen.getByTestId('matrix-count')).toHaveTextContent('Showing 1 of 5 permissions');
    expect(screen.getByTestId('cell-admin.user.read')).toBeInTheDocument();
  });
});

describe('why a permission is dangerous', () => {
  it('names each catalogue flag on the row in words, never colour alone', () => {
    renderMatrix();
    fireEvent.change(screen.getByTestId('matrix-search'), { target: { value: 'admin.role.assign' } });
    const row = screen.getByTestId('cell-admin.role.assign').closest('[role="row"]');
    expect(row).not.toBeNull();
    const scope = within(row as HTMLElement);
    expect(scope.getByText('Dual approval')).toBeInTheDocument();
    expect(scope.getByText('Step-up auth')).toBeInTheDocument();
    expect(scope.getByText('critical')).toBeInTheDocument();
    expect(scope.getByText('SoD pair')).toBeInTheDocument();
  });

  it('explains every flag in a legend that is always available, not only on hover', () => {
    renderMatrix();
    const legend = screen.getByText('What the badges on a permission mean').closest('details');
    expect(legend).not.toBeNull();
    const scope = within(legend as HTMLElement);
    expect(
      scope.getByText(/Granting this needs two approvers and MFA on the person receiving it/),
    ).toBeInTheDocument();
    expect(
      scope.getByText(/Licence state, degradation tier and feature flags can never block/),
    ).toBeInTheDocument();
    expect(scope.getByText(/segregation-of-duties rule/)).toBeInTheDocument();
  });
});

describe('bulk selection', () => {
  it('selects everything currently shown and grants it in one action', () => {
    renderMatrix();
    fireEvent.change(screen.getByTestId('matrix-search'), { target: { value: 'audit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Select all 2 shown' }));
    expect(screen.getByTestId('bulk-selected')).toHaveTextContent('2 permissions selected');

    fireEvent.click(screen.getByTestId('bulk-grant'));
    expect(screen.getByTestId('diff-granted-count')).toHaveTextContent('2 to grant');
    expect(screen.getByTestId('diff-revoked-count')).toHaveTextContent('0 to revoke');
  });

  it('revokes a selection, including a permission the role already held', () => {
    renderMatrix();
    fireEvent.click(screen.getByRole('button', { name: 'Select all 5 shown' }));
    fireEvent.click(screen.getByTestId('bulk-revoke'));
    expect(screen.getByTestId('diff-revoked-count')).toHaveTextContent('1 to revoke');
  });

  it('grants a whole module from its heading row', () => {
    renderMatrix();
    fireEvent.click(screen.getByRole('button', { name: 'Grant every permission in EN-024' }));
    expect(screen.getByTestId('diff-granted-count')).toHaveTextContent('2 to grant');
  });

  it('clears the selection without undoing the change already applied', () => {
    renderMatrix();
    fireEvent.click(screen.getByRole('button', { name: 'Select all 5 shown' }));
    fireEvent.click(screen.getByTestId('bulk-grant'));
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(screen.getByTestId('bulk-selected')).toHaveTextContent('Select rows, a module, or filter');
    expect(screen.getByTestId('diff-granted-count')).toHaveTextContent('4 to grant');
  });
});

describe('the change diff', () => {
  it('is not shown until something has changed', () => {
    renderMatrix();
    expect(screen.queryByTestId('change-diff')).not.toBeInTheDocument();
  });

  it('lists each key with the direction it is moving in', () => {
    renderMatrix();
    fireEvent.click(screen.getByTestId('cell-audit.export'));
    fireEvent.click(screen.getByTestId('cell-admin.user.read'));

    const diff = within(screen.getByTestId('change-diff'));
    expect(diff.getByText('audit.export').closest('li')).toHaveAttribute('data-direction', 'granted');
    expect(diff.getByText('admin.user.read').closest('li')).toHaveAttribute('data-direction', 'revoked');
  });

  it('can be discarded, returning the draft to what is saved', () => {
    renderMatrix();
    fireEvent.click(screen.getByTestId('cell-audit.export'));
    expect(screen.getByTestId('change-diff')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(screen.queryByTestId('change-diff')).not.toBeInTheDocument();
  });
});

describe('saving', () => {
  it('is refused while nothing has changed', () => {
    renderMatrix();
    expect(screen.getByTestId('matrix-save')).toBeDisabled();
  });

  it('will not save without a reason, and not with whitespace either', () => {
    const { onSave } = renderMatrix();
    fireEvent.click(screen.getByTestId('cell-audit.export'));
    fireEvent.click(screen.getByTestId('matrix-save'));

    const confirm = screen.getByRole('button', { name: 'Save the role' });
    expect(confirm).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/Reason for this change/), { target: { value: '   ' } });
    expect(confirm).toBeDisabled();

    fireEvent.click(confirm);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('also requires the role key to be typed, because the change reaches everyone holding it', () => {
    const { onSave } = renderMatrix();
    fireEvent.click(screen.getByTestId('cell-audit.export'));
    fireEvent.click(screen.getByTestId('matrix-save'));

    fireEvent.change(screen.getByLabelText(/Reason for this change/), {
      target: { value: 'Pharmacy restructure' },
    });
    const confirm = screen.getByRole('button', { name: 'Save the role' });
    expect(confirm).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/Type ward_pharmacist to confirm/), {
      target: { value: 'ward_pharmacist' },
    });
    expect(confirm).toBeEnabled();

    fireEvent.click(confirm);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(['admin.user.read', 'audit.export'], 'Pharmacy restructure');
  });

  it('tells the administrator how many people the change reaches', () => {
    renderMatrix();
    fireEvent.click(screen.getByTestId('cell-audit.export'));
    fireEvent.click(screen.getByTestId('matrix-save'));
    expect(screen.getByText(/12 user\(s\) holding this role/)).toBeInTheDocument();
  });
});

describe('segregation of duties', () => {
  it('warns before the save and blocks it until the conflict is accepted', () => {
    renderMatrix();
    fireEvent.click(screen.getByTestId('cell-admin.role.assign'));

    const warning = screen.getByTestId('sod-warning');
    expect(within(warning).getByText(/maker and checker in one person/)).toBeInTheDocument();
    expect(screen.getByTestId('matrix-save')).toBeDisabled();

    fireEvent.click(screen.getByLabelText(/I have read each conflict above/));
    expect(screen.getByTestId('matrix-save')).toBeEnabled();
  });
});

describe('a system template', () => {
  const template: RoleDetail = { ...ROLE, is_system: true, key: 'pharmacist_op' };

  it('is read-only, and says why, instead of offering edits the database will refuse', () => {
    renderMatrix({ role: template, onCloneRequested: vi.fn() });
    expect(screen.getByText(/Templates are read-only/)).toBeInTheDocument();
    expect(screen.queryByTestId('cell-audit.read')).not.toBeInTheDocument();
    expect(screen.queryByTestId('matrix-save')).not.toBeInTheDocument();
    expect(screen.queryByTestId('bulk-bar')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clone this template' })).toBeInTheDocument();
  });

  it('still reports what the role holds, as text rather than as a dead checkbox', () => {
    renderMatrix({ role: template });
    expect(screen.getByText('admin.user.read for Ward pharmacist: granted')).toBeInTheDocument();
    expect(screen.getByText('audit.read for Ward pharmacist: not granted')).toBeInTheDocument();
  });
});

describe('without admin.role.configure', () => {
  it('renders the matrix as a report and explains the missing key', () => {
    renderMatrix({ canConfigure: false });
    expect(screen.getByText(/admin.role.configure/)).toBeInTheDocument();
    expect(screen.queryByTestId('matrix-save')).not.toBeInTheDocument();
  });
});

describe('comparison columns', () => {
  it('adds a read-only column per compared role and announces its values', () => {
    renderMatrix({
      comparisons: [{ role: COMPARISON, permissions: new Set(['audit.read']), loading: false }],
    });
    expect(screen.getByRole('columnheader', { name: /OP pharmacist/ })).toBeInTheDocument();
    expect(screen.getByText('audit.read for OP pharmacist: granted')).toBeInTheDocument();
    expect(screen.getByText('admin.user.read for OP pharmacist: not granted')).toBeInTheDocument();
  });
});

describe('keyboard navigation', () => {
  it('moves the single tab stop down a row and across a column', () => {
    renderMatrix();
    const grid = screen.getByRole('grid');
    const stop = (): string | null =>
      grid.querySelector('[data-matrix-cell][tabindex="0"]')?.getAttribute('data-matrix-cell') ?? null;

    expect(stop()).toBe('0:1');
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    expect(stop()).toBe('1:1');
    fireEvent.keyDown(grid, { key: 'ArrowLeft' });
    expect(stop()).toBe('1:0');
    fireEvent.keyDown(grid, { key: 'End' });
    expect(stop()).toBe('6:0');
    fireEvent.keyDown(grid, { key: 'Home' });
    expect(stop()).toBe('0:0');
  });

  it('keeps exactly one tab stop however far the user moves, including past a row\u2019s last column', () => {
    renderMatrix();
    const grid = screen.getByRole('grid');
    // A permission row has no third column when nothing is being compared, so a
    // right-arrow that overshoots must land on the row's last cell rather than on
    // nothing — the dead end is what makes a grid feel broken from the keyboard.
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    fireEvent.keyDown(grid, { key: 'ArrowRight' });
    fireEvent.keyDown(grid, { key: 'ArrowRight' });
    expect(grid.querySelectorAll('[data-matrix-cell][tabindex="0"]')).toHaveLength(1);

    fireEvent.keyDown(grid, { key: 'ArrowUp' });
    expect(grid.querySelectorAll('[data-matrix-cell][tabindex="0"]')).toHaveLength(1);
  });
});
